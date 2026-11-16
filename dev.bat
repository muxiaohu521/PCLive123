@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ============================================================
:: 自动检测本地 Node.js（纯批处理，不联网、不下载）
:: ============================================================
set NODE_LOCAL=%~dp0tools\node

:: 1) 优先使用 E:\tools\app\node 下版本号最高的 node.exe（纯批处理，不联网）
set "NODE_BEST="
call :scan_node_dir "E:\tools\app\node"
if defined NODE_BEST (
    set "PATH=%NODE_BEST%;%PATH%"
    goto :env_ok
)

:: 2) 其次检查 PATH
where node >nul 2>nul
if %errorlevel% equ 0 goto :env_ok

:: 3) 检查项目自带 tools\node
call :scan_node_dir "%NODE_LOCAL%"
if defined NODE_BEST (
    set "PATH=%NODE_BEST%;%PATH%"
    goto :env_ok
)

:: 4) 搜索常见安装位置
for %%L in (C D E F G) do (
    if exist "%%L:\Program Files\nodejs\node.exe" (
        set "PATH=%%L:\Program Files\nodejs;%PATH%"
        goto :env_ok
    )
    if exist "%%L:\nodejs\node.exe" (
        set "PATH=%%L:\nodejs;%PATH%"
        goto :env_ok
    )
)

:: 5) 未检测到本地 Node.js（不下载、不联网）
echo.
echo ========================================
echo   [ERROR] 未检测到本地 Node.js！
echo ========================================
echo.
echo   请手动安装 Node.js (推荐 LTS):
echo     https://nodejs.org/
echo     winget install OpenJS.NodeJS.LTS
echo.
echo   或将 node.exe 放到以下任一目录:
echo     E:\tools\app\node\node.exe
echo     %NODE_LOCAL%\node.exe
echo.
pause
exit /b 1

:env_ok
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js 不可用
    pause
    exit /b 1
)

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo ========================================
    echo   [ERROR] 未找到 npm！
    echo ========================================
    echo.
    echo   npm 通常随 Node.js 一起安装。
    echo   请重新安装 Node.js: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo 依赖未安装，正在自动安装...
    call npm install
    if errorlevel 1 (
        echo 安装失败！
        pause
        exit /b 1
    )
)

echo Starting PCLive Development...
echo.
call npm run electron:dev
pause
exit /b 0

:: ============================================================
:: 纯批处理：扫描指定目录，返回 node.exe 所在目录（版本号最高优先）
:: 用法: call :scan_node_dir "目录路径"
:: 结果: 若找到，则设置 NODE_BEST 为 node.exe 所在目录
:: ============================================================
:scan_node_dir
if "%~1"=="" exit /b 0
if not exist "%~1\" exit /b 0
set "SCAN_BEST_DIR="
set "SCAN_BEST_SCORE=0"
rem 遍历 node-v* 子目录，按主/次/修订版本号数值比较，取最高者
for /f "delims=" %%D in ('dir /b /ad "%~1\node-v*" 2^>nul') do (
    call :pick "%~1" "%%D"
)
if defined SCAN_BEST_DIR set "NODE_BEST=%SCAN_BEST_DIR%"
rem 其次匹配目录下直接的 node.exe
if exist "%~1\node.exe" if not defined NODE_BEST set "NODE_BEST=%~1"
exit /b 0

:pick
set "_S="
set "V=%~2"
set "V=%V:node-v=%"
for /f "tokens=1-3 delims=.-" %%a in ("%V%") do set /a "_S=%%a*1000000+%%b*1000+%%c" >nul
if not defined _S exit /b 0
set /a "_D=%_S% - %SCAN_BEST_SCORE%"
if %_D% GTR 0 (
    set "SCAN_BEST_SCORE=%_S%"
    set "SCAN_BEST_DIR=%~1\%~2"
)
exit /b 0