@echo off
title Bridge OS
cd /d "%~dp0"
echo.
echo  BRIDGE OS v4.1.0
echo.

if not exist "main.js" (
    echo  ERROR: main.js not found in %CD%
    pause & exit /b 1
)

if not exist "node_modules\electron" (
    echo  Installing Electron...
    call npm install
    if %errorlevel% neq 0 ( pause & exit /b 1 )
)

echo  Launching...
call node_modules\.bin\electron.cmd . --no-sandbox
if %errorlevel% neq 0 (
    echo.
    echo  Failed. Trying npx...
    call npx electron . --no-sandbox
)
if %errorlevel% neq 0 (
    echo.
    echo  Error. Check: %APPDATA%\bridge-os\bridge-os.log
    pause
)
