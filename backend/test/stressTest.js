const ethers = require('ethers');
require('dotenv').config();

// 批量測試配置
const NUM_TRADES = 5;           // 要執行的交易數量
const DELAY_BETWEEN_TRADES = 10000;  // 交易間隔時間（毫秒）
const BASE_AMOUNT = "0.01";     // 基本交易金額 (ETH)

// 合約ABI定義
const assetContractABI = [
    "function inceptTrade(uint id, uint256 amount, address payable seller, string memory keyEncryptedSeller, uint256 duration) public",
    "function confirmTrade(uint id, uint256 amount, address payable buyer, string memory keyEncryptedBuyer) public payable",
    "function transferWithKey(uint id, string memory key) public",
    "function getTrade(uint _tradeId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256)"
];

const paymentContractABI = [
    "function inceptPayment(uint id, uint assetTradeId, uint256 amount, address payable seller, string memory keyEncryptedSeller, uint256 duration) public payable",
    "function confirmPayment(uint id, uint256 amount, address payable buyer, string memory keyEncryptedBuyer) public",
    "function transferWithKey(uint id, string memory key) public",
    "function getPayment(uint _paymentId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256, uint)"
];

// 環境配置
const ASSET_ETHEREUM_NODE_URL = process.env.ASSET_ETHEREUM_NODE_URL; 
const PAYMENT_ETHEREUM_NODE_URL = process.env.PAYMENT_ETHEREUM_NODE_URL;
const ASSET_CONTRACT_ADDRESS = process.env.ASSET_CONTRACT_ADDRESS;
const PAYMENT_CONTRACT_ADDRESS = process.env.PAYMENT_CONTRACT_ADDRESS;
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY;
const SELLER_PRIVATE_KEY = process.env.SELLER_PRIVATE_KEY;

// 建立提供者和簽名者
async function setupProviders() {
    // Asset鏈連接
    const assetProvider = new ethers.JsonRpcProvider(ASSET_ETHEREUM_NODE_URL);
    const assetBuyerSigner = new ethers.Wallet(BUYER_PRIVATE_KEY, assetProvider);
    const assetSellerSigner = new ethers.Wallet(SELLER_PRIVATE_KEY, assetProvider);
    const assetContractBuyer = new ethers.Contract(ASSET_CONTRACT_ADDRESS, assetContractABI, assetBuyerSigner);
    const assetContractSeller = new ethers.Contract(ASSET_CONTRACT_ADDRESS, assetContractABI, assetSellerSigner);

    // Payment鏈連接
    const paymentProvider = new ethers.JsonRpcProvider(PAYMENT_ETHEREUM_NODE_URL);
    const paymentBuyerSigner = new ethers.Wallet(BUYER_PRIVATE_KEY, paymentProvider);
    const paymentSellerSigner = new ethers.Wallet(SELLER_PRIVATE_KEY, paymentProvider);
    const paymentContractBuyer = new ethers.Contract(PAYMENT_CONTRACT_ADDRESS, paymentContractABI, paymentBuyerSigner);
    const paymentContractSeller = new ethers.Contract(PAYMENT_CONTRACT_ADDRESS, paymentContractABI, paymentSellerSigner);

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
}

