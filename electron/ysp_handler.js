/**
 * 央视频 (yangshipin.cn) 频道链接提取器
 * 
 * 策略: 在 BrowserWindow 中加载央视频TV首页，等待Vue SPA完全渲染后，
 * 分析DOM结构提取频道名称，通过Vue 3组件内部状态获取pid值。
 */
const { BrowserWindow, session } = require('electron')
const path = require('path')
const fs = require('fs')

// ============ Logger ============
const LOG_LEVEL = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, VERBOSE: 4 }
const LOG_LABEL = ['ERROR', 'WARN ', 'INFO ', 'DEBUG', 'TRACE']
const isDev = !require('electron').app.isPackaged
const CURRENT_LOG_LEVEL = isDev ? LOG_LEVEL.VERBOSE : LOG_LEVEL.INFO
const TAG = 'YSP'

function getLogDir() {
  try {
    const app = require('electron').app
    const dataDir = app.getPath('userData')
    return isDev ? path.join(__dirname, '..', 'logs') : path.join(dataDir, 'logs')
  } catch (_) {
    return path.join(__dirname, '..', 'logs')
  }
}

function writeYspLog(level, msg) {
  if (level > CURRENT_LOG_LEVEL) return
  const label = LOG_LABEL[level] || '????'
  const line = '[' + new Date().toISOString() + '] [' + label + '] [' + TAG + '] ' + msg
  if (isDev) {
    const fn = level <= LOG_LEVEL.WARN ? 'error' : 'log'
    console[fn](line)
  }
  try {
    const logDir = getLogDir()
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(path.join(logDir, 'pclive-debug.log'), line + '\n')
  } catch (_) {}
}

function yspLogError(msg)   { writeYspLog(LOG_LEVEL.ERROR, msg) }
function yspLogWarn(msg)    { writeYspLog(LOG_LEVEL.WARN, msg) }
function yspLogInfo(msg)    { writeYspLog(LOG_LEVEL.INFO, msg) }
function yspLogDebug(msg)   { writeYspLog(LOG_LEVEL.DEBUG, msg) }
function yspLogVerbose(msg) { writeYspLog(LOG_LEVEL.VERBOSE, msg) }

const SNIFF_TIMEOUT = 25000
const STEALTH_PRELOAD = path.join(__dirname, 'sniffer-preload.js')

// ====== DIAGNOSTIC SCRIPT ======
// 诊断页面是否加载完成（Vue app 是否已挂载）
const DIAG_SCRIPT = `
(function(){
  var app = document.querySelector('#app');
  var hasVue = !!(app && app.__vue_app__);
  var channels = document.querySelectorAll('.tv-main-con-r-list-left-imga span, .tv-main-con-r-list-left-imgb span');
  var videos = document.querySelectorAll('video');
  return JSON.stringify({
    hasApp: !!app,
    hasVue: hasVue,
    channelCount: channels.length,
    videoCount: videos.length,
    ready: hasVue && channels.length > 0
  });
})()
`

