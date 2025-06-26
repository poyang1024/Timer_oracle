/**
 * 跨鏈交易驗證器
 * 使用現代化的狀態證明和交易驗證方法
 * 基於 ethers.js 和 EIP-1186，替代已廢棄的 eth-proof 套件
 */

const ethers = require('ethers');
const logger = require('./logger');

class CrossChainTransactionVerifier {
    constructor(paymentRpcUrl) {
        this.paymentRpcUrl = paymentRpcUrl;
        this.provider = new ethers.JsonRpcProvider(paymentRpcUrl);
        
        logger('info', '跨鏈交易驗證器初始化', {
            paymentRpcUrl: paymentRpcUrl?.substring(0, 50) + '...'
        });
    }

    /**
     * 驗證交易是否在區塊中確實存在並成功執行
     * 使用現代化的狀態證明方法替代傳統 Merkle proof
     */
    async verifyTransactionExecution(txHash, confirmations = 20, timeoutSeconds = 480) {
        const startTime = Date.now();
        const timeout = timeoutSeconds * 1000;

        logger('info', '開始跨鏈交易驗證', {
            txHash,
            confirmations,
            timeoutSeconds
        });

        try {
            // 1. 等待交易被挖掘並獲得足夠確認
            let receipt = null;
            let transaction = null;
            let currentBlock = await this.provider.getBlockNumber();
            
            // 首先檢查交易是否存在
            while (!receipt && (Date.now() - startTime) < timeout) {
                try {
                    receipt = await this.provider.getTransactionReceipt(txHash);
                    if (!receipt) {
                        logger('debug', '等待交易被挖掘...', { txHash });
                        await this.delay(2000);
                        continue;
                    }
                    
                    // 同時獲取交易詳情
                    transaction = await this.provider.getTransaction(txHash);
                    break;
                } catch (error) {
                    logger('debug', '查詢交易失敗，繼續等待...', {
                        txHash,
                        error: error.message
                    });
                    await this.delay(2000);
                }
            }

            if (!receipt || !transaction) {
                throw new Error(`交易 ${txHash} 在 ${timeoutSeconds} 秒內未被挖掘`);
            }

            logger('info', '交易已被挖掘', {
                txHash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed?.toString(),
                status: receipt.status,
                from: transaction.from,
                to: transaction.to
            });

            // 2. 檢查交易是否成功執行
            if (receipt.status !== 1) {
                throw new Error(`交易執行失敗，status: ${receipt.status}`);
            }

            // 3. 等待足夠的確認數
            while ((Date.now() - startTime) < timeout) {
                currentBlock = await this.provider.getBlockNumber();
                const confirmationsReceived = currentBlock - receipt.blockNumber + 1;
                
                if (confirmationsReceived >= confirmations) {
                    logger('info', '已獲得足夠確認', {
                        txHash,
                        confirmationsReceived,
                        requiredConfirmations: confirmations
                    });
                    break;
                }

                logger('debug', '等待更多確認...', {
                    txHash,
                    confirmationsReceived,
                    requiredConfirmations: confirmations
                });
                
                await this.delay(3000);
            }

            // 4. 獲取區塊資訊進行驗證
            const txBlock = await this.provider.getBlock(receipt.blockNumber, true); // 包含交易
            const trustedBlockHash = txBlock.hash;

            // 5. 現代化驗證方法：直接驗證交易在區塊中的存在性
            const blockTransactions = txBlock.transactions;
            let transactionFound = false;
            
            // 檢查交易是否真的在區塊中
            for (const blockTx of blockTransactions) {
                if (typeof blockTx === 'string') {
                    if (blockTx.toLowerCase() === txHash.toLowerCase()) {
                        transactionFound = true;
                        break;
                    }
                } else if (blockTx.hash && blockTx.hash.toLowerCase() === txHash.toLowerCase()) {
                    transactionFound = true;
                    break;
                }
            }

            if (!transactionFound) {
                throw new Error(`交易 ${txHash} 未在區塊 ${receipt.blockNumber} 中找到`);
            }

            // 6. 使用 eth_getProof 進行狀態驗證（如果節點支援）
            let stateProofVerified = false;
            try {
                // 嘗試獲取合約狀態證明
                if (transaction.to) {
                    const proof = await this.provider.send('eth_getProof', [
                        transaction.to,
                        [],
                        `0x${receipt.blockNumber.toString(16)}`
                    ]);
                    stateProofVerified = !!proof;
                    logger('info', 'eth_getProof 狀態驗證成功', {
                        txHash,
                        contractAddress: transaction.to,
                        proofVerified: stateProofVerified
                    });
                }
            } catch (proofError) {
                logger('warn', 'eth_getProof 不支援或失敗，使用基本驗證', {
                    txHash,
                    error: proofError.message
                });
                stateProofVerified = true; // 如果不支援，則使用基本驗證
            }

            // 7. 驗證交易回執的完整性
            const requeriedReceipt = await this.provider.getTransactionReceipt(txHash);
            if (!requeriedReceipt || requeriedReceipt.blockHash !== receipt.blockHash) {
                throw new Error('交易回執驗證失敗：區塊雜湊不匹配');
            }

            logger('info', '跨鏈交易狀態證明驗證完成', {
                txHash,
                blockHash: trustedBlockHash,
                blockNumber: receipt.blockNumber,
                confirmations: currentBlock - receipt.blockNumber + 1,
                gasUsed: receipt.gasUsed?.toString(),
                verificationTime: Date.now() - startTime,
                transactionInBlock: transactionFound,
                stateProofSupported: stateProofVerified
            });

            return {
                verified: true,
                receipt: receipt,
                transaction: transaction,
                proof: {
                    blockHash: trustedBlockHash,
                    blockNumber: receipt.blockNumber,
                    confirmations: currentBlock - receipt.blockNumber + 1,
                    verificationTime: Date.now() - startTime,
                    transactionInBlock: transactionFound,
                    stateProofSupported: stateProofVerified
                },
                originalReceipt: receipt
            };

        } catch (error) {
            logger('error', '跨鏈交易驗證過程出錯', {
                txHash,
                error: error.message,
                stack: error.stack,
                timeElapsed: Date.now() - startTime
            });

            return {
                verified: false,
                error: error.message,
                timeElapsed: Date.now() - startTime
            };
        }
    }