// 等待函數
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 單個交易流程
async function executeTrade(tradeIndex, providers) {
    const tradeId = Math.floor(Date.now() / 1000) + tradeIndex;
    const paymentId = tradeId;
    const amount = ethers.parseEther(BASE_AMOUNT);
    const duration = 3600; // 1小時
    const secretKey = `secret_${tradeId}`;
    // 使用固定的公鑰加密後的密鑰
    const encryptedKeyForSeller = "0QOwlviLqv5lfwLZkaZ7s8V2C5hB3KRe"; // sellerkey
    const encryptedKeyForBuyer = "ltRkeyWXsmA11d7qU3FCWfBs1LEwxXeU";   // buyerkey

    const {
        assetContractBuyer,
        assetContractSeller,
        paymentContractBuyer,
        paymentContractSeller,
        assetBuyerSigner,
        paymentBuyerSigner
    } = providers;

    const sellerAddress = await assetContractSeller.runner.provider.getSigner().getAddress();
    const buyerAddress = await assetBuyerSigner.getAddress();

    console.log(`\n===== 開始交易 #${tradeIndex+1} (ID: ${tradeId}) =====`);

    try {
        // 1. 買方在Asset鏈上創建交易
        console.log(`[交易 #${tradeIndex+1}] 步驟1: 買方在Asset鏈上創建交易`);
        let tx = await assetContractBuyer.inceptTrade(
            tradeId,
            amount,
            sellerAddress,
            encryptedKeyForSeller,
            duration
        );
        await tx.wait();
        
        // 2. 買方在Payment鏈上創建支付
        await delay(5000); // 等待Oracle處理
        console.log(`[交易 #${tradeIndex+1}] 步驟2: 買方在Payment鏈上創建支付`);
        tx = await paymentContractBuyer.inceptPayment(
            paymentId,
            tradeId,
            amount,
            sellerAddress,
            encryptedKeyForSeller,
            duration,
            { value: amount }
        );
        await tx.wait();
        
        // 3. 賣方確認Asset交易
        await delay(5000);
        console.log(`[交易 #${tradeIndex+1}] 步驟3: 賣方確認Asset交易`);
        tx = await assetContractSeller.confirmTrade(
            tradeId,
            amount,
            buyerAddress,
            encryptedKeyForBuyer,
            { value: amount }
        );
        await tx.wait();
        
        // 4. 賣方確認Payment
        await delay(5000);
        console.log(`[交易 #${tradeIndex+1}] 步驟4: 賣方確認Payment`);
        tx = await paymentContractSeller.confirmPayment(
            paymentId,
            amount,
            buyerAddress,
            encryptedKeyForBuyer
        );
        await tx.wait();
        
        // 5. 買方使用密鑰獲取Asset
        await delay(5000);
        console.log(`[交易 #${tradeIndex+1}] 步驟5: 買方使用密鑰獲取Asset`);
        tx = await assetContractBuyer.transferWithKey(tradeId, secretKey);
        await tx.wait();
        
        // 6. 買方使用密鑰釋放Payment
        await delay(5000);
        console.log(`[交易 #${tradeIndex+1}] 步驟6: 買方使用密鑰釋放Payment`);
        tx = await paymentContractBuyer.transferWithKey(paymentId, secretKey);
        await tx.wait();
        
        console.log(`[交易 #${tradeIndex+1}] 完成！\n`);
        return true;
    } catch (error) {
        console.error(`[交易 #${tradeIndex+1}] 錯誤:`, error.message);
        return false;
    }
}

// 執行壓力測試
async function runStressTest() {
    console.log(`開始壓力測試: ${NUM_TRADES}個交易，間隔${DELAY_BETWEEN_TRADES/1000}秒`);
    
    const providers = await setupProviders();
    const results = {
        total: NUM_TRADES,
        successful: 0,
        failed: 0
    };
    
    for (let i = 0; i < NUM_TRADES; i++) {
        const success = await executeTrade(i, providers);
        if (success) {
            results.successful++;
        } else {
            results.failed++;
        }
        
        if (i < NUM_TRADES - 1) {
            console.log(`等待${DELAY_BETWEEN_TRADES/1000}秒後開始下一筆交易...`);
            await delay(DELAY_BETWEEN_TRADES);
        }
    }
    
    console.log("\n===== 壓力測試結果 =====");
    console.log(`總交易數: ${results.total}`);
    console.log(`成功交易: ${results.successful}`);
    console.log(`失敗交易: ${results.failed}`);
    console.log(`成功率: ${(results.successful/results.total*100).toFixed(2)}%`);
    console.log("=========================");
}

// 執行測試
runStressTest().catch(error => {
    console.error("壓力測試執行失敗:", error);
});
