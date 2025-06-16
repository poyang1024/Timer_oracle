#!/usr/bin/env node

/**
 * 🔧 跨鏈原子交換超時測試套件
 * 
 * 這個腳本專門用於測試各種超時場景，符合流程圖的完整超時處理邏輯
 * 
 * 使用方法:
 * node run_timeout_tests.js [test_name]
 * 
 * 可用測試:
 * - all: 運行所有超時測試
 * - basic: 基本超時退款測試
 * - confirmation: 確認階段超時測試
 * - execution: 執行階段超時測試
 * - timesync: 跨鏈時間同步測試
 */

const {
    testTimeoutRefund,
    testConfirmationTimeout,
    testExecutionTimeout,
    testCrossChainTimeSync,
    checkCurrentBalances,
    checkSystemHealth
} = require('./autoTest.js');

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

// 超時測試結果
let timeoutTestResults = {
    basic: false,
    confirmation: false,
    execution: false,
    timesync: false
};

// 運行所有超時測試
async function runAllTimeoutTests() {
    colorLog('bright', '🔧 開始運行完整超時測試套件...');
    colorLog('bright', '測試開始時間: ' + new Date().toLocaleString());
    
    const startTime = Date.now();
    
    try {
        // 系統健康檢查
        colorLog('cyan', '\n🔍 執行系統健康檢查...');
        const systemHealthy = await checkSystemHealth();
        if (!systemHealthy) {
            colorLog('red', '❌ 系統健康檢查失敗，停止測試');
            return false;
        }
        
        // 檢查初始餘額
        colorLog('cyan', '\n💰 檢查初始帳戶餘額...');
        await checkCurrentBalances();
        
        colorLog('bright', '\n🚀 開始執行超時測試序列...');
        
        // 測試1: 基本超時退款
        colorLog('yellow', '\n📋 執行測試序列 1/4...');
        timeoutTestResults.basic = await testTimeoutRefund();
        await delay(15000); // 測試間隔
        
        // 測試2: 確認階段超時
        colorLog('yellow', '\n📋 執行測試序列 2/4...');
        timeoutTestResults.confirmation = await testConfirmationTimeout();
        await delay(15000);
        
        // 測試3: 執行階段超時
        colorLog('yellow', '\n📋 執行測試序列 3/4...');
        timeoutTestResults.execution = await testExecutionTimeout();
        await delay(15000);
        
        // 測試4: 跨鏈時間同步
        colorLog('yellow', '\n📋 執行測試序列 4/4...');
        timeoutTestResults.timesync = await testCrossChainTimeSync();
        
        // 生成報告
        const endTime = Date.now();
        const duration = Math.round((endTime - startTime) / 1000);
        
        generateTimeoutTestReport(duration);
        
        // 檢查最終餘額
        colorLog('cyan', '\n💰 檢查最終帳戶餘額...');
        await checkCurrentBalances();
        
        const allPassed = Object.values(timeoutTestResults).every(result => result);
        return allPassed;
        
    } catch (error) {
        colorLog('red', '❌ 超時測試套件執行失敗: ' + error.message);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 運行單一超時測試
async function runSingleTimeoutTest(testName) {
    colorLog('bright', `🧪 運行單一超時測試: ${testName}`);
    colorLog('bright', '測試開始時間: ' + new Date().toLocaleString());
    
    const startTime = Date.now();
    let result = false;
    
    try {
        // 系統健康檢查
        const systemHealthy = await checkSystemHealth();
        if (!systemHealthy) {
            colorLog('red', '❌ 系統健康檢查失敗，停止測試');
            return false;
        }
        
        switch (testName.toLowerCase()) {
            case 'basic':
            case 'timeout':
                result = await testTimeoutRefund();
                break;
            case 'confirmation':
            case 'confirm':
                result = await testConfirmationTimeout();
                break;
            case 'execution':
            case 'exec':
                result = await testExecutionTimeout();
                break;
            case 'timesync':
            case 'sync':
                result = await testCrossChainTimeSync();
                break;
            case 'balance':
                result = await checkCurrentBalances();
                break;
            default:
                colorLog('red', `未知的測試名稱: ${testName}`);
                showUsage();
                return false;
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
        
        return result;
        
    } catch (error) {
        colorLog('red', `測試 "${testName}" 執行失敗: ${error.message}`);
        console.error('詳細錯誤:', error);
        return false;
    }
}

// 生成超時測試報告
function generateTimeoutTestReport(duration) {
    colorLog('bright', '\n' + '='.repeat(80));
    colorLog('bright', '🔧 超時測試套件結果報告');
    colorLog('bright', '='.repeat(80));

    const totalTests = Object.keys(timeoutTestResults).length;
    const passedTests = Object.values(timeoutTestResults).filter(result => result).length;
    const failedTests = totalTests - passedTests;

    colorLog('cyan', '\n📊 測試摘要:');
    console.log(`  總測試數: ${totalTests}`);
    console.log(`  通過測試: ${passedTests}`);
    console.log(`  失敗測試: ${failedTests}`);
    console.log(`  通過率: ${Math.round((passedTests / totalTests) * 100)}%`);
    console.log(`  總執行時間: ${duration} 秒`);

    colorLog('cyan', '\n📋 詳細結果:');
    console.log(`  基本超時退款: ${timeoutTestResults.basic ? '✓ 通過' : '✗ 失敗'}`);
    console.log(`  確認階段超時: ${timeoutTestResults.confirmation ? '✓ 通過' : '✗ 失敗'}`);
    console.log(`  執行階段超時: ${timeoutTestResults.execution ? '✓ 通過' : '✗ 失敗'}`);
    console.log(`  跨鏈時間同步: ${timeoutTestResults.timesync ? '✓ 通過' : '✗ 失敗'}`);

    // 流程圖對應分析
    colorLog('cyan', '\n🔄 流程圖對應分析:');
    if (timeoutTestResults.basic) {
        colorLog('green', '  ✓ Timeout 1 (創建階段) - 正確處理');
    } else {
        colorLog('red', '  ✗ Timeout 1 (創建階段) - 需要改進');
    }
    
    if (timeoutTestResults.confirmation) {
        colorLog('green', '  ✓ 部分確認超時 - 正確回滾');
    } else {
        colorLog('red', '  ✗ 部分確認超時 - 回滾機制需要改進');
    }
    
    if (timeoutTestResults.execution) {
        colorLog('green', '  ✓ Timeout 2 (執行階段) - 防止資金鎖定');
    } else {
        colorLog('red', '  ✗ Timeout 2 (執行階段) - 存在資金鎖定風險');
    }
    
    if (timeoutTestResults.timesync) {
        colorLog('green', '  ✓ 跨鏈時間同步 - 風險檢測正常');
    } else {
        colorLog('red', '  ✗ 跨鏈時間同步 - 需要加強檢測機制');
    }

    if (passedTests === totalTests) {
        colorLog('green', '\n🎉 所有超時測試通過！系統超時處理機制完善。');
    } else {
        colorLog('yellow', '\n⚠️ 部分超時測試失敗，請檢查Oracle超時處理邏輯。');
    }

    // 改進建議
    colorLog('cyan', '\n🔧 系統改進建議:');
    if (!timeoutTestResults.basic) {
        console.log('  📋 基本超時處理:');
        console.log('    - 檢查Oracle的checkAndHandleExpiredTrades函數');
        console.log('    - 確認30秒檢查間隔是否合適');
        console.log('    - 驗證handleFailedConfirmation調用');
    }
    if (!timeoutTestResults.confirmation) {
        console.log('  🔄 確認階段超時:');
        console.log('    - 實現部分確認狀態的回滾機制');
        console.log('    - 加強跨鏈狀態一致性檢查');
        console.log('    - 優化確認階段的超時檢測');
    }
    if (!timeoutTestResults.execution) {
        console.log('  ⚡ 執行階段超時:');
        console.log('    - 防止資金永久鎖定的機制');
        console.log('    - 實現執行階段的強制退款');
        console.log('    - 加強密鑰揭示超時處理');
    }
    if (!timeoutTestResults.timesync) {
        console.log('  🕐 跨鏈時間同步:');
        console.log('    - 實現跨鏈時間差檢測');
        console.log('    - 設置合理的時間容忍度');
        console.log('    - 加強Oracle時間同步邏輯');
    }

    console.log('\n' + '='.repeat(80));
}

// 顯示使用說明
function showUsage() {
    colorLog('cyan', '\n📖 使用說明:');
    console.log('  node run_timeout_tests.js [test_name]');
    console.log('');
    colorLog('yellow', '可用測試:');
    console.log('  all - 運行所有超時測試');
    console.log('  basic - 基本超時退款測試');
    console.log('  confirmation - 確認階段超時測試');
    console.log('  execution - 執行階段超時測試');
    console.log('  timesync - 跨鏈時間同步測試');
    console.log('  balance - 檢查當前餘額');
    console.log('');
    colorLog('cyan', '範例:');
    console.log('  node run_timeout_tests.js all');
    console.log('  node run_timeout_tests.js basic');
    console.log('  node run_timeout_tests.js confirmation');
}

// 延遲函數
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    if (Object.keys(timeoutTestResults).length > 0) {
        generateTimeoutTestReport(0);
    }
    process.exit(1);
});

// 主執行邏輯
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args[0] === 'all') {
        // 運行所有超時測試
        runAllTimeoutTests().then(success => {
            process.exit(success ? 0 : 1);
        }).catch(error => {
            colorLog('red', `超時測試套件啟動失敗: ${error.message}`);
            console.error(error);
            process.exit(1);
        });
    } else if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        showUsage();
        process.exit(0);
    } else {
        // 運行單一測試
        const testName = args[0];
        runSingleTimeoutTest(testName).then(success => {
            process.exit(success ? 0 : 1);
        }).catch(error => {
            colorLog('red', `測試啟動失敗: ${error.message}`);
            console.error(error);
            process.exit(1);
        });
    }
}

module.exports = {
    runAllTimeoutTests,
    runSingleTimeoutTest,
    generateTimeoutTestReport,
    timeoutTestResults
}; 
