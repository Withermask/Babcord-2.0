@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployment\scripts\Start-BabcordDirect.ps1"
if errorlevel 1 (
  echo.
  echo Babcord did not fully start. Read the error above.
) else (
  echo.
  echo Babcord is running. You may close this window.
)
pause

