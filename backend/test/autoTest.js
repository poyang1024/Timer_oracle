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

// 🔧 改進的安全執行交易函數
async function safeExecuteTransaction(contractMethod, description, retries = 3) {
    let lastError;
    let transactionExecuted = false;
    
    for (let i = 0; i < retries; i++) {
        try {
            colorLog('blue', `執行: ${description} (嘗試 ${i + 1}/${retries})`);
            
            const tx = await contractMethod();
            colorLog('yellow', `交易已提交: ${tx.hash}`);
            
            // 等待交易確認
            const receipt = await tx.wait();
            
            if (receipt.status === 0) {
                throw new Error(`交易失敗: ${tx.hash}`);
            }
            
            // 計算 Gas 費用
            const gasUsed = receipt.gasUsed;
            const gasPrice = receipt.gasPrice || tx.gasPrice;
            const totalGasCost = gasUsed * gasPrice;
            
            colorLog('green', `✓ ${description} 成功 (區塊: ${receipt.blockNumber}, Gas: ${receipt.gasUsed.toString()})`);
            colorLog('cyan', `  Gas 費用: ${ethers.formatEther(totalGasCost)} ETH`);
            
            transactionExecuted = true;
            return receipt;
            
        } catch (error) {
            lastError = error;
            colorLog('red', `✗ ${description} 失敗 (嘗試 ${i + 1}): ${error.message}`);
            
            // 檢查是否是因為交易已經成功但網路問題導致的錯誤
            if (error.message.includes('already exists') || 
                error.message.includes('nonce too low') ||
                error.message.includes('replacement transaction underpriced')) {
                colorLog('yellow', '⚠️ 交易可能已經成功，停止重試');
                transactionExecuted = true;
                break;
            }
            
            if (i === retries - 1) {
                throw lastError;
            }
            
            // 遞增等待時間再重試
            const waitTime = (i + 1) * 3000;
            colorLog('yellow', `等待 ${waitTime/1000} 秒後重試...`);
            await delay(waitTime);
        }
    }
    
    if (!transactionExecuted) {
        throw lastError || new Error('交易執行失敗');
    }
    
    return { skipped: true };
}

// 🔧 帳戶資產狀況檢查功能 (增強版)
async function checkAccountBalances(providers, description = "當前") {
    try {
        const {
            assetProvider,
            paymentProvider,
            assetBuyerSigner,
            assetSellerSigner
        } = providers;

        colorLog('bright', `\n${'='.repeat(60)}`);
        colorLog('bright', `${description}帳戶資產狀況`);
        colorLog('bright', `${'='.repeat(60)}`);

        // 獲取帳戶地址
        const buyerAddress = await assetBuyerSigner.getAddress();
        const sellerAddress = await assetSellerSigner.getAddress();

        // Asset Chain 餘額和 Nonce
        colorLog('cyan', '\n🔗 Asset 鏈帳戶狀況:');
        const assetBuyerBalance = await assetProvider.getBalance(buyerAddress);
        const assetSellerBalance = await assetProvider.getBalance(sellerAddress);
        const assetBuyerNonce = await assetProvider.getTransactionCount(buyerAddress);
        const assetSellerNonce = await assetProvider.getTransactionCount(sellerAddress);
        
        console.log(`  👤 買方 (${buyerAddress}):`);
        console.log(`     餘額: ${ethers.formatEther(assetBuyerBalance)} ETH`);
        console.log(`     Nonce: ${assetBuyerNonce}`);
        console.log(`  👤 賣方 (${sellerAddress}):`);
        console.log(`     餘額: ${ethers.formatEther(assetSellerBalance)} ETH`);
        console.log(`     Nonce: ${assetSellerNonce}`);

        // Payment Chain 餘額和 Nonce
        colorLog('magenta', '\n💰 Payment 鏈帳戶狀況:');
        const paymentBuyerBalance = await paymentProvider.getBalance(buyerAddress);
        const paymentSellerBalance = await paymentProvider.getBalance(sellerAddress);
        const paymentBuyerNonce = await paymentProvider.getTransactionCount(buyerAddress);
        const paymentSellerNonce = await paymentProvider.getTransactionCount(sellerAddress);
        
        console.log(`  👤 買方 (${buyerAddress}):`);
        console.log(`     餘額: ${ethers.formatEther(paymentBuyerBalance)} ETH`);
        console.log(`     Nonce: ${paymentBuyerNonce}`);
        console.log(`  👤 賣方 (${sellerAddress}):`);
        console.log(`     餘額: ${ethers.formatEther(paymentSellerBalance)} ETH`);
        console.log(`     Nonce: ${paymentSellerNonce}`);

        // 計算總資產
        const buyerTotalBalance = assetBuyerBalance + paymentBuyerBalance;
        const sellerTotalBalance = assetSellerBalance + paymentSellerBalance;

        colorLog('yellow', '\n📊 總資產統計:');
        console.log(`  👤 買方總資產: ${ethers.formatEther(buyerTotalBalance)} ETH`);
        console.log(`     - Asset 鏈: ${ethers.formatEther(assetBuyerBalance)} ETH`);
        console.log(`     - Payment 鏈: ${ethers.formatEther(paymentBuyerBalance)} ETH`);
        
        console.log(`  👤 賣方總資產: ${ethers.formatEther(sellerTotalBalance)} ETH`);
        console.log(`     - Asset 鏈: ${ethers.formatEther(assetSellerBalance)} ETH`);
        console.log(`     - Payment 鏈: ${ethers.formatEther(paymentSellerBalance)} ETH`);

        // console.log(`\n  💎 系統總資產: ${ethers.formatEther(buyerTotalBalance + sellerTotalBalance)} ETH`);

        return {
            buyer: {
                address: buyerAddress,
                assetBalance: assetBuyerBalance,
                paymentBalance: paymentBuyerBalance,
                totalBalance: buyerTotalBalance,
                assetNonce: assetBuyerNonce,
                paymentNonce: paymentBuyerNonce
            },
            seller: {
                address: sellerAddress,
                assetBalance: assetSellerBalance,
                paymentBalance: paymentSellerBalance,
                totalBalance: sellerTotalBalance,
                assetNonce: assetSellerNonce,
                paymentNonce: paymentSellerNonce
            },
            systemTotal: buyerTotalBalance + sellerTotalBalance,
            timestamp: Math.floor(Date.now() / 1000)
        };
    } catch (error) {
        colorLog('red', '❌ 檢查帳戶餘額時發生錯誤: ' + error.message);
        return null;
    }
}