// ====== EXTRACT_CHANNELS_SCRIPT ======
// 在Vue SPA就绪后执行，提取频道名称+pid
const EXTRACT_CHANNELS_SCRIPT = `
(function(){
  var result = { success: false, channels: [], count: 0, message: '' };
  var seen = {};
  var channels = [];

  function addChannel(pid, name) {
    if (!pid || !name) return;
    pid = String(pid).trim();
    name = name.trim().replace(/\\s+/g, ' ');
    if (!/^\\d{6,}\$/.test(pid)) return;
    if (seen[pid]) return;
    if (name.length < 2 || name.length > 60) return;
    seen[pid] = 1;
    channels.push({ name: name, pid: pid, url: 'https://www.yangshipin.cn/tv/home?pid=' + pid });
  }

  // 方法1: 从DOM提取频道名称（无论有没有pid）
  var nameList = [];
  var domSpans = document.querySelectorAll('.tv-main-con-r-list-left-imga span, .tv-main-con-r-list-left-imgb span');
  domSpans.forEach(function(span) {
    var clone = span.cloneNode(true);
    var tags = clone.querySelectorAll('.tv-main-con-r-list-left-tag');
    for (var i = 0; i < tags.length; i++) tags[i].remove();
    var name = (clone.textContent || '').trim();
    if (name && name.length >= 2 && nameList.indexOf(name) < 0) {
      nameList.push(name);
    }
  });

  // 方法2: 从Vue组件状态提取pid
  try {
    var app = document.querySelector('#app');
    if (app && app.__vue_app__) {
      var instance = app.__vue_app__._instance;
      if (instance) {
        function findChannels(obj, depth, path) {
          if (!obj || depth > 15) return;
          if (typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) {
              var item = obj[i];
              if (item && typeof item === 'object') {
                var pid = item.pid || item.channelId || item.id;
                if (pid && /^\\d{6,}\$/.test(String(pid))) {
                  var name = item.name || item.title || item.channelName || item.label || '';
                  addChannel(String(pid), String(name));
                }
                findChannels(item, depth + 1, path + '[' + i + ']');
              }
            }
            return;
          }
          var keys = Object.keys(obj);
          for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            if (key === 'parent' || key === 'root' || key === 'appContext' || key === 'provides') continue;
            try {
              var val = obj[key];
              if (val && typeof val === 'object' && val !== obj) {
                findChannels(val, depth + 1, path + '.' + key);
              }
            } catch(e) {}
          }
        }

        var sources = [instance.proxy, instance.setupState, instance.ctx];
        for (var s = 0; s < sources.length; s++) {
          if (sources[s]) findChannels(sources[s], 0, 'root');
        }

        // 遍历subTree
        var subTree = instance.subTree;
        if (subTree) {
          findChannels(subTree.component, 0, 'subTree.component');
          findChannels(subTree.children, 0, 'subTree.children');
          findChannels(subTree.dynamicChildren, 0, 'subTree.dynamicChildren');
        }
      }
    }
  } catch(e) {}

  // 方法3: 搜索全局变量中的pid
  try {
    var globalKeys = ['__INITIAL_STATE__', '__NUXT__', '__NEXT_DATA__', '__DATA__'];
    for (var g = 0; g < globalKeys.length; g++) {
      if (window[globalKeys[g]]) {
        var text = JSON.stringify(window[globalKeys[g]]);
        var re = /"pid"\\s*:\\s*"?(\\d{6,})"?/g;
        var m;
        while ((m = re.exec(text)) !== null) {
          var context = text.substring(Math.max(0, m.index - 300), Math.min(text.length, m.index + 300));
          var nm = context.match(/"name"\\s*:\\s*"([^"]+)"/) || context.match(/"title"\\s*:\\s*"([^"]+)"/) || context.match(/"channelName"\\s*:\\s*"([^"]+)"/);
          if (nm) addChannel(m[1], nm[1]);
        }
      }
    }
  } catch(e) {}

  // 方法4: 搜索script标签内容
  try {
    var scripts = document.querySelectorAll('script');
    for (var sc = 0; sc < scripts.length; sc++) {
      var scText = scripts[sc].textContent || '';
      if (scText.length < 100) continue;
      var re2 = /"pid"\\s*:\\s*"?(\\d{6,})"?/g;
      var m2;
      while ((m2 = re2.exec(scText)) !== null) {
        var ctx = scText.substring(Math.max(0, m2.index - 300), Math.min(scText.length, m2.index + 300));
        var nm2 = ctx.match(/"name"\\s*:\\s*"([^"]+)"/) || ctx.match(/"title"\\s*:\\s*"([^"]+)"/) || ctx.match(/"channelName"\\s*:\\s*"([^"]+)"/);
        if (nm2) addChannel(m2[1], nm2[1]);
      }
    }
  } catch(e) {}

  // 方法5: 搜索整个HTML中的pid
  try {
    var html = document.documentElement.innerHTML;
    var re3 = /"pid"\\s*:\\s*"?(\\d{6,})"?/g;
    var m3;
    while ((m3 = re3.exec(html)) !== null) {
      var ctx2 = html.substring(Math.max(0, m3.index - 300), Math.min(html.length, m3.index + 300));
      var nm3 = ctx2.match(/"name"\\s*:\\s*"([^"]+)"/) || ctx2.match(/"title"\\s*:\\s*"([^"]+)"/) || ctx2.match(/"channelName"\\s*:\\s*"([^"]+)"/) || ctx2.match(/"label"\\s*:\\s*"([^"]+)"/);
      if (nm3) addChannel(m3[1], nm3[1]);
    }
  } catch(e) {}

  // 匹配：将有pid的频道和DOM中提取的名称关联
  // 对于有pid但没匹配到名称的，尝试从DOM名称列表中查找
  var channelsWithPid = channels.filter(function(c) { return c.pid; });
  var domOnlyNames = nameList.filter(function(n) {
    return !channelsWithPid.some(function(c) { return c.name === n; });
  });

  // 把仅有名称的频道也加入结果（作为备用，让用户手动填写URL）
  for (var d = 0; d < domOnlyNames.length; d++) {
    channels.push({ name: domOnlyNames[d], pid: '', url: '' });
  }

  result.channels = channels;
  result.count = channels.length;
  result.success = channels.length > 0;
  result.message = channelsWithPid.length > 0 ? 'ok' : 'no pid found, names only';
  return JSON.stringify(result);
})()
`

