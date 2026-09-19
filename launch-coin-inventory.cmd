@echo off
setlocal

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%start-coin-inventory.ps1"
exit /b 0