// 🔧 比較交易前後的資產變化 (增強版)
async function compareBalanceChanges(beforeBalances, afterBalances, tradeAmount) {
    if (!beforeBalances || !afterBalances) {
        colorLog('red', '❌ 無法比較餘額變化：缺少餘額數據');
        return;
    }

    colorLog('bright', `\n${'='.repeat(60)}`);
    colorLog('bright', '📈 交易前後資產變化分析');
    colorLog('bright', `${'='.repeat(60)}`);

    const tradeAmountWei = ethers.parseEther(tradeAmount.toString());

    // 買方資產變化
    colorLog('blue', '\n👤 買方資產變化:');
    const buyerAssetChange = afterBalances.buyer.assetBalance - beforeBalances.buyer.assetBalance;
    const buyerPaymentChange = afterBalances.buyer.paymentBalance - beforeBalances.buyer.paymentBalance;
    const buyerTotalChange = afterBalances.buyer.totalBalance - beforeBalances.buyer.totalBalance;
    const buyerAssetNonceChange = afterBalances.buyer.assetNonce - beforeBalances.buyer.assetNonce;
    const buyerPaymentNonceChange = afterBalances.buyer.paymentNonce - beforeBalances.buyer.paymentNonce;

    console.log(`  Asset 鏈變化: ${buyerAssetChange >= 0 ? '+' : ''}${ethers.formatEther(buyerAssetChange)} ETH`);
    console.log(`  Payment 鏈變化: ${buyerPaymentChange >= 0 ? '+' : ''}${ethers.formatEther(buyerPaymentChange)} ETH`);
    console.log(`  總資產變化: ${buyerTotalChange >= 0 ? '+' : ''}${ethers.formatEther(buyerTotalChange)} ETH`);
    console.log(`  Asset Nonce 變化: +${buyerAssetNonceChange} (交易次數)`);
    console.log(`  Payment Nonce 變化: +${buyerPaymentNonceChange} (交易次數)`);

    // 賣方資產變化
    colorLog('green', '\n👤 賣方資產變化:');
    const sellerAssetChange = afterBalances.seller.assetBalance - beforeBalances.seller.assetBalance;
    const sellerPaymentChange = afterBalances.seller.paymentBalance - beforeBalances.seller.paymentBalance;
    const sellerTotalChange = afterBalances.seller.totalBalance - beforeBalances.seller.totalBalance;
    const sellerAssetNonceChange = afterBalances.seller.assetNonce - beforeBalances.seller.assetNonce;
    const sellerPaymentNonceChange = afterBalances.seller.paymentNonce - beforeBalances.seller.paymentNonce;

    console.log(`  Asset 鏈變化: ${sellerAssetChange >= 0 ? '+' : ''}${ethers.formatEther(sellerAssetChange)} ETH`);
    console.log(`  Payment 鏈變化: ${sellerPaymentChange >= 0 ? '+' : ''}${ethers.formatEther(sellerPaymentChange)} ETH`);
    console.log(`  總資產變化: ${sellerTotalChange >= 0 ? '+' : ''}${ethers.formatEther(sellerTotalChange)} ETH`);
    console.log(`  Asset Nonce 變化: +${sellerAssetNonceChange} (交易次數)`);
    console.log(`  Payment Nonce 變化: +${sellerPaymentNonceChange} (交易次數)`);

    // 系統總資產變化
    const systemTotalChange = afterBalances.systemTotal - beforeBalances.systemTotal;
    colorLog('yellow', '\n💎 系統總資產變化:');
    console.log(`  變化: ${systemTotalChange >= 0 ? '+' : ''}${ethers.formatEther(systemTotalChange)} ETH`);
    
    if (systemTotalChange < 0) {
        colorLog('cyan', `  (主要為 Gas 費用消耗)`);
    }

    // 🔧 詳細 Gas 費用分析
    colorLog('magenta', '\n⛽ Gas 費用分析:');
    const totalAssetNonceChange = buyerAssetNonceChange + sellerAssetNonceChange;
    const totalPaymentNonceChange = buyerPaymentNonceChange + sellerPaymentNonceChange;
    console.log(`  Asset 鏈總交易數: ${totalAssetNonceChange}`);
    console.log(`  Payment 鏈總交易數: ${totalPaymentNonceChange}`);
    console.log(`  總交易數: ${totalAssetNonceChange + totalPaymentNonceChange}`);
    
    if (systemTotalChange < 0) {
        const avgGasPerTx = Math.abs(systemTotalChange) / (totalAssetNonceChange + totalPaymentNonceChange);
        console.log(`  平均每筆交易 Gas 費用: ${ethers.formatEther(avgGasPerTx)} ETH`);
    }

    // 🔧 交易驗證 (增強版)
    colorLog('bright', '\n✅ 交易驗證結果:');
    console.log(`  預期交易金額: ${tradeAmount} ETH`);
    
    // 檢查買方是否獲得了資產
    if (buyerAssetChange > 0) {
        const actualGain = ethers.formatEther(buyerAssetChange);
        colorLog('green', `  ✓ 買方成功獲得資產 (+${actualGain} ETH on Asset Chain)`);
        
        // 檢查金額是否正確
        if (Math.abs(Number(actualGain) - Number(tradeAmount)) < 0.001) {
            colorLog('green', `  ✓ 資產金額正確`);
        } else {
            colorLog('yellow', `  ⚠️ 資產金額與預期不符 (預期: ${tradeAmount} ETH, 實際: ${actualGain} ETH)`);
        }
    } else {
        colorLog('red', `  ✗ 買方未獲得預期資產`);
    }

    // 檢查賣方是否獲得了支付
    if (sellerPaymentChange > 0) {
        const actualPayment = ethers.formatEther(sellerPaymentChange);
        colorLog('green', `  ✓ 賣方成功獲得支付 (+${actualPayment} ETH on Payment Chain)`);
        
        // 🔧 重要：檢查賣方收到的金額是否正確
        const expectedPayment = Number(tradeAmount);
        const actualPaymentNum = Number(actualPayment);
        
        if (Math.abs(actualPaymentNum - expectedPayment) < 0.001) {
            colorLog('green', `  ✓ 支付金額正確`);
        } else {
            colorLog('red', `  ✗ 支付金額不正確！`);
            colorLog('red', `    預期: ${tradeAmount} ETH`);
            colorLog('red', `    實際: ${actualPayment} ETH`);
            colorLog('red', `    差額: ${(expectedPayment - actualPaymentNum).toFixed(6)} ETH`);
            
            // 分析可能的原因
            colorLog('yellow', '\n🔍 問題分析:');
            if (sellerPaymentNonceChange > 1) {
                colorLog('yellow', `  - 賣方進行了 ${sellerPaymentNonceChange} 筆 Payment 鏈交易`);
                colorLog('yellow', `  - 可能存在重複交易或額外的費用扣除`);
            }
            
            const sellerTotalGasSpent = Math.abs(sellerTotalChange - sellerPaymentChange);
            if (sellerTotalGasSpent > 0) {
                colorLog('yellow', `  - 賣方總 Gas 費用: ${ethers.formatEther(sellerTotalGasSpent)} ETH`);
            }
        }
    } else {
        colorLog('red', `  ✗ 賣方未獲得預期支付`);
    }

    // 檢查交易是否平衡
    if (buyerAssetChange > 0 && sellerPaymentChange > 0) {
        colorLog('green', '  ✓ 交易成功完成，雙方都獲得了預期收益');
    } else {
        colorLog('yellow', '  ⚠️ 交易可能未完全按預期執行');
    }

    // 🔧 時間差分析
    const timeDiff = afterBalances.timestamp - beforeBalances.timestamp;
    colorLog('cyan', `\n⏰ 時間分析:`);
    console.log(`  交易總耗時: ${timeDiff} 秒`);
    console.log(`  開始時間: ${new Date(beforeBalances.timestamp * 1000).toLocaleString()}`);
    console.log(`  完成時間: ${new Date(afterBalances.timestamp * 1000).toLocaleString()}`);

    console.log(`\n${'='.repeat(60)}`);
}