function extractYangshipinChannels() {
  yspLogInfo('start')
  yspLogDebug('partition=ysp-dom-xxx, timeout=' + SNIFF_TIMEOUT + 'ms')
  return new Promise((resolve) => {
    const partitionKey = 'ysp-dom-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    const yspSession = session.fromPartition(partitionKey, { cache: false })
    yspLogDebug('session: ' + partitionKey)

    let resolved = false
    const finish = (result) => {
      if (resolved) return
      resolved = true
      const chCount = result.channels ? result.channels.length : 0
      yspLogInfo('done: ok=' + result.success + ' n=' + chCount + ' msg="' + (result.message || '') + '"')
      if (chCount > 0) {
        yspLogDebug('channels: ' + JSON.stringify(result.channels || []).substring(0, 500))
      }
      try {
        const w = yspWin
        if (w && !w.isDestroyed()) { w.close(); yspLogVerbose('win closed') }
      } catch (_) {}
      resolve(result)
    }

    var yspWin
    try {
      yspWin = new BrowserWindow({
        width: 1280, height: 720, show: false, frame: false,
        webPreferences: {
          preload: STEALTH_PRELOAD,
          session: yspSession,
          nodeIntegration: false,
          contextIsolation: false,
          webSecurity: false,
          sandbox: false,
          javascript: true,
          images: true,
          plugins: true,
        },
      })
      yspLogVerbose('BrowserWindow created')
    } catch (e) {
      yspLogError('BrowserWindow create failed: ' + e.message)
      resolve({ success: false, channels: [], message: 'window create error' })
      return
    }

    let loadCompleted = false

    yspWin.webContents.on('did-finish-load', () => {
      loadCompleted = true
      yspLogInfo('page loaded, waiting for Vue SPA to mount...')
    })

    yspWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      yspLogError('load failed: ' + errorCode + ' ' + errorDescription)
      finish({ success: false, channels: [], message: 'load failed: ' + errorCode })
    })

    // 控制台日志监听（用于调试）
    yspWin.webContents.on('console-message', (_event, level, message) => {
      if (level <= 2) {
        yspLogVerbose('page-console[' + level + ']: ' + message.substring(0, 200))
      }
    })

    yspWin.loadURL('https://www.yangshipin.cn/tv/home', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }).catch(err => {
      if (!resolved) {
        yspLogError('loadURL error: ' + err.message)
        finish({ success: false, channels: [], message: 'loadURL error: ' + err.message })
      }
    })

    // 等待Vue SPA就绪后执行提取
    let pollCount = 0
    const MAX_POLL = 20
    const pollInterval = setInterval(() => {
      pollCount++
      if (resolved) { clearInterval(pollInterval); return }

      if (!loadCompleted) {
        if (pollCount >= MAX_POLL) {
          yspLogWarn('page not loaded after ' + (pollCount * 1000) + 'ms')
          clearInterval(pollInterval)
          finish({ success: false, channels: [], message: 'page load timeout' })
        }
        return
      }

      yspLogVerbose('diag poll #' + pollCount)
      yspWin.webContents.executeJavaScript(DIAG_SCRIPT).then(diagStr => {
        if (resolved) return
        try {
          const diag = JSON.parse(diagStr)
          yspLogDebug('diag: hasApp=' + diag.hasApp + ' hasVue=' + diag.hasVue + ' ch=' + diag.channelCount + ' vid=' + diag.videoCount + ' ready=' + diag.ready)

          if (diag.ready) {
            clearInterval(pollInterval)
            yspLogInfo('Vue SPA ready, executing extract script')
            yspWin.webContents.executeJavaScript(EXTRACT_CHANNELS_SCRIPT).then(resultStr => {
              yspLogVerbose('extract done, len=' + (resultStr ? resultStr.length : 0))
              if (resultStr && typeof resultStr === 'string') {
                try {
                  const result = JSON.parse(resultStr)
                  finish({
                    success: result.success,
                    channels: result.channels || [],
                    count: result.count || 0,
                    message: result.message || '',
                  })
                } catch (_) {
                  yspLogError('JSON parse failed on result')
                  finish({ success: false, channels: [], message: 'parse error' })
                }
              } else {
                yspLogWarn('no result string from extract')
                finish({ success: false, channels: [], message: 'no result' })
              }
            }).catch(err => {
              yspLogError('extract script error: ' + err.message)
              finish({ success: false, channels: [], message: 'extract error: ' + err.message })
            })
          } else if (pollCount >= MAX_POLL) {
            clearInterval(pollInterval)
            yspLogWarn('timeout waiting for Vue SPA, ready=' + diag.ready)
            if (diag.hasApp && diag.channelCount > 0) {
              yspLogInfo('attempting extract anyway (has channels in DOM)')
              yspWin.webContents.executeJavaScript(EXTRACT_CHANNELS_SCRIPT).then(resultStr => {
                try {
                  const result = JSON.parse(resultStr)
                  finish({
                    success: result.success,
                    channels: result.channels || [],
                    count: result.count || 0,
                    message: (result.message || '') + ' (partial)',
                  })
                } catch (_) {
                  finish({ success: false, channels: [], message: 'parse error (partial)' })
                }
              }).catch(err => {
                finish({ success: false, channels: [], message: 'extract error (partial): ' + err.message })
              })
            } else {
              finish({ success: false, channels: [], message: 'SPA timeout, ch=' + diag.channelCount })
            }
          }
        } catch (_) {
          yspLogVerbose('diag parse error')
          if (pollCount >= MAX_POLL) {
            clearInterval(pollInterval)
            finish({ success: false, channels: [], message: 'diag parse timeout' })
          }
        }
      }).catch(err => {
        yspLogVerbose('diag script error: ' + err.message)
        if (pollCount >= MAX_POLL) {
          clearInterval(pollInterval)
          finish({ success: false, channels: [], message: 'diag error: ' + err.message })
        }
      })
    }, 1500) // 每1.5秒轮询一次

    setTimeout(() => {
      if (!resolved) {
        clearInterval(pollInterval)
        yspLogWarn('total timeout')
        finish({ success: false, channels: [], message: 'total timeout' })
      }
    }, SNIFF_TIMEOUT)
  })
}

module.exports = { extractYangshipinChannels }