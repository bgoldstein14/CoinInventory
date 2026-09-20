<#
    Coin Inventory launcher.

    Starts the backend (Express on port 3000) and the Angular dev server
    (port 4200) via "npm start", waits until BOTH are genuinely ready, then
    opens Edge. When the browser window closes, the npm process tree is
    stopped.

    Why the "wait for both" matters:
    The Angular app calls InventoryService.hydrate() exactly once, at startup.
    If the browser opens before the API on port 3000 is accepting requests,
    that single hydration attempt fails and the app shows
    "Cannot connect to database" even though the backend comes up a second
    later. The previous version of this script only polled port 4200 (the
    Angular dev server), which is usually -- but not always -- slower to
    start than the API. That race is why startup "usually works but
    occasionally fails".
#>

$ErrorActionPreference = 'Stop'

$appDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$lockFile  = Join-Path $appDir '.coin-inventory.lock'
$runScript = Join-Path $appDir 'run-coin-inventory.ps1'

$appUrl    = 'http://localhost:4200'
$healthUrl = 'http://localhost:3000/api/health'

# How long to wait for the two servers before giving up.
$startupTimeoutSeconds = 180

# ------------------------------------------------------------------
# Single-instance check
# ------------------------------------------------------------------
# The lock file holds the PID of the launcher. If that process is still
# alive we assume the app is already running. A stale lock (left behind by
# a crash or a hard kill) is simply removed.
if (Test-Path $lockFile) {
    $existingPid = $null
    try {
        $existingPid = [int]((Get-Content -Path $lockFile -TotalCount 1).Trim())
    }
    catch {
        $existingPid = $null
    }

    if ($existingPid -and $existingPid -ne $PID -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
        Write-Host 'Coin Inventory is already running.'
        exit 0
    }

    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}

Set-Content -Path $lockFile -Value $PID -Encoding ascii

# ------------------------------------------------------------------
# Prerequisites
# ------------------------------------------------------------------
# Node must be on PATH. If it is missing we offer the bundled installer.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'Node.js is not installed. Launching installer...'
    $installer = Join-Path $appDir 'setup\install-node.ps1'
    if (Test-Path $installer) { & $installer }

    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
        Write-Host 'Node.js is still unavailable. Install it from https://nodejs.org/ and try again.' -ForegroundColor Red
        Start-Sleep -Seconds 10
        exit 1
    }
}

# Install dependencies ONLY when they are actually missing.
#
# The previous launcher in setup\ ran "npm install" on every single start.
# Against the I: network share that is slow, and any transient npm or
# network hiccup aborted the whole launch -- a significant cause of
# "it usually starts but sometimes doesn't". Dependencies do not change
# between runs, so check instead of reinstalling.
foreach ($target in @(@{ Dir = $appDir; Label = 'app' }, @{ Dir = (Join-Path $appDir 'server'); Label = 'server' })) {
    $modulesPath = Join-Path $target.Dir 'node_modules'
    if (-not (Test-Path $modulesPath)) {
        Write-Host "Installing $($target.Label) dependencies (first run only)..."
        Push-Location $target.Dir
        try {
            npm install
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed in $($target.Dir) with exit code $LASTEXITCODE."
            }
        }
        finally {
            Pop-Location
        }
    }
}

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

# Returns $true when the URL responds with HTTP 200.
# Used for the Angular dev server, which just needs to serve index.html.
function Test-HttpOk {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return ($response.StatusCode -eq 200)
    }
    catch {
        return $false
    }
}

# Returns $true only when /api/health reports the DATABASE is connected.
#
# We deliberately check the response body, not just the status code. The
# Express server has an Angular SPA catch-all route ("app.get('*')") that
# returns index.html with a 200 for any unmatched GET. Without a body check
# a missing /api/health endpoint would look "healthy" and we would open the
# browser too early -- exactly the bug this script is meant to prevent.
function Test-ApiHealthy {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        if ($response.StatusCode -ne 200) { return $false }

        $payload = $response.Content | ConvertFrom-Json
        return ($payload.status -eq 'ok' -and $payload.database -eq 'connected')
    }
    catch {
        # A 503 from the health endpoint (database down) also lands here,
        # which is what we want: keep waiting rather than opening the app.
        return $false
    }
}

function Find-EdgePath {
    foreach ($candidate in @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Stop-ProcessTree {
    param($Process)

    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            & taskkill /T /F /PID $Process.Id 2>&1 | Out-Null
        }
    }
    catch {
        # Best effort only -- never let cleanup failures surface as errors.
    }
}

