@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ============================================================
:: 自动检测 / 下载 Node.js
:: ============================================================
set NODE_LOCAL=%~dp0tools\node

where node >nul 2>nul
if %errorlevel% equ 0 goto :env_ok

if exist "%NODE_LOCAL%\node.exe" (
    set PATH=%NODE_LOCAL%;%PATH%
    goto :env_ok
)
for /d %%D in ("%NODE_LOCAL%\*") do (
    if exist "%%D\node.exe" (
        set NODE_LOCAL=%%D
        set PATH=%NODE_LOCAL%;%PATH%
        goto :env_ok
    )
)

echo.
echo ========================================
echo   Node.js 未检测到，正在自动下载...
echo ========================================
echo.
powershell -ExecutionPolicy Bypass -Command ^
    "$nDir='%NODE_LOCAL%';" ^
    "if(-not(Test-Path $nDir)){New-Item -Force -ItemType Directory $nDir|Out-Null};" ^
    "$url='https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip';" ^
    "try{$idx=Invoke-RestMethod 'https://nodejs.org/download/release/index.json' -TimeoutSec 15; $lts=$idx|?{$_.lts -and $_.files -contains 'win-x64-zip'}|Select -First 1; if($lts){$url='https://nodejs.org/dist/'+$lts.version+'/node-'+$lts.version+'-win-x64.zip'}}catch{};" ^
    "$zip=Join-Path $nDir 'node.zip';" ^
    "Write-Host '  正在下载 Node.js (约 30MB)...';" ^
    "$ProgressPreference='SilentlyContinue';" ^
    "try{Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 300 -ErrorAction Stop}catch{Write-Host '[ERROR] 下载失败: 请手动安装 https://nodejs.org/' -ForegroundColor Red; exit 1};" ^
    "Write-Host '  正在解压...';" ^
    "Get-ChildItem $nDir -Exclude '*.zip' -ErrorAction SilentlyContinue|Remove-Item -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "Expand-Archive -Path $zip -DestinationPath $nDir -Force; Remove-Item $zip -Force -ErrorAction SilentlyContinue;" ^
    "$found=Get-ChildItem $nDir -Directory|?{Test-Path \"$($_.FullName)\node.exe\"}|Select -First 1;" ^
    "if($found){Write-Host ('Node.js 已安装: '+$found.FullName) -ForegroundColor Green}elseif(Test-Path \"$nDir\node.exe\"){Write-Host ('Node.js 已安装: '+$nDir) -ForegroundColor Green}else{Write-Host '[ERROR] 未找到 node.exe' -ForegroundColor Red; exit 1}"
if %errorlevel% neq 0 (
    echo.
    echo ========================================
    echo   [ERROR] Node.js 自动下载失败！
    echo ========================================
    echo.
    echo   请手动安装 Node.js (推荐 LTS):
    echo     https://nodejs.org/
    echo     winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

for /d %%D in ("%NODE_LOCAL%\*") do (
    if exist "%%D\node.exe" (
        set NODE_LOCAL=%%D
        set PATH=%NODE_LOCAL%;%PATH%
    )
)
echo.

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

echo ================================
echo   PCLive 依赖安装
echo ================================
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ========================================
    echo   安装失败！请检查网络连接。
    echo   可尝试切换镜像源:
    echo     npm config set registry https://registry.npmmirror.com
    echo ========================================
    pause
    exit /b 1
)
echo.
echo 安装完成！双击 dev.bat 启动开发模式
pause