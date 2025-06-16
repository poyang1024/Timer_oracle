const ethers = require('ethers');
const express = require('express');
const logger = require('./services/logger');
require('dotenv').config();

const app = express();
app.use(express.json());

// 在啟動時記錄服務器信息
logger('info', 'Oracle服務器啟動', {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    logFile: logger.getCurrentLogFile()
});

const assetContractABI = [
    "function fulfillTime(bytes32 _requestId, uint256 _timestamp) external",
    "function handleFailedConfirmation(uint tradeId) external",
    "event TimeRequestSent(bytes32 requestId, uint tradeId, uint256 duration)",
    "function getTrade(uint _tradeId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256)"
];

const paymentContractABI = [
    "function fulfillTime(bytes32 _requestId, uint256 _timestamp) external",
    "function handleFailedConfirmation(uint paymentId) external",
    "event TimeRequestSent(bytes32 requestId, uint paymentId, uint256 duration)",
    "function getPayment(uint _paymentId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256, uint)"
];

// Environment variables for both contracts
const ASSET_CONTRACT_ADDRESS = process.env.ASSET_CONTRACT_ADDRESS;
const PAYMENT_CONTRACT_ADDRESS = process.env.PAYMENT_CONTRACT_ADDRESS;
const ASSET_ETHEREUM_NODE_URL = process.env.ASSET_ETHEREUM_NODE_URL || process.env.ETHEREUM_NODE_URL;
const PAYMENT_ETHEREUM_NODE_URL = process.env.PAYMENT_ETHEREUM_NODE_URL || process.env.ETHEREUM_NODE_URL;
const ASSET_PRIVATE_KEY = process.env.ASSET_PRIVATE_KEY || process.env.PRIVATE_KEY;
const PAYMENT_PRIVATE_KEY = process.env.PAYMENT_PRIVATE_KEY || process.env.PRIVATE_KEY;

// 記錄配置信息
logger('info', '配置信息載入', {
    assetContract: ASSET_CONTRACT_ADDRESS,
    paymentContract: PAYMENT_CONTRACT_ADDRESS,
    assetRPC: ASSET_ETHEREUM_NODE_URL?.substring(0, 50) + '...',
    paymentRPC: PAYMENT_ETHEREUM_NODE_URL?.substring(0, 50) + '...'
});

// Ethereum connection variables
let assetProvider, assetSigner, assetContract;
let paymentProvider, paymentSigner, paymentContract;

// Tracking variables for both chains
let assetLastProcessedBlock = 0;
let paymentLastProcessedBlock = 0;
let assetCurrentNonce = 0;
let paymentCurrentNonce = 0;

// State tracking for both chains
const assetTrades = new Map();
const paymentTrades = new Map();
const assetEventQueue = [];
const paymentEventQueue = [];
const processingAssetTrades = new Set();
const processingPaymentTrades = new Set();

// Cross-chain trade mapping
const crossChainTrades = new Map();

