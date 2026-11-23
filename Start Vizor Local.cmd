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
rem Offer the bundled skills (e.g. unslop) for Claude Code; asks once and remembers the answer.
call :install_skills "%~dp0skills"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-shortcut.ps1"
node --disable-warning=ExperimentalWarning dist\src\cli.js serve --orchestrator claude --worker claude --open
if errorlevel 1 goto fail
exit /b 0
:fail
echo.
echo Vizor Local did not start. The error is above.
pause
exit /b 1

rem ---------------------------------------------------------------------------
rem Bundled skills. Nothing is copied without consent. The answer ("yes" or
rem "never") is kept in %USERPROFILE%\.local-poc\skills-consent.txt; delete that
rem file to be asked again. Existing skill folders are only replaced after a
rem separate yes for that skill. Always returns 0 so the launch carries on.
rem ---------------------------------------------------------------------------
:install_skills
setlocal
set "SKILLS_SRC=%~1"
if "%SKILLS_SRC:~-1%"=="\" set "SKILLS_SRC=%SKILLS_SRC:~0,-1%"
set "SKILLS_DEST=%USERPROFILE%\.claude\skills"
set "CONSENT_DIR=%USERPROFILE%\.local-poc"
set "CONSENT_FILE=%CONSENT_DIR%\skills-consent.txt"
if not exist "%SKILLS_SRC%\" goto skills_done
if not exist "%CONSENT_DIR%\" mkdir "%CONSENT_DIR%" >nul 2>nul
set "ANSWER="
if exist "%CONSENT_FILE%" set /p ANSWER=<"%CONSENT_FILE%"
if /i "%ANSWER%"=="never" goto skills_never
if /i "%ANSWER%"=="yes" goto skills_copy
call :ask_skills_consent
if /i "%ANSWER%"=="yes" goto skills_copy
goto skills_done
:skills_never
echo Bundled skills: not installed, you chose never.
goto skills_done
:skills_copy
for /d %%S in ("%SKILLS_SRC%\*") do call :copy_one_skill "%%~nxS"
:skills_done
endlocal
exit /b 0

:ask_skills_consent
echo.
echo Vizor Local comes with skills for Claude Code. It can copy these folders:
for /d %%S in ("%SKILLS_SRC%\*") do echo   %%~nxS
echo from "%SKILLS_SRC%"
echo into "%SKILLS_DEST%"
echo A skill folder that is already there is only replaced if you say yes to that skill.
echo.
echo   Y = install now
echo   N = not now, ask again next launch
echo   X = never ask again
choice /c YNX /n /m "Install the bundled skills? [Y/N/X] "
set "PICK=%errorlevel%"
if "%PICK%"=="1" goto consent_yes
if "%PICK%"=="3" goto consent_never
set "ANSWER="
echo Not now. You will be asked again next launch.
exit /b 0
:consent_yes
>"%CONSENT_FILE%" echo yes
set "ANSWER=yes"
echo Saved your answer in "%CONSENT_FILE%". Delete that file to be asked again.
exit /b 0
:consent_never
>"%CONSENT_FILE%" echo never
set "ANSWER=never"
echo Saved. Skills will not be installed and you will not be asked again.
echo Delete "%CONSENT_FILE%" if you change your mind.
exit /b 0

:copy_one_skill
set "SKILL_NAME=%~1"
if exist "%SKILLS_DEST%\%SKILL_NAME%\" goto skill_exists
xcopy "%SKILLS_SRC%\%SKILL_NAME%" "%SKILLS_DEST%\%SKILL_NAME%\" /E /I /Q >nul 2>nul
if errorlevel 1 goto skill_copy_failed
echo Copied skill: %SKILL_NAME%
exit /b 0
:skill_exists
set "REPLACE="
set /p "REPLACE=Skill %SKILL_NAME% is already installed. Replace it with the bundled copy? [y/N] "
setlocal EnableDelayedExpansion
set "OK=0"
if /i "!REPLACE!"=="y" set "OK=1"
if /i "!REPLACE!"=="yes" set "OK=1"
endlocal & set "OK=%OK%"
if not "%OK%"=="1" goto skill_skipped
xcopy "%SKILLS_SRC%\%SKILL_NAME%" "%SKILLS_DEST%\%SKILL_NAME%\" /E /I /Y /Q >nul 2>nul
if errorlevel 1 goto skill_copy_failed
echo Replaced skill: %SKILL_NAME%
exit /b 0
:skill_skipped
echo Skipped skill: %SKILL_NAME%, already installed.
exit /b 0
:skill_copy_failed
echo Could not copy skill %SKILL_NAME% into "%SKILLS_DEST%".
exit /b 0