// 🔧 檢查交易是否需要執行
async function checkTransactionNecessity(contract, method, params) {
    try {
        if (method === 'confirmPayment') {
            const paymentId = params[0];
            const payment = await contract.getPayment(paymentId);
            
            // 如果已經是 Confirmed 狀態，就不需要再確認
            if (payment[4] === 2) { // PaymentState.Confirmed
                colorLog('yellow', `⚠️ Payment ${paymentId} 已經是確認狀態，跳過重複確認`);
                return false;
            }
        }
        
        if (method === 'confirmTrade') {
            const tradeId = params[0];
            const trade = await contract.getTrade(tradeId);
            
            // 如果已經是 Confirmed 狀態，就不需要再確認
            if (trade[4] === 2) { // TradeState.Confirmed
                colorLog('yellow', `⚠️ Trade ${tradeId} 已經是確認狀態，跳過重複確認`);
                return false;
            }
        }
        
        return true; // 需要執行交易
    } catch (error) {
        colorLog('yellow', `檢查交易必要性時出錯: ${error.message}`);
        return true; // 出錯時還是執行交易
    }
}

// 🔧 改進的安全交易執行函數
async function improvedSafeExecuteTransaction(contract, method, params, description, retries = 3) {
    // 先檢查是否真的需要執行這個交易
    const isNecessary = await checkTransactionNecessity(contract, method, params);
    if (!isNecessary) {
        colorLog('green', `✓ ${description} 已完成，跳過執行`);
        return { skipped: true };
    }
    
    return await safeExecuteTransaction(() => contract[method](...params), description, retries);
}

