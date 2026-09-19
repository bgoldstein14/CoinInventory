$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lockFile = Join-Path $appDir '.coin-inventory.lock'
$runScript = Join-Path $appDir 'run-coin-inventory.ps1'

if (Test-Path $lockFile) {
    $existingPid = $null
    try {
        $existingPid = [int]((Get-Content -Path $lockFile -TotalCount 1).Trim())
    }
    catch {
        $existingPid = $null
    }

    if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Host 'Coin Inventory is already running.'
        exit 0
    }

    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}

Set-Content -Path $lockFile -Value $PID
Write-Host 'Starting Coin Inventory...'

try {
    $npmProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runScript,
        '-WorkingDirectory', $appDir
    ) -WorkingDirectory $appDir -PassThru

    $uri = 'http://localhost:4200'
    $edgePath = $null
    foreach ($candidate in @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )) {
        if (Test-Path $candidate) {
            $edgePath = $candidate
            break
        }
    }

    $edgeProcess = $null
    for ($i = 0; $i -lt 120; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 2 | Out-Null
            if ($edgePath) {
                $edgeProcess = Start-Process -FilePath $edgePath -ArgumentList $uri -PassThru
            }
            else {
                $edgeProcess = Start-Process $uri -PassThru
            }
            break
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }

    if (-not $edgeProcess) {
        if ($edgePath) {
            $edgeProcess = Start-Process -FilePath $edgePath -ArgumentList $uri -PassThru
        }
        else {
            $edgeProcess = Start-Process $uri -PassThru
        }
    }

    if ($edgeProcess) {
        try {
            Wait-Process -Id $edgeProcess.Id
        }
        finally {
            if (-not $npmProcess.HasExited) {
                & taskkill /T /F /PID $npmProcess.Id | Out-Null
            }
        }
    }
}
finally {
    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}

exit 0
