const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

class Logger {
    constructor() {
        this.logDir = path.join(__dirname, '..', 'logs');
        this.currentLogFile = null;
        this.initializeLogFile();
    }

    initializeLogFile() {
        // 確保 logs 目錄存在
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        // 生成日誌文件名（基於啟動時間）
        const now = new Date();
        const timestamp = now.toISOString()
            .replace(/:/g, '-')
            .replace(/\./g, '-')
            .replace('T', '_')
            .slice(0, 19);
        
        this.currentLogFile = path.join(this.logDir, `oracle_${timestamp}.log`);
        
        // 寫入啟動日誌
        const startupMessage = `\n${'='.repeat(80)}\nOracle Server Started at ${now.toISOString()}\nLog File: ${this.currentLogFile}\n${'='.repeat(80)}\n`;
        fs.writeFileSync(this.currentLogFile, startupMessage);
        
        console.log(chalk.green(`📝 日誌文件已創建: ${this.currentLogFile}`));
    }

    safeStringify(obj) {
        return JSON.stringify(obj, (key, value) =>
            typeof value === 'bigint'
                ? value.toString()
                : value
        );
    }

    writeToFile(logEntry) {
        try {
            fs.appendFileSync(this.currentLogFile, logEntry + '\n');
        } catch (error) {
            console.error(chalk.red('寫入日誌文件時發生錯誤:'), error.message);
        }
    }

    log(level, message, data = null) {
        const timestamp = new Date().toISOString();
        let logColor;
        
        switch (level.toLowerCase()) {
            case 'error':
                logColor = chalk.red;
                break;
            case 'warn':
                logColor = chalk.yellow;
                break;
            case 'info':
                logColor = chalk.blue;
                break;
            case 'debug':
                logColor = chalk.gray;
                break;
            default:
                logColor = chalk.white;
        }

        let consoleMessage = `${chalk.gray(timestamp)} ${logColor.bold(`[${level.toUpperCase()}]`)} ${logColor(message)}`;
        let fileMessage = `${timestamp} [${level.toUpperCase()}] ${message}`;
        
        if (data) {
            if (typeof data === 'object' && data !== null) {
                const dataString = Object.entries(data)
                    .map(([key, value]) => `${key}: ${this.safeStringify(value)}`)
                    .join(', ');
                
                consoleMessage += `\n  ${chalk.cyan(dataString)}`;
                fileMessage += ` | ${dataString}`;
            } else {
                const dataStr = this.safeStringify(data);
                consoleMessage += `\n  ${chalk.green(dataStr)}`;
                fileMessage += ` | ${dataStr}`;
            }
        }

        // 輸出到控制台
        console.log(consoleMessage);
        
        // 寫入文件
        this.writeToFile(fileMessage);
    }

    // 便捷方法
    info(message, data) {
        this.log('info', message, data);
    }

    warn(message, data) {
        this.log('warn', message, data);
    }

    error(message, data) {
        this.log('error', message, data);
    }

    debug(message, data) {
        this.log('debug', message, data);
    }

    // 清理舊日誌文件（保留最近 N 天的日誌）
    cleanOldLogs(daysToKeep = 7) {
        try {
            const files = fs.readdirSync(this.logDir);
            const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
            
            files.forEach(file => {
                if (file.startsWith('oracle_') && file.endsWith('.log')) {
                    const filePath = path.join(this.logDir, file);
                    const stats = fs.statSync(filePath);
                    
                    if (stats.mtime.getTime() < cutoffTime) {
                        fs.unlinkSync(filePath);
                        this.log('info', `已刪除舊日誌文件: ${file}`);
                    }
                }
            });
        } catch (error) {
            this.log('error', '清理舊日誌文件時發生錯誤', { error: error.message });
        }
    }

    // 獲取當前日誌文件路徑
    getCurrentLogFile() {
        return this.currentLogFile;
    }

    // 優雅關閉
    close() {
        const shutdownMessage = `\n${'='.repeat(80)}\nOracle Server Shutdown at ${new Date().toISOString()}\n${'='.repeat(80)}\n`;
        this.writeToFile(shutdownMessage);
    }
}

// 創建全局 logger 實例
const logger = new Logger();

// 在啟動時清理舊日誌
logger.cleanOldLogs(7); // 保留 7 天的日誌

// 導出 logger 函數（保持向後兼容）
function loggerFunction(level, message, data) {
    logger.log(level, message, data);
}

// 添加 logger 實例的屬性到函數上
loggerFunction.instance = logger;
loggerFunction.info = (message, data) => logger.info(message, data);
loggerFunction.warn = (message, data) => logger.warn(message, data);
loggerFunction.error = (message, data) => logger.error(message, data);
loggerFunction.debug = (message, data) => logger.debug(message, data);
loggerFunction.getCurrentLogFile = () => logger.getCurrentLogFile();
loggerFunction.close = () => logger.close();

module.exports = loggerFunction;
