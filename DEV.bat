@echo off
title Bridge OS DEV
cd /d "%~dp0"
echo.
echo  BRIDGE OS DEV MODE
echo.

if not exist "node_modules\electron" (
    echo  Installing...
    call npm install
    if %errorlevel% neq 0 ( pause & exit /b 1 )
)

call node_modules\.bin\electron.cmd . --dev --no-sandbox
echo.
echo  Exited. Press any key.
pause