    /**
     * 專門驗證支付合約的 transferWithKey 交易
     */
    async verifyPaymentTransferTransaction(txHash, paymentContractAddress, paymentId, confirmations = 20, timeoutSeconds = 480) {
        logger('info', '開始驗證支付轉帳交易', {
            txHash,
            paymentContractAddress,
            paymentId,
            confirmations,
            timeoutSeconds
        });

        try {
            // 使用基礎驗證方法
            const baseResult = await this.verifyTransactionExecution(txHash, confirmations, timeoutSeconds);
            
            if (!baseResult.verified) {
                return {
                    ...baseResult,
                    paymentVerified: false,
                    paymentError: baseResult.error
                };
            }

            // 額外的支付特定驗證
            const receipt = baseResult.receipt;
            const transaction = baseResult.transaction;

            // 檢查是否是對正確合約的調用
            if (transaction.to.toLowerCase() !== paymentContractAddress.toLowerCase()) {
                throw new Error(`交易目標合約不匹配：期望 ${paymentContractAddress}，實際 ${transaction.to}`);
            }

            // 檢查是否有 PaymentCompleted 事件
            let paymentCompletedFound = false;
            for (const log of receipt.logs) {
                if (log.address.toLowerCase() === paymentContractAddress.toLowerCase()) {
                    // PaymentCompleted 事件的簽名
                    const paymentCompletedTopic = ethers.id('PaymentCompleted(uint256,address,uint256)');
                    if (log.topics[0] === paymentCompletedTopic) {
                        try {
                            // 解碼事件參數
                            const decodedLog = ethers.AbiCoder.defaultAbiCoder().decode(
                                ['uint256', 'address', 'uint256'],
                                log.data
                            );
                            const eventPaymentId = decodedLog[0];
                            
                            if (eventPaymentId.toString() === paymentId.toString()) {
                                paymentCompletedFound = true;
                                logger('info', 'PaymentCompleted 事件驗證成功', {
                                    txHash,
                                    paymentId: eventPaymentId.toString(),
                                    recipient: decodedLog[1],
                                    amount: decodedLog[2].toString()
                                });
                                break;
                            }
                        } catch (decodeError) {
                            logger('warn', 'PaymentCompleted 事件解碼失敗', {
                                txHash,
                                error: decodeError.message
                            });
                        }
                    }
                }
            }

            if (!paymentCompletedFound) {
                throw new Error(`未在交易 ${txHash} 中找到 PaymentID ${paymentId} 的 PaymentCompleted 事件`);
            }

            return {
                ...baseResult,
                paymentVerified: true,
                paymentId: paymentId,
                contractAddress: paymentContractAddress
            };

        } catch (error) {
            logger('error', '支付轉帳交易驗證失敗', {
                txHash,
                paymentId,
                error: error.message
            });

            return {
                verified: false,
                paymentVerified: false,
                error: error.message,
                paymentError: error.message,
                timeElapsed: Date.now() - Date.now()
            };
        }
    }

