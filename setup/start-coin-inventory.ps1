$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'Node.js is not installed.'
    Write-Host 'Launching installer...'
    & "$PSScriptRoot\install-node.ps1"
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Error 'Node.js is still unavailable. Please install it manually from https://nodejs.org/'
        exit 1
    }
}

Set-Location $appDir
Write-Host 'Installing dependencies...'
npm install
Write-Host 'Starting Coin Inventory...'
npm start -- --host 0.0.0.0
