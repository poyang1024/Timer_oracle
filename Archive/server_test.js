const ethers = require('ethers');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { BigNumber } = ethers;
require('dotenv').config();
const logger = require('../backend/services/logger');

const app = express();
app.use(express.json());

const contractABI = [
    "function fulfillTime(bytes32 _requestId, uint256 _timestamp) external",
    "function handleFailedConfirmation(uint tradeId) external",
    "event TimeRequestSent(bytes32 requestId, uint tradeId, uint256 duration)",
    "function getTrade(uint _tradeId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256)"
];

const MAX_PENDING_TIME = 3600; // 1 hour in seconds
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY = 15; // seconds
const MAX_WAIT_TIME = 5 * 60 * 1000; // 5 minutes in milliseconds

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ETHEREUM_NODE_URL = process.env.ETHEREUM_NODE_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS;

let provider, signer, contract;
let lastCheckedBlock = 0;
const processedEvents = new Set();
const pendingTransactions = new Map();
const tradeDetails = new Map();

const BASE_GAS_PRICE = ethers.parseUnits('5', 'gwei');
const MAX_GAS_PRICE = ethers.parseUnits('50', 'gwei');
const GAS_PRICE_INCREMENT = ethers.parseUnits('1', 'gwei');
const FIXED_GAS_LIMIT = '200000';

const STATUS_FILE = path.join(__dirname, 'trade_status.json');

