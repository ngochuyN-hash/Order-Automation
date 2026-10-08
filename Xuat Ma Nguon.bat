@echo off
chcp 65001 >nul 2>&1
title Xuat Ma Nguon Ban Giao - Lên Đơn Hàng
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   XUẤT MÃ NGUỒN BÀN GIAO - Lên Đơn Hàng    ║
echo  ╚══════════════════════════════════════════════╝
echo.

cd /d "%~dp0"

node scripts/package-source.js
if errorlevel 1 (
    echo.
    echo [LỖI] Xuất mã nguồn thất bại!
    pause
    exit /b 1
)

echo.
echo  Zip nằm trong folder: Mã nguồn bàn giao\
echo.
pause
