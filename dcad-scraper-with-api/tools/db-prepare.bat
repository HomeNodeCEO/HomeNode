@echo off
setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set REPO_ROOT=%SCRIPT_DIR%..\

set HOST=127.0.0.1
set PORT=5432
set DB=mooolah_inc
set USER=postgres
set PS1=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe

%PS1% -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%db-prepare.ps1" -Host %HOST% -Port %PORT% -Database %DB% -User %USER%

exit /b %ERRORLEVEL%