async function loadTradeStatus() {
    try {
        const data = await fs.readFile(STATUS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

async function saveTradeStatus(status) {
    await fs.writeFile(STATUS_FILE, JSON.stringify(status, null, 2));
}

async function updateTradeStatus(tradeId, status) {
    const currentStatus = await loadTradeStatus();
    if (currentStatus[tradeId] !== status) {
        currentStatus[tradeId] = status;
        await saveTradeStatus(currentStatus);
        logger('info', `Updated trade status`, { tradeId, status });
    }
}

async function getTradeStatus(tradeId) {
    const status = await loadTradeStatus();
    return status[tradeId] || 'pending';
}

async function getOptimalGasPrice(retryCount = 0) {
    try {
        const feeData = await provider.getFeeData();
        let gasPrice = BigNumber.from(feeData.gasPrice);
        const increment = ethers.utils.parseUnits((1 * retryCount).toString(), 'gwei');
        gasPrice = gasPrice.add(increment);
        
        const basePrice = BigNumber.from(BASE_GAS_PRICE);
        const maxPrice = BigNumber.from(MAX_GAS_PRICE);
        
        if (gasPrice.lt(basePrice)) return basePrice;
        if (gasPrice.gt(maxPrice)) return maxPrice;
        return gasPrice;
    } catch (error) {
        logger('warn', 'Error fetching gas price, using base price', { error: error.message });
        return BigNumber.from(BASE_GAS_PRICE);
    }
}


function getGasLimit() {
    return BigInt(FIXED_GAS_LIMIT);
}

async function initializeEthers() {
    logger('info', 'Initializing with the following configuration:', {
        CONTRACT_ADDRESS,
        ETHEREUM_NODE_URL,
        ORACLE_ADDRESS
    });

    provider = new ethers.JsonRpcProvider(ETHEREUM_NODE_URL);
    
    const privateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
    signer = new ethers.Wallet(privateKey, provider);
    
    const signerAddress = await signer.getAddress();
    logger('info', 'Signer address:', { address: signerAddress });
    
    if (signerAddress.toLowerCase() !== ORACLE_ADDRESS.toLowerCase()) {
        throw new Error("The private key does not correspond to the Oracle address");
    }
    
    contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, signer);

    lastCheckedBlock = await provider.getBlockNumber();
    logger('info', `Connected to contract and starting to poll events`, {
        contractAddress: CONTRACT_ADDRESS,
        startingBlock: lastCheckedBlock
    });
    
    setInterval(pollEvents, 3000);
    setInterval(processPendingTransactions, 5000);
    setInterval(cleanupPendingTransactions, 60000); // Run every minute
}

async function pollEvents() {
    try {
        const latestBlock = await provider.getBlockNumber();
        let fromBlock = lastCheckedBlock + 1;
        
        while (fromBlock <= latestBlock) {
            const toBlock = Math.min(fromBlock + 999, latestBlock);
            
            const filter = contract.filters.TimeRequestSent();
            const events = await contract.queryFilter(filter, fromBlock, toBlock);
            
            for (let event of events) {
                const eventId = `${event.transactionHash}-${event.logIndex}`;
                if (!processedEvents.has(eventId)) {
                    await processTimeRequestEvent(event);
                    processedEvents.add(eventId);
                }
            }
            
            fromBlock = toBlock + 1;
        }
        
        lastCheckedBlock = latestBlock;
    } catch (error) {
        logger('error', 'Error polling for events:', { error: error.message });
    }
}

async function processTimeRequestEvent(event) {
    const tradeId = event.args.tradeId.toString();
    const currentStatus = await getTradeStatus(tradeId);
    const currentTime = Math.floor(Date.now() / 1000);
    
    logger('info', 'Received TimeRequestSent event', {
        requestId: event.args.requestId,
        tradeId: tradeId,
        duration: event.args.duration.toString(),
        currentStatus: currentStatus
    });
    
    if (currentStatus === 'pending' || currentStatus === 'processing') {
        const duration = Number(event.args.duration);

        tradeDetails.set(tradeId, {
            requestId: event.args.requestId,
            inceptionTime: currentTime,
            duration: duration,
            expirationTime: currentTime + duration
        });
        addToPendingTransactions(event.args.requestId, tradeId);
        await updateTradeStatus(tradeId, 'processing');
    } else {
        logger('info', 'Trade already completed or failed, skipping', { tradeId, currentStatus });
    }
}

function addToPendingTransactions(requestId, tradeId) {
    if (!pendingTransactions.has(requestId)) {
        pendingTransactions.set(requestId, {
            attempts: 0,
            lastAttempt: Math.floor(Date.now() / 1000),
            tradeId: tradeId,
            transactionSent: false,
            failureHandled: false
        });
    }
}

async function checkBalance() {
    const balance = await provider.getBalance(signer.getAddress());
    const gasPrice = await getOptimalGasPrice();
    const gasLimit = getGasLimit();
    const estimatedCost = gasPrice * gasLimit;
    
    logger('info', 'Balance check', {
        currentBalance: ethers.formatEther(balance),
        estimatedCost: ethers.formatEther(estimatedCost)
    });
    
    return balance >= estimatedCost;
}

async function processPendingTransactions() {
    const currentTime = Math.floor(Date.now() / 1000);
    const transactionsToProcess = new Map(pendingTransactions);

    logger('info', `Processing ${transactionsToProcess.size} pending transactions`);

    for (const [requestId, details] of transactionsToProcess) {
        if (details && details.tradeId) {
            await processSingleTransaction(requestId, details, currentTime);
        } else {
            logger('warn', 'Invalid transaction details', { requestId });
            pendingTransactions.delete(requestId);
        }
    }

    logger('info', `Finished processing pending transactions`);
}

async function processSingleTransaction(requestId, details, currentTime) {
    if (!details || !details.tradeId) {
        logger('warn', 'Invalid transaction details, removing', { requestId });
        pendingTransactions.delete(requestId);
        return;
    }

    const tradeId = details.tradeId.toString();
    const tradeDetail = tradeDetails.get(tradeId);

    if (!tradeDetail) {
        logger('warn', 'Trade details not found, removing from pending', { tradeId });
        pendingTransactions.delete(requestId);
        return;
    }

    const currentStatus = await getTradeStatus(tradeId);
    const elapsedTime = currentTime - tradeDetail.inceptionTime;
    
    logger('info', 'Processing transaction', { 
        tradeId, 
        elapsedTime, 
        duration: tradeDetail.duration,
        expirationTime: new Date(tradeDetail.expirationTime * 1000).toISOString(),
        currentTime: new Date(currentTime * 1000).toISOString(),
        currentStatus
    });

    try {
        if (currentStatus === 'fulfilled' || currentStatus === 'failed') {
            logger('info', 'Trade already fulfilled or failed, removing from pending', { tradeId, currentStatus });
            pendingTransactions.delete(requestId);
        } else if (currentTime >= tradeDetail.expirationTime) {
            logger('info', 'Trade expired, handling failed confirmation', { tradeId });
            await handleExpiredTrade(tradeId, requestId);
        } else if (currentStatus === 'processing' && !details.transactionSent && currentTime - details.lastAttempt >= RETRY_DELAY) {
            await processActiveTrade(requestId, tradeId, details);
        } else {
            logger('info', 'Skipping trade, not yet time to retry or already processed', { 
                tradeId, 
                timeSinceLastAttempt: currentTime - details.lastAttempt,
                transactionSent: details.transactionSent,
                currentStatus
            });
        }
    } catch (error) {
        await handleProcessingError(error, requestId, tradeId, details, currentTime);
    }
}

async function waitForTransaction(txHash, maxWaitTime = MAX_WAIT_TIME) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
            if (receipt.status === 1) {
                return { success: true, receipt };
            } else {
                return { success: false, receipt };
            }
        }
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for 5 seconds before checking again
    }
    return { success: false, error: 'Transaction wait timeout' };
}

