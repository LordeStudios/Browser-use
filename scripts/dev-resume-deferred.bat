@echo off
rem EXTERNAL RESTART TIMER — this file is the thing that outlives the app.
rem
rem It is launched by an outside shell (cmd /c start ...) so its timer runs in
rem its own console, not in the app's internal terminal: when the app is
rem killed, the terminal dies with it, but this script keeps running and
rem finishes the restart.
rem
rem   dev-resume-deferred.bat            wait 5s, then kill + relaunch
rem   set DEV_RESUME_GRACE=12 & ...bat   wait 12s
rem   set DEV_RESUME_FRESH=1 & ...bat    relaunch without resuming
rem
rem The trace goes to scratch\dev-resume-helper.log.
setlocal
cd /d "%~dp0.."

set SECS=%DEV_RESUME_GRACE%
if not "%~1"=="" set SECS=%~1
if "%SECS%"=="" set SECS=5
set RESUME_ARG=
if "%DEV_RESUME_FRESH%"=="1" set RESUME_ARG=--fresh
set DRY_ARG=
if "%DEV_RESUME_DRY%"=="1" set DRY_ARG=--dry-run

if not exist "scratch" mkdir "scratch"
echo [%DATE% %TIME%] external timer started; waiting %SECS%s >> "scratch\dev-resume-helper.log"

rem The timer lives HERE, in an external process. `timeout` needs a console
rem input handle and exits immediately when stdin is redirected, so the wait is
rem a real sleep in an external PowerShell (fallback: ping, which needs no
rem console at all).
powershell -NoProfile -NonInteractive -Command "Start-Sleep -Seconds %SECS%" >nul 2>&1
if errorlevel 1 (
  set /a PING=%SECS%+1
  ping -n %PING% 127.0.0.1 >nul 2>&1
)

echo [%DATE% %TIME%] timer elapsed; running the restart >> "scratch\dev-resume-helper.log"
node "scripts\dev-resume.mjs" --kill-and-launch %RESUME_ARG% %DRY_ARG% >> "scratch\dev-resume-helper.log" 2>&1
echo [%DATE% %TIME%] restart worker finished >> "scratch\dev-resume-helper.log"
endlocal
