$ErrorActionPreference = "Stop"
$port = if ($env:PORT) { [int]$env:PORT } else { 4317 }

$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $connections) {
    Write-Output "Gmail Control is not running on port $port."
    exit 0
}

$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $pids) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Write-Output "Gmail Control stopped."