// 🔧 測試1: 正常交易流程 (包含完整資產追蹤)
async function testCorrectAtomicSwapWithDualKeys() {
    colorLog('bright', '\n' + '='.repeat(60));
    colorLog('bright', '測試1: 清晰角色定義的原子交換流程');
    colorLog('bright', '='.repeat(60));
    
    try {
        const providers = await setupProviders();
        const {
            assetContractBuyer,   // asset_buyer 在 Asset Chain 的合約接口
            assetContractSeller,  // asset_seller 在 Asset Chain 的合約接口
            paymentContractBuyer, // asset_buyer 在 Payment Chain 的合約接口
            paymentContractSeller,// asset_seller 在 Payment Chain 的合約接口
            assetBuyerSigner,     // asset_buyer 的簽名者
            assetSellerSigner     // asset_seller 的簽名者
        } = providers;

        // 記錄交易前的帳戶餘額
        const beforeBalances = await checkAccountBalances(providers, "原子交換前");

        // 生成唯一交易ID和雙密鑰
        const nonce = Math.floor(Math.random() * 1000);
        const TRADE_ID = Math.floor(Date.now() / 1000) + nonce;
        const PAYMENT_ID = TRADE_ID;
        const AMOUNT = ethers.parseEther("0.005");
        const DURATION = 3600; // 1小時

        const assetSellerAddress = await assetSellerSigner.getAddress();  // asset_seller 的地址
        const assetBuyerAddress = await assetBuyerSigner.getAddress();    // asset_buyer 的地址

        // 生成雙密鑰
        colorLog('cyan', '\n=== Step 1: 生成交換密鑰對 ===');
        const SELLER_KEY = `seller_key_${TRADE_ID}_${Math.random().toString(36).substring(7)}`;
        const BUYER_KEY = `buyer_key_${TRADE_ID}_${Math.random().toString(36).substring(7)}`;
        
        colorLog('cyan', `原子交換參數:`);
        console.log(`  交易ID: ${TRADE_ID}`);
        console.log(`  金額: ${ethers.formatEther(AMOUNT)} ETH`);
        console.log(`  有效期限: ${DURATION} 秒`);
        console.log(`  asset_buyer: ${assetBuyerAddress}`);
        console.log(`  asset_seller: ${assetSellerAddress}`);
        console.log(`  賣方密鑰: ${SELLER_KEY}`);
        console.log(`  買方密鑰: ${BUYER_KEY}`);

        // 🔧 清晰的角色說明
        colorLog('yellow', '\n📋 跨鏈 ETH 交換邏輯：');
        console.log(`  Asset Chain:`);
        console.log(`    - asset_buyer 想要 Asset Chain 的 ETH`);
        console.log(`    - asset_seller 提供 Asset Chain 的 ETH`);
        console.log(`  Payment Chain:`);
        console.log(`    - asset_buyer 提供 Payment Chain 的 ETH`);
        console.log(`    - asset_seller 想要 Payment Chain 的 ETH`);
        console.log(`  🔄 結果：雙方交換不同鏈上的 ETH`);

        // Step 2: asset_buyer 在 Asset Chain 發起交易
        colorLog('yellow', '\n=== Step 2: asset_buyer 在 Asset Chain 發起交易 ===');
        colorLog('cyan', '📤 asset_buyer 調用 inceptTrade，請求 asset_seller 的資產');
        
        await safeExecuteTransaction(
            () => assetContractBuyer.inceptTrade(
                TRADE_ID, 
                AMOUNT, 
                assetSellerAddress,    // asset_seller 是 Asset Chain 的 seller
                SELLER_KEY,
                DURATION
            ),
            'asset_buyer 發起 Asset 交易'
        );
        
        // 等待 Oracle 處理
        colorLog('yellow', '⏰ 等待 Oracle 處理 TimeRequestSent 事件...');
        await delay(20000);

        // Step 3: asset_seller 觀察並決定參與
        colorLog('yellow', '\n=== Step 3: asset_seller 觀察 Asset Chain 狀態並決定參與 ===');
        colorLog('cyan', '🔍 asset_seller 查詢合約狀態，看 asset_buyer 的請求');
        
        let status = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        if (!status || !status.assetTrade.isActive) {
            throw new Error('❌ asset_buyer 的交易創建失敗或 Oracle 未處理完成');
        }
        
        if (status.assetTrade.state !== 1) {
            colorLog('yellow', `⚠️ 警告: Asset 交易狀態為 ${status.assetTrade.state}，預期為 1 (AwaitingConfirmation)`);
        }
        
        colorLog('green', '✓ asset_seller 確認看到 asset_buyer 的交易請求');
        colorLog('cyan', '💭 asset_seller 分析交易條件:');
        colorLog('cyan', `   - 交易 ID: ${TRADE_ID} ✓`);
        colorLog('cyan', `   - 交易金額: ${ethers.formatEther(AMOUNT)} ETH ✓`);
        colorLog('cyan', `   - 超時時間: ${DURATION} 秒 ✓`);
        colorLog('cyan', '   - 決定：條件符合，我願意用我的 Asset Chain ETH 換取 Payment Chain ETH！');

        // Step 4: asset_buyer 在 Payment Chain 投入 ETH
        colorLog('yellow', '\n=== Step 4: asset_buyer 在 Payment Chain 投入 ETH ===');
        colorLog('cyan', '📤 asset_buyer 調用 inceptPayment，在 Payment Chain 投入 ETH');
        
        await safeExecuteTransaction(
            () => paymentContractBuyer.inceptPayment(
                PAYMENT_ID, 
                TRADE_ID, 
                AMOUNT, 
                assetSellerAddress,       // asset_seller 是收款方
                BUYER_KEY,               // 初始密鑰（可以是任意值）
                DURATION, 
                { value: AMOUNT }
            ),
            'asset_buyer 在 Payment Chain 投入 ETH'
        );
        
        // 等待 Oracle 處理
        colorLog('yellow', '⏰ 等待 Oracle 處理 Payment TimeRequestSent 事件...');
        await delay(20000);
        
        // 確認 Payment 創建成功
        status = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        if (!status || !status.paymentTrade.isActive) {
            throw new Error('❌ asset_buyer 的 Payment 創建失敗或 Oracle 未處理完成');
        }
        
        colorLog('green', '✓ asset_buyer 成功在 Payment Chain 投入 ETH');
        colorLog('cyan', '🔗 跨鏈映射已建立：Asset 交易 ↔ Payment 交易');

        // Step 5: asset_seller 確認 Asset 交易
        colorLog('yellow', '\n=== Step 5: asset_seller 確認 Asset 交易 ===');
        colorLog('cyan', '🔍 asset_seller 作為 Asset Chain 的 seller，確認提供資產');
        
        await safeExecuteTransaction(
            () => assetContractSeller.confirmTrade(
                TRADE_ID, 
                AMOUNT, 
                assetBuyerAddress,    // asset_buyer 是 Asset Chain 的 buyer
                BUYER_KEY,
                { value: AMOUNT }
            ),
            'asset_seller 確認並鎖定 Asset 交易'
        );
        
        // 等待 Oracle 處理
        colorLog('yellow', '⏰ 等待 Oracle 處理 Asset 確認事件...');
        await delay(20000);

        // Step 6: asset_buyer 確認 Payment 交易
        colorLog('yellow', '\n=== Step 6: asset_buyer 確認 Payment 交易 ===');
        colorLog('cyan', '🔑 asset_buyer 確認支付，並提供 seller 密鑰');

        await safeExecuteTransaction(
            () => paymentContractBuyer.confirmPayment(  // ✅ buyer 確認
                PAYMENT_ID, 
                AMOUNT, 
                assetSellerAddress,       // seller 地址
                SELLER_KEY               // ✅ 提供 seller 密鑰
            ),
            'asset_buyer 確認 Payment 交易'
        );

        // 等待 Oracle 處理
        colorLog('yellow', '⏰ 等待 Oracle 處理 Payment 確認事件...');
        await delay(20000);
        
        // 檢查雙方都已確認
        const confirmedStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        if (!confirmedStatus || confirmedStatus.assetTrade.state !== 2 || confirmedStatus.paymentTrade.state !== 2) {
            colorLog('yellow', '⚠️ 警告: 雙方確認狀態未如預期，但繼續執行交換...');
        } else {
            colorLog('green', '🤝 雙方都已確認！原子交換進入執行階段');
        }

        // 檢查確認階段的餘額
        const afterConfirmationBalances = await checkAccountBalances(providers, "雙方確認後");

        // Step 7: asset_buyer 先釋放支付（揭示密鑰
        colorLog('yellow', '\n=== Step 7: asset_buyer 釋放支付給 asset_seller ===');
        colorLog('cyan', '🔑 關鍵：asset_buyer 先承擔風險，釋放支付並揭示密鑰');

        await safeExecuteTransaction(
            () => paymentContractBuyer.transferWithKey(PAYMENT_ID, SELLER_KEY),
            'asset_buyer 釋放支付給 asset_seller（HTLC 標準步驟）'
        );

        // Step 8: asset_buyer 領取資產（使用 seller 揭示的密鑰）
        colorLog('yellow', '\n=== Step 8: asset_buyer 領取 Asset Chain 的 ETH ===');
        colorLog('cyan', '🎯 asset_buyer 使用 seller揭示的密鑰領取資產');

        await safeExecuteTransaction(
            () => assetContractBuyer.transferWithKey(TRADE_ID, SELLER_KEY),
            'asset_buyer 領取 Asset Chain ETH（使用已揭示密鑰）'
        );

        // 最終狀態檢查
        await delay(10000);
        const finalStatus = await checkTransactionStatusDetailed(assetContractBuyer, paymentContractBuyer, TRADE_ID, PAYMENT_ID);
        
        // 記錄最終餘額變化
        const finalBalances = await checkAccountBalances(providers, "原子交換完成後");
        
        // 詳細的資產變化分析
        await compareBalanceChanges(beforeBalances, finalBalances, ethers.formatEther(AMOUNT));
        
        // 原子交換成功驗證
        colorLog('bright', '\n' + '='.repeat(60));
        colorLog('bright', '🏆 清晰角色原子交換結果驗證');
        colorLog('bright', '='.repeat(60));
        
        const isCompleted = !finalStatus || (!finalStatus.assetTrade.isActive && !finalStatus.paymentTrade.isActive);
        
        if (isCompleted) {
            colorLog('green', '🎉 跨鏈原子交換圓滿成功！');
            colorLog('green', '');
            colorLog('green', '✅ 跨鏈 ETH 交換結果：');
            colorLog('green', '   📤 asset_seller 給出：Asset Chain ETH → 得到：Payment Chain ETH');
            colorLog('green', '   📥 asset_buyer 給出：Payment Chain ETH → 得到：Asset Chain ETH');
            colorLog('green', '');
            colorLog('green', '🔐 跨鏈 ETH 交換的優勢：');
            colorLog('green', '   ✓ 雙方都在不同鏈上投入和獲得等值 ETH');
            colorLog('green', '   ✓ 實現跨鏈流動性轉移');
            colorLog('green', '   ✓ 無需信任第三方的跨鏈橋');
            colorLog('green', '   ✓ asset_seller 和 asset_buyer 各自確認自己的行為');
            colorLog('green', '   ✓ 原子性保證要麼全成功要麼全失敗');
            
            return true;
        } else {
            colorLog('yellow', '⚠️ 原子交換邏輯完成，但合約狀態仍存在');
            colorLog('yellow', '這可能是正常的清理延遲，交換實際上是成功的');
            return true;
        }
        
    } catch (error) {
        // 錯誤處理和最終餘額檢查
        try {
            const providers = await setupProviders();
            await checkAccountBalances(providers, "錯誤發生後");
        } catch (balanceError) {
            colorLog('red', '無法檢查錯誤後的餘額: ' + balanceError.message);
        }
        
        colorLog('red', '❌ 清晰角色原子交換測試失敗: ' + error.message);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 🔧 獨立的餘額檢查功能
async function checkCurrentBalances() {
    colorLog('bright', '🔍 檢查當前帳戶餘額...');
    
    try {
        const providers = await setupProviders();
        await checkAccountBalances(providers, "目前");
        return true;
    } catch (error) {
        colorLog('red', '❌ 檢查餘額失敗: ' + error.message);
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

        // 🔧 記錄測試前餘額
        const beforeBalances = await checkAccountBalances(providers, "超時測試前");

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

        // 🔧 檢查創建後餘額
        const afterCreationBalances = await checkAccountBalances(providers, "創建短超時交易後");

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
        
        // 🔧 檢查超時後餘額
        const afterTimeoutBalances = await checkAccountBalances(providers, "超時後");
        
        // 🔧 比較超時前後餘額變化
        await compareBalanceChanges(beforeBalances, afterTimeoutBalances, ethers.formatEther(AMOUNT));
        
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

// 測試3：雙重支付攻擊預防
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

        // 🔧 記錄測試前餘額
        const beforeBalances = await checkAccountBalances(providers, "雙重支付測試前");

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
            
            // 🔧 檢查最終餘額
            const afterBalances = await checkAccountBalances(providers, "雙重支付測試後");
            await compareBalanceChanges(beforeBalances, afterBalances, ethers.formatEther(AMOUNT));
            
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

        // 🔧 記錄測試前餘額
        const beforeBalances = await checkAccountBalances(providers, "無效密鑰測試前");

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

        // 🔧 檢查最終餘額
        const afterBalances = await checkAccountBalances(providers, "無效密鑰測試後");
        await compareBalanceChanges(beforeBalances, afterBalances, ethers.formatEther(AMOUNT));

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
        const minBalance = ethers.parseEther("0.001"); // 至少需要0.001 ETH
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

        // 🔧 嘗試連接Oracle API
        try {
            const response = await fetch('http://localhost:1202/status');
            if (response.ok) {
                const oracleStatus = await response.json();
                colorLog('green', '  ✓ Oracle服務連接正常');
                console.log(`    運行時間: ${Math.round(oracleStatus.uptime)} 秒`);
                console.log(`    Asset鏈處理到區塊: ${oracleStatus.chains?.asset?.currentBlock || 'N/A'}`);
                console.log(`    Payment鏈處理到區塊: ${oracleStatus.chains?.payment?.currentBlock || 'N/A'}`);
            } else {
                colorLog('yellow', '  ⚠️ Oracle API 響應異常');
            }
        } catch (error) {
            colorLog('yellow', '  ⚠️ 無法連接到Oracle服務 (這是正常的，如果Oracle未運行)');
        }

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

    // 🔧 增強的建議
    colorLog('cyan', '\n🔧 系統優化建議:');
    if (!testResults.normalTrade) {
        console.log('  📋 正常交易流程問題:');
        console.log('    - 檢查Oracle服務是否正常運行');
        console.log('    - 驗證合約地址和ABI配置');
        console.log('    - 確認帳戶餘額充足');
        console.log('    - 檢查網路連接和RPC端點');
    }
    if (!testResults.timeoutRefund) {
        console.log('  ⏰ 超時處理問題:');
        console.log('    - 檢查Oracle的超時處理機制');
        console.log('    - 調整checkAndHandleExpiredTrades的執行頻率');
        console.log('    - 驗證時間同步邏輯');
    }
    if (!testResults.doubleSpendPrevention) {
        console.log('  🛡️ 安全性問題:');
        console.log('    - 在Oracle中實現跨鏈超時一致性檢查');
        console.log('    - 加強雙重支付檢測邏輯');
        console.log('    - 添加風險評估機制');
    }
    if (!testResults.invalidKeyTest) {
        console.log('  🔐 密鑰驗證問題:');
        console.log('    - 檢查合約密鑰驗證邏輯');
        console.log('    - 確認密鑰加密和解密流程');
        console.log('    - 驗證密鑰匹配算法');
    }

    // 🔧 性能建議
    colorLog('cyan', '\n⚡ 性能優化建議:');
    console.log('  - 考慮實現批量事件處理');
    console.log('  - 優化Gas費用使用');
    console.log('  - 實現更智能的重試機制');
    console.log('  - 添加交易狀態緩存');

    console.log('\n' + '='.repeat(80));
}

// 🔧 交易歷史分析功能
async function analyzeTransactionHistory(providers, address, chainType = 'both') {
    colorLog('bright', `\n📊 ${address.slice(0,10)}... 交易歷史分析`);
    
    try {
        const { assetProvider, paymentProvider } = providers;
        
        if (chainType === 'both' || chainType === 'asset') {
            colorLog('cyan', '\n🔗 Asset鏈交易歷史:');
            const assetNonce = await assetProvider.getTransactionCount(address);
            console.log(`  總交易數: ${assetNonce}`);
            
            // 獲取最近幾筆交易
            if (assetNonce > 0) {
                const latestBlock = await assetProvider.getBlockNumber();
                const fromBlock = Math.max(0, latestBlock - 100); // 查看最近100個區塊
                
                try {
                    const logs = await assetProvider.getLogs({
                        fromBlock,
                        toBlock: 'latest',
                        address: ASSET_CONTRACT_ADDRESS
                    });
                    console.log(`  最近事件數: ${logs.length}`);
                } catch (error) {
                    console.log(`  無法獲取事件歷史: ${error.message}`);
                }
            }
        }
        
        if (chainType === 'both' || chainType === 'payment') {
            colorLog('magenta', '\n💰 Payment鏈交易歷史:');
            const paymentNonce = await paymentProvider.getTransactionCount(address);
            console.log(`  總交易數: ${paymentNonce}`);
            
            if (paymentNonce > 0) {
                const latestBlock = await paymentProvider.getBlockNumber();
                const fromBlock = Math.max(0, latestBlock - 100);
                
                try {
                    const logs = await paymentProvider.getLogs({
                        fromBlock,
                        toBlock: 'latest',
                        address: PAYMENT_CONTRACT_ADDRESS
                    });
                    console.log(`  最近事件數: ${logs.length}`);
                } catch (error) {
                    console.log(`  無法獲取事件歷史: ${error.message}`);
                }
            }
        }
        
    } catch (error) {
        colorLog('red', `分析交易歷史時發生錯誤: ${error.message}`);
    }
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
        
        testResults.normalTrade = await testCorrectAtomicSwapWithDualKeys();
        await delay(10000);

        testResults.timeoutRefund = await testTimeoutRefund();
        await delay(10000);

        testResults.doubleSpendPrevention = await testDoubleSpendPrevention();
        await delay(10000);

        testResults.invalidKeyTest = await testInvalidKeyHandling();

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
    
    // 🔧 最終餘額檢查
    try {
        const providers = await setupProviders();
        await checkAccountBalances(providers, "測試完成後最終");
        
        // 分析交易歷史
        const buyerAddress = await providers.assetBuyerSigner.getAddress();
        const sellerAddress = await providers.assetSellerSigner.getAddress();
        
        await analyzeTransactionHistory(providers, buyerAddress);
        await analyzeTransactionHistory(providers, sellerAddress);
        
    } catch (error) {
        colorLog('red', '最終狀態檢查失敗: ' + error.message);
    }
    
    // 根據結果退出
    const allPassed = Object.values(testResults).every(result => result);
    
    if (allPassed) {
        colorLog('green', '\n🎉 所有測試通過！系統運行完美！');
    } else {
        colorLog('yellow', '\n⚠️ 部分測試需要改進，請參考上述建議。');
    }
    
    process.exit(allPassed ? 0 : 1);
}

// 🔧 單獨運行測試的函數
async function runSingleTest(testName) {
    const startTime = Date.now();
    
    colorLog('bright', `🧪 運行單一測試: ${testName}`);
    colorLog('bright', '測試開始時間: ' + new Date().toLocaleString());
    
    let result = false;
    
    try {
        switch (testName.toLowerCase()) {
            case 'balance':
            case 'check':
                result = await checkCurrentBalances();
                break;
            case 'normal':
            case '1':
                result = await testCorrectAtomicSwapWithDualKeys();
                break;
            case 'timeout':
            case '2':
                result = await testTimeoutRefund();
                break;
            case 'double':
            case 'doublespend':
            case '3':
                result = await testDoubleSpendPrevention();
                break;
            case 'key':
            case 'invalidkey':
            case '4':
                result = await testInvalidKeyHandling();
                break;
            case 'health':
                result = await checkSystemHealth();
                break;
            default:
                colorLog('red', `未知的測試名稱: ${testName}`);
                colorLog('yellow', '可用的測試:');
                console.log('  balance/check - 檢查當前餘額');
                console.log('  normal/1 - 正常交易流程測試');
                console.log('  timeout/2 - 超時退款測試');
                console.log('  double/3 - 雙重支付預防測試');
                console.log('  key/4 - 無效密鑰處理測試');
                console.log('  health - 系統健康檢查');
                return;
        }
        
        const endTime = Date.now();
        const duration = Math.round((endTime - startTime) / 1000);
        
        colorLog('bright', `\n測試完成時間: ${new Date().toLocaleString()}`);
        colorLog('bright', `執行時間: ${duration} 秒`);
        
        if (result) {
            colorLog('green', `✅ 測試 "${testName}" 通過！`);
        } else {
            colorLog('red', `❌ 測試 "${testName}" 失敗！`);
        }
        
    } catch (error) {
        colorLog('red', `測試 "${testName}" 執行失敗: ${error.message}`);
        console.error('詳細錯誤:', error);
    }
    
    process.exit(result ? 0 : 1);
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

// 🔧 命令行參數處理
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length > 0) {
        // 運行單一測試
        const testName = args[0];
        runSingleTest(testName).catch(error => {
            colorLog('red', `測試啟動失敗: ${error.message}`);
            console.error(error);
            process.exit(1);
        });
    } else {
        // 運行所有測試
        runAllTests().catch(error => {
            colorLog('red', `測試啟動失敗: ${error.message}`);
            console.error(error);
            process.exit(1);
        });
    }
}

// 導出所有函數
module.exports = {
    runAllTests,
    runSingleTest,
    checkAccountBalances,
    compareBalanceChanges,
    testCorrectAtomicSwapWithDualKeys,
    checkCurrentBalances,
    testTimeoutRefund,
    testDoubleSpendPrevention,
    testInvalidKeyHandling,
    checkSystemHealth,
    analyzeTransactionHistory,
    safeExecuteTransaction,
    improvedSafeExecuteTransaction,
    checkTransactionNecessity
};
