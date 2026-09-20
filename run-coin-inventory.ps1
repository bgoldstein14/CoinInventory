<#
    Runs the Coin Inventory servers (Express API + Angular dev server).

    This script is started by start-coin-inventory.ps1 and does nothing but
    invoke "npm start" in the project directory.

    Note: this script deliberately does NOT touch .coin-inventory.lock.
    The lock file belongs to the launcher (start-coin-inventory.ps1), which
    creates it and removes it in its own "finally" block. The previous
    version deleted the lock here too, which meant this child process could
    remove the launcher's lock while the launcher was still running -- so a
    second launch would think nothing was running and start a duplicate set
    of servers fighting over ports 3000 and 4200.
#>

$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Set-Location $appDir
npm start
