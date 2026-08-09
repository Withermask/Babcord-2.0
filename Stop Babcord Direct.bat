@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployment\scripts\Stop-BabcordDirect.ps1" -Confirm:$false
if errorlevel 1 echo Babcord may not have stopped cleanly. Read the error above.
pause

