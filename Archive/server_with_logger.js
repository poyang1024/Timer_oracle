const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const ethers = require('ethers');
require('dotenv').config();
const logger = require('../logger');

const app = express();
app.use(express.json());

const contractABI = [
    "function fulfillTime(bytes32 _requestId, uint256 _timestamp) external",
    "function handleFailedConfirmation(uint tradeId) external",
    "event TimeRequestSent(bytes32 requestId, uint tradeId, uint256 duration)",
    "function getTrade(uint _tradeId) public view returns (uint, uint256, address, address, bool, uint256, uint256, bool)"
];

// Define the maximum time a transaction can be pending before it's considered "long pending"
const MAX_PENDING_TIME = 3600; // 1 hour in seconds

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

async function getOptimalGasPrice() {
    try {
        const feeData = await provider.getFeeData();
        const currentGasPrice = feeData.gasPrice;
        return ethers.min(ethers.max(currentGasPrice, BASE_GAS_PRICE), MAX_GAS_PRICE);
    } catch (error) {
        logger('warn', 'Error fetching gas price, using base price', { error: error.message });
        return BASE_GAS_PRICE;
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
                    const tradeId = event.args.tradeId.toString();
                    const currentStatus = await getTradeStatus(tradeId);
                    
                    logger('info', 'Received TimeRequestSent event', {
                        requestId: event.args.requestId,
                        tradeId: tradeId,
                        duration: event.args.duration.toString(),
                        currentStatus: currentStatus
                    });
                    
                    if (currentStatus === 'pending') {
                        const duration = Number(event.args.duration);

                        tradeDetails.set(tradeId, {
                            requestId: event.args.requestId,
                            inceptionTime: Math.floor(Date.now() / 1000),
                            duration: duration
                        });
                        addToPendingTransactions(event.args.requestId, event.args.tradeId);
                        await updateTradeStatus(tradeId, 'processing');
                    } else {
                        logger('info', 'Trade already being processed or completed, skipping', { tradeId, currentStatus });
                    }
                    
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

function addToPendingTransactions(requestId, tradeId) {
    if (!pendingTransactions.has(requestId)) {
        pendingTransactions.set(requestId, {
            attempts: 0,
            lastAttempt: 0,
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
    
    if (balance < estimatedCost) {
        logger('error', 'Insufficient balance', {
            currentBalance: ethers.formatEther(balance),
            estimatedCost: ethers.formatEther(estimatedCost)
        });
        return false;
    }
    return true;
}

async function processPendingTransactions() {
    const currentTime = Math.floor(Date.now() / 1000);
    const transactionsToProcess = new Map(pendingTransactions);

    logger('info', `Processing ${transactionsToProcess.size} pending transactions`);

    for (const [requestId, details] of transactionsToProcess) {
        const tradeId = details.tradeId.toString();
        const tradeDetail = tradeDetails.get(tradeId);

        logger('info', `Processing transaction`, { requestId, tradeId });

        if (!tradeDetail) {
            logger('warn', 'Trade details not found, removing from pending', { tradeId });
            pendingTransactions.delete(requestId);
            continue;
        }

        const elapsedTime = currentTime - tradeDetail.inceptionTime;
        logger('info', 'Checking trade duration', { 
            tradeId, 
            elapsedTime, 
            duration: tradeDetail.duration,
            inceptionTime: new Date(tradeDetail.inceptionTime * 1000).toISOString(),
            currentTime: new Date(currentTime * 1000).toISOString()
        });

        try {
            const currentStatus = await getTradeStatus(tradeId);
            
            if (currentStatus !== 'processing') {
                logger('info', 'Trade not in processing state, removing from pending', { tradeId, currentStatus });
                pendingTransactions.delete(requestId);
                continue;
            }

            if (elapsedTime > tradeDetail.duration && !details.failureHandled) {
                logger('info', 'Trade duration exceeded, calling handleFailedConfirmation', { tradeId });
                const result = await handleFailedConfirmation(tradeId);
                if (result.success) {
                    await updateTradeStatusAndRemoveFromPending(tradeId, 'failed', requestId);
                    logger('info', 'Trade failed due to timeout', { tradeId });
                } else {
                    logger('error', 'Failed to handle timeout', { tradeId, error: result.error });
                    details.attempts++;
                    details.lastAttempt = currentTime;
                    if (details.attempts >= 5) {
                        await updateTradeStatusAndRemoveFromPending(tradeId, 'failed', requestId);
                        logger('error', 'Max attempts reached for failed confirmation', { tradeId });
                    }
                }
                details.failureHandled = true;
            } else if (!details.transactionSent && currentTime - details.lastAttempt >= 15) {
                logger('info', 'Processing trade', { tradeId });
                const result = await handleTimeRequest(requestId, tradeId);
                if (result.success) {
                    await updateTradeStatusAndRemoveFromPending(tradeId, 'fulfilled', requestId);
                    logger('info', 'Trade fulfilled successfully', { tradeId });
                } else {
                    logger('warn', 'Failed to fulfill time', { tradeId, error: result.error });
                    details.attempts++;
                    details.lastAttempt = currentTime;
                    if (details.attempts >= 5) {
                        await updateTradeStatusAndRemoveFromPending(tradeId, 'failed', requestId);
                        logger('error', 'Max attempts reached, trade failed', { tradeId });
                    }
                }
            } else {
                logger('info', 'Skipping trade, not yet time to retry or already processed', { 
                    tradeId, 
                    timeSinceLastAttempt: currentTime - details.lastAttempt,
                    transactionSent: details.transactionSent
                });
            }
        } catch (error) {
            logger('error', 'Error processing trade', { tradeId, error: error.message });
            details.attempts++;
            details.lastAttempt = currentTime;
            if (details.attempts >= 5) {
                await updateTradeStatusAndRemoveFromPending(tradeId, 'failed', requestId);
                logger('error', 'Max attempts reached due to repeated errors', { tradeId });
            }
        }
    }

    logger('info', `Finished processing pending transactions`);
}

async function updateTradeStatusAndRemoveFromPending(tradeId, status, requestId) {
    const currentStatus = await getTradeStatus(tradeId);
    if (currentStatus !== status) {
        await updateTradeStatus(tradeId, status);
        pendingTransactions.delete(requestId);
        logger('info', 'Updated trade status and removed from pending', { tradeId, status });
    } else {
        logger('info', 'Trade status already up to date, skipping update', { tradeId, status });
    }
}

async function handleTimeRequest(requestId, tradeId) {
    const currentStatus = await getTradeStatus(tradeId);
    if (currentStatus !== 'processing') {
        logger('info', 'Trade not in processing state, skipping time request', { tradeId, currentStatus });
        return { success: true };
    }

    try {
        if (!(await checkBalance())) {
            throw new Error("Insufficient balance to send transaction");
        }

        const gasPrice = await getOptimalGasPrice();
        const gasLimit = getGasLimit();

        logger('info', 'Attempting to send fulfillTime transaction', {
            requestId,
            tradeId,
            gasPrice: ethers.formatUnits(gasPrice, 'gwei'),
            gasLimit: gasLimit.toString()
        });

        const currentTimestamp = Math.floor(Date.now() / 1000);
        const tx = await contract.fulfillTime(requestId, currentTimestamp, {
            gasPrice: gasPrice,
            gasLimit: gasLimit
        });
        logger('info', 'FulfillTime transaction sent', { hash: tx.hash });
        
        const details = pendingTransactions.get(requestId);
        if (details) {
            details.transactionSent = true;
            pendingTransactions.set(requestId, details);
        }

        const receipt = await tx.wait(3);
        
        const effectiveGasPrice = receipt.effectiveGasPrice 
            ? ethers.formatUnits(receipt.effectiveGasPrice, 'gwei') 
            : 'N/A';
        
        logger('info', 'Time fulfilled', {
            requestId,
            tradeId,
            timestamp: currentTimestamp,
            txHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice
        });

        const tradeDetail = tradeDetails.get(tradeId);
        if (tradeDetail) {
            tradeDetail.inceptionTime = currentTimestamp;
            tradeDetails.set(tradeId, tradeDetail);
        }

        return { success: true, txHash: receipt.hash };
    } catch (error) {
        logger('error', 'Error fulfilling time', { error: error.message, tradeId });
        if (error.code === 'INSUFFICIENT_FUNDS') {
            logger('error', 'Insufficient funds to send transaction. Please add more ETH to the account.');
        }
        return { success: false, error: error.message };
    }
}

async function handleFailedConfirmation(tradeId) {
    const currentStatus = await getTradeStatus(tradeId);
    if (currentStatus !== 'processing') {
        logger('info', 'Trade not in processing state, skipping failed confirmation', { tradeId, currentStatus });
        return { success: true };
    }

    try {
        if (!(await checkBalance())) {
            throw new Error("Insufficient balance to send transaction");
        }

        const gasPrice = await getOptimalGasPrice();
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
        
        const receipt = await tx.wait(3);
        
        const effectiveGasPrice = receipt.effectiveGasPrice 
            ? ethers.formatUnits(receipt.effectiveGasPrice, 'gwei') 
            : 'N/A';
        
        logger('info', 'HandleFailedConfirmation called successfully', {
            tradeId,
            txHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
            effectiveGasPrice
        });

        return { success: true, txHash: receipt.hash };
    } catch (error) {
        logger('error', 'Error handling failed confirmation', { error: error.message, tradeId });
        if (error.code === 'INSUFFICIENT_FUNDS') {
            logger('error', 'Insufficient funds to send transaction. Please add more ETH to the account.');
        }
        return { success: false, error: error.message };
    }
}

async function cleanupPendingTransactions() {
    const currentTime = Math.floor(Date.now() / 1000);

    for (const [requestId, details] of pendingTransactions.entries()) {
        if (currentTime - details.lastAttempt > MAX_PENDING_TIME && !details.transactionSent) {
            logger('info', 'Removing long-pending transaction', { 
                requestId, 
                tradeId: details.tradeId, 
                pendingTime: currentTime - details.lastAttempt 
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
        tradeId: details.tradeId.toString(),
        attempts: details.attempts,
        lastAttempt: new Date(details.lastAttempt * 1000).toISOString(),
        transactionSent: details.transactionSent,
        failureHandled: details.failureHandled
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
                isConfirmed: onChainDetails[4],
                inceptionTime: onChainDetails[5].toString(),
                duration: onChainDetails[6].toString(),
                isCompleted: onChainDetails[7]
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

app.get('/trade-status/:tradeId', async (req, res) => {
    const tradeId = req.params.tradeId;
    try {
        const status = await getTradeStatus(tradeId);
        res.json({ tradeId, status });
    } catch (error) {
        logger('error', 'Error fetching trade status', { tradeId, error: error.message });
        res.status(500).json({ error: 'Failed to fetch trade status', details: error.message });
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
    handleFailedConfirmation,
    getTradeStatus,
    updateTradeStatus,
    checkBalance,
    cleanupPendingTransactions
};