@echo off
chcp 65001 >nul 2>&1
title Build EXE - Lên Đơn Hàng
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Build EXE - Ứng dụng Lên Đơn Hàng    ║
echo  ╚══════════════════════════════════════════╝
echo.

cd /d "%~dp0"

echo [1/3] Kiểm tra source files...
node validate-build.js pre
if errorlevel 1 (
    echo.
    echo [LỖI] Source validation failed! Không thể build.
    pause
    exit /b 1
)

echo [2/3] Đang build EXE...
call npx electron-builder --win
if errorlevel 1 (
    echo.
    echo [LỖI] Build thất bại!
    pause
    exit /b 1
)

echo [3/3] Kiểm tra output...
node validate-build.js post
if errorlevel 1 (
    echo.
    echo [LỖI] Output validation failed!
    pause
    exit /b 1
)

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║  ✅ BUILD THÀNH CÔNG!                    ║
echo  ║  File EXE tại: Ứng dụng Lên Đơn Hàng\  ║
echo  ╚══════════════════════════════════════════╝
echo.
pause