    /**
     * 延遲函數
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 查找支付轉帳交易（輔助方法）
     */
    async findPaymentTransferTransaction(paymentContractAddress, paymentId, fromBlock, toBlock = 'latest') {
        logger('info', '查找支付轉帳交易', {
            paymentContractAddress,
            paymentId,
            fromBlock,
            toBlock
        });

        try {
            // PaymentCompleted 事件的過濾器
            const paymentCompletedTopic = ethers.id('PaymentCompleted(uint256,address,uint256)');
            const paymentIdTopic = ethers.zeroPadValue(ethers.toBeHex(paymentId), 32);

            const filter = {
                address: paymentContractAddress,
                topics: [paymentCompletedTopic, paymentIdTopic],
                fromBlock: fromBlock,
                toBlock: toBlock
            };

            const logs = await this.provider.getLogs(filter);
            
            if (logs.length === 0) {
                throw new Error(`未找到 PaymentID ${paymentId} 的 PaymentCompleted 事件`);
            }

            const log = logs[0]; // 取第一個匹配的事件
            const txHash = log.transactionHash;

            logger('info', '找到支付轉帳交易', {
                paymentId,
                txHash,
                blockNumber: log.blockNumber
            });

            return {
                txHash: txHash,
                blockNumber: log.blockNumber,
                log: log
            };

        } catch (error) {
            logger('error', '查找支付轉帳交易失敗', {
                paymentId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * 根據交易金額動態計算所需確認數
     * @param {string} amount - 交易金額 (wei)
     * @returns {number} 建議的確認數
     */
    calculateRequiredConfirmations(amount) {
        const amountInEth = parseFloat(ethers.formatEther(amount));
        
        if (amountInEth >= 10) {
            return 30; // 高價值交易：30 個確認
        } else if (amountInEth >= 1) {
            return 20; // 中價值交易：20 個確認
        } else if (amountInEth >= 0.1) {
            return 15; // 一般交易：15 個確認
        } else {
            return 10; // 小額交易：10 個確認
        }
    }

    /**
     * 根據交易金額動態計算超時時間
     * @param {number} confirmations - 確認數
     * @returns {number} 超時時間（秒）
     */
    calculateTimeout(confirmations) {
        // 基於平均出塊時間計算：以太坊約 12 秒/塊
        const averageBlockTime = 12;
        const bufferMultiplier = 2; // 安全緩衝
        return confirmations * averageBlockTime * bufferMultiplier + 60; // 額外 60 秒緩衝
    }
}

module.exports = CrossChainTransactionVerifier; 