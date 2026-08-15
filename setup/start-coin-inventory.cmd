@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "APP_DIR=%SCRIPT_DIR%.."

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found on this machine.
    echo Please install Node.js LTS from https://nodejs.org/
    echo or run: powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-node.ps1"
    echo.
    pause
    exit /b 1
)

cd /d "%APP_DIR%"
call npm install
if errorlevel 1 (
    echo.
    echo Dependency install failed.
    pause
    exit /b 1
)

call npm start -- --host 0.0.0.0
if errorlevel 1 (
    echo.
    echo The app closed with an error.
    pause
    exit /b 1
)
