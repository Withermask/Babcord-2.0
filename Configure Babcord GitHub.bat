@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployment\scripts\Configure-BabcordDirectGitHub.ps1"
if errorlevel 1 (
  echo.
  echo GitHub setup failed. Read the error above; no client was published.
) else (
  echo.
  echo GitHub updates are configured. You can now run Start Babcord Direct.bat.
)
pause
