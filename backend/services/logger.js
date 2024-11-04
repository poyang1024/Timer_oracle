const chalk = require('chalk');

function safeStringify(obj) {
    return JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint'
            ? value.toString()
            : value
    );
}

function logger(level, message, data = null) {
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

    let logMessage = `${chalk.gray(timestamp)} ${logColor.bold(`[${level.toUpperCase()}]`)} ${logColor(message)}`;
    
    if (data) {
        if (typeof data === 'object' && data !== null) {
            const dataString = Object.entries(data)
                .map(([key, value]) => `${chalk.cyan(key)}: ${chalk.green(safeStringify(value))}`)
                .join('\n  ');
            logMessage += `\n  ${dataString}`;
        } else {
            logMessage += `\n  ${chalk.green(safeStringify(data))}`;
        }
    }

    console.log(logMessage);
}

module.exports = logger;