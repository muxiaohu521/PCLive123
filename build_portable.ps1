# ================================================================
#  PCLive Portable Build Script
#  便携版构建脚本 - 解压即用，无需安装
#  用法: powershell -ExecutionPolicy Bypass -File build_portable.ps1
# ================================================================
param(
    [switch]$CleanOnly,          # 仅清理
    [switch]$SkipViteBuild,      # 跳过前端构建(已有 dist/)
    [string]$OutputName = "PCLive"  # 输出文件夹名称
)

$ErrorActionPreference = "Continue"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ================================================================
# 0. 路径定义
# ================================================================
$ElectronDir  = Join-Path $scriptDir "node_modules\electron\dist"
$DistDir      = Join-Path $scriptDir "dist"
$ElectronSrc  = Join-Path $scriptDir "electron"
$OutputRoot   = Join-Path $scriptDir "PCLive-portable"
$OutputDir    = Join-Path $OutputRoot $OutputName
$ResourcesDir = Join-Path $OutputDir "resources"
$NodeModules  = Join-Path $scriptDir "node_modules"

# ================================================================
# 1. 环境检查
# ================================================================
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  PCLive Portable Build Script" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[STEP 0] Checking environment..." -ForegroundColor Yellow

# ============================================================
# 自动检测 / 下载 Node.js
# ============================================================
function Install-NodeJs {
    $nodeToolsDir = Join-Path $scriptDir "tools\node"
    if (-not (Test-Path $nodeToolsDir)) {
        New-Item -ItemType Directory -Force -Path $nodeToolsDir | Out-Null
    }

    # 获取最新 LTS 下载地址
    $nodeUrl = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip"
    try {
        $index = Invoke-RestMethod "https://nodejs.org/download/release/index.json" -TimeoutSec 15
        $lts = $index | Where-Object { $_.lts -ne $false -and $_.files -contains "win-x64-zip" } | Select-Object -First 1
        if ($lts) { $nodeUrl = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-win-x64.zip" }
    } catch {}

    $zipFile = Join-Path $nodeToolsDir "node.zip"

    Write-Host "  正在下载 Node.js (约 30MB)..." -ForegroundColor Cyan
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $nodeUrl -OutFile $zipFile -TimeoutSec 300 -ErrorAction Stop
    } catch {
        Write-Host "  [ERROR] Node.js 下载失败: $_" -ForegroundColor Red
        return $false
    }

    Write-Host "  正在解压..." -ForegroundColor Cyan
    try {
        Get-ChildItem -Path $nodeToolsDir -Exclude "*.zip" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -Path $zipFile -DestinationPath $nodeToolsDir -Force
        Remove-Item -Path $zipFile -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "  [ERROR] 解压失败: $_" -ForegroundColor Red
        return $false
    }

    # 找到解压后的 node.exe
    $extracted = Get-ChildItem -Path $nodeToolsDir -Directory | Where-Object { Test-Path "$($_.FullName)\node.exe" } | Select-Object -First 1
    if ($extracted) { $script:nodeBinDir = $extracted.FullName; return $true }
    if (Test-Path "$nodeToolsDir\node.exe") { $script:nodeBinDir = $nodeToolsDir; return $true }

    Write-Host "  [ERROR] 未找到解压后的 node.exe" -ForegroundColor Red
    return $false
}

function Get-NodeBin {
    $nodeBin = $null
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $nodeBin = Split-Path $nodeCmd.Source -Parent }
    if (-not $nodeBin) {
        $localNode = Join-Path $scriptDir "tools\node"
        if (Test-Path "$localNode\node.exe") { $nodeBin = $localNode }
        else {
            $found = Get-ChildItem -Path $localNode -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path "$($_.FullName)\node.exe" } | Select-Object -First 1
            if ($found) { $nodeBin = $found.FullName }
        }
    }
    return $nodeBin
}

