$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lockFile = Join-Path $appDir '.coin-inventory.lock'

try {
    Set-Location $appDir
    npm start
}
finally {
    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}
