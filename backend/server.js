const ethers = require('ethers');
const express = require('express');
require('dotenv').config();

const app = express();
app.use(express.json());

const contractABI = [
    "function fulfillTime(bytes32 _requestId, uint256 _timestamp) external",
    "function handleFailedConfirmation(uint tradeId) external",
    "event TimeRequestSent(bytes32 requestId, uint tradeId, uint256 duration)",
    "function getTrade(uint _tradeId) public view returns (uint, uint256, address, address, uint8, uint256, uint256, uint256)"
];

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const ETHEREUM_NODE_URL = process.env.ETHEREUM_NODE_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

let provider, signer, contract;
let lastProcessedBlock = 0;
let currentNonce = 0;

// Store trade information and processing status
const trades = new Map();
// Queue for pending events
const eventQueue = [];
// Set of trade IDs currently being processed
const processingTrades = new Set();

function log(message) {
    console.log(`${new Date().toISOString()} - ${message}`);
}

async function initializeEthers() {
    provider = new ethers.JsonRpcProvider(ETHEREUM_NODE_URL);
    signer = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, signer);
    lastProcessedBlock = await provider.getBlockNumber();
    currentNonce = await provider.getTransactionCount(signer.address);
    log(`Initialized with contract: ${CONTRACT_ADDRESS}`);
}

async function handleTimeRequest(requestId, tradeId, duration, eventTimestamp) {
    if (processingTrades.has(tradeId)) {
        log(`Trade ${tradeId} is currently being processed, queueing this request`);
        eventQueue.push({ requestId, tradeId, duration, eventTimestamp });
        return;
    }

    processingTrades.add(tradeId);
    
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        
        if (!trades.has(tradeId)) {
            // First time seeing this trade
            trades.set(tradeId, { 
                inceptionTime: eventTimestamp, 
                duration: Number(duration),
                lastRequestId: requestId,
                lastRequestTime: eventTimestamp
            });
            await fulfillTime(requestId, eventTimestamp);
            log(`Inception time set for trade ${tradeId}`);
        } else {
            const trade = trades.get(tradeId);
            if (currentTime - trade.inceptionTime <= trade.duration) {
                // Confirmation within duration
                trade.lastRequestId = requestId;
                trade.lastRequestTime = eventTimestamp;
                await fulfillTime(requestId, eventTimestamp);
                log(`Confirmation time set for trade ${tradeId}`);
            } else {
                // Exceeded duration
                await handleFailedConfirmation(tradeId);
                log(`Failed confirmation for trade ${tradeId} due to exceeded duration`);
                trades.delete(tradeId);
            }
        }
    } catch (error) {
        log(`Error processing trade ${tradeId}: ${error.message}`);
    } finally {
        processingTrades.delete(tradeId);
        processNextEvent();
    }
}

async function fulfillTime(requestId, timestamp) {
    try {
        const tx = await contract.fulfillTime(requestId, timestamp, {
            nonce: currentNonce++,
            gasLimit: 200000 // Adjust as needed
        });
        await tx.wait();
        log(`Fulfilled time for request ${requestId}`);
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            currentNonce = await provider.getTransactionCount(signer.address);
            log(`Nonce reset to ${currentNonce}`);
            // Retry the transaction
            return fulfillTime(requestId, timestamp);
        }
        throw error;
    }
}

async function handleFailedConfirmation(tradeId) {
    try {
        const tx = await contract.handleFailedConfirmation(tradeId, {
            nonce: currentNonce++,
            gasLimit: 200000 // Adjust as needed
        });
        await tx.wait();
        log(`Handled failed confirmation for trade ${tradeId}`);
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            currentNonce = await provider.getTransactionCount(signer.address);
            log(`Nonce reset to ${currentNonce}`);
            // Retry the transaction
            return handleFailedConfirmation(tradeId);
        }
        throw error;
    }
}

function processNextEvent() {
    if (eventQueue.length > 0) {
        const nextEvent = eventQueue.shift();
        handleTimeRequest(nextEvent.requestId, nextEvent.tradeId, nextEvent.duration, nextEvent.eventTimestamp)
            .catch(error => log(`Error processing queued event: ${error.message}`));
    }
}

async function checkAndHandleExpiredTrades() {
    const currentTime = Math.floor(Date.now() / 1000);
    for (const [tradeId, trade] of trades.entries()) {
        if (currentTime - trade.inceptionTime > trade.duration && !processingTrades.has(tradeId)) {
            processingTrades.add(tradeId);
            try {
                await handleFailedConfirmation(tradeId);
                log(`Handled expired trade ${tradeId}`);
                trades.delete(tradeId);
            } catch (error) {
                log(`Error handling expired trade ${tradeId}: ${error.message}`);
            } finally {
                processingTrades.delete(tradeId);
            }
        }
    }
}

async function pollEvents() {
    try {
        const latestBlock = await provider.getBlockNumber();
        if (latestBlock <= lastProcessedBlock) {
            return; // No new blocks
        }

        log(`Checking for events from block ${lastProcessedBlock + 1} to ${latestBlock}`);

        const filter = contract.filters.TimeRequestSent();
        const events = await contract.queryFilter(filter, lastProcessedBlock + 1, latestBlock);

        for (const event of events) {
            const { requestId, tradeId, duration } = event.args;
            const eventTimestamp = (await event.getBlock()).timestamp;
            log(`Received TimeRequestSent event for trade ${tradeId}`);
            if (!processingTrades.has(tradeId.toString())) {
                handleTimeRequest(requestId, tradeId.toString(), duration, eventTimestamp)
                    .catch(error => log(`Error processing event: ${error.message}`));
            } else {
                eventQueue.push({ requestId, tradeId: tradeId.toString(), duration, eventTimestamp });
                log(`Trade ${tradeId} is being processed, event queued`);
            }
        }

        lastProcessedBlock = latestBlock;
    } catch (error) {
        log(`Error polling events: ${error.message}`);
    }
}

// Poll for events every 15 seconds
setInterval(pollEvents, 15000);

// Check for expired trades every 30 seconds
setInterval(checkAndHandleExpiredTrades, 30000);

const PORT = process.env.PORT || 1202;

async function startServer() {
    await initializeEthers();
    
    app.listen(PORT, () => {
        log(`Server running on port ${PORT}`);
    });
}

startServer().catch(error => log(`Unhandled error during server start: ${error.message}`));