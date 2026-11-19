<#
    Runs the Coin Inventory servers (Express API + Angular dev server).

    Started as a child process by start-coin-inventory.ps1 in this folder;
    runs "npm start" in the project directory. Not an entry point.

    Must not touch .coin-inventory.lock. The launcher owns it: removing it
    here, while the launcher is still running, would let a second launch
    start a duplicate set of servers on ports 3000 and 4200.
#>

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $appDir
npm start
