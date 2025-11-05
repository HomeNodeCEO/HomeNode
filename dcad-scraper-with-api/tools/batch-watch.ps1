param(
  [Parameter(Mandatory=$true)]
  [string]$CsvPath,
  [int]$DelaySec = 2,
  [string]$DatabaseUrl,
  [string]$Schema = 'core',
  [string]$PythonPath,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $CsvPath)) {
  Write-Error "CSV not found: $CsvPath"; exit 1
}

# Resolve repo root and default Python venv
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
if (-not $PythonPath) {
  $PythonPath = Join-Path $repoRoot '.venv\Scripts\python.exe'
  if (-not (Test-Path $PythonPath)) { $PythonPath = Join-Path $repoRoot 'venv\Scripts\python.exe' }
}
if (-not (Test-Path $PythonPath)) {
  Write-Error "Python venv not found. Set -PythonPath or create .venv."; exit 1
}

# Env vars
if ($DatabaseUrl) { $env:DATABASE_URL = $DatabaseUrl }
if (-not $env:DATABASE_URL) {
  Write-Warning "DATABASE_URL not set. Set -DatabaseUrl or export env var."
}
$env:DB_SCHEMA = $Schema
$env:PYTHONPATH = (Join-Path $repoRoot 'scraper')

# Build account list from CSV: collect any 17-digit tokens, unique, preserve order
$ids = @()
Get-Content -LiteralPath $CsvPath | ForEach-Object {
  $_ -split ',' | ForEach-Object {
    $t = $_.Trim(); if ($t -match '^[0-9]{17}$') { $ids += $t }
  }
}
$ids = $ids | Select-Object -Unique
$total = $ids.Count
if ($total -eq 0) { Write-Error "No 17-digit account IDs found in CSV: $CsvPath"; exit 1 }

if ($LogPath) {
  "[$(Get-Date -Format o)] Starting batch-watch for $total accounts from $CsvPath" | Out-File -FilePath $LogPath -Encoding utf8
}

Write-Host ("Scraping {0} accounts with {1}s delay..." -f $total, $DelaySec) -ForegroundColor Cyan

$started = Get-Date
for ($i = 0; $i -lt $total; $i++) {
  $acc = $ids[$i]
  $pct = [int](($i / [double]$total) * 100)
  Write-Progress -Activity "DCAD scrape & upsert" -Status ("[{0}/{1}] {2}" -f ($i+1), $total, $acc) -PercentComplete $pct

  $stamp = Get-Date -Format o
  $line = "[$stamp] [{0}/{1}] account_id={2}" -f ($i+1), $total, $acc
  Write-Host $line -ForegroundColor Yellow
  if ($LogPath) { $line | Out-File -FilePath $LogPath -Append -Encoding utf8 }

  try {
    & $PythonPath -m dcad.run_once $acc
    $ok = $LASTEXITCODE -eq 0
  } catch {
    $ok = $false
  }
  $stamp2 = Get-Date -Format o
  if ($ok) {
    $msg = "[$stamp2] Upsert complete for account_id=$acc"
    Write-Host $msg -ForegroundColor Green
    if ($LogPath) { $msg | Out-File -FilePath $LogPath -Append -Encoding utf8 }
  } else {
    $msg = "[$stamp2] ERROR for account_id=$acc (exit $LASTEXITCODE)"
    Write-Host $msg -ForegroundColor Red
    if ($LogPath) { $msg | Out-File -FilePath $LogPath -Append -Encoding utf8 }
  }

  if ($DelaySec -gt 0 -and $i -lt ($total-1)) { Start-Sleep -Seconds $DelaySec }
}

Write-Progress -Activity "DCAD scrape & upsert" -Completed
$elapsed = (Get-Date) - $started
Write-Host ("Done. {0} accounts in {1:mm\:ss}." -f $total, $elapsed) -ForegroundColor Green
if ($LogPath) { "[$(Get-Date -Format o)] Done." | Out-File -FilePath $LogPath -Append -Encoding utf8 }

