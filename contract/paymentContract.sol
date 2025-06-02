// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

contract PaymentChain {
    address private oracle;

    enum PaymentState { Initiated, AwaitingConfirmation, Confirmed, Completed, Failed }

    struct Payment {
        uint id;
        uint256 amount;
        address payable buyer;
        address payable seller;
        string keyEncryptedSeller;
        string keyEncryptedBuyer;
        uint256 inceptionTime;
        uint256 confirmationTime;
        uint256 duration;
        uint256 lastOracleUpdate;
        PaymentState state;
        uint assetTradeId; // Reference to corresponding trade on AssetChain
    }
    
    mapping(uint => Payment) public payments;
    mapping(bytes32 => uint) private requestToPaymentId;
    uint[] public paymentIds;

    event TimeRequestSent(bytes32 requestId, uint paymentId, uint256 duration);
    event PaymentConfirmed(uint id);
    event PaymentCompleted(uint id, address recipient, uint256 amount);
    event PaymentFailed(uint id, string reason);
    event PaymentInitiated(uint id, uint assetTradeId, uint256 amount, address buyer, address seller, uint256 duration);
    event PaymentConfirmationRequested(uint id, uint256 amount, address buyer);
    event PaymentConfirmationReceived(uint id, uint256 amount, address seller);
    event TimeRequestFulfilled(uint id, uint256 timestamp);
    event PaymentCompletionAttempted(uint id, bool success, string reason);
    event PaymentReturned(uint id, address recipient, uint256 amount);

    constructor(address _oracle) {
        oracle = _oracle;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "Only the oracle can call this function");
        _;
    }

    function inceptPayment(uint id, uint assetTradeId, uint256 amount, address payable seller, string memory keyEncryptedSeller, uint256 duration) public payable {
        require(payments[id].id == 0, "Payment ID already exists");
        require(msg.value == amount, "Incorrect payment amount");
        
        payments[id] = Payment(
            id, 
            amount, 
            payable(msg.sender), 
            seller, 
            keyEncryptedSeller, 
            "", 
            0, 
            0, 
            duration, 
            0, 
            PaymentState.Initiated,
            assetTradeId
        );
        
        paymentIds.push(id);
        
        bytes32 requestId = keccak256(abi.encodePacked(block.timestamp, id));
        requestToPaymentId[requestId] = id;
        emit PaymentInitiated(id, assetTradeId, amount, msg.sender, seller, duration);
        emit TimeRequestSent(requestId, id, duration);
    }

    function confirmPayment(uint id, uint256 amount, address payable buyer, string memory keyEncryptedBuyer) public {
        require(payments[id].id != 0, "Payment ID does not exist");
        require(payments[id].seller == msg.sender, "Only the seller can confirm the payment");
        require(payments[id].buyer == buyer, "Buyer address does not match");
        require(payments[id].amount == amount, "Amount does not match");
        require(payments[id].state == PaymentState.AwaitingConfirmation, "Payment is not in the correct state");

        emit PaymentConfirmationRequested(id, amount, buyer);
        
        payments[id].keyEncryptedBuyer = keyEncryptedBuyer;
        payments[id].state = PaymentState.Confirmed;
        
        bytes32 requestId = keccak256(abi.encodePacked(block.timestamp, id));
        requestToPaymentId[requestId] = id;
        emit PaymentConfirmationReceived(id, amount, msg.sender);
        emit TimeRequestSent(requestId, id, payments[id].duration);
        emit PaymentConfirmed(id);
    }

    function fulfillTime(bytes32 _requestId, uint256 _timestamp) external onlyOracle {
        uint paymentId = requestToPaymentId[_requestId];
        require(paymentId != 0, "Invalid request ID");
        
        Payment storage payment = payments[paymentId];
        require(payment.state != PaymentState.Completed && payment.state != PaymentState.Failed, "Payment already completed or failed");

        emit TimeRequestFulfilled(paymentId, _timestamp);

        payment.lastOracleUpdate = _timestamp;
        
        if (payment.inceptionTime == 0) {
            payment.inceptionTime = _timestamp;
            payment.state = PaymentState.AwaitingConfirmation;
        } else if (payment.state == PaymentState.Confirmed) {
            // 確保確認時間被正確設置
            payment.confirmationTime = _timestamp;
            
            uint256 timeElapsed = _timestamp - payment.inceptionTime;
            if (timeElapsed <= payment.duration) {
                emit PaymentCompletionAttempted(paymentId, true, "Within time limit");
                // 不在這裡完成支付，等待 transferWithKey
            } else {
                emit PaymentCompletionAttempted(paymentId, false, "Time limit exceeded");
                failPayment(paymentId, "Time limit exceeded");
            }
        }
    }

    function handleFailedConfirmation(uint paymentId) external onlyOracle {
        require(payments[paymentId].id != 0, "Payment does not exist");
        require(payments[paymentId].state != PaymentState.Completed && payments[paymentId].state != PaymentState.Failed, "Payment is already completed or failed");
        
        failPayment(paymentId, "Confirmation timeout");
    }

    function transferWithKey(uint id, string memory key) public {
        require(payments[id].state == PaymentState.Confirmed, "Payment is not in the correct state");
        require(payments[id].buyer == msg.sender, "Only the buyer can initiate the transfer");
        require(payments[id].confirmationTime != 0, "Confirmation time not set");
        
        Payment storage payment = payments[id];
        
        // 修正時間驗證邏輯 - 使用確認時間而非最後更新時間
        uint256 timeElapsed;
        if (payment.confirmationTime > payment.inceptionTime) {
            timeElapsed = payment.confirmationTime - payment.inceptionTime;
        } else {
            // 如果確認時間異常，使用最後更新時間
            timeElapsed = payment.lastOracleUpdate - payment.inceptionTime;
        }
        
        require(timeElapsed <= payment.duration, "Payment duration exceeded");
        
        // 驗證密鑰 - 注意這裡應該驗證買方提供的密鑰與賣方的加密密鑰
        if (keccak256(abi.encodePacked(key)) == keccak256(abi.encodePacked(payment.keyEncryptedSeller))) {
            completePayment(id);
        } else {
            failPayment(id, "Invalid key provided");
        }
    }

    function completePayment(uint id) internal {
        Payment storage payment = payments[id];
        require(payment.state == PaymentState.Confirmed, "Payment is not confirmed");
        payment.state = PaymentState.Completed;
        (bool sent, ) = payment.seller.call{value: payment.amount}("");
        require(sent, "Failed to transfer payment to seller");
        emit PaymentCompleted(id, payment.seller, payment.amount);
        removePayment(id);
    }

    function failPayment(uint id, string memory reason) internal {
        Payment storage payment = payments[id];
        require(payment.state != PaymentState.Completed && payment.state != PaymentState.Failed, "Payment already completed or failed");

        // If payment is confirmed, return funds to buyer
        if (payment.state == PaymentState.Confirmed || payment.state == PaymentState.AwaitingConfirmation || payment.state == PaymentState.Initiated) {
            uint256 amountToReturn = payment.amount;
            payment.amount = 0; // Prevent reentrancy attacks
            (bool sent, ) = payment.buyer.call{value: amountToReturn}("");
            if (sent) {
                emit PaymentReturned(id, payment.buyer, amountToReturn);
            } else {
                payment.amount = amountToReturn; // If refund fails, restore the amount
                emit PaymentReturned(id, payment.buyer, 0);
            }
            require(sent, "Failed to return payment to buyer");
        }

        payment.state = PaymentState.Failed;
        emit PaymentFailed(id, reason);
        removePayment(id);
    }

    function removePayment(uint id) internal {
        for (uint i = 0; i < paymentIds.length; i++) {
            if (paymentIds[i] == id) {
                paymentIds[i] = paymentIds[paymentIds.length - 1];
                paymentIds.pop();
                break;
            }
        }
        delete payments[id];
    }

    function getActivePaymentIds() public view returns (uint[] memory) {
        uint[] memory activeIds = new uint[](paymentIds.length);
        uint count = 0;
        for (uint i = 0; i < paymentIds.length; i++) {
            if (payments[paymentIds[i]].state != PaymentState.Completed && payments[paymentIds[i]].state != PaymentState.Failed) {
                activeIds[count] = paymentIds[i];
                count++;
            }
        }
        uint[] memory result = new uint[](count);
        for (uint i = 0; i < count; i++) {
            result[i] = activeIds[i];
        }
        return result;
    }

    function getPayment(uint _paymentId) public view returns (
        uint id,
        uint256 amount,
        address buyer,
        address seller,
        PaymentState state,
        uint256 inceptionTime,
        uint256 confirmationTime,
        uint256 duration,
        uint assetTradeId
    ) {
        Payment storage payment = payments[_paymentId];
        return (
            payment.id,
            payment.amount,
            payment.buyer,
            payment.seller,
            payment.state,
            payment.inceptionTime,
            payment.confirmationTime,
            payment.duration,
            payment.assetTradeId
        );
    }

    function setOracleAddress(address _oracle) public {
        require(msg.sender == oracle, "Only the current oracle can update the oracle address");
        oracle = _oracle;
    }

    receive() external payable {}
}
