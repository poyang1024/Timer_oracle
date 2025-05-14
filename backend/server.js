const ethers = require('ethers');
const express = require('express');
const logger = require('./services/logger');
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

const trades = new Map();
const eventQueue = [];
const processingTrades = new Set();

async function initializeEthers() {
    provider = new ethers.JsonRpcProvider(ETHEREUM_NODE_URL);
    signer = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, contractABI, signer);
    lastProcessedBlock = await provider.getBlockNumber();
    currentNonce = await provider.getTransactionCount(signer.address);
    logger('info', `Initialized contract`, { 
        contract: CONTRACT_ADDRESS,
        startBlock: lastProcessedBlock
    });
}

async function handleTimeRequest(requestId, tradeId, duration, eventTimestamp) {
    if (processingTrades.has(tradeId)) {
        logger('info', `Trade queued for processing`, {
            tradeId,
            requestId,
            duration: duration.toString(),
            eventTimestamp
        });
        eventQueue.push({ requestId, tradeId, duration, eventTimestamp });
        return;
    }

    processingTrades.add(tradeId);
    
    try {
        const currentTime = Math.floor(Date.now() / 1000);
        
        if (!trades.has(tradeId)) {
            trades.set(tradeId, { 
                inceptionTime: eventTimestamp, 
                duration: Number(duration),
                lastRequestId: requestId,
                lastRequestTime: eventTimestamp
            });
            await fulfillTime(requestId, eventTimestamp);
            logger('info', `Inception time set`, {
                tradeId,
                inceptionTime: eventTimestamp,
                duration: duration.toString()
            });
        } else {
            const trade = trades.get(tradeId);
            if (currentTime - trade.inceptionTime <= trade.duration) {
                trade.lastRequestId = requestId;
                trade.lastRequestTime = eventTimestamp;
                await fulfillTime(requestId, eventTimestamp);
                logger('info', `Confirmation time set`, {
                    tradeId,
                    requestId,
                    duration: trade.duration.toString(),
                    timeElapsed: (currentTime - trade.inceptionTime).toString()
                });
            } else {
                await handleFailedConfirmation(tradeId);
                logger('warn', `Failed confirmation due to exceeded duration`, {
                    tradeId,
                    duration: trade.duration.toString(),
                    timeElapsed: (currentTime - trade.inceptionTime).toString()
                });
                trades.delete(tradeId);
            }
        }
    } catch (error) {
        logger('error', `Error processing trade`, {
            tradeId,
            duration: duration.toString(),
            error: error.message
        });
    } finally {
        processingTrades.delete(tradeId);
        processNextEvent();
    }
}

async function fulfillTime(requestId, timestamp) {
    try {
        const tx = await contract.fulfillTime(requestId, timestamp, {
            nonce: currentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        logger('info', `Time fulfilled`, {
            requestId,
            timestamp
        });
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            currentNonce = await provider.getTransactionCount(signer.address);
            logger('warn', `Nonce reset`, {
                newNonce: currentNonce
            });
            return fulfillTime(requestId, timestamp);
        }
        throw error;
    }
}

async function handleFailedConfirmation(tradeId) {
    try {
        const tx = await contract.handleFailedConfirmation(tradeId, {
            nonce: currentNonce++,
            gasLimit: 200000
        });
        await tx.wait();
        logger('info', `Failed confirmation handled`, {
            tradeId
        });
    } catch (error) {
        if (error.message.includes('nonce too low')) {
            currentNonce = await provider.getTransactionCount(signer.address);
            logger('warn', `Nonce reset`, {
                newNonce: currentNonce
            });
            return handleFailedConfirmation(tradeId);
        }
        throw error;
    }
}

function processNextEvent() {
    if (eventQueue.length > 0) {
        const nextEvent = eventQueue.shift();
        handleTimeRequest(nextEvent.requestId, nextEvent.tradeId, nextEvent.duration, nextEvent.eventTimestamp)
            .catch(error => logger('error', `Error processing queued event`, {
                error: error.message,
                duration: nextEvent.duration.toString()
            }));
    }
}

async function checkAndHandleExpiredTrades() {
    const currentTime = Math.floor(Date.now() / 1000);
    for (const [tradeId, trade] of trades.entries()) {
        if (currentTime - trade.inceptionTime > trade.duration && !processingTrades.has(tradeId)) {
            processingTrades.add(tradeId);
            try {
                await handleFailedConfirmation(tradeId);
                logger('info', `Expired trade handled`, {
                    tradeId,
                    duration: trade.duration.toString(),
                    timeElapsed: (currentTime - trade.inceptionTime).toString()
                });
                trades.delete(tradeId);
            } catch (error) {
                logger('error', `Error handling expired trade`, {
                    tradeId,
                    duration: trade.duration.toString(),
                    error: error.message
                });
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
            return;
        }

        logger('debug', `Checking for new events`, {
            fromBlock: lastProcessedBlock + 1,
            toBlock: latestBlock
        });

        const filter = contract.filters.TimeRequestSent();
        const events = await contract.queryFilter(filter, lastProcessedBlock + 1, latestBlock);

        for (const event of events) {
            const { requestId, tradeId, duration } = event.args;
            const eventTimestamp = (await event.getBlock()).timestamp;
            
            logger('info', `TimeRequestSent event received`, {
                tradeId: tradeId.toString(),
                requestId,
                duration: duration.toString(),
                eventTimestamp
            });

            if (!processingTrades.has(tradeId.toString())) {
                handleTimeRequest(requestId, tradeId.toString(), duration, eventTimestamp)
                    .catch(error => logger('error', `Error processing event`, {
                        error: error.message,
                        duration: duration.toString()
                    }));
            } else {
                eventQueue.push({ requestId, tradeId: tradeId.toString(), duration, eventTimestamp });
                logger('info', `Event queued - trade in process`, {
                    tradeId: tradeId.toString(),
                    duration: duration.toString()
                });
            }
        }

        lastProcessedBlock = latestBlock;
    } catch (error) {
        logger('error', `Error polling events`, {
            error: error.message
        });
    }
}

setInterval(pollEvents, 15000);
setInterval(checkAndHandleExpiredTrades, 30000);

const PORT = process.env.PORT || 1202;

async function startServer() {
    await initializeEthers();
    
    app.listen(PORT, () => {
        logger('info', `Server started`, {
            port: PORT
        });
    });
}

startServer().catch(error => logger('error', `Server start failed`, {
    error: error.message
}));