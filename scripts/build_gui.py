#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PCLive1.3 EXE 打包工具 (GUI)
- 自动检测/下载 Node.js
- 支持便携版 (解压即用) 和 NSIS 安装版
- 参考 TVLive1.1 build_gui.py 架构
"""

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
import subprocess
import threading
import os
import json
import queue
import zipfile
import shutil
import ssl
import urllib.request
import urllib.error

VERSION = "1.0.0"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
TOOLS_DIR = os.path.join(PROJECT_ROOT, 'tools')
NODE_TOOLS_DIR = os.path.join(TOOLS_DIR, 'node')
CACHE_FILE = os.path.join(SCRIPT_DIR, '.build_gui_cache.json')

PORTABLE_SCRIPT = os.path.join(SCRIPT_DIR, 'build_portable.ps1')
NODE_MODULES = os.path.join(PROJECT_ROOT, 'node_modules')
DIST_DIR = os.path.join(PROJECT_ROOT, 'dist')

NODE_VERSION = "20.18.1"
NODE_INDEX_URL = "https://nodejs.org/download/release/index.json"
BUILD_TYPES = {
    "portable": {
        "desc": "便携版 (解压即用, 复制 Electron + dist)",
        "output": os.path.join(PROJECT_ROOT, "PCLive-portable"),
    },
    "nsis": {
        "desc": "NSIS 安装版 (.exe 安装包, electron-builder)",
        "output": os.path.join(PROJECT_ROOT, "PCLive-portable"),
    },
}


def find_nodejs():
    """自动检测 Node.js 路径 (返回 bin 目录)"""
    candidates = []

    # PATH 中的 node
    node_path = shutil.which('node')
    if node_path:
        candidates.append(os.path.dirname(node_path))

    # 常见安装路径
    search_roots = [
        os.path.join(os.environ.get('ProgramFiles', 'C:\\Program Files'), 'nodejs'),
        os.path.join(os.environ.get('ProgramFiles(x86)', 'C:\\Program Files (x86)'), 'nodejs'),
        os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs', 'nodejs'),
        os.path.join(os.environ.get('APPDATA', ''), 'npm'),
        'C:\\Program Files\\nodejs',
        'C:\\nodejs',
        NODE_TOOLS_DIR,
    ]

    for root in search_roots:
        if not os.path.isdir(root):
            continue
        # 支持 nodejs 根目录 或 tools/node/node-vX.X.X-win-x64/ 结构
        for dirpath, dirs, files in os.walk(root):
            depth = dirpath.replace(root, '').count(os.sep)
            if depth > 3:
                dirs.clear()
                continue
            if os.path.isfile(os.path.join(dirpath, 'node.exe')):
                candidates.append(dirpath)
                break

    # 去重 + 验证
    seen = set()
    result = []
    for c in candidates:
        c = os.path.normpath(c)
        if c not in seen and os.path.isfile(os.path.join(c, 'node.exe')):
            seen.add(c)
            ver = _get_node_version(c)
            result.append((c, ver))

    result.sort(key=lambda x: _version_key(x[1]), reverse=True)
    return result


def _get_node_version(bin_dir):
    node_exe = os.path.join(bin_dir, 'node.exe')
    if not os.path.isfile(node_exe):
        return "?"
    try:
        out = subprocess.check_output([node_exe, '--version'], text=True, timeout=5, errors='replace')
        return out.strip().lstrip('v')
    except Exception:
        return "?"


def _version_key(v):
    try:
        parts = v.replace('v', '').split('.')
        return tuple(int(x) for x in parts if x.isdigit())
    except Exception:
        return (-1,)


def _find_npm(bin_dir):
    npm_exe = os.path.join(bin_dir, 'npm.cmd')
    if os.path.isfile(npm_exe):
        return npm_exe
    npm_exe2 = os.path.join(bin_dir, 'npm')
    if os.path.isfile(npm_exe2):
        return npm_exe2
    npm_path = shutil.which('npm')
    return npm_path


def download_nodejs(dest_parent, progress_cb=None):
    """下载 Node.js 到指定目录"""
    os.makedirs(dest_parent, exist_ok=True)
    zip_path = os.path.join(dest_parent, 'node.zip')

    if progress_cb:
        progress_cb(0, "正在查询 Node.js 最新 LTS 版本...")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    # 尝试获取最新 LTS
    node_url = f"https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-win-x64.zip"
    try:
        req = urllib.request.Request(NODE_INDEX_URL, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urllib.request.urlopen(req, context=ctx, timeout=15)
        index = json.loads(resp.read().decode('utf-8'))
        lts = next((e for e in index if e.get('lts') and 'win-x64-zip' in e.get('files', [])), None)
        if lts:
            node_url = f"https://nodejs.org/dist/{lts['version']}/node-{lts['version']}-win-x64.zip"
            if progress_cb:
                progress_cb(1, f"找到最新 LTS: {lts['version']}")
    except Exception:
        pass

    if progress_cb:
        progress_cb(2, "正在下载 Node.js (约 30MB)...")

    req = urllib.request.Request(node_url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urllib.request.urlopen(req, context=ctx, timeout=600)
    except Exception as e:
        raise RuntimeError(f"下载失败: {e}\nURL: {node_url}")

    total_size = int(resp.headers.get('Content-Length', 0))
    with open(zip_path, 'wb') as f:
        downloaded = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            if progress_cb and total_size:
                pct = 2 + int(93 * downloaded / total_size)
                progress_cb(pct, f"下载中... {downloaded // 1024 // 1024}MB / {total_size // 1024 // 1024}MB")

    if progress_cb:
        progress_cb(97, "解压中...")

    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(dest_parent)

    os.remove(zip_path)

    # 找到解压后的 node.exe
    for dirpath, dirs, files in os.walk(dest_parent):
        if 'node.exe' in files:
            return dirpath
    if os.path.isfile(os.path.join(dest_parent, 'node.exe')):
        return dest_parent
    return None


def load_cache():
    if os.path.isfile(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_cache(data):
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


class BuildRunner(threading.Thread):
    def __init__(self, node_bin, build_type, skip_vite, clean_first, output_name, log_cb, done_cb, progress_cb):
        super().__init__(daemon=True)
        self.node_bin = node_bin
        self.build_type = build_type
        self.skip_vite = skip_vite
        self.clean_first = clean_first
        self.output_name = output_name
        self.log_cb = log_cb
        self.done_cb = done_cb
        self.progress_cb = progress_cb
        self._cancel = False
        self._proc = None

    def cancel(self):
        self._cancel = True
        if self._proc:
            try:
                self._proc.kill()
            except Exception:
                pass

    def _npm(self, *args):
        npm = _find_npm(self.node_bin)
        if npm:
            return [npm] + list(args)
        return [os.path.join(self.node_bin, 'node.exe'), 'npm'] + list(args)

    def _npx(self, *args):
        npx = os.path.join(self.node_bin, 'npx.cmd')
        if not os.path.isfile(npx):
            npx = os.path.join(self.node_bin, 'npx')
        if os.path.isfile(npx):
            return [npx] + list(args)
        return [os.path.join(self.node_bin, 'node.exe'), os.path.join(self.node_bin, 'npx.cmd')] + list(args)

    def run(self):
        env = os.environ.copy()
        env['PATH'] = os.pathsep.join(filter(None, [
            self.node_bin,
            os.path.join(PROJECT_ROOT, 'node_modules', '.bin'),
            env.get('PATH', ''),
        ]))

        # 收集所有构建步骤
        steps = []

        # 0. 检查 npm 是否可用
        npm_path = _find_npm(self.node_bin)
        if not npm_path:
            self._log("[错误] npm 未找到，请确保 Node.js 安装完整", "error")
            self.done_cb(False, "npm 未找到")
            return

        # 如果 node_modules 不存在，先 install
        if not os.path.isdir(NODE_MODULES):
            steps.append(("安装依赖 (npm install)", self._npm('install')))

        # 1. 前端构建
        if not self.skip_vite:
            vite_output = os.path.join(DIST_DIR, 'index.html')
            if not os.path.isfile(vite_output) or self.clean_first:
                steps.append(("前端构建 (vite build)", self._npx('vite', 'build')))

        # 2. 打包
        if self.build_type == 'portable':
            ps_args = ['-ExecutionPolicy', 'Bypass', '-File', PORTABLE_SCRIPT, '-OutputName', self.output_name]
            if self.skip_vite:
                ps_args.append('-SkipViteBuild')
            steps.append(("便携版打包 (build_portable.ps1)", [
                'powershell', '-NoProfile'
            ] + ps_args))
        elif self.build_type == 'nsis':
            steps.append(("NSIS 安装包 (electron-builder)", self._npx('electron-builder', '--win')))

        # 打印头部信息
        self._log("=" * 60, "header")
        self._log(f"PCLive1.3 打包工具 v{VERSION}", "header")
        self._log(f"构建类型: {BUILD_TYPES[self.build_type]['desc']}", "header")
        self._log(f"Node.js:  {self.node_bin}  (v{_get_node_version(self.node_bin)})", "header")
        self._log(f"跳过前端: {'是' if self.skip_vite else '否'}", "header")
        if self.build_type == 'portable':
            self._log(f"输出名称: {self.output_name}", "header")
        self._log("=" * 60, "header")

        total_steps = len(steps)
        for idx, (name, cmd) in enumerate(steps):
            if self._cancel:
                self._log("\n[取消] 用户中断", "error")
                self.done_cb(False, "用户取消")
                return

            self._log(f"\n>>> [{idx + 1}/{total_steps}] {name}", "info")
            self._log(f"    CMD: {' '.join(cmd)}", "info")

            try:
                self._proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    env=env,
                    cwd=PROJECT_ROOT,
                    bufsize=1,
                )

                q = queue.Queue()

                def _read_stdout():
                    try:
                        for line in iter(self._proc.stdout.readline, ''):
                            q.put(line)
                    except Exception:
                        pass
                    finally:
                        q.put(None)

                reader = threading.Thread(target=_read_stdout, daemon=True)
                reader.start()

                batch = []

                def _flush():
                    nonlocal batch
                    if batch and self.log_cb:
                        self._log('\n'.join(batch), 'normal')
                        batch = []

                while True:
                    try:
                        line = q.get(timeout=0.3)
                    except queue.Empty:
                        if self._cancel:
                            try:
                                self._proc.kill()
                            except Exception:
                                pass
                            reader.join(timeout=2)
                            _flush()
                            self._log("\n[取消] 用户中断", "error")
                            self.done_cb(False, "用户取消")
                            return
                        _flush()
                        continue

                    if line is None:
                        _flush()
                        break

                    line = line.rstrip()
                    if not line:
                        continue

                    tag = "normal"
                    upper = line.upper()
                    if any(k in upper for k in ("ERROR", "FAILED", "EXCEPTION", "BUILD FAILED")):
                        tag = "error"
                    elif any(k in upper for k in ("WARNING", "WARN")):
                        tag = "warning"
                    elif any(k in upper for k in ("SUCCESS", "BUILD SUCCESSFUL", "BUILD SUCCESS", "COMPLETED")):
                        tag = "success"
                    elif any(k in upper for k in ("[STEP", "========================================")):
                        tag = "info"

                    batch.append(line)
                    if len(batch) >= 20 or tag != "normal":
                        _flush()

                _flush()
                reader.join(timeout=2)
                self._proc.wait()

                if self._proc.returncode != 0:
                    self._log(f"\n[失败] {name} 返回码: {self._proc.returncode}", "error")
                    self.done_cb(False, f"{name} 失败 (返回码 {self._proc.returncode})")
                    return

            except Exception as e:
                self._log(f"\n[异常] {e}", "error")
                self.done_cb(False, str(e))
                return

        # 构建完成后的检查
        self._log("=" * 60, "header")

        if self.build_type == 'portable':
            output_dir = os.path.join(PROJECT_ROOT, "PCLive-portable", self.output_name)
        else:
            output_dir = BUILD_TYPES[self.build_type]['output']

        if os.path.isdir(output_dir):
            self._log(f"[成功] 打包完成!", "success")
            self._log(f"  输出目录: {output_dir}", "success")
            # 统计文件数
            file_count = sum(1 for _ in _walk_files(output_dir))
            self._log(f"  文件数: {file_count}", "success")
        else:
            self._log(f"[注意] 输出目录未找到: {output_dir}", "warning")
            self._log("  请检查构建日志确认是否成功", "warning")

        self._log("=" * 60, "header")
        self.done_cb(True, "打包完成")

    def _log(self, text, tag="normal"):
        if self.log_cb:
            self.log_cb(text, tag)


def _walk_files(root):
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            yield os.path.join(dirpath, f)


class BuildGUI(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"PCLive1.3 EXE 打包工具 v{VERSION}")
        self.geometry("860x720")
        self.minsize(700, 580)
        self.resizable(True, True)

        self.cache = load_cache()
        self.node_path = tk.StringVar(value=self.cache.get('node_path', ''))
        self.build_type_var = tk.StringVar(value=self.cache.get('build_type', 'portable'))
        self.output_name_var = tk.StringVar(value=self.cache.get('output_name', 'PCLive'))
        self.skip_vite_var = tk.BooleanVar(value=self.cache.get('skip_vite', False))
        self.clean_var = tk.BooleanVar(value=False)

        self.runner = None
        self._build_ui()
        self._auto_detect()

    def _build_ui(self):
        main_frame = ttk.Frame(self, padding=10)
        main_frame.pack(fill=tk.BOTH, expand=True)

        # ===== Node.js 环境 =====
        env_frame = ttk.LabelFrame(main_frame, text="运行环境", padding=8)
        env_frame.pack(fill=tk.X, pady=(0, 8))

        row0 = ttk.Frame(env_frame)
        row0.pack(fill=tk.X, pady=2)
        ttk.Label(row0, text="Node.js (bin 目录)", width=22).pack(side=tk.LEFT)
        ttk.Entry(row0, textvariable=self.node_path).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=3)
        ttk.Button(row0, text="浏览", width=5, command=self._browse_node).pack(side=tk.LEFT, padx=1)
        ttk.Button(row0, text="检测", width=5, command=self._detect_node).pack(side=tk.LEFT, padx=1)
        ttk.Button(row0, text="下载", width=5, command=self._dl_node).pack(side=tk.LEFT, padx=1)

        self.env_status = ttk.Label(env_frame, text="", foreground="gray")
        self.env_status.pack(anchor=tk.W, pady=(3, 0))

        # ===== 打包选项 =====
        opt_frame = ttk.LabelFrame(main_frame, text="打包选项", padding=8)
        opt_frame.pack(fill=tk.X, pady=(0, 8))

        # 构建类型
        type_row = ttk.Frame(opt_frame)
        type_row.pack(fill=tk.X, pady=2)
        ttk.Label(type_row, text="构建类型", width=22).pack(side=tk.LEFT)
        for key, info in BUILD_TYPES.items():
            ttk.Radiobutton(
                type_row, text=info['desc'], variable=self.build_type_var, value=key,
                command=self._on_type_change
            ).pack(side=tk.LEFT, padx=8)

        # 输出名称 (仅便携版)
        name_row = ttk.Frame(opt_frame)
        name_row.pack(fill=tk.X, pady=2)
        ttk.Label(name_row, text="输出文件夹名称", width=22).pack(side=tk.LEFT)
        self.name_entry = ttk.Entry(name_row, textvariable=self.output_name_var, width=25)
        self.name_entry.pack(side=tk.LEFT, padx=3)

        # 前端构建选项
        vite_row = ttk.Frame(opt_frame)
        vite_row.pack(fill=tk.X, pady=2)
        ttk.Label(vite_row, text="前端构建", width=22).pack(side=tk.LEFT)
        ttk.Checkbutton(vite_row, text="跳过 vite build (已有 dist/)", variable=self.skip_vite_var).pack(side=tk.LEFT, padx=3)

        # 清理
        clean_row = ttk.Frame(opt_frame)
        clean_row.pack(fill=tk.X, pady=2)
        ttk.Label(clean_row, text="其他选项", width=22).pack(side=tk.LEFT)
        ttk.Checkbutton(clean_row, text="构建前清理 (clean)", variable=self.clean_var).pack(side=tk.LEFT, padx=3)

        self._on_type_change()

        # ===== 按钮区 =====
        btn_frame = ttk.Frame(main_frame)
        btn_frame.pack(fill=tk.X, pady=(0, 5))

        self.build_btn = ttk.Button(btn_frame, text="开始打包", command=self._start_build)
        self.build_btn.pack(side=tk.LEFT, padx=3)

        self.cancel_btn = ttk.Button(btn_frame, text="取消", command=self._cancel_build, state=tk.DISABLED)
        self.cancel_btn.pack(side=tk.LEFT, padx=3)

        ttk.Button(btn_frame, text="打开输出目录", command=self._open_output).pack(side=tk.LEFT, padx=3)

        self.progress = ttk.Progressbar(btn_frame, mode='indeterminate', length=150)
        self.progress.pack(side=tk.RIGHT, padx=3)

        # ===== 日志 =====
        log_frame = ttk.LabelFrame(main_frame, text="构建日志", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=True)

        self.log_widget = scrolledtext.ScrolledText(
            log_frame, wrap=tk.WORD, font=('Consolas', 9),
            state=tk.DISABLED, bg='#1e1e1e'
        )
        self.log_widget.pack(fill=tk.BOTH, expand=True)

        self.log_widget.tag_configure('header', foreground='#569cd6', font=('Consolas', 9, 'bold'))
        self.log_widget.tag_configure('error', foreground='#f44747')
        self.log_widget.tag_configure('warning', foreground='#cca700')
        self.log_widget.tag_configure('success', foreground='#6a9955')
        self.log_widget.tag_configure('info', foreground='#4fc1ff')
        self.log_widget.tag_configure('normal', foreground='#d4d4d4')

        # 底部状态栏
        bottom = ttk.Frame(main_frame)
        bottom.pack(fill=tk.X, pady=(3, 0))
        self.status_label = ttk.Label(bottom, text="就绪")
        self.status_label.pack(side=tk.LEFT)
        ttk.Label(bottom, text=f"v{VERSION} · PCLive1.3 Electron 打包", foreground="gray").pack(side=tk.RIGHT)

    # ── 自动检测 ──

    def _auto_detect(self):
        if not self.node_path.get():
            self._detect_node()

    def _detect_node(self):
        self._log("正在检测 Node.js...", "info")
        nodes = find_nodejs()
        if nodes:
            best = nodes[0]
            self.node_path.set(best[0])
            self.env_status.config(
                text=f"检测到 {len(nodes)} 个 Node.js，已选: {best[0]}  (v{best[1]})",
                foreground="green"
            )
            self._save_state()
        else:
            self.env_status.config(
                text="未检测到 Node.js，请手动选择或点击[下载]",
                foreground="red"
            )

    def _browse_node(self):
        p = filedialog.askdirectory(title="选择 Node.js bin 目录 (包含 node.exe)")
        if p and os.path.isfile(os.path.join(p, 'node.exe')):
            self.node_path.set(p)
            self._save_state()
        elif p:
            messagebox.showwarning("警告", f"所选目录不包含 node.exe:\n{p}")

    # ── 下载 Node.js ──

    def _dl_node(self):
        if not messagebox.askyesno("确认下载", "将下载 Node.js LTS (约30MB) 到项目 tools/node 目录。\n继续吗？"):
            return

        os.makedirs(NODE_TOOLS_DIR, exist_ok=True)
        self.build_btn.config(state=tk.DISABLED)
        self.status_label.config(text="正在下载 Node.js...")
        self.progress.config(mode='determinate', maximum=100, value=0)

        def _do():
            try:
                result = download_nodejs(
                    NODE_TOOLS_DIR,
                    progress_cb=lambda p, msg: self.after(0, self._on_dl_progress, p, msg)
                )
                self.after(0, self._on_dl_done, result)
            except Exception as e:
                self.after(0, self._on_dl_error, str(e))

        threading.Thread(target=_do, daemon=True).start()

    def _on_dl_progress(self, pct, msg):
        self.progress['value'] = pct
        self.status_label.config(text=msg)

    def _on_dl_done(self, result):
        self.progress.config(mode='indeterminate')
        self.build_btn.config(state=tk.NORMAL)
        if result:
            self.node_path.set(result)
            self._save_state()
            ver = _get_node_version(result)
            self._log(f"[下载完成] Node.js v{ver} → {result}", "success")
            self.env_status.config(
                text=f"Node.js v{ver} 已就绪: {result}",
                foreground="green"
            )
            self.status_label.config(text="Node.js 下载完成")
        else:
            self._log("[下载失败] 无法定位安装目录", "error")
            self.status_label.config(text="下载失败")

    def _on_dl_error(self, msg):
        self.progress.config(mode='indeterminate')
        self.build_btn.config(state=tk.NORMAL)
        self._log(f"[下载异常] {msg}", "error")
        self.status_label.config(text="下载失败")

    # ── 构建类型切换 ──

    def _on_type_change(self, *_):
        bt = self.build_type_var.get()
        if bt == 'portable':
            self.name_entry.config(state=tk.NORMAL)
        else:
            self.name_entry.config(state=tk.DISABLED)

    # ── 启动构建 ──

    def _start_build(self):
        node = self.node_path.get().strip()
        build_type = self.build_type_var.get()
        output_name = self.output_name_var.get().strip()
        skip_vite = self.skip_vite_var.get()
        clean = self.clean_var.get()

        # 验证 Node.js
        if not node or not os.path.isfile(os.path.join(node, 'node.exe')):
            messagebox.showerror("错误", "请先选择有效的 Node.js bin 目录\n(需包含 node.exe)")
            return

        # 验证 npm
        npm = _find_npm(node)
        if not npm or not os.path.isfile(npm):
            messagebox.showerror("错误", f"未找到 npm\n预期位置: {os.path.join(node, 'npm.cmd')}")
            return

        # 非便携版不需要输出名
        if build_type == 'portable' and not output_name:
            messagebox.showerror("错误", "请输入输出文件夹名称")
            return

        # 如果跳过前端构建，验证 dist/ 存在
        if skip_vite and not os.path.isfile(os.path.join(DIST_DIR, 'index.html')):
            if not messagebox.askyesno("确认", "dist/index.html 不存在，跳过前端构建可能导致失败。\n继续吗？"):
                return

        # 保存设置
        self._save_state()

        # 清空日志
        self.log_widget.config(state=tk.NORMAL)
        self.log_widget.delete(1.0, tk.END)
        self.log_widget.config(state=tk.DISABLED)

        # UI 状态
        self.build_btn.config(state=tk.DISABLED)
        self.cancel_btn.config(state=tk.NORMAL)
        self.progress.start()
        self.status_label.config(text="正在打包...")

        # 启动构建线程
        self.runner = BuildRunner(
            node_bin=node,
            build_type=build_type,
            skip_vite=skip_vite,
            clean_first=clean,
            output_name=output_name,
            log_cb=self._append_log,
            done_cb=self._on_build_done,
            progress_cb=lambda p: None,
        )
        self.runner.start()

    def _cancel_build(self):
        if self.runner and self.runner.is_alive():
            self.runner.cancel()
            self.status_label.config(text="正在取消...")

    def _on_build_done(self, success, msg):
        self.after(0, lambda: self._finish_build(success, msg))

    def _finish_build(self, success, msg):
        self.progress.stop()
        self.build_btn.config(state=tk.NORMAL)
        self.cancel_btn.config(state=tk.DISABLED)
        if success:
            self.clean_var.set(False)
            self.status_label.config(text="打包完成！")
            self._append_log(f"\n打包成功!", "success")
        else:
            self.status_label.config(text=f"失败: {msg}")
            self._append_log(f"\n打包失败: {msg}", "error")

    # ── 日志 ──

    def _append_log(self, text, tag="normal"):
        self.after(0, lambda: self._do_append_log(text, tag))

    def _do_append_log(self, text, tag):
        self.log_widget.config(state=tk.NORMAL)
        self.log_widget.insert(tk.END, text + "\n", tag)
        self.log_widget.see(tk.END)
        self.log_widget.config(state=tk.DISABLED)

    def _log(self, text, tag="normal"):
        self._do_append_log(text, tag)

    # ── 工具 ──

    def _save_state(self):
        self.cache['node_path'] = self.node_path.get()
        self.cache['build_type'] = self.build_type_var.get()
        self.cache['output_name'] = self.output_name_var.get()
        self.cache['skip_vite'] = self.skip_vite_var.get()
        save_cache(self.cache)

    def _open_output(self):
        bt = self.build_type_var.get()
        if bt == 'portable':
            out = os.path.join(PROJECT_ROOT, "PCLive-portable")
        else:
            out = BUILD_TYPES[bt]['output']
        os.makedirs(out, exist_ok=True)
        os.startfile(out)


def main():
    app = BuildGUI()
    app.mainloop()


if __name__ == '__main__':
    main()