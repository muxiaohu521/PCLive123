@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting PCLive...
if not exist "dist\index.html" (
    echo Dist not found, building first...
    call npm run build
    if %errorlevel% neq 0 (
        echo Build failed!
        pause
        exit /b
    )
)
start "" node node_modules\electron\cli.js .