$nodeBinDir = Get-NodeBin
if (-not $nodeBinDir) {
    Write-Host "  Node.js 未检测到，正在自动下载..." -ForegroundColor Yellow
    if (Install-NodeJs) {
        $nodeBinDir = Get-NodeBin
        Write-Host "  Node.js 安装完成: $nodeBinDir" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  ========================================" -ForegroundColor Red
        Write-Host "    [ERROR] Node.js 下载失败！" -ForegroundColor Red
        Write-Host "  ========================================" -ForegroundColor Red
        Write-Host ""
        Write-Host "    请手动安装 Node.js (推荐 LTS 版本):" -ForegroundColor Yellow
        Write-Host "      下载地址: https://nodejs.org/" -ForegroundColor Gray
        Write-Host "      安装命令: winget install OpenJS.NodeJS.LTS" -ForegroundColor Gray
        Write-Host ""
        exit 1
    }
}

$env:Path = "$nodeBinDir;$env:Path"
$nodeVer = node --version 2>$null
Write-Host "  Node.js: $nodeVer" -ForegroundColor Green

# 检查 npm
$npmVer = npm --version 2>$null
if (-not $npmVer) {
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Red
    Write-Host "    [ERROR] npm 未找到！" -ForegroundColor Red
    Write-Host "  ========================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "    npm 通常随 Node.js 一起安装。" -ForegroundColor Yellow
    Write-Host "    请重新安装 Node.js: https://nodejs.org/" -ForegroundColor Gray
    Write-Host ""
    exit 1
}
Write-Host "  npm:     v$npmVer" -ForegroundColor Green

# 检查 Electron dist
if (-not (Test-Path $ElectronDir)) {
    Write-Host "  ERROR: Electron dist not found at: $ElectronDir" -ForegroundColor Red
    Write-Host "  Run: npm install" -ForegroundColor Yellow
    exit 1
}
Write-Host "  Electron: OK ($ElectronDir)" -ForegroundColor Green

# 检查 dist (前端构建产物)
if (-not (Test-Path (Join-Path $DistDir "index.html"))) {
    Write-Host "  WARNING: dist/ not built yet, will run vite build" -ForegroundColor Yellow
    $SkipViteBuild = $false
} else {
    Write-Host "  dist/:    OK" -ForegroundColor Green
}

Write-Host "  Environment check passed!" -ForegroundColor Green

Write-Host ""

# ================================================================
# 2. 清理旧产物
# ================================================================
Write-Host "[STEP 1] Cleaning old build..." -ForegroundColor Yellow

