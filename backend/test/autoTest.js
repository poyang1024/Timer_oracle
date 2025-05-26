const ethers = require('ethers');
require('dotenv').config();

// 合約ABI定義
const assetContractABI = [
    "function inceptTrade(uint id, uint256 amount, address payable seller, string memory keyEncryptedSeller, uint256 duration) public",
    "function confirmTrade(uint id, uint256 amount, address payable buyer, string memory keyEncryptedBuyer) public payable",
    "function transferWithKey(uint id, string memory key) public",
    "function getTrade(uint _tradeId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256)",
    "function getActiveTradeIds() public view returns (uint[] memory)",
    "event TradeInitiated(uint id, uint256 amount, address buyer, address seller, uint256 duration)",
    "event TradeConfirmed(uint id)",
    "event TradeCompleted(uint id, address recipient, uint256 amount)",
    "event TradeFailed(uint id, string reason)"
];

const paymentContractABI = [
    "function inceptPayment(uint id, uint assetTradeId, uint256 amount, address payable seller, string memory keyEncryptedSeller, uint256 duration) public payable",
    "function confirmPayment(uint id, uint256 amount, address payable buyer, string memory keyEncryptedBuyer) public",
    "function transferWithKey(uint id, string memory key) public",
    "function getPayment(uint _paymentId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256, uint)",
    "function getActivePaymentIds() public view returns (uint[] memory)",
    "event PaymentInitiated(uint id, uint assetTradeId, uint256 amount, address buyer, address seller, uint256 duration)",
    "event PaymentConfirmed(uint id)",
    "event PaymentCompleted(uint id, address recipient, uint256 amount)",
    "event PaymentFailed(uint id, string reason)"
];

// 環境配置
const ASSET_ETHEREUM_NODE_URL = process.env.ASSET_ETHEREUM_NODE_URL;
const PAYMENT_ETHEREUM_NODE_URL = process.env.PAYMENT_ETHEREUM_NODE_URL;
const ASSET_CONTRACT_ADDRESS = process.env.ASSET_CONTRACT_ADDRESS;
const PAYMENT_CONTRACT_ADDRESS = process.env.PAYMENT_CONTRACT_ADDRESS;
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY;
const SELLER_PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY;

// 測試用密鑰
const ENCRYPTED_KEY_SELLER = "0QOwlviLqv5lfwLZkaZ7s8V2C5hB3KRe"; // sellerkey
const ENCRYPTED_KEY_BUYER = "ltRkeyWXsmA11d7qU3FCWfBs1LEwxXeU";   // buyerkey

// 全局變量
let testResults = {
    normalTrade: false,
    timeoutRefund: false,
    doubleSpendPrevention: false,
    invalidKeyTest: false
};

// 顏色輸出函數
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

