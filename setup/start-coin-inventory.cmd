@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-coin-inventory.ps1"
if errorlevel 1 (
    echo.
    echo Coin Inventory launcher exited with an error.
    pause
    exit /b 1
)