# --- 强制杀掉所有可能占用文件的进程 ---
# 注意：绝不杀 node 进程！IDE/终端依赖 Node.js 运行
$killNames = @("PCLive", "electron")
$killedAny = $false
foreach ($pn in $killNames) {
    $procs = @(Get-Process -Name $pn -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) {
        foreach ($p in $procs) {
            Write-Host "  Killing: $pn (PID: $($p.Id))" -ForegroundColor Yellow
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
        $killedAny = $true
    }
}
if ($killedAny) {
    Start-Sleep -Seconds 2
    Write-Host "  Processes killed, handles released" -ForegroundColor Gray
}

# --- 目录清理函数：先逐文件删除，再删空目录 ---
function Remove-DirForce {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $true }

    # Step A: 递归删除所有文件（逐个文件，跳过锁定的）
    $allFiles = @(Get-ChildItem $Path -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($f in $allFiles) {
        try {
            # 先去掉只读属性，再用 .NET 删除（比 PowerShell Remove-Item 更可靠）
            [System.IO.File]::SetAttributes($f.FullName, [System.IO.FileAttributes]::Normal)
            [System.IO.File]::Delete($f.FullName)
        } catch {
            # 文件被锁，跳过，后面用改名策略
        }
    }
    Start-Sleep -Milliseconds 300

    # Step B: 删除空目录（从深到浅）
    $allDirs = @(Get-ChildItem $Path -Recurse -Directory -ErrorAction SilentlyContinue | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($d in $allDirs) {
        try {
            [System.IO.Directory]::Delete($d.FullName, $false)
        } catch {}
    }

    # Step C: 尝试删除根目录
    try {
        [System.IO.Directory]::Delete($Path, $true)
        return $true
    } catch {}

    # Step D: 仍有残留 → 改名后删
    $parent = Split-Path $Path -Parent
    $tmp = Join-Path $parent ("_killme_" + (Get-Random))
    try {
        [System.IO.Directory]::Move($Path, $tmp)
        Start-Sleep -Milliseconds 300
        [System.IO.Directory]::Delete($tmp, $true)
        return $true
    } catch {}

    # Step E: 最后手段，逐子项用 .NET 再试一次
    try {
        foreach ($item in (Get-ChildItem $Path -ErrorAction SilentlyContinue)) {
            try {
                if ($item.PSIsContainer) {
                    [System.IO.Directory]::Delete($item.FullName, $true)
                } else {
                    [System.IO.File]::SetAttributes($item.FullName, [System.IO.FileAttributes]::Normal)
                    [System.IO.File]::Delete($item.FullName)
                }
            } catch {}
        }
        [System.IO.Directory]::Delete($Path, $true)
    } catch {}
    
    return (-not (Test-Path $Path))
}

# --- 执行清理 ---
$cleanResult = Remove-DirForce -Path $OutputDir
if ($cleanResult) {
    Write-Host "  Removed: $OutputDir" -ForegroundColor Gray
} else {
    Write-Host "  WARNING: Could not fully delete $OutputDir" -ForegroundColor Yellow
    Write-Host "  (some files locked, will overwrite them)" -ForegroundColor Gray
}

# 清理临时 asar 目录
$tempAsar = Join-Path $scriptDir "_asar_temp"
$null = Remove-DirForce -Path $tempAsar

Write-Host "  Clean OK" -ForegroundColor Green
Write-Host ""

if ($CleanOnly) {
    Write-Host "Clean-only mode, exiting." -ForegroundColor Green
    exit 0
}

# ================================================================
# 3. 前端构建
# ================================================================
if (-not $SkipViteBuild) {
    Write-Host "[STEP 2] Building frontend (vite)..." -ForegroundColor Yellow
    
    Push-Location $scriptDir
    try {
        npx vite build 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        if ($LASTEXITCODE -ne 0) {
            throw "vite build failed with code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path (Join-Path $DistDir "index.html"))) {
        Write-Host "  ERROR: vite build did not produce dist/index.html" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Frontend built OK" -ForegroundColor Green
} else {
    Write-Host "[STEP 2] Skipping frontend build (using existing dist/)" -ForegroundColor Yellow
}
Write-Host ""

# ================================================================
# 4. 创建输出目录 + 复制 Electron 运行时
# ================================================================
Write-Host "[STEP 3] Creating output directory and copying Electron runtime..." -ForegroundColor Yellow

New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null

# Electron 运行必备文件清单
$electronFiles = @(
    "icudtl.dat",             # Unicode/国际化数据 (10 MB, 必需)
    "snapshot_blob.bin",      # V8 快照 (必需)
    "v8_context_snapshot.bin", # V8 上下文快照 (必需)
    "resources.pak",          # UI 资源 (必需)
    "chrome_100_percent.pak",  # UI 资源 100% DPI (必需)
    "chrome_200_percent.pak",  # UI 资源 200% DPI (必需)
    "ffmpeg.dll",             # 音视频编解码 (必需)
    "d3dcompiler_47.dll",     # Direct3D 编译器 (必需)
    "libEGL.dll",             # OpenGL ES (必需)
    "libGLESv2.dll",          # OpenGL ES v2 (必需)
    "vk_swiftshader.dll",     # Vulkan 软件渲染 (必需)
    "vulkan-1.dll",           # Vulkan 加载器 (必需)
    "vk_swiftshader_icd.json" # Vulkan 配置 (必需)
)

# 跳过无用文件清单
$skipFiles = @(
    "LICENSE", "LICENSE.*", "LICENSES.*",  # 许可证文件
    "*.lib", "*.pdb", "*.map",             # 调试符号
    "*.d.ts",                               # TypeScript 声明文件
    "*.md",                                 # 文档
    "package.json",                         # 各模块的 package.json(非顶层)
    ".npmignore", ".gitignore"
)

# 复制必需文件
foreach ($file in $electronFiles) {
    $srcPath = Join-Path $ElectronDir $file
    $dstPath = Join-Path $OutputDir $file
    if (Test-Path $srcPath) {
        Copy-Item $srcPath -Destination $dstPath -Force
        $size = (Get-Item $dstPath).Length
        Write-Host ("  Copied: " + $file.PadRight(30) + [math]::Round($size/1MB,2).ToString().PadLeft(8) + " MB") -ForegroundColor Gray
    } else {
        Write-Host "  WARNING: $file not found in Electron dist" -ForegroundColor Yellow
    }
}

# 复制 electron.exe -> 重命名为 PCLive.exe
$electronExe = Join-Path $ElectronDir "electron.exe"
if (Test-Path $electronExe) {
    Copy-Item $electronExe -Destination (Join-Path $OutputDir "PCLive.exe") -Force
    Write-Host ("  Copied: " + "electron.exe -> PCLive.exe".PadRight(30) + [math]::Round((Get-Item $electronExe).Length/1MB,2).ToString().PadLeft(8) + " MB") -ForegroundColor Gray
} else {
    Write-Host "  ERROR: electron.exe not found!" -ForegroundColor Red
    exit 1
}

# 只复制 zh-CN 和 en-US locales (节省 ~5MB)
$localesDir = Join-Path $OutputDir "locales"
New-Item -ItemType Directory -Path $localesDir -Force | Out-Null
$neededLocales = @("zh-CN.pak", "en-US.pak")
foreach ($locale in $neededLocales) {
    $src = Join-Path (Join-Path $ElectronDir "locales") $locale
    if (Test-Path $src) {
        Copy-Item $src -Destination $localesDir -Force
    }
}
Write-Host "  Copied: locales (zh-CN, en-US only)" -ForegroundColor Gray

Write-Host "  Electron runtime OK" -ForegroundColor Green
Write-Host ""

# ================================================================
# 5. 收集 app 源文件（直接写到 resources/app/ 目录，Electron 原生支持，无 asar 锁问题）
# ================================================================
Write-Host "[STEP 4] Collecting app source files..." -ForegroundColor Yellow

$appDir = Join-Path $ResourcesDir "app"

# 如果旧 app/ 目录存在，逐文件删除（容错模式）
if (Test-Path $appDir) {
    Get-ChildItem $appDir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        try { [System.IO.File]::Delete($_.FullName) } catch {}
    }
    try { [System.IO.Directory]::Delete($appDir, $true) } catch {
        Write-Host "  WARNING: Old app/ partially locked, will overwrite" -ForegroundColor Yellow
    }
}
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

# --- 5a. 复制 dist/ (Vite 前端构建产物) ---
$distExcludes = @(
    ".vite"          # Vite 缓存, 不带
    "*.map"          # source maps, 不带
)
$distSrc = $DistDir
$distDst = Join-Path $appDir "dist"
Copy-Item $distSrc -Destination $distDst -Recurse -Force
Write-Host "  Copied: dist/" -ForegroundColor Gray

# --- 5b. 复制 electron/ (主进程) ---
$electronSrcDir = $ElectronSrc
$electronDst = Join-Path $appDir "electron"
Copy-Item $electronSrcDir -Destination $electronDst -Recurse -Force
Write-Host "  Copied: electron/" -ForegroundColor Gray

# --- 5c. 复制 sources.json (外置直播源) ---
$sourcesFile = Join-Path $scriptDir "sources.json"
if (Test-Path $sourcesFile) {
    Copy-Item $sourcesFile -Destination $OutputDir -Force
    Write-Host "  Copied: sources.json" -ForegroundColor Gray
} else {
    Write-Host "  WARNING: sources.json not found, app will launch with empty source list" -ForegroundColor Yellow
}

# --- 5d. 复制 package.json (只保留必要字段) ---
$pkgJson = Get-Content (Join-Path $scriptDir "package.json") -Raw | ConvertFrom-Json
$minimalPkg = @{
    name = $pkgJson.name
    version = $pkgJson.version
    description = $pkgJson.description
    main = $pkgJson.main
}
$minimalPkg | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $appDir "package.json")
Write-Host "  Copied: package.json (minimal)" -ForegroundColor Gray

# --- 5e. 复制运行时 node_modules ---
# 自动递归收集所有传递依赖，不再手动维护列表
Write-Host "  Collecting runtime dependencies (auto-resolve)..." -ForegroundColor Gray

$nmDest = Join-Path $appDir "node_modules"
New-Item -ItemType Directory -Path $nmDest -Force | Out-Null

# 入口模块：主进程 require 的第三方包
$entryModules = @("electron-store")

function Add-DepsToQueue {
    param($pkgFile, $queue, $collected)
    if (-not (Test-Path $pkgFile)) { return }
    try {
        $pkg = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $deps = $pkg.dependencies
        if ($deps) {
            foreach ($key in $deps.PSObject.Properties.Name) {
                if (-not $collected.ContainsKey($key)) {
                    [void]$queue.Add($key)
                }
            }
        }
    } catch {}
}

# 递归收集所有传递依赖（含嵌套 node_modules）
$collected = @{}
$queue = [System.Collections.ArrayList]::new()
foreach ($m in $entryModules) { [void]$queue.Add($m) }

while ($queue.Count -gt 0) {
    $mod = $queue[0]
    $queue.RemoveAt(0)
    if ($collected.ContainsKey($mod)) { continue }
    
    $modPath = Join-Path $NodeModules $mod
    if (-not (Test-Path $modPath)) {
        Write-Host "    WARN: module not found: $mod" -ForegroundColor DarkYellow
        $collected[$mod] = $false
        continue
    }
    
    $collected[$mod] = $true
    
    # 处理根模块的直接依赖
    $pkgFile = Join-Path $modPath "package.json"
    Add-DepsToQueue $pkgFile $queue $collected
    
    # 检查嵌套 node_modules（npm 因版本冲突保留的私有副本）
    # 嵌套模块可能依赖不同于根版本的包，也需要收集
    $nestedNm = Join-Path $modPath "node_modules"
    if (Test-Path $nestedNm) {
        Get-ChildItem $nestedNm -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $nestedName = $_.Name
            if ($nestedName.StartsWith('@')) {
                # scoped packages
                Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                    $scopedName = "$nestedName/$($_.Name)"
                    if (-not $collected.ContainsKey($scopedName)) {
                        [void]$queue.Add($scopedName)
                    }
                    # Also collect their deps
                    $nestedPkg = Join-Path $_.FullName "package.json"
                    Add-DepsToQueue $nestedPkg $queue $collected
                }
            } else {
                if (-not $collected.ContainsKey($nestedName)) {
                    [void]$queue.Add($nestedName)
                }
                # Also collect their deps (may differ from hoisted version)
                $nestedPkg = Join-Path $_.FullName "package.json"
                Add-DepsToQueue $nestedPkg $queue $collected
            }
        }
    }
}