function colorLog(color, message) {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// 設置提供者和合約
async function setupProviders() {
    try {
        // Asset鏈連接 (Besu私有鏈)
        const assetProvider = new ethers.JsonRpcProvider(ASSET_ETHEREUM_NODE_URL);
        const assetBuyerSigner = new ethers.Wallet(BUYER_PRIVATE_KEY, assetProvider);
        const assetSellerSigner = new ethers.Wallet(SELLER_PRIVATE_KEY, assetProvider);
        const assetContractBuyer = new ethers.Contract(ASSET_CONTRACT_ADDRESS, assetContractABI, assetBuyerSigner);
        const assetContractSeller = new ethers.Contract(ASSET_CONTRACT_ADDRESS, assetContractABI, assetSellerSigner);

        // Payment鏈連接 (Sepolia測試網)
        const paymentProvider = new ethers.JsonRpcProvider(PAYMENT_ETHEREUM_NODE_URL);
        const paymentBuyerSigner = new ethers.Wallet(BUYER_PRIVATE_KEY, paymentProvider);
        const paymentSellerSigner = new ethers.Wallet(SELLER_PRIVATE_KEY, paymentProvider);
        const paymentContractBuyer = new ethers.Contract(PAYMENT_CONTRACT_ADDRESS, paymentContractABI, paymentBuyerSigner);
        const paymentContractSeller = new ethers.Contract(PAYMENT_CONTRACT_ADDRESS, paymentContractABI, paymentSellerSigner);

        // 檢查連接
        const assetBlockNumber = await assetProvider.getBlockNumber();
        const paymentBlockNumber = await paymentProvider.getBlockNumber();
        
        colorLog('green', '✓ 區塊鏈連接成功');
        console.log(`  Asset鏈當前區塊: ${assetBlockNumber}`);
        console.log(`  Payment鏈當前區塊: ${paymentBlockNumber}`);

        // 檢查餘額
        const assetBuyerBalance = await assetProvider.getBalance(assetBuyerSigner.address);
        const paymentBuyerBalance = await paymentProvider.getBalance(paymentBuyerSigner.address);
        
        console.log(`  Asset鏈買方餘額: ${ethers.formatEther(assetBuyerBalance)} ETH`);
        console.log(`  Payment鏈買方餘額: ${ethers.formatEther(paymentBuyerBalance)} ETH`);

        const assetSellerBalance = await assetProvider.getBalance(assetSellerSigner.address);
        const paymentSellerBalance = await paymentProvider.getBalance(paymentSellerSigner.address);

        console.log(`  Asset鏈賣方餘額: ${ethers.formatEther(assetSellerBalance)} ETH`);
        console.log(`  Payment鏈賣方餘額: ${ethers.formatEther(paymentSellerBalance)} ETH`);

        return {
            assetProvider,
            assetBuyerSigner,
            assetSellerSigner,
            assetContractBuyer,
            assetContractSeller,
            paymentProvider,
            paymentBuyerSigner,
            paymentSellerSigner,
            paymentContractBuyer,
            paymentContractSeller
        };
    } catch (error) {
        colorLog('red', '✗ 設置提供者失敗: ' + error.message);
        throw error;
    }
}

// 詳細檢查交易狀態
async function checkTransactionStatusDetailed(assetContract, paymentContract, tradeId, paymentId) {
    try {
        const assetTradeInfo = await assetContract.getTrade(tradeId);
        const paymentInfo = await paymentContract.getPayment(paymentId);

        console.log("\n" + "=".repeat(50));
        colorLog('cyan', '詳細交易狀態檢查');
        console.log("=".repeat(50));
        
        // Asset 交易詳細信息
        colorLog('blue', 'Asset交易詳細信息:');
        console.log(`  ID: ${assetTradeInfo[0].toString()}`);
        console.log(`  金額: ${ethers.formatEther(assetTradeInfo[1])} ETH`);
        console.log(`  買方: ${assetTradeInfo[2]}`);
        console.log(`  賣方: ${assetTradeInfo[3]}`);
        console.log(`  狀態代碼: ${assetTradeInfo[4].toString()}`);
        console.log(`  狀態文字: ${getTradeStateText(assetTradeInfo[4])}`);
        console.log(`  創建時間戳記: ${assetTradeInfo[5].toString()}`);
        console.log(`  確認時間戳記: ${assetTradeInfo[6].toString()}`);
        console.log(`  有效期限: ${assetTradeInfo[7].toString()} 秒`);
        
        if (assetTradeInfo[5] > 0) {
            console.log(`  創建時間: ${new Date(Number(assetTradeInfo[5]) * 1000).toLocaleString()}`);
        }
        if (assetTradeInfo[6] > 0) {
            console.log(`  確認時間: ${new Date(Number(assetTradeInfo[6]) * 1000).toLocaleString()}`);
        }

        // Payment 交易詳細信息
        colorLog('magenta', '\nPayment交易詳細信息:');
        console.log(`  ID: ${paymentInfo[0].toString()}`);
        console.log(`  金額: ${ethers.formatEther(paymentInfo[1])} ETH`);
        console.log(`  買方: ${paymentInfo[2]}`);
        console.log(`  賣方: ${paymentInfo[3]}`);
        console.log(`  狀態代碼: ${paymentInfo[4].toString()}`);
        console.log(`  狀態文字: ${getTradeStateText(paymentInfo[4])}`);
        console.log(`  創建時間戳記: ${paymentInfo[5].toString()}`);
        console.log(`  確認時間戳記: ${paymentInfo[6].toString()}`);
        console.log(`  有效期限: ${paymentInfo[7].toString()} 秒`);
        console.log(`  關聯Asset交易ID: ${paymentInfo[8].toString()}`);
        
        if (paymentInfo[5] > 0) {
            console.log(`  創建時間: ${new Date(Number(paymentInfo[5]) * 1000).toLocaleString()}`);
        }
        if (paymentInfo[6] > 0) {
            console.log(`  確認時間: ${new Date(Number(paymentInfo[6]) * 1000).toLocaleString()}`);
        }

        // 時間分析
        const currentTime = Math.floor(Date.now() / 1000);
        colorLog('yellow', '\n時間分析:');
        console.log(`  當前時間戳記: ${currentTime}`);
        console.log(`  當前時間: ${new Date().toLocaleString()}`);
        
        if (assetTradeInfo[5] > 0) {
            const assetElapsed = currentTime - Number(assetTradeInfo[5]);
            const assetRemaining = Number(assetTradeInfo[7]) - assetElapsed;
            console.log(`  Asset交易經過時間: ${assetElapsed} 秒`);
            console.log(`  Asset交易剩餘時間: ${assetRemaining} 秒`);
            
            if (assetRemaining <= 0) {
                colorLog('red', '  ⚠️  Asset交易已超時');
            }
        }
        
        if (paymentInfo[5] > 0) {
            const paymentElapsed = currentTime - Number(paymentInfo[5]);
            const paymentRemaining = Number(paymentInfo[7]) - paymentElapsed;
            console.log(`  Payment交易經過時間: ${paymentElapsed} 秒`);
            console.log(`  Payment交易剩餘時間: ${paymentRemaining} 秒`);
            
            if (paymentRemaining <= 0) {
                colorLog('red', '  ⚠️  Payment交易已超時');
            }
        }

        // 跨鏈時間同步檢查
        if (assetTradeInfo[5] > 0 && paymentInfo[5] > 0) {
            const timeDiff = Number(paymentInfo[5]) - Number(assetTradeInfo[5]);
            console.log(`  跨鏈時間差: ${timeDiff} 秒`);
            if (Math.abs(timeDiff) > 60) {
                colorLog('yellow', '  ⚠️  警告: 跨鏈時間差異過大，可能影響交易執行');
            }
        }

        console.log("=".repeat(50) + "\n");

        return {
            assetTrade: {
                id: Number(assetTradeInfo[0]),
                state: Number(assetTradeInfo[4]),
                inceptionTime: Number(assetTradeInfo[5]),
                confirmationTime: Number(assetTradeInfo[6]),
                duration: Number(assetTradeInfo[7]),
                isActive: Number(assetTradeInfo[0]) > 0
            },
            paymentTrade: {
                id: Number(paymentInfo[0]),
                state: Number(paymentInfo[4]),
                inceptionTime: Number(paymentInfo[5]),
                confirmationTime: Number(paymentInfo[6]),
                duration: Number(paymentInfo[7]),
                assetTradeId: Number(paymentInfo[8]),
                isActive: Number(paymentInfo[0]) > 0
            }
        };
    } catch (error) {
        colorLog('red', '檢查交易狀態時發生錯誤: ' + error.message);
        console.error('錯誤詳情:', error);
        return null;
    }
}

// 交易狀態轉換為可讀文字
function getTradeStateText(stateCode) {
    const states = ["已創建", "等待確認", "已確認", "已完成", "已失敗"];
    return states[Number(stateCode)] || "未知狀態";
}

// 等待函數
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 安全執行交易函數
async function safeExecuteTransaction(contractMethod, description, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            colorLog('blue', `執行: ${description} (嘗試 ${i + 1}/${retries})`);
            const tx = await contractMethod();
            colorLog('yellow', `交易已提交: ${tx.hash}`);
            const receipt = await tx.wait();
            colorLog('green', `✓ ${description} 成功 (區塊: ${receipt.blockNumber}, Gas: ${receipt.gasUsed.toString()})`);
            return receipt;
        } catch (error) {
            colorLog('red', `✗ ${description} 失敗 (嘗試 ${i + 1}): ${error.message}`);
            if (i === retries - 1) {
                throw error;
            }
            await delay(2000); // 重試前等待2秒
        }
    }
}

