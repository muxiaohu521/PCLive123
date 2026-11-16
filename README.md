# PCLive v1.4.0 - PC 直播客户端

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-muxiaohu521%2FPCLive123-green.svg)](https://github.com/muxiaohu521/PCLive123)

基于 **Electron + Vue 3 + TypeScript** 的桌面直播播放器，支持 M3U / M3U8 / JSON / TXT 等多种直播源格式，内置 HLS / FLV 流媒体播放能力。

---

## 功能特性

### 直播播放
- 支持 **M3U8 (HLS)**、**FLV**、**MP4**、**TS**、**MKV**、**DASH (.mpd)**、**WebTorrent (磁力/.torrent)** 等流媒体格式
- 基于 ArtPlayer 播放器内核 + 可插拔播放引擎体系（`player-plugins`），集成 HLS.js、mpegts.js、dashjs、WebTorrent、原生 video、纯音频六类引擎
- **解码模式切换**：自动 / 硬解 / 软解 / MPV / VLC / FFmpeg 解码，适配不同硬件环境
- 频道线路切换（多线路自动切换，播放失败自动切下一个线路）
- **本地直播源模块**：CCTV+卫视频道，每频道多线路，支持线路独立编辑/增删
- 音量控制、静音、暂停/播放
- 键盘快捷键操作（上下键切频道、左右键切线路、空格播放/暂停、数字键选台等）

### 本地视频播放
- 支持扫描本地目录，添加本地视频/音频文件到播放列表
- 支持 **MP4、MKV、AVI、MOV、WMV、FLV、WebM、TS、M2TS** 等主流视频格式
- 支持 **MP3、M4A、AAC、WAV、FLAC、OPUS、WMA** 等音频格式（纯音频播放模式）
- 三种播放模式：**单曲循环** / **顺序播放** / **随机播放**

### 外部播放器（MPV / VLC）
- 支持将当前播放流推送到 **MPV** / **VLC** 独立窗口播放
- 在「设置」中配置 MPV / VLC 可执行文件路径，并支持一键检测可用性
- 作为解码模式之一：自动模式下软解失败时按 **MPV → VLC → FFmpeg** 顺序回退

### 官网直播源（网页源）
- 内置大量频道列表，覆盖 CCTV1~17、卫视频道、地方频道
- 通过 Electron BrowserWindow 加载官网页面，自动注入控制面板（`YspPlayerBar`）
- 播放控制栏功能：**上一节目 / 下一节目**、**播放/暂停**
- 支持添加、编辑、删除自定义央视频频道
- 频道数据存储在 `data/ysp_channels.json`
- 后台主进程 `ysp_handler.js` 负责页面渲染、DOM 分析、CDN 流地址提取

### 直播源管理
- 内置 **默认直播源**（JSON / M3U 格式），覆盖主流 TVBox 线路
- 支持**添加、编辑、删除**自定义直播源
- 支持**导入/导出**本地 M3U / M3U8 / JSON / TXT 文件
- **连通性测试**：批量检测直播源可用性（全部测试 / 仅未解析模式）
- 自动缓存解析结果，按频道数量智能排序
- AList 源爬虫（`SpiderService`），支持从 AList 网盘自动抓取直播源

### 频道浏览
- 频道列表面板（Tab 键呼出），支持**搜索过滤**
- 按分组/分类标签切换浏览
- 显示当前播放信息（频道名、分组名）
- 子线路列表面板（多源切换）

### DLNA 投屏
- 自动扫描局域网内 **DLNA / UPnP** 设备
- 支持将当前播放流推送到电视/投屏设备
- 投屏控制：播放、暂停、停止、音量调节

### 悬浮窗
- 支持**画中画、悬浮窗**模式，将视频以独立小窗口显示在其他应用之上
- WebRTC 视频镜像流（`useMirrorStream`），主窗口与悬浮窗间同步

### 录制与下载
- **录屏**：从当前播放画面直录，输出 WebM，切频道/线路自动跟随录制，6 小时自动停止
- **流下载**：HLS 按分片缓存下载后使用内置 FFmpeg 无损合并，6 小时自动停止
- 基于统一流接口（`PlaybackStreamHub`），下载/录屏/悬浮窗/投屏/画中画按需消费同一路流

### URL 嗅探
- 输入网页 URL 自动嗅探页面中的视频/流媒体链接
- 支持从常见视频网站提取播放地址
- 嗅探结果可直接播放

### 高级网络能力（Electron 主进程）
- **DNS-over-HTTPS + hosts 映射**：自定义域名解析，解决 DNS 污染
- **全局 CookieJar**：Node.js 与 Electron net 层共享 Cookie，保持登录态
- **智能编码检测**：自动识别 UTF-8 / GBK 编码内容
- **CORS 绕过**：主进程注入 CORS 头，保证跨域流媒体正常播放
- **HTTP 代理支持**：支持配置代理服务器
- **流媒体探针**：HEAD/GET 请求自动检测流格式（M3U8/FLV/MP4）
- **重定向追踪**：自动跟随 HTTP 301/302 重定向，解决一次性 token 源问题
- **M3U8 净化器**（`m3u8Purifier`）：自动过滤无效/广告片段

### 广告过滤
- 内置广告过滤规则（`ad-filter-rules.json`）
- `AdFilter` 服务实时拦截广告请求
- 支持自定义广告过滤规则

### 字幕支持
- 外挂字幕自动加载（SRT / ASS / VTT 格式）
- 字幕样式自定义：字号、颜色、背景

### 数据安全
- 支持 **AES-CBC / AES-ECB 解密**自动解析加密直播源内容
- JSON comment-stripping（兼容非标准 JSON 格式）
- Base64/steganography 内容提取（FindResult 解密）

### 设置面板
- 播放设置：默认音量、缓冲区大小、解码模式（自动/硬解/软解/MPV/VLC/FFmpeg）
- FFmpeg / MPV / VLC 路径配置与可用性检测
- 字幕设置：字号、颜色、背景
- 网络设置：HTTP 代理、请求超时
- 广告过滤规则管理

### 便携版构建
- **Python GUI 打包工具**（`scripts/build_gui.py`）：Tkinter 图形界面，一站式配置 Node.js 路径、构建参数，实时日志输出
- `scripts/build_portable.ps1` 一键构建**免安装便携版**，输出为 `PCLive-portable/PCLive/` 目录
- 构建产物采用 `resources/app/` 目录模式（非 asar 打包），彻底避免 Windows 文件锁定问题
- 自动清理旧产物、收集运行时依赖、裁剪 node_modules 垃圾文件
- 支持 NSIS 安装版打包（`electron-builder`），输出 `setup.exe`

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron 45 |
| 前端框架 | Vue 3 (Composition API) + TypeScript |
| 状态管理 | Pinia |
| UI 组件库 | Element Plus |
| 视频播放 | ArtPlayer + 插件引擎体系（HLS.js / mpegts.js / dashjs / WebTorrent / 原生 / 音频） |
| 构建工具 | Vite 5 |
| 持久化存储 | LocalStorage + electron-store |
| 流处理 | FFmpeg（内置 + 可选外置） |
| 外部播放器 | MPV / VLC（可选） |
| 投屏 | DLNA / UPnP |
| WebRTC | 悬浮窗镜像流 |

---

## 项目结构

```
PCLive/
├── electron/                     # Electron 主进程
│   ├── main.js                   # 主进程入口（窗口管理、HTTP请求、DNS、加解密、CookieJar）
│   ├── preload.js                # 预加载脚本（IPC 桥接，安全暴露 API）
│   ├── dlna.js                   # DLNA/UPnP 投屏服务
│   ├── tvlive.js                 # TVLive 投屏服务（局域网设备发现/ADB）
│   ├── sniffer.js                # URL 嗅探器（网页视频提取）
│   ├── sniffer-preload.js        # 嗅探器预加载脚本
│   ├── m3u8Purifier.js           # M3U8 净化器（过滤无效片段）
│   ├── ysp_handler.js            # 央视频流处理
│   ├── ua.js                     # 浏览器 User-Agent 定义
│   └── shared/
│       └── ad-filter-rules.json  # 广告过滤规则
├── src/                          # Vue 渲染进程源码
│   ├── App.vue                   # 根组件（布局、键盘事件、频道/线路导航）
│   ├── main.ts                   # 入口（挂载 Vue、Pinia、Element Plus）
│   ├── components/               # UI 组件
│   │   ├── TitleBar.vue          # 自定义标题栏（窗口控制、源名称显示）
│   │   ├── VideoPlayer.vue       # 视频播放器（ArtPlayer 封装，多格式支持）
│   │   ├── video-player/         # 播放器核心模块（引擎调度、硬解/软解、自动回退、外部播放器、FFmpeg 解码、字幕、看门狗）
│   │   ├── ChannelList.vue       # 频道列表面板（搜索、分组切换）
│   │   ├── SourceManager.vue     # 直播源管理面板（增删改、导入导出）
│   │   ├── LocalChannelsList.vue # 本地直播源面板
│   │   ├── LivesPanel.vue        # 子线路列表面板
│   │   ├── LocalVideoList.vue    # 本地视频/音频列表
│   │   ├── ToolsDialog.vue       # 工具对话框（连通性测试、URL嗅探、IP查询、录屏、下载、投屏）
│   │   ├── DlnaPanel.vue         # DLNA 投屏面板
│   │   ├── YspPanel.vue          # 央视频面板
│   │   ├── YspPlayerBar.vue      # 央视频播放控制栏
│   │   ├── SyncTVPanel.vue       # TVLive 同步投屏面板
│   │   ├── TaskStatusBar.vue     # 任务状态栏（录屏/下载等后台任务进度）
│   │   └── SettingsPanel.vue     # 设置面板（播放、字幕、网络、广告过滤）
│   ├── composables/              # Vue Composables
│   │   ├── usePlaybackStream.ts  # 统一流接口应用层绑定（下载/投屏直链）
│   │   ├── useRecorder.ts        # 主窗口直录（MediaRecorder，切频道跟随）
│   │   ├── useMirrorStream.ts    # WebRTC 镜像流（悬浮窗视频同步）
│   │   ├── useSubtitle.ts        # 外挂字幕处理
│   │   └── useInputContextMenu.ts # 输入框右键菜单
│   ├── player-plugins/           # 播放引擎插件体系（按格式调度最优引擎）
│   │   ├── index.ts              # 插件统一入口（注册全部内置引擎）
│   │   ├── registry.ts           # 插件注册中心（按格式查找/选择引擎）
│   │   ├── base.ts               # 插件基类
│   │   ├── types.ts              # 插件类型定义
│   │   └── plugins/              # 内置引擎插件
│   │       ├── native.plugin.ts  # 原生 video 引擎
│   │       ├── audio.plugin.ts   # 纯音频引擎
│   │       ├── hls.plugin.ts     # HLS 引擎（hls.js）
│   │       ├── mpegts.plugin.ts  # FLV/TS 引擎（mpegts.js）
│   │       ├── dash.plugin.ts    # DASH 引擎（dashjs）
│   │       └── webtorrent.plugin.ts # BT 引擎（WebTorrent）
│   ├── store/
│   │   └── index.ts              # Pinia Store（全局状态、频道/线路排序、源管理）
│   ├── tools/                    # 工具箱模块化系统（按需懒加载）
│   │   ├── registry.ts           # 工具注册表（tab 元数据与懒加载）
│   │   ├── types.ts              # 工具类型定义
│   │   ├── connectivity/         # 连通性测试
│   │   ├── sniffer/              # URL 嗅探
│   │   ├── geoip/                # IP 查询
│   │   ├── recording/            # 录屏
│   │   ├── download/             # 下载
│   │   ├── cast/                 # 投屏
│   │   └── shared/               # 公共工具（格式化、shell、样式）
│   ├── services/                 # 业务服务层
│   │   ├── ChannelService.ts     # 频道服务（数据获取、解密、解析）
│   │   ├── AudioPlayer.ts        # 音频播放器（纯音频模式）
│   │   ├── FormatDetector.ts     # 流格式检测器
│   │   ├── NetworkInterceptor.ts # 网络拦截器
│   │   ├── SpiderService.ts      # AList 爬虫服务
│   │   ├── PlaybackStreamHub.ts  # 统一流接口（下载/录屏/悬浮窗/投屏消费者调度）
│   │   └── StreamSessionManager.ts # 流会话管理器
│   ├── models/
│   │   ├── LiveChannelItem.ts    # 频道/分组/源数据模型
│   │   └── index.ts              # 模型导出
│   ├── utils/                    # 工具函数
│   │   ├── TxtParser.ts          # M3U/TXT/JSON 多格式解析器
│   │   ├── ThreadPool.ts         # 线程池 / 并发控制工具
│   │   ├── SourceFileService.ts  # 源文件导入导出服务
│   │   ├── SourceCrawler.ts      # 直播源爬虫
│   │   ├── AdFilter.ts           # 广告过滤器
│   │   ├── GeoService.ts         # 地理位置服务
│   │   ├── SubtitleParser.ts     # 字幕解析器（SRT/ASS/VTT）
│   │   ├── m3uConverter.ts       # M3U 格式转换器
│   │   ├── md5.ts                # MD5 计算工具
│   │   ├── webviewFillScreen.ts  # Webview 全屏填充工具
│   │   └── logger.ts             # 日志工具
│   ├── views/
│   │   └── FloatView.vue         # 悬浮窗视图
│   ├── constants/
│   │   └── index.ts              # 常量定义
│   └── types/
│       └── global.d.ts           # 全局类型声明
├── data/                         # 数据文件（全部跟踪版本控制）
│   ├── verified_channels.json    # 本地直播源
│   ├── sources.json              # 远程直播源配置
│   ├── ysp_channels.json         # 央视频频道配置
│   ├── cache/                    # 原始直播源缓存
│   └── ffmpeg/                   # 内置 FFmpeg（ffmpeg.exe / ffprobe.exe）
├── scripts/                      # 构建脚本
│   ├── build_gui.py              # Python GUI 打包工具（Tkinter 弹窗，含 Node.js 下载）
│   ├── build_portable.ps1        # 便携版一键构建脚本（自动收集依赖、裁剪、打包）
│   └── 启动构建工具.bat          # 一键启动 GUI 打包工具
├── dist/                         # Vite 构建产物
├── index.html                    # HTML 入口
├── vite.config.ts                # Vite 配置
├── tsconfig.json                 # TypeScript 配置
├── tsconfig.node.json            # Node 端 TS 配置
├── env.d.ts                      # 环境类型声明
├── package.json                  # 项目配置与依赖
├── install.bat                   # 依赖安装脚本
├── dev.bat                       # 开发模式启动脚本
├── run.bat                       # 生产模式启动脚本
```

---

## 快速开始

### 环境要求

- **Node.js** >= 18
- **npm** >= 9
- **FFmpeg**：项目已内置（`data/ffmpeg/`），也可在设置中自定义路径；用于 FFmpeg 解码 / 软解转码 / 下载合并

### 安装依赖

```bash
# 双击 install.bat
# 或命令行：
npm install
```

### 开发模式

```bash
# 双击 dev.bat（同时启动 Vite 开发服务器 + Electron）
# 或命令行：
npm run electron:dev
```

### 生产模式运行

```bash
# 双击 run.bat（先构建前端，再启动 Electron）
# 或命令行：
npm run build
npx electron .
```

### 构建便携版

#### 方式一：Python GUI 打包工具（推荐）

```bash
# 双击 scripts/启动构建工具.bat，或命令行运行：
python scripts/build_gui.py
```

GUI 界面功能：
- **Node.js 管理**：自动检测系统安装的 Node.js、浏览指定路径、一键下载 Node.js LTS 到 `tools/node/`
- **构建选项**：选择便携版 / NSIS 安装版、自定义输出文件夹名称、跳过 Vite 构建
- **实时日志**：彩色日志输出，构建进度一目了然
- **输出管理**：构建完成后一键打开输出目录

#### 方式二：PowerShell 脚本（命令行）

```powershell
# 完整构建（先 Vite 打包前端，再收集 Electron 运行时和依赖）：
powershell -ExecutionPolicy Bypass -File scripts/build_portable.ps1

# 跳过前端构建（使用已有 dist/ 目录，仅重打包）：
powershell -ExecutionPolicy Bypass -File scripts/build_portable.ps1 -SkipViteBuild

# 仅清理旧产物：
powershell -ExecutionPolicy Bypass -File scripts/build_portable.ps1 -CleanOnly
```

**构建流程：**
1. **清理旧产物** — 强制终止 PCLive/Electron 进程，删除旧的 `PCLive-portable/` 目录
2. **依赖检查/安装**（GUI 模式） — 如 `node_modules/` 不存在，自动执行 `npm install`
3. **Vite 打包前端** — 编译 Vue/TypeScript 源码到 `dist/`
4. **复制 Electron 运行时** — 复制 `electron.exe`（重命名为 `PCLive.exe`）、`ffmpeg.dll`、Chromium 资源文件等
5. **收集应用源码** — 将 `dist/`、`electron/`、运行时 node_modules 依赖写入 `resources/app/`
6. **裁剪冗余** — 删除 `.d.ts`、`.js.map`、`.md`、`test/` 等运行时无用文件
7. **生成版本信息** — 写入 `BUILD_INFO.txt`

**产物结构：**
```
PCLive-portable/PCLive/
├── PCLive.exe              # Electron 可执行文件
├── ffmpeg.dll              # 音视频编解码
├── d3dcompiler_47.dll      # Direct3D 编译器
├── libEGL.dll              # OpenGL ES 接口
├── libGLESv2.dll           # OpenGL ES 渲染
├── vk_swiftshader.dll      # Vulkan 软件渲染
├── vulkan-1.dll            # Vulkan 加载器
├── vk_swiftshader_icd.json # Vulkan 配置
├── icudtl.dat              # 国际化数据
├── resources.pak / chrome_*.pak   # Chromium UI 资源
├── snapshot_blob.bin / v8_context_snapshot.bin  # V8 快照
├── locales/                # 语言包（zh-CN, en-US 精简）
├── data/                   # 数据文件
│   ├── sources.json        # 默认直播源配置
│   ├── verified_channels.json  # 本地直播源
│   ├── ysp_channels.json   # 央视频频道配置
│   └── cache/              # 原始直播源缓存
├── BUILD_INFO.txt          # 构建信息
└── resources/app/          # 应用程序代码（目录模式，非 asar）
    ├── dist/               # 前端构建产物
    ├── electron/           # 主进程脚本
    ├── node_modules/       # 运行时依赖（已裁剪）
    └── package.json        # 最小化包配置
```

---

## 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `↑` / `↓` | 切换上/下一个频道 |
| `←` / `→` | 切换上/下一线路 |
| `0-9` | 快速跳转到对应编号频道 |
| `空格` | 播放 / 暂停 |
| `C` | 展开/收起频道列表 |
| `K` | 打开/关闭本地直播源列表 |
| `O` | 打开/关闭官网直播源（央视频） |
| `V` | 本地视频列表 |
| `L` | 子线路列表面板 |
| `Ctrl+Shift+S` | 直播源管理面板 |
| `Ctrl+Shift+X` | 工具面板（连通性测试 / URL嗅探 / IP查询 / 录屏 / 下载 / 投屏） |
| `Ctrl+Shift+D` | DLNA 投屏面板 |
| `Ctrl+,` | 设置面板 |
| `Esc` | 关闭所有侧边面板 |
| `F5` | 强制重新加载频道数据 |
| `F11` | 全屏切换 |

---

## 直播源格式说明

### 本地直播源（verified_channels.json）— v1.2 新增

每条频道支持多线路，频道按 CCTV 数字序 + 卫视拼音序排列：

```json
{
  "lives": [
    {
      "name": "CCTV1",
      "urls": [
        "http://example.com/cctv1_hd.m3u8",
        "http://example.com/cctv1_sd.m3u8"
      ]
    },
    {
      "name": "北京卫视",
      "urls": [
        "http://example.com/btv1.m3u8"
      ]
    }
  ]
}
```

### M3U 格式（推荐）

```m3u
#EXTM3U
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV-1" tvg-logo="https://..." group-title="央视频道",CCTV-1 综合
http://example.com/cctv1.m3u8
```

### JSON 格式

支持 TVBox 格式、自定义分组格式：

```json
{
  "lives": [
    {
      "name": "主线路",
      "url": "http://example.com/tv.json",
      "ua": "Mozilla/5.0"
    }
  ],
  "hosts": ["example.com=1.2.3.4"],
  "proxy": { "host": "127.0.0.1", "port": 1080 }
}
```

### TXT 格式

```
频道名称,http://example.com/stream.m3u8
```

---

## 更新日志

### v1.4.0
- 官网直播源模块新增 **视频流解析**功能，新增地方频道
- 新增 **录屏/下载**功能
- 优化硬解、软解逻辑，内置 FFmpeg 解码

### v1.3.0
- 新增 **MPV / VLC 外部播放器**支持，可配置路径与一键检测，自动模式下作为软解回退方案
- 工具箱新增 **IP 查询**标签页
- 新增 **Webview 全屏填充**工具（`webviewFillScreen.ts`）
- 新增 **官网直播源模块**，浏览器网页加载播放官方频道，内置CCTV+卫视频道

### v1.2.0
- 新增 **本地直播源模块**（`LocalChannelsList.vue`）：CCTV+卫视频道，每频道多线路
- 本地直播源支持 **逐线路编辑**：添加/修改/删除单条 URL，拖拽移动弹窗，暗色主题
- 新增 **线路切换**快捷键 `←` / `→`，播放失败自动切换下一线路
- 频道排序：CCTV 按数字序、卫视按拼音序，多位置自动保持排序
- 数据目录 `data/` 完整纳入版本控制（含原始直播源缓存）
- 优化 `.gitignore`：移除 `cache/` 误拦规则，窄化 `*.local` / `_x*` 等通配符

### v1.1.0
- 新增 **DLNA/UPnP 投屏**功能，支持局域网设备发现与投屏控制
- 新增 **悬浮窗**模式（画中画），支持 WebRTC 视频镜像流同步
- 新增 **本地视频/音频播放**功能，支持多种音视频格式
- 新增 **URL 嗅探**功能，可从网页提取视频链接
- 新增 **广告过滤**功能（AdFilter + 内置规则）
- 新增 **外挂字幕**支持（SRT/ASS/VTT），字幕样式可自定义
- 新增 **外置 FFmpeg 解码**模式选项
- 新增 **设置面板**：播放、字幕、网络、广告过滤统一管理
- 新增 **M3U8 净化器**：自动过滤无效/广告片段
- 新增 **全局 CookieJar**：Node.js 与 Electron net 层共享 Cookie
- 新增 **AList 爬虫**服务
- 新增 **音频播放器**模式（纯音频播放）

### v1.0.0
- 初始版本，基础直播播放与管理功能

---

## 许可

本项目基于 [MIT License](LICENSE) 开源，Copyright © 2025 PCLive。

**第三方依赖许可：**

| 依赖 | 许可证 |
|------|--------|
| Electron | MIT |
| Vue 3 / Pinia | MIT |
| Element Plus | MIT |
| ArtPlayer | MIT |
| HLS.js | Apache 2.0 |
| mpegts.js | MIT |
| Vite | MIT |
| FFmpeg（内置） | LGPL v2.1+ |