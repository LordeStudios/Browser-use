@echo off
rem DEV RESUME (one click / agent-runnable):
rem   dev-resume.bat             kill this checkout's dev build, relaunch it
rem                              resuming the previous tabs + chat
rem   dev-resume.bat --fresh     relaunch with a fresh session
rem   dev-resume.bat --kill-only stop the dev build and exit
rem   dev-resume.bat --attach    stay attached to the console (watch logs)
setlocal
cd /d "%~dp0.."
node scripts\dev-resume.mjs %*
endlocal
