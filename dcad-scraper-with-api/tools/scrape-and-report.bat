@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
  echo Usage: %~n0 ^<ACCOUNT_ID or CSV_PATH or comma_list^>
  exit /b 2
)

set SCRIPT_DIR=%~dp0
set PS1=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe

"%PS1%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scrape-and-report.ps1" -Accounts "%~1"

exit /b %ERRORLEVEL%

