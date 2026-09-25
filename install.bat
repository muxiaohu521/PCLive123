@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================
echo   PCLive 依赖安装
echo ================================
echo.
call npm install
echo.
echo 安装完成！双击 dev.bat 启动开发模式
pause