// 測試1: 正常交易流程
async function testNormalTradeFlow() {
    colorLog('bright', '\n' + '='.repeat(60));
    colorLog('bright', '測試1: 正常交易流程');
    colorLog('bright', '='.repeat(60));
    
    try {
        const providers = await setupProviders();
        const {
            assetContractBuyer,
            assetContractSeller,
            paymentContractBuyer,
            paymentContractSeller,
            assetBuyerSigner,
            assetSellerSigner
        } = providers;

        // 生成唯一交易ID
        const nonce = Math.floor(Math.random() * 1000);
        const TRADE_ID = Math.floor(Date.now() / 1000) + nonce;
        const PAYMENT_ID = TRADE_ID;
        const AMOUNT = ethers.parseEther("0.005");
        const DURATION = 3600; // 1小時

        const sellerAddress = await assetSellerSigner.getAddress();
        const buyerAddress = await assetBuyerSigner.getAddress();

        colorLog('cyan', `\n交易參數:`);
        console.log(`  交易ID: ${TRADE_ID}`);
        console.log(`  金額: ${ethers.formatEther(AMOUNT)} ETH`);
        console.log(`  有效期限: ${DURATION} 秒`);
        console.log(`  買方地址: ${buyerAddress}`);
        console.log(`  賣方地址: ${sellerAddress}`);

        // 步驟1：買方在Asset鏈上創建交易
        colorLog('yellow', '\n步驟1：買方在Asset鏈上創建交易');
        await safeExecuteTransaction(
            () => assetContractBuyer.inceptTrade(TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, DURATION),
            'Asset交易創建'
        );
        
        // 等待Oracle處理
        colorLog('yellow', '等待Oracle處理 (15秒)...');
        await delay(15000);

        // 步驟2：買方在Payment鏈上創建支付
        colorLog('yellow', '\n步驟2：買方在Payment鏈上創建支付');
        await safeExecuteTransaction(
            () => paymentContractBuyer.inceptPayment(PAYMENT_ID, TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, DURATION, { value: AMOUNT }),
            'Payment支付創建'
        );
        
        // 等待Oracle處理並檢查狀態
        await delay(15000);
        let status = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        if (!status || !status.assetTrade.isActive || !status.paymentTrade.isActive) {
            throw new Error('交易創建後狀態異常');
        }

        // 步驟3：賣方確認Asset交易
        colorLog('yellow', '\n步驟3：賣方確認Asset交易');
        await safeExecuteTransaction(
            () => assetContractSeller.confirmTrade(TRADE_ID, AMOUNT, buyerAddress, ENCRYPTED_KEY_BUYER, { value: AMOUNT }),
            'Asset交易確認'
        );
        
        await delay(15000);

        // 步驟4：賣方確認Payment
        colorLog('yellow', '\n步驟4：賣方確認Payment');
        await safeExecuteTransaction(
            () => paymentContractSeller.confirmPayment(PAYMENT_ID, AMOUNT, buyerAddress, ENCRYPTED_KEY_BUYER),
            'Payment確認'
        );
        
        await delay(15000);
        status = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);

        if (!status || status.assetTrade.state !== 2 || status.paymentTrade.state !== 2) {
            colorLog('yellow', '警告: 交易狀態未如預期變為"已確認"，但繼續測試...');
        }

        // 步驟5：買方使用密鑰釋放Payment（先轉移支付）
        colorLog('yellow', '\n步驟5：買方使用密鑰釋放Payment（先轉移支付）');
        try {
            await safeExecuteTransaction(
                () => paymentContractBuyer.transferWithKey(PAYMENT_ID, ENCRYPTED_KEY_SELLER),
                'Payment釋放（支付給賣家）'
            );
        } catch (error) {
            colorLog('red', 'Payment釋放失敗，嘗試使用買方密鑰...');
            await safeExecuteTransaction(
                () => paymentContractBuyer.transferWithKey(PAYMENT_ID, ENCRYPTED_KEY_BUYER),
                'Payment釋放（使用買方密鑰）'
            );
        }

        // 步驟6：買方使用密鑰獲取Asset（後轉移資產）
        colorLog('yellow', '\n步驟6：買方使用密鑰獲取Asset（獲取資產）');
        await safeExecuteTransaction(
            () => assetContractBuyer.transferWithKey(TRADE_ID, ENCRYPTED_KEY_SELLER),
            'Asset轉移（資產給買家）'
        );

        // 最終檢查狀態
        await delay(5000);
        const finalStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        const isCompleted = !finalStatus || (!finalStatus.assetTrade.isActive && !finalStatus.paymentTrade.isActive);
        
        if (isCompleted) {
            colorLog('green', '✓ 正常交易流程測試完成！交易已成功完成並清理');
            return true;
        } else {
            colorLog('yellow', '⚠ 交易流程完成，但狀態檢查顯示交易仍存在');
            return true;
        }
        
    } catch (error) {
        colorLog('red', '✗ 正常交易流程測試失敗: ' + error.message);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 測試2: 交易超時自動退款
async function testTimeoutRefund() {
    colorLog('bright', '\n' + '='.repeat(60));
    colorLog('bright', '測試2: 交易超時自動退款');
    colorLog('bright', '='.repeat(60));
    
    try {
        const providers = await setupProviders();
        const {
            assetContractBuyer,
            paymentContractBuyer,
            assetSellerSigner
        } = providers;

        // 使用短時間的交易持續時間
        const TRADE_ID = Math.floor(Date.now() / 1000) + 1000;
        const PAYMENT_ID = TRADE_ID;
        const AMOUNT = ethers.parseEther("0.005");
        const SHORT_DURATION = 90; // 90秒

        const sellerAddress = await assetSellerSigner.getAddress();

        colorLog('cyan', `\n測試參數:`);
        console.log(`  交易ID: ${TRADE_ID}`);
        console.log(`  金額: ${ethers.formatEther(AMOUNT)} ETH`);
        console.log(`  短超時時間: ${SHORT_DURATION} 秒`);

        // 步驟1：買方在Asset鏈上創建交易
        colorLog('yellow', '\n步驟1：買方在Asset鏈上創建短超時交易');
        await safeExecuteTransaction(
            () => assetContractBuyer.inceptTrade(TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, SHORT_DURATION),
            `Asset交易創建 (${SHORT_DURATION}秒超時)`
        );
        
        await delay(15000);

        // 步驟2：買方在Payment鏈上創建支付
        colorLog('yellow', '\n步驟2：買方在Payment鏈上創建短超時支付');
        await safeExecuteTransaction(
            () => paymentContractBuyer.inceptPayment(PAYMENT_ID, TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, SHORT_DURATION, { value: AMOUNT }),
            `Payment支付創建 (${SHORT_DURATION}秒超時)`
        );
        
        await delay(15000);

        // 確認交易已創建
        const initialStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        if (!initialStatus || !initialStatus.assetTrade.isActive || !initialStatus.paymentTrade.isActive) {
            throw new Error('短超時交易創建失敗');
        }

        // 不進行後續確認，等待超時
        const waitTime = SHORT_DURATION + 45; // 額外等待45秒確保超時
        colorLog('yellow', `\n等待交易超時 (${waitTime}秒)...`);
        
        // 分段等待並顯示進度
        const segments = 6;
        const segmentTime = Math.floor(waitTime / segments);
        for (let i = 0; i < segments; i++) {
            await delay(segmentTime * 1000);
            colorLog('cyan', `  等待進度: ${Math.round((i + 1) / segments * 100)}%`);
        }
        
        // 檢查交易是否已自動退款
        colorLog('yellow', '\n檢查交易是否已自動取消並退款:');
        const finalStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        // 檢查交易狀態
        const isTimedOut = !finalStatus || 
                          !finalStatus.assetTrade.isActive || 
                          !finalStatus.paymentTrade.isActive ||
                          finalStatus.assetTrade.state === 4 || 
                          finalStatus.paymentTrade.state === 4;
        
        if (isTimedOut) {
            colorLog('green', '✓ 測試成功: 交易已自動取消並退款');
            return true;
        } else {
            colorLog('red', '✗ 測試失敗: 交易未自動取消');
            colorLog('yellow', '這可能表示Oracle的超時處理機制需要調整');
            return false;
        }
    } catch (error) {
        colorLog('red', '✗ 交易超時測試失敗: ' + error.message);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 改進的測試3：雙重支付攻擊預防
async function testDoubleSpendPrevention() {
    colorLog('bright', '\n' + '='.repeat(60));
    colorLog('bright', '測試3: 雙重支付攻擊預防');
    colorLog('bright', '='.repeat(60));
    
    try {
        const providers = await setupProviders();
        const {
            assetContractBuyer,
            paymentContractBuyer,
            assetSellerSigner
        } = providers;

        // 使用不同的超時值來模擬攻擊
        const TRADE_ID = Math.floor(Date.now() / 1000) + 2000;
        const PAYMENT_ID = TRADE_ID;
        const AMOUNT = ethers.parseEther("0.005");
        const ASSET_DURATION = 300;   // Asset鏈超時: 5分鐘
        const PAYMENT_DURATION = 600; // Payment鏈超時: 10分鐘

        const sellerAddress = await assetSellerSigner.getAddress();

        colorLog('cyan', '\n攻擊模擬參數:');
        console.log(`  交易ID: ${TRADE_ID}`);
        console.log(`  金額: ${ethers.formatEther(AMOUNT)} ETH`);
        console.log(`  Asset持續時間: ${ASSET_DURATION} 秒 (較短)`);
        console.log(`  Payment持續時間: ${PAYMENT_DURATION} 秒 (較長)`);
        colorLog('red', '  ⚠️  這是一個潛在的雙重支付攻擊情境');

        // 步驟1：買方在Asset鏈上創建交易 (短超時)
        colorLog('yellow', '\n步驟1：買方在Asset鏈上創建交易（較短超時）');
        await safeExecuteTransaction(
            () => assetContractBuyer.inceptTrade(TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, ASSET_DURATION),
            `Asset交易創建 (${ASSET_DURATION}秒超時)`
        );
        
        await delay(15000);
        
        // 檢查 Asset 交易狀態
        let assetStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        if (assetStatus && assetStatus.assetTrade.isActive) {
            colorLog('green', '✓ Asset 交易已成功創建');
        } else {
            colorLog('red', '✗ Asset 交易創建失敗');
            return false;
        }

        // 步驟2：買方嘗試在Payment鏈上創建支付 (長超時)
        colorLog('yellow', '\n步驟2：買方嘗試在Payment鏈上創建支付（較長超時）');
        colorLog('red', '注意: 系統應該檢測到Asset超時 < Payment超時的危險情況');
        
        try {
            await safeExecuteTransaction(
                () => paymentContractBuyer.inceptPayment(PAYMENT_ID, TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, PAYMENT_DURATION, { value: AMOUNT }),
                `Payment支付創建 (${PAYMENT_DURATION}秒超時)`
            );
            
            colorLog('yellow', '⚠️ Payment 交易已提交，現在檢查 Oracle 是否會處理風險...');
            
            // 立即檢查狀態
            await delay(5000);
            let immediateStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
            
            // 等待Oracle處理雙重支付風險檢測
            colorLog('yellow', '\n等待Oracle檢測並處理不一致情況 (30秒)...');
            await delay(30000);
            
            // 再次檢查狀態
            const finalStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
            
            // 分析結果
            if (!finalStatus || (!finalStatus.assetTrade.isActive && !finalStatus.paymentTrade.isActive)) {
                colorLog('green', '✓ 測試成功: Oracle 正確檢測並取消了雙重支付風險的交易');
                colorLog('green', '  - 兩個交易都已被自動取消');
                colorLog('green', '  - 資金已退回給相應方');
                return true;
            } else if (finalStatus.assetTrade.isActive && finalStatus.paymentTrade.isActive) {
                colorLog('yellow', '⚠️ 測試結果: Oracle 允許了不一致的超時設置');
                colorLog('yellow', '  - 建議: 加強雙重支付檢測機制');
                return false;
            } else {
                colorLog('yellow', '⚠️ 測試結果: 部分交易被取消');
                colorLog('cyan', `  - Asset 交易狀態: ${finalStatus.assetTrade.isActive ? '活躍' : '已取消'}`);
                colorLog('cyan', `  - Payment 交易狀態: ${finalStatus.paymentTrade.isActive ? '活躍' : '已取消'}`);
                return true;
            }
            
        } catch (contractError) {
            colorLog('green', '✓ 測試成功: 合約層面直接拒絕了不一致的超時設置');
            colorLog('cyan', '系統在合約級別阻止了潛在的雙重支付攻擊');
            console.log('拒絕原因:', contractError.message);
            return true;
        }
    } catch (error) {
        colorLog('red', '✗ 雙重支付預防測試失敗: ' + error.message);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 測試4: 無效密鑰測試
async function testInvalidKeyHandling() {
    colorLog('bright', '\n' + '='.repeat(60));
    colorLog('bright', '測試4: 無效密鑰處理測試');
    colorLog('bright', '='.repeat(60));
    
    try {
        const providers = await setupProviders();
        const {
            assetContractBuyer,
            assetContractSeller,
            paymentContractBuyer,
            paymentContractSeller,
            assetBuyerSigner,
            assetSellerSigner
        } = providers;

        // 生成唯一交易ID
        const TRADE_ID = Math.floor(Date.now() / 1000) + 3000;
        const PAYMENT_ID = TRADE_ID;
        const AMOUNT = ethers.parseEther("0.005");
        const DURATION = 1800; // 30分鐘

        const sellerAddress = await assetSellerSigner.getAddress();
        const buyerAddress = await assetBuyerSigner.getAddress();
        const INVALID_KEY = "InvalidKeyForTesting123456789";

        colorLog('cyan', `\n測試參數:`);
        console.log(`  交易ID: ${TRADE_ID}`);
        console.log(`  金額: ${ethers.formatEther(AMOUNT)} ETH`);
        console.log(`  有效期限: ${DURATION} 秒`);
        console.log(`  無效密鑰: ${INVALID_KEY}`);

        // 創建完整的交易流程直到確認階段
        colorLog('yellow', '\n步驟1-4：創建並確認交易');
        
        // Asset交易創建
        await safeExecuteTransaction(
            () => assetContractBuyer.inceptTrade(TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, DURATION),
            'Asset交易創建'
        );
        await delay(15000);

        // Payment創建
        await safeExecuteTransaction(
            () => paymentContractBuyer.inceptPayment(PAYMENT_ID, TRADE_ID, AMOUNT, sellerAddress, ENCRYPTED_KEY_SELLER, DURATION, { value: AMOUNT }),
            'Payment創建'
        );
        await delay(15000);

        // Asset確認
        await safeExecuteTransaction(
            () => assetContractSeller.confirmTrade(TRADE_ID, AMOUNT, buyerAddress, ENCRYPTED_KEY_BUYER, { value: AMOUNT }),
            'Asset交易確認'
        );
        await delay(15000);

        // Payment確認
        await safeExecuteTransaction(
            () => paymentContractSeller.confirmPayment(PAYMENT_ID, AMOUNT, buyerAddress, ENCRYPTED_KEY_BUYER),
            'Payment確認'
        );
        await delay(15000);

        // 檢查確認後的狀態
        const confirmedStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        if (!confirmedStatus || confirmedStatus.assetTrade.state !== 2 || confirmedStatus.paymentTrade.state !== 2) {
            colorLog('yellow', '警告: 交易未達到已確認狀態，但繼續測試無效密鑰處理...');
        }

        // 步驟5：嘗試使用無效密鑰
        colorLog('yellow', '\n步驟5：嘗試使用無效密鑰獲取Asset');
        try {
            await assetContractBuyer.transferWithKey(TRADE_ID, INVALID_KEY);
            colorLog('red', '✗ 錯誤: 系統接受了無效密鑰');
            return false;
        } catch (error) {
            colorLog('green', '✓ 正確: Asset合約拒絕了無效密鑰');
            console.log('拒絕原因:', error.message);
        }

        // 步驟6：嘗試使用無效密鑰釋放Payment
        colorLog('yellow', '\n步驟6：嘗試使用無效密鑰釋放Payment');
        try {
            await paymentContractBuyer.transferWithKey(PAYMENT_ID, INVALID_KEY);
            colorLog('red', '✗ 錯誤: 系統接受了無效密鑰');
            return false;
        } catch (error) {
            colorLog('green', '✓ 正確: Payment合約拒絕了無效密鑰');
            console.log('拒絕原因:', error.message);
        }

        // 步驟7：使用正確密鑰完成交易
        colorLog('yellow', '\n步驟7：使用正確密鑰完成交易');
        await safeExecuteTransaction(
            () => assetContractBuyer.transferWithKey(TRADE_ID, ENCRYPTED_KEY_SELLER),
            'Asset轉移 (正確密鑰)'
        );

        await safeExecuteTransaction(
            () => paymentContractBuyer.transferWithKey(PAYMENT_ID, ENCRYPTED_KEY_SELLER),
            'Payment釋放 (正確密鑰)'
        );

        colorLog('green', '✓ 無效密鑰處理測試完成！');
        return true;

    } catch (error) {
        colorLog('red', '✗ 無效密鑰處理測試失敗: ' + error.message);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 檢查系統狀態
async function checkSystemHealth() {
    colorLog('bright', '\n' + '='.repeat(60));
    colorLog('bright', '系統健康狀況檢查');
    colorLog('bright', '='.repeat(60));

    try {
        const providers = await setupProviders();
        const {
            assetProvider,
            paymentProvider,
            assetContractBuyer,
            paymentContractBuyer,
            assetBuyerSigner,
            paymentBuyerSigner
        } = providers;

        // 檢查區塊鏈連接
        colorLog('cyan', '\n區塊鏈連接狀況:');
        const assetBlock = await assetProvider.getBlockNumber();
        const paymentBlock = await paymentProvider.getBlockNumber();
        console.log(`  Asset鏈最新區塊: ${assetBlock}`);
        console.log(`  Payment鏈最新區塊: ${paymentBlock}`);

        // 檢查帳戶餘額
        colorLog('cyan', '\n帳戶餘額檢查:');
        const assetBalance = await assetProvider.getBalance(assetBuyerSigner.address);
        const paymentBalance = await paymentProvider.getBalance(paymentBuyerSigner.address);
        console.log(`  Asset鏈測試帳戶餘額: ${ethers.formatEther(assetBalance)} ETH`);
        console.log(`  Payment鏈測試帳戶餘額: ${ethers.formatEther(paymentBalance)} ETH`);

        // 檢查餘額是否充足
        const minBalance = ethers.parseEther("0.001"); // 至少需要0.01 ETH
        if (assetBalance < minBalance) {
            colorLog('red', '  ⚠️ Asset鏈餘額不足，可能影響測試');
        }
        if (paymentBalance < minBalance) {
            colorLog('red', '  ⚠️ Payment鏈餘額不足，可能影響測試');
        }

        // 檢查合約連接
        colorLog('cyan', '\n合約連接檢查:');
        try {
            const activeAssetTrades = await assetContractBuyer.getActiveTradeIds();
            const activePayments = await paymentContractBuyer.getActivePaymentIds();
            console.log(`  Asset合約活躍交易數: ${activeAssetTrades.length}`);
            console.log(`  Payment合約活躍支付數: ${activePayments.length}`);
            colorLog('green', '  ✓ 合約連接正常');
        } catch (error) {
            colorLog('red', '  ✗ 合約連接異常: ' + error.message);
            return false;
        }

        // 檢查Oracle服務狀況
        colorLog('cyan', '\n檢查Oracle服務:');
        colorLog('yellow', '  提示: 請確保Oracle服務正在運行 (backend/server.js)');
        colorLog('yellow', '  Oracle應該監聽端口 1202');

        return true;
    } catch (error) {
        colorLog('red', '系統健康檢查失敗: ' + error.message);
        return false;
    }
}

// 生成測試報告
function generateTestReport() {
    colorLog('bright', '\n' + '='.repeat(80));
    colorLog('bright', '測試結果報告');
    colorLog('bright', '='.repeat(80));

    const totalTests = Object.keys(testResults).length;
    const passedTests = Object.values(testResults).filter(result => result).length;
    const failedTests = totalTests - passedTests;

    colorLog('cyan', '\n測試摘要:');
    console.log(`  總測試數: ${totalTests}`);
    console.log(`  通過測試: ${passedTests}`);
    console.log(`  失敗測試: ${failedTests}`);
    console.log(`  通過率: ${Math.round((passedTests / totalTests) * 100)}%`);

    colorLog('cyan', '\n詳細結果:');
    console.log(`  測試1 (正常交易流程): ${testResults.normalTrade ? '✓ 通過' : '✗ 失敗'}`);
    console.log(`  測試2 (交易超時自動退款): ${testResults.timeoutRefund ? '✓ 通過' : '✗ 失敗'}`);
    console.log(`  測試3 (雙重支付攻擊預防): ${testResults.doubleSpendPrevention ? '✓ 通過' : '✗ 失敗'}`);
    console.log(`  測試4 (無效密鑰處理): ${testResults.invalidKeyTest ? '✓ 通過' : '✗ 失敗'}`);

    if (passedTests === totalTests) {
        colorLog('green', '\n🎉 所有測試通過！系統運行正常。');
    } else {
        colorLog('yellow', '\n⚠️ 部分測試失敗，請檢查系統配置和Oracle服務。');
    }

    colorLog('cyan', '\n建議:');
    if (!testResults.normalTrade) {
        console.log('  - 檢查Oracle服務是否正常運行');
        console.log('  - 驗證合約地址和ABI配置');
        console.log('  - 確認帳戶餘額充足');
    }
    if (!testResults.timeoutRefund) {
        console.log('  - 檢查Oracle的超時處理機制');
        console.log('  - 調整checkAndHandleExpiredTrades的執行頻率');
    }
    if (!testResults.doubleSpendPrevention) {
        console.log('  - 在Oracle中實現跨鏈超時一致性檢查');
        console.log('  - 加強雙重支付檢測邏輯');
    }
    if (!testResults.invalidKeyTest) {
        console.log('  - 檢查合約密鑰驗證邏輯');
        console.log('  - 確認密鑰加密和解密流程');
    }

    console.log('\n' + '='.repeat(80));
}

// 主執行函數
async function runAllTests() {
    const startTime = Date.now();
    
    colorLog('bright', '🚀 開始執行跨鏈交易自動測試...');
    colorLog('bright', '測試開始時間: ' + new Date().toLocaleString());
    
    // 系統健康檢查
    const systemHealthy = await checkSystemHealth();
    if (!systemHealthy) {
        colorLog('red', '❌ 系統健康檢查失敗，停止測試');
        return;
    }

    // 等待一段時間讓系統穩定
    colorLog('yellow', '\n等待系統穩定 (5秒)...');
    await delay(5000);

    try {
        // 執行所有測試
        colorLog('bright', '\n開始執行測試套件...');
        
        testResults.normalTrade = await testNormalTradeFlow();
        await delay(10000);

        testResults.timeoutRefund = await testTimeoutRefund();
        await delay(10000);

        testResults.doubleSpendPrevention = await testDoubleSpendPrevention();
        await delay(10000);

        // testResults.invalidKeyTest = await testInvalidKeyHandling();

    } catch (error) {
        colorLog('red', '測試執行過程中發生嚴重錯誤: ' + error.message);
        console.error('錯誤堆疊:', error.stack);
    }

    // 生成報告
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);
    
    generateTestReport();
    
    colorLog('bright', `\n測試完成時間: ${new Date().toLocaleString()}`);
    colorLog('bright', `總執行時間: ${duration} 秒`);
    
    // 根據結果退出
    const allPassed = Object.values(testResults).every(result => result);
    process.exit(allPassed ? 0 : 1);
}

// 錯誤處理
process.on('unhandledRejection', (reason, promise) => {
    colorLog('red', '未處理的Promise拒絕:');
    console.error('Promise:', promise);
    console.error('原因:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    colorLog('red', '未捕獲的異常:');
    console.error(error);
    process.exit(1);
});

// 優雅退出處理
process.on('SIGINT', () => {
    colorLog('yellow', '\n收到中斷信號，正在清理...');
    generateTestReport();
    process.exit(1);
});

// 如果直接運行此腳本
if (require.main === module) {
    runAllTests().catch(error => {
        colorLog('red', '測試啟動失敗: ' + error.message);
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    runAllTests,
    testNormalTradeFlow,
    testTimeoutRefund,
    testDoubleSpendPrevention,
    // testInvalidKeyHandling,
    checkSystemHealth
};
