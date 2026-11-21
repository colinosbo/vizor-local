@echo off
rem Vizor Local launcher: double-click to start (or to open the one already running).
cd /d "%~dp0"
title Vizor Local
where node >nul 2>nul || (echo Node.js was not found on PATH. Install Node 22.13 or newer. & pause & exit /b 1)
where git >nul 2>nul || (echo Git was not found on PATH. & pause & exit /b 1)
where claude >nul 2>nul || echo Warning: claude was not found on PATH; planning and workers will fail until it is.
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto fail
)
echo Building...
call npm run build || goto fail
rem Install bundled skills (e.g. unslop) for Claude Code; never overwrites a newer copy.
xcopy "%~dp0skills" "%USERPROFILE%\.claude\skills\" /E /I /Y /D /Q >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcut.ps1"
node --disable-warning=ExperimentalWarning dist\src\cli.js serve --orchestrator claude --worker claude --open
if errorlevel 1 goto fail
exit /b 0
:fail
echo.
echo Vizor Local did not start. The error is above.
pause
exit /b 1
