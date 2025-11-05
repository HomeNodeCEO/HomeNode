param(
  [Parameter(Mandatory=$true, Position=0)]
  [string]$Accounts,
  [string]$PythonPath,
  [string]$DatabaseUrl,
  [string]$Schema = "core"
)

$ErrorActionPreference = 'Stop'

# Resolve repo root and Python
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $PythonPath) {
  $PythonPath = Join-Path $repoRoot '.venv\Scripts\python.exe'
  if (-not (Test-Path $PythonPath)) { $PythonPath = Join-Path $repoRoot 'venv\Scripts\python.exe' }
}
if (-not (Test-Path $PythonPath)) {
  Write-Error "Python venv not found. Set -PythonPath or create .venv."
}

# Environment
if ($DatabaseUrl) { $env:DATABASE_URL = $DatabaseUrl }
if (-not $env:DATABASE_URL) {
  Write-Warning "DATABASE_URL not set. Set -DatabaseUrl or export env var."
}
$env:DB_SCHEMA = $Schema
$env:PYTHONPATH = (Join-Path $repoRoot 'scraper')

# Parse accounts: CSV path or comma-separated list or single ID
function Resolve-Accounts([string]$arg) {
  if (Test-Path $arg) {
    $out = @()
    Get-Content -LiteralPath $arg | ForEach-Object {
      $_ -split ',' | ForEach-Object { $v = $_.Trim(); if ($v -match '^[0-9]+$') { $out += $v } }
    }
    return $out
  } else {
    return ($arg -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
}

$acctList = Resolve-Accounts $Accounts
if (-not $acctList -or $acctList.Count -eq 0) { Write-Error "No account IDs parsed from '$Accounts'" }

Write-Host "Scraping and reporting for $($acctList.Count) account(s)" -ForegroundColor Cyan

foreach ($acc in $acctList) {
  Write-Host "== Account $acc ==" -ForegroundColor Yellow
  & $PythonPath -m dcad.run_once $acc
  if ($LASTEXITCODE -ne 0) { Write-Warning "run_once failed for $acc (exit $LASTEXITCODE)" }
  & $PythonPath -m dcad.report $acc
  if ($LASTEXITCODE -ne 0) { Write-Warning "report failed for $acc (exit $LASTEXITCODE)" }
}

Write-Host "Done." -ForegroundColor Green

