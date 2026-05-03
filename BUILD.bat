@echo off
setlocal enabledelayedexpansion
title Bridge OS — Build
echo.
echo  ⬢  BRIDGE OS BUILD SCRIPT  v4.1.0
echo  ─────────────────────────────────────────
echo.

:: Check Node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo  Node: %NODEVER%

:: Install if needed
if not exist "node_modules\electron" (
    echo.
    echo  [1/5] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed.
        pause & exit /b 1
    )
) else (
    echo  [1/5] Dependencies already installed.
)

echo.
echo  [2/5] Generating integrity manifest...
node scripts\gen-manifest.js
if %errorlevel% neq 0 (
    echo  [WARNING] Manifest generation failed — skipping
)

echo.
echo  [3/5] Building portable package (no installer needed)...
call npx electron-packager . "Bridge OS" --platform=win32 --arch=x64 --out=dist --overwrite --asar --asar-unpack="bridge-node/**" --ignore="dist" --ignore=".git" --ignore="node_modules/.cache" --app-version=4.1.0 --build-version=4.1.0
if %errorlevel% neq 0 (
    echo.
    echo  [INFO] electron-packager failed. Trying electron-builder...
    call npm run build
    if %errorlevel% neq 0 (
        echo  [ERROR] Both build methods failed.
        echo  Try: npm install --save-dev electron-packager
        echo  Then run this script again.
        pause & exit /b 1
    )
)

echo.
echo  [4/5] Done.
echo.
echo  ─────────────────────────────────────────

:: Find what was built
if exist "dist\Bridge OS-win32-x64\Bridge OS.exe" (
    echo  PORTABLE: dist\Bridge OS-win32-x64\Bridge OS.exe
    echo  Zip that folder and ship it — no install needed.
) else if exist "dist\BridgeOS-Setup-4.1.0.exe" (
    echo  INSTALLER: dist\BridgeOS-Setup-4.1.0.exe
) else (
    echo  Build output is in the dist\ folder.
    dir dist /b 2>nul
)

echo  ─────────────────────────────────────────
echo.

echo  [5/5] Optional — open dist folder?
set /p OPEN="Open dist folder? (y/n): "
if /i "%OPEN%"=="y" explorer dist

echo.
pause