async function handleTimeRequest(requestId, tradeId, retryCount = 0) {
    const currentStatus = await getTradeStatus(tradeId);
    if (currentStatus !== 'processing') {
        logger('info', 'Trade not in processing state, skipping time request', { tradeId, currentStatus });
        return { success: true };
    }

    try {
        if (!(await checkBalance())) {
            throw new Error("Insufficient balance to send transaction");
        }

        const gasPrice = await getOptimalGasPrice(retryCount);
        const gasLimit = getGasLimit();
        const nonce = await provider.getTransactionCount(signer.getAddress(), 'pending');

        logger('info', 'Attempting to send fulfillTime transaction', {
            requestId,
            tradeId,
            gasPrice: ethers.utils.formatUnits(gasPrice, 'gwei'),
            gasLimit: gasLimit.toString(),
            nonce
        });

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const tx = await contract.fulfillTime(requestId, currentTimestamp, {
            gasPrice: gasPrice,
            gasLimit: gasLimit,
            nonce
        });
        logger('info', 'FulfillTime transaction sent', { hash: tx.hash });
        
        const receipt = await tx.wait(1);
        
        logger('info', 'Time fulfilled and confirmed', {
            requestId,
            tradeId,
            timestamp: currentTimestamp,
            txHash: receipt.transactionHash,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.effectiveGasPrice 
                ? ethers.utils.formatUnits(receipt.effectiveGasPrice, 'gwei') 
                : 'N/A'
        });

        await updateTradeStatus(tradeId, 'fulfilled');
        pendingTransactions.delete(requestId);
        return { success: true, txHash: receipt.transactionHash };
    } catch (error) {
        logger('error', 'Error fulfilling time', { error: error.message, tradeId, retryCount });
        if (error.code === 'REPLACEMENT_UNDERPRICED' && retryCount < MAX_RETRY_ATTEMPTS) {
            logger('info', 'Retrying with higher gas price', { tradeId, retryCount: retryCount + 1 });
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retrying
            return handleTimeRequest(requestId, tradeId, retryCount + 1);
        }
        return { success: false, error: error.message };
    }
}


async function handleExpiredTrade(tradeId, requestId, retryCount = 0) {
    logger('info', 'Trade duration exceeded, calling handleFailedConfirmation', { tradeId, retryCount });
    const currentStatus = await getTradeStatus(tradeId);
    if (currentStatus !== 'processing') {
        logger('info', 'Trade not in processing state, skipping failed confirmation', { tradeId, currentStatus });
        pendingTransactions.delete(requestId);
        return;
    }

    try {
        if (!(await checkBalance())) {
            throw new Error("Insufficient balance to send transaction");
        }

        const gasPrice = await getOptimalGasPrice(retryCount);
        const gasLimit = getGasLimit();

        logger('info', 'Attempting to send handleFailedConfirmation transaction', {
            tradeId,
            gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
            gasLimit: gasLimit.toString()
        });

        const tx = await contract.handleFailedConfirmation(tradeId, {
            gasPrice: gasPrice,
            gasLimit: gasLimit
        });
        logger('info', 'HandleFailedConfirmation transaction sent', { hash: tx.hash });
        
        const receipt = await tx.wait(1);
        
        logger('info', 'HandleFailedConfirmation called successfully', {
            tradeId,
            txHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice: receipt.effectiveGasPrice 
                ? ethers.formatUnits(receipt.effectiveGasPrice, 'gwei') 
                : 'N/A'
        });

        await updateTradeStatus(tradeId, 'failed');
        pendingTransactions.delete(requestId);
    } catch (error) {
        logger('error', 'Error handling expired trade', { error: error.message, tradeId, retryCount });
        if (retryCount < MAX_RETRY_ATTEMPTS) {
            const backoffTime = Math.min(RETRY_DELAY * Math.pow(2, retryCount), 300); // Max backoff of 5 minutes
            await new Promise(resolve => setTimeout(resolve, backoffTime * 1000));
            return handleExpiredTrade(tradeId, requestId, retryCount + 1);
        } else {
            logger('error', 'Max retry attempts reached for expired trade', { tradeId });
            await updateTradeStatus(tradeId, 'failed');
            pendingTransactions.delete(requestId);
        }
    }
}

async function processActiveTrade(requestId, tradeId, details) {
    logger('info', 'Processing active trade', { tradeId });
    const result = await handleTimeRequest(requestId, tradeId);
    if (result.success) {
        await updateTradeStatus(tradeId, 'fulfilled');
        logger('info', 'Trade fulfilled successfully', { tradeId });
    } else {
        logger('warn', 'Failed to fulfill time', { tradeId, error: result.error });
        details.attempts++;
        details.lastAttempt = Math.floor(Date.now() / 1000);
        if (details.attempts >= MAX_RETRY_ATTEMPTS) {
            await updateTradeStatus(tradeId, 'failed');
            pendingTransactions.delete(requestId);
            logger('error', 'Max attempts reached, trade failed', { tradeId });
        }
    }
}

