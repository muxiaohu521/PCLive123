@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting PCLive Development...
echo.
call npm run electron:dev
pause