async function initializeEthers() {
    logger('info', '開始初始化區塊鏈連接...');
    
    try {
        // Initialize Asset Chain connection
        assetProvider = new ethers.JsonRpcProvider(ASSET_ETHEREUM_NODE_URL);
        assetSigner = new ethers.Wallet(ASSET_PRIVATE_KEY, assetProvider);
        assetContract = new ethers.Contract(ASSET_CONTRACT_ADDRESS, assetContractABI, assetSigner);
        assetLastProcessedBlock = await assetProvider.getBlockNumber();
        assetCurrentNonce = await assetProvider.getTransactionCount(assetSigner.address);
        
        logger('info', `Asset鏈初始化成功`, { 
            contract: ASSET_CONTRACT_ADDRESS,
            startBlock: assetLastProcessedBlock,
            signerAddress: assetSigner.address,
            nonce: assetCurrentNonce
        });
        
        // Initialize Payment Chain connection
        paymentProvider = new ethers.JsonRpcProvider(PAYMENT_ETHEREUM_NODE_URL);
        paymentSigner = new ethers.Wallet(PAYMENT_PRIVATE_KEY, paymentProvider);
        paymentContract = new ethers.Contract(PAYMENT_CONTRACT_ADDRESS, paymentContractABI, paymentSigner);
        paymentLastProcessedBlock = await paymentProvider.getBlockNumber();
        paymentCurrentNonce = await paymentProvider.getTransactionCount(paymentSigner.address);
        
        logger('info', `Payment鏈初始化成功`, { 
            contract: PAYMENT_CONTRACT_ADDRESS,
            startBlock: paymentLastProcessedBlock,
            signerAddress: paymentSigner.address,
            nonce: paymentCurrentNonce
        });
        
        logger('info', '所有區塊鏈連接初始化完成');
        
    } catch (error) {
        logger('error', '區塊鏈連接初始化失敗', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

// 🔧 新增：即時雙重支付檢測函數
async function performImmediateDoubleSpendCheck(assetTradeId, paymentId, assetDuration, paymentDuration) {
    logger('info', '執行即時雙重支付檢測', {
        assetTradeId,
        paymentId,
        assetDuration,
        paymentDuration
    });
    
    // 關鍵檢測：Asset 超時小於 Payment 超時
    if (assetDuration < paymentDuration) {
        logger('error', '🚨 檢測到雙重支付風險 - Asset超時小於Payment超時', {
            assetTradeId,
            paymentId,
            assetDuration,
            paymentDuration,
            riskType: 'ASSET_TIMEOUT_TOO_SHORT'
        });
        
        // 立即取消兩個交易
        try {
            await handleAssetFailedConfirmation(assetTradeId);
            await handlePaymentFailedConfirmation(paymentId);
            
            logger('info', '✅ 成功阻止雙重支付攻擊', {
                assetTradeId,
                paymentId
            });
            
            // 清理狀態
            assetTrades.delete(assetTradeId);
            paymentTrades.delete(paymentId);
            crossChainTrades.delete(`asset_${assetTradeId}`);
            crossChainTrades.delete(`payment_${paymentId}`);
            
            return { action: 'CANCEL', reason: 'Double spend risk detected' };
        } catch (error) {
            logger('error', '處理雙重支付風險時出錯', {
                assetTradeId,
                paymentId,
                error: error.message
            });
            throw error;
        }
    }
    
    // 檢查通過
    logger('info', '✅ 雙重支付檢測通過', {
        assetTradeId,
        paymentId
    });
    
    return { action: 'CONTINUE' };
}

// Asset Chain handler functions
async function handleAssetTimeRequest(requestId, tradeId, duration, eventTimestamp) {
    if (processingAssetTrades.has(tradeId)) {
        logger('info', `Asset交易已在處理隊列中`, {
            tradeId,
            requestId,
            duration: duration.toString(),
            eventTimestamp
        });
        assetEventQueue.push({ requestId, tradeId, duration, eventTimestamp });
        return;
    }

    processingAssetTrades.add(tradeId);
    
    try {
        // 使用鏈外當前時間而非事件時間戳
        const currentTime = Math.floor(Date.now() / 1000);
        
        if (!assetTrades.has(tradeId)) {
            // 🔧 新增：Asset 交易創建時檢查是否已有對應的 Payment 交易
            const existingPaymentTrade = paymentTrades.get(tradeId);
            
            if (existingPaymentTrade) {
                // 執行即時雙重支付檢測
                const checkResult = await performImmediateDoubleSpendCheck(
                    tradeId, 
                    tradeId, 
                    Number(duration), 
                    existingPaymentTrade.duration
                );
                
                if (checkResult.action === 'CANCEL') {
                    logger('info', 'Asset交易創建時檢測到風險，已取消', { tradeId });
                    return;
                }
            }
            
            assetTrades.set(tradeId, { 
                inceptionTime: currentTime,  // 使用當前時間
                duration: Number(duration),
                lastRequestId: requestId,
                lastRequestTime: currentTime
            });
            await fulfillAssetTime(requestId, currentTime);
            logger('info', `Asset交易創建時間已設定`, {
                tradeId,
                inceptionTime: currentTime,
                duration: duration.toString()
            });
        } else {
            const trade = assetTrades.get(tradeId);
            if (currentTime - trade.inceptionTime <= trade.duration) {
                trade.lastRequestId = requestId;
                trade.lastRequestTime = currentTime;
                await fulfillAssetTime(requestId, currentTime);
                logger('info', `Asset交易確認時間已設定`, {
                    tradeId,
                    requestId,
                    duration: trade.duration.toString(),
                    timeElapsed: (currentTime - trade.inceptionTime).toString()
                });
            } else {
                await handleAssetFailedConfirmation(tradeId);
                logger('warn', `Asset交易因超時而確認失敗`, {
                    tradeId,
                    duration: trade.duration.toString(),
                    timeElapsed: (currentTime - trade.inceptionTime).toString()
                });
                assetTrades.delete(tradeId);
            }
        }
    } catch (error) {
        logger('error', `處理Asset交易時發生錯誤`, {
            tradeId,
            duration: duration.toString(),
            error: error.message
        });
    } finally {
        processingAssetTrades.delete(tradeId);
        processNextAssetEvent();
    }
}

async function fulfillAssetTime(requestId, timestamp) {
    try {
        const tx = await assetContract.fulfillTime(requestId, timestamp, {
            nonce: assetCurrentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        logger('info', `Asset時間履行成功`, {
            requestId,
            timestamp,
            txHash: tx.hash
        });
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            assetCurrentNonce = await assetProvider.getTransactionCount(assetSigner.address);
            logger('warn', `Asset nonce重置`, {
                newNonce: assetCurrentNonce
            });
            return fulfillAssetTime(requestId, timestamp);
        }
        logger('error', `Asset時間履行失敗`, {
            requestId,
            timestamp,
            error: error.message
        });
        throw error;
    }
}

async function handleAssetFailedConfirmation(tradeId) {
    try {
        const tx = await assetContract.handleFailedConfirmation(tradeId, {
            nonce: assetCurrentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        
        logger('info', `Asset失敗確認已處理`, {
            tradeId,
            txHash: tx.hash
        });
        
        // 🔧 處理對應的Payment失敗
        const paymentId = crossChainTrades.get(`asset_${tradeId}`);
        if (paymentId) {
            logger('info', `處理對應的Payment失敗`, {
                assetTradeId: tradeId,
                paymentId
            });
            
            // 清理跨鏈映射
            crossChainTrades.delete(`asset_${tradeId}`);
            crossChainTrades.delete(`payment_${paymentId}`);
            
            // 如果Payment還存在，也處理失敗
            if (paymentTrades.has(paymentId) && !processingPaymentTrades.has(paymentId)) {
                processingPaymentTrades.add(paymentId);
                try {
                    await handlePaymentFailedConfirmation(paymentId);
                } catch (error) {
                    logger('error', `處理對應Payment失敗時出錯`, {
                        paymentId,
                        error: error.message
                    });
                } finally {
                    processingPaymentTrades.delete(paymentId);
                }
            }
        }
        
        assetTrades.delete(tradeId);
        
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            assetCurrentNonce = await assetProvider.getTransactionCount(assetSigner.address);
            logger('warn', `Asset nonce重置`, {
                newNonce: assetCurrentNonce
            });
            return handleAssetFailedConfirmation(tradeId);
        }
        
        // 🔑 任何錯誤都清理內存狀態，避免重複嘗試
        logger('error', `處理Asset失敗確認時發生錯誤`, {
            tradeId,
            error: error.message
        });
        assetTrades.delete(tradeId);
        processingAssetTrades.delete(tradeId);
    }
}

// 新增：處理Asset執行階段超時
async function handleAssetExecutionTimeout(tradeId) {
    try {
        const tx = await assetContract.handleExecutionTimeout(tradeId, {
            nonce: assetCurrentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        
        logger('info', `Asset執行階段超時已處理`, {
            tradeId,
            txHash: tx.hash
        });
        
        // 🔧 處理對應的Payment執行超時
        const paymentId = crossChainTrades.get(`asset_${tradeId}`);
        if (paymentId) {
            logger('info', `處理對應的Payment執行超時`, {
                assetTradeId: tradeId,
                paymentId
            });
            
            // 清理跨鏈映射
            crossChainTrades.delete(`asset_${tradeId}`);
            crossChainTrades.delete(`payment_${paymentId}`);
            
            // 如果Payment還存在，也處理執行超時
            if (paymentTrades.has(paymentId) && !processingPaymentTrades.has(paymentId)) {
                processingPaymentTrades.add(paymentId);
                try {
                    await handlePaymentExecutionTimeout(paymentId);
                } catch (error) {
                    logger('error', `處理對應Payment執行超時時出錯`, {
                        paymentId,
                        error: error.message
                    });
                } finally {
                    processingPaymentTrades.delete(paymentId);
                }
            }
        }
        
        assetTrades.delete(tradeId);
        
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            assetCurrentNonce = await assetProvider.getTransactionCount(assetSigner.address);
            logger('warn', `Asset nonce重置`, {
                newNonce: assetCurrentNonce
            });
            return handleAssetExecutionTimeout(tradeId);
        }
        
        logger('error', `處理Asset執行階段超時時發生錯誤`, {
            tradeId,
            error: error.message
        });
        assetTrades.delete(tradeId);
        processingAssetTrades.delete(tradeId);
    }
}

function processNextAssetEvent() {
    if (assetEventQueue.length > 0) {
        const nextEvent = assetEventQueue.shift();
        handleAssetTimeRequest(nextEvent.requestId, nextEvent.tradeId, nextEvent.duration, nextEvent.eventTimestamp)
            .catch(error => logger('error', `處理Asset隊列事件時發生錯誤`, {
                error: error.message,
                duration: nextEvent.duration.toString()
            }));
    }
}

// Payment Chain handler functions
async function handlePaymentTimeRequest(requestId, paymentId, duration, eventTimestamp) {
    if (processingPaymentTrades.has(paymentId)) {
        logger('info', `Payment交易已在處理隊列中`, {
            paymentId,
            requestId,
            duration: duration.toString(),
            eventTimestamp
        });
        paymentEventQueue.push({ requestId, paymentId, duration, eventTimestamp });
        return;
    }

    processingPaymentTrades.add(paymentId);
    
    try {
        // 使用鏈外當前時間
        const currentTime = Math.floor(Date.now() / 1000);
        
        // 🔧 檢查這是否為初次創建還是確認階段
        const existingPayment = paymentTrades.get(paymentId);
        
        if (!existingPayment) {
            // 🟢 這是初次創建 Payment
            logger('info', `處理Payment初次創建`, {
                paymentId,
                requestId,
                duration: duration.toString()
            });
            
            // 檢查是否有對應的 Asset 交易進行時間同步
            const correspondingAssetTrade = assetTrades.get(paymentId);
            let syncedTimestamp = currentTime;
            
            if (correspondingAssetTrade) {
                // 🔧 關鍵修改：執行即時雙重支付檢測
                const checkResult = await performImmediateDoubleSpendCheck(
                    paymentId, 
                    paymentId, 
                    correspondingAssetTrade.duration, 
                    Number(duration)
                );
                
                if (checkResult.action === 'CANCEL') {
                    logger('info', 'Payment交易創建時檢測到風險，已取消', { paymentId });
                    return;
                }
                
                // 使用 Asset 交易的創建時間作為基準
                syncedTimestamp = correspondingAssetTrade.inceptionTime;
                
                // 建立跨鏈映射
                crossChainTrades.set(`asset_${paymentId}`, paymentId);
                crossChainTrades.set(`payment_${paymentId}`, paymentId);
                
                logger('info', `跨鏈交易映射已建立`, {
                    paymentId,
                    assetTradeId: paymentId,
                    syncedTime: syncedTimestamp
                });
            }
            
            paymentTrades.set(paymentId, { 
                inceptionTime: syncedTimestamp, 
                duration: Number(duration),
                lastRequestId: requestId,
                lastRequestTime: syncedTimestamp,
                isConfirmationPhase: false
            });
            
            await fulfillPaymentTime(requestId, syncedTimestamp);
            logger('info', `Payment交易創建時間已設定`, {
                paymentId,
                inceptionTime: syncedTimestamp,
                duration: duration.toString(),
                synced: !!correspondingAssetTrade
            });
            
        } else {
            // 🟡 這是確認階段的請求
            logger('info', `處理Payment確認階段`, {
                paymentId,
                requestId,
                previousRequestId: existingPayment.lastRequestId,
                duration: duration.toString()
            });
            
            const payment = existingPayment;
            const correspondingAssetTrade = assetTrades.get(paymentId);
            
            // 使用同步的時間進行驗證
            let confirmationTime = currentTime;
            if (correspondingAssetTrade) {
                // 🔧 關鍵修正：使用 Asset 交易的最新時間來保持同步
                confirmationTime = Math.max(
                    correspondingAssetTrade.lastRequestTime || correspondingAssetTrade.inceptionTime,
                    currentTime
                );
                
                logger('info', `使用跨鏈同步的確認時間`, {
                    paymentId,
                    assetLastRequestTime: correspondingAssetTrade.lastRequestTime,
                    assetInceptionTime: correspondingAssetTrade.inceptionTime,
                    syncedConfirmationTime: confirmationTime
                });
            }
            
            // 檢查是否在時間限制內
            const timeElapsed = confirmationTime - payment.inceptionTime;
            if (timeElapsed <= payment.duration) {
                payment.lastRequestId = requestId;
                payment.lastRequestTime = confirmationTime;
                payment.isConfirmationPhase = true;
                
                // 🔧 關鍵：呼叫 fulfillPaymentTime 來設定合約中的 confirmationTime
                await fulfillPaymentTime(requestId, confirmationTime);
                
                logger('info', `Payment交易確認時間已設定`, {
                    paymentId,
                    requestId,
                    duration: payment.duration.toString(),
                    timeElapsed: timeElapsed.toString(),
                    confirmationTime: confirmationTime,
                    inceptionTime: payment.inceptionTime
                });
            } else {
                await handlePaymentFailedConfirmation(paymentId);
                logger('warn', `Payment交易因超時而確認失敗`, {
                    paymentId,
                    duration: payment.duration.toString(),
                    timeElapsed: timeElapsed.toString(),
                    confirmationTime: confirmationTime,
                    inceptionTime: payment.inceptionTime
                });
                paymentTrades.delete(paymentId);
            }
        }
        
    } catch (error) {
        logger('error', `處理Payment交易時發生錯誤`, {
            paymentId,
            requestId,
            duration: duration.toString(),
            error: error.message,
            stack: error.stack
        });
        
        // 🔧 錯誤時也要清理狀態
        paymentTrades.delete(paymentId);
        
    } finally {
        processingPaymentTrades.delete(paymentId);
        processNextPaymentEvent();
    }
}

async function fulfillPaymentTime(requestId, timestamp, retryCount = 0) {
    const maxRetries = 3;
    
    try {
        logger('debug', `準備執行Payment fulfillTime`, {
            requestId,
            timestamp,
            currentNonce: paymentCurrentNonce,
            retryCount
        });
        
        const tx = await paymentContract.fulfillTime(requestId, timestamp, {
            nonce: paymentCurrentNonce++,
            gasLimit: 200000
        });
        
        const receipt = await tx.wait();
        
        if (receipt.status === 0) {
            throw new Error('Transaction failed with status 0');
        }
        
        logger('info', `Payment時間履行成功`, {
            requestId,
            timestamp,
            txHash: tx.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString()
        });
        
    } catch (error) {
        logger('error', `Payment時間履行過程中發生錯誤`, {
            requestId,
            timestamp,
            retryCount,
            error: error.message
        });
        
        if (error.message.includes('nonce too low')) {
            paymentCurrentNonce = await paymentProvider.getTransactionCount(paymentSigner.address);
            logger('warn', `Payment nonce重置`, {
                newNonce: paymentCurrentNonce,
                requestId
            });
            
            if (retryCount < maxRetries) {
                logger('info', `重試Payment時間履行`, {
                    requestId,
                    retryCount: retryCount + 1
                });
                return fulfillPaymentTime(requestId, timestamp, retryCount + 1);
            }
        }
        
        // 其他類型的錯誤也記錄詳細資訊
        if (error.message.includes('insufficient funds')) {
            const balance = await paymentProvider.getBalance(paymentSigner.address);
            logger('error', `Payment鏈餘額不足`, {
                requestId,
                signerAddress: paymentSigner.address,
                balance: balance.toString()
            });
        }
        
        if (error.message.includes('Invalid request ID')) {
            logger('error', `無效的請求ID`, {
                requestId,
                timestamp
            });
        }
        
        throw error;
    }
}

async function handlePaymentFailedConfirmation(paymentId) {
    try {
        const tx = await paymentContract.handleFailedConfirmation(paymentId, {
            nonce: paymentCurrentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        
        logger('info', `Payment失敗確認已處理`, {
            paymentId,
            txHash: tx.hash
        });
        
        // 🔧 處理對應的Asset失敗
        const assetTradeId = crossChainTrades.get(`payment_${paymentId}`);
        if (assetTradeId) {
            logger('info', `處理對應的Asset失敗`, {
                paymentId,
                assetTradeId
            });
            
            // 清理跨鏈映射
            crossChainTrades.delete(`payment_${paymentId}`);
            crossChainTrades.delete(`asset_${assetTradeId}`);
            
            // 如果Asset還存在，也處理失敗
            if (assetTrades.has(assetTradeId) && !processingAssetTrades.has(assetTradeId)) {
                processingAssetTrades.add(assetTradeId);
                try {
                    await handleAssetFailedConfirmation(assetTradeId);
                } catch (error) {
                    logger('error', `處理對應Asset失敗時出錯`, {
                        assetTradeId,
                        error: error.message
                    });
                } finally {
                    processingAssetTrades.delete(assetTradeId);
                }
            }
        }
        
        paymentTrades.delete(paymentId);
        
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            paymentCurrentNonce = await paymentProvider.getTransactionCount(paymentSigner.address);
            logger('warn', `Payment nonce重置`, {
                newNonce: paymentCurrentNonce
            });
            return handlePaymentFailedConfirmation(paymentId);
        }
        
        // 🔑 任何錯誤都清理內存狀態，避免重複嘗試
        logger('error', `處理Payment失敗確認時發生錯誤`, {
            paymentId,
            error: error.message
        });
        paymentTrades.delete(paymentId);
        processingPaymentTrades.delete(paymentId);
    }
}

// 新增：處理Payment執行階段超時
async function handlePaymentExecutionTimeout(paymentId) {
    try {
        const tx = await paymentContract.handleExecutionTimeout(paymentId, {
            nonce: paymentCurrentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        
        logger('info', `Payment執行階段超時已處理`, {
            paymentId,
            txHash: tx.hash
        });
        
        // 🔧 處理對應的Asset執行超時
        const assetTradeId = crossChainTrades.get(`payment_${paymentId}`);
        if (assetTradeId) {
            logger('info', `處理對應的Asset執行超時`, {
                paymentId,
                assetTradeId
            });
            
            // 清理跨鏈映射
            crossChainTrades.delete(`payment_${paymentId}`);
            crossChainTrades.delete(`asset_${assetTradeId}`);
            
            // 如果Asset還存在，也處理執行超時
            if (assetTrades.has(assetTradeId) && !processingAssetTrades.has(assetTradeId)) {
                processingAssetTrades.add(assetTradeId);
                try {
                    await handleAssetExecutionTimeout(assetTradeId);
                } catch (error) {
                    logger('error', `處理對應Asset執行超時時出錯`, {
                        assetTradeId,
                        error: error.message
                    });
                } finally {
                    processingAssetTrades.delete(assetTradeId);
                }
            }
        }
        
        paymentTrades.delete(paymentId);
        
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            paymentCurrentNonce = await paymentProvider.getTransactionCount(paymentSigner.address);
            logger('warn', `Payment nonce重置`, {
                newNonce: paymentCurrentNonce
            });
            return handlePaymentExecutionTimeout(paymentId);
        }
        
        logger('error', `處理Payment執行階段超時時發生錯誤`, {
            paymentId,
            error: error.message
        });
        paymentTrades.delete(paymentId);
        processingPaymentTrades.delete(paymentId);
    }
}

function processNextPaymentEvent() {
    if (paymentEventQueue.length > 0) {
        const nextEvent = paymentEventQueue.shift();
        handlePaymentTimeRequest(nextEvent.requestId, nextEvent.paymentId, nextEvent.duration, nextEvent.eventTimestamp)
            .catch(error => logger('error', `處理Payment隊列事件時發生錯誤`, {
                error: error.message,
                duration: nextEvent.duration.toString()
            }));
    }
}

// Check expired trades for both chains
async function checkAndHandleExpiredTrades() {
    const currentTime = Math.floor(Date.now() / 1000);
    
    // Check Asset Chain expired trades - 先收集，再處理
    const expiredAssetTrades = [];
    const executionTimeoutAssetTrades = [];
    
    for (const [tradeId, trade] of assetTrades.entries()) {
        if (processingAssetTrades.has(tradeId)) continue;
        
        const timeElapsed = currentTime - trade.inceptionTime;
        
        // 檢查執行階段超時（已確認但未執行）
        if (trade.confirmationTime && 
            currentTime - trade.confirmationTime > trade.duration && 
            timeElapsed <= trade.duration * 2) { // 給執行階段額外時間
            executionTimeoutAssetTrades.push(tradeId);
        }
        // 檢查總體超時
        else if (timeElapsed > trade.duration) {
            expiredAssetTrades.push(tradeId);
        }
    }
    
    // 處理執行階段超時
    for (const tradeId of executionTimeoutAssetTrades) {
        if (processingAssetTrades.has(tradeId)) continue;
        
        processingAssetTrades.add(tradeId);
        try {
            const contractTrade = await assetContract.getTrade(tradeId);
            
            if (contractTrade[0] == 0 || contractTrade[4] == 3 || contractTrade[4] == 4) {
                logger('info', `執行階段檢查：Asset交易已完成，清理內存狀態`, { tradeId });
                assetTrades.delete(tradeId);
                continue;
            }
            
            // 檢查是否為已確認狀態
            if (contractTrade[4] == 2) { // Confirmed state
                logger('info', `檢測到Asset交易執行階段超時`, {
                    tradeId,
                    duration: assetTrades.get(tradeId)?.duration.toString(),
                    executionTimeElapsed: (currentTime - assetTrades.get(tradeId)?.confirmationTime).toString()
                });
                
                await handleAssetExecutionTimeout(tradeId);
            }
        } catch (error) {
            logger('error', `處理執行階段超時Asset交易時發生錯誤`, {
                tradeId,
                error: error.message
            });
            assetTrades.delete(tradeId);
        } finally {
            processingAssetTrades.delete(tradeId);
        }
    }
    
    // 處理收集到的超時交易
    for (const tradeId of expiredAssetTrades) {
        if (processingAssetTrades.has(tradeId)) continue;
        
        processingAssetTrades.add(tradeId);
        try {
            // 🔑 處理前先檢查合約狀態
            const contractTrade = await assetContract.getTrade(tradeId);
            
            if (contractTrade[0] == 0 || contractTrade[4] == 3 || contractTrade[4] == 4) {
                logger('info', `超時檢查：Asset交易已完成，清理內存狀態`, { tradeId });
                assetTrades.delete(tradeId);
                continue;
            }
            
            logger('info', `檢測到資產交易已超時`, {
                tradeId,
                duration: assetTrades.get(tradeId)?.duration.toString(),
                timeElapsed: (currentTime - assetTrades.get(tradeId)?.inceptionTime).toString()
            });
            
            await handleAssetFailedConfirmation(tradeId);
        } catch (error) {
            logger('error', `處理超時Asset交易時發生錯誤`, {
                tradeId,
                error: error.message
            });
            assetTrades.delete(tradeId);
        } finally {
            processingAssetTrades.delete(tradeId);
        }
    }
    
    // Check Payment Chain expired trades - 先收集，再處理
    const expiredPaymentTrades = [];
    const executionTimeoutPaymentTrades = [];
    
    for (const [paymentId, trade] of paymentTrades.entries()) {
        if (processingPaymentTrades.has(paymentId)) continue;
        
        const timeElapsed = currentTime - trade.inceptionTime;
        
        // 檢查執行階段超時（已確認但未執行）
        if (trade.confirmationTime && 
            currentTime - trade.confirmationTime > trade.duration && 
            timeElapsed <= trade.duration * 2) { // 給執行階段額外時間
            executionTimeoutPaymentTrades.push(paymentId);
        }
        // 檢查總體超時
        else if (timeElapsed > trade.duration) {
            expiredPaymentTrades.push(paymentId);
        }
    }
    
    // 處理執行階段超時
    for (const paymentId of executionTimeoutPaymentTrades) {
        if (processingPaymentTrades.has(paymentId)) continue;
        
        processingPaymentTrades.add(paymentId);
        try {
            const contractPayment = await paymentContract.getPayment(paymentId);
            
            if (contractPayment[0] == 0 || contractPayment[4] == 3 || contractPayment[4] == 4) {
                logger('info', `執行階段檢查：Payment交易已完成，清理內存狀態`, { paymentId });
                paymentTrades.delete(paymentId);
                continue;
            }
            
            // 檢查是否為已確認狀態
            if (contractPayment[4] == 2) { // Confirmed state
                logger('info', `檢測到Payment交易執行階段超時`, {
                    paymentId,
                    duration: paymentTrades.get(paymentId)?.duration.toString(),
                    executionTimeElapsed: (currentTime - paymentTrades.get(paymentId)?.confirmationTime).toString()
                });
                
                await handlePaymentExecutionTimeout(paymentId);
            }
        } catch (error) {
            logger('error', `處理執行階段超時Payment交易時發生錯誤`, {
                paymentId,
                error: error.message
            });
            paymentTrades.delete(paymentId);
        } finally {
            processingPaymentTrades.delete(paymentId);
        }
    }
    
    // 處理收集到的超時支付
    for (const paymentId of expiredPaymentTrades) {
        if (processingPaymentTrades.has(paymentId)) continue;
        
        processingPaymentTrades.add(paymentId);
        try {
            // 🔑 處理前先檢查合約狀態
            const contractPayment = await paymentContract.getPayment(paymentId);
            
            if (contractPayment[0] == 0 || contractPayment[4] == 3 || contractPayment[4] == 4) {
                logger('info', `超時檢查：Payment交易已完成，清理內存狀態`, { paymentId });
                paymentTrades.delete(paymentId);
                continue;
            }
            
            logger('info', `檢測到支付交易已超時`, {
                paymentId,
                duration: paymentTrades.get(paymentId)?.duration.toString(),
                timeElapsed: (currentTime - paymentTrades.get(paymentId)?.inceptionTime).toString()
            });
            
            await handlePaymentFailedConfirmation(paymentId);
        } catch (error) {
            logger('error', `處理超時Payment交易時發生錯誤`, {
                paymentId,
                error: error.message
            });
            paymentTrades.delete(paymentId);
        } finally {
            processingPaymentTrades.delete(paymentId);
        }
    }
}

// Poll events from both chains
async function pollAssetEvents() {
    try {
        const latestBlock = await assetProvider.getBlockNumber();
        if (latestBlock <= assetLastProcessedBlock) {
            return;
        }

        logger('debug', `檢查Asset鏈新事件`, {
            fromBlock: assetLastProcessedBlock + 1,
            toBlock: latestBlock
        });

        const filter = assetContract.filters.TimeRequestSent();
        const events = await assetContract.queryFilter(filter, assetLastProcessedBlock + 1, latestBlock);

        for (const event of events) {
            const { requestId, tradeId, duration } = event.args;
            const eventTimestamp = (await event.getBlock()).timestamp;
            
            logger('info', `Asset TimeRequestSent事件接收`, {
                tradeId: tradeId.toString(),
                requestId,
                duration: duration.toString(),
                eventTimestamp,
                blockNumber: event.blockNumber
            });

            if (!processingAssetTrades.has(tradeId.toString())) {
                handleAssetTimeRequest(requestId, tradeId.toString(), duration, eventTimestamp)
                    .catch(error => logger('error', `處理Asset事件時發生錯誤`, {
                        error: error.message,
                        duration: duration.toString()
                    }));
            } else {
                assetEventQueue.push({ requestId, tradeId: tradeId.toString(), duration, eventTimestamp });
                logger('info', `Asset事件已加入隊列`, {
                    tradeId: tradeId.toString(),
                    duration: duration.toString()
                });
            }
        }

        assetLastProcessedBlock = latestBlock;
    } catch (error) {
        logger('error', `輪詢Asset事件時發生錯誤`, {
            error: error.message
        });
    }
}

async function pollPaymentEvents() {
    try {
        const latestBlock = await paymentProvider.getBlockNumber();
        if (latestBlock <= paymentLastProcessedBlock) {
            return;
        }

        logger('debug', `檢查Payment鏈新事件`, {
            fromBlock: paymentLastProcessedBlock + 1,
            toBlock: latestBlock
        });

        const filter = paymentContract.filters.TimeRequestSent();
        const events = await paymentContract.queryFilter(filter, paymentLastProcessedBlock + 1, latestBlock);

        for (const event of events) {
            const { requestId, paymentId, duration } = event.args;
            const eventTimestamp = (await event.getBlock()).timestamp;
            
            logger('info', `Payment TimeRequestSent事件接收`, {
                paymentId: paymentId.toString(),
                requestId,
                duration: duration.toString(),
                eventTimestamp,
                blockNumber: event.blockNumber
            });
            
            // 🔧 檢查是否存在對應的內存記錄來判斷是否為確認階段
            const existingPayment = paymentTrades.get(paymentId.toString());
            if (existingPayment) {
                logger('info', `檢測到Payment確認階段事件`, {
                    paymentId: paymentId.toString(),
                    existingInceptionTime: existingPayment.inceptionTime,
                    existingRequestId: existingPayment.lastRequestId,
                    newRequestId: requestId
                });
            } else {
                logger('info', `檢測到Payment初次創建事件`, {
                    paymentId: paymentId.toString(),
                    requestId
                });
            }

            // 正常處理事件
            if (!processingPaymentTrades.has(paymentId.toString())) {
                handlePaymentTimeRequest(requestId, paymentId.toString(), duration, eventTimestamp)
                    .catch(error => logger('error', `處理Payment事件時發生錯誤`, {
                        error: error.message,
                        paymentId: paymentId.toString(),
                        requestId,
                        duration: duration.toString()
                    }));
            } else {
                paymentEventQueue.push({ requestId, paymentId: paymentId.toString(), duration, eventTimestamp });
                logger('info', `Payment事件已加入隊列 - 交易正在處理中`, {
                    paymentId: paymentId.toString(),
                    duration: duration.toString(),
                    queueLength: paymentEventQueue.length
                });
            }
        }

        paymentLastProcessedBlock = latestBlock;
    } catch (error) {
        logger('error', `輪詢Payment事件時發生錯誤`, {
            error: error.message,
            stack: error.stack
        });
    }
}

// Set up API endpoints
app.get('/status', async (req, res) => {
    try {
        const assetBlock = await assetProvider.getBlockNumber();
        const paymentBlock = await paymentProvider.getBlockNumber();
        
        const statusData = {
            status: 'running',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            chains: {
                asset: {
                    contract: ASSET_CONTRACT_ADDRESS,
                    lastProcessedBlock: assetLastProcessedBlock,
                    currentBlock: assetBlock,
                    activeTrades: Array.from(assetTrades.keys()),
                    pendingEvents: assetEventQueue.length
                },
                payment: {
                    contract: PAYMENT_CONTRACT_ADDRESS,
                    lastProcessedBlock: paymentLastProcessedBlock,
                    currentBlock: paymentBlock,
                    activePayments: Array.from(paymentTrades.keys()),
                    pendingEvents: paymentEventQueue.length
                }
            },
            crossChainMappings: Object.fromEntries(
                Array.from(crossChainTrades.entries())
                .filter(([key]) => key.startsWith('asset_'))
                .map(([key, value]) => [key.replace('asset_', ''), value])
            ),
            logFile: logger.getCurrentLogFile()
        };
        
        logger('info', 'API狀態查詢', {
            remoteAddress: req.ip,
            userAgent: req.get('User-Agent')
        });
        
        res.json(statusData);
    } catch (error) {
        logger('error', `獲取狀態時發生錯誤`, {
            error: error.message
        });
        res.status(500).json({ error: error.message });
    }
});

app.get('/trade/:tradeId', async (req, res) => {
    try {
        const { tradeId } = req.params;
        const tradeInfo = await assetContract.getTrade(tradeId);
        
        const paymentId = crossChainTrades.get(`asset_${tradeId}`);
        let paymentInfo = null;
        
        if (paymentId) {
            paymentInfo = await paymentContract.getPayment(paymentId);
        }
        
        const responseData = {
            trade: {
                id: tradeInfo[0].toString(),
                amount: tradeInfo[1].toString(),
                buyer: tradeInfo[2],
                seller: tradeInfo[3],
                state: tradeInfo[4],
                inceptionTime: tradeInfo[5].toString(),
                confirmationTime: tradeInfo[6].toString(),
                duration: tradeInfo[7].toString()
            },
            payment: paymentInfo ? {
                id: paymentInfo[0].toString(),
                amount: paymentInfo[1].toString(),
                buyer: paymentInfo[2],
                seller: paymentInfo[3],
                state: paymentInfo[4],
                inceptionTime: paymentInfo[5].toString(),
                confirmationTime: paymentInfo[6].toString(),
                duration: paymentInfo[7].toString(),
                assetTradeId: paymentInfo[8].toString()
            } : null
        };
        
        logger('info', 'API交易查詢', {
            tradeId,
            remoteAddress: req.ip
        });
        
        res.json(responseData);
    } catch (error) {
        logger('error', `獲取交易資訊時發生錯誤`, {
            tradeId: req.params.tradeId,
            error: error.message
        });
        res.status(500).json({ error: error.message });
    }
});

app.get('/payment/:paymentId', async (req, res) => {
    try {
        const { paymentId } = req.params;
        const paymentInfo = await paymentContract.getPayment(paymentId);
        
        const assetTradeId = paymentInfo[8].toString();
        let tradeInfo = null;
        
        if (assetTradeId && assetTradeId !== '0') {
            tradeInfo = await assetContract.getTrade(assetTradeId);
        }
        
        const responseData = {
            payment: {
                id: paymentInfo[0].toString(),
                amount: paymentInfo[1].toString(),
                buyer: paymentInfo[2],
                seller: paymentInfo[3],
                state: paymentInfo[4],
                inceptionTime: paymentInfo[5].toString(),
                confirmationTime: paymentInfo[6].toString(),
                duration: paymentInfo[7].toString(),
                assetTradeId: assetTradeId
            },
            trade: tradeInfo ? {
                id: tradeInfo[0].toString(),
                amount: tradeInfo[1].toString(),
                buyer: tradeInfo[2],
                seller: tradeInfo[3],
                state: tradeInfo[4],
                inceptionTime: tradeInfo[5].toString(),
                confirmationTime: tradeInfo[6].toString(),
                duration: tradeInfo[7].toString()
            } : null
        };
        
        logger('info', 'API支付查詢', {
            paymentId,
            remoteAddress: req.ip
        });
        
        res.json(responseData);
    } catch (error) {
        logger('error', `獲取支付資訊時發生錯誤`, {
            paymentId: req.params.paymentId,
            error: error.message
        });
        res.status(500).json({ error: error.message });
    }
});

// 新增日誌查看端點
app.get('/logs', (req, res) => {
    try {
        const logFile = logger.getCurrentLogFile();
        const fs = require('fs');
        
        if (fs.existsSync(logFile)) {
            const logContent = fs.readFileSync(logFile, 'utf8');
            const lines = logContent.split('\n');
            const limit = parseInt(req.query.limit) || 100;
            const recentLines = lines.slice(-limit);
            
            logger('info', 'API日誌查看', {
                requestedLines: limit,
                actualLines: recentLines.length,
                remoteAddress: req.ip
            });
            
            res.json({
                logFile: logFile,
                totalLines: lines.length,
                displayedLines: recentLines.length,
                logs: recentLines
            });
        } else {
            res.status(404).json({ error: '日誌文件不存在' });
        }
    } catch (error) {
        logger('error', `讀取日誌時發生錯誤`, {
            error: error.message
        });
        res.status(500).json({ error: error.message });
    }
});

// 新增統計資訊端點
app.get('/stats', async (req, res) => {
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        
        // 計算各種統計
        const assetTradeStats = {
            total: assetTrades.size,
            processing: processingAssetTrades.size,
            queued: assetEventQueue.length,
            oldestTrade: null,
            newestTrade: null
        };
        
        const paymentTradeStats = {
            total: paymentTrades.size,
            processing: processingPaymentTrades.size,
            queued: paymentEventQueue.length,
            oldestPayment: null,
            newestPayment: null
        };
        
        // 找出最舊和最新的交易
        if (assetTrades.size > 0) {
            let oldest = Infinity;
            let newest = 0;
            for (const [tradeId, trade] of assetTrades.entries()) {
                if (trade.inceptionTime < oldest) {
                    oldest = trade.inceptionTime;
                    assetTradeStats.oldestTrade = {
                        id: tradeId,
                        age: currentTime - trade.inceptionTime,
                        duration: trade.duration
                    };
                }
                if (trade.inceptionTime > newest) {
                    newest = trade.inceptionTime;
                    assetTradeStats.newestTrade = {
                        id: tradeId,
                        age: currentTime - trade.inceptionTime,
                        duration: trade.duration
                    };
                }
            }
        }
        
        if (paymentTrades.size > 0) {
            let oldest = Infinity;
            let newest = 0;
            for (const [paymentId, payment] of paymentTrades.entries()) {
                if (payment.inceptionTime < oldest) {
                    oldest = payment.inceptionTime;
                    paymentTradeStats.oldestPayment = {
                        id: paymentId,
                        age: currentTime - payment.inceptionTime,
                        duration: payment.duration
                    };
                }
                if (payment.inceptionTime > newest) {
                    newest = payment.inceptionTime;
                    paymentTradeStats.newestPayment = {
                        id: paymentId,
                        age: currentTime - payment.inceptionTime,
                        duration: payment.duration
                    };
                }
            }
        }
        
        const statsData = {
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            assetChain: assetTradeStats,
            paymentChain: paymentTradeStats,
            crossChainMappings: crossChainTrades.size,
            blockProgress: {
                asset: {
                    lastProcessed: assetLastProcessedBlock,
                    current: await assetProvider.getBlockNumber()
                },
                payment: {
                    lastProcessed: paymentLastProcessedBlock,
                    current: await paymentProvider.getBlockNumber()
                }
            }
        };
        
        logger('info', 'API統計查詢', {
            remoteAddress: req.ip
        });
        
        res.json(statsData);
    } catch (error) {
        logger('error', `獲取統計資訊時發生錯誤`, {
            error: error.message
        });
        res.status(500).json({ error: error.message });
    }
});

// 新增健康檢查端點
app.get('/health', async (req, res) => {
    try {
        const healthData = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            services: {
                assetChain: 'unknown',
                paymentChain: 'unknown',
                database: 'healthy'
            },
            version: process.version,
            uptime: process.uptime()
        };
        
        // 檢查 Asset 鏈連接
        try {
            await assetProvider.getBlockNumber();
            healthData.services.assetChain = 'healthy';
        } catch (error) {
            healthData.services.assetChain = 'unhealthy';
            healthData.status = 'degraded';
        }
        
        // 檢查 Payment 鏈連接
        try {
            await paymentProvider.getBlockNumber();
            healthData.services.paymentChain = 'healthy';
        } catch (error) {
            healthData.services.paymentChain = 'unhealthy';
            healthData.status = 'degraded';
        }
        
        // 如果兩個鏈都不健康，標記為不健康
        if (healthData.services.assetChain === 'unhealthy' && healthData.services.paymentChain === 'unhealthy') {
            healthData.status = 'unhealthy';
        }
        
        const statusCode = healthData.status === 'healthy' ? 200 : 
                          healthData.status === 'degraded' ? 200 : 503;
        
        res.status(statusCode).json(healthData);
    } catch (error) {
        logger('error', `健康檢查時發生錯誤`, {
            error: error.message
        });
        res.status(503).json({
            status: 'unhealthy',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 設置定時器
logger('info', '設置定時器', {
    assetEventPolling: '15秒',
    paymentEventPolling: '15秒',
    expiredTradeCheck: '30秒'
});

setInterval(pollAssetEvents, 15000);
setInterval(pollPaymentEvents, 15000);
setInterval(checkAndHandleExpiredTrades, 30000);

const PORT = process.env.SERVER_PORT || 1202;

// 優雅關閉處理
function gracefulShutdown(signal) {
    logger('info', `收到${signal}信號，開始優雅關閉...`);
    
    // 記錄當前狀態
    logger('info', '關閉時狀態統計', {
        activeAssetTrades: assetTrades.size,
        activePaymentTrades: paymentTrades.size,
        assetEventQueue: assetEventQueue.length,
        paymentEventQueue: paymentEventQueue.length,
        crossChainMappings: crossChainTrades.size,
        uptime: process.uptime()
    });
    
    // 關閉日誌
    logger.close();
    
    // 退出程序
    process.exit(0);
}

// 註冊信號處理器
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 處理未捕獲的異常
process.on('uncaughtException', (error) => {
    logger('error', '未捕獲的異常', {
        error: error.message,
        stack: error.stack
    });
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    logger('error', '未處理的Promise拒絕', {
        reason: reason?.toString(),
        promise: promise?.toString()
    });
});

async function startServer() {
    try {
        await initializeEthers();
        
        const server = app.listen(PORT, () => {
            logger('info', `雙鏈 Timer 已啟動`, {
                port: PORT,
                assetContract: ASSET_CONTRACT_ADDRESS,
                paymentContract: PAYMENT_CONTRACT_ADDRESS,
                processId: process.pid,
                nodeVersion: process.version,
                logFile: logger.getCurrentLogFile()
            });
            
            // 顯示可用的 API 端點
            logger('info', '可用的API端點', {
                status: `http://localhost:${PORT}/status`,
                health: `http://localhost:${PORT}/health`,
                stats: `http://localhost:${PORT}/stats`,
                logs: `http://localhost:${PORT}/logs`,
                trade: `http://localhost:${PORT}/trade/{tradeId}`,
                payment: `http://localhost:${PORT}/payment/{paymentId}`
            });
        });
        
        // 設置服務器錯誤處理
        server.on('error', (error) => {
            logger('error', '服務器錯誤', {
                error: error.message,
                code: error.code
            });
        });
        
        // 設置服務器關閉處理
        server.on('close', () => {
            logger('info', '服務器已關閉');
        });
        
    } catch (error) {
        logger('error', `服務器啟動失敗`, {
            error: error.message,
            stack: error.stack
        });
        process.exit(1);
    }
}

startServer();