async function handleProcessingError(error, requestId, tradeId, details, currentTime) {
    logger('error', 'Error processing trade', { tradeId, error: error.message });
    details.attempts++;
    details.lastAttempt = currentTime;
    if (details.attempts >= MAX_RETRY_ATTEMPTS) {
        try {
            await updateTradeStatus(tradeId, 'failed');
            logger('error', 'Max attempts reached, trade failed', { tradeId });
            pendingTransactions.delete(requestId);
        } catch (err) {
            logger('error', 'Failed to update trade status after max attempts', { tradeId, error: err.message });
        }
    }
}

async function cleanupPendingTransactions() {
    const currentTime = Math.floor(Date.now() / 1000);

    for (const [requestId, details] of pendingTransactions.entries()) {
        if (!details || !details.lastAttempt) {
            logger('warn', 'Invalid transaction details, removing', { requestId });
            pendingTransactions.delete(requestId);
            continue;
        }

        const pendingTime = currentTime - details.lastAttempt;
        if (pendingTime > MAX_PENDING_TIME && !details.transactionSent) {
            logger('info', 'Removing long-pending transaction', { 
                requestId, 
                tradeId: details.tradeId, 
                pendingTime: pendingTime 
            });
            await updateTradeStatus(details.tradeId, 'failed');
            pendingTransactions.delete(requestId);
        }
    }
}

// API endpoints
app.post('/oracle-time', async (req, res) => {
    const { requestId } = req.body;

    if (!requestId) {
        return res.status(400).json({ error: 'requestId is required' });
    }

    try {
        addToPendingTransactions(requestId);
        res.json({ message: 'Time request added to processing queue', requestId });
    } catch (error) {
        logger('error', 'Failed to add time request to queue', { error: error.message });
        res.status(500).json({ 
            error: 'Failed to add time request to queue', 
            details: error.message 
        });
    }
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', message: 'Oracle API is running' });
});

app.get('/pending-transactions', (req, res) => {
    const pendingList = Array.from(pendingTransactions.entries()).map(([requestId, details]) => ({
        requestId,
        tradeId: details.tradeId ? details.tradeId.toString() : 'unknown',
        attempts: details.attempts,
        lastAttempt: details.lastAttempt ? new Date(details.lastAttempt * 1000).toISOString() : 'unknown',
        transactionSent: details.transactionSent || false,
        failureHandled: details.failureHandled || false
    }));
    res.json(pendingList);
});

app.get('/trade-details/:tradeId', async (req, res) => {
    const tradeId = req.params.tradeId;
    const details = tradeDetails.get(tradeId);
    if (!details) {
        return res.status(404).json({ error: 'Trade details not found' });
    }
    
    try {
        const onChainDetails = await contract.getTrade(tradeId);
        res.json({
            ...details,
            onChainDetails: {
                id: onChainDetails[0].toString(),
                amount: onChainDetails[1].toString(),
                buyer: onChainDetails[2],
                seller: onChainDetails[3],
                state: onChainDetails[4],
                inceptionTime: onChainDetails[5].toString(),
                confirmationTime: onChainDetails[6].toString(),
                duration: onChainDetails[7].toString()
            }
        });
    } catch (error) {
        logger('error', 'Error fetching on-chain trade details', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch on-chain trade details', details: error.message });
    }
});

app.get('/balance', async (req, res) => {
    try {
        const balance = await provider.getBalance(signer.getAddress());
        const gasPrice = await getOptimalGasPrice();
        const gasLimit = getGasLimit();
        const estimatedCost = gasPrice * gasLimit;
        res.json({
            balance: ethers.formatEther(balance),
            estimatedTransactionCost: ethers.formatEther(estimatedCost),
            sufficientFunds: balance >= estimatedCost,
            gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
            gasLimit: gasLimit.toString()
        });
    } catch (error) {
        logger('error', 'Failed to fetch balance', { error: error.message });
        res.status(500).json({ error: 'Failed to fetch balance', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await initializeEthers();
        app.listen(PORT, () => {
            logger('info', `Server running on port ${PORT}`);
        });
    } catch (error) {
        logger('error', 'Failed to start server', { error: error.message });
        process.exit(1);
    }
}

startServer().catch(error => logger('error', 'Unhandled error during server start', { error: error.message }));

module.exports = {
    initializeEthers,
    pollEvents,
    processPendingTransactions,
    handleTimeRequest,
    getTradeStatus,
    updateTradeStatus,
    checkBalance,
    cleanupPendingTransactions
};