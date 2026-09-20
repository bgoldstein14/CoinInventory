@echo off
REM ===================================================================
REM  Coin Inventory - double-click this file to start the application.
REM
REM  In Windows Explorer this may appear as just "launch-coin-inventory"
REM  (without the .cmd) because Explorer hides known file extensions by
REM  default. Look for the file with the gear / cog icon.
REM
REM  This forwards to start-coin-inventory.ps1 in this same folder,
REM  which is the real launcher: it checks Node, starts the backend and
REM  the web app, waits until BOTH are ready, then opens the browser.
REM ===================================================================
setlocal

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%start-coin-inventory.ps1"

REM Keep the window open if the launcher failed, so the error is readable.
REM The previous version ended with an unconditional "exit /b 0", which
REM closed the window instantly on failure and left no way to see why.
if errorlevel 1 (
    echo.
    echo Coin Inventory exited with an error ^(code %errorlevel%^).
    echo Check server\logs\app.log for details.
    echo.
    pause
    exit /b %errorlevel%
)

exit /b 0
