# =========================================================================
#  LAUNCHER for "Len don hang" (Order Automation) desktop app
# =========================================================================
#  Sets the ORDER_DIR environment variable to the orders data folder
#  (C:\Antigravity\Order Automation\I.DON HANG) and then launches the app so it can find
#  the Excel order files after installation.
#
#  NOTE: This script intentionally contains NO Vietnamese literals.
#  It discovers the data folder and the app .exe dynamically, so it works
#  no matter how this file is encoded on disk.
# =========================================================================

$ErrorActionPreference = 'Stop'
$root = 'C:\Antigravity\Order Automation'

# --- 1) Locate the orders data folder (the only top-level dir starting "I.") ---
$orderDir = Get-ChildItem -LiteralPath $root -Directory |
    Where-Object { $_.Name -like 'I.*' } |
    Select-Object -First 1 -ExpandProperty FullName

if (-not $orderDir) {
    Write-Host 'LOI: Khong tim thay thu muc du lieu don hang (I.*) trong C:\Antigravity\Order Automation' -ForegroundColor Red
    Read-Host 'Nhan Enter de thoat'
    exit 1
}

# --- 2) Export ORDER_DIR for child processes launched from this session ---
$env:ORDER_DIR = $orderDir
Write-Host ("ORDER_DIR = {0}" -f $orderDir) -ForegroundColor Green

# --- 3) Locate the application .exe ---------------------------------------
$exe = $null

# 3a) Prefer the INSTALLED copy (via Windows uninstall registry entries)
$uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($r in $uninstallRoots) {
    if (-not (Test-Path $r)) { continue }
    $entry = Get-ChildItem $r | ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object {
            $_.InstallLocation -and (Test-Path $_.InstallLocation) -and
            (
                $_.Publisher -eq 'Order Automation' -or
                (Test-Path (Join-Path $_.InstallLocation 'resources\app.asar'))
            )
        } | Select-Object -First 1
    if ($entry) {
        $cand = Get-ChildItem -LiteralPath $entry.InstallLocation -Filter *.exe -File |
            Where-Object { $_.Name -notlike 'Uninstall*' } |
            Sort-Object Length -Descending | Select-Object -First 1
        if ($cand) { $exe = $cand.FullName; break }
    }
}

# 3b) Fallback: the built "win-unpacked" copy inside C:\Antigravity\Order Automation
if (-not $exe) {
    $wuPath = Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {
        $p = Join-Path $_.FullName 'win-unpacked'
        if (Test-Path -LiteralPath $p) { $p }
    } | Select-Object -First 1
    if ($wuPath) {
        $cand = Get-ChildItem -LiteralPath $wuPath -Filter *.exe -File |
            Where-Object { $_.Name -notlike 'Uninstall*' } |
            Sort-Object Length -Descending | Select-Object -First 1
        if ($cand) { $exe = $cand.FullName }
    }
}

# --- 4) Launch (child process inherits ORDER_DIR) -------------------------
if (-not $exe) {
    Write-Host 'LOI: Khong tim thay ung dung "Len don hang".' -ForegroundColor Red
    Write-Host '     Hay cai dat truoc bang file "Len don hang Setup 1.0.0.exe",' -ForegroundColor Yellow
    Write-Host '     hoac giu thu muc "win-unpacked" trong C:\Antigravity\Order Automation.' -ForegroundColor Yellow
    Read-Host 'Nhan Enter de thoat'
    exit 1
}

Write-Host ("Dang mo: {0}" -f $exe) -ForegroundColor Cyan
Start-Process -FilePath $exe
