$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 4317 }

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "Gmail Control is already listening on port $port."
    exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$dataDir = Join-Path $root "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$out = Join-Path $dataDir "server.out.log"
$err = Join-Path $dataDir "server.err.log"

$process = Start-Process -FilePath $node -ArgumentList "src/server.mjs" -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 100
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Write-Output "Gmail Control started on http://127.0.0.1:$port (PID $($process.Id))."
        exit 0
    }
}

Write-Error "Gmail Control did not start. Check $err"
exit 1
