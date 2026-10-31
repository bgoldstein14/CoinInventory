$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Host 'Node.js is already installed.'
    return
}

Write-Host 'Node.js was not found. Attempting to install Node.js LTS via winget...'
winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'Node.js could not be installed automatically. Please install it manually from https://nodejs.org/'
    exit 1
}

Write-Host 'Node.js is installed. You can now run the app shortcut.'
