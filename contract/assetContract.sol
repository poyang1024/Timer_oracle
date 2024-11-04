// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

contract AssetChain {
    address private oracle;

    enum TradeState { Initiated, AwaitingConfirmation, Confirmed, Completed, Failed }

    struct Trade {
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
        TradeState state;
    }
    
    mapping(uint => Trade) public trades;
    mapping(bytes32 => uint) private requestToTradeId;
    uint[] public tradeIds;

    event TimeRequestSent(bytes32 requestId, uint tradeId, uint256 duration);
    event TradeConfirmed(uint id);
    event TradeCompleted(uint id, address recipient, uint256 amount);
    event TradeFailed(uint id, string reason);
    event TradeInitiated(uint id, uint256 amount, address buyer, address seller, uint256 duration);
    event TradeConfirmationRequested(uint id, uint256 amount, address buyer);
    event TradeConfirmationReceived(uint id, uint256 amount, address seller);
    event TimeRequestFulfilled(uint id, uint256 timestamp);
    event TradeCompletionAttempted(uint id, bool success, string reason);
    event AssetReturned(uint id, address recipient, uint256 amount);

    constructor(address _oracle) {
        oracle = _oracle;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "Only the oracle can call this function");
        _;
    }

    function inceptTrade(uint id, uint256 amount, address payable seller, string memory keyEncryptedSeller, uint256 duration) public {
        require(trades[id].id == 0, "Trade ID already exists");
        trades[id] = Trade(id, amount, payable(msg.sender), seller, keyEncryptedSeller, "", 0, 0, duration, 0, TradeState.Initiated);
        tradeIds.push(id);
        
        bytes32 requestId = keccak256(abi.encodePacked(block.timestamp, id));
        requestToTradeId[requestId] = id;
        emit TradeInitiated(id, amount, msg.sender, seller, duration);
        emit TimeRequestSent(requestId, id, duration);
    }

    function confirmTrade(uint id, uint256 amount, address payable buyer, string memory keyEncryptedBuyer) public payable {
        require(trades[id].id != 0, "Trade ID does not exist");
        require(trades[id].seller == msg.sender, "Only the seller can confirm the trade");
        require(trades[id].buyer == buyer, "Buyer address does not match");
        require(trades[id].amount == amount, "Amount does not match");
        require(msg.value == amount, "Incorrect deposit amount");
        require(trades[id].state == TradeState.AwaitingConfirmation, "Trade is not in the correct state");

        emit TradeConfirmationRequested(id, amount, buyer);
        
        trades[id].keyEncryptedBuyer = keyEncryptedBuyer;
        trades[id].state = TradeState.Confirmed;
        
        bytes32 requestId = keccak256(abi.encodePacked(block.timestamp, id));
        requestToTradeId[requestId] = id;
        emit TradeConfirmationReceived(id, amount, msg.sender);
        emit TimeRequestSent(requestId, id, trades[id].duration);
        emit TradeConfirmed(id);
    }

    function fulfillTime(bytes32 _requestId, uint256 _timestamp) external onlyOracle {
        uint tradeId = requestToTradeId[_requestId];
        require(tradeId != 0, "Invalid request ID");
        
        Trade storage trade = trades[tradeId];
        require(trade.state != TradeState.Completed && trade.state != TradeState.Failed, "Trade already completed or failed");

        emit TimeRequestFulfilled(tradeId, _timestamp);

        trade.lastOracleUpdate = _timestamp;
        
        if (trade.inceptionTime == 0) {
            trade.inceptionTime = _timestamp;
            trade.state = TradeState.AwaitingConfirmation;
        } else if (trade.state == TradeState.Confirmed) {
            trade.confirmationTime = _timestamp;
            if (_timestamp - trade.inceptionTime <= trade.duration) {
                emit TradeCompletionAttempted(tradeId, true, "Within time limit");
                // Do not complete the trade here, wait for transferWithKey
            } else {
                emit TradeCompletionAttempted(tradeId, false, "Time limit exceeded");
                failTrade(tradeId, "Time limit exceeded");
            }
        }
    }

    function handleFailedConfirmation(uint tradeId) external onlyOracle {
        require(trades[tradeId].id != 0, "Trade does not exist");
        require(trades[tradeId].state != TradeState.Completed && trades[tradeId].state != TradeState.Failed, "Trade is already completed or failed");
        
        failTrade(tradeId, "Confirmation timeout");
    }

    function transferWithKey(uint id, string memory key) public {
        require(trades[id].state == TradeState.Confirmed, "Trade is not in the correct state");
        require(trades[id].buyer == msg.sender, "Only the buyer can initiate the transfer");
        require(trades[id].confirmationTime != 0, "Confirmation time not set");
        // require(block.timestamp - trades[id].confirmationTime <= trades[id].duration, "Trade duration exceeded");
        require(trades[id].lastOracleUpdate - trades[id].confirmationTime <= trades[id].duration, "Trade duration exceeded");
        
        Trade storage trade = trades[id];

        if (keccak256(abi.encodePacked(key)) == keccak256(abi.encodePacked(trade.keyEncryptedSeller))) {
            completeTrade(id);
        } else {
            failTrade(id, "Invalid key provided");
        }
    }

    function completeTrade(uint id) internal {
        Trade storage trade = trades[id];
        require(trade.state == TradeState.Confirmed, "Trade is not confirmed");
        trade.state = TradeState.Completed;
        (bool sent, ) = trade.buyer.call{value: trade.amount}("");
        require(sent, "Failed to transfer asset to buyer");
        emit TradeCompleted(id, trade.buyer, trade.amount);
        removeTrade(id);
    }

    function failTrade(uint id, string memory reason) internal {
        Trade storage trade = trades[id];
        require(trade.state != TradeState.Completed && trade.state != TradeState.Failed, "Trade already completed or failed");

        // 如果交易已確認且賣家已存入資金，則退回資金
        if (trade.state == TradeState.Confirmed) {
            uint256 amountToReturn = trade.amount;
            trade.amount = 0; // 防止重入攻擊
            (bool sent, ) = trade.seller.call{value: amountToReturn}("");
            if (sent) {
                emit AssetReturned(id, trade.seller, amountToReturn);
            } else {
                trade.amount = amountToReturn; // 如果退款失敗，恢復金額
                emit AssetReturned(id, trade.seller, 0);
            }
            require(sent, "Failed to return asset to seller");
        }

        trade.state = TradeState.Failed;
        emit TradeFailed(id, reason);
        removeTrade(id);
    }

    function removeTrade(uint id) internal {
        for (uint i = 0; i < tradeIds.length; i++) {
            if (tradeIds[i] == id) {
                tradeIds[i] = tradeIds[tradeIds.length - 1];
                tradeIds.pop();
                break;
            }
        }
        delete trades[id];
    }

    function getActiveTradeIds() public view returns (uint[] memory) {
        uint[] memory activeIds = new uint[](tradeIds.length);
        uint count = 0;
        for (uint i = 0; i < tradeIds.length; i++) {
            if (trades[tradeIds[i]].state != TradeState.Completed && trades[tradeIds[i]].state != TradeState.Failed) {
                activeIds[count] = tradeIds[i];
                count++;
            }
        }
        uint[] memory result = new uint[](count);
        for (uint i = 0; i < count; i++) {
            result[i] = activeIds[i];
        }
        return result;
    }

    function getTrade(uint _tradeId) public view returns (
        uint id,
        uint256 amount,
        address buyer,
        address seller,
        TradeState state,
        uint256 inceptionTime,
        uint256 confirmationTime,
        uint256 duration
    ) {
        Trade storage trade = trades[_tradeId];
        return (
            trade.id,
            trade.amount,
            trade.buyer,
            trade.seller,
            trade.state,
            trade.inceptionTime,
            trade.confirmationTime,
            trade.duration
        );
    }

    function setOracleAddress(address _oracle) public {
        require(msg.sender == oracle, "Only the current oracle can update the oracle address");
        oracle = _oracle;
    }

    receive() external payable {}
}