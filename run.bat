@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ============================================================
:: 自动检测 / 下载 Node.js
:: ============================================================
set NODE_LOCAL=%~dp0tools\node

:: 1) 优先使用 E:\tools\app\node 中版本号最高的 Node.js（优先最新版）
set "NODE_PREFER=E:\tools\app\node"
set "NODE_BEST="
if exist "%NODE_PREFER%" for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$r='%NODE_PREFER%';$bv=$null;$b=$null;foreach($d in (Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue)){if(-not (Test-Path (Join-Path $d.FullName 'node.exe'))){continue};$m=[regex]::Match($d.Name,'v(\d+)\.(\d+)\.(\d+)');if($m.Success){$v=[version]($m.Groups[1].Value+'.'+$m.Groups[2].Value+'.'+$m.Groups[3].Value)}else{$v=[version]'0.0.0'};if(($bv -eq $null) -or ($v -gt $bv)){$bv=$v;$b=$d.FullName}};if($b){$b}"`) do set "NODE_BEST=%%P"
if defined NODE_BEST (
    set "PATH=%NODE_BEST%;%PATH%"
    goto :env_ok
)
if exist "%NODE_PREFER%\node.exe" (
    set "PATH=%NODE_PREFER%;%PATH%"
    goto :env_ok
)

:: 2) 其次检查 PATH
where node >nul 2>nul
if %errorlevel% equ 0 goto :env_ok

:: 3) 检查本地 tools\node\
if exist "%NODE_LOCAL%\node.exe" (
    set "PATH=%NODE_LOCAL%;%PATH%"
    goto :env_ok
)
for /d %%D in ("%NODE_LOCAL%\*") do (
    if exist "%%D\node.exe" (
        set NODE_LOCAL=%%D
        call set "PATH=%%NODE_LOCAL%%;%PATH%"
        goto :env_ok
    )
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
    for /d %%T in ("%%L:\tools\node*") do (
        if exist "%%T\node.exe" (
            set "PATH=%%T;%PATH%"
            goto :env_ok
        )
    )
    for /d %%S in ("%%L:\tools\*") do (
        for /d %%T in ("%%S\node*") do (
            if exist "%%T\node.exe" (
                set "PATH=%%T;%PATH%"
                goto :env_ok
            )
        )
    )
)

:: 5) 自动下载
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
    "try{Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 300 -ErrorAction Stop}catch{Write-Host '[ERROR] 下载失败: 请手动安装 https://nodejs.org/' -ForegroundColor Red; throw};" ^
    "Write-Host '  正在解压...';" ^
    "Get-ChildItem $nDir -Exclude '*.zip' -ErrorAction SilentlyContinue|Remove-Item -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "Expand-Archive -Path $zip -DestinationPath $nDir -Force; Remove-Item $zip -Force -ErrorAction SilentlyContinue;" ^
    "$found=Get-ChildItem $nDir -Directory|?{Test-Path (Join-Path $_.FullName 'node.exe')}|Select -First 1;" ^
    "if($found){Write-Host ('Node.js 已安装: '+$found.FullName) -ForegroundColor Green}elseif(Test-Path (Join-Path $nDir 'node.exe')){Write-Host ('Node.js 已安装: '+$nDir) -ForegroundColor Green}else{Write-Host '[ERROR] 未找到 node.exe' -ForegroundColor Red; throw}"
if errorlevel 1 (
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
        call set "PATH=%%NODE_LOCAL%%;%PATH%"
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

if not exist "node_modules\" (
    echo ========================================
    echo   依赖未安装，请先运行 install.bat
    echo ========================================
    pause
    exit /b 1
)

echo Starting PCLive...
if exist "dist\index.html" (
    echo 检测到现有构建物，直接启动（跳过构建）...
    goto :launch
)

echo 未检测到构建物，首次运行开始构建...
call npm run build
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)
echo 构建完成，正在启动 PCLive...

:launch
start "" node node_modules\electron\cli.js .
if errorlevel 1 (
    echo [ERROR] 启动失败！请检查 Electron 是否安装。
)
pause