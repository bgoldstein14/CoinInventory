$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
$edgeUrl = 'http://localhost:4200'
$lockPath = Join-Path $env:TEMP 'coin-inventory-launch.lock'

function Stop-TrackedApp {
    $processes = Get-CimInstance Win32_Process |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.Contains($appDir) -and
            (
                $_.CommandLine.Contains('npm start') -or
                $_.CommandLine.Contains('ng serve') -or
                $_.CommandLine.Contains('tsx server.ts') -or
                $_.CommandLine.Contains('server')
            )
        }

    foreach ($process in $processes) {
        try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Host "Unable to stop process $($process.ProcessId): $($_.Exception.Message)"
        }
    }

    if (Test-Path $lockPath) {
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    }
}

try {
    if (Test-Path $lockPath) {
        $existingPid = Get-Content $lockPath -ErrorAction SilentlyContinue
        if ($existingPid) {
            $existing = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($existing) {
                Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host 'Node.js is not installed.'
        Write-Host 'Launching installer...'
        & (Join-Path $scriptDir 'install-node.ps1')
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
    $appProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList "/c cd /d `"$appDir`" && npm start -- --host 0.0.0.0" -PassThru -WindowStyle Minimized
    [System.IO.File]::WriteAllText($lockPath, $appProcess.Id)

    Write-Host "Opening Edge to $edgeUrl"
    $existingEdgeProcesses = @(Get-Process -Name msedge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    Start-Process "microsoft-edge:$edgeUrl"

    $browserProcess = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        $candidate = @(Get-Process -Name msedge -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $existingEdgeProcesses } | Sort-Object StartTime -Descending)
        if ($candidate.Count -gt 0) {
            $browserProcess = $candidate[0]
            break
        }
    }

    if ($null -ne $browserProcess) {
        while (-not $browserProcess.HasExited) {
            Start-Sleep -Seconds 2
            $browserProcess = Get-Process -Id $browserProcess.Id -ErrorAction SilentlyContinue
        }
    }

    Write-Host 'Browser closed. Stopping Coin Inventory...'
    Stop-TrackedApp
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    Stop-TrackedApp
    exit 1
}
