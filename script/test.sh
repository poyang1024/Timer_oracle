#!/bin/bash

# 切換到專案根目錄
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
echo "當前工作目錄: $PWD"

# 檢查 Node.js 和 npm
echo "檢查 Node.js 和 npm..."
echo "Node.js 版本: $(node --version)"
echo "npm 版本: $(npm --version)"

# 檢查並安裝依賴
echo "檢查依賴..."
if [ ! -d "node_modules" ] || [ ! -f "package.json" ]; then
    echo "安裝依賴..."
    npm install ethers dotenv chalk express
else
    echo "依賴已存在，跳過安裝"
fi

# 檢查環境配置
if [ ! -f .env ]; then
    echo "未找到.env檔案"
    exit 1
fi

# 載入環境變數
echo "檢查合約地址配置..."
source .env
if [ -z "$ASSET_CONTRACT_ADDRESS" ]; then
    echo "警告: Asset合約地址似乎未設置"
else
    echo "Asset合約地址: $ASSET_CONTRACT_ADDRESS"
fi

if [ -z "$PAYMENT_CONTRACT_ADDRESS" ]; then
    echo "警告: Payment合約地址似乎未設置"
else
    echo "Payment合約地址: $PAYMENT_CONTRACT_ADDRESS"
fi

# 選擇測試
echo ""
echo "請選擇要運行的測試類型:"
echo "1) 單一交易測試"
echo "2) 壓力測試"
echo "3) 啟動監聽服務器"
echo "4) 退出"
read -p "請輸入選項 [1-4]: " choice

case $choice in
    1)
        echo "運行單一交易測試..."
        node backend/test/autoTest.js
        ;;
    2)
        echo "運行壓力測試..."
        node backend/test/stressTest.js
        ;;
    3)
        echo "啟動監聽服務器..."
        node backend/server.js
        ;;
    4)
        echo "退出"
        exit 0
        ;;
    *)
        echo "無效選項"
        exit 1
        ;;
esac