# 复制收集到的模块
$copiedModules = 0
foreach ($mod in $collected.Keys) {
    if (-not $collected[$mod]) { continue }
    $modPath = Join-Path $NodeModules $mod
    $destPath = Join-Path $nmDest $mod
    Copy-Item $modPath -Destination $destPath -Recurse -Force
    $copiedModules++
}

Write-Host ("  Runtime dependencies auto-collected: " + $copiedModules + " packages") -ForegroundColor Green

# --- 5f. 清理 node_modules 中的无运行时垃圾 ---
Write-Host "  Pruning node_modules garbage..." -ForegroundColor Gray

# 删除 .bin 目录（dev 工具包装器，运行时无用）
$binDir = Join-Path $nmDest ".bin"
if (Test-Path $binDir) {
    Remove-Item $binDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    Removed: .bin/" -ForegroundColor DarkGray
}

# 删除 TypeScript 声明文件（*.d.ts）
$dtsFiles = Get-ChildItem $nmDest -Recurse -Filter "*.d.ts" -ErrorAction SilentlyContinue
$dtsCount = ($dtsFiles | Measure-Object).Count
$dtsFiles | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "    Removed: $dtsCount *.d.ts files" -ForegroundColor DarkGray

# 删除 source maps（*.js.map）
$mapFiles = Get-ChildItem $nmDest -Recurse -Filter "*.js.map" -ErrorAction SilentlyContinue
$mapCount = ($mapFiles | Measure-Object).Count
$mapFiles | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "    Removed: $mapCount *.js.map files" -ForegroundColor DarkGray

