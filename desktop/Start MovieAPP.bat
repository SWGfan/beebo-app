@echo off
title Beebo Entertainment
cd /d "%~dp0apps\desktop"

rem Double-clicked with no argument -> relaunch with NO visible console window
rem (via the hidden VBS), then close this one. The hidden copy re-enters below
rem with the "hidden" argument. Run with the argument  visible  to force a
rem normal window for troubleshooting.
if "%~1"=="" (
    if exist "%~dp0Start MovieAPP (hidden).vbs" (
        wscript.exe "%~dp0Start MovieAPP (hidden).vbs"
        exit /b
    )
)

where npm >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js isn't installed or this window can't see it yet.
    echo   Install it with:   winget install --id OpenJS.NodeJS.LTS -e --source winget
    echo   then close this window and double-click Start MovieAPP again.
    echo.
    pause
    exit /b 1
)

rem Dependencies live in the REPO ROOT node_modules (npm workspaces project),
rem not in apps\desktop. Checking two packages that were added later means a
rem stale install tops itself up instead of failing at runtime with
rem "busboy_not_installed" or a converter that silently never runs.
set NEEDS_INSTALL=
if not exist "%~dp0node_modules\busboy" set NEEDS_INSTALL=1
if not exist "%~dp0node_modules\@ffmpeg-installer" set NEEDS_INSTALL=1
if defined NEEDS_INSTALL (
    echo Installing/updating dependencies, please wait...
    pushd "%~dp0"
    call npm install
    popd
)

if /i "%~1"=="hidden" goto hidden

echo Starting Beebo Entertainment...
call npm run dev
pause
exit /b

:hidden
rem Launched from "Start MovieAPP (hidden).vbs" - there is no console to print
rem to, so everything goes to a log file we can read if something goes wrong.
if not exist "%~dp0logs" mkdir "%~dp0logs"
call npm run dev > "%~dp0logs\movieapp.log" 2>&1
exit /b
