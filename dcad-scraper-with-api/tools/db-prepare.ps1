param(
  [string]$Host = "127.0.0.1",
  [int]$Port = 5432,
  [string]$Database = "mooolah_inc",
  [string]$User = "postgres",
  [string]$PsqlPath = "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $PsqlPath)) {
  $PsqlPath = "psql"
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sqlFile = Join-Path $repoRoot 'tools\\prepare_core_from_dcad.sql'
if (-not (Test-Path $sqlFile)) {
  Write-Error "SQL file not found: $sqlFile"
}

Write-Host "Running DB prepare script: $sqlFile" -ForegroundColor Cyan

& $PsqlPath -h $Host -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -f $sqlFile

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Done." -ForegroundColor Green