# 删除 markdown 文档和许可证文件
Get-ChildItem $nmDest -Recurse -Filter "*.md" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $nmDest -Recurse -Filter "LICENSE*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $nmDest -Recurse -Filter "*.markdown" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "    Removed: *.md / LICENSE files" -ForegroundColor DarkGray

# 删除测试目录
Get-ChildItem $nmDest -Recurse -Directory -Filter "test" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    Removed: $($_.FullName.Replace($nmDest,'node_modules'))" -ForegroundColor DarkGray
}
Get-ChildItem $nmDest -Recurse -Directory -Filter "tests" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    Removed: $($_.FullName.Replace($nmDest,'node_modules'))" -ForegroundColor DarkGray
}

# 删除 example/example 目录
Get-ChildItem $nmDest -Recurse -Directory -Filter "examples" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem $nmDest -Recurse -Directory -Filter "example" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}

# 删除 .npmignore / .gitignore 等
Get-ChildItem $nmDest -Recurse -Filter ".npmignore" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $nmDest -Recurse -Filter ".gitignore" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $nmDest -Recurse -Filter ".travis.yml" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "  Pruning complete" -ForegroundColor Gray

Write-Host "  App source collected OK" -ForegroundColor Green

# 统计 app/ 目录大小
$appSize = (Get-ChildItem $appDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("  App directory: " + [math]::Round($appSize/1MB, 2) + " MB (unpacked)") -ForegroundColor Gray
Write-Host ""

# ================================================================
# 6. 清理临时文件
# ================================================================
Write-Host "[STEP 5] Cleaning up temp files..." -ForegroundColor Yellow

# 删除 default_app.asar (Electron 默认应用, 我们不需要)
$defaultAsar = Join-Path $ResourcesDir "default_app.asar"
if (Test-Path $defaultAsar) {
    try { [System.IO.File]::Delete($defaultAsar) } catch {}
    Write-Host "  Removed default_app.asar" -ForegroundColor Gray
}

# 也删除之前版本可能遗留的 app.asar（Electron 会优先加载 app.asar 而非 app/ 目录！）
# 若文件被锁，则尝试清空文件内容后再删，绝不留下旧 asar 干扰新版本
$oldAsar = Join-Path $ResourcesDir "app.asar"
if (Test-Path $oldAsar) {
    # 尝试1: .NET 直接删除
    try { [System.IO.File]::SetAttributes($oldAsar, [System.IO.FileAttributes]::Normal); [System.IO.File]::Delete($oldAsar) } catch {}
    if (-not (Test-Path $oldAsar)) { Write-Host "  Removed old app.asar" -ForegroundColor Gray }
    else {
        # 尝试2: 清空文件内容（绕过只读锁）→ 改名
        try {
            $fs = [System.IO.File]::OpenWrite($oldAsar)
            $fs.SetLength(0)
            $fs.Close()
            [System.IO.File]::Delete($oldAsar)
        } catch {}
        if (-not (Test-Path $oldAsar)) { Write-Host "  Removed old app.asar (truncated first)" -ForegroundColor Gray }
        else {
            # 尝试3: 仍被锁 → 改名，如果改名也失败就强制覆盖内容
            try {
                $renamed = Join-Path $ResourcesDir ("_dead_" + (Get-Random) + ".asar")
                [System.IO.File]::Move($oldAsar, $renamed)
                Write-Host "  Renamed old app.asar away" -ForegroundColor Gray
            } catch {
                # 最后的最后：覆盖内容为无效 asar（Electron 会忽略损坏的 asar，fallback 到 app/）
                try {
                    $fs = [System.IO.File]::Open($oldAsar, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                    $fs.SetLength(0)
                    $fs.Close()
                    Write-Host "  Overwrote locked app.asar with empty content (Electron will use app/ instead)" -ForegroundColor Yellow
                } catch {
                    Write-Host "  WARNING: Could not remove old app.asar — it may shadow the new app/!" -ForegroundColor Red
                }
            }
        }
    }
}

Write-Host "  Cleanup OK" -ForegroundColor Green
Write-Host ""

# ================================================================
# 8. 生成发布包信息
# ================================================================
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  BUILD COMPLETE!" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# 统计大小
$allFiles = Get-ChildItem $OutputDir -Recurse -File
$totalSize = ($allFiles | Measure-Object -Property Length -Sum).Sum
$exeSize = (Get-Item (Join-Path $OutputDir "PCLive.exe")).Length
Write-Host "  Output: $OutputDir" -ForegroundColor White
Write-Host ""

# 分类统计
$electronRuntime = $allFiles | Where-Object { $_.FullName -notlike "$ResourcesDir\*" }
$electronSize = ($electronRuntime | Measure-Object -Property Length -Sum).Sum
$appFiles = $allFiles | Where-Object { $_.FullName -like "$ResourcesDir\app\*" }
$appSize = ($appFiles | Measure-Object -Property Length -Sum).Sum

Write-Host "  Size breakdown:" -ForegroundColor White
Write-Host ("    Electron runtime:  " + [math]::Round($electronSize/1MB, 1).ToString().PadLeft(8) + " MB  (Chromium + FFmpeg + DLLs)") -ForegroundColor Gray
Write-Host ("    app/ (unpacked):   " + [math]::Round($appSize/1MB, 1).ToString().PadLeft(8) + " MB  (Frontend + Main Process + Runtime deps)") -ForegroundColor Gray
Write-Host "    ---------------------------------" -ForegroundColor DarkGray
Write-Host ("    TOTAL:             " + [math]::Round($totalSize/1MB, 1).ToString().PadLeft(8) + " MB") -ForegroundColor Green
Write-Host ""

# 列出输出文件
Write-Host "  Files in output:" -ForegroundColor White
Get-ChildItem $OutputDir -File | ForEach-Object {
    $mb = [math]::Round($_.Length/1MB, 2)
    Write-Host ("    " + $_.Name.PadRight(35) + $mb.ToString().PadLeft(8) + " MB") -ForegroundColor Gray
}
Write-Host "    resources/app/ (unpacked directory)" -ForegroundColor Gray
Write-Host ""

# 使用提示
Write-Host "  To distribute: compress the entire '$OutputName' folder into a .zip" -ForegroundColor Cyan
Write-Host "  To run:        double-click PCLive.exe" -ForegroundColor Cyan
Write-Host ""

# ================================================================
# 9. 生成版本信息文件
# ================================================================
$buildInfo = @"
Build Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Node.js:    $nodeVer
Electron:   28.3.3
App:        $($pkgJson.name) v$($pkgJson.version)
Mode:       Portable (no install required)
"@
$buildInfo | Out-File (Join-Path $OutputDir "BUILD_INFO.txt") -Encoding utf8

Write-Host "  BUILD_INFO.txt written" -ForegroundColor Gray
Write-Host "  Done!" -ForegroundColor Green