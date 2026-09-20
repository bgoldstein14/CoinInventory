<#
    Compatibility shim.

    The real launcher is start-coin-inventory.ps1 in the PROJECT ROOT. This
    file used to be a second, independent implementation, and the two drifted
    apart -- they had different readiness probes, different lock files (this
    one used %TEMP%, the root one uses the project directory) and different
    shutdown logic. Because the lock files differed, launching via this script
    and via the root launch-coin-inventory.cmd at the same time started two
    copies of the servers that then fought over ports 3000 and 4200.

    Rather than maintain two launchers, this now simply forwards to the root
    one, so `setup\start-coin-inventory.cmd` keeps working.

    Three behaviours of the old version were deliberately NOT carried over:

      * "npm install" on every launch. Dependencies do not change between
        runs, and on a network share this was slow and turned any transient
        npm failure into a failed startup. The root launcher installs only
        when node_modules is actually missing.

      * A cleanup routine that killed any process whose command line
        contained the app directory AND the substring 'server'. That is
        broad enough to terminate an editor, a terminal, or another tool
        that merely had the project path open.

      * Guessing the browser process by enumerating msedge.exe and taking
        the newest one. Edge spawns renderer and GPU child processes, so
        this could latch onto a short-lived helper and shut the app down
        moments after it started.
#>

$ErrorActionPreference = 'Stop'

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootScript = Join-Path (Resolve-Path (Join-Path $scriptDir '..')).Path 'start-coin-inventory.ps1'

if (-not (Test-Path $rootScript)) {
    Write-Host "Cannot find the main launcher at $rootScript" -ForegroundColor Red
    exit 1
}

& $rootScript
exit $LASTEXITCODE
