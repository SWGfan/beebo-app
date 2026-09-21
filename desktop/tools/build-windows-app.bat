@echo off
setlocal
title Build Beebo Entertainment Windows App

rem Builds the Windows viewer app that family members install.
rem
rem It copies the Electron runtime that npm already downloaded into this
rem project, drops the small viewer app inside it, and zips the result so the
rem website can hand it out at /download/windows-app.
rem
rem Run this again whenever the viewer app changes.

set "ROOT=%~dp0.."
set "SRC=%ROOT%\node_modules\electron\dist"
set "OUT=%ROOT%\apps\viewer\dist"
set "STAGE=%OUT%\Beebo Entertainment Viewer"
set "ZIP=%OUT%\Beebo-Entertainment-Viewer-Windows.zip"

if not exist "%SRC%\electron.exe" (
    echo.
    echo   Can't find the Electron runtime at:
    echo   %SRC%
    echo.
    echo   Run this first, from D:\MovieAPP\MovieAPP-scaffold :
    echo       npm install
    echo.
    pause
    exit /b 1
)

echo Preparing a clean build folder...
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" 2>nul

echo Copying the Electron runtime (this takes a moment)...
robocopy "%SRC%" "%STAGE%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
if errorlevel 8 (
    echo   Copy failed.
    pause
    exit /b 1
)

echo Adding the Beebo Entertainment Viewer app...
rem Electron runs resources\app if it exists, instead of its own welcome screen.
if exist "%STAGE%\resources\default_app.asar" del /q "%STAGE%\resources\default_app.asar"
mkdir "%STAGE%\resources\app" 2>nul
mkdir "%STAGE%\resources\app\electron" 2>nul
copy /y "%ROOT%\apps\viewer\package.json" "%STAGE%\resources\app\package.json" >nul
copy /y "%ROOT%\apps\viewer\electron\main.js" "%STAGE%\resources\app\electron\main.js" >nul

echo Naming the program Beebo Entertainment Viewer.exe...
ren "%STAGE%\electron.exe" "Beebo Entertainment Viewer.exe"

echo Writing a Start Beebo Entertainment shortcut helper...
> "%STAGE%\READ ME FIRST.txt" echo Double-click "Beebo Entertainment Viewer.exe" to start.
>> "%STAGE%\READ ME FIRST.txt" echo.
>> "%STAGE%\READ ME FIRST.txt" echo The first time it runs it asks for the Beebo Entertainment address,
>> "%STAGE%\READ ME FIRST.txt" echo then for your username and password. It remembers both.
>> "%STAGE%\READ ME FIRST.txt" echo.
>> "%STAGE%\READ ME FIRST.txt" echo Windows may warn that the app is unrecognised - choose
>> "%STAGE%\READ ME FIRST.txt" echo "More info" then "Run anyway". It is unsigned, not unsafe.

echo Zipping it up for the website (this takes a minute)...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%' -DestinationPath '%ZIP%' -CompressionLevel Optimal"
if not exist "%ZIP%" (
    echo   Zipping failed.
    pause
    exit /b 1
)

echo.
echo   Done. The Windows app is ready to download from your website at:
echo       /download/windows-app
echo.
echo   Built files:
echo       %ZIP%
echo       %STAGE%
echo.
pause
