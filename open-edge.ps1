$uri = 'http://localhost:4200'
$edgePaths = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)

$edgePath = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

$alreadyRunning = $false
try {
    $existing = Get-Process -Name msedge -ErrorAction Stop
    if ($existing) { $alreadyRunning = $true }
}
catch {
    $alreadyRunning = $false
}

if ($alreadyRunning) {
    exit 0
}

$opened = $false
for ($i = 0; $i -lt 90; $i++) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec 2 | Out-Null
        if ($edgePath) {
            Start-Process -FilePath $edgePath -ArgumentList $uri
        }
        else {
            Start-Process $uri
        }

        $opened = $true
        break
    }
    catch {
        Start-Sleep -Seconds 1
    }
}

if (-not $opened) {
    if ($edgePath) {
        Start-Process -FilePath $edgePath -ArgumentList $uri
    }
    else {
        Start-Process $uri
    }
}
