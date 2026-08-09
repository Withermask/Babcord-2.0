@echo off
setlocal
cd /d "%~dp0"
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator access for one-time setup...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployment\scripts\Initialize-BabcordDirectHost.ps1" -InstallDependencies -InstallCaddy
if errorlevel 1 (
  echo.
  echo Setup failed. Read the error above; no router settings were changed.
) else (
  echo.
  echo Setup finished. Next run Configure Babcord GitHub.bat and configure router TCP 80/443.
)
pause
