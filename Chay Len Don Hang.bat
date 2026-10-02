@echo off
chcp 65001 >nul 2>&1
title Lên Đơn Hàng - Order Automation
echo.
echo  ╔══════════════════════════════════════╗
echo  ║   Đang khởi động ứng dụng...        ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [LỖI] Node.js chưa được cài đặt!
    echo Vui lòng cài Node.js từ https://nodejs.org
    pause
    exit /b 1
)

:: Check node_modules
if not exist "node_modules\electron" (
    echo [INFO] Đang cài đặt dependencies lần đầu...
    call npm install
)

:: Launch app
echo [OK] Đang mở ứng dụng...
npx electron .

if errorlevel 1 (
    echo.
    echo [LỖI] Ứng dụng gặp lỗi khi khởi động!
    pause
)