# ------------------------------------------------------------------
# Start the servers and wait for them
# ------------------------------------------------------------------
$npmProcess  = $null
$edgeProcess = $null

try {
    Write-Host 'Starting Coin Inventory...'

    $npmProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $runScript
    ) -WorkingDirectory $appDir -PassThru

    $deadline    = (Get-Date).AddSeconds($startupTimeoutSeconds)
    $apiReady    = $false
    $appReady    = $false
    $lastMessage = ''

    while ((Get-Date) -lt $deadline) {
        # If npm died, there is no point continuing to poll.
        if ($npmProcess.HasExited) {
            throw "The server process exited unexpectedly (exit code $($npmProcess.ExitCode)). Run 'npm start' in $appDir to see the error."
        }

        if (-not $apiReady) { $apiReady = Test-ApiHealthy -Url $healthUrl }
        if (-not $appReady) { $appReady = Test-HttpOk     -Url $appUrl }

        if ($apiReady -and $appReady) { break }

        # Give the user some feedback about what we are still waiting for,
        # but only print when the state actually changes.
        $waitingFor = @()
        if (-not $apiReady) { $waitingFor += 'database API (port 3000)' }
        if (-not $appReady) { $waitingFor += 'web app (port 4200)' }
        $message = 'Waiting for ' + ($waitingFor -join ' and ') + '...'
        if ($message -ne $lastMessage) {
            Write-Host $message
            $lastMessage = $message
        }

        Start-Sleep -Seconds 1
    }

    if (-not ($apiReady -and $appReady)) {
        $notReady = @()
        if (-not $apiReady) { $notReady += 'the database API on port 3000' }
        if (-not $appReady) { $notReady += 'the web app on port 4200' }
        throw ("Timed out after $startupTimeoutSeconds seconds waiting for " + ($notReady -join ' and ') + ". The browser was not opened. Check server\logs\app.log, and confirm SQL Server is running.")
    }

    Write-Host 'Both servers are ready. Opening browser...'

    # ------------------------------------------------------------------
    # Open the browser
    # ------------------------------------------------------------------
    # We use the user's NORMAL Edge profile on purpose. The app stores its
    # UI preferences (visible columns, app settings) in the browser's
    # IndexedDB, so launching with a separate --user-data-dir would present
    # a blank profile and silently reset those preferences every time.
    # (Coin data itself lives in SQL Server and is unaffected either way.)
    #
    # The catch: if Edge is ALREADY running, the msedge.exe we launch just
    # hands the URL to the existing Edge instance and exits immediately.
    # Wait-Process would then return within a second and the "finally"
    # block below would kill the servers right after starting them.
    #
    # So we launch normally, then check whether our process survived. If it
    # exited straight away we know Edge took over, and we wait on the
    # server process instead of the browser.
    $edgePath = Find-EdgePath

    if ($edgePath) {
        $edgeProcess = Start-Process -FilePath $edgePath -ArgumentList @(
            '--new-window',
            $appUrl
        ) -PassThru
    }
    else {
        # No Edge installed -- fall back to whatever the default browser is.
        Write-Host 'Microsoft Edge not found; opening the default browser.'
        Start-Process $appUrl | Out-Null
        $edgeProcess = $null
    }

    # Give a launched browser a moment to either stick around (it owns the
    # window) or exit (it handed off to an already-running instance).
    if ($edgeProcess) {
        Start-Sleep -Seconds 3
        if ($edgeProcess.HasExited) {
            $edgeProcess = $null
        }
    }

    if ($edgeProcess) {
        Write-Host 'Coin Inventory is running. Close the browser window to shut it down.'
        Wait-Process -Id $edgeProcess.Id
    }
    else {
        # Either Edge handed off to an existing window, or we used the
        # default browser. Neither gives us a process whose lifetime tracks
        # the app, so tie the app's lifetime to this console window instead.
        Write-Host ''
        Write-Host 'Coin Inventory is running.'
        Write-Host 'Close THIS window (or press Ctrl+C) to shut the servers down.'
        Write-Host ''
        Wait-Process -Id $npmProcess.Id
    }
}
catch {
    Write-Host ''
    Write-Host "Coin Inventory failed to start: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    # Keep the window up long enough for the user to read the message when
    # launched by double-clicking the .cmd file.
    Start-Sleep -Seconds 10
}
finally {
    Stop-ProcessTree -Process $npmProcess
    Remove-Item -Path $lockFile -Force -ErrorAction SilentlyContinue
}

exit 0
