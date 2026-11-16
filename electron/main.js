const dns = require('dns')
dns.setDefaultResultOrder('ipv4first')

const { app, BrowserWindow, ipcMain, dialog, session, net, shell, webContents } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const zlib = require('zlib')
const dlna = require('./dlna')
const tvlive = require('./tvlive')

tvlive.setLogCallback(({ level, msg, data, time }) => {
  const line = `[tlv1] [${level}] [${time}] ${msg}`
  if (level === 'ERRO') logError(line)
  else if (level === 'WARN') logWarn(line)
  else logInfo(line)
  // 同时转发到投屏面板日志栏（level 映射为面板的 INFO/WARN/ERROR/DEBUG）
  const map = { ERRO: 'ERROR', WARN: 'WARN', INFO: 'INFO', DEBG: 'DEBUG' }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tlv1:log', { level: map[level] || 'INFO', msg: `[tlv] ${msg}`, time })
    }
  } catch (_) {}
})
dlna.setLogCallback((level, msg) => {
  if (level === 'ERROR') logError(msg)
  else if (level === 'WARN') logWarn(msg)
  else logInfo(msg)
})
const sniffer = require('./sniffer')
const yspHandler = require('./ysp_handler')
const { BROWSER_UA, MOBILE_UA } = require('./ua')
const os = require('os')
const { purifyM3u8Playlist } = require('./m3u8Purifier')

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')

// 共享 keep-alive Agent：直播流播放时 m3u8 与各分片请求复用同一条 TLS 连接，
// 避免对同一 CDN 在短时间内新建大量连接触发 403 限流（央视频 *.ysp.cctv.cn 尤甚）。
// 空闲连接被 CDN 主动关闭导致的 ECONNRESET 已由 doProxyFetchNode 的 retry 逻辑兜底。
const httpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 })
const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 30000 })

function safeCorsOrigin(req) {
  const origin = (req.headers && (req.headers.origin || req.headers.Origin))
  return origin || '*'
}

function toBase64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str) {
  try {
    str = str.replace(/-/g, '+').replace(/_/g, '/')
    while (str.length % 4) str += '='
    return Buffer.from(str, 'base64')
  } catch (_) { return Buffer.alloc(0) }
}

const dataDir = (() => {
  if (isDev) return app.getPath('userData')
  const dir = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'cache')
    : path.join(__dirname, '..', 'cache')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
  app.setPath('userData', dir)
  return dir
})()

const Store = require('electron-store')

function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

// ============ Shared CookieJar ============
// Global cookie store shared across ALL network stacks (Node.js http/https AND Electron net.request)
// Key: domain (e.g. "example.com"), Value: Map<cookieName, {value, path, expires, secure, httpOnly, sameSite}>
const cookieStore = new Map()

function cookieGetDomain(url) {
  try {
    const u = new URL(url)
    let hostname = u.hostname
    hostname = hostname.replace(/^\.+|\.+$/g, '')
    if (hostname.startsWith('.')) hostname = hostname.slice(1)
    return hostname
  } catch (_) { return null }
}

function cookieGetDomainVariants(hostname) {
  const parts = hostname.split('.')
  const variants = [hostname]
  for (let i = 1; i < parts.length - 1; i++) {
    variants.push('.' + parts.slice(i).join('.'))
  }
  if (parts.length > 1) {
    variants.push('.' + parts.slice(1).join('.'))
  }
  return variants
}

function cookiePathMatch(cookiePath, requestPath) {
  if (!cookiePath || cookiePath === '/') return true
  const rp = requestPath || '/'
  if (rp === cookiePath) return true
  if (rp.startsWith(cookiePath + '/')) return true
  if (cookiePath.endsWith('/') && rp.startsWith(cookiePath)) return true
  return false
}

function parseSetCookie(setCookieStr, requestUrl) {
  if (!setCookieStr) return []
  const domain = cookieGetDomain(requestUrl)
  if (!domain) return []
  const pathName = (() => { try { return new URL(requestUrl).pathname } catch (_) { return '/' } })()

  const results = []
  const cookies = Array.isArray(setCookieStr) ? setCookieStr : [setCookieStr]

  for (const raw of cookies) {
    const parts = raw.split(';').map(s => s.trim())
    const kv = parts[0].split('=')
    if (kv.length < 2) continue
    const name = kv[0].trim()
    const value = kv.slice(1).join('=').trim()
    if (!name) continue

    let path = '/'
    let expires = null
    let httpOnly = false
    let secure = false
    let sameSite = null
    let cookieDomain = null

    for (let i = 1; i < parts.length; i++) {
      const attr = parts[i]
      const eqIdx = attr.indexOf('=')
      const attrName = (eqIdx >= 0 ? attr.substring(0, eqIdx) : attr).trim().toLowerCase()
      const attrValue = eqIdx >= 0 ? attr.substring(eqIdx + 1).trim() : ''

      if (attrName === 'path') {
        path = attrValue || '/'
      } else if (attrName === 'domain') {
        cookieDomain = attrValue
      } else if (attrName === 'expires') {
        try { expires = new Date(attrValue).getTime() } catch (_) { expires = null }
      } else if (attrName === 'max-age') {
        try {
          const age = parseInt(attrValue, 10)
          if (!isNaN(age)) expires = Date.now() + age * 1000
        } catch (_) {}
      } else if (attrName === 'httponly') {
        httpOnly = true
      } else if (attrName === 'secure') {
        secure = true
      } else if (attrName === 'samesite') {
        sameSite = attrValue.toLowerCase()
      }
    }

    const storeDomain = cookieDomain || domain
    if (!storeDomain) continue

    // don't add secure cookies for http requests
    if (secure && requestUrl.startsWith && requestUrl.startsWith('http://')) continue

    const cookieObj = { name, value, path, expires, secure, httpOnly, sameSite, domain: storeDomain }

    results.push(cookieObj)

    if (!cookieStore.has(storeDomain)) {
      cookieStore.set(storeDomain, new Map())
    }
    cookieStore.get(storeDomain).set(name, cookieObj)
  }

  // Clean expired cookies periodically
  const now = Date.now()
  for (const [dom, cookies] of cookieStore) {
    for (const [n, c] of cookies) {
      if (c.expires && c.expires < now) {
        cookies.delete(n)
      }
    }
    if (cookies.size === 0) cookieStore.delete(dom)
  }

  return results
}

function getCookiesForUrl(url) {
  const hostname = cookieGetDomain(url)
  if (!hostname) return ''
  const pathName = (() => { try { return new URL(url).pathname } catch (_) { return '/' } })()
  const isSecure = url.startsWith('https://')
  const now = Date.now()

  const variants = cookieGetDomainVariants(hostname)
  const matched = new Map()

  for (const variant of variants) {
    const cookies = cookieStore.get(variant)
    if (!cookies) continue
    for (const [name, c] of cookies) {
      if (matched.has(name)) continue
      if (c.expires && c.expires < now) continue
      if (c.secure && !isSecure) continue
      if (!cookiePathMatch(c.path, pathName)) continue
      matched.set(name, c.value)
    }
  }

  if (matched.size === 0) return ''
  return Array.from(matched.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

function extractSetCookieHeaders(headers) {
  if (!headers) return null
  const keys = Object.keys(headers)
  const candidates = keys.filter(k => k.toLowerCase() === 'set-cookie')
  if (candidates.length === 0) return null
  if (candidates.length === 1) return headers[candidates[0]]
  return candidates.map(k => headers[k]).flat()
}

// ============ GitHub Mirror Fallback ============
const GITHUB_MIRRORS = [
  'https://gh-proxy.org/',
  'https://mirror.ghproxy.com/',
  'https://gh.llkk.cc/',
  'https://gh.jiasu.in/',
  'https://github.moeyy.xyz/',
  'https://gh.con.sh/',
  'https://gh.api.99988866.xyz/',
]

function stripGhProxy(url) {
  for (const mirror of GITHUB_MIRRORS) {
    if (url.startsWith(mirror)) {
      const inner = url.substring(mirror.length)
      if (/^https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/.+/i.test(inner)) {
        return { strippedUrl: inner, wasProxied: true }
      }
      return { strippedUrl: inner, wasProxied: true }
    }
  }
  if (/^https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/.+/i.test(url)) {
    return { strippedUrl: url, wasProxied: false }
  }
  return { strippedUrl: url, wasProxied: false }
}

// Speed-test all GitHub mirrors concurrently, return top 2 fastest
let fastestGitHubMirrors = null
let mirrorSpeedTestRunning = false

async function getFastestGitHubMirrors(timeout = 3000) {
  if (fastestGitHubMirrors) return fastestGitHubMirrors
  // Simple mutex to prevent concurrent speed-tests
  while (mirrorSpeedTestRunning) {
    await new Promise(r => setTimeout(r, 50))
    if (fastestGitHubMirrors) return fastestGitHubMirrors
  }
  mirrorSpeedTestRunning = true
  try {
    const results = await Promise.allSettled(
      GITHUB_MIRRORS.map(m => testMirrorSpeed(m, timeout))
    )
    const valid = results
      .filter(r => r.status === 'fulfilled' && r.value[1] !== Infinity)
      .map(r => r.value)
      .sort((a, b) => a[1] - b[1])

    fastestGitHubMirrors = valid.slice(0, 2).map(v => v[0])
    if (fastestGitHubMirrors.length === 0) {
      fastestGitHubMirrors = GITHUB_MIRRORS.slice(0, 2)
    }
    logInfo('GH MIRROR speed test complete, top 2: ' + fastestGitHubMirrors.join(', '))
    return fastestGitHubMirrors
  } finally {
    mirrorSpeedTestRunning = false
  }
}

function testMirrorSpeed(mirror, timeout) {
  return new Promise((resolve) => {
    const start = Date.now()
    try {
      const parsed = new URL(mirror)
      const httpMod = parsed.protocol === 'https:' ? https : http
      const req = httpMod.request(parsed.href, {
        method: 'HEAD',
        timeout: timeout,
        rejectUnauthorized: false,
        headers: { 'User-Agent': BROWSER_UA },
      }, (res) => {
        res.resume()
        res.on('end', () => {
          const elapsed = Date.now() - start
          debugLog('GH MIRROR speed: ' + mirror + ' = ' + elapsed + 'ms')
          resolve([mirror, elapsed])
        })
      })
      req.on('error', () => resolve([mirror, Infinity]))
      req.on('timeout', () => {
        req.destroy()
        resolve([mirror, Infinity])
      })
      req.end()
    } catch (_) {
      resolve([mirror, Infinity])
    }
  })
}

const sourcesFilePath = app.isPackaged
  ? path.join(path.dirname(app.getPath('exe')), 'data', 'sources.json')
  : path.join(__dirname, '..', 'data', 'sources.json')

function ensureSourcesFile() {
  try {
    const raw = fs.readFileSync(sourcesFilePath, 'utf8')
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length > 0) {
      logInfo('SOURCES: Loaded ' + arr.length + ' sources from file')
      return arr
    }
  } catch (e) {
    logError('SOURCES: Read error: ' + e.message)
  }
  logWarn('SOURCES: sources.json missing or invalid, returning empty list')
  return []
}

function loadSourcesFile() {
  return ensureSourcesFile()
}

function saveSourcesFile(list) {
  if (!Array.isArray(list)) {
    logWarn('SOURCES: saveSourcesFile received non-array, ignoring')
    return false
  }
  try {
    const tmpPath = sourcesFilePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2), 'utf8')
    fs.renameSync(tmpPath, sourcesFilePath)
    logInfo('SOURCES: Saved ' + list.length + ' sources to file')
    return true
  } catch (e) {
    logError('SOURCES: Failed to save sources file: ' + e.message)
    try { fs.unlinkSync(sourcesFilePath + '.tmp') } catch (_) {}
    throw e
  }
}

const store = new Store({
  name: 'pclive-data',
  defaults: {
    windowBounds: { width: 1280, height: 800 },
    liveSourceList: [],
    currentSourceName: '',
    volume: 0.8
  }
})

let mainWindow = null
let floatWindow = null
let floatSourceInfo = null

function createWindow() {
  logDebug('WINDOW: creating main window')
  const { width, height } = store.get('windowBounds', { width: 1280, height: 800 })

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../public/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: true,  // 荔枝网等站点在 webSecurity=false 时会被服务端下发非法 token，导致 m3u8 403
      allowRunningInsecureContent: true
    }
  })

  // Inject CORS headers for all requests so HLS.js/mpegts.js direct play works from renderer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': ['*'],
        'Access-Control-Allow-Methods': ['GET, POST, OPTIONS'],
        'Access-Control-Allow-Headers': ['*'],
      }
    })
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.webContents.on('did-finish-load', () => {
    logDebug('WINDOW: main window loaded')
  })

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isFullScreen()) return
    const [w, h] = mainWindow.getSize()
    store.set('windowBounds', { width: w, height: h })
  })

  // 全屏状态变化同步到渲染进程（用于隐藏标题栏、让播放区真正铺满屏幕）
  mainWindow.on('enter-full-screen', () => {
    mainWindow?.webContents.send('window-fullscreen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    mainWindow?.webContents.send('window-fullscreen-changed', false)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 长江云隐藏浏览器窗口会阻止 window-all-closed 触发，主窗口关闭时须一并销毁
    closeHbtvBrowser()
    stopRecordingInternal()
  })
}

// ============ Logger: dev=详细日志 / prod=精简日志 ============
const LOG_LEVEL = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, VERBOSE: 4 }
const LOG_LABEL = ['ERROR', 'WARN ', 'INFO ', 'DEBUG', 'TRACE']
const CURRENT_LOG_LEVEL = isDev ? LOG_LEVEL.VERBOSE : LOG_LEVEL.DEBUG

const logDir = (() => {
  const dir = isDev ? path.join(__dirname, '..', 'logs') : path.join(dataDir, 'logs')
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
  return dir
})()
const debugLogFile = path.join(logDir, 'pclive-debug.log')
try { fs.appendFileSync(debugLogFile, '\n=== PCLive Session ' + new Date().toISOString() + ' ===\n') } catch (_) {}

function writeLog(level, msg) {
  if (level > CURRENT_LOG_LEVEL) return
  const label = LOG_LABEL[level] || '????'
  const line = `[${new Date().toISOString()}] [${label}] ${msg}`
  const fn = level <= LOG_LEVEL.WARN ? 'error' : 'log'
  console[fn](line)
  try { fs.appendFileSync(debugLogFile, line + '\n') } catch (_) {}
}

function logError(msg) { writeLog(LOG_LEVEL.ERROR, msg) }
function logWarn(msg)  { writeLog(LOG_LEVEL.WARN, msg) }
function logInfo(msg)  { writeLog(LOG_LEVEL.INFO, msg) }
function logDebug(msg) { writeLog(LOG_LEVEL.DEBUG, msg) }
function logVerbose(msg) { writeLog(LOG_LEVEL.VERBOSE, msg) }

function debugLog(msg) { logDebug(msg) }

// 投屏面板日志：同时写入本地日志文件，并推送到渲染进程「投屏」面板的日志栏。
// level 使用 INFO / WARN / ERROR / DEBUG，与面板样式 dlna-log-<level> 对应。
function tlv1Log(level, msg, data) {
  const lvl = String(level || 'INFO').toUpperCase()
  if (lvl === 'ERROR') logError(msg)
  else if (lvl === 'WARN') logWarn(msg)
  else if (lvl === 'DEBUG') logDebug(msg)
  else logInfo(msg)
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tlv1:log', {
        level: lvl,
        msg,
        data,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      })
    }
  } catch (_) {}
}

// ============ Encoding detection ============
const textDecoderUtf8 = new TextDecoder('utf-8', { fatal: false })
const textDecoderGbk = new TextDecoder('gbk', { fatal: false })

function smartDecode(buf, contentType) {
  const REPLACEMENT_THRESHOLD = 0.01 // 1% 替换字符即判定为乱码

  // 检查 Content-Type 声明的 charset
  const charsetMatch = (contentType || '').match(/charset=([^\s;]+)/i)
  if (charsetMatch) {
    const charset = charsetMatch[1].toLowerCase().replace(/['"]/g, '')
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return textDecoderGbk.decode(buf)
    }
    if (charset === 'big5' || charset === 'big5-hkscs') {
      try { return new TextDecoder('big5', { fatal: false }).decode(buf) } catch (_) {}
    }
    if (charset === 'utf-8' || charset === 'utf8') {
      return textDecoderUtf8.decode(buf)
    }
  }

  // 先尝试 UTF-8
  const utf8Str = textDecoderUtf8.decode(buf)

  // 统计替换字符 U+FFFD 数量，判断是否乱码
  const replacementCount = (utf8Str.match(/\uFFFD/g) || []).length
  if (replacementCount > 0 && replacementCount > utf8Str.length * REPLACEMENT_THRESHOLD) {
    // GBK / GB2312 / GB18030 回退
    try {
      const gbkStr = textDecoderGbk.decode(buf)
      const gbkBroken = (gbkStr.match(/\uFFFD/g) || []).length
      if (gbkBroken < replacementCount) {
        return gbkStr
      }
    } catch (_) {}

    // Big5 繁体中文回退
    try {
      const big5Decoder = new TextDecoder('big5', { fatal: false })
      const big5Str = big5Decoder.decode(buf)
      const big5Broken = (big5Str.match(/\uFFFD/g) || []).length
      if (big5Broken < replacementCount) {
        return big5Str
      }
    } catch (_) {}
  }

  return utf8Str
}

// ============ Image steganography detection ============
// Many Chinese IPTV sources (e.g. 饭太硬) embed M3U/TXT data within or after images.
// APKs handle this by parsing raw binary; we need to extract before text decoding.

const JPEG_MAGIC = Buffer.from([0xFF, 0xD8, 0xFF])
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47])
const GIF87_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
const GIF89_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const BMP_MAGIC = Buffer.from([0x42, 0x4D])

function bufStartsWith(buf, magic) {
  if (buf.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (buf[i] !== magic[i]) return false
  }
  return true
}

function extractTextFromImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null

  // JPEG: find last FF D9 (EOI marker), extract text after it
  if (bufStartsWith(buf, JPEG_MAGIC)) {
    let eoiIdx = -1
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i] === 0xFF && buf[i + 1] === 0xD9) {
        eoiIdx = i + 2
        break
      }
    }
    if (eoiIdx > 0 && eoiIdx < buf.length - 4) {
      const textBuf = buf.subarray(eoiIdx)
      if (textBuf.length >= 10) {
        debugLog(`IMAGE STEGO: JPEG detected, extracted ${textBuf.length} bytes after EOI`)
        return textBuf
      }
    }
    return null
  }

  // PNG: find IEND chunk, extract text after it
  if (bufStartsWith(buf, PNG_MAGIC)) {
    const iendMarker = Buffer.from('IEND', 'ascii')
    const iendPos = buf.indexOf(iendMarker)
    if (iendPos > 0 && iendPos < buf.length - 8) {
      const iendEndIdx = iendPos + 8  // skip IEND type (4 bytes) + CRC (4 bytes); data is 0 bytes for IEND
      const textBuf = buf.subarray(iendEndIdx)
      if (textBuf.length >= 10) {
        debugLog(`IMAGE STEGO: PNG detected, extracted ${textBuf.length} bytes after IEND`)
        return textBuf
      }
    }
    return null
  }

  // GIF: find trailer 0x3B, extract text after it
  if (bufStartsWith(buf, GIF87_MAGIC) || bufStartsWith(buf, GIF89_MAGIC)) {
    let trailerIdx = -1
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === 0x3B) {
        trailerIdx = i + 1
        break
      }
    }
    if (trailerIdx > 0 && trailerIdx < buf.length - 4) {
      const textBuf = buf.subarray(trailerIdx)
      if (textBuf.length >= 10) {
        debugLog(`IMAGE STEGO: GIF detected, extracted ${textBuf.length} bytes after trailer`)
        return textBuf
      }
    }
    return null
  }

  // BMP: check DIB header for actual file size, extract text after it
  if (bufStartsWith(buf, BMP_MAGIC)) {
    const fileSize = buf.readUInt32LE(2)
    if (fileSize > 54 && fileSize < buf.length - 4) {
      const textBuf = buf.subarray(fileSize)
      if (textBuf.length >= 10) {
        debugLog(`IMAGE STEGO: BMP detected, extracted ${textBuf.length} bytes after declared size`)
        return textBuf
      }
    }
    return null
  }

  return null
}

function decodeImageStego(buf, contentType) {
  const textBuf = extractTextFromImage(buf)
  if (textBuf) {
    return smartDecode(textBuf, contentType)
  }
  return null
}

// ============ DNS-over-HTTPS + Hosts Mapping + Proxy ============
const customHosts = new Map()
let proxyConfig = null

function resolveUrl(baseUrl, location) {
  if (location.startsWith('http://') || location.startsWith('https://')) return location
  try { return new URL(location, baseUrl).href } catch (_) { return location }
}

function getIpFamily(parsedUrl) {
  try {
    const hostname = typeof parsedUrl === 'string' ? new URL(parsedUrl).hostname : parsedUrl.hostname
    if (hostname.startsWith('[')) return 6
  } catch (_) {}
  return 4
}

async function fetchUrlWithDns(url, reqHeaders, maxRedirects = 5, timeout = 20000) {
  if (maxRedirects <= 0) throw new Error('Too many redirects')
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://')
  if (/^https?:\/\/https?:\/\//i.test(url)) throw new Error('Double protocol detected in URL')

  if (customHosts.size > 0) {
    for (const [domain, ip] of customHosts) {
      if (url.includes(domain)) {
        const replaced = url.replace(domain, ip)
        logVerbose(`FETCH DNS: hosts rewrite ${domain} → ${ip}`)
        url = replaced
        break
      }
    }
  }

  const parsed = new URL(url)
  const startTime = Date.now()
  return new Promise((resolve, reject) => {
    const sendHeaders = buildReqHeaders(parsed, reqHeaders)

    debugLog(`FETCH INTERNAL: about to call Node.js req url=${url}`)
    const protocol = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: sendHeaders,
      timeout: timeout,
      rejectUnauthorized: false,
      agent: parsed.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
    }

    const req = protocol.request(options, (res) => {
      debugLog(`FETCH INTERNAL: response ${res.statusCode} for ${url}`)

      // Parse Set-Cookie from all responses (redirects included)
      const setCookieData = extractSetCookieHeaders(res.headers)
      if (setCookieData) {
        try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
      }

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href
        debugLog(`FETCH INTERNAL: redirect ${url} → ${res.statusCode} ${redirectUrl} remaining=${maxRedirects}`)
        res.resume()
        resolve(fetchUrlWithDns(redirectUrl, reqHeaders, maxRedirects - 1, timeout))
        return
      }

      const ce = res.headers['content-encoding'] || ''
      const ct = res.headers['content-type'] || ''
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let raw
        try {
          if (ce.includes('gzip')) raw = zlib.gunzipSync(buf)
          else if (ce.includes('deflate')) raw = zlib.inflateSync(buf)
          else raw = buf
        } catch (_) { raw = buf }
        const stegoText = decodeImageStego(raw, ct)
        if (stegoText) {
          debugLog(`IMAGE STEGO: successfully extracted text (${stegoText.length} chars)`)
          resolve(stegoText)
          return
        }
        logVerbose(`FETCH INTERNAL: completed in ${Date.now() - startTime}ms url=${url} size=${raw.length}`)
        resolve(smartDecode(raw, ct))
      })
      res.on('error', (e) => {
        logError(`FETCH INTERNAL: res error for ${url}: ${e.message}`)
        reject(e)
      })
    })

    req.on('error', (e) => {
      logError(`FETCH INTERNAL: req error for ${url}: ${e.message} code=${e.code}`)
      reject(e)
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.end()
  })
}

// Spider-aware fetch: returns full response object with statusCode, headers, content, finalUrl
// Supports noRedirect mode via X-Spider-No-Redirect header for manual redirect handling
async function fetchUrlSpider(url, reqHeaders, maxRedirects = 5, timeout = 20000) {
  if (maxRedirects <= 0) {
    return { content: '', statusCode: 310, headers: { location: '' }, finalUrl: url }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { content: '', statusCode: 400, headers: {}, finalUrl: url }
  }
  if (/^https?:\/\/https?:\/\//i.test(url)) {
    return { content: '', statusCode: 400, headers: {}, finalUrl: url }
  }

  if (customHosts.size > 0) {
    for (const [domain, ip] of customHosts) {
      if (url.includes(domain)) {
        const replaced = url.replace(domain, ip)
        logVerbose(`FETCH SPIDER DNS: hosts rewrite ${domain} → ${ip}`)
        url = replaced
        break
      }
    }
  }

  // Extract spider control flags from headers
  const noRedirect = String(reqHeaders['X-Spider-No-Redirect'] || '0') === '1'
  const spiderMethod = String(reqHeaders['X-Spider-Method'] || 'GET').toUpperCase()
  const spiderBody = String(reqHeaders['X-Spider-Body'] || '')

  // Clean internal spider headers before sending to server
  const cleanHeaders = {}
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase()
    if (!lk.startsWith('x-spider-')) {
      cleanHeaders[k] = v
    }
  }

  const parsed = new URL(url)
  const startTime = Date.now()
  return new Promise((resolve, reject) => {
    const sendHeaders = buildReqHeaders(parsed, cleanHeaders)

    debugLog(`FETCH SPIDER: url=${url} noRedirect=${noRedirect} method=${spiderMethod}`)
    const protocol = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: spiderMethod,
      headers: sendHeaders,
      timeout: timeout,
      rejectUnauthorized: false,
      agent: parsed.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
    }

    let reqBodySent = false
    const req = protocol.request(options, (res) => {
      const statusCode = res.statusCode || 200
      const respHeaders = {}
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined && v !== null) {
          respHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
        }
      }

      // Parse Set-Cookie
      const setCookieData = extractSetCookieHeaders(res.headers)
      if (setCookieData) {
        try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
      }

      // If noRedirect mode and server returned a redirect — return redirect info
      if (noRedirect && statusCode >= 300 && statusCode < 400 && respHeaders['location']) {
        debugLog(`FETCH SPIDER: noRedirect, returning ${statusCode} Location=${respHeaders['location'].substring(0, 80)}`)
        res.resume()
        resolve({
          content: '',
          statusCode,
          headers: respHeaders,
          finalUrl: url
        })
        return
      }

      // If normal mode and server returned a redirect — follow it
      if (!noRedirect && statusCode >= 300 && statusCode < 400 && respHeaders['location']) {
        const redirectUrl = resolveUrl(parsed.href, respHeaders['location'])
        debugLog(`FETCH SPIDER: following redirect ${statusCode} → ${redirectUrl.substring(0, 80)} remaining=${maxRedirects}`)
        res.resume()
        resolve(fetchUrlSpider(redirectUrl, reqHeaders, maxRedirects - 1, timeout))
        return
      }

      const ce = res.headers['content-encoding'] || ''
      const ct = res.headers['content-type'] || ''
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let raw
        try {
          if (ce.includes('gzip')) raw = zlib.gunzipSync(buf)
          else if (ce.includes('deflate')) raw = zlib.inflateSync(buf)
          else raw = buf
        } catch (_) { raw = buf }
        const stegoText = decodeImageStego(raw, ct)
        if (stegoText) {
          debugLog(`FETCH SPIDER: stego extracted ${stegoText.length} chars`)
          resolve({ content: stegoText, statusCode, headers: respHeaders, finalUrl: url })
          return
        }
        logVerbose(`FETCH SPIDER: completed in ${Date.now() - startTime}ms url=${url} status=${statusCode} size=${raw.length}`)
        resolve({
          content: smartDecode(raw, ct),
          statusCode,
          headers: respHeaders,
          finalUrl: url
        })
      })
      res.on('error', (e) => {
        logError(`FETCH SPIDER: res error for ${url}: ${e.message}`)
        reject(e)
      })
    })

    req.on('error', (e) => {
      logError(`FETCH SPIDER: req error for ${url}: ${e.message} code=${e.code}`)
      reject(e)
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })

    if (spiderMethod === 'POST' && spiderBody) {
      req.write(spiderBody)
    }
    req.end()
  })
}

function buildReqHeaders(parsedUrl, reqHeaders) {
  const hostname = parsedUrl.hostname
  const port = parsedUrl.port
  const hostHeader = port ? `${hostname}:${port}` : hostname
  const origin = `${parsedUrl.protocol}//${hostHeader}`
  const explicitReferer = reqHeaders['Referer'] || reqHeaders['referer'] || ''
  const explicitOrigin = reqHeaders['Origin'] || reqHeaders['origin'] || ''
  const isBaiduCdn = /\.bdstatic\.com$/.test(hostname)
  const defaultReferer = explicitReferer || (isBaiduCdn ? 'https://haokan.baidu.com/' : `${origin}/`)
  const defaultOrigin = explicitOrigin || (isBaiduCdn ? 'https://haokan.baidu.com' : origin)
  const headers = {
    'Host': hostHeader,
    'User-Agent': reqHeaders['User-Agent'] || BROWSER_UA,
    'Accept': reqHeaders['Accept'] || '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Referer': defaultReferer,
    'Origin': defaultOrigin
  }
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase()
    if (!['user-agent', 'accept', 'accept-language', 'accept-encoding', 'referer', 'origin', 'host'].includes(lk)) {
      if (v) headers[k] = v
    }
  }
  if (!headers['Accept-Encoding']) delete headers['Accept-Encoding']

  // Inject cookies from shared CookieJar (if not explicitly set by caller)
  const hasExplicitCookie = Object.keys(reqHeaders).some(k => k.toLowerCase() === 'cookie')
  if (!hasExplicitCookie) {
    const cookies = getCookiesForUrl(parsedUrl.href)
    if (cookies) {
      headers['Cookie'] = cookies
    }
  }

  return headers
}

function probeContentType(url, headers, forStreaming) {
  return new Promise((resolve) => {
    let probeTimer = null
    try {
      probeContentTypeCore(url, headers || {}, 20, resolve, forStreaming)
    } catch (e) {
      resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url })
    }
  })
}

function probeContentTypeWithGet(url, headers, redirectsLeft = 10) {
  return new Promise((resolve) => {
    if (redirectsLeft <= 0) return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url })
    let parsed
    try { parsed = new URL(url) } catch (_) { return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url }) }
    const httpMod = parsed.protocol === 'https:' ? https : http
    const sendHeaders = buildReqHeaders(parsed, headers)

    const req = httpMod.get(parsed, { headers: sendHeaders, rejectUnauthorized: false, family: getIpFamily(parsed), timeout: 8000 }, res => {
      const status = res.statusCode || 200
      const loc = (res.headers['location'] || res.headers['Location'] || '')

      // Parse Set-Cookie from GET probe response
      const setCookieData = extractSetCookieHeaders(res.headers)
      if (setCookieData) {
        try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
      }

      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        res.destroy()
        const nextUrl = resolveUrl(parsed.href, loc)
        return probeContentTypeWithGet(nextUrl, headers, redirectsLeft - 1).then(resolve)
      }
      const ct = (res.headers['content-type'] || '').toLowerCase()
      const isPlaylist = ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl')
      const isFlv = ct.includes('video/x-flv') || ct.includes('video/flv')
      res.destroy()
      resolve({ contentType: ct, isPlaylist, isFlv, finalUrl: parsed.href })
    })
    req.on('error', () => resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url }))
    req.setTimeout(8000, () => { req.destroy(); resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url }) })
  })
}

function probeContentTypeCore(url, headers, redirectsLeft, resolve, forStreaming) {
  if (redirectsLeft <= 0) return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url })
  if (!/^https?:\/\//i.test(url)) return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url })

  let parsed
  try { parsed = new URL(url) } catch (_) { return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url }) }

  const httpMod = parsed.protocol === 'https:' ? https : http
  const sendHeaders = buildReqHeaders(parsed, headers)

  // HEAD-first probe: follow redirects, check Content-Type header (no body consumed, safe for one-time tokens)
  const req = httpMod.request(parsed, {
    method: 'HEAD',
    headers: sendHeaders,
    rejectUnauthorized: false,
    family: getIpFamily(parsed),
    timeout: forStreaming ? 0 : 8000,
  }, res => {
    const status = res.statusCode || 200
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
    const loc = (res.headers['location'] || res.headers['Location'] || '')

    // Parse Set-Cookie from HEAD response (some servers set cookies on redirect check)
    const setCookieData = extractSetCookieHeaders(res.headers)
    if (setCookieData) {
      try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
    }

    if ([301, 302, 303, 307, 308].includes(status) && loc) {
      res.destroy()
      const nextUrl = resolveUrl(parsed.href, loc)
      probeContentTypeCore(nextUrl, headers, redirectsLeft - 1, resolve, forStreaming)
      return
    }

    // Detect format from Content-Type header (NO body consumed)
    if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl') || ct.includes('audio/mpegurl')) {
      res.destroy()
      return resolve({ contentType: ct, isPlaylist: true, isFlv: false, finalUrl: parsed.href })
    }
    if (ct.includes('video/x-flv') || ct.includes('video/flv')) {
      res.destroy()
      return resolve({ contentType: ct, isPlaylist: false, isFlv: true, finalUrl: parsed.href })
    }
    if (ct.includes('video/mp2t') || ct.includes('video/mpeg') || ct.includes('video/mp4')) {
      res.destroy()
      return resolve({ contentType: ct, isPlaylist: false, isFlv: false, finalUrl: parsed.href })
    }

    // Ambiguous Content-Type — fall back to GET + body-read (only for non-streaming probes)
    res.destroy()
    if (forStreaming) {
      // Don't consume body for streaming token URLs; guess from URL pattern
      const urlLower = parsed.pathname.toLowerCase()
      if (urlLower.endsWith('.m3u8') || urlLower.endsWith('.m3u')) {
        return resolve({ contentType: ct, isPlaylist: true, isFlv: false, finalUrl: parsed.href })
      }
      if (urlLower.endsWith('.flv')) {
        return resolve({ contentType: ct, isPlaylist: false, isFlv: true, finalUrl: parsed.href })
      }
      if (urlLower.endsWith('.mp4') || urlLower.endsWith('.mov') || urlLower.endsWith('.webm') || urlLower.endsWith('.mkv')) {
        return resolve({ contentType: 'video/mp4', isPlaylist: false, isFlv: false, finalUrl: parsed.href })
      }
      if (urlLower.endsWith('.ts') || urlLower.endsWith('.m2ts')) {
        return resolve({ contentType: 'video/mp2t', isPlaylist: false, isFlv: false, finalUrl: parsed.href })
      }
      // Can't determine — resolve as unknown, caller must handle
      return resolve({ contentType: ct, isPlaylist: false, isFlv: false, finalUrl: parsed.href })
    }

    probeContentTypeCoreGet(url, headers, redirectsLeft, resolve)
  })

  req.on('error', () => {
    // HEAD failed (some servers don't support it) — fall back to GET probe
    probeContentTypeCoreGet(url, headers, redirectsLeft, resolve)
  })
  if (forStreaming) {
    req.on('socket', (s) => { s.setNoDelay(true) })
    req.setTimeout(0)
  } else {
    req.setTimeout(8000, () => { req.destroy(); resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: parsed.href }) })
  }
  req.end()
}

function probeContentTypeCoreGet(url, headers, redirectsLeft, resolve) {
  if (redirectsLeft <= 0) return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url })
  if (!/^https?:\/\//i.test(url)) return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url })

  let parsed
  try { parsed = new URL(url) } catch (_) { return resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: url }) }

  const httpMod = parsed.protocol === 'https:' ? https : http
  const sendHeaders = buildReqHeaders(parsed, headers)

  const req = httpMod.get(parsed, {
    headers: sendHeaders,
    rejectUnauthorized: false,
    family: getIpFamily(parsed),
    timeout: 8000,
  }, res => {
    const status = res.statusCode || 200
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
    const loc = (res.headers['location'] || res.headers['Location'] || '')

    // Parse Set-Cookie from GET probe response
    const setCookieData = extractSetCookieHeaders(res.headers)
    if (setCookieData) {
      try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
    }

    if ([301, 302, 303, 307, 308].includes(status) && loc) {
      res.destroy()
      const nextUrl = resolveUrl(parsed.href, loc)
      probeContentTypeCoreGet(nextUrl, headers, redirectsLeft - 1, resolve)
      return
    }

    const chunks = []
    let resolved = false

    res.on('data', (chunk) => {
      if (resolved) return
      chunks.push(chunk)
      const totalSize = chunks.reduce((s, c) => s + c.length, 0)

      if (totalSize >= 4096) {
        resolved = true
        res.destroy()
        const buf = Buffer.concat(chunks)
        const str = buf.toString('utf8').substring(0, 4096)
        const isPlaylist = str.startsWith('#EXTM3U') || str.includes('\n#EXTM3U')
        const isFlv = buf[0] === 0x46 && buf[1] === 0x4C && buf[2] === 0x56
        resolve({ contentType: ct, isPlaylist, isFlv, finalUrl: parsed.href })
      }
    })

    res.on('end', () => {
      if (resolved) return
      resolved = true
      const buf = Buffer.concat(chunks)
      const str = buf.toString('utf8')
      let isPlaylist = str.startsWith('#EXTM3U') || str.includes('\n#EXTM3U')
      let isFlv = buf.length >= 3 && buf[0] === 0x46 && buf[1] === 0x4C && buf[2] === 0x56
      if (!isPlaylist && !isFlv) {
        const urlLower = parsed.pathname.toLowerCase()
        if (urlLower.endsWith('.m3u8') || urlLower.endsWith('.m3u')) isPlaylist = true
        else if (urlLower.endsWith('.flv')) isFlv = true
      }
      resolve({ contentType: ct, isPlaylist, isFlv, finalUrl: parsed.href })
    })

    res.on('error', () => {
      if (!resolved) { resolved = true; resolve({ contentType: ct, isPlaylist: false, isFlv: false, finalUrl: parsed.href }) }
    })
  })

  req.on('error', () => {
    resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: parsed.href })
  })
  req.setTimeout(8000, () => { req.destroy(); resolve({ contentType: '', isPlaylist: false, isFlv: false, finalUrl: parsed.href }) })
}

function doProxyFetchNode(url, sessionHeaders, redirectsLeft, resolve, reject, depth, allowRetry = true, isolateCookies = false) {
  if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
  if (!/^https?:\/\//i.test(url)) return reject(new Error('Invalid URL: ' + url))

  let parsed
  try { parsed = new URL(url) } catch (_) { return reject(new Error('Malformed URL: ' + url)) }

  const sendHeaders = buildReqHeaders(parsed, sessionHeaders)

  const protocol = parsed.protocol === 'https:' ? https : http
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: sendHeaders,
    timeout: 15000,
    rejectUnauthorized: false,
    family: getIpFamily(parsed),
    agent: parsed.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
  }

  const req = protocol.request(options, (res) => {
    const status = res.statusCode || 200
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
    const loc = (res.headers['location'] || res.headers['Location'] || '')

    const setCookieData = extractSetCookieHeaders(res.headers)
    if (setCookieData && !isolateCookies) {
      try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
    }

    if (status >= 300 && status < 400 && loc) {
      res.resume()
      const nextUrl = resolveUrl(parsed.href, loc)
      doProxyFetchNode(nextUrl, sessionHeaders, redirectsLeft - 1, resolve, reject, depth + 1, true, isolateCookies)
      return
    }

    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      const buf = Buffer.concat(chunks)
      const ce = res.headers['content-encoding'] || ''
      let bodyBuf = buf
      try {
        if (ce.includes('gzip')) bodyBuf = zlib.gunzipSync(buf)
        else if (ce.includes('deflate')) bodyBuf = zlib.inflateSync(buf)
      } catch (_) {}

      const bodyStr = bodyBuf.toString('utf8')
      const isPlaylist = bodyStr.startsWith('#EXTM3U') || bodyStr.includes('\n#EXTM3U')
      const finalCt = isPlaylist ? 'application/vnd.apple.mpegurl' : ct

      resolve({
        status,
        contentType: finalCt,
        body: bodyBuf,
        isPlaylist,
        finalUrl: url,
      })
    })
    res.on('error', e => {
      logError(`PROXY-FETCH-NODE RES ERROR depth=${depth}: ${e.message}`)
      reject(e)
    })
  })

  req.on('error', e => {
    logError(`PROXY-FETCH-NODE REQ ERROR depth=${depth}: ${e.message}`)
    // keep-alive 复用的空闲连接可能已被 CDN 主动关闭（ECONNRESET / socket hang up），
    // 这种情况重试一次即可（Agent 会自动换成新连接）。
    if (allowRetry && (e.code === 'ECONNRESET' || /socket hang up|ECONNRESET/i.test(e.message || ''))) {
      logVerbose(`PROXY-FETCH-NODE: retry after ${e.code || e.message}`)
      doProxyFetchNode(url, sessionHeaders, redirectsLeft, resolve, reject, depth, false, isolateCookies)
      return
    }
    reject(e)
  })
  req.on('timeout', () => {
    req.destroy()
    reject(new Error('timeout'))
  })
  req.end()
}

function proxyFetch(sessionBaseUrl, sessionHeaders, reqPath, maxRedirects = 20) {
  let targetUrl
  if (reqPath.startsWith('seg/')) {
    // 与 rewritePlaylistUrls 配对：分片 URL 结尾补的原始扩展名（.ts/.m4s 等）在 base64 解码前剥除
    const encoded = reqPath.slice(4).replace(/\.([a-z0-9]{2,5})$/i, '')
    try { targetUrl = fromBase64Url(encoded).toString('utf8') } catch (_) {}
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) return Promise.reject(new Error('bad segment URL'))
  } else if (reqPath === 'stream') {
    targetUrl = sessionBaseUrl
  } else {
    targetUrl = sessionBaseUrl.replace(/\/?$/, '/') + reqPath.replace(/^\//, '')
  }

  return new Promise((resolve, reject) => {
    logVerbose(`PROXY-FETCH: reqPath=${reqPath} depth=0`)
    doProxyFetch(targetUrl, sessionHeaders, maxRedirects, resolve, reject, 0)
  })
}

// net.request 的 Chromium 网络栈会对 setHeader 施加浏览器安全策略：
//   1. Host / Content-Length 是受限头，显式设置触发 net::ERR_INVALID_ARGUMENT；
//   2. Referer 若为 https 而请求为 http（央视频/百度 CDN 即此场景）会触发
//      net::ERR_BLOCKED_BY_CLIENT（Referer 降级保护）。
// Node.js 原生 http/https 栈是裸 socket 客户端，无任何上述限制，所以当初
// "回退 Node 栈能放、纯 net.request 不能放"。修复方式：这些受限头不再走
// setHeader，而是经 session.defaultSession.webRequest.onBeforeSendHeaders
// 注入（Chromium 官方支持的加头途径，不受降级拦截），Host 则交由 Chromium
// 依据 URL 自动补齐。
const proxyFetchHeaderInjections = new Map() // url -> { Referer, ... }

function doProxyFetch(url, sessionHeaders, redirectsLeft, resolve, reject, depth, retry403Left = 2) {
  logVerbose(`PROXY-FETCH: url=${url.substring(0, 100)} depth=${depth}`)
  if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
  if (!/^https?:\/\//i.test(url)) return reject(new Error('Invalid URL: ' + url))

  let parsed
  try { parsed = new URL(url) } catch (_) { return reject(new Error('Malformed URL: ' + url)) }

  const sendHeaders = buildReqHeaders(parsed, sessionHeaders)

  // 通用拉流：net.request（Chromium 网络栈）为主路径，模拟浏览器请求，
  // 兼容只认浏览器 TLS 指纹的 CDN（央视频等）。主路径失败（传输错误 / 超时 /
  // 5xx / 403 重试耗尽）时回退 Node.js 原生栈（doProxyFetchNode）兜底——
  // 部分 CDN 对 Node 栈更友好（无浏览器 TLS 指纹 / Referer 降级限制）。
  logVerbose(`PROXY-FETCH: branch=net.request (browser sim) url=${url.substring(0, 80)}`)
  // Use Electron's net.request (Chromium network stack) with automatic redirect handling.
  const req = net.request({
    method: 'GET',
    url: parsed.href,
  })

  // 经 Electron net API 下发请求头。
  // Host / Content-Length 是受限头（setHeader 触发 net::ERR_INVALID_ARGUMENT），跳过，
  // Host 由 Chromium 依据 URL 自动补齐；Referer 若为 https 而请求为 http 会触发
  // net::ERR_BLOCKED_BY_CLIENT，改为经 webRequest.onBeforeSendHeaders 注入。
  if (sendHeaders) {
    const injectHeaders = {}
    for (const [key, val] of Object.entries(sendHeaders)) {
      const lk = key.toLowerCase()
      if (lk === 'host' || lk === 'content-length') continue
      if (lk === 'referer') { if (val) injectHeaders[key] = val; continue }
      try { req.setHeader(key, val) } catch (_) {}
    }
    if (Object.keys(injectHeaders).length) {
      proxyFetchHeaderInjections.set(parsed.href, injectHeaders)
    }
  }

  let resolved = false

  // net.request 主路径失败时回退 Node.js 原生栈（裸 socket，无浏览器 TLS 指纹 /
  // Referer 降级限制）。回退后全程走 Node 栈（doProxyFetchNode 内部重定向/重试只在
  // 自己栈内递归），不再切回 net.request，避免死循环。
  const fallbackToNode = (reason) => {
    if (resolved) return
    resolved = true
    clearTimeout(timeout)
    proxyFetchHeaderInjections.delete(parsed.href)
    try { req.abort() } catch (_) {}
    logWarn(`PROXY-FETCH: net.request 失败(${reason || 'unknown'})，回退 Node 原生栈 url=${url.substring(0, 80)}`)
    doProxyFetchNode(url, sessionHeaders, redirectsLeft, resolve, reject, depth)
  }

  const timeout = setTimeout(() => {
    proxyFetchHeaderInjections.delete(parsed.href)
    if (!resolved) fallbackToNode('timeout')
  }, 15000)

  req.on('response', (res) => {
    proxyFetchHeaderInjections.delete(parsed.href)
    const status = res.statusCode || 200
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
    const loc = (res.headers['location'] || res.headers['Location'] || '')

    // 长江云（hbtv）等 CDN 对新会话的首次清单请求固定返回 403，第二次才放行。
    // 命中 403 时对同一地址原样重试（最多 retry403Left 次）；重试耗尽仍 403 则回退
    // Node 原生栈（部分 CDN 对 Node 栈更友好），而不是把 403 直接透传给播放器。
    if (status === 403) {
      if (retry403Left > 0) {
        resolved = true; clearTimeout(timeout); res.destroy()
        logWarn(`PROXY-FETCH: CDN 403, warmup retry (left=${retry403Left - 1}) url=${url.substring(0, 80)}`)
        doProxyFetch(url, sessionHeaders, redirectsLeft, resolve, reject, depth, retry403Left - 1)
      } else {
        res.destroy()
        fallbackToNode('CDN 403 (warmup retries exhausted)')
      }
      return
    }

    // 5xx 同样回退 Node 原生栈（TLS 指纹 / 请求头差异下可能拿到 200），
    // 只有 Node 栈也失败才最终上抛给会话层兜底。
    if (status >= 500) {
      res.destroy()
      logWarn(`PROXY-FETCH: CDN ${status}, fallback to Node url=${url.substring(0, 80)}`)
      fallbackToNode(`CDN ${status}`)
      return
    }

    // Parse Set-Cookie from response headers (now works for every redirect step)
    const setCookieData = extractSetCookieHeaders(res.headers)
    if (setCookieData) {
      try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
    }

    if ([301, 302, 303, 307, 308].includes(status) && loc) {
      resolved = true; clearTimeout(timeout); res.destroy()
      const nextUrl = resolveUrl(parsed.href, loc)
      doProxyFetch(nextUrl, sessionHeaders, redirectsLeft - 1, resolve, reject, depth + 1)
      return
    }

    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      const buf = Buffer.concat(chunks)
      const ce = res.headers['content-encoding'] || ''
      let bodyBuf = buf
      try {
        if (ce === 'gzip') bodyBuf = zlib.gunzipSync(buf)
        else if (ce === 'deflate') bodyBuf = zlib.inflateSync(buf)
      } catch (_) {}

      const bodyStr = bodyBuf.toString('utf8')
      const isPlaylist = bodyStr.startsWith('#EXTM3U') || bodyStr.includes('\n#EXTM3U')
      const finalCt = isPlaylist ? 'application/vnd.apple.mpegurl' : ct

      resolve({
        status,
        contentType: finalCt,
        body: bodyBuf,
        isPlaylist,
        finalUrl: url,
      })
    })
    res.on('error', e => {
      if (resolved) return
      logError(`PROXY RES ERROR depth=${depth}: ${e.message}`)
      fallbackToNode(e.message)
    })
  })

  req.on('error', e => {
    proxyFetchHeaderInjections.delete(parsed.href)
    if (resolved) return
    logWarn(`PROXY REQ ERROR depth=${depth}: ${e.message}`)
    fallbackToNode(e.message || e.code)
  })

  req.end()
}

// ============ Universal Stream Session Proxy ============
const streamSessions = new Map()
let proxyServer = null
let proxyPort = 0

// 央视频 CDN 的 m3u8 签名地址是一次性 token：第一次 GET 返回 200，第二次立即 403。
// 本地代理因此必须：(1) 用短缓存吸收 hls.js / FFmpeg / mpv / vlc 启动时的连续重复拉取；
// (2) 一旦发现 m3u8 拉取失败（403），立即重新调用站点解析接口拿全新签名地址并重试，
// 而不是把 403 直接透传给播放器。短缓存时长参考 YSPlayer1.5 的 500ms 并适当放宽。
const M3U8_CACHE_TTL = 800

// 虎牙/斗鱼等第三方换票网关（site='generic'）的清单换票接口响应很慢（实测 ~7s），
// 而分片（hs.hls.huya.com 等）与换票网关分属不同域名。若每次清单刷新都同步等待慢网关，
// 客户端缓冲会在等待期间耗尽，触发 hls.js bufferStalledError 循环重载。
// 解决：对 generic 站点启用「清单后台预热」——清单成功返回后立即在后台连续拉新清单并缓存，
// hls.js 刷新清单时直接命中预热缓存，不再同步等待慢网关。缓存 TTL 必须覆盖一次预热往返
// （预热间隔 + 网关耗时），否则预热窗口内缓存过期又会退化为同步慢请求。
// 预热间隔不宜过密（虎牙等 CDN 对清单域名仍有访问频率限制，400ms 级高频轮询易触发 403），
// 取 ~1.5s 已远小于清单刷新节奏（每 2~4s 一次），足以让缓存始终处于有效期内。
const PREWARM_CACHE_TTL = 8000
const PREWARM_INTERVAL_MS = 1500

const localFileSessions = new Map()
let localFileServer = null
let localFileServerPort = 0

function ensureLocalFileServer() {
  if (localFileServer) return Promise.resolve()
  return new Promise((resolve, reject) => {
    localFileServer = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': safeCorsOrigin(req),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        })
        res.end()
        return
      }

      const urlPath = req.url || ''
      const match = urlPath.match(/^\/local-file\/([^/]+)/)
      if (!match) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
        res.end('not found')
        return
      }

      const token = match[1]
      const session = localFileSessions.get(token)
      if (!session) {
        res.writeHead(404, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
        res.end('session not found')
        return
      }

      const filePath = session.filePath
      const ext = path.extname(filePath).toLowerCase().replace('.', '')
      const contentTypes = {
        flv: 'video/x-flv', f4v: 'video/x-flv', f4a: 'video/x-flv', f4p: 'video/x-flv',
        ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t',
        m3u8: 'application/vnd.apple.mpegurl', m3u: 'application/vnd.apple.mpegurl',
        mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
        webm: 'video/webm', ogv: 'video/ogg',
      }
      const contentType = contentTypes[ext] || 'application/octet-stream'

      fs.stat(filePath, (statErr, stats) => {
        if (statErr || !stats.isFile()) {
          res.writeHead(404, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
          res.end('file not found')
          return
        }

        const fileSize = stats.size
        const rangeHeader = req.headers.range

        if (rangeHeader) {
          const parts = rangeHeader.replace(/bytes=/, '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
          const chunkSize = end - start + 1

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': safeCorsOrigin(req),
            'Cache-Control': 'no-cache',
          })

          const stream = fs.createReadStream(filePath, { start, end })
          stream.on('error', () => { try { res.end() } catch (_) {} })
          stream.pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': safeCorsOrigin(req),
            'Cache-Control': 'no-cache',
          })

          const stream = fs.createReadStream(filePath)
          stream.on('error', () => { try { res.end() } catch (_) {} })
          stream.pipe(res)
        }
      })
    })

    localFileServer.listen(0, '0.0.0.0', () => {
      localFileServerPort = localFileServer.address().port
      logInfo(`LOCAL-FILE-SVR: server on port ${localFileServerPort}`)
      resolve()
    })
    localFileServer.on('error', reject)
  })
}

function pipeLiveStreamNode(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft) {
  logVerbose(`STREAM-PIPE: start url=${targetUrl.substring(0, 80)} redirectsLeft=${redirectsLeft}`)
  if (redirectsLeft <= 0) {
    if (!clientRes.headersSent) { clientRes.writeHead(502, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end('too many redirects') }
    return
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    if (!clientRes.headersSent) { clientRes.writeHead(400, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end('bad url') }
    return
  }

  let parsed
  try { parsed = new URL(targetUrl) } catch (_) {
    if (!clientRes.headersSent) { clientRes.writeHead(400, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end('bad url') }
    return
  }

  const sendHeaders = buildReqHeaders(parsed, sessionHeaders)

  const protocol = parsed.protocol === 'https:' ? https : http
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: sendHeaders,
    timeout: 30000,
    rejectUnauthorized: false,
    family: getIpFamily(parsed),
    agent: parsed.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
  }

  const req = protocol.request(options, (res) => {
    const status = res.statusCode || 200
    const loc = (res.headers['location'] || res.headers['Location'] || '')

    const setCookieData = extractSetCookieHeaders(res.headers)
    if (setCookieData) {
      try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
    }

    if (status >= 300 && status < 400 && loc) {
      res.resume()
      const nextUrl = resolveUrl(parsed.href, loc)
      return pipeLiveStreamNode(clientReq, clientRes, nextUrl, sessionHeaders, redirectsLeft - 1)
    }

    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || 'video/mp2t').toLowerCase()

    if (status >= 400 || /^(text\/html|text\/plain|application\/json|application\/xml)/.test(ct)) {
      res.resume()
      if (status === 403 && redirectsLeft > 1) {
        const currentReferer = sendHeaders['Referer'] || ''
        const targetOrigin = `${parsed.protocol}//${parsed.host}`
        if (currentReferer && !currentReferer.startsWith(targetOrigin)) {
          logWarn(`[STREAM-PIPE-NODE] 403 with cross-origin Referer, retry with target origin Referer`)
          const retryHeaders = { ...sessionHeaders, 'Referer': `${targetOrigin}/`, 'Origin': targetOrigin }
          return pipeLiveStreamNode(clientReq, clientRes, targetUrl, retryHeaders, redirectsLeft - 1)
        }
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(status >= 400 ? status : 415, { 'Content-Type': ct, 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) })
        clientRes.end()
      }
      return
    }

    const respHeaders = {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
    if (res.headers['content-length']) respHeaders['Content-Length'] = res.headers['content-length']
    clientRes.writeHead(status, respHeaders)

    res.pipe(clientRes)
    res.on('error', () => { try { clientRes.end() } catch (_) {} })
    clientReq.on('close', () => { try { res.destroy() } catch (_) {} })
  })

  req.on('error', (e) => {
    logError(`STREAM-PIPE-NODE error: ${e.message} url=${targetUrl.substring(0, 80)}`)
    if (!clientRes.headersSent) { clientRes.writeHead(502, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end(e.message) }
  })
  req.on('timeout', () => {
    req.destroy()
    if (!clientRes.headersSent) { clientRes.writeHead(504, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end('timeout') }
  })
  req.end()
}

// net.request（Chromium 网络栈）流式透传 FLV/TS/MP4 直播流。
// 与 m3u8 清单/分片同栈：模拟浏览器 TLS 指纹，兼容只认浏览器栈的直播 CDN。
// 仅处理「成功建立 + 视频内容」的正常透传；403/5xx/错误内容类型/传输错误/超时
// 一律回退 pipeLiveStreamNode（Node 原生栈，内部保留 cross-origin Referer 重试），
// 保证拉流主路径与清单/分片一致地「优先 Chromium、失败回退 Node」。
function pipeLiveStreamChromium(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft) {
  logVerbose(`STREAM-PIPE-CR: start url=${targetUrl.substring(0, 80)} redirectsLeft=${redirectsLeft}`)
  if (redirectsLeft <= 0) {
    pipeLiveStreamNode(clientReq, clientRes, targetUrl, sessionHeaders, 8)
    return
  }
  if (!/^https?:\/\//i.test(targetUrl)) {
    pipeLiveStreamNode(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft)
    return
  }

  let parsed
  try { parsed = new URL(targetUrl) } catch (_) {
    pipeLiveStreamNode(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft)
    return
  }

  const sendHeaders = buildReqHeaders(parsed, sessionHeaders)

  const req = net.request({ method: 'GET', url: parsed.href })

  // 与 doProxyFetch 完全一致：Host/Content-Length 是受限头必须跳过，Referer 若为
  // https-on-http 会被 Chromium 降级拦截，改经 webRequest.onBeforeSendHeaders 注入。
  const injectHeaders = {}
  for (const [key, val] of Object.entries(sendHeaders)) {
    const lk = key.toLowerCase()
    if (lk === 'host' || lk === 'content-length') continue
    if (lk === 'referer') { if (val) injectHeaders[key] = val; continue }
    try { req.setHeader(key, val) } catch (_) {}
  }
  if (Object.keys(injectHeaders).length) {
    proxyFetchHeaderInjections.set(parsed.href, injectHeaders)
  }

  let resolved = false
  let timeout = null

  const fallbackToNode = (reason) => {
    if (resolved) return
    resolved = true
    if (timeout) clearTimeout(timeout)
    proxyFetchHeaderInjections.delete(parsed.href)
    try { req.abort() } catch (_) {}
    logWarn(`STREAM-PIPE-CR: net.request 失败(${reason || 'unknown'})，回退 Node 原生栈 url=${targetUrl.substring(0, 80)}`)
    pipeLiveStreamNode(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft)
  }

  timeout = setTimeout(() => {
    proxyFetchHeaderInjections.delete(parsed.href)
    if (!resolved) fallbackToNode('timeout')
  }, 15000)

  req.on('response', (res) => {
    proxyFetchHeaderInjections.delete(parsed.href)
    const status = res.statusCode || 200
    const loc = (res.headers['location'] || res.headers['Location'] || '')
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || 'video/x-flv').toLowerCase()

    // 与 doProxyFetch 一致：net.request 不自动跟随重定向，手动递归。
    if ([301, 302, 303, 307, 308].includes(status) && loc) {
      resolved = true
      if (timeout) clearTimeout(timeout)
      res.destroy()
      const nextUrl = resolveUrl(parsed.href, loc)
      return pipeLiveStreamChromium(clientReq, clientRes, nextUrl, sessionHeaders, redirectsLeft - 1)
    }

    // 403：回退 Node 栈（Node 栈带 cross-origin Referer 重试，且部分 CDN 对 Node 栈更友好）。
    if (status === 403) {
      res.resume()
      fallbackToNode('CDN 403')
      return
    }

    // 5xx / 错误内容类型（网页/JSON 拦截页）：回退 Node 栈。
    if (status >= 400 || /^(text\/html|text\/plain|application\/json|application\/xml)/.test(ct)) {
      res.resume()
      fallbackToNode(status >= 400 ? `CDN ${status}` : `content-type ${ct}`)
      return
    }

    // 成功建立：流式透传，不再回退（数据已开始转发，回退会重复）。
    resolved = true
    if (timeout) clearTimeout(timeout)
    const respHeaders = {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }
    if (res.headers['content-length']) respHeaders['Content-Length'] = res.headers['content-length']
    clientRes.writeHead(status, respHeaders)

    res.pipe(clientRes)
    res.on('error', () => { try { clientRes.end() } catch (_) {} })
    clientReq.on('close', () => { try { res.destroy() } catch (_) {} })
  })

  req.on('error', (e) => {
    proxyFetchHeaderInjections.delete(parsed.href)
    if (resolved) return
    fallbackToNode(e.message || e.code)
  })

  req.end()
}

function pipeLiveStream(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft = 8) {
  // 直播流透传与清单/分片统一策略：优先 net.request（Chromium 网络栈）。
  // 仅在主路径失败（403/5xx/错误类型/传输错误/超时）时回退 Node 原生栈兜底。
  if (!/^https?:\/\//i.test(targetUrl)) {
    if (!clientRes.headersSent) { clientRes.writeHead(400, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end('bad url') }
    return
  }

  pipeLiveStreamChromium(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft)
}

function startProxyServer() {
  if (proxyServer) return Promise.resolve()
  return new Promise((resolve, reject) => {
    proxyServer = http.createServer((clientReq, clientRes) => {
      if (clientReq.socket) clientReq.socket.setNoDelay(true)
      const urlPath = clientReq.url || ''
      logVerbose(`PROXY-SVR: req ${clientReq.method} ${urlPath}`)
      const match = urlPath.match(/^\/session\/([^/]+)\/(.+)$/)
      if (!match) {
        clientRes.writeHead(404, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) })
        clientRes.end('not found')
        return
      }

      const sessionId = match[1]
      const reqPath = match[2]
      const session = streamSessions.get(sessionId)

      if (!session || !session.active) {
        clientRes.writeHead(404, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) })
        clientRes.end('session gone')
        return
      }

      if (clientReq.method === 'OPTIONS') {
        clientRes.writeHead(204, {
          'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        })
        clientRes.end()
        return
      }

      // 非 m3u8 直播流（TS/FLV/MP4 等）：管道直接透传，不做缓冲
      if (session.detectedFormat && session.detectedFormat !== 'm3u8' && reqPath === 'stream') {
        pipeLiveStream(clientReq, clientRes, session.baseUrl, session.headers)
        return
      }

      // m3u8 播放列表（含自动探测）：一次性 token 短缓存 + 403 自动刷新策略
      if (reqPath === 'stream') {
        handleStreamRequest(clientReq, clientRes, session, sessionId).catch(err => {
          logError(`PROXY-SVR: stream error for ${sessionId}: ${err && err.message}`)
          if (!session.active || !streamSessions.has(sessionId)) return
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) })
            clientRes.end(err && err.message ? err.message : 'stream error')
          }
        })
        return
      }

      // 分片 / 其它子资源请求：直接透传（分片地址已在播放列表里改写为 /seg/...）。
      // 央视频等 CDN 按「短时间内新建的 TLS 连接数」判定，并发多条连接会整体 403，
      // 故必须经会话级串行队列转发（见 enqueueUpstream），保证任一时刻只有一条上游
      // 请求在飞、让 keep-alive Agent 复用同一条连接。
      // 分片统一走 proxyFetch（net.request，Chromium 网络栈），与清单同栈，
      // 避免分片因走 Node.js 原生栈被只认浏览器 TLS 的 CDN 拒绝。
      // generic 站点（虎牙等）分片域名独立、无连接数限流，改为并发直连，避免串行队列
      // 把 hls.js 的并发预取强制串行化，导致「缓冲播完才拉到新分片」。
      let clientAborted = false
      clientRes.on('close', () => { if (!clientRes.writableEnded) clientAborted = true })
      const segStart = Date.now()
      const segLabel = reqPath.startsWith('seg/') ? `seg#${reqPath.slice(4, 12)}` : reqPath.slice(0, 40)
      const runSegFetch = () => {
        if (clientAborted || !session.active) return Promise.resolve({ skipped: true })
        const fetchStart = Date.now()
        return proxyFetch(session.baseUrl, session.headers, reqPath, 20).then(r => {
          logVerbose(`PROXY-SEG: upstream ${segLabel} status=${r && r.status} size=${r && r.body ? r.body.length : 0} fetchMs=${Date.now() - fetchStart} queueWaitMs=${fetchStart - segStart}`)
          return r
        })
      }
      // generic 站点分片并发直连，其余（央视频等一次性 token 站点）保持串行防 403。
      const segPromise = shouldPrewarmSession(session)
        ? runSegFetch()
        : enqueueUpstream(session, runSegFetch)
      segPromise.then(result => {
        if (!session.active || !streamSessions.has(sessionId)) return
        if (!result || result.skipped || clientAborted) return
        logVerbose(`PROXY-SEG: respond ${segLabel} totalMs=${Date.now() - segStart}`)
        const respHeaders = {
          'Content-Type': result.contentType || 'application/octet-stream',
          'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
          'Cache-Control': 'no-cache',
          'Content-Length': result.body.length,
        }
        clientRes.writeHead(result.status || 200, respHeaders)
        clientRes.end(result.body)
      }).catch(err => {
        logError(`PROXY-SVR: fetch error for ${sessionId}: ${err.message}`)
        if (clientAborted) return
        if (!session.active || !streamSessions.has(sessionId)) return
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) })
          clientRes.end(err.message)
        }
      })
    })

    proxyServer.listen(0, '0.0.0.0', () => {
      proxyPort = proxyServer.address().port
      logInfo(`PROXY-SVR: server on port ${proxyPort}`)
      resolve()
    })
    proxyServer.on('error', reject)
  })
}

// 提取媒体 URL 的文件扩展名。FFmpeg 的 HLS 解复用器会校验分片 URL 的扩展名是否落在
// allowed_segment_extensions 白名单内（否则报 "is not in allowed_segment_extensions"）。
// 本地代理把分片地址改写成 /seg/{base64url} 后，结尾不再携带原始扩展名，会导致 FFmpeg
// 拒收该分片，因此改写时需在 base64url 之后补回原始扩展名。
function extractMediaExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    const m = pathname.match(/\.([a-z0-9]{2,5})$/i)
    return m ? m[1] : 'ts'
  } catch (_) {
    return 'ts'
  }
}

function buildSegmentProxyUrl(sessionId, targetUrl) {
  const encoded = toBase64Url(Buffer.from(targetUrl))
  const ext = extractMediaExtension(targetUrl)
  return `http://127.0.0.1:${proxyPort}/session/${sessionId}/seg/${encoded}.${ext}`
}

function rewritePlaylistUrls(playlistContent, sessionId, baseUrl) {
  const lines = playlistContent.split('\n')
  const result = []

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('#') || trimmed === '') {
      result.push(line)
      continue
    }

    if (/^https?:\/\//i.test(trimmed)) {
      result.push(buildSegmentProxyUrl(sessionId, trimmed))
    } else {
      const resolved = resolveUrl(baseUrl, trimmed)
      result.push(buildSegmentProxyUrl(sessionId, resolved))
    }
  }

  return result.join('\n')
}

// 央视频等站点：m3u8 一次性 token 失效后重新解析全新签名地址。
// 返回是否拿到了一个与当前不同的新地址（只有地址真的变了，重试才有意义）。
async function refreshSessionEntry(session) {
  let meta = session.siteMeta
  if (!meta || !meta.site || meta.site === 'generic') {
    try { meta = sniffer.inferSiteMetaFromUrl(session.baseUrl) } catch (_) { meta = null }
  }
  if (!meta || !meta.site || meta.site === 'generic') return false

  try {
    sniffer.clearPlayUrlCache()
    const list = await sniffer.resolvePlayUrl(meta)
    const fresh = list && list[0]
    if (!fresh || !fresh.url) return false
    const changed = fresh.url !== session.baseUrl
    session.baseUrl = fresh.url
    if (fresh.headers && typeof fresh.headers === 'object') {
      session.headers = { ...(session.headers || {}), ...fresh.headers }
    }
    if (fresh.format) session.detectedFormat = fresh.format
    session.playlistCache = null
    logInfo(`PROXY-REFRESH: session site=${meta.site} new url=${fresh.url.substring(0, 100)}`)
    return changed
  } catch (_) {
    return false
  }
}

// 处理 /stream 播放列表请求：
// (1) 短缓存吸收 hls.js / FFmpeg / mpv / vlc 启动时的连续重复拉取；
// (2) 一次性 token 失效（403 / 网络失败）时自动重新解析全新签名地址并重试；
// (3) 仍失败则退回最后一次成功缓存，避免播放中断。
async function handleStreamRequest(clientReq, clientRes, session, sessionId) {
  const now = Date.now()
  const cache = session.playlistCache
  // generic 站点（慢网关）走预热 + 长缓存：命中缓存直接返回，不触发同步慢请求；
  // 央视频等一次性 token 站点保持短缓存，确保 token 失效后能及时重解析续签。
  const cacheTtl = shouldPrewarmSession(session) ? PREWARM_CACHE_TTL : M3U8_CACHE_TTL

  if (cache && cache.body && (now - cache.fetchedAt) < cacheTtl) {
    logVerbose(`PROXY-MANIFEST: cache hit age=${now - cache.fetchedAt}ms ttl=${cacheTtl}ms site=${(session.siteMeta && session.siteMeta.site) || 'unknown'}`)
    clientRes.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
      'Cache-Control': 'no-cache',
      // 播放列表是一次性完整响应，必须带 Content-Length：
      // 否则 Node 走 chunked，FFmpeg 会把它当作「流式资源」，EOF 语义模糊（见 networkArgs 说明）。
      'Content-Length': Buffer.byteLength(cache.body),
    })
    clientRes.end(cache.body)
    return
  }
  logVerbose(`PROXY-MANIFEST: cache miss site=${(session.siteMeta && session.siteMeta.site) || 'unknown'} age=${cache && cache.fetchedAt ? now - cache.fetchedAt : 'none'}ms ttl=${cacheTtl}ms`)

  // 长江云清单只能经真实浏览器页面上下文取回（主进程 net.request 固定 403），
  // 故此处单独走隐藏浏览器 fetch，其余站点继续走统一 net.request 代理。
  const isHbtv = !!(session.siteMeta && session.siteMeta.site === 'hbtv') || isHbtvStreamUrl(session.baseUrl)

  const fetchOnce = async () => {
    if (isHbtv) {
      try {
        const captured = await fetchHbtvManifestViaBrowser(session.baseUrl)
        if (captured && captured.text && captured.text.trimStart().startsWith('#EXTM3U')) {
          return {
            status: 200,
            contentType: 'application/vnd.apple.mpegurl',
            body: Buffer.from(captured.text, 'utf8'),
            isPlaylist: true,
            finalUrl: captured.url || session.baseUrl,
          }
        }
        return { status: (captured && captured.status) || 0, contentType: '', body: Buffer.alloc(0), isPlaylist: false, finalUrl: session.baseUrl }
      } catch (e) {
        logError(`PROXY-SVR: hbtv browser manifest fetch failed: ${e && e.message}`)
        return null
      }
    }
    try { return await enqueueUpstream(session, () => proxyFetch(session.baseUrl, session.headers, 'stream', 20)) }
    catch (_) { return null }
  }

  let result = await fetchOnce()
  logVerbose(`PROXY-MANIFEST: fetch#1 done ms=${Date.now() - now} status=${result && result.status} isPlaylist=${result && result.isPlaylist}`)

  if (!result || result.status >= 400) {
    logWarn(`PROXY-MANIFEST: fetch#1 bad status=${result && result.status}, try refreshSessionEntry site=${(session.siteMeta && session.siteMeta.site) || 'unknown'}`)
    const refreshed = await refreshSessionEntry(session)
    if (refreshed) result = await fetchOnce()
    logVerbose(`PROXY-MANIFEST: fetch#2 after refresh=${refreshed} ms=${Date.now() - now} status=${result && result.status}`)
  }

  if (!result || result.status >= 400) {
    if (cache && cache.body) {
      clientRes.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(cache.body),
      })
      clientRes.end(cache.body)
      return
    }
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) })
      clientRes.end('playlist unavailable')
    }
    return
  }

  if (result.isPlaylist) {
    const playlistBaseUrl = result.finalUrl || session.baseUrl
    const rawBody = result.body.toString('utf8')
    const purifiedBody = purifyM3u8Playlist(playlistBaseUrl, rawBody)
    const bodyToRewrite = purifiedBody || rawBody
    const rewrittenBody = rewritePlaylistUrls(bodyToRewrite, sessionId, playlistBaseUrl)
    // 更新 baseUrl 为重定向后的最终地址，避免后续请求再次触发 PHP 重定向（可能重新生成 token）。
    // 长江云例外：finalUrl 是浏览器内换出的带 extrakey/aalook 的票地址，而后续每次拉清单都需
    // 以官网内联裸流地址（session.baseUrl）在浏览器内重新换票（跨会话票会被 CDN 403），故保持 baseUrl 不变。
    if (result.finalUrl && result.finalUrl !== session.baseUrl && !isHbtv) {
      session.baseUrl = result.finalUrl
      session.detectedFormat = 'm3u8'
    }
    session.playlistCache = { body: rewrittenBody, fetchedAt: Date.now() }
    // generic 站点：清单成功返回后启动后台预热，持续更新缓存，避免后续刷新同步等待慢网关。
    ensureSessionPrewarm(session, sessionId)
    clientRes.writeHead(result.status || 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
      'Cache-Control': 'no-cache',
      'Content-Length': Buffer.byteLength(rewrittenBody),
    })
    clientRes.end(rewrittenBody)
  } else {
    // 非播放列表（例如重定向后直接是 TS/FLV 二进制）：保持原透传行为
    const respHeaders = {
      'Content-Type': result.contentType || 'application/octet-stream',
      'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
      'Cache-Control': 'no-cache',
      'Content-Length': result.body.length,
    }
    clientRes.writeHead(result.status || 200, respHeaders)
    clientRes.end(result.body)
  }
}

// 央视频等 CDN 的访问控制按「短时间内新建的 TLS 连接数」判定：并发多条连接会整体 403
// （实测结论见 sniffer.js 中 yspResolveViaBkLiveInfo 上方的注释）。播放器（hls.js）启动
// 缓冲阶段会并发拉取多个分片，若原样并发转发到 CDN 必然触发 403 风暴，随后靠 hls.js
// 的退避重试才慢慢收敛成串行请求——这就是「多次报错后成功播放」的来源。
// 这里用会话级串行队列把 m3u8 与分片请求排队，保证任一时刻只有一条上游请求在飞，
// 让 keep-alive Agent 能复用同一条连接。
function enqueueUpstream(session, task) {
  const prev = session.upstreamChain || Promise.resolve()
  const run = prev.then(() => task())
  session.upstreamChain = run.then(() => undefined, () => undefined)
  return run
}

// generic 站点（第三方换票网关，如 tv.zimtv.cn/huya.php）：清单换票慢但分片域名独立，
// 适合后台预热。央视频等一次性 token 站点后台多拉会提前耗尽 token / 触发 CDN 403，禁用。
function shouldPrewarmSession(session) {
  const site = session.siteMeta && session.siteMeta.site
  return !site || site === 'generic'
}

// 清单后台预热：仅对 generic 站点启用。清单成功返回后启动，之后在后台连续拉新清单并
// 更新 session.playlistCache，让 hls.js 的清单刷新命中缓存而非同步等待慢网关。
// 预热请求不进入 enqueueUpstream 串行队列（generic 站点的清单与分片分属不同域名，
// 并发不触发 CDN 连接数限流），从而与分片拉取并行推进，缓冲持续有货。
function ensureSessionPrewarm(session, sessionId) {
  if (!shouldPrewarmSession(session)) return
  if (session.prewarmRunning) return
  session.prewarmRunning = true

  const tick = () => {
    if (!session.active || !streamSessions.has(sessionId)) {
      session.prewarmRunning = false
      return
    }
    // 单飞：上一轮预热仍在飞（慢网关未返回），本轮跳过，避免堆积多个慢请求。
    if (session.prewarmInFlight) {
      session.prewarmTimer = setTimeout(tick, PREWARM_INTERVAL_MS)
      return
    }
    session.prewarmInFlight = (async () => {
      const t0 = Date.now()
      try {
        const r = await proxyFetch(session.baseUrl, session.headers, 'stream', 20)
        if (!session.active || !streamSessions.has(sessionId)) return
        if (r && r.isPlaylist && r.status < 400) {
          const playlistBaseUrl = r.finalUrl || session.baseUrl
          const rawBody = r.body.toString('utf8')
          const purifiedBody = purifyM3u8Playlist(playlistBaseUrl, rawBody)
          const rewrittenBody = rewritePlaylistUrls(purifiedBody || rawBody, sessionId, playlistBaseUrl)
          session.playlistCache = { body: rewrittenBody, fetchedAt: Date.now() }
          logVerbose(`PROXY-PREWARM: cache updated ms=${Date.now() - t0} status=${r.status} baseUrlChanged=${!!(r.finalUrl && r.finalUrl !== session.baseUrl)}`)
          // 与 handleStreamRequest 保持一致：换票网关若发生重定向（如 tv.zimtv.cn → 虎牙
          // m3u8 地址），更新 baseUrl 以复用最终地址，避免每轮预热重复触发重定向换票。
          if (r.finalUrl && r.finalUrl !== session.baseUrl) {
            session.baseUrl = r.finalUrl
            session.detectedFormat = 'm3u8'
          }
        } else {
          logWarn(`PROXY-PREWARM: bad result ms=${Date.now() - t0} status=${r && r.status} isPlaylist=${r && r.isPlaylist}`)
        }
      } catch (e) {
        // 预热失败静默，下一轮重试；失败不破坏现有缓存。
        logWarn(`PROXY-PREWARM: fail ms=${Date.now() - t0} err=${e && e.message}`)
      } finally {
        session.prewarmInFlight = null
        if (session.active && streamSessions.has(sessionId)) {
          session.prewarmTimer = setTimeout(tick, PREWARM_INTERVAL_MS)
        } else {
          session.prewarmRunning = false
        }
      }
    })()
  }

  session.prewarmTimer = setTimeout(tick, PREWARM_INTERVAL_MS)
}

function isHbtvStreamUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host === 'hbtv.com.cn' || host.endsWith('.hbtv.com.cn')
  } catch (_) { return false }
}

// ============ 长江云（hbtv）浏览器清单会话 ============
// 实测结论（_hbtv_eprobe*.js）：live21-cjy.hbtv.com.cn 的清单（m3u8）只对「真实浏览器
// 页面上下文内发起的 fetch」放行，且新会话首次清单请求固定 403、第二次才返回 200。
// 主进程 net.request / session.defaultSession.fetch / 纯 Node https 请求一律固定 403
// （补齐 Sec-Fetch-* / Sec-Ch-Ua / Accept-Language 等浏览器头也无济于事）。
// 分片（.ts）则只校验官网 Referer/Origin，net.request 与 Node 原生栈均可正常拿到 200。
// 因此清单必须经隐藏 BrowserWindow 的页面内 fetch 读取（带 403 暖机重试），
// 分片继续走统一会话代理的 net.request 链路。
const HBTV_BROWSER_PAGE_URL = 'https://news.hbtv.com.cn/app/tv/431'
let hbtvBrowserWin = null
let hbtvBrowserOpening = null

function ensureHbtvBrowser() {
  if (hbtvBrowserWin && !hbtvBrowserWin.isDestroyed()) return Promise.resolve(hbtvBrowserWin)
  if (hbtvBrowserOpening) return hbtvBrowserOpening
  hbtvBrowserOpening = (async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: true,
      },
    })
    win.on('closed', () => {
      if (hbtvBrowserWin === win) { hbtvBrowserWin = null; hbtvBrowserOpening = null }
    })
    // 载入官网页建立正确的 Origin/Referer/Cookie 上下文。失败或没拿到 client-id
    // 都会销毁窗口并抛错，让下一次请求重新载页。
    try {
      await win.loadURL(HBTV_BROWSER_PAGE_URL)
      // 换票接口依赖官网下发的匿名 client-id，缺它必然失败：没下发就销毁窗口、下次重新载页，
      // 避免留下一个永远换不出票的坏会话（对齐 iptv-main #ensurePage 的 client-id 校验）。
      const hasClientId = await win.webContents.executeJavaScript(
        `document.cookie.split('; ').some(item => item.startsWith('client-id='))`,
      )
      if (!hasClientId) {
        logWarn('HBTV-BROWSER: no anonymous client-id from site, destroying session')
        throw new Error('HBTV-BROWSER: no anonymous client-id from site')
      }
      hbtvBrowserWin = win
      return win
    } catch (e) {
      try { win.destroy() } catch (_) {}
      throw e
    }
  })().catch((e) => {
    if (hbtvBrowserWin && !hbtvBrowserWin.isDestroyed()) { try { hbtvBrowserWin.destroy() } catch (_) {} }
    hbtvBrowserWin = null
    throw e
  }).finally(() => {
    hbtvBrowserOpening = null
  })
  return hbtvBrowserOpening
}

function closeHbtvBrowser() {
  if (hbtvBrowserOpening) hbtvBrowserOpening.catch(() => {})
  if (hbtvBrowserWin && !hbtvBrowserWin.isDestroyed()) {
    try { hbtvBrowserWin.destroy() } catch (_) {}
  }
  hbtvBrowserWin = null
  hbtvBrowserOpening = null
}

// 经隐藏浏览器页面内完成长江云「完整取流链路」，返回 { status, text, url }。
// 关键约束（_hbtv_verify.js 实测结论）：/ajax/get_cdn_leech 换票与清单 fetch 必须在
// 同一个浏览器会话内连续发起；跨会话换出的票会被 CDN 固定 403。因此这里不能像之前那样
// 从外部传入提前换好的 ticket，必须把「读 client-id → 换票 → 重试 3 次 fetch 清单」
// 全部放在同一个页面上下文的 executeJavaScript 内执行，与 iptv-main/extractors/hbtv/
// session.js 的 page.evaluate 全链路逐行对齐。
async function fetchHbtvManifestViaBrowser(rawUrl) {
  const win = await ensureHbtvBrowser()
  const code = `(async () => {
    // 官网下发的匿名 client-id 由页面自己携带，换票接口据此签发 extrakey/aalook 防盗链参数
    const clientId = document.cookie.split('; ')
      .find(item => item.startsWith('client-id='))
      ?.split('=').slice(1).join('=') || ''
    let ticketUrl = ''
    let lastStatus = 0
    try {
      const ticketResponse = await fetch(
        '/ajax/get_cdn_leech?url=' + encodeURIComponent(${JSON.stringify(rawUrl)}) + '&client-id=' + encodeURIComponent(clientId),
        { headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store' },
      )
      const ticket = await ticketResponse.json()
      if (!ticket || !ticket.state || typeof ticket.data !== 'string' || !ticket.data) {
        return { status: ticketResponse.status, text: '', url: '', reason: (ticket && ticket.message) ? ticket.message : '防盗链接口没有返回播放地址' }
      }
      ticketUrl = ticket.data
    } catch (e) {
      return { status: 0, text: '', url: '', reason: '防盗链接口请求失败: ' + (e && e.message ? e.message : String(e)) }
    }
    // 该 CDN 对新浏览器会话的首次清单请求固定 403、第二次放行，显式重试 3 次。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(ticketUrl, { cache: 'no-store' })
        const text = await r.text()
        lastStatus = r.status
        if (r.ok && text.trimStart().startsWith('#EXTM3U')) {
          return { status: r.status, text, url: r.url || ticketUrl }
        }
      } catch (_) {}
    }
    return { status: lastStatus || 0, text: '', url: ticketUrl }
  })()`
  try {
    const result = await win.webContents.executeJavaScript(code)
    return result || { status: 0, text: '', url: '' }
  } catch (e) {
    logWarn(`HBTV-BROWSER: executeJavaScript failed: ${e && e.message}`)
    return { status: 0, text: '', url: '' }
  }
}

function createStreamSession(baseUrl, headers, detectedFormat, siteMeta) {
  const sessionId = generateId()
  // 从播放地址本身推断站点（央视频 CDN 地址携带 pid 查询参数），供 m3u8 一次性 token
  // 失效后重新解析全新签名地址使用。前端未显式传入 siteMeta 时以此为兜底。
  let resolvedMeta = siteMeta || null
  if (!resolvedMeta || !resolvedMeta.site || resolvedMeta.site === 'generic') {
    try { resolvedMeta = sniffer.inferSiteMetaFromUrl(baseUrl) } catch (_) { resolvedMeta = null }
  }
  const session = {
    active: true,
    baseUrl,
    headers: headers || {},
    detectedFormat: detectedFormat || null,
    siteMeta: resolvedMeta,
    playlistCache: null, // { body, fetchedAt }：已改写的播放列表短缓存
    upstreamChain: Promise.resolve(), // 上游请求串行队列（防止并发建连触发 CDN 403）
    prewarmTimer: null, // 清单后台预热定时器（generic 站点）
    prewarmRunning: false, // 预热循环是否已启动
    prewarmInFlight: null, // 在飞的预热 Promise（单飞，防止堆积慢请求）
  }
  streamSessions.set(sessionId, session)
  logInfo(`SESSION CREATE: ${sessionId} url=${baseUrl.substring(0, 100)} fmt=${detectedFormat || 'auto'} site=${resolvedMeta && resolvedMeta.site ? resolvedMeta.site : 'unknown'}`)
  return sessionId
}

function closeStreamSession(sessionId) {
  const session = streamSessions.get(sessionId)
  if (!session) return
  session.active = false
  if (session.prewarmTimer) {
    clearTimeout(session.prewarmTimer)
    session.prewarmTimer = null
  }
  session.prewarmRunning = false
  streamSessions.delete(sessionId)
  logInfo(`SESSION CLOSE: ${sessionId}`)
}

// ============ URL Sniffer Helpers ============
function extractVideoUrls(html, baseUrl) {
  const found = []
  const seen = new Set()

  // m3u8/m3u patterns
  const m3u8Pattern = /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.m3u8[^\s"'<>\[\]{}|\\^`]*)/gi
  // mp4 patterns
  const mp4Pattern = /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.mp4[^\s"'<>\[\]{}|\\^`]*)/gi
  // flv patterns
  const flvPattern = /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.flv[^\s"'<>\[\]{}|\\^`]*)/gi
  // mpd patterns
  const mpdPattern = /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.mpd[^\s"'<>\[\]{}|\\^`]*)/gi
  // rtmp/rtsp patterns
  const rtmpPattern = /(rtmp[ts]?:\/\/[^\s"'<>\[\]{}|\\^`]+)/gi
  // m3u8 in URL params (e.g. url=m3u8_xxx or playurl=xxx.m3u8)
  const paramPattern = /["']?(https?:\/\/[^"'\s]*?(?:m3u8?|live|stream|tv|play)[^"'\s]*?)["']?/gi
  // base64 encoded URLs in JS
  const b64Pattern = /atob\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/g
  // thunder:// pattern
  const thunderPattern = /(thunder:\/\/[^\s"'<>]+)/gi
  // magnet pattern
  const magnetPattern = /(magnet:\?xt=urn:btih:[^\s"'<>]+)/gi

  const patterns = [
    { regex: m3u8Pattern, priority: 1 },
    { regex: mp4Pattern, priority: 2 },
    { regex: flvPattern, priority: 2 },
    { regex: mpdPattern, priority: 3 },
    { regex: rtmpPattern, priority: 1 },
    { regex: thunderPattern, priority: 4 },
    { regex: magnetPattern, priority: 4 },
  ]

  for (const { regex, priority: _p } of patterns) {
    let m
    while ((m = regex.exec(html)) !== null) {
      let url = m[1]
      // Clean up the URL (remove trailing punctuation)
      url = url.replace(/[,;:!?)\]}>\s]+$/, '')
      if (url && !seen.has(url)) {
        seen.add(url)
        found.push(url)
      }
    }
  }

  // Also extract URLs from script tags that contain stream-related keywords
  const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let sm
  while ((sm = scriptPattern.exec(html)) !== null) {
    const scriptContent = sm[1]
    if (/var\s+\w*\s*=\s*["'](https?:\/\/[^"']+m3u8[^"']*)["']/gi) {
      const vp = /var\s+\w*\s*=\s*["'](https?:\/\/[^"']+m3u8[^"']*)["']/gi
      let vm
      while ((vm = vp.exec(scriptContent)) !== null) {
        if (!seen.has(vm[1])) {
          seen.add(vm[1])
          found.push(vm[1])
        }
      }
    }
  }

  // Try to decode base64 URLs from atob() calls
  let bm
  while ((bm = b64Pattern.exec(html)) !== null) {
    try {
      const decoded = Buffer.from(bm[1], 'base64').toString('utf8')
      if (/^https?:\/\//i.test(decoded) && !seen.has(decoded)) {
        seen.add(decoded)
        found.push(decoded)
      }
    } catch (_) {}
  }

  return found
}

function guessFormatFromUrl(url) {
  const lower = url.split('?')[0].split('#')[0].toLowerCase()
  if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'm3u8'
  if (lower.endsWith('.flv')) return 'flv'
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.endsWith('.mkv')) return 'mp4'
  if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return 'ts'
  if (lower.endsWith('.mpd')) return 'mpd'
  if (/^rtmp[s]?:\/\//i.test(url)) return 'rtmp'
  if (/^rtsp:\/\//i.test(url)) return 'rtsp'
  if (/m3u8/i.test(url)) return 'm3u8'
  return 'unknown'
}

// Lightweight format probe (HEAD only, no body consumption)
function probeContentTypeFast(url) {
  return new Promise((resolve) => {
    if (!/^https?:\/\//i.test(url)) {
      resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false })
      return
    }
    let parsed
    try { parsed = new URL(url) } catch (_) {
      resolve({ format: 'unknown', contentType: '', finalUrl: url, isPlaylist: false, isFlv: false })
      return
    }
    const httpMod = parsed.protocol === 'https:' ? https : http
    const req = httpMod.request(parsed, {
      method: 'HEAD',
      headers: buildReqHeaders(parsed, { 'User-Agent': BROWSER_UA }),
      rejectUnauthorized: false,
      family: getIpFamily(parsed),
      timeout: 5000,
    }, res => {
      const status = res.statusCode || 200
      const ct = (res.headers['content-type'] || '').toLowerCase()
      const loc = (res.headers['location'] || res.headers['Location'] || '')
      res.destroy()
      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        const nextUrl = resolveUrl(parsed.href, loc)
        probeContentTypeFast(nextUrl).then(resolve)
        return
      }
      let format = 'unknown'
      let isPlaylist = false
      let isFlv = false
      if (ct.includes('application/vnd.apple.mpegurl') || ct.includes('application/x-mpegurl') || ct.includes('audio/mpegurl')) {
        format = 'm3u8'; isPlaylist = true
      } else if (ct.includes('video/x-flv') || ct.includes('video/flv')) {
        format = 'flv'; isFlv = true
      } else if (ct.includes('video/mp2t') || ct.includes('video/mpeg')) {
        format = 'ts'
      } else if (ct.includes('video/mp4')) {
        format = 'mp4'
      } else {
        format = guessFormatFromUrl(url)
      }
      resolve({ format, contentType: ct, finalUrl: parsed.href, isPlaylist, isFlv })
    })
    req.on('error', () => {
      resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false })
    })
    req.setTimeout(5000, () => { req.destroy(); resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false }) })
    req.end()
  })
}

app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests,BlockAutoplay')
app.commandLine.appendSwitch('dns-result-order', 'ipv4first')
app.commandLine.appendSwitch('ignore-certificate-errors')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// ── 本机硬件解码引擎检测（只读，零阻塞） ──
// 硬解调用链：应用 → Chromium GPU 进程 → 平台原生 API（Windows 为 DXVA 的现代形式
// D3D11VA / D3D12 Video API，以及 Media Foundation MFT）→ GPU 驱动 → 硬件解码引擎
// （NVIDIA NVDEC / AMD VCN / Intel QSV / Apple VideoToolbox）。
// 引擎优先级：CPU 引擎优先（Intel Quick Sync Video、AMD APU 内置 VCN），
// 其次 GPU 引擎（NVIDIA NVDEC、AMD 独立显卡 VCN）。
//
// 重要：本模块绝不阻塞主进程。主进程一旦被同步阻塞，webview 的
// GUEST_VIEW_MANAGER_CALL 与页面加载都会排队超时，表现为切台卡顿、网页打不开。
// 因此这里不使用 execFileSync / powershell 之类的同步外部进程调用，也不在
// gpu-info-update 事件里反复调用重型的 app.getGPUInfo('complete')。

function classifyAdapterByName(name) {
  const lower = String(name || '').toLowerCase()
  if (!lower) return { vendor: '未知', engine: '未知硬件解码引擎', tier: 'gpu', api: 'D3D11VA/DXVA' }
  if (/basic render|basic display|remote display|virtual display|parsec|spacedesk|idd /.test(lower)) {
    return { vendor: 'Microsoft', engine: 'WARP 软件渲染（无硬件解码）', tier: 'software', api: 'WARP' }
  }
  if (/apple|videotoolbox|metal/.test(lower)) {
    return { vendor: 'Apple', engine: 'Apple VideoToolbox', tier: 'cpu', api: 'VideoToolbox' }
  }
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/.test(lower)) {
    return { vendor: 'NVIDIA', engine: 'NVIDIA NVDEC', tier: 'gpu', api: 'D3D11VA/DXVA（NVDEC 固定功能解码单元）' }
  }
  if (/intel/.test(lower)) {
    return { vendor: 'Intel', engine: 'Intel Quick Sync Video (QSV/MFX)', tier: 'cpu', api: 'D3D11VA/DXVA + Media Foundation MFT' }
  }
  if (/amd|radeon|ati /.test(lower)) {
    // AMD APU 核显（CPU 引擎）命名形如 "Radeon(TM) Graphics" / "Radeon Graphics" /
    // "Vega 8 Graphics"；独立显卡带具体型号（RX / PRO / XT / W 系列），据此区分。
    const discrete = /(\brx\s*\d|\brx\b|\bpro\s*\d|\bxt\b|\bxtx\b|\bw\d{3,4}\b|firepro)/.test(lower)
    return discrete
      ? { vendor: 'AMD', engine: 'AMD VCN（独立显卡）', tier: 'gpu', api: 'D3D11VA/DXVA（VCN 统一编解码块）' }
      : { vendor: 'AMD', engine: 'AMD VCN（APU 核显，CPU 引擎）', tier: 'cpu', api: 'D3D11VA/DXVA（VCN 统一编解码块）' }
  }
  if (/qualcomm|adreno/.test(lower)) {
    return { vendor: 'Qualcomm', engine: 'Qualcomm Adreno 硬件解码', tier: 'gpu', api: 'D3D11VA/DXVA' }
  }
  return { vendor: '未知', engine: '未知硬件解码引擎', tier: 'gpu', api: 'D3D11VA/DXVA' }
}

// 通过 Chromium GPU 进程异步枚举本机显示适配器（非阻塞，结果缓存）
// 相比 WMI/PowerShell，这里拿到的是 Chromium 实际可见、实际会用于解码的适配器，
// 且完全异步，不会冻结主进程事件循环。
let _systemAdaptersCache = null
let _systemAdaptersPromise = null

// 带超时的 GPU 信息查询：GPU 进程异常时 getGPUInfo 可能永不 resolve，
// 这里强制在 2.5 秒内返回，确保 IPC 不会被永久挂住。
// 必须用 'complete' 模式：只有它返回 deviceString（完整型号名）与可靠的 active 标记。
// 'basic' 模式的 active 字段恒为 false，且 auxAttributes 里没有 glRenderer，
// 无法判定当前实际承载解码的适配器。该查询只在程序启动时执行一次，之后全部走缓存，
// 因此重量级开销只发生一次，绝不会反复冻结主进程。
function getGPUInfoSafe() {
  const p = Promise.resolve(app.getGPUInfo('complete')).catch(() => null)
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
  ])
}

// 通过 Chromium GPU 进程异步枚举本机显示适配器（非阻塞，结果缓存）。
// 返回 { list, glRenderer }：list 为去重后的适配器清单，每项含 deviceString 完整型号名、
// 可靠的 active 标记与硬解引擎分类；glRenderer 用于解析实际承载解码的适配器。
async function getSystemAdapters() {
  if (_systemAdaptersCache) return _systemAdaptersCache
  if (_systemAdaptersPromise) return _systemAdaptersPromise
  _systemAdaptersPromise = (async () => {
    const list = []
    let glRenderer = ''
    try {
      const info = await getGPUInfoSafe()
      const aux = (info && info.auxAttributes) || {}
      glRenderer = aux.glRenderer || ''
      const devices = (info && info.gpuDevice) || []
      const seen = new Set()
      for (const d of devices) {
        // deviceString 才是完整型号名（如 "AMD Radeon(TM) Graphics"、
        // "NVIDIA GeForce RTX 4050 Laptop GPU"），vendorId/deviceId 只是编号，
        // 靠它们拼不出可供 classifyAdapterByName 精确分类的字符串。
        const name = String(d.deviceString || '').trim()
        const key = `${d.vendorId}:${d.deviceId}`
        if (!name || seen.has(key)) continue // 同一 vendor:device 会重复出现，去重并保留首个（通常是 active 的那条）
        seen.add(key)
        const devId = Number(d.deviceId)
        list.push({
          name,
          deviceId: Number.isFinite(devId) ? '0x' + devId.toString(16) : '',
          driverVersion: d.driverVersion || '',
          status: 'OK',
          active: !!d.active,
          ...classifyAdapterByName(name),
        })
      }
    } catch (e) {
      logWarn('GPU-DETECT: Chromium 适配器枚举失败: ' + e.message)
    }
    if (!list.length && process.platform === 'darwin') {
      list.push({ name: 'Apple VideoToolbox', driverVersion: '', status: 'OK', active: true, ...classifyAdapterByName('apple') })
    }
    const result = { list, glRenderer }
    _systemAdaptersCache = result
    _systemAdaptersPromise = null
    return result
  })()
  return _systemAdaptersPromise
}

// ── 硬解引擎检测：只读，绝不设置任何 Chromium GPU 命令行开关 ──
// app.commandLine.appendSwitch 是进程级全局配置，会同时作用于 webview 里由
// Chromium 内核加载的网页（网页自带播放模块必须保持原样），因此这里不追加
// force_low_power_gpu / ignore-gpu-blocklist / enable-zero-copy 等开关。
// 本地播放器（纯 NODE 视频流）依赖 Chromium 默认开启的硬件解码能力，
// 本模块仅提供引擎清单供本地播放器读取并在日志中做可观测性输出。

// 从 ANGLE 渲染器字符串里解析 Chromium GPU 进程实际使用的适配器
function activeAdapterFromRenderer(glRenderer) {
  const s = String(glRenderer || '')
  if (!s) return ''
  const m = s.match(/ANGLE \(([^,]+),\s*([^,]+)/)
  if (m) return `${m[1].trim()} / ${m[2].trim()}`
  return s
}

// 硬解状态结果缓存：本机 GPU 在进程生命周期内不会变化，只在程序启动时查询一次，
// 之后所有硬解调用（含本地播放器每次切台）都直接复用该结果，不再触发 GPU 往返。
let _hwStatusCache = null
let _hwStatusPromise = null

async function getHardwareDecodeStatus() {
  if (_hwStatusCache) return _hwStatusCache
  if (_hwStatusPromise) return _hwStatusPromise
  _hwStatusPromise = queryHardwareDecodeStatus()
    .then((s) => {
      _hwStatusCache = s
      return s
    })
    .catch((e) => {
      _hwStatusPromise = null
      throw e
    })
  return _hwStatusPromise
}

// 真正的查询实现：只由 getHardwareDecodeStatus 调用一次（启动预热或首个 IPC 请求）
async function queryHardwareDecodeStatus() {
  const rank = (t) => (t === 'cpu' ? 0 : t === 'gpu' ? 1 : 2)
  const { list: sysAdapters, glRenderer } = await getSystemAdapters()
  const preferred = sysAdapters.slice().sort((a, b) => rank(a.tier) - rank(b.tier))[0] || null

  const result = {
    videoDecode: 'unknown',
    hardwareAccelerated: false,
    decodeEngine: preferred ? preferred.engine : '',
    decodeApi: preferred ? preferred.api : '',
    engineTier: preferred ? preferred.tier : '',
    preferredEngine: preferred ? preferred.engine : '',
    preferredTier: preferred ? preferred.tier : '',
    actualEngine: '',
    actualAdapter: '',
    engineMatched: false,
    gpuVendor: '',
    gpuDeviceId: '',
    driverVersion: '',
    adapters: sysAdapters.map(a => ({
      name: a.name,
      driverVersion: a.driverVersion,
      vendor: a.vendor,
      deviceId: a.deviceId || '',
      active: !!a.active,
      engine: a.engine,
      tier: a.tier,
    })),
    systemAdapters: sysAdapters.map(a => ({
      name: a.name,
      driverVersion: a.driverVersion,
      vendor: a.vendor,
      engine: a.engine,
      tier: a.tier,
      active: !!a.active,
    })),
  }
  try {
    const features = app.getGPUFeatureStatus() || {}
    result.videoDecode = features.video_decode || 'unknown'
    const v = String(result.videoDecode).toLowerCase()
    // Chromium 返回 'enabled' 或 'hardware accelerated' 表示视频解码走硬件；
    // 其余（disabled_software / unavailable_software 等）表示被禁用或退化为软件解码。
    result.hardwareAccelerated = v === 'enabled' || v.includes('hardware')
  } catch (e) {
    logWarn('GPU-STATUS: getGPUFeatureStatus failed: ' + e.message)
  }
  try {
    // 适配器清单与 glRenderer 已在 getSystemAdapters 里一次性拿到，这里不再重复查询 GPU 信息。
    result.actualAdapter = activeAdapterFromRenderer(glRenderer)

    // 实际承载解码的引擎：优先用 ANGLE 渲染器字符串识别，其次用 active 适配器
    const activeAdapter = sysAdapters.find(a => a.active) || sysAdapters[0] || null
    if (!result.actualAdapter && activeAdapter) {
      // complete 模式拿不到 glRenderer 时，用 Chromium 标记为 active 的适配器名称回填，
      // 保证日志里始终能显示实际适配器与引擎，不会出现「适配器=?」。
      result.actualAdapter = activeAdapter.name
    }
    const actualText = result.actualAdapter || (activeAdapter ? activeAdapter.vendor : '') || ''
    if (actualText) {
      result.actualEngine = classifyAdapterByName(actualText).engine
    }
    if (activeAdapter) {
      result.gpuVendor = activeAdapter.vendor
      result.gpuDeviceId = activeAdapter.deviceId || ''
      result.driverVersion = activeAdapter.driverVersion
    }
    result.engineMatched = !!result.actualEngine && result.actualEngine === result.preferredEngine
  } catch (e) {
    logWarn('GPU-STATUS: getGPUInfo failed: ' + e.message)
  }
  return result
}

// 启动期预热：程序启动时查询一次硬解能力并缓存，后续一律复用，不再查询。
// 异步发起、绝不 await，因此不会阻塞主进程事件循环、不影响 webview 页面加载。
// GPU 进程初始化完成后会触发一次 gpu-info-update，此时 video_decode 与 active 标记
// 才定型，因此监听该事件清空缓存刷新一次结果（只刷新一次，complete 模式 + 超时保护，
// 开销仅此一次，之后全程命中缓存）。
function prewarmHardwareDecodeStatus() {
  getHardwareDecodeStatus().catch(() => {})
  app.once('gpu-info-update', () => {
    _hwStatusCache = null
    _hwStatusPromise = null
    _systemAdaptersCache = null
    _systemAdaptersPromise = null
    getHardwareDecodeStatus()
      .then((s) => {
        logInfo(`GPU-STATUS(启动查询): video_decode=${s.videoDecode} 硬件解码=${s.hardwareAccelerated ? '是' : '否'} 首选引擎=${s.preferredEngine || '?'}[${s.preferredTier === 'cpu' ? 'CPU 引擎优先' : s.preferredTier === 'gpu' ? 'GPU 引擎' : '未知层级'}] 实际引擎=${s.actualEngine || '?'} 引擎匹配=${s.engineMatched ? '是' : '否'} 实际适配器=${s.actualAdapter || s.gpuVendor || '?'} 驱动=${s.driverVersion || '?'}`)
        const list = (s.systemAdapters || []).map((a) => `${a.name}[${a.engine}/${a.tier}${a.active ? ',当前使用' : ''}]`).join(' | ')
        logInfo(`GPU-STATUS(启动查询): 本机适配器: ${list || '未探测到'}`)
      })
      .catch(() => {})
  })
}

app.whenReady().then(() => {
  logDebug('APP: ready, starting services')
  createWindow()

  // 统一放行渲染进程权限请求（网页版 webview 的媒体 / 通知等），
  // 本项目为本地桌面应用，此前未设置权限处理器（Electron 默认宽松），保持宽松即可。
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(true)
  })

  // 硬解能力只在程序启动时查询一次并缓存，之后所有硬解调用直接复用该结果。
  // 该调用是异步的、不 await，因此不会阻塞主进程，也不影响 webview 页面加载。
  // 硬解信息对 webview 网页播放毫无用处（网页用自己的播放内核），此模块只服务于
  // 本地纯 NODE 视频流播放器。
  prewarmHardwareDecodeStatus()

  // Start the universal proxy server
  startProxyServer()

  // --- Dev-mode: periodic memory monitoring ---
  if (isDev) {
    const memInterval = setInterval(() => {
      const mem = process.memoryUsage()
      const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(1)
      const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(1)
      const rssMB = (mem.rss / 1024 / 1024).toFixed(1)
      logVerbose(`MEMORY: heap=${heapUsedMB}/${heapTotalMB}MB rss=${rssMB}MB`)
    }, 60000)
    memInterval.unref()
  }

  // --- Dev-mode self-diagnostic ---
  if (isDev) {
    setTimeout(async () => {
      const testUrls = [
        { name: '俊哥', url: 'http://home.jundie.top:81/top98.json' },
        { name: 'dxawi', url: 'https://dxawi.github.io/0/0.json' },
        { name: '南风线路', url: 'https://gh-proxy.com/https://raw.githubusercontent.com/yoursmile66/TVBox/refs/heads/main/XC.json' },
        { name: '小盒子单仓', url: 'http://xhztv.top/xhz' },
      ]
      const lines = []
      debugLog('')
      debugLog('====== SELF-DIAGNOSTIC START ======')
      debugLog(`Node version: ${process.version}`)
      debugLog(`Electron version: ${process.versions.electron}`)
      for (const t of testUrls) {
        try {
          const r = await fetchUrlWithDns(t.url, {}, 5)
          const isJson = (() => { try { JSON.parse((r || '').trim()); return true } catch { return false } })()
          const hasLives = (r || '').includes('"lives"')
          const msg = `SELF-TEST ${t.name}: OK size=${(r || '').length} json=${isJson} lives=${hasLives}`
          debugLog(msg)
          lines.push(`[DIAG] ${msg}`)
        } catch (e) {
          const msg = `SELF-TEST ${t.name}: FAIL ${e.message}`
          debugLog(msg)
          lines.push(`[DIAG] ${msg}`)
        }
      }
      debugLog('====== SELF-DIAGNOSTIC END ======')
      debugLog('')
      console.log(lines.join('\n'))
    }, 1500)
  }

  app.on('certificate-error', (event, _webContents, _url, _error, _cert, callback) => {
    console.warn('Certificate error ignored for:', _url)
    event.preventDefault()
    callback(true)
  })

  // Map of active video header injections: key → { domainName, Referer, Origin, ... }
  const videoHeaderDomains = new Map()

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (!details.requestHeaders['User-Agent']) {
      details.requestHeaders['User-Agent'] = BROWSER_UA
    }
    // 代理拉流专用：doProxyFetch 里被 setHeader 跳过的 Referer（https-on-http 会被
    // Chromium 降级拦截）在此注入。webRequest 注入不受该拦截，Node.js 原生栈也
    // 不受该拦截，这就是两者行为差异的根因。
    const proxyInj = proxyFetchHeaderInjections.get(details.url)
    if (proxyInj) {
      for (const [k, v] of Object.entries(proxyInj)) {
        if (v) details.requestHeaders[k] = v
      }
      callback({ requestHeaders: details.requestHeaders })
      return
    }
    // Inject Referer/Origin for registered video CDN domains
    // This is the standard Electron approach — works for <video>, XHR, fetch, etc.
    let reqHost = ''
    try { reqHost = new URL(details.url).hostname } catch (_) {}
    const reqHostClean = reqHost.toLowerCase().replace(/^\[|\]$/g, '')
    const isLoopbackHost = reqHostClean === 'localhost' || reqHostClean === '::1' || /^127\./.test(reqHostClean)
    // 本地回环地址（本地代理/本地文件/FFmpeg 服务）不注入视频请求头：
    // 覆盖浏览器真实 Origin 会让本地代理回显错误 CORS 头，触发 hls.js 跨域失败。
    if (!isLoopbackHost) {
      for (const [_key, injection] of videoHeaderDomains) {
        const domainName = injection.domainName || ''
        if (domainName && (reqHost.includes(domainName) || details.url.includes(domainName))) {
          for (const [k, v] of Object.entries(injection)) {
            if (k !== 'domainName' && v) {
              details.requestHeaders[k] = v
            }
          }
          break
        }
      }
    }
    callback({ requestHeaders: details.requestHeaders })
  })

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders || {}
    if (!responseHeaders['access-control-allow-origin'] && !responseHeaders['Access-Control-Allow-Origin']) {
      responseHeaders['Access-Control-Allow-Origin'] = ['*']
    }
    callback({ responseHeaders })
  })

  mainWindow.webContents.on('console-message', (_e, lvl, msg) => {
    debugLog(`R[${lvl}] ${msg}`)
  })

  ipcMain.on('renderer:log', (_event, msg) => {
    debugLog(`RENDERER: ${msg}`)
  })

  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window-close', () => mainWindow?.close())

  // --- 窗口全屏（网页线路/长江云等站点全屏依赖此通道） ---
  // 使用 BrowserWindow.setFullScreen 而不是渲染进程的 DOM requestFullscreen：
  // 1) DOM 全屏要求“用户手势”激活，由 webview(guest) 内点击触发的全屏请求
  //    无法在宿主文档里获得激活状态，会被直接拒绝；
  // 2) webview 抢走键盘焦点时宿主渲染进程收不到 F11，只能由主进程统一处理。
  ipcMain.on('window-toggle-fullscreen', () => {
    if (!mainWindow) return
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })
  ipcMain.on('window-set-fullscreen', (_event, flag) => {
    if (!mainWindow) return
    mainWindow.setFullScreen(!!flag)
  })
  ipcMain.handle('window-get-fullscreen', () => (mainWindow ? mainWindow.isFullScreen() : false))

  // --- Source List File Management ---
  ipcMain.handle('get-sources', () => loadSourcesFile())
  ipcMain.on('save-sources', (event, list) => { event.returnValue = saveSourcesFile(list) })
  ipcMain.handle('get-sources-path', () => sourcesFilePath)

  // --- Channel Cache (直播源解析缓存，每个源独立JSON文件，按源名称命名) ---
  const channelCacheDir = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'data', 'cache')
    : path.join(__dirname, '..', 'data', 'cache')
  try { fs.mkdirSync(channelCacheDir, { recursive: true }) } catch (_) {}

  function safeCacheName(name) {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_')
  }

  function cacheNameForUrl(url) {
    const sources = loadSourcesFile()
    for (const s of sources) {
      if (s.url === url) return safeCacheName(s.name) || null
    }
    return null
  }

  function cacheFileForUrl(url) {
    const name = cacheNameForUrl(url)
    if (name) {
      return path.join(channelCacheDir, `${name}.json`)
    }
    const crypto = require('crypto')
    const hash = crypto.createHash('md5').update(url).digest('hex')
    return path.join(channelCacheDir, `${hash}.json`)
  }

  ipcMain.handle('get-channel-cache-entry', (_event, url) => {
    try {
      const file = cacheFileForUrl(url)
      if (!fs.existsSync(file)) return null
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch { return null }
  })

  ipcMain.handle('set-channel-cache-entry', (_event, url, entry) => {
    try {
      fs.writeFileSync(cacheFileForUrl(url), JSON.stringify(entry), 'utf8')
      return true
    } catch { return false }
  })

  function cacheMd5FileForUrl(url) {
    const crypto = require('crypto')
    const hash = crypto.createHash('md5').update(url).digest('hex')
    return path.join(channelCacheDir, `${hash}.json`)
  }

  ipcMain.handle('delete-channel-cache-entry', (_event, url) => {
    try {
      const file = cacheFileForUrl(url)
      const md5File = cacheMd5FileForUrl(url)
      if (fs.existsSync(file)) fs.unlinkSync(file)
      if (md5File !== file && fs.existsSync(md5File)) fs.unlinkSync(md5File)
      return true
    } catch { return false }
  })

  ipcMain.handle('clear-channel-cache', () => {
    try {
      const files = fs.readdirSync(channelCacheDir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try { fs.unlinkSync(path.join(channelCacheDir, f)) } catch (_) {}
      }
      return true
    } catch { return false }
  })

  // --- Local Channels (本地直播源 verified_channels.json) ---
  // 与 sources.json 一致：EXE 旁边（便携版）/ 项目根目录（开发版），Vite 零干扰
  const localChannelsPath = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'data', 'verified_channels.json')
    : path.join(__dirname, '..', 'data', 'verified_channels.json')

  // 旧路径（首次启动自动迁移）
  const legacyChannelsPaths = [
    path.join(__dirname, '..', 'public', 'sources', 'verified_channels.json'),
    app.isPackaged ? path.join(__dirname, '..', 'dist', 'sources', 'verified_channels.json') : null,
  ].filter(Boolean)

  function ensureLocalChannelsFile() {
    if (fs.existsSync(localChannelsPath)) return
    for (const legacy of legacyChannelsPaths) {
      if (fs.existsSync(legacy)) {
        logInfo(`LOCAL-CHANNELS: migrating from ${legacy}`)
        fs.copyFileSync(legacy, localChannelsPath)
        return
      }
    }
  }

  ipcMain.handle('local-channels:read', () => {
    try {
      ensureLocalChannelsFile()
      if (fs.existsSync(localChannelsPath)) {
        const data = JSON.parse(fs.readFileSync(localChannelsPath, 'utf8'))
        logInfo(`LOCAL-CHANNELS: read ${Array.isArray(data?.lives) ? data.lives.length : 0} channels`)
        return data
      }
      return { lives: [] }
    } catch (e) {
      logError(`LOCAL-CHANNELS: read error: ${e.message}`)
      return { lives: [], error: e.message }
    }
  })

  ipcMain.handle('local-channels:write', (_event, data) => {
    try {
      fs.writeFileSync(localChannelsPath, JSON.stringify(data, null, 2), 'utf8')
      logInfo(`LOCAL-CHANNELS: wrote ${Array.isArray(data?.lives) ? data.lives.length : 0} channels`)
      return true
    } catch (e) {
      logError(`LOCAL-CHANNELS: write error: ${e.message}`)
      return false
    }
  })

  // --- 央视频频道列表 (ysp_channels.json) ---
  const yspChannelsPath = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'data', 'ysp_channels.json')
    : path.join(__dirname, '..', 'data', 'ysp_channels.json')

  ipcMain.handle('ysp-channels:read', () => {
    try {
      logDebug(`YSP-CHANNELS: read requested, path=${yspChannelsPath}`)
      const dir = path.dirname(yspChannelsPath)
      if (!fs.existsSync(dir)) {
        logDebug(`YSP-CHANNELS: read creating dir ${dir}`)
        fs.mkdirSync(dir, { recursive: true })
      }
      if (fs.existsSync(yspChannelsPath)) {
        const raw = fs.readFileSync(yspChannelsPath, 'utf8')
        logDebug(`YSP-CHANNELS: read file raw length=${raw.length}`)
        const data = JSON.parse(raw)
        logInfo(`YSP-CHANNELS: read ${Array.isArray(data?.channels) ? data.channels.length : 0} channels from ${yspChannelsPath}`)
        return data
      }
      logDebug('YSP-CHANNELS: file not found, returning empty')
      return { channels: [] }
    } catch (e) {
      logError(`YSP-CHANNELS: read error: ${e.message}`)
      return { channels: [], error: e.message }
    }
  })

  ipcMain.handle('ysp-channels:write', (_event, data) => {
    try {
      logDebug(`YSP-CHANNELS: write received data type=${typeof data} keys=${Object.keys(data||{}).join(',')}`)
      const chanCount = Array.isArray(data?.channels) ? data.channels.length : -1
      logDebug(`YSP-CHANNELS: write channels count=${chanCount} path=${yspChannelsPath}`)
      if (chanCount > 0) {
        data.channels.forEach((c, i) => logDebug(`YSP-CHANNELS:   [${i}] name="${c?.name}" url="${(c?.url||'').substring(0,60)}"`))
      }
      const dir = path.dirname(yspChannelsPath)
      if (!fs.existsSync(dir)) {
        logDebug(`YSP-CHANNELS: creating dir ${dir}`)
        fs.mkdirSync(dir, { recursive: true })
      }
      const json = JSON.stringify(data, null, 2)
      logDebug(`YSP-CHANNELS: json length=${json.length}`)
      fs.writeFileSync(yspChannelsPath, json, 'utf8')
      logInfo(`YSP-CHANNELS: wrote ${chanCount} channels => ${yspChannelsPath}`)
      return true
    } catch (e) {
      logError(`YSP-CHANNELS: write error: ${e.message} stack=${e.stack}`)
      return false
    }
  })

  ipcMain.handle('ysp-channels:openFile', () => {
    try {
      shell.showItemInFolder(yspChannelsPath)
      logInfo('YSP-CHANNELS: opened file location')
      return true
    } catch (e) {
      logError(`YSP-CHANNELS: openFile error: ${e.message}`)
      return false
    }
  })

  ipcMain.handle('ysp-channels:getPath', () => {
    return yspChannelsPath
  })

  // --- Networking Config IPC ---
  ipcMain.handle('set-networking-config', async (_event, config) => {
    if (config.hosts && Array.isArray(config.hosts)) {
      customHosts.clear()
      for (const entry of config.hosts) {
        const parts = entry.split('=', 2)
        if (parts.length === 2) customHosts.set(parts[0].trim(), parts[1].trim())
      }
      logInfo(`NET: hosts set: ${customHosts.size} entries`)
    }
    if (config.proxy) {
      proxyConfig = config.proxy
      logInfo(`NET: proxy set: ${JSON.stringify(config.proxy)}`)
    }
    return true
  })

  ipcMain.handle('network:hasIpv6', async () => {
    try {
      const interfaces = os.networkInterfaces()
      for (const iface of Object.values(interfaces)) {
        if (!iface) continue
        for (const addr of iface) {
          if (addr.family === 'IPv6' && !addr.internal) return true
        }
      }
    } catch (_) {}
    return false
  })

  ipcMain.handle('clear-networking-config', async () => {
    customHosts.clear()
    proxyConfig = null
    logInfo('NET: config cleared')
    return true
  })

  // --- File Dialog & I/O ---
  ipcMain.handle('dialog:openFile', async (_event, options = {}) => {
    logInfo('dialog:openFile 收到请求, title=' + (options.title || '') + ', filters=' + JSON.stringify(options.filters?.map(f => f.name) || []))
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择直播源文件',
      filters: options.filters || [
        { name: '直播源文件', extensions: ['json', 'm3u', 'm3u8', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    logInfo('dialog:openFile showOpenDialog result: canceled=' + result.canceled + ', filePaths.length=' + (result.filePaths?.length || 0))
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    logInfo('dialog:openFile selected: ' + filePath)
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      return { filePath, content, fileName: path.basename(filePath) }
    } catch (e) {
      // 二进制文件或读取失败 — 仍返回路径供调用方使用
      logError('dialog:openFile read error (non-text, returning path): ' + e.message)
      return { filePath, fileName: path.basename(filePath) }
    }
  })

  // 专门用于选择视频/媒体文件，不读取文件内容
  ipcMain.handle('dialog:openMediaFile', async (_event, options = {}) => {
    logInfo('dialog:openMediaFile 收到请求, title=' + (options.title || ''))
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择媒体文件',
      filters: options.filters || [
        { name: '媒体文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    logInfo('dialog:openMediaFile showOpenDialog result: canceled=' + result.canceled + ', filePaths.length=' + (result.filePaths?.length || 0))
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    logInfo('dialog:openMediaFile selected: ' + filePath)
    return { filePath, fileName: path.basename(filePath) }
  })

  ipcMain.handle('dialog:saveFile', async (_event, options = {}) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: options.title || '导出直播源',
      defaultPath: options.defaultPath || 'pclive_channels.m3u',
      filters: options.filters || [
        { name: 'M3U 播放列表', extensions: ['m3u', 'm3u8'] },
        { name: 'JSON 直播源', extensions: ['json'] },
        { name: 'TXT 文本', extensions: ['txt'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    try {
      fs.writeFileSync(result.filePath, options.content || '', 'utf8')
      return { filePath: result.filePath, success: true }
    } catch (e) {
      logError('FILE: saveFile write error: ' + e.message)
      return { error: e.message }
    }
  })

  ipcMain.handle('file:read', async (_event, filePath) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      return { filePath, content, fileName: path.basename(filePath), success: true }
    } catch (e) {
      logError('FILE: read error: ' + e.message)
      return { error: e.message }
    }
  })

  ipcMain.handle('file:exists', async (_event, filePath) => {
    return fs.existsSync(filePath)
  })

  ipcMain.handle('file:write', async (_event, filePath, content) => {
    try {
      try { fs.mkdirSync(path.dirname(filePath), { recursive: true }) } catch (_) {}
      fs.writeFileSync(filePath, content || '', 'utf8')
      return { success: true, filePath }
    } catch (e) {
      logError('FILE: write error: ' + e.message)
      return { error: e.message }
    }
  })

  ipcMain.handle('dialog:openDirectory', async (_event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择导出目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null
    return { directoryPath: result.filePaths[0] }
  })

  ipcMain.handle('dialog:scanVideoDirectory', async (_event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择包含视频的文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null

    const dirPath = result.filePaths[0]
    const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.ts', '.mts', '.m2ts', '.ogv', '.3gp', '.3g2', '.asf', '.vob', '.rmvb', '.divx']

    function scanDir(dir) {
      let results = []
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            results = results.concat(scanDir(fullPath))
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (videoExts.includes(ext)) {
              try {
                const stat = fs.statSync(fullPath)
                results.push({ name: entry.name, filePath: fullPath, size: stat.size })
              } catch (_) {
                results.push({ name: entry.name, filePath: fullPath, size: 0 })
              }
            }
          }
        }
      } catch (e) {
        logError('SCAN_DIR: error reading ' + dir + ': ' + (e.message || e))
      }
      return results
    }

    const files = scanDir(dirPath)
    logInfo('SCAN_DIR: found ' + files.length + ' video files in ' + dirPath)
    return { directoryPath: dirPath, files }
  })

  ipcMain.handle('fetch-url', async (_event, url, headers = {}) => {
    debugLog(`FETCH REQUEST: url=${url} isDev=${isDev}`)
    if (!/^https?:\/\//i.test(url)) {
      logWarn(`FETCH SKIP (bad URL): ${url}`)
      throw new Error('URL must start with http:// or https://')
    }
    try {
      const result = await fetchUrlWithDns(url, headers, 8)
      debugLog(`FETCH OK: ${url} size=${(result||'').length}`)
      return result
    } catch (e) {
      logError(`FETCH FAIL (primary): ${url}  ${e.message}  stack=${(e.stack||'').substring(0,200)}`)
      // Fallback: retry with PC Chrome UA if primary (OkHttp/Android) request failed
      try {
        const fallbackHeaders = { ...headers, 'User-Agent': BROWSER_UA }
        logWarn(`FETCH RETRY (fallback UA): ${url}`)
        const result = await fetchUrlWithDns(url, fallbackHeaders, 8)
        debugLog(`FETCH OK (fallback): ${url} size=${(result||'').length}`)
        return result
      } catch (e2) {
        logError(`FETCH FAIL (fallback): ${url}  ${e2.message}  stack=${(e2.stack||'').substring(0,200)}`)

        // GitHub mirror fallback: strip proxy → direct → mirrors
        const { strippedUrl, wasProxied } = stripGhProxy(url)
        const isGitHubUrl = wasProxied || /^https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/.+/i.test(strippedUrl)
        if (isGitHubUrl) {
          if (wasProxied && strippedUrl !== url) {
            logWarn(`FETCH RETRY (gh direct): ${strippedUrl}`)
            try {
              const result = await fetchUrlWithDns(strippedUrl, headers, 8)
              debugLog(`FETCH OK (gh direct): ${strippedUrl} size=${(result||'').length}`)
              return result
            } catch (_) {
              logError(`FETCH FAIL (gh direct): ${strippedUrl}`)
            }
          }

          // Speed-test all mirrors concurrently, pick top 2 fastest
          const fastMirrors = await getFastestGitHubMirrors()
          for (const mirror of fastMirrors) {
            const mirrorUrl = mirror + strippedUrl
            logWarn(`FETCH RETRY (gh mirror top2): ${mirrorUrl}`)
            try {
              const result = await fetchUrlWithDns(mirrorUrl, headers, 8)
              debugLog(`FETCH OK (gh mirror top2): ${mirrorUrl} size=${(result||'').length}`)
              return result
            } catch (_) {
              logError(`FETCH FAIL (gh mirror top2): ${mirrorUrl}`)
            }
          }
        }

        throw e2
      }
    }
  })

  // --- Spider fetch: returns full response with statusCode, headers, finalUrl ---
  ipcMain.handle('fetch-url-spider', async (_event, url, headers = {}) => {
    debugLog(`FETCH SPIDER REQUEST: url=${url}`)
    if (!/^https?:\/\//i.test(url)) {
      logWarn(`FETCH SPIDER SKIP (bad URL): ${url}`)
      return { content: '', statusCode: 400, headers: {}, finalUrl: url }
    }
    try {
      const result = await fetchUrlSpider(url, headers, 8)
      debugLog(`FETCH SPIDER OK: ${url} status=${result.statusCode} size=${(result.content||'').length}`)
      return result
    } catch (e) {
      logError(`FETCH SPIDER FAIL: ${url} ${e.message}`)
      return {
        content: '',
        statusCode: e?.code || 500,
        headers: {},
        finalUrl: url
      }
    }
  })

  // --- Probe stream format (ExoPlayer-style auto-detection) ---
  ipcMain.handle('probe-stream', async (_event, url, headers) => {
    logVerbose(`IPC probe-stream: url=${(url||'').substring(0, 80)}`)
    if (/^rtmp:\/\//i.test(url)) return { format: 'rtmp', contentType: '', finalUrl: url }
    if (/^rtsp:\/\//i.test(url)) return { format: 'rtsp', contentType: '', finalUrl: url }
    if (!/^https?:\/\//i.test(url)) return { format: 'unknown', contentType: '', finalUrl: url }
    try {
      const probe = await probeContentType(url, headers || {})
      let format = 'unknown'
      if (probe.isPlaylist) {
        format = 'm3u8'
      } else if (probe.isFlv) {
        format = 'flv'
      } else if (probe.contentType && (
        probe.contentType.includes('video/mp2t') ||
        probe.contentType.includes('video/mpeg')
      )) {
        format = 'ts'
      } else if (probe.contentType && probe.contentType.includes('video/mp4')) {
        format = 'mp4'
      }

      if (format === 'unknown' && probe.finalUrl) {
        const lower = probe.finalUrl.split('?')[0].split('#')[0].toLowerCase()
        if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) format = 'm3u8'
        else if (lower.endsWith('.flv')) format = 'flv'
        else if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.endsWith('.mkv')) format = 'mp4'
        else if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) format = 'ts'
      }

      if (format === 'unknown') {
        try {
          const p = new URL(url)
          const pathLower = p.pathname.toLowerCase()
          const hostLower = p.hostname.toLowerCase()
          if (/\.php\b/.test(pathLower)) {
            if (/\/(huya|douyu|yy)\.php\b/.test(pathLower)) format = 'flv'
            else format = 'm3u8'
          }
          if (/^live\.(ottiptv|metshop|iill)\.cc$/.test(hostLower) && /\/(huya|douyu|douyin|yy)\//.test(pathLower)) format = 'flv'
          if (/\.(ottiptv|metshop|iill)\.cc$/.test(hostLower) && /\/(huya|douyu|douyin|yy)\//.test(pathLower)) format = 'flv'
          if (/8505255\.xyz$/.test(hostLower)) format = 'm3u8'
          if (hostLower === 'live.264788.xyz') format = 'm3u8'
          if (/\.iill\.top$/.test(hostLower)) format = 'm3u8'
          if (hostLower === 'rihou.cc' && /\/tv\//.test(pathLower)) {
            const decodedPath = decodeURIComponent(pathLower)
            if (decodedPath.includes('[mg]')) format = 'm3u8'
          }
          if (format === 'unknown' && /(188766|52tb|migu)\.xyz$/i.test(hostLower)) format = 'm3u8'
          if (format === 'unknown' && /goodiptv\.club$/.test(hostLower) && /\.php\b/.test(pathLower)) format = 'm3u8'
          if (format === 'unknown' && /cntv\.sbs$/.test(hostLower)) format = 'm3u8'
          if (format === 'unknown' && /\blitenews\.cn$/.test(hostLower)) format = 'm3u8'
          if (format === 'unknown' && /\/pltv\//i.test(pathLower)) format = 'm3u8'
          if (format === 'unknown' && /^\/\d{6,}\//.test(pathLower)) format = 'm3u8'
        } catch (_) {}
      }

      if (format === 'unknown') {
        try {
          const probeGet = await probeContentTypeWithGet(url, headers || {})
          if (probeGet.isFlv) format = 'flv'
          else if (probeGet.isPlaylist) format = 'm3u8'
          else if (probeGet.contentType && probeGet.contentType.includes('video/mp4')) format = 'mp4'
          else if (probeGet.contentType && (probeGet.contentType.includes('video/mp2t') || probeGet.contentType.includes('video/mpeg'))) format = 'ts'
          if (format !== 'unknown' && probeGet.finalUrl) {
            probe.finalUrl = probeGet.finalUrl
          }
        } catch (_) {}
      }

      return {
        format,
        contentType: probe.contentType,
        finalUrl: probe.finalUrl || url,
        isPlaylist: probe.isPlaylist,
        isFlv: probe.isFlv
      }
    } catch (e) {
      logWarn('PROBE-STREAM failed: ' + e.message)
      return { format: 'unknown', contentType: '', finalUrl: url }
    }
  })

  // 网关URL格式探测：纯HEAD+重定向跟随，绝不消费body（安全用于一次性TOKEN）
  ipcMain.handle('probe-gateway-format', async (_event, url, headers) => {
    logVerbose(`IPC probe-gateway-format: url=${(url||'').substring(0, 80)}`)
    if (/^rtmp:\/\//i.test(url)) return { format: 'rtmp', contentType: '', finalUrl: url }
    if (/^rtsp:\/\//i.test(url)) return { format: 'rtsp', contentType: '', finalUrl: url }
    if (!/^https?:\/\//i.test(url)) return { format: 'unknown', contentType: '', finalUrl: url }
    try {
      const probe = await probeContentType(url, headers || {}, true)
      let format = 'unknown'
      if (probe.isPlaylist) {
        format = 'm3u8'
      } else if (probe.isFlv) {
        format = 'flv'
      } else if (probe.contentType && (
        probe.contentType.includes('video/mp2t') ||
        probe.contentType.includes('video/mpeg')
      )) {
        format = 'ts'
      } else if (probe.contentType && probe.contentType.includes('video/mp4')) {
        format = 'mp4'
      }

      if (format === 'unknown' && probe.finalUrl) {
        const lower = probe.finalUrl.split('?')[0].split('#')[0].toLowerCase()
        if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) format = 'm3u8'
        else if (lower.endsWith('.flv')) format = 'flv'
        else if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.endsWith('.mkv')) format = 'mp4'
        else if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) format = 'ts'
      }

      if (format === 'unknown') {
        try {
          const p = new URL(url)
          const pathLower = p.pathname.toLowerCase()
          const hostLower = p.hostname.toLowerCase()
          if (/\.php\b/.test(pathLower)) {
            if (/\/(huya|douyu|yy)\.php\b/.test(pathLower)) format = 'flv'
            else format = 'm3u8'
          }
          if (/^live\.(ottiptv|metshop|iill)\.cc$/.test(hostLower) && /\/(huya|douyu|douyin|yy)\//.test(pathLower)) format = 'flv'
          if (/\.(ottiptv|metshop|iill)\.cc$/.test(hostLower) && /\/(huya|douyu|douyin|yy)\//.test(pathLower)) format = 'flv'
          if (/8505255\.xyz$/.test(hostLower)) format = 'm3u8'
          if (hostLower === 'live.264788.xyz') format = 'm3u8'
          if (/\.iill\.top$/.test(hostLower)) format = 'm3u8'
          if (hostLower === 'rihou.cc' && /\/tv\//.test(pathLower)) {
            const decodedPath = decodeURIComponent(pathLower)
            if (decodedPath.includes('[mg]')) format = 'm3u8'
          }
          if (format === 'unknown' && /(188766|52tb|migu)\.xyz$/i.test(hostLower)) format = 'm3u8'
          if (format === 'unknown' && /goodiptv\.club$/.test(hostLower) && /\.php\b/.test(pathLower)) format = 'm3u8'
          if (format === 'unknown' && /cntv\.sbs$/.test(hostLower)) format = 'm3u8'
          if (format === 'unknown' && /\blitenews\.cn$/.test(hostLower)) format = 'm3u8'
          if (format === 'unknown' && /\/pltv\//i.test(pathLower)) format = 'm3u8'
          if (format === 'unknown' && /^\/\d{6,}\//.test(pathLower)) format = 'm3u8'
        } catch (_) {}
      }

      return {
        format,
        contentType: probe.contentType,
        finalUrl: probe.finalUrl || url,
        isPlaylist: probe.isPlaylist,
        isFlv: probe.isFlv
      }
    } catch (e) {
      logWarn('PROBE-GATEWAY-FORMAT failed: ' + e.message)
      return { format: 'unknown', contentType: '', finalUrl: url }
    }
  })

  // --- Create stream session (resolve URL + start proxy) ---
  ipcMain.handle('create-stream-session', async (_event, url, headers, detectedFormat, preferIpv6) => {
    logDebug(`IPC create-stream-session: url=${(url||'').substring(0, 80)} fmt=${detectedFormat || 'auto'} ipv6=${!!preferIpv6}`)
    await startProxyServer()
    let resolvedUrl = url
    let format = detectedFormat || 'unknown'

    if (!/^https?:\/\//i.test(url)) {
      if (/^rtmp:\/\//i.test(url)) format = 'rtmp'
      else if (/^rtsp:\/\//i.test(url)) format = 'rtsp'
    } else if (format === 'unknown' || !format) {
      // IMPORTANT: Do NOT probe (HEAD/GET) the URL here!
      // PHP redirectors (e.g. live.php?id=xxx) generate one-time tokens on each request.
      // A HEAD/GET probe would consume the token, causing the actual playback request to fail with 502.
      // Let the proxy server handle the first real request — it follows redirects and detects the format from the response.
      if (resolvedUrl) {
        const lower = resolvedUrl.split('?')[0].split('#')[0].toLowerCase()
        if (lower.endsWith('.flv')) format = 'flv'
        else if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.endsWith('.mkv')) format = 'mp4'
        else if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) format = 'ts'
        else format = 'm3u8'
      }
    }
    if (!format || format === 'unknown') format = 'm3u8'

    const sessionId = createStreamSession(resolvedUrl, headers || {}, format)
    const proxyUrl = `http://127.0.0.1:${proxyPort}/session/${sessionId}/stream`

    return { sessionId, proxyUrl, proxyPort, detectedFormat: format, resolvedUrl }
  })

ipcMain.handle('close-stream-session', async (_event, sessionId) => {
  closeStreamSession(sessionId)
  return true
})

  // 硬解能力查询（仅本地纯 NODE 流播放器使用，webview 网页播放不涉及）
  // 结果在程序启动时已查询并缓存，这里直接复用缓存，立即返回，不做任何 GPU 探测，
  // 因此本地播放器切台完全不受硬解逻辑影响。
  ipcMain.handle('get-hardware-decode-status', async () => {
    return getHardwareDecodeStatus()
  })

  // Register video header injection for a domain pattern (used by sniffer/external playback)
  // The onBeforeSendHeaders handler will inject these headers for matching requests
  ipcMain.handle('register-video-headers', async (_event, domainKey, domainName, headers) => {
    if (!domainKey || !domainName) return false
    videoHeaderDomains.set(domainKey, { domainName, ...(headers || {}) })
    logInfo(`VIDEO-HDR: registered ${domainKey} → ${domainName} (${JSON.stringify(headers).slice(0, 100)})`)
    return true
  })

  ipcMain.handle('unregister-video-headers', async (_event, domainKey) => {
    if (!domainKey) return false
    videoHeaderDomains.delete(domainKey)
    logInfo(`VIDEO-HDR: unregistered ${domainKey}`)
    return true
  })

  // --- DLNA / Casting ---
  ipcMain.handle('dlna-discover', async () => {
    try {
      const devices = await dlna.discoverDevices()
      return { success: true, devices }
    } catch (e) {
      logError('DLNA: discover error: ' + e.message)
      return { success: false, error: e.message, devices: [] }
    }
  })

  ipcMain.handle('dlna-cast', async (_event, deviceIndex, videoUrl) => {
    try {
      const devices = await dlna.discoverDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        return { success: false, error: 'Device not found' }
      }
      const device = devices[deviceIndex]
      await dlna.setAvTransportUri(device, videoUrl)
      await dlna.playDevice(device)
      logInfo(`DLNA: cast to device[${deviceIndex}] url=${videoUrl.substring(0, 80)}`)
      return { success: true }
    } catch (e) {
      logError('DLNA: cast error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('dlna-stop', async (_event, deviceIndex) => {
    try {
      const devices = await dlna.discoverDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        return { success: false, error: 'Device not found' }
      }
      await dlna.stopDevice(devices[deviceIndex])
      return { success: true }
    } catch (e) {
      logError('DLNA: stop error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('dlna-pause', async (_event, deviceIndex) => {
    try {
      const devices = await dlna.discoverDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        return { success: false, error: 'Device not found' }
      }
      await dlna.pauseDevice(devices[deviceIndex])
      return { success: true }
    } catch (e) {
      logError('DLNA: pause error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('dlna-set-volume', async (_event, deviceIndex, volume) => {
    try {
      const devices = await dlna.discoverDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        return { success: false, error: 'Device not found' }
      }
      await dlna.setVolume(devices[deviceIndex], volume)
      return { success: true }
    } catch (e) {
      logError('DLNA: setVolume error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  // --- TVLive 1.1 专用投屏 ---

  let cachedTVLiveDevices = []

  ipcMain.handle('tlv1-discover', async (_event, opts) => {
    try {
      const expanded = !!(opts && opts.expanded)
      const devices = await tvlive.discoverTVLiveDevices(expanded ? 60000 : 30000, { expanded })
      cachedTVLiveDevices = devices
      logInfo('TVLive: discovered ' + devices.length + ' device(s), expanded=' + expanded)
      return { success: true, devices }
    } catch (e) {
      logError('TVLive: discover error: ' + e.message)
      return { success: false, error: e.message, devices: [] }
    }
  })

  ipcMain.handle('tlv1-cast', async (_event, deviceIndex, videoUrl, options) => {
    const { format = 'auto', quality = 'original', position = 0, headers = {}, inputFormat = '' } = options || {}
    const useHls = format !== 'mpegts'
    const needReencode = quality !== 'original'
    let child = null
    let mirrorServer = null
    let mirrorPort = 0
    let sessionId = generateId()
    try {
      tlv1Log('INFO', `========== 开始投屏 session=${sessionId} ==========`)
      tlv1Log('INFO', `入参: format=${format} quality=${quality} position=${position} headersKeys=${Object.keys(headers || {}).join(',') || '(无)'} inputFormat=${inputFormat || '(空)'}`)
      tlv1Log('INFO', `源地址: ${String(videoUrl || '').substring(0, 200)}`)
      const devices = cachedTVLiveDevices.length > 0
        ? cachedTVLiveDevices
        : await tvlive.discoverTVLiveDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        return { success: false, error: 'Device not found' }
      }
      const device = devices[deviceIndex]
      tlv1Log('INFO', `目标设备: ${device.deviceName} @ ${device.host}:${device.port} model=${device.deviceModel || ''} mfr=${device.manufacturer || ''}`)

      // 投屏目标解析：模拟器走 adb reverse + 127.0.0.1，真实设备走局域网 IP 直连。
      // 统一复用 tvlive 的判定逻辑，覆盖市面上所有常见安卓模拟器，同时兼容真机 / TV 盒子。
      const castTarget = tvlive.resolveCastTarget(device)
      let isEmulatorDevice = castTarget.isEmulatorDevice
      let lanIp = castTarget.lanIp
      let fallbackLanIp = castTarget.fallbackLanIp
      tlv1Log('INFO', `目标解析: isEmulator=${isEmulatorDevice} lanIp=${lanIp} fallbackLanIp=${fallbackLanIp || '(无)'}`)

      // 投屏转码统一使用项目内置 FFmpeg（data/ffmpeg/ffmpeg.exe），找不到时再回退系统 PATH / resources 根目录。
      let ffmpegPath = resolveBuiltinFfmpegPath()
      if (!ffmpegPath) {
        try {
          const exts = process.platform === 'win32' ? ['', '.exe'] : ['']
          for (const ext of exts) {
            try {
              const p = path.join(process.resourcesPath, 'ffmpeg' + ext)
              if (fs.existsSync(p)) { ffmpegPath = p; break }
            } catch (_) {}
          }
          if (!ffmpegPath) {
            try {
              const result = await new Promise((res) => {
                execFile('where', ['ffmpeg'], { timeout: 3000 }, (e, stdout) => {
                  if (!e && stdout) res(stdout.trim().split('\n')[0])
                  else res(null)
                })
              })
              if (result) ffmpegPath = result
            } catch (_) {}
          }
        } catch (_) {}
      }
      if (!ffmpegPath) {
        return { success: false, error: 'FFmpeg未找到，请确认项目内置 data/ffmpeg 或设置 FFmpeg 路径' }
      }
      cachedFFmpegPath = ffmpegPath
      tlv1Log('INFO', `FFmpeg 路径: ${ffmpegPath}`)

      let inputUrl = videoUrl
      let isLocalFile = false
      if (videoUrl.startsWith('file://')) {
        let fp = decodeURIComponent(videoUrl.replace(/^file:\/\//, ''))
        if (fp.startsWith('/') && fp.length > 2 && fp.charAt(2) === ':') fp = fp.substring(1)
        inputUrl = fp
        isLocalFile = true
      } else if (/^[A-Za-z]:[/\\]/.test(videoUrl)) {
        inputUrl = videoUrl
        isLocalFile = true
      }
      tlv1Log('INFO', `输入解析: isLocalFile=${isLocalFile} inputUrl=${String(inputUrl).substring(0, 200)}`)

      // 源流为直播源时，必须携带与原播放一致的请求头（Referer / UA / 自定义头等），
      // 否则防盗链源会被源站拒绝，导致 FFmpeg 拉不到流 → 接收端黑屏。
      // 复用 buildFfmpegHeaderArgs：UA 走 user_agent，其余请求头拼进 headers（恒定注入禁缓存头）。
      const effectiveHeaders = { ...(headers && typeof headers === 'object' ? headers : {}) }
      if (!effectiveHeaders['User-Agent'] && !effectiveHeaders['user-agent']) {
        effectiveHeaders['User-Agent'] = BROWSER_UA
      }
      const headerArgs = buildFfmpegHeaderArgs(effectiveHeaders, isLocalFile)

      // HLS 输入判定：显式格式或地址扩展名任一命中即为 HLS。
      // 网络参数统一复用 buildFfmpegNetworkArgs，与播放 / 下载模块完全一致，
      // 避免对 HLS 列表误用 -reconnect_streamed（短响应读完整即 EOF，会导致重连抖动甚至拉流失败）。
      const isHlsInput = !isLocalFile && isHlsInputUrl(inputUrl, inputFormat)
      const networkArgs = buildFfmpegNetworkArgs(isLocalFile, isHlsInput)

      const qualityScale = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }

      const hlsDir = useHls ? fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-hls-')) : null
      const playlistFile = useHls ? path.join(hlsDir, 'playlist.m3u8') : null

      // 原画模式使用 -c:v copy 透传：不再硬编码 h264_mp4toannexb。
      // FFmpeg 会根据源编码自动插入对应 annexb 比特流过滤器（H.264 / HEVC 等），
      // 硬编码 h264_mp4toannexb 会导致 HEVC 等非 H.264 源直接报错退出 → 黑屏。
      const videoCodecArgs = needReencode
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-vf', `scale=-2:${qualityScale[quality] || 720}`]
        : ['-c:v', 'copy']

      const extraVideoArgs = needReencode
        ? ['-preset', 'ultrafast', '-crf', '23', '-vf', `scale=-2:${qualityScale[quality] || 720}`]
        : []

      // -ss 仅对本地文件有效，网络直播流无法seek，跳过
      const seekArgs = (isLocalFile && position > 0) ? ['-ss', String(position)] : []
      const rawArgs = [
        '-fflags', '+genpts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
        ...headerArgs,
        ...networkArgs,
        ...seekArgs,
        '-i', inputUrl,
        '-map', '0:v:0', '-map', '0:a:0?',
        ...videoCodecArgs,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      ]

      // 本地文件=VOD模式(keep all segments + ENDLIST)
      // 网络流=LIVE模式(sliding window + omit_endlist)
      let ffArgs
      if (useHls) {
        if (isLocalFile) {
          ffArgs = [
            ...rawArgs,
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '0',
            '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'),
            playlistFile,
          ]
        } else {
          ffArgs = [
            ...rawArgs,
            '-f', 'hls',
            '-hls_time', '2',
            '-hls_list_size', '6',
            '-hls_flags', 'omit_endlist',
            '-hls_segment_filename', path.join(hlsDir, 'seg_%03d.ts'),
            playlistFile,
          ]
        }
      } else {
        ffArgs = [
          ...rawArgs,
          '-f', 'mpegts',
          '-',
        ]
      }

      tlv1Log('INFO', `FFmpeg 输出: ${useHls ? 'HLS(m3u8+ts)' : 'MPEG-TS(裸流)'}`)
      tlv1Log('INFO', `FFmpeg 完整命令: ${[path.basename(ffmpegPath), ...ffArgs.map(a => (/\s/.test(a) ? `"${a}"` : a))].join(' ')}`)

      child = spawn(ffmpegPath, ffArgs, {
        stdio: ['ignore', useHls ? 'pipe' : 'pipe', 'pipe'],
        windowsHide: true,
      })

      let stderrAcc = ''
      let ffmpegExited = false

      child.stderr.on('data', (d) => {
        const txt = d.toString()
        stderrAcc += txt
        if (stderrAcc.length > 8192) stderrAcc = stderrAcc.slice(-4096)
        // 实时透传 FFmpeg 日志到投屏面板，便于排查拉流 / 编码问题
        txt.split(/\r?\n/).forEach((line) => {
          const t = line.trim()
          if (!t) return
          tlv1Log('DEBUG', `[ffmpeg] ${t}`)
        })
      })

      child.on('error', (err) => {
        logError(`TVLive: ffmpeg spawn error: ${err.message}`)
        tlv1Log('ERROR', `FFmpeg 启动失败: ${err.message}`)
        ffmpegExited = true
      })

      child.on('exit', (code) => {
        ffmpegExited = true
        logInfo(`TVLive: ffmpeg ${useHls ? 'HLS' : 'MPEG-TS'} session ${sessionId} exited code=${code}`)
        tlv1Log(code === 0 ? 'INFO' : 'ERROR', `FFmpeg 退出 code=${code}`)
        // mirrorServer 保持运行 — TV端VOD模式会自然播完(ENDLIST)，LIVE模式等待用户手动停止
        // 资源清理统一由 tlv1-stop handler 和 session 替换时处理
      })

      if (useHls) {
        // ======== HLS 静态文件服务器 ========
        const mimeTypes = {
          '.m3u8': 'application/vnd.apple.mpegurl',
          '.ts': 'video/mp2t',
        }

                mirrorServer = http.createServer(async (req, res) => {
          const clientIp = req.socket.remoteAddress
          const reqPath = (req.url || '/').split('?')[0]
          const fileName = reqPath === '/' ? 'playlist.m3u8' : path.basename(reqPath)
          const filePath = path.join(hlsDir, fileName)
          tlv1Log('DEBUG', `镜像服务收到请求: ${clientIp} ${req.method} ${req.url || '/'} -> ${fileName}${fs.existsSync(filePath) ? ' [命中]' : ' [未生成]'}`)

          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': safeCorsOrigin(req),
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            })
            res.end()
            return
          }

          const ext = path.extname(fileName).toLowerCase()

          if (!fs.existsSync(filePath)) {
            if (ext === '.m3u8') {
              const deadline = Date.now() + 5000
              let ready = false
              while (Date.now() < deadline && !ffmpegExited) {
                if (fs.existsSync(filePath)) { ready = true; break }
                await new Promise(r => setTimeout(r, 200))
              }
              if (ready) {
                tlv1Log('INFO', `HLS 列表已就绪 (等待 ${((Date.now() - deadline + 5000) / 1000).toFixed(1)}s)，客户端 ${clientIp}`)
              } else {
                tlv1Log('WARN', `HLS 列表 5 秒仍未就绪，客户端 ${clientIp}（说明 FFmpeg 没有产出画面，请查看上方 [ffmpeg] 日志）`)
              }
            }
            if (!fs.existsSync(filePath)) {
              tlv1Log('WARN', `HLS 文件未生成: ${fileName}，客户端 ${clientIp} -> 返回 404`)
              res.writeHead(404, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
              res.end('not ready')
              return
            }
          }

          const contentType = mimeTypes[ext] || 'application/octet-stream'

          try {
            const stat = fs.statSync(filePath)
            const cacheControl = ext === '.m3u8' ? 'no-cache' : 'public, max-age=5'

            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': stat.size,
              'Access-Control-Allow-Origin': safeCorsOrigin(req),
              'Cache-Control': cacheControl,
            })

            const stream = fs.createReadStream(filePath)
            stream.pipe(res)
            stream.on('error', () => { try { res.end() } catch (_) {} })
            req.on('close', () => { stream.destroy() })
          } catch (e) {
            logError(`TVLive: HLS serve error: ${e.message}`)
            try { res.writeHead(500, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) }) } catch (_) {}
            try { res.end('internal error') } catch (_) {}
          }
        })
      } else {
        // ======== MPEG-TS 管道流服务器 ========
        const clients = new Set()
        const preBuffer = []
        let firstStdoutLogged = false

        child.stdout.on('data', (chunk) => {
          if (!firstStdoutLogged) {
            firstStdoutLogged = true
            tlv1Log('INFO', `FFmpeg 已开始输出 MPEG-TS 数据 (首包 ${chunk.length} 字节)`)
          }
          preBuffer.push(chunk)
          for (const client of clients) {
            try { client.write(chunk) } catch (_) { clients.delete(client) }
          }
          while (preBuffer.reduce((s, c) => s + c.length, 0) > 512 * 1024) {
            preBuffer.shift()
          }
        })

        mirrorServer = http.createServer((req, res) => {
          const clientIp = req.socket.remoteAddress
          tlv1Log('INFO', `MPEG-TS 客户端接入: ${clientIp} ${req.method} ${req.url || '/'}`)

          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': safeCorsOrigin(req),
              'Access-Control-Allow-Methods': 'GET, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            })
            res.end()
            return
          }

          if (ffmpegExited && preBuffer.length === 0 && (!child.stdout || child.stdout.destroyed)) {
            tlv1Log('WARN', `MPEG-TS 流不可用，客户端 ${clientIp} -> 503`)
            res.writeHead(503, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
            res.end('stream unavailable')
            return
          }

          const preBufLen = preBuffer.reduce((s, c) => s + c.length, 0)
          tlv1Log('INFO', `MPEG-TS 开始推流给 ${clientIp}，当前客户端数=${clients.size + 1} 预缓冲=${preBufLen} 字节`)

          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': safeCorsOrigin(req),
            'Cache-Control': 'no-cache',
          })

          for (const chunk of preBuffer) res.write(chunk)
          clients.add(res)
          req.on('close', () => {
            clients.delete(res)
            tlv1Log('DEBUG', `MPEG-TS 客户端断开: ${clientIp} 剩余=${clients.size}`)
          })
        })
      }

      mirrorPort = await new Promise((resolveProxy, rejectProxy) => {
        mirrorServer.listen(0, '0.0.0.0', () => {
          resolveProxy(mirrorServer.address().port)
        })
        mirrorServer.on('error', rejectProxy)
        setTimeout(() => rejectProxy(new Error('mirror server start timeout')), 5000)
      })
      tlv1Log('INFO', `镜像服务已监听 0.0.0.0:${mirrorPort}`)

      // 模拟器设备：建立ADB反向转发，让模拟器内127.0.0.1:{mirrorPort} → PC {mirrorPort}
      if (isEmulatorDevice) {
        try {
          const reverseResult = await tvlive.setupAdbReverse(mirrorPort)
          if (reverseResult.success) {
            lanIp = '127.0.0.1'
            tlv1Log('INFO', `ADB 反向转发建立成功 (${reverseResult.serial})，模拟器访问 127.0.0.1:${mirrorPort}`)
          } else if (fallbackLanIp) {
            // 桥接模式的模拟器等：reverse 失败时回退局域网 IP 直连
            lanIp = fallbackLanIp
            tlv1Log('WARN', `ADB 反向转发失败(${reverseResult.error})，回退局域网IP ${fallbackLanIp}`)
          } else {
            tlv1Log('ERROR', `ADB 反向转发失败: ${reverseResult.error}，模拟器可能无法访问镜像流`)
          }
        } catch (e) {
          tlv1Log('ERROR', `ADB 反向转发异常: ${e.message}`)
          if (fallbackLanIp) lanIp = fallbackLanIp
        }
      }

      const proxyUrl = useHls
        ? `http://${lanIp}:${mirrorPort}/playlist.m3u8`
        : `http://${lanIp}:${mirrorPort}/stream`

      tlv1Log('INFO', `推流地址: ${proxyUrl}`)

      ffmpegSessions.set(sessionId, {
        active: true,
        proc: child,
        server: mirrorServer,
        sessionId,
        hlsDir: hlsDir || undefined,
        // 供 tlv1-seek 重启 FFmpeg 使用
        isLocalFile,
        useHls,
        needReencode,
        quality,
        ffmpegPath,
        inputUrl,
        lanIp,
        mirrorPort,
        device,
        isEmulatorDevice,
        codec: needReencode ? 'libx264' : 'copy',
        extraVideoArgs,
        networkArgs,
        headerArgs,
      })

      logInfo(`TVLive: cast ${useHls ? 'HLS' : 'MPEG-TS'} ${needReencode ? quality : '原画'} ${proxyUrl} to ${device.deviceName} (${device.host})`)

      await tvlive.castToTVLiveDevice(device, proxyUrl)
      tlv1Log('INFO', `已向设备下发 do=push 指令成功，等待接收端拉流（观察上方是否有「镜像服务收到请求」）`)
      logInfo(`TVLive: cast SUCCESS to device[${deviceIndex}] (${device.deviceName})`)
      return { success: true, sessionId, proxyUrl }
    } catch (e) {
      logError('TVLive: cast error: ' + e.message)
      tlv1Log('ERROR', `投屏失败: ${e.message}`)
      try { child.kill('SIGTERM') } catch (_) {}
      try { mirrorServer.close() } catch (_) {}
      if (hlsDir) try { fs.rmSync(hlsDir, { recursive: true, force: true }) } catch (_) {}
      if (ffmpegSessions.has(sessionId)) ffmpegSessions.delete(sessionId)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tlv1-stop', async (_event, deviceIndex, sessionId) => {
    try {
      const devices = cachedTVLiveDevices.length > 0
        ? cachedTVLiveDevices
        : await tvlive.discoverTVLiveDevices()
      if (deviceIndex >= 0 && deviceIndex < devices.length) {
        await tvlive.stopTVLiveDevice(devices[deviceIndex])
        logInfo('TVLive: stop device[' + deviceIndex + ']')
      }
      if (sessionId && ffmpegSessions.has(sessionId)) {
        const sess = ffmpegSessions.get(sessionId)
        try { sess.proc.kill('SIGTERM') } catch (_) {}
        try { sess.server.close() } catch (_) {}
        if (sess.hlsDir) {
          setTimeout(() => {
            try { fs.rmSync(sess.hlsDir, { recursive: true, force: true }) } catch (_) {}
          }, 3000)
        }
        sess.active = false
        ffmpegSessions.delete(sessionId)
      }
      return { success: true }
    } catch (e) {
      logError('TVLive: stop error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tlv1-pause', async (_event, _deviceIndex, sessionId, currentPosition) => {
    try {
      if (!sessionId || !ffmpegSessions.has(sessionId)) {
        return { success: false, error: 'session not found' }
      }
      const sess = ffmpegSessions.get(sessionId)
      if (!sess.active) return { success: true, message: 'already paused' }

      // 保存暂停位置
      sess.pausedPosition = typeof currentPosition === 'number' ? Math.round(currentPosition) : 0
      sess.active = false

      // 杀死 FFmpeg，保留 mirrorServer 和 hlsDir
      try { sess.proc.kill('SIGTERM') } catch (_) {}

      // 通知TV端停止播放
      try { await tvlive.stopTVLiveDevice(sess.device) } catch (_) {}

      logInfo(`TVLive: paused session ${sessionId} at ${sess.pausedPosition}s`)
      return { success: true }
    } catch (e) {
      logError('TVLive: pause error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tlv1-resume', async (_event, deviceIndex, sessionId) => {
    try {
      if (!sessionId || !ffmpegSessions.has(sessionId)) {
        return { success: false, error: 'session not found' }
      }
      const sess = ffmpegSessions.get(sessionId)
      if (sess.active) return { success: true, message: 'already active' }

      const newPos = sess.pausedPosition || 0
      logInfo(`TVLive: resume session ${sessionId} from ${newPos}s`)

      // 重建 FFmpeg 进程（复用已有的 server / hlsDir / ffmpegPath / inputUrl）
      const seekArgs = (sess.isLocalFile && newPos > 0) ? ['-ss', String(newPos)] : []
      const rawArgs = [
        '-loglevel', 'error',
        '-fflags', '+genpts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
        ...(sess.headerArgs || []),
        ...sess.networkArgs,
        ...seekArgs,
        '-i', sess.inputUrl,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', sess.codec,
        ...sess.extraVideoArgs,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      ]

      let ffArgs
      let newChild = null
      let newServer = null

      if (sess.useHls) {
        // 清理 HLS 旧分片
        if (sess.hlsDir) {
          try {
            const oldFiles = fs.readdirSync(sess.hlsDir)
            for (const f of oldFiles) {
              if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
                try { fs.unlinkSync(path.join(sess.hlsDir, f)) } catch (_) {}
              }
            }
          } catch (_) {}
        }

        const playlistFile = path.join(sess.hlsDir, 'playlist.m3u8')
        if (sess.isLocalFile) {
          ffArgs = [
            ...rawArgs,
            '-f', 'hls', '-hls_time', '2',
            '-hls_list_size', '0',
            '-hls_segment_filename', path.join(sess.hlsDir, 'seg_%03d.ts'),
            playlistFile,
          ]
        } else {
          ffArgs = [
            ...rawArgs,
            '-f', 'hls', '-hls_time', '2',
            '-hls_list_size', '6', '-hls_flags', 'omit_endlist',
            '-hls_segment_filename', path.join(sess.hlsDir, 'seg_%03d.ts'),
            playlistFile,
          ]
        }
        newChild = spawn(sess.ffmpegPath, ffArgs, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        newChild.stderr.on('data', () => {})
        newChild.on('exit', (code) => {
          logInfo(`TVLive: resumed ffmpeg(HLS) exited code=${code} (sessionId=${sessionId})`)
        })
        newChild.on('error', (err) => {
          logError(`TVLive: resumed ffmpeg(HLS) error: ${err.message}`)
        })
        sess.proc = newChild
      } else {
        // MPEG-TS 模式：重建管道服务器
        ffArgs = [...rawArgs, '-f', 'mpegts', '-']
        newChild = spawn(sess.ffmpegPath, ffArgs, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })

        try { sess.server.close() } catch (_) {}

        const tsClients = new Set()
        const tsPreBuffer = []
        let tsExited = false

        newChild.stdout.on('data', (chunk) => {
          tsPreBuffer.push(chunk)
          for (const client of tsClients) {
            try { client.write(chunk) } catch (_) { tsClients.delete(client) }
          }
          while (tsPreBuffer.reduce((s, c) => s + c.length, 0) > 512 * 1024) {
            tsPreBuffer.shift()
          }
        })
        newChild.stderr.on('data', () => {})
        newChild.on('exit', (code) => {
          tsExited = true
          logInfo(`TVLive: resumed ffmpeg(MPEG-TS) exited code=${code} (sessionId=${sessionId})`)
        })
        newChild.on('error', (err) => {
          logError(`TVLive: resumed ffmpeg(MPEG-TS) error: ${err.message}`)
        })

        newServer = http.createServer((req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': safeCorsOrigin(req), 'Access-Control-Allow-Methods': 'GET, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            })
            res.end()
            return
          }
          if (tsExited && tsPreBuffer.length === 0 && (!newChild.stdout || newChild.stdout.destroyed)) {
            res.writeHead(503, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
            res.end('stream unavailable')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': safeCorsOrigin(req),
            'Cache-Control': 'no-cache',
          })
          for (const chunk of tsPreBuffer) res.write(chunk)
          tsClients.add(res)
          req.on('close', () => { tsClients.delete(res) })
        })
        sess.mirrorPort = 0
        newServer.listen(0, '0.0.0.0', () => {
          sess.mirrorPort = newServer.address().port
        })
        // Wait for server to bind
        await new Promise((resolveListen) => {
          let waited = false
          const check = setInterval(() => {
            if (sess.mirrorPort !== 0) {
              clearInterval(check)
              if (!waited) { waited = true; resolveListen() }
            }
          }, 100)
          setTimeout(() => { clearInterval(check); if (!waited) { waited = true; resolveListen() } }, 5000)
        })
        sess.proc = newChild
        sess.server = newServer
      }

      // 等待 FFmpeg 准备好
      await new Promise(r => setTimeout(r, 800))

      // 构造 URL 并推送到 TV 设备
      const proxyUrl = sess.useHls
        ? `http://${sess.lanIp}:${sess.mirrorPort}/playlist.m3u8`
        : `http://${sess.lanIp}:${sess.mirrorPort}/stream`

      await tvlive.castToTVLiveDevice(sess.device, proxyUrl)
      sess.active = true
      logInfo(`TVLive: resumed SUCCESS session ${sessionId} url=${proxyUrl}`)
      return { success: true, sessionId, proxyUrl }
    } catch (e) {
      logError('TVLive: resume error: ' + e.message)
      try { if (newChild) newChild.kill('SIGTERM') } catch (_) {}
      try { if (newServer) newServer.close() } catch (_) {}
      const sess = ffmpegSessions.get(sessionId)
      if (sess) sess.active = false
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tlv1-get-subnets', async () => {
    try {
      const subnets = tvlive.getLocalSubnets()
      return { success: true, subnets }
    } catch (e) {
      return { success: false, error: e.message, subnets: [] }
    }
  })

  ipcMain.handle('tlv1-get-local-ips', async () => {
    try {
      const ips = tvlive.getLocalIpAddresses()
      return { success: true, ips }
    } catch (e) {
      return { success: false, error: e.message, ips: [] }
    }
  })

  ipcMain.handle('tlv1-emulator-status', async () => {
    try {
      const status = await tvlive.getEmulatorStatus()
      return { success: true, ...status }
    } catch (e) {
      return { success: false, error: e.message, available: false }
    }
  })

  // PC → TV 播放跳转同步：重启 FFmpeg 从新位置编码
  ipcMain.handle('tlv1-seek', async (_event, _deviceIndex, positionSec, sessionId) => {
    try {
      if (!sessionId || !ffmpegSessions.has(sessionId)) {
        return { success: false, error: 'session not found' }
      }
      const sess = ffmpegSessions.get(sessionId)
      if (!sess || !sess.active || !sess.device) {
        return { success: false, error: 'session inactive' }
      }

      // 网络流不支持 seek（源不可定位）
      if (!sess.isLocalFile) {
        logInfo(`TVLive: seek skipped — network stream cannot be restarted with -ss (sessionId=${sessionId})`)
        return { success: true }
      }

      const newPos = Math.round(positionSec)
      logInfo(`TVLive: seek restart FFmpeg from ${newPos}s (sessionId=${sessionId})`)

      // 1. 杀掉旧 FFmpeg 进程
      try { sess.proc.kill('SIGTERM') } catch (_) { /* 忽略 */ }

      // 2. 清理 HLS 旧分片
      if (sess.hlsDir) {
        try {
          const oldFiles = fs.readdirSync(sess.hlsDir)
          for (const f of oldFiles) {
            if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
              try { fs.unlinkSync(path.join(sess.hlsDir, f)) } catch (_) { /* 忽略 */ }
            }
          }
        } catch (_) { /* 忽略 */ }
      }

      // 3. 构建新的 FFmpeg 参数（仅 -ss 不同，其余与首次投屏 rawArgs 一致）
      const seekArgs = (sess.isLocalFile && newPos > 0) ? ['-ss', String(newPos)] : []
      const rawArgs = [
        '-loglevel', 'error',
        '-fflags', '+genpts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
        ...(sess.headerArgs || []),
        ...sess.networkArgs,
        ...seekArgs,
        '-i', sess.inputUrl,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', sess.codec,
        ...sess.extraVideoArgs,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      ]

      const useHls = sess.useHls
      let ffArgs
      let newChild

      if (useHls) {
        // ======== HLS 模式：复用已有服务器，仅重启 FFmpeg ========
        const playlistFile = path.join(sess.hlsDir, 'playlist.m3u8')
        if (sess.isLocalFile) {
          ffArgs = [
            ...rawArgs,
            '-f', 'hls', '-hls_time', '2',
            '-hls_list_size', '0',
            '-hls_segment_filename', path.join(sess.hlsDir, 'seg_%03d.ts'),
            playlistFile,
          ]
        } else {
          ffArgs = [
            ...rawArgs,
            '-f', 'hls', '-hls_time', '2',
            '-hls_list_size', '6', '-hls_flags', 'omit_endlist',
            '-hls_segment_filename', path.join(sess.hlsDir, 'seg_%03d.ts'),
            playlistFile,
          ]
        }
        newChild = spawn(sess.ffmpegPath, ffArgs, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        newChild.stderr.on('data', () => { /* 静默消费 */ })
        newChild.on('exit', (code) => {
          logInfo(`TVLive: seek-restarted ffmpeg(HLS) exited code=${code} (sessionId=${sessionId})`)
        })
        newChild.on('error', (err) => {
          logError(`TVLive: seek-restarted ffmpeg(HLS) error: ${err.message}`)
        })
        sess.proc = newChild
        // 服务器保持不变，新 FFmpeg 写入同一 hlsDir
      } else {
        // ======== MPEG-TS 模式：必须重建服务器+FFmpeg（管道绑定） ========
        ffArgs = [...rawArgs, '-f', 'mpegts', '-']
        newChild = spawn(sess.ffmpegPath, ffArgs, {
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })

        // 关闭旧服务器
        try { sess.server.close() } catch (_) { /* 忽略 */ }

        // 重建 MPEG-TS 管道服务器
        const tsClients = new Set()
        const tsPreBuffer = []
        let tsExited = false

        newChild.stdout.on('data', (chunk) => {
          tsPreBuffer.push(chunk)
          for (const client of tsClients) {
            try { client.write(chunk) } catch (_) { tsClients.delete(client) }
          }
          while (tsPreBuffer.reduce((s, c) => s + c.length, 0) > 512 * 1024) {
            tsPreBuffer.shift()
          }
        })

        newChild.stderr.on('data', () => { /* 静默消费 */ })
        newChild.on('exit', (code) => {
          tsExited = true
          logInfo(`TVLive: seek-restarted ffmpeg(MPEG-TS) exited code=${code} (sessionId=${sessionId})`)
        })
        newChild.on('error', (err) => {
          logError(`TVLive: seek-restarted ffmpeg(MPEG-TS) error: ${err.message}`)
        })

        const newServer = http.createServer((req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': safeCorsOrigin(req), 'Access-Control-Allow-Methods': 'GET, OPTIONS',
              'Access-Control-Allow-Headers': '*',
            })
            res.end()
            return
          }
          if (tsExited && tsPreBuffer.length === 0 && (!newChild.stdout || newChild.stdout.destroyed)) {
            res.writeHead(503, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
            res.end('stream unavailable')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': safeCorsOrigin(req), 'Cache-Control': 'no-cache',
          })
          for (const chunk of tsPreBuffer) res.write(chunk)
          tsClients.add(res)
          req.on('close', () => { tsClients.delete(res) })
        })

        // 尽量复用原端口，失败则换新端口
        const newPort = await new Promise((resolveProxy) => {
          newServer.on('error', () => {
            newServer.listen(0, '0.0.0.0', () => resolveProxy(newServer.address().port))
          })
          newServer.listen(sess.mirrorPort, '0.0.0.0', () => resolveProxy(newServer.address().port))
          setTimeout(() => resolveProxy(0), 5000)
        })
        if (newPort === 0) {
          try { newChild.kill('SIGTERM') } catch (_) { /* 忽略 */ }
          try { newServer.close() } catch (_) { /* 忽略 */ }
          return { success: false, error: 'MPEG-TS server restart timeout' }
        }
        if (newPort !== sess.mirrorPort) {
          logInfo(`TVLive: MPEG-TS seek server port changed ${sess.mirrorPort} → ${newPort}`)
          sess.mirrorPort = newPort
        }
        sess.proc = newChild
        sess.server = newServer
      }

      // 6. 通知 TV 重新加载流（stop + push）
      const proxyUrl = useHls
        ? `http://${sess.lanIp}:${sess.mirrorPort}/playlist.m3u8`
        : `http://${sess.lanIp}:${sess.mirrorPort}/stream`

      try {
        await tvlive.stopTVLiveDevice(sess.device)
      } catch (_) { /* stop 可能失败（TV 已断开），忽略 */ }

      // 短暂延迟让 TV 释放旧播放器
      await new Promise(r => setTimeout(r, 800))

      try {
        await tvlive.castToTVLiveDevice(sess.device, proxyUrl)
      } catch (e) {
        logError(`TVLive: seek re-push failed: ${e.message}`)
        return { success: false, error: `re-push failed: ${e.message}` }
      }

      logInfo(`TVLive: seek restart SUCCESS from ${newPos}s (sessionId=${sessionId})`)
      return { success: true }
    } catch (e) {
      logError('TVLive: seek error: ' + e.message)
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tlv1-emulator-forward', async () => {
    try {
      const result = await tvlive.setupEmulatorForwarding()
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: e.message, setup: false }
    }
  })

  ipcMain.handle('tlv1-connect', async (_event, ip) => {
    try {
      const device = await tvlive.connectToIP(ip)
      // 同步到后端缓存，确保前后端deviceIndex一致
      const existIdx = cachedTVLiveDevices.findIndex(d =>
        (d.host === device.host) || (d.displayHost === device.host) || (d.host === device.displayHost)
      )
      if (existIdx >= 0) {
        cachedTVLiveDevices[existIdx] = device
      } else {
        cachedTVLiveDevices.unshift(device)
      }
      return { success: true, device }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // --- ADB 路径管理 ---
  ipcMain.handle('tlv1-select-adb', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 ADB 可执行文件',
      filters: [
        { name: 'ADB 可执行文件 (adb.exe)', extensions: ['exe'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, path: '' }
    }
    const adbPath = result.filePaths[0]
    // 校验是否为有效 ADB
    const testResult = await tvlive.testAdbPath(adbPath)
    if (testResult.success) {
      tvlive.setAdbPath(adbPath)
      logInfo('TVLive: 手动指定ADB: ' + adbPath + ' (v' + testResult.version + ')')
      return { success: true, path: adbPath, version: testResult.version }
    } else {
      return { success: false, path: '', error: '所选文件不是有效的ADB: ' + (testResult.error || '无法执行') }
    }
  })

  ipcMain.handle('tlv1-set-adb-path', async (_event, adbPath) => {
    if (adbPath && adbPath.trim()) {
      const testResult = await tvlive.testAdbPath(adbPath)
      if (testResult.success) {
        tvlive.setAdbPath(adbPath)
        logInfo('TVLive: ADB路径已设置: ' + adbPath)
        return { success: true }
      } else {
        return { success: false, error: testResult.error || '无效的ADB路径' }
      }
    } else {
      tvlive.setAdbPath(null)
      logInfo('TVLive: ADB路径已清除，恢复自动检测')
      return { success: true }
    }
  })

  ipcMain.handle('tlv1-get-adb-path', async () => {
    const adbPath = tvlive.getAdbPath()
    const isOverride = tvlive.isAdbOverridden()
    return { success: true, path: adbPath, isOverride }
  })

  ipcMain.handle('tlv1:openLogFile', async () => {
    try {
      if (fs.existsSync(debugLogFile)) {
        const err = await shell.openPath(debugLogFile)
        if (err) return { success: false, error: err }
        return { success: true, path: debugLogFile }
      }
      return { success: false, error: '日志文件不存在' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('tlv1-sync-local-channels', async (_event, deviceIndex, channelsData) => {
    try {
      const devices = cachedTVLiveDevices.length > 0
        ? cachedTVLiveDevices
        : await tvlive.discoverTVLiveDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        logError(`TVLive sync-local-channels: invalid deviceIndex ${deviceIndex}`)
        return { success: false, error: '设备索引无效' }
      }
      const device = devices[deviceIndex]
      const result = await tvlive.syncLocalChannelsToDevice(device, channelsData)
      logInfo(`TVLive sync-local-channels: 同步完成 ${device.deviceName} count=${result.count}`)
      return { success: true, count: result.count }
    } catch (e) {
      logError(`TVLive sync-local-channels: ${e.message}`)
      return { success: false, error: e.message }
    }
  })

  // --- Float Window (PiP) ---
  // position：切频道「关闭重建」时传入上次窗口坐标，保证新窗口在原位置附近重建，
  // 而不是跳回屏幕中央。首次打开或未传坐标时走系统默认居中逻辑。
  ipcMain.handle('create-float-window', async (_event, position) => {
    try {
      if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.focus()
        return true
      }

      const winOptions = {
        width: 480,
        height: 270,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        // 禁用系统边缘缩放手柄（resizable: false）与最大化，彻底杜绝：
        // 1) 长按/拖动窗口内部时被 Windows Aero Snap 错误放大；
        // 2) 鼠标滑到隐形手柄触发系统缩放。
        // 边缘按比例缩放改由渲染端自定义实现（检测边线 → setBounds），窗口移动由渲染端 setPosition 完成。
        resizable: false,
        maximizable: false,
        transparent: false,
        backgroundColor: '#000000',
        icon: path.join(__dirname, '../public/icon.png'),
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          webviewTag: true,
          autoplayPolicy: 'no-user-gesture-required',
        }
      }

      // 原位置重建：传入有效坐标则作为初始位置，避免窗口跳回屏幕中央
      const px = Math.round(Number(position?.x))
      const py = Math.round(Number(position?.y))
      if (Number.isFinite(px) && Number.isFinite(py)) {
        winOptions.x = px
        winOptions.y = py
      }

      const win = new BrowserWindow(winOptions)

      const loadUrl = isDev
        ? `http://localhost:5173/#/float`
        : `file://${path.join(__dirname, '../dist/index.html')}#/float`

      floatWindow = win

      // 关键修复：resizable:false 会让 Windows 把最小尺寸锁死为初始 480x270，
      // 导致渲染端按视频宽高比缩小窗口（如 295x640）时宽度被钳制回 480。
      // 显式覆盖最小尺寸，使 setSize / setBounds 可以自由缩小。
      win.setMinimumSize(160, 120)

      // ── 诊断日志：追踪一切可能改变悬浮窗尺寸的源头 ──
      win.on('will-resize', (_e, newBounds) => {
        logVerbose(`[FLOAT][will-resize] → ${newBounds?.width}x${newBounds?.height}`)
      })
      win.on('resize', () => {
        if (win.isDestroyed()) return
        const [w, h] = win.getSize()
        logVerbose(`[FLOAT][resize] size=${w}x${h} fullscreen=${win.isFullScreen()} maximized=${win.isMaximized()}`)
      })
      win.on('maximize', () => logVerbose('[FLOAT][maximize] 窗口被最大化'))
      win.on('unmaximize', () => logVerbose('[FLOAT][unmaximize] 窗口取消最大化'))
      win.on('enter-full-screen', () => logVerbose('[FLOAT][enter-full-screen]'))
      win.on('leave-full-screen', () => logVerbose('[FLOAT][leave-full-screen]'))

      win.loadURL(loadUrl)

      win.webContents.once('did-finish-load', () => {
        if (floatSourceInfo) {
          win.webContents.send('float-source-update', floatSourceInfo)
        }
      })

      win.on('closed', () => {
        // 仅当关闭的是「当前」悬浮窗时才清空引用；关闭旧窗口触发的 closed 若
        // 盲目把 floatWindow 置 null，会把刚创建的新悬浮窗引用一并清掉，导致
        // 新窗口收不到后续的 float-source-update / mirror:signal，重新打开时
        // 悬浮窗永远收不到 offer，卡死在「正在连接镜像」。
        if (floatWindow === win) {
          floatWindow = null
          floatSourceInfo = null
        }
      })

      if (isDev) {
        win.webContents.openDevTools({ mode: 'detach' })
      }

      logInfo('FLOAT-WINDOW: created')
      return true
    } catch (e) {
      logError('FLOAT-WINDOW: create error: ' + e.message)
      return false
    }
  })

  // 悬浮窗「副本播放」源描述同步：主窗口把当前播放源（仅 Artplayer 直链 stream 源）
  // 同步给悬浮窗，悬浮窗据此独立播放与主窗口一致的副本内容。
  ipcMain.handle('float-source-update', async (_event, source) => {
    floatSourceInfo = source
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.webContents.send('float-source-update', source)
    }
    return true
  })

  ipcMain.handle('close-float-window', async () => {
    // 先同步清空引用再关闭窗口，避免「旧窗口 closed 事件延迟触发」把随后新建的
    // 悬浮窗引用误清掉（见下方 closed 的 === win 守卫）；同步清空 floatSourceInfo，
    // 防止重新打开时把陈旧源描述推给新窗口。
    const win = floatWindow
    floatWindow = null
    floatSourceInfo = null
    if (win && !win.isDestroyed()) {
      win.close()
    }
  })

  // 查询悬浮窗真实存活状态：供渲染端单例互斥守卫使用，避免本地标志与主进程
  // 实际窗口状态脱节（悬浮窗被系统快捷键/外部方式关闭时本地标志可能残留为 true）。
  ipcMain.handle('is-float-window-open', async () => {
    return !!(floatWindow && !floatWindow.isDestroyed())
  })

  // 查询悬浮窗当前坐标/尺寸：切频道「关闭重建」前读取，作为新窗口初始位置，
  // 实现「原位置附近重建」。全屏时取正常状态边界，避免把全屏坐标当成重建位置。
  ipcMain.handle('get-float-window-bounds', async () => {
    if (!floatWindow || floatWindow.isDestroyed()) return null
    const b = floatWindow.isFullScreen() ? floatWindow.getNormalBounds() : floatWindow.getBounds()
    return { x: b.x, y: b.y, width: b.width, height: b.height }
  })

  ipcMain.handle('toggle-float-fullscreen', async () => {
    if (!floatWindow || floatWindow.isDestroyed()) return false
    // 悬浮窗已支持自由缩放，无需切换比例锁/缩放约束，直接切换全屏即可。
    const next = !floatWindow.isFullScreen()
    floatWindow.setFullScreen(next)
    // 返回切换后的目标状态，供渲染端精确同步 isFullscreen，避免手动翻转导致状态漂移
    return next
  })

  // 悬浮窗按视频原生宽高比自适应尺寸：渲染端在视频轨道 metadata 就绪后，
  // 计算匹配视频宽高比的窗口尺寸（控制栏为悬浮覆盖层，窗口尺寸即视频区尺寸），主进程据此 resize。
  ipcMain.handle('resize-float-window', async (_event, size) => {
    if (!floatWindow || floatWindow.isDestroyed()) return false
    // 全屏时忽略尺寸贴合请求，避免与全屏布局冲突
    if (floatWindow.isFullScreen()) return false
    const w = Math.max(160, Math.round(Number(size?.width) || 640))
    const h = Math.max(120, Math.round(Number(size?.height) || 360))
    logVerbose(`[FLOAT][setSize] 程序化 resize → ${w}x${h}`)
    floatWindow.setSize(w, h)
    return true
  })

  // 悬浮窗自定义边缘缩放：渲染端检测到鼠标在窗口边线拖拽时，
  // 按视频原生宽高比计算新的窗口边界，主进程一次性 setBounds 落位（位置+尺寸）。
  // 使用 send 高频调用，避免 invoke 往返堆积。
  ipcMain.on('set-float-bounds', (_event, bounds) => {
    if (!floatWindow || floatWindow.isDestroyed()) return
    if (floatWindow.isFullScreen()) return
    const x = Math.round(Number(bounds?.x))
    const y = Math.round(Number(bounds?.y))
    const w = Math.max(160, Math.round(Number(bounds?.width) || 640))
    const h = Math.max(120, Math.round(Number(bounds?.height) || 360))
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    logVerbose(`[FLOAT][setBounds] → ${x},${y} ${w}x${h}`)
    floatWindow.setBounds({ x, y, width: w, height: h }, false)
  })

  // 悬浮窗全局拖动：渲染端监听 mousedown/mousemove 计算目标位置，主进程仅负责落位。
  // 使用 send 而非 invoke，拖动期间高频调用，避免每次往返等待应答。
  ipcMain.on('move-float-window', (_event, pos) => {
    if (!floatWindow || floatWindow.isDestroyed()) return
    const x = Math.round(Number(pos?.x))
    const y = Math.round(Number(pos?.y))
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const [cw, ch] = floatWindow.getSize()
    // 渲染端传入拖动开始时的固定尺寸（width/height），用 setBounds 锁定位置+尺寸，
    // 避免单独 setPosition 在无边框窗口上触发 Windows 边框重算导致尺寸 +2/+1 膨胀。
    const w = Math.round(Number(pos?.width))
    const h = Math.round(Number(pos?.height))
    const bw = Number.isFinite(w) && w > 0 ? w : cw
    const bh = Number.isFinite(h) && h > 0 ? h : ch
    logVerbose(`[FLOAT][setBounds-move] → ${x},${y} ${bw}x${bh}`)
    floatWindow.setBounds({ x, y, width: bw, height: bh }, false)
  })

  // --- Mirror Signal Relay (WebRTC signaling between main window and float window) ---
  ipcMain.handle('mirror:signal', (event, data) => {
    const isFromMain = event.sender === (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
    const target = isFromMain ? floatWindow : mainWindow
    const dir = isFromMain ? 'main→float' : 'float→main'
    const sdpOk = !!(data && data.sdp)
    logVerbose(`MIRROR-SIGNAL ${dir} type=${data?.type} sdp=${sdpOk} floatAlive=${!!(floatWindow && !floatWindow.isDestroyed())} mainAlive=${!!(mainWindow && !mainWindow.isDestroyed())} target=${target && !target.isDestroyed() ? 'OK' : 'NULL'}`)
    if (target && !target.isDestroyed()) {
      target.webContents.send('mirror:signal', data)
    }
  })

  // --- Resolve playable URL at play-time from site metadata ---
  // When user clicks "play" on a sniff result with siteMeta (Bilibili, CCTV, etc.),
  // this generates a FRESH URL from the site's API right now.
  // forceRefresh=true（切换解码模式时使用）：先清空解析缓存，强制重新签发一次性 token，
  // 否则会命中 5 分钟播放地址缓存，拿回已被播放器消耗掉的旧签名地址（必然 403）。
  ipcMain.handle('resolve-external-play-url', async (_event, siteMeta) => {
    logDebug(`IPC resolve-external-play-url: site=${(siteMeta?.site || '?')} page=${(siteMeta?.pageUrl || '').substring(0, 50)} force=${!!siteMeta?.forceRefresh}`)
    if (!siteMeta || !siteMeta.site) return { success: false, urls: [] }
    try {
      if (siteMeta.forceRefresh) {
        try { sniffer.clearPlayUrlCache() } catch (_) {}
      }
      const urls = await sniffer.resolvePlayUrl(siteMeta)
      return { success: true, urls }
    } catch (e) {
      // 与安卓版 IJK 一致：解析失败即清空解析缓存，下次重新取新地址。
      try { sniffer.clearPlayUrlCache() } catch (_) {}
      logError('RESOLVE-PLAY-URL: error for site=' + (siteMeta?.site || '?') + ': ' + e.message)
      return { success: false, urls: [], error: e.message }
    }
  })

  // --- URL Sniffer: extract video/stream URLs from a webpage ---
  // 视频流解析模式：全程纯 HTTP，不创建任何浏览器窗口、不加载网页。
  // Phase 1: HTTP 抓取 HTML → 正则提取；Phase 2: 站点专用纯 HTTP 接口解析。
  ipcMain.handle('sniff-url', async (_event, pageUrl) => {
    logDebug(`IPC sniff-url: page=${(pageUrl||'').substring(0, 80)}`)
    if (!/^https?:\/\//i.test(pageUrl)) {
      return { success: false, error: 'URL must start with http:// or https://', urls: [] }
    }

    // Detect if the input URL is itself a direct media link
    const isDirectMedia = sniffer.directMediaPatterns.some(p => p.test(pageUrl))
    if (isDirectMedia) {
      const format = sniffer.guessFormatFromUrl(pageUrl)
      return {
        success: true,
        urls: [{ url: pageUrl, sourceUrl: pageUrl, format, contentType: '', isLive: false }],
        totalFound: 1,
        phase: 'direct',
        hint: '已识别为直链媒体地址，可直接播放',
      }
    }

    const allUrls = []
    const seenUrls = new Set()
    let phase = ''

    // Phase 1: Quick HTML extraction
    try {
      const html = await fetchUrlWithDns(pageUrl, {
        'User-Agent': MOBILE_UA,
        'Referer': pageUrl,
      }, 5, 10000)

      if (html && html.length >= 10) {
        const quickUrls = sniffer.extractVideoUrlsFromHtml(html, pageUrl)
        quickUrls.forEach(u => seenUrls.add(u))
        phase = 'quick'
      }
    } catch (_) {
      logWarn('SNIFF: quick extraction failed for ' + pageUrl.substring(0, 60))
    }

    // Phase 2: 站点专用纯 HTTP 解析（不创建浏览器窗口、不加载网页）
    let deepMetadata = sniffer.inferSiteMetaFromUrl(pageUrl)
    let freshUrlSet = []
    if (deepMetadata && deepMetadata.site) {
      try {
        const resolved = await sniffer.resolvePlayUrl(deepMetadata)
        for (const item of resolved) {
          if (item && item.url && !seenUrls.has(item.url)) {
            seenUrls.add(item.url)
            freshUrlSet.push(item.url)
          }
        }
        if (freshUrlSet.length > 0) phase = phase ? 'quick+site' : 'site'
      } catch (_) {
        logWarn('SNIFF: site resolve failed for site=' + deepMetadata.site + ' page=' + pageUrl.substring(0, 60))
      }
    }

    if (seenUrls.size === 0) {
      // 与安卓版 IJK 一致：解析失败即清空解析缓存，下次重新取新地址。
      try { sniffer.clearPlayUrlCache() } catch (_) {}
      return {
        success: true,
        urls: [],
        totalFound: 0,
        phase,
        hint: '未检测到视频流地址。该页面可能使用DRM保护或需要登录，请尝试直接粘贴视频链接',
      }
    }

    // Format results with metadata attached
    // Filter out the input page URL itself (leaked by /video/ regex pattern)
    const pageUrlNoSlash = pageUrl.replace(/\/$/, '')
    const results = []
    const probeLimit = Math.min(seenUrls.size, 30)
    const urlArray = [...seenUrls]
      .filter(u => {
        // Skip the input page URL itself and its no-slash variant
        const cleanU = u.replace(/\/$/, '')
        return cleanU !== pageUrlNoSlash && cleanU !== pageUrlNoSlash + '/'
      })
      .slice(0, probeLimit)
    for (const u of urlArray) {
      try {
        const probe = await sniffer.probeContentTypeFast(u, { http, https })
        const result = {
          url: u,
          sourceUrl: probe.finalUrl || u,
          format: probe.format,
          contentType: probe.contentType,
          isLive: probe.isPlaylist || probe.isFlv,
        }
        // Attach site metadata for "resolve at play-time" support
        if (deepMetadata && deepMetadata.site) {
          result.siteMeta = deepMetadata
          result.fromApi = freshUrlSet.includes(u)
        }
        results.push(result)
      } catch (_) {
        const result = {
          url: u,
          sourceUrl: u,
          format: sniffer.guessFormatFromUrl(u),
          contentType: '',
          isLive: false,
        }
        if (deepMetadata && deepMetadata.site) {
          result.siteMeta = deepMetadata
          result.fromApi = freshUrlSet.includes(u)
        }
        results.push(result)
      }
    }
    return { success: true, urls: results, totalFound: seenUrls.size, phase }
  })
})

  // ============ 央视频 (yangshipin.cn) 频道列表提取 ============
  ipcMain.handle('ysp-extract-channels', async () => {
    logDebug('IPC ysp-extract-channels: 正在提取央视频频道链接')
    try {
      const result = await yspHandler.extractYangshipinChannels()
      logInfo(`YSP: 提取到 ${result.count || 0} 个频道`)
      return result
    } catch (e) {
      logError('YSP: extract error: ' + e.message)
      return { success: false, channels: [], message: e.message }
    }
  })

  // ============ FFmpeg IPC handlers ============
  const { spawn, execFile } = require('child_process')
  const ffmpegSessions = new Map()
  const mpvSessions = new Map()
  const vlcSessions = new Map()
  let cachedFFmpegPath = null
  let cachedMpvPath = null

  // 构建 FFmpeg 自定义请求头参数：UA 走 user_agent，其余请求头统一拼进 headers，
  // 并恒定注入 Cache-Control / Pragma 禁缓存（与安卓版 IJK applyOptions 一致）。
  // 供 ffmpeg:createSession 与下载模块复用，保证下载与播放使用完全相同的请求头策略。
  function buildFfmpegHeaderArgs(headers, isLocalFile) {
    if (isLocalFile) return []
    const h = (headers && typeof headers === 'object') ? headers : {}
    const args = []
    const ua = h['User-Agent'] || h['user-agent']
    if (ua) args.push('-user_agent', String(ua))
    const headerLines = ['Cache-Control: no-cache, no-store', 'Pragma: no-cache']
    for (const [k, v] of Object.entries(h)) {
      if (k && v && k.toLowerCase() !== 'user-agent' && k.toLowerCase() !== 'cache-control' && k.toLowerCase() !== 'pragma') {
        headerLines.push(`${k}: ${String(v)}`)
      }
    }
    args.push('-headers', headerLines.join('\r\n') + '\r\n')
    return args
  }

  // HLS 输入判定：显式格式或地址扩展名任一命中即为 HLS。
  function isHlsInputUrl(sourceUrl, inputFormat) {
    const hlsFmtRe = /^(m3u8|m3u|hls)$/i
    return (typeof inputFormat === 'string' && hlsFmtRe.test(inputFormat)) ||
      /\.(m3u8|m3u)(\?|#|$)/i.test(sourceUrl || '')
  }

  // 构建 FFmpeg 网络重连参数（逐项对齐安卓版 IJK），供 ffmpeg:createSession 与下载模块复用。
  // 注意：HLS 播放列表是「读完整即 EOF」的短响应，绝不能用 -reconnect_streamed；
  // HLS 的直播续播由 hls 解复用器自身的 -max_reload 负责，不需要 http 层重连。
  function buildFfmpegNetworkArgs(isLocalFile, isHlsInput) {
    if (isLocalFile) {
      return [
        '-analyzeduration', '2000000',
        '-probesize', '5000000',
      ]
    }
    if (isHlsInput) {
      return [
        '-timeout', '60000000',
        '-max_reload', '100000',
        // 直播从最早可用分片开始拉取，提前建立播放缓冲，避免等到缓冲耗尽才开始取下一分片。
        '-live_start_index', '0',
        // 并行建立多条 HTTP 连接预拉后续分片，彻底消除「切换分片才重新拉取」导致的卡顿。
        '-http_multiple', '1',
        '-analyzeduration', '3000000',
        '-probesize', '1048576',
        '-rtbufsize', '16M',
      ]
    }
    return [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '10',
      '-timeout', '60000000',
      '-analyzeduration', '3000000',
      '-probesize', '1048576',
      '-rtbufsize', '16M',
    ]
  }

  // 解析应用内置 FFmpeg 可执行文件路径（软解/转码默认使用该二进制）。
  // 布局：开发态 <project>/data/ffmpeg/ffmpeg.exe；打包态 <app>/data/ffmpeg/ffmpeg.exe（extraResources 复制）。
  function resolveBuiltinFfmpegPath() {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    const candidates = []
    if (app.isPackaged) {
      candidates.push(path.join(path.dirname(app.getPath('exe')), 'data', 'ffmpeg', exeName))
    } else {
      candidates.push(path.join(__dirname, '..', 'data', 'ffmpeg', exeName))
    }
    // 兼容旧布局：resources 根目录直接放置 ffmpeg
    candidates.push(path.join(process.resourcesPath, exeName))
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p
      } catch (_) {}
    }
    return ''
  }

  function probeDuration(ffprobePath, filePath) {
    return new Promise((resolve) => {
      execFile(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { timeout: 15000 }, (err, stdout) => {
        if (err) {
          logWarn(`FFPROBE: error: ${err.message}`)
          resolve(null)
          return
        }
        const dur = parseFloat(String(stdout).trim())
        if (!isNaN(dur) && dur > 0) {
          logInfo(`FFPROBE: detected duration=${dur}s for ${filePath}`)
          resolve(dur)
        } else {
          logWarn(`FFPROBE: could not parse duration from "${String(stdout).trim()}"`)
          resolve(null)
        }
      })
    })
  }

  // 查找目标时间点之前最近的关键帧时间（秒）。
  // 仅用于日志诊断：确认 -ss 后 FFmpeg 的真实起播位置，不参与时间轴计算。
  function probeKeyframeTime(ffprobePath, filePath, targetSec) {
    return new Promise((resolve) => {
      const start = Math.max(0, targetSec - 20)
      const end = targetSec + 0.001
      execFile(ffprobePath, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,flags',
        '-of', 'csv=p=0',
        '-read_intervals', `${start}%${end}`,
        filePath,
      ], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) {
          logWarn(`FFPROBE: keyframe probe failed: ${err ? err.message : 'empty output'}`)
          resolve(null)
          return
        }
        let best = null
        for (const line of String(stdout).split('\n')) {
          const parts = line.trim().split(',')
          if (parts.length < 2) continue
          const t = parseFloat(parts[0])
          if (!Number.isFinite(t)) continue
          if (!(parts[1] || '').includes('K')) continue
          if (t > end + 0.5) continue
          if (best === null || t > best) best = t
        }
        if (best !== null) logInfo(`FFPROBE: keyframe <= ${targetSec}s is ${best}s`)
        resolve(best)
      })
    })
  }

  ipcMain.handle('ffmpeg:selectPath', async (_event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 FFmpeg 可执行文件',
      filters: [
        { name: 'FFmpeg 可执行文件', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, path: '' }
    }
    return { success: true, path: result.filePaths[0] }
  })

  ipcMain.handle('ffmpeg:getBuiltinPath', async () => {
    return resolveBuiltinFfmpegPath()
  })

  ipcMain.handle('ffmpeg:test', async (_event, ffmpegPath) => {
    return new Promise((resolve) => {
      execFile(ffmpegPath, ['-version'], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, version: '', error: err.message || String(err) })
          return
        }
        const output = stdout || stderr || ''
        const match = output.match(/ffmpeg version\s+(\S+)/i)
        const version = match ? match[1] : ''
        resolve({ success: true, version })
      })
    })
  })

  ipcMain.handle('ffmpeg:createSession', async (_event, sourceUrl, headers, ffmpegPath, seekTime, inputFormat, decodeMode) => {
    // 内置 FFmpeg 仅供软解（decodeMode='software'）使用；
    // 外置 FFmpeg（用户选择）用于转封装等其他模式。两者互斥隔离，绝不互相回退。
    if (!ffmpegPath && decodeMode === 'software') {
      ffmpegPath = resolveBuiltinFfmpegPath()
      if (ffmpegPath) logInfo(`FFMPEG: software mode using builtin ffmpeg ${ffmpegPath}`)
    }
    cachedFFmpegPath = ffmpegPath
    if (!ffmpegPath) {
      return { success: false, error: 'FFmpeg未找到，请确认已内置或设置 FFmpeg 路径' }
    }
    logDebug(`IPC ffmpeg:createSession: src=${(sourceUrl||'').substring(0, 80)} seek=${seekTime||0} fmt=${inputFormat||'auto'}`)
    const sessionId = generateId()

    let inputUrl = sourceUrl
    let isLocalFile = false
    if (sourceUrl.startsWith('file://')) {
      inputUrl = normalizeFileUrl(sourceUrl)
      isLocalFile = true
    }

    logInfo(`FFMPEG: createSession sourceUrl=${sourceUrl} inputUrl=${inputUrl} isLocalFile=${isLocalFile} seekTime=${seekTime}`)

    // 视频流解析模式严禁加载网页：FFmpeg 只接受真实媒体流地址。
    // 若上游解析器误把网页/CSS/JSON 接口传进来，直接拒绝，避免 spawn 后再报 Invalid data。
    if (!isLocalFile && sniffer.isUnplayableStreamUrl(inputUrl)) {
      logError(`FFMPEG: reject non-media url (网页/静态资源/接口) inputUrl=${inputUrl}`)
      return { success: false, error: `不是有效的媒体流地址：${inputUrl}` }
    }

    var probedDuration = null
    if (isLocalFile) {
      try {
        fs.accessSync(inputUrl, fs.constants.R_OK)
        logInfo(`FFMPEG: local file accessible: ${inputUrl}`)
      } catch (e) {
        logError(`FFMPEG: local file NOT accessible: ${inputUrl} - ${e.message}`)
        return { success: false, error: `File not accessible: ${inputUrl} - ${e.message}` }
      }
      const ffprobePath = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      probedDuration = await probeDuration(ffprobePath, inputUrl)
    }

    // 与安卓版 IJK 的 applyOptions 完全一致：
    // 1) UA 走独立的 user_agent 选项；
    // 2) 其余请求头统一拼进 headers 选项，并恒定注入 Cache-Control / Pragma 禁缓存。
    // 复用 buildFfmpegHeaderArgs：UA 走 user_agent，其余请求头统一拼进 headers，
    // 并恒定注入 Cache-Control / Pragma 禁缓存（下载模块同样复用，保证策略一致）。
    const headerArgs = buildFfmpegHeaderArgs(headers, isLocalFile)

    // HLS 输入判定：显式格式或地址扩展名任一命中即为 HLS。
    // 本地代理地址（/session/xxx/stream）没有扩展名，因此软解/回退链必须把真实格式传进来。
    const isHlsInput = !isLocalFile && isHlsInputUrl(sourceUrl, inputFormat)

    // 网络输入参数逐项对齐安卓版 IJK（IjkVideoPlayer.applyOptions），
    // 复用 buildFfmpegNetworkArgs（下载模块同样复用，保证重连策略一致）。
    const networkArgs = buildFfmpegNetworkArgs(isLocalFile, isHlsInput)

    const movFlags = 'frag_keyframe+empty_moov+default_base_moof'

    // 解码方式与容器格式正交：
    // - 'copy'（硬解/转封装）：视频码流原样透传，交给 Chromium 的 GPU 专用解码电路硬解；
    // - 'software'（软解）：由 FFmpeg 的 CPU 通用处理器软解码，再重编码为 H.264 供 video 元素播放。
    const videoCodecArgs = (decodeMode === 'software')
      ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-maxrate', '4M', '-bufsize', '8M']
      : ['-c:v', 'copy']

    // 只接受已知容器格式，避免前端把 'unknown' 之类的探测结果透传成 `-f unknown` 导致 FFmpeg 直接报错。
    // HLS 不在这里强制指定：本地代理在 CDN 直接返回 TS 二进制时会走透传分支，
    // 强制 hls 解复用器会报 Invalid data；交给 FFmpeg 按内容探测更稳（探测只多一次列表请求，被代理短缓存吸收）。
    const inputFormatArgs = []
    if (!isLocalFile && typeof inputFormat === 'string' && inputFormat) {
      const fmtMap = { flv: 'flv', live_flv: 'live_flv', ts: 'mpegts', mpegts: 'mpegts', mp4: 'mp4' }
      const ffFmt = fmtMap[inputFormat.toLowerCase()]
      if (ffFmt) inputFormatArgs.push('-f', ffFmt)
    }

    // 转封装（-c:v copy）时 -ss 只能落在关键帧：FFmpeg 文档明确说明
    // 「stream copy 时关键帧到目标点之间的片段会被保留」。
    // 而音频走 -c:a aac 重编码，默认 accurate_seek 会把这段精确裁掉，
    // 结果视频从关键帧起播、音频从目标点起播，两者错位最多一个 GOP，
    // 播放器在起播瞬间反复对齐 → 表现为新时间点附近抖一下。
    // 用 -noaccurate_seek 让音频也保留到关键帧，音画严格同步。
    const seekAccurateArgs = (decodeMode === 'software') ? [] : ['-noaccurate_seek']
    const seekInputArgs = (isLocalFile && typeof seekTime === 'number' && seekTime > 0)
      ? [...seekAccurateArgs, '-ss', String(seekTime)]
      : []

    const ffmpegArgs = [
      '-fflags', '+genpts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      ...headerArgs,
      ...networkArgs,
      ...seekInputArgs,
      ...inputFormatArgs,
      '-i', inputUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      ...videoCodecArgs,
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'mp4',
      '-movflags', movFlags,
      '-',
    ]
    logInfo(`FFMPEG: spawn ${ffmpegPath} ${ffmpegArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`)
logInfo(`FFMPEG: input=${inputUrl}, sessionId=${sessionId}, isLocal=${isLocalFile}, movFlags=${movFlags}`)

    let ffmpegProc
    try {
      ffmpegProc = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      return { success: false, error: 'spawn failed: ' + e.message }
    }

    const MAX_BUFFER_BYTES = 16 * 1024 * 1024
    const sessionState = {
      bufferChunks: [],
      bufferBytes: 0,
      bufferEnded: false,
      activeResponses: [],
      stderrLines: [],
    }

    ffmpegProc.stderr?.on('data', (data) => {
      const text = data.toString()
      const lines = text.trim().split('\n')
      for (const line of lines) {
        sessionState.stderrLines.push(line)
        if (sessionState.stderrLines.length > 200) sessionState.stderrLines.shift()
      }
      debugLog(`FFMPEG: [stderr] ${text.trim().substring(0, 1000)}`)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ffmpeg:stderr', { sessionId, lines: lines.filter(l => l.trim()) })
      }
      const errorKeywords = ['error', 'Error', 'ERROR', 'Invalid', 'failed', 'Failed', 'FAILED', 'No such', 'Permission denied', 'Unable', 'not found', 'Unsupported']
      const trimmed = text.trim()
      if (errorKeywords.some(kw => trimmed.includes(kw))) {
        logWarn(`FFMPEG: [stderr-error] ${trimmed.substring(0, 500)}`)
      }
    })

    const ffmpegServer = http.createServer((req, res) => {
      debugLog(`FFMPEG: HTTP request ${req.method} ${req.url} from ${req.socket?.remoteAddress}`)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': safeCorsOrigin(req),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        })
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Access-Control-Allow-Origin': safeCorsOrigin(req),
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'none',
      })
      for (const chunk of sessionState.bufferChunks) {
        try { res.write(chunk) } catch (_) {}
      }
      if (sessionState.bufferEnded) {
        debugLog(`FFMPEG: HTTP response end (bufferEnded), chunks=${sessionState.bufferChunks.length}, bytes=${sessionState.bufferBytes}`)
        res.end()
      } else {
        sessionState.activeResponses.push(res)
        debugLog(`FFMPEG: HTTP response streaming, activeResponses=${sessionState.activeResponses.length}`)
        req.on('close', () => {
          const idx = sessionState.activeResponses.indexOf(res)
          if (idx >= 0) sessionState.activeResponses.splice(idx, 1)
          debugLog(`FFMPEG: HTTP client disconnected, remaining=${sessionState.activeResponses.length}`)
        })
      }
    })

    return new Promise((resolve) => {
      let resolved = false
      let serverPort = 0
      let serverProxyUrl = ''

      function failResolve(errorMsg) {
        if (resolved) return
        resolved = true
        try { ffmpegProc.kill('SIGTERM') } catch (_) {}
        try { ffmpegServer.close() } catch (_) {}
        const lastStderr = sessionState.stderrLines.slice(-30).join('\n')
        logError(`FFMPEG: FAIL ${errorMsg} stderr=${lastStderr.substring(0, 2000)}`)
        resolve({ success: false, error: errorMsg + (lastStderr ? '\nFFmpeg stderr:\n' + lastStderr : '') })
      }

      function tryResolve() {
        if (resolved) return
        if (serverPort && sessionState.bufferChunks.length > 0) {
          resolved = true
          ffmpegSessions.set(sessionId, {
            active: true,
            proc: ffmpegProc,
            server: ffmpegServer,
            sessionId,
            state: sessionState,
            isLocalFile,
            ffmpegPath,
            inputUrl,
            decodeMode,
            headerArgs,
            networkArgs,
            videoCodecArgs,
            inputFormatArgs,
            movFlags,
            duration: probedDuration,
            serverPort,
            serverProxyUrl,
          })
          logInfo(`FFMPEG SESSION CREATE: ${sessionId} on port ${serverPort}, buffer=${sessionState.bufferBytes}B`)
          resolve({ success: true, sessionId, proxyUrl: serverProxyUrl, port: serverPort, detectedFormat: 'mp4', duration: probedDuration })
        }
      }

      ffmpegProc.on('error', (err) => {
        logError(`FFMPEG: process spawn error: ${err.message}`)
        failResolve('FFmpeg process error: ' + err.message)
      })

      ffmpegProc.on('close', (code) => {
        const lastStd = sessionState.stderrLines.slice(-5).join(' | ')
        logInfo(`FFMPEG: process closed, code=${code}, resolved=${resolved}, bufferChunks=${sessionState.bufferChunks.length}, lastStderr=${lastStd.substring(0, 300)}`)
        if (!resolved) {
          if (code !== 0 && code !== null) {
            failResolve(`FFmpeg exited with code ${code}`)
          } else if (code === 0 && sessionState.bufferChunks.length === 0) {
            failResolve('FFmpeg exited with code 0 but produced no output')
          }
        }
        const s = ffmpegSessions.get(sessionId)
        if (s && s.proc === ffmpegProc) s.active = false
      })

      let stdoutChunkCount = 0
      ffmpegProc.stdout?.on('data', (chunk) => {
        const s = ffmpegSessions.get(sessionId)
        if (s && s.proc !== ffmpegProc) return
        sessionState.bufferChunks.push(chunk)
        sessionState.bufferBytes += chunk.length
        stdoutChunkCount++
        while (sessionState.bufferBytes > MAX_BUFFER_BYTES && sessionState.bufferChunks.length > 1) {
          const old = sessionState.bufferChunks.shift()
          sessionState.bufferBytes -= old.length
        }
        for (const res of sessionState.activeResponses) {
          try { res.write(chunk) } catch (_) {}
        }
        if (stdoutChunkCount === 1) {
          debugLog(`FFMPEG: first stdout data, chunkSize=${chunk.length}, totalBytes=${sessionState.bufferBytes}`)
        }
        if (stdoutChunkCount % 100 === 0) {
          debugLog(`FFMPEG: stdout progress, chunks=${stdoutChunkCount}, totalBytes=${sessionState.bufferBytes}, activeResponses=${sessionState.activeResponses.length}`)
        }
        tryResolve()
      })

      ffmpegProc.stdout?.on('end', () => {
        const s = ffmpegSessions.get(sessionId)
        if (s && s.proc !== ffmpegProc) return
        sessionState.bufferEnded = true
        debugLog(`FFMPEG: stdout end, totalChunks=${stdoutChunkCount}, totalBytes=${sessionState.bufferBytes}`)
        for (const res of sessionState.activeResponses) {
          try { res.end() } catch (_) {}
        }
        sessionState.activeResponses = []
      })

      ffmpegServer.listen(0, '0.0.0.0', () => {
        serverPort = ffmpegServer.address().port
        serverProxyUrl = `http://127.0.0.1:${serverPort}/stream`
        logInfo(`FFMPEG: server ready on port ${serverPort}, waiting for first data...`)
        tryResolve()
        setTimeout(() => {
          if (!resolved) {
            failResolve('FFmpeg produced no output within 15s')
          }
        }, 15000)
      })

      ffmpegServer.on('error', (e) => {
        logError(`FFMPEG: server error: ${e.message}`)
        resolve({ success: false, error: 'server error: ' + e.message })
      })
    })
  })

  ipcMain.handle('ffmpeg:closeSession', async (_event, sessionId) => {
    const s = ffmpegSessions.get(sessionId)
    if (s) {
      s.active = false
      try { s.proc.kill('SIGTERM') } catch (_) {}
      try { s.server.close() } catch (_) {}
      ffmpegSessions.delete(sessionId)
      logInfo(`FFMPEG SESSION CLOSE: ${sessionId}`)
    }
    return true
  })

  // 本地文件动态 seek：复用已有 HTTP 服务器，并改为「先预热、后切换」。
  // 旧实现是「拉起新进程后立刻切换 video.src」，此时新进程尚未产出任何数据，
  // video 元素只能空等，表现为画面卡住后突然起播 → 抖动。
  // 新实现让新 FFmpeg 先在暂存区产出首批数据，确认可播后才提交并切换，
  // 切换瞬间缓冲区已有数据，video 元素可立即出帧，过渡接近无缝。
  ipcMain.handle('ffmpeg:seek', async (_event, sessionId, positionSec) => {
    const sess = ffmpegSessions.get(sessionId)
    if (!sess || !sess.state) {
      return { success: false, error: 'session not found' }
    }
    if (!sess.isLocalFile) {
      return { success: false, error: 'only local files support seek' }
    }

    const requestedPos = Math.max(0, Math.round(positionSec || 0))

    // 关键帧位置只做后台诊断日志，不参与起播决策，更不能阻塞 seek 返回。
    // 之前把它当作时间轴偏移回传，会让时间轴标签回跳到关键帧时刻，
    // 与前端「用户点击的时间」不一致，反而放大了抖动。
    if (requestedPos > 0 && sess.decodeMode !== 'software') {
      const ffprobePath = path.join(path.dirname(sess.ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      probeKeyframeTime(ffprobePath, sess.inputUrl, requestedPos)
        .then(kf => { if (kf !== null) logInfo(`FFMPEG SEEK: requested=${requestedPos}s keyframe=${kf}s`) })
        .catch(() => {})
    }

    logInfo(`FFMPEG SEEK: restart from ${requestedPos}s decodeMode=${sess.decodeMode || 'copy'} (sessionId=${sessionId})`)

    const st = sess.state
    const oldProc = sess.proc

    // 仅 -ss 不同，其余参数与首次创建完全一致。
    // 转封装模式必须带 -noaccurate_seek：否则视频从关键帧起播、音频被精确裁到目标点，
    // 音画错位一个 GOP，起播瞬间会明显抖一下。
    const seekAccurateArgs = (sess.decodeMode === 'software') ? [] : ['-noaccurate_seek']
    const seekArgs = requestedPos > 0 ? [...seekAccurateArgs, '-ss', String(requestedPos)] : []
    const ffmpegArgs = [
      '-fflags', '+genpts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      ...sess.headerArgs,
      ...sess.networkArgs,
      ...seekArgs,
      ...sess.inputFormatArgs,
      '-i', sess.inputUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      ...sess.videoCodecArgs,
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'mp4',
      '-movflags', sess.movFlags,
      '-',
    ]

    let newProc
    try {
      newProc = spawn(sess.ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
    } catch (e) {
      return { success: false, error: 'seek spawn failed: ' + e.message }
    }

    const MAX_BUFFER_BYTES = 16 * 1024 * 1024
    // 预热阈值：约 0.3~0.5 秒的 fMP4 数据。只求切换后立刻能出帧，
    // 阈值越大切换越晚、画面冻结越久，因此不宜过大。
    const PRIME_BYTES = 192 * 1024
    const PRIME_TIMEOUT_MS = 3000

    // 用 token 标记本次重启，避免旧进程残留回调污染新状态
    const token = {}
    sess.restartToken = token

    const staging = { chunks: [], bytes: 0, ended: false }
    let committed = false

    newProc.stderr?.on('data', (data) => {
      const text = data.toString()
      const lines = text.trim().split('\n')
      for (const line of lines) {
        st.stderrLines.push(line)
        if (st.stderrLines.length > 200) st.stderrLines.shift()
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ffmpeg:stderr', { sessionId, lines: lines.filter(l => l.trim()) })
      }
    })

    return await new Promise((resolve) => {
      let settled = false
      let timer = null

      const finish = (payload) => {
        if (settled) return
        settled = true
        if (timer) { clearTimeout(timer); timer = null }
        resolve(payload)
      }

      // 提交：缓冲区就地换成预热好的数据，并切换进程与响应
      const commit = () => {
        if (committed) return
        committed = true
        // 先让新进程接管会话，旧进程回调随即失效
        sess.proc = newProc
        sess.active = true
        // 旧响应不能立刻 end：那会让旧 video 元素判定「流已结束」，
        // 触发 ended/pause 状态，表现为跳转瞬间闪一下暂停。
        // 这里只是把它们从写入列表摘出，让旧连接自然挂着（画面继续播已缓存的内容），
        // 等前端切换 src 时浏览器会自行断开；再兜底 1.5s 强制回收。
        const staleResponses = st.activeResponses
        st.activeResponses = []
        setTimeout(() => {
          for (const res of staleResponses) {
            try { res.end() } catch (_) {}
          }
        }, 1500)
        // HTTP 服务器闭包持有的是同一个 state 对象，因此必须就地替换内容
        st.bufferChunks = staging.chunks
        st.bufferBytes = staging.bytes
        st.bufferEnded = staging.ended
        try { oldProc && oldProc.kill('SIGTERM') } catch (_) {}
        logInfo(`FFMPEG SEEK COMMIT: ${sessionId} -> ${requestedPos}s, primed=${staging.bytes}B, stale=${staleResponses.length}, port=${sess.serverPort}`)
        finish({ success: true, sessionId, proxyUrl: sess.serverProxyUrl, duration: sess.duration })
      }

      newProc.stdout?.on('data', (chunk) => {
        if (sess.restartToken !== token) return
        if (!committed) {
          staging.chunks.push(chunk)
          staging.bytes += chunk.length
          if (staging.bytes >= PRIME_BYTES) commit()
          return
        }
        st.bufferChunks.push(chunk)
        st.bufferBytes += chunk.length
        while (st.bufferBytes > MAX_BUFFER_BYTES && st.bufferChunks.length > 1) {
          const old = st.bufferChunks.shift()
          st.bufferBytes -= old.length
        }
        for (const res of st.activeResponses) {
          try { res.write(chunk) } catch (_) {}
        }
      })

      newProc.stdout?.on('end', () => {
        if (sess.restartToken !== token) return
        if (!committed) {
          staging.ended = true
          if (staging.bytes > 0) commit()
          return
        }
        st.bufferEnded = true
        for (const res of st.activeResponses) {
          try { res.end() } catch (_) {}
        }
        st.activeResponses = []
      })

      newProc.on('close', (code) => {
        if (sess.restartToken !== token) return
        if (sess.proc === newProc) sess.active = false
        logInfo(`FFMPEG: seek-restarted process closed code=${code} (sessionId=${sessionId})`)
      })

      newProc.on('error', (err) => {
        logError(`FFMPEG: seek-restarted process error: ${err.message}`)
        if (!committed) finish({ success: false, error: 'seek process error: ' + err.message })
      })

      // 超时兜底：只要有数据就提交，否则回滚并保留旧进程，由前端降级全量重建
      timer = setTimeout(() => {
        if (committed) return
        if (staging.bytes > 0) {
          staging.ended = true
          commit()
        } else {
          sess.restartToken = null
          try { newProc.kill('SIGTERM') } catch (_) {}
          logWarn(`FFMPEG SEEK: no output within ${PRIME_TIMEOUT_MS}ms, rollback (sessionId=${sessionId})`)
          finish({ success: false, error: 'seek produced no output in time' })
        }
      }, PRIME_TIMEOUT_MS)
    })
  })

  ipcMain.handle('local-file:serve', async (_event, filePath) => {
    try {
      await ensureLocalFileServer()
      const token = generateId()
      localFileSessions.set(token, { filePath, active: true })
      const proxyUrl = `http://127.0.0.1:${localFileServerPort}/local-file/${token}`
      logInfo(`LOCAL-FILE-SVR: serve ${filePath} as ${proxyUrl}`)
      return { success: true, token, proxyUrl }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('local-file:close', async (_event, token) => {
    localFileSessions.delete(token)
    logInfo(`LOCAL-FILE-SVR: close ${token}`)
    return true
  })

  // ============ MPV 弹窗播放 ============

  function normalizeFileUrl(fileUrl) {
    let p = decodeURIComponent(fileUrl.replace(/^file:\/\/+/, ''))
    if (process.platform === 'win32') {
      p = p.replace(/^\/+/, '')
    }
    return p
  }

  ipcMain.handle('mpv:selectPath', async (_event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 MPV 可执行文件',
      filters: [
        { name: 'MPV 可执行文件', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, path: '' }
    }
    return { success: true, path: result.filePaths[0] }
  })

  ipcMain.handle('mpv:test', async (_event, mpvPath) => {
    return new Promise((resolve) => {
      execFile(mpvPath, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, version: '', error: err.message || String(err) })
          return
        }
        const output = stdout || stderr || ''
        const match = output.match(/mpv\s+(\S+)/i)
        const version = match ? match[1] : ''
        resolve({ success: true, version })
      })
    })
  })

  ipcMain.handle('mpv:createSession', async (_event, sourceUrl, headers, mpvPath, seekTime) => {
    logInfo(`MPV: createSession src=${(sourceUrl || '').substring(0, 80)} seek=${seekTime || 0}`)
    const sessionId = generateId()
    const isLocalFile = sourceUrl && sourceUrl.startsWith('file://')
    let inputUrl = sourceUrl
    if (isLocalFile) {
      inputUrl = normalizeFileUrl(sourceUrl)
    }

    const args = [
      '--force-window=yes',
      '--keep-open=no',
      '--no-terminal',
    ]

    if (!isLocalFile && headers && typeof headers === 'object') {
      const ua = headers['User-Agent'] || headers['user-agent']
      if (ua) args.push('--user-agent=' + String(ua))
      const referer = headers['Referer'] || headers['referer']
      if (referer) args.push('--referrer=' + String(referer))
    }

    if (seekTime && seekTime > 0) {
      args.push('--start=' + String(seekTime))
    }

    args.push(inputUrl)

    const cmdPreview = args.map(a => /\s/.test(a) ? '"' + a + '"' : a).join(' ')
    logInfo(`MPV: spawn cmd: ${mpvPath} ${cmdPreview}`)

    let mpvProc
    try {
      mpvProc = spawn(mpvPath, args, { stdio: 'ignore' })
    } catch (e) {
      logError(`MPV: spawn failed, error=${e.message}`)
      return { success: false, error: 'spawn failed: ' + e.message }
    }

    const session = {
      active: true,
      proc: mpvProc,
      sessionId,
      sourceUrl,
      startTime: Date.now(),
    }
    mpvSessions.set(sessionId, session)

    logInfo(`MPV: process spawned, pid=${mpvProc.pid}, sessionId=${sessionId}, activeSessions=${mpvSessions.size}`)

    mpvProc.on('error', (err) => {
      logError(`MPV: spawn ERROR, sessionId=${sessionId}, error=${err.message}`)
      session.active = false
      mpvSessions.delete(sessionId)
    })

    mpvProc.on('close', (code) => {
      logInfo(`MPV: ${sessionId} exited, code=${code}`)
      session.active = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mpv:playbackEnded', { sessionId, exitCode: code })
      }
      try { mpvSessions.delete(sessionId) } catch (_) {}
    })

    return { success: true, sessionId }
  })

  ipcMain.handle('mpv:closeSession', async (_event, sessionId) => {
    const session = mpvSessions.get(sessionId)
    if (session) {
      session.active = false
      try { session.proc.kill('SIGTERM') } catch (_) {}
      mpvSessions.delete(sessionId)
      logInfo(`MPV SESSION CLOSE: ${sessionId}`)
    }
    return true
  })

  // ============ VLC 弹窗播放 ============

  ipcMain.handle('vlc:selectPath', async (_event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 VLC 可执行文件',
      filters: [
        { name: 'VLC 可执行文件', extensions: process.platform === 'win32' ? ['exe'] : ['*'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, path: '' }
    }
    return { success: true, path: result.filePaths[0] }
  })

  ipcMain.handle('vlc:test', async (_event, vlcPath) => {
    return new Promise((resolve) => {
      execFile(vlcPath, ['--version'], { timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, version: '', error: err.message || String(err) })
          return
        }
        const output = stdout || stderr || ''
        const match = output.match(/VLC media player\s+(\S+)/i) || output.match(/(\d+\.\d+\.\d+)/)
        const version = match ? match[1] : output.split('\n')[0]
        resolve({ success: true, version })
      })
    })
  })

  ipcMain.handle('vlc:createSession', async (_event, sourceUrl, headers, vlcPath, seekTime) => {
    logInfo(`VLC: createSession src=${(sourceUrl || '').substring(0, 80)} seek=${seekTime || 0}`)
    const sessionId = generateId()
    const isLocalFile = sourceUrl && sourceUrl.startsWith('file://')
    let inputUrl = sourceUrl
    if (isLocalFile) {
      let filePath = normalizeFileUrl(sourceUrl)
      if (process.platform === 'win32') {
        filePath = path.normalize(filePath)
      }
      inputUrl = filePath
    }

    const args = [
      '--play-and-exit',
      '--no-video-title-show',
      '--no-qt-privacy-ask',
    ]

    if (!isLocalFile) {
      if (headers && typeof headers === 'object') {
        const ua = headers['User-Agent'] || headers['user-agent']
        if (ua) args.push('--http-user-agent', String(ua))
        const referer = headers['Referer'] || headers['referer']
        if (referer) args.push('--http-referrer', String(referer))
      }
      args.push('--network-caching=3000')
    }

    if (seekTime && seekTime > 0) {
      args.push('--start-time=' + String(seekTime))
    }

    args.push(inputUrl)

    const cmdPreview = args.map(a => /\s/.test(a) ? '"' + a + '"' : a).join(' ')
    logInfo(`VLC: spawn cmd: ${vlcPath} ${cmdPreview}`)

    let vlcProc
    try {
      vlcProc = spawn(vlcPath, args, { stdio: 'ignore' })
    } catch (e) {
      logError(`VLC: spawn failed, error=${e.message}`)
      return { success: false, error: 'spawn failed: ' + e.message }
    }

    const session = {
      active: true,
      proc: vlcProc,
      sessionId,
      sourceUrl,
      startTime: Date.now(),
    }
    vlcSessions.set(sessionId, session)

    logInfo(`VLC: process spawned, pid=${vlcProc.pid}, sessionId=${sessionId}, activeSessions=${vlcSessions.size}`)

    vlcProc.on('error', (err) => {
      logError(`VLC: spawn ERROR, sessionId=${sessionId}, error=${err.message}`)
      session.active = false
      vlcSessions.delete(sessionId)
    })

    vlcProc.on('close', (code) => {
      logInfo(`VLC: ${sessionId} exited, code=${code}`)
      session.active = false
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vlc:playbackEnded', { sessionId, exitCode: code })
      }
      try { vlcSessions.delete(sessionId) } catch (_) {}
    })

    return { success: true, sessionId }
  })

  ipcMain.handle('vlc:closeSession', async (_event, sessionId) => {
    const session = vlcSessions.get(sessionId)
    if (session) {
      session.active = false
      try { session.proc.kill('SIGTERM') } catch (_) {}
      vlcSessions.delete(sessionId)
      logInfo(`VLC SESSION CLOSE: ${sessionId}`)
    }
    return true
  })

  // ============ 录屏模块 ============
  // 录屏已与悬浮窗 / 离屏副本窗口完全解耦：主窗口渲染进程（useRecorder）直接从
  // 统一流接口（PlaybackStreamHub）获取主窗口 <video> 的 MediaStream（视频 + 音频），
  // 用 MediaRecorder 编码后经 recording:writeChunk 流式写入磁盘；主进程仅负责建流、
  // 写盘、状态管理与 6 小时兜底停止。外部播放器（MPV/VLC）与网页版 webview 无主
  // 窗口 <video> 可捕获，不支持直录（由渲染层拦截提示）。
  const recordingState = {
    active: false,
    outputPath: '',   // 最终输出 MP4 路径
    tempPath: '',     // MediaRecorder 的 WebM 临时文件路径（录制结束后由 FFmpeg 转封装为 MP4）
    startTime: 0,
    writeStream: null,
    totalBytes: 0,
    maxTimer: null,
    paused: false,
    finalizing: false,
  }

  // 解析录屏转码可用的 FFmpeg 路径：统一使用内置 FFmpeg（data/ffmpeg），
  // 内置缺失时回退到已缓存的 FFmpeg（用户设置/会话）。
  function resolveRecordFfmpegPath() {
    const builtin = resolveBuiltinFfmpegPath()
    if (builtin) return builtin
    if (cachedFFmpegPath) {
      try { if (fs.existsSync(cachedFFmpegPath)) return cachedFFmpegPath } catch (_) {}
    }
    return ''
  }

  // 结束写入流并等待其完全落盘（end + flush 到 close）。
  // 带 10s 兜底超时：磁盘 IO 异常卡死时也保证停止流程能继续，不阻塞收尾。
  function endRecordWriteStream() {
    return new Promise((resolve) => {
      const ws = recordingState.writeStream
      recordingState.writeStream = null
      if (!ws) { resolve(); return }
      let done = false
      const finish = () => { if (!done) { done = true; resolve() } }
      ws.once('close', finish)
      ws.once('error', finish)
      try { ws.end() } catch (_) { finish() }
      setTimeout(finish, 10000)
    })
  }

  // 把 WebM 临时录制转码为通用 MP4（H.264 + AAC + faststart），保证兼容绝大多数播放器。
  // 返回最终输出路径；转码失败或 FFmpeg 不可用时回退为 .webm，保证录制内容不丢失。
  async function finalizeRecordToMp4() {
    if (recordingState.finalizing) return recordingState.outputPath
    recordingState.finalizing = true
    const tempPath = recordingState.tempPath
    const outputPath = recordingState.outputPath
    const fallbackPath = outputPath.replace(/\.mp4$/i, '') + '.webm'
    let finalPath = outputPath
    try {
      await endRecordWriteStream()
      if (tempPath && outputPath && fs.existsSync(tempPath)) {
        const ffmpegPath = resolveRecordFfmpegPath()
        if (ffmpegPath) {
          const code = await new Promise((resolve) => {
            const args = [
              '-y',
              '-i', tempPath,
              '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
              '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '128k',
              '-movflags', '+faststart',
              outputPath,
            ]
            let child
            try {
              child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
            } catch (e) {
              logError(`RECORDING: ffmpeg spawn error: ${e.message}`)
              resolve(-1)
              return
            }
            let stderrTail = ''
            if (child.stderr) {
              child.stderr.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-500) })
            }
            let settled = false
            let killTimer = null
            const settle = (c) => {
              if (settled) return
              settled = true
              if (killTimer) { clearTimeout(killTimer); killTimer = null }
              resolve(c)
            }
            // 转码兜底超时：FFmpeg 卡死时强制结束进程树并回退 WebM，保证停止流程一定返回
            killTimer = setTimeout(() => {
              logWarn('RECORDING: ffmpeg 转码超时，强制结束并回退 WebM')
              try { forceKillProcessTree(child.pid) } catch (_) {}
              settle(-1)
            }, 60000)
            child.on('error', (err) => {
              logError(`RECORDING: ffmpeg error: ${err.message}`)
              settle(-1)
            })
            child.on('close', (c) => {
              if (c !== 0) logError(`RECORDING: ffmpeg exit code=${c}, stderr=${stderrTail}`)
              settle(c)
            })
          })
          if (code === 0) {
            logInfo(`RECORDING: converted to MP4: ${outputPath}`)
          } else {
            finalPath = fallbackPath
            logWarn(`RECORDING: 转码失败，输出改为 WebM: ${finalPath}`)
          }
        } else {
          finalPath = fallbackPath
          logWarn('RECORDING: FFmpeg 不可用，无法转码 MP4，回退为 WebM')
        }
        // 清理临时 WebM
        try { fs.unlinkSync(tempPath) } catch (_) {}
      }
      // 仅在仍指向本次录制时回写，避免与重叠录制冲突
      if (recordingState.outputPath === outputPath) recordingState.outputPath = finalPath
      if (recordingState.tempPath === tempPath) recordingState.tempPath = ''
    } catch (e) {
      logError(`RECORDING: finalize error: ${e.message}`)
    } finally {
      recordingState.finalizing = false
    }
    return finalPath
  }

  function stopRecordingInternal() {
    if (!recordingState.active) return
    recordingState.active = false
    recordingState.paused = false
    if (recordingState.maxTimer) {
      clearTimeout(recordingState.maxTimer)
      recordingState.maxTimer = null
    }
    // 不在此处 end writeStream：统一交由 finalizeRecordToMp4 结束写入流并等待落盘后再转码
    const elapsed = ((Date.now() - recordingState.startTime) / 1000).toFixed(1)
    logInfo(`RECORDING: stopped, elapsed=${elapsed}s, bytes=${recordingState.totalBytes}, output=${recordingState.outputPath}`)
    // 携带录制结果（时长/字节数/输出路径），供主窗口收尾展示
    const result = {
      elapsed,
      totalBytes: recordingState.totalBytes,
      outputPath: recordingState.outputPath,
    }
    // 主进程侧兜底收尾：通知主窗口收尾（useRecorder 监听 recording:stopped）
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording:stopped', result)
    }
  }

  ipcMain.handle('recording:selectOutput', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '选择录屏保存位置',
      defaultPath: `PCLive_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.mp4`,
      filters: [
        { name: 'MP4 视频', extensions: ['mp4'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { success: false, path: '' }
    // 用户手动输入路径且未带扩展名时，统一补 .mp4
    let filePath = result.filePath
    if (!/\.mp4$/i.test(filePath)) filePath += '.mp4'
    return { success: true, path: filePath }
  })

  ipcMain.handle('recording:startStream', async (_event, { outputPath }) => {
    if (recordingState.active) {
      stopRecordingInternal()
      finalizeRecordToMp4().catch((e) => logError(`RECORDING: finalize error: ${e.message}`))
    }
    // 未选择保存位置时，与下载模块逻辑一致：默认保存到项目根目录 / EXE 所在目录的 out 文件夹
    let resolvedPath = outputPath
    if (!resolvedPath) {
      const dir = resolveDefaultDownloadDir()
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (e) {
        return { success: false, error: '无法创建默认保存文件夹: ' + e.message }
      }
      resolvedPath = path.join(dir, `PCLive_rec_${downloadTimestamp()}.mp4`)
    }
    // 统一补 .mp4 扩展名
    if (!/\.mp4$/i.test(resolvedPath)) resolvedPath += '.mp4'

    recordingState.outputPath = resolvedPath
    // MediaRecorder 只能输出 WebM，先落盘为临时 WebM，录制结束后由 FFmpeg 转封装为 MP4
    recordingState.tempPath = path.join(os.tmpdir(), `pclive-rec-${downloadTimestamp()}.webm`)
    recordingState.startTime = Date.now()
    recordingState.totalBytes = 0
    recordingState.active = true
    recordingState.paused = false
    recordingState.finalizing = false

    // 兜底：无论是否手动停止，默认 6 小时自动停止（与下载模块一致）
    recordingState.maxTimer = setTimeout(() => {
      if (recordingState.active) {
        stopRecordingInternal()
        finalizeRecordToMp4().catch((e) => logError(`RECORDING: finalize error: ${e.message}`))
      }
    }, 6 * 3600 * 1000)

    recordingState.writeStream = fs.createWriteStream(recordingState.tempPath, { flags: 'w' })
    recordingState.writeStream.on('error', (err) => {
      logError(`RECORDING: writeStream error: ${err.message}`)
      if (recordingState.active) {
        stopRecordingInternal()
        finalizeRecordToMp4().catch((e) => logError(`RECORDING: finalize error: ${e.message}`))
      }
    })

    logInfo(`RECORDING: stream started, output=${resolvedPath}, temp=${recordingState.tempPath}`)
    return { success: true, outputPath: resolvedPath }
  })

  ipcMain.handle('recording:writeChunk', async (_event, chunk) => {
    if (!recordingState.active || !recordingState.writeStream) return { success: false }
    try {
      const buf = Buffer.from(chunk)
      recordingState.writeStream.write(buf)
      recordingState.totalBytes += buf.length
      return { success: true }
    } catch (e) {
      logError(`RECORDING: writeChunk error: ${e.message}`)
      return { success: false }
    }
  })

  ipcMain.handle('recording:finishStream', async () => {
    if (!recordingState.active) {
      return { success: false, error: '未在录制' }
    }
    const elapsed = ((Date.now() - recordingState.startTime) / 1000).toFixed(1)
    const totalBytes = recordingState.totalBytes
    stopRecordingInternal()
    // 等待写入流落盘，再用 FFmpeg 转码为 MP4（失败则回退 WebM）
    const outputPath = await finalizeRecordToMp4()
    return { success: true, elapsed, totalBytes, outputPath }
  })

  ipcMain.handle('recording:pause', async () => {
    if (!recordingState.active) return { success: false, error: '未在录制' }
    recordingState.paused = true
    logInfo('RECORDING: paused')
    return { success: true }
  })

  ipcMain.handle('recording:resume', async () => {
    if (!recordingState.active) return { success: false, error: '未在录制' }
    recordingState.paused = false
    logInfo('RECORDING: resumed')
    return { success: true }
  })

  ipcMain.handle('recording:status', async () => {
    if (!recordingState.active) {
      return { recording: false }
    }
    const elapsed = Math.round((Date.now() - recordingState.startTime) / 1000)
    return {
      recording: true,
      paused: recordingState.paused,
      elapsed,
      totalBytes: recordingState.totalBytes,
      outputPath: recordingState.outputPath,
    }
  })

  ipcMain.handle('recording:openFolder', async (_event, outputPath) => {
    // 优先打开当前选择/最近一次录屏输出所在目录，否则回退到默认 out 保存目录
    const dir = outputPath
      ? path.dirname(outputPath)
      : recordingState.outputPath
        ? path.dirname(recordingState.outputPath)
        : resolveDefaultDownloadDir()
    if (!dir) return { success: false, error: '暂无保存目录' }
    try {
      const err = await shell.openPath(dir)
      if (err) return { success: false, error: err }
      return { success: true, directoryPath: dir }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

  // ============ 流下载模块（多任务并发） ============
  // 复用现有播放接口抓取视频流：HLS(m3u8) 走「分片下载 + ffmpeg concat 无损合并」，
  // 其他直链格式(flv/ts/mp4 等) 走单文件流式下载。未点击停止时默认 6 小时自动停止。
  // 支持多个不同频道的链接并列下载：每个任务独立状态，重复链接跳过，
  // 并发数上限默认 3（最大 10），超出并发数的新任务进入队列等待。
  const downloadTasks = new Map()   // id -> task
  let downloadNextId = 1
  let downloadMaxConcurrent = 3

  function makeDownloadTask(id, params) {
    return {
      id,
      status: 'queued',          // queued | downloading | merging | done
      active: false,
      merging: false,
      done: false,
      success: false,
      url: params.url || '',
      headers: params.headers || {},
      outputDir: params.outputDir || '',
      segmentsDir: '',
      outputFile: '',
      cleanupMode: params.cleanupMode === 'auto' ? 'auto' : 'manual',
      title: params.title || '',
      startTime: 0,
      segmentCount: 0,
      totalBytes: 0,
      downloadedSeq: new Set(),
      processedSeq: new Set(),
      segmentFiles: [],
      stopRequested: false,
      reason: '',
      maxDurationMs: 6 * 3600 * 1000,
      timer: null,
      ffmpegProc: null,
      currentRequest: null,
      error: '',
      lastNewSegmentTime: 0,
      // 直播流状态：isLive 表示需要持续追流（不因当前缓冲窗口下完而自动结束），
      // siteMeta 用于在短效 token 过期前重解析获取新的一次性播放地址。
      isLive: false,
      siteMeta: null,
      lastResolveTime: 0,
    }
  }

  function countActiveDownloads() {
    let n = 0
    for (const st of downloadTasks.values()) {
      if ((st.active || st.merging) && !st.done) n++
    }
    return n
  }

  // 有并发空位时，按入队顺序启动下一个排队任务
  function scheduleNextDownload() {
    if (countActiveDownloads() >= downloadMaxConcurrent) return
    for (const st of downloadTasks.values()) {
      if (st.status === 'queued' && !st.done) {
        startDownloadTask(st)
        if (countActiveDownloads() >= downloadMaxConcurrent) break
      }
    }
  }

  // 仅输出请求头「键名」用于日志，Cookie 值脱敏（只显示长度），避免泄露敏感凭据
  function summarizeHeadersForLog(headers) {
    if (!headers || typeof headers !== 'object') return '{}'
    const keys = Object.keys(headers).map((k) => {
      const lk = k.toLowerCase()
      if (lk === 'cookie') return `Cookie=<${String(headers[k] || '').length} chars>`
      return k
    })
    return `{${keys.join(', ')}}`
  }

  // 真正启动一个任务（初始化目录 / 定时器并进入下载循环）
  function startDownloadTask(st) {
    st.status = 'downloading'
    st.active = true
    st.startTime = Date.now()
    st.lastNewSegmentTime = Date.now()
    try { fs.mkdirSync(st.outputDir, { recursive: true }) } catch (_) {}
    st.segmentsDir = path.join(st.outputDir, 'segments_' + downloadTimestamp())
    try { fs.mkdirSync(st.segmentsDir, { recursive: true }) } catch (_) {}
    st.timer = setTimeout(() => {
      if (st.active && !st.done) {
        st.stopRequested = true
        st.reason = 'timeout'
        if (st.currentRequest) { destroyDownloadRequest(st.currentRequest) }
        if (st.ffmpegProc) { try { forceKillProcessTree(st.ffmpegProc.pid) } catch (_) {} }
        logInfo(`DOWNLOAD: 6h max duration reached, auto-stopping task ${st.id}`)
      }
    }, st.maxDurationMs)
    logInfo(`DOWNLOAD: started task ${st.id} url=${st.url.substring(0, 160)} dir=${st.outputDir} cleanup=${st.cleanupMode} headers=${summarizeHeadersForLog(st.headers)}`)
    runDownloadLoop(st)
  }

  function sanitizeFileName(name) {
    return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80).trim() || 'download'
  }

  // 未选择保存文件夹时的默认输出目录：开发态为项目根目录 out，打包态为 EXE 所在目录 out
  function resolveDefaultDownloadDir() {
    if (app.isPackaged) {
      return path.join(path.dirname(app.getPath('exe')), 'out')
    }
    return path.join(__dirname, '..', 'out')
  }

  function downloadTimestamp() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  // 从直链地址推导原始容器扩展名（用于「原视频直接落盘」不改变封装格式）
  function resolveStreamExt(url, fallback = '.ts') {
    const m = /\.(m3u8|m3u|flv|mp4|m4s|ts|m2ts|mkv|avi|mov|webm|aac|mp3)(\?|#|$)/i.exec(url || '')
    if (m) {
      const ext = m[1].toLowerCase()
      if (ext === 'm3u' || ext === 'm3u8') return '.ts'
      return '.' + ext
    }
    return fallback
  }

  // 从 HLS 分片 URI 推导原始扩展名（fMP4 为 .m4s/.mp4，其余默认 .ts）
  function resolveSegmentExt(segUri) {
    return resolveStreamExt(segUri, '.ts')
  }

  function downloadSendProgress(st, extra = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('download:progress', {
      id: st.id,
      status: st.status,
      active: st.active,
      merging: st.merging,
      elapsed: st.startTime ? Math.round((Date.now() - st.startTime) / 1000) : 0,
      segmentCount: st.segmentCount,
      totalBytes: st.totalBytes,
      phase: extra.phase || (st.merging ? 'merging' : 'downloading'),
      currentSegment: extra.currentSegment || '',
      title: st.title,
      url: st.url,
      outputDir: st.outputDir,
      segmentsDir: st.segmentsDir,
    })
  }

  function downloadSendDone(st, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('download:done', {
      id: st.id,
      success: !!st.success,
      error: st.error || '',
      reason: st.reason,
      outputFile: st.outputFile,
      outputDir: st.outputDir,
      segmentsDir: st.segmentsDir,
      segmentCount: st.segmentCount,
      totalBytes: st.totalBytes,
      cleanupMode: st.cleanupMode,
      title: st.title,
      url: st.url,
    })
  }

  // 强制结束指定 PID 的进程及其子进程。Windows 下 FFmpeg 可能卡死在 IO/网络，
  // SIGTERM 不生效，用 taskkill /T /F 杀整棵进程树兜底；非 Windows 走负 PID 组杀。
  function forceKillProcessTree(pid) {
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        k.on('error', () => {})
      } else {
        try { process.kill(-pid, 'SIGKILL') } catch (_) {}
        try { process.kill(pid, 'SIGKILL') } catch (_) {}
      }
    } catch (_) {}
  }

  function finishDownload(st, payload) {
    if (st.done) return
    st.active = false
    st.merging = false
    st.done = true
    st.status = 'done'
    st.success = !!payload.success
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.stopWatchdog) { clearTimeout(st.stopWatchdog); st.stopWatchdog = null }
    if (st.currentRequest) { destroyDownloadRequest(st.currentRequest); st.currentRequest = null }
    if (st.ffmpegProc) { try { forceKillProcessTree(st.ffmpegProc.pid) } catch (_) {} st.ffmpegProc = null }
    st.error = payload.error || ''
    st.reason = payload.reason || st.reason || 'stopped'
    if (payload.outputFile) st.outputFile = payload.outputFile
    if (st.success) {
      logInfo(`DOWNLOAD: task ${st.id} 结束成功 reason=${st.reason} outputFile=${st.outputFile} totalBytes=${st.totalBytes} segments=${st.segmentCount}`)
    } else {
      logError(`DOWNLOAD: task ${st.id} 结束失败 reason=${st.reason} error=${st.error || '(无)'} url=${(st.url || '').substring(0, 160)}`)
    }
    downloadSendDone(st, {})
    // 释放并发名额，调度队列中的下一个任务
    scheduleNextDownload()
  }

  function abortDownload(st) {
    st.active = false
    st.stopRequested = true
    st.merging = false
    st.done = true
    st.status = 'done'
    st.success = false
    if (st.timer) { clearTimeout(st.timer); st.timer = null }
    if (st.currentRequest) { destroyDownloadRequest(st.currentRequest); st.currentRequest = null }
    if (st.ffmpegProc) { try { forceKillProcessTree(st.ffmpegProc.pid) } catch (_) {} st.ffmpegProc = null }
  }

  // 基于 doProxyFetchNode 的 Promise 封装，返回 { status, body(Buffer), contentType, finalUrl }
  // isolateCookies=true：下载走独立隔离环境，不读写全局 CookieJar，避免切换频道污染下载任务
  function downloadFetchBuffer(url, headers) {
    logVerbose(`DOWNLOAD: fetch buffer url=${url.substring(0, 140)} headers=${summarizeHeadersForLog(headers)}`)
    return new Promise((resolve, reject) => {
      doProxyFetchNode(url, headers || {}, 20, resolve, reject, 0, true, true)
    })
  }

  // 下载模块流格式探测：仅读取响应头部即可判定 HLS 播放列表还是原始媒体流。
  // 与 downloadFetchBuffer 的关键区别：遇到非 HLS 的无限直播流（FLV/TS/MP4 等）时
  // 在首个数据块内立即断开连接，避免对永不结束的响应做整段缓冲导致卡死。
  // 返回 { status, contentType, body(Buffer), isHls }；isHls=true 时 body 为完整播放列表文本。
  const DOWNLOAD_PROBE_MAX_BYTES = 256 * 1024
  function downloadProbe(st, url, headers) {
    logVerbose(`DOWNLOAD: probe stream url=${url.substring(0, 140)} headers=${summarizeHeadersForLog(headers)}`)
    return new Promise((resolve, reject) => {
      const attempt = (u, redirectsLeft) => {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
        let parsed
        try { parsed = new URL(u) } catch (_) { return reject(new Error('Malformed URL: ' + u)) }
        const sendHeaders = buildReqHeaders(parsed, headers || {})
        const protocol = parsed.protocol === 'https:' ? https : http
        const options = {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: sendHeaders,
          timeout: 15000,
          rejectUnauthorized: false,
          family: getIpFamily(parsed),
          agent: parsed.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
        }
        const req = protocol.request(options, (res) => {
          st.currentRequest = req
          const status = res.statusCode || 200
          const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
          const loc = (res.headers['location'] || res.headers['Location'] || '')
          const encoding = (res.headers['content-encoding'] || '').toLowerCase()
          if (status >= 300 && status < 400 && loc) {
            res.resume()
            attempt(resolveUrl(parsed.href, loc), redirectsLeft - 1)
            return
          }
          if (status !== 200) {
            res.resume()
            return resolve({ status, contentType: ct, body: null, isHls: false })
          }
          const chunks = []
          let settled = false
          let isHls = ct.includes('mpegurl') || ct.includes('m3u8')
          const tryDecode = (buf) => {
            if (encoding.includes('gzip')) { try { return zlib.gunzipSync(buf) } catch (_) {} }
            if (encoding.includes('deflate')) { try { return zlib.inflateSync(buf) } catch (_) {} }
            return buf
          }
          const finishBinary = () => {
            if (settled) return
            settled = true
            try { req.destroy() } catch (_) {}
            resolve({ status, contentType: ct, body: Buffer.concat(chunks), isHls: false })
          }
          res.on('data', (c) => {
            if (settled) return
            chunks.push(c)
            if (isHls) return
            const head = tryDecode(Buffer.concat(chunks))
            const headStr = head.slice(0, 512).toString('utf8')
            if (headStr.startsWith('#EXTM3U')) {
              isHls = true
              return
            }
            // 二进制魔法字节：FLV("FLV") / MP4(ftyp) / MPEG-TS(0x47 同步字节) / ID3
            if (head.length >= 3 && head[0] === 0x46 && head[1] === 0x4c && head[2] === 0x56) return finishBinary()
            if (head.length >= 8 && head.slice(4, 8).toString('ascii') === 'ftyp') return finishBinary()
            if (head.length >= 1 && head[0] === 0x47) return finishBinary()
            if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return finishBinary()
            // 累计超过上限仍未识别为 HLS，视为二进制直链流
            let total = 0
            for (const b of chunks) total += b.length
            if (total >= DOWNLOAD_PROBE_MAX_BYTES) return finishBinary()
          })
          res.on('end', () => {
            if (settled) return
            settled = true
            const bodyBuf = tryDecode(Buffer.concat(chunks))
            resolve({ status, contentType: isHls ? 'application/vnd.apple.mpegurl' : ct, body: bodyBuf, isHls })
          })
          res.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
        })
        req.on('error', (e) => reject(e))
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
        req.end()
      }
      attempt(url, 20)
    })
  }

  // 从分片 URI 中提取尾部递增序号（如央视频时移分片 0-22-1786647537.ts 中的 1786647537）。
  // 用于无 #EXT-X-MEDIA-SEQUENCE 的直播时移清单：续签得到新清单后，分片序号跨清单单调递增，
  // 确保去重与文件命名稳定，避免新清单分片序号从 0 重新计数导致已下载分片被误判或覆盖。
  function extractStableSeqFromUri(uri) {
    const m = /(\d+)\.(?:ts|m4s|mp4|m2ts|flv|aac|mp3)(?:\?|#|$)/i.exec(String(uri || ''))
    return m ? parseInt(m[1], 10) : null
  }

  function parseM3u8(text) {
    const lines = String(text || '').split(/\r?\n/)
    const res = { isMaster: false, variants: [], mediaSequence: 0, targetDuration: 4, endList: false, segments: [], encrypted: false }
    let hasStreamInf = false
    let pendingVariant = null
    let seq = 0
    let dur = 0
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        hasStreamInf = true
        pendingVariant = {}
        const bw = line.match(/BANDWIDTH=(\d+)/i)
        const rs = line.match(/RESOLUTION=(\d+x\d+)/i)
        if (bw) pendingVariant.bandwidth = parseInt(bw[1], 10)
        if (rs) pendingVariant.resolution = rs[1]
      } else if (hasStreamInf && !line.startsWith('#') && pendingVariant) {
        pendingVariant.url = line
        res.variants.push(pendingVariant)
        pendingVariant = null
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        seq = parseInt(line.split(':')[1], 10) || 0
      } else if (line.startsWith('#EXT-X-TARGETDURATION')) {
        res.targetDuration = parseFloat(line.split(':')[1]) || 4
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        res.endList = true
      } else if (line.startsWith('#EXT-X-KEY')) {
        // 检测 AES-128 / SAMPLE-AES 加密：加密分片无法直接以原始字节合并播放，
        // 需回退 FFmpeg -c copy 解密（仅解封装解密，不重编码）
        if (/METHOD=(AES-128|SAMPLE-AES)/i.test(line)) res.encrypted = true
      } else if (line.startsWith('#EXTINF')) {
        dur = parseFloat((line.split(':')[1] || '').split(',')[0]) || 0
      } else if (!line.startsWith('#')) {
        let segSeq = seq
        // 优先采用分片 URI 尾部的递增序号（如央视频时移分片 0-18-1786633612.ts 中的 1786633612）。
        // 央视频/央视时移清单的 #EXT-X-MEDIA-SEQUENCE 是相对当前缓冲窗口从 0 重新计数的，
        // 续签换到新 token 后序号会回退，导致新窗口分片与已下载分片序号冲突而被误判去重、缺失分片。
        // 分片 URI 尾部的 CDN 全局序号跨清单单调递增，更适合去重与文件命名；
        // 提取不到、或尾部数字小于相对序号（经典直播 MEDIA-SEQUENCE 更权威）时回退 MEDIA-SEQUENCE。
        const extracted = extractStableSeqFromUri(line)
        if (extracted != null && extracted >= seq) segSeq = extracted
        res.segments.push({ uri: line, duration: dur, seq: segSeq })
        seq++
        dur = 0
      }
    }
    res.isMaster = hasStreamInf
    return res
  }

  function selectBestVariant(variants, baseUrl) {
    if (!variants || !variants.length) return ''
    const sorted = [...variants].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
    return resolveUrl(baseUrl, sorted[0].url)
  }

  function downloadSleep(ms, st) {
    return new Promise((resolve) => {
      const start = Date.now()
      const tick = () => {
        if (st.stopRequested) return resolve()
        if (Date.now() - start >= ms) return resolve()
        setTimeout(tick, 500)
      }
      tick()
    })
  }

  // 递归展开「嵌套 m3u8 播放列表」：部分 IPTV 转发源会用 .ts 扩展名返回子播放列表
  // （内容仍以 #EXTM3U 开头，且可能多层嵌套，如 cctv1.m3u8 → cctv1md/segment_x.ts →
  //  102/segment_y.ts → …）。此时直接把该「分片」落盘只会得到几 KB 的清单文本。
  // 需逐层解析并抓取最内层的真实媒体分片，按顺序追加写入同一个输出文件。
  // chain：当前递归链上已访问的 URL，用于防止异常嵌套成环导致死循环。
  const NESTED_PLAYLIST_MAX_DEPTH = 10

  async function downloadNestedPlaylist(listUrl, headers, outFilePath, st, depth, chain) {
    if (depth > NESTED_PLAYLIST_MAX_DEPTH || st.stopRequested) return { ok: false, bytes: 0 }
    const resp = await downloadFetchBuffer(listUrl, headers).catch(() => null)
    if (!resp || resp.status !== 200 || !resp.body || !resp.body.length) return { ok: false, bytes: 0 }
    const baseUrl = resp.finalUrl || listUrl
    const parsed = parseM3u8(resp.body.toString('utf8'))

    // 嵌套主播放列表：选最高带宽子流继续递归
    if (parsed.isMaster) {
      const variantUrl = selectBestVariant(parsed.variants, baseUrl)
      if (!variantUrl) return { ok: false, bytes: 0 }
      return downloadNestedPlaylist(variantUrl, headers, outFilePath, st, depth + 1, chain)
    }

    // 加密嵌套分片无法以原始字节合并播放，交由上层回退处理
    if (parsed.encrypted || !parsed.segments.length) return { ok: false, bytes: 0 }

    let total = 0
    let first = true
    for (const seg of parsed.segments) {
      if (st.stopRequested) break
      const segUrl = resolveUrl(baseUrl, seg.uri)
      if (chain.has(segUrl)) continue
      chain.add(segUrl)
      const r = await downloadFetchBuffer(segUrl, headers).catch(() => null)
      chain.delete(segUrl)
      if (!r || r.status !== 200 || !r.body || !r.body.length) continue
      if (r.isPlaylist) {
        // 更深一层嵌套：先落到临时文件再按顺序追加，保证最终字节顺序正确
        const tmpFile = outFilePath + '.nested_tmp'
        const inner = await downloadNestedPlaylist(segUrl, headers, tmpFile, st, depth + 1, chain)
        if (inner.ok && inner.bytes > 0) {
          const buf = fs.readFileSync(tmpFile)
          if (first) { fs.writeFileSync(outFilePath, buf); first = false }
          else fs.appendFileSync(outFilePath, buf)
          total += inner.bytes
        }
        try { fs.unlinkSync(tmpFile) } catch (_) {}
      } else {
        if (first) { fs.writeFileSync(outFilePath, r.body); first = false }
        else fs.appendFileSync(outFilePath, r.body)
        total += r.body.length
      }
    }
    return { ok: total > 0, bytes: total }
  }

  async function downloadSegment(segUrl, headers, filePath, seq, st) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (st.stopRequested) return { ok: false, skipped: true }
      try {
        const resp = await downloadFetchBuffer(segUrl, headers)
        if (resp.status === 404 || resp.status === 410) {
          return { ok: false, skipped: true }
        }
        if (resp.status === 200 && resp.body && resp.body.length > 0) {
          // 分片实际是嵌套 m3u8 子播放列表：逐层展开抓取真实媒体分片
          if (resp.isPlaylist) {
            const inner = await downloadNestedPlaylist(segUrl, headers, filePath, st, 0, new Set([segUrl]))
            if (inner.ok) {
              st.totalBytes += inner.bytes
              logInfo(`DOWNLOAD: task ${st.id} segment ${seq} 嵌套播放列表展开成功 bytes=${inner.bytes}`)
              return { ok: true, skipped: false }
            }
            logWarn(`DOWNLOAD: task ${st.id} segment ${seq} 嵌套播放列表展开失败（可能为加密或异常嵌套）`)
            return { ok: false, skipped: false }
          }
          fs.writeFileSync(filePath, resp.body)
          st.totalBytes += resp.body.length
          return { ok: true, skipped: false }
        }
      } catch (e) {
        logWarn(`DOWNLOAD: task ${st.id} segment ${seq} attempt ${attempt + 1} failed: ${e.message}`)
      }
    }
    return { ok: false, skipped: false }
  }

  async function mergeSegments(st) {
    if (st.done) return
    if (st.merging) return
    st.merging = true
    st.active = false
    st.status = 'merging'
    downloadSendProgress(st, { phase: 'merging' })

    const segments = [...st.segmentFiles].sort((a, b) => a.seq - b.seq)
    if (segments.length === 0) {
      finishDownload(st, { success: false, reason: st.reason || 'stopped', error: '没有下载到任何分片' })
      return
    }

    const safeTitle = sanitizeFileName(st.title) || 'download'
    // 以原始分片扩展名合并输出，不改变原视频封装格式
    const mergedExt = path.extname(segments[0].file) || '.ts'
    st.outputFile = path.join(st.outputDir, `${safeTitle}_${downloadTimestamp()}${mergedExt}`)
    logInfo(`DOWNLOAD: merging ${segments.length} segments → ${st.outputFile}`)

    try {
      const out = fs.createWriteStream(st.outputFile, { flags: 'w' })
      let streamErr = null
      out.on('error', (e) => { streamErr = e })
      for (const seg of segments) {
        if (streamErr) break
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(seg.file)
          rs.on('error', reject)
          rs.on('end', resolve)
          rs.pipe(out, { end: false })
        })
      }
      await new Promise((resolve) => out.end(() => resolve()))
      if (streamErr) throw streamErr
    } catch (e) {
      finishDownload(st, { success: false, reason: 'error', error: '合并失败: ' + e.message })
      return
    }

    if (st.cleanupMode === 'auto') {
      try { fs.rmSync(st.segmentsDir, { recursive: true, force: true }) } catch (e) {
        logWarn(`DOWNLOAD: cleanup segments failed: ${e.message}`)
      }
    }
    finishDownload(st, { success: true, reason: st.reason || 'stopped', outputFile: st.outputFile })
  }

  // 仅用于「HLS 加密流」的解密回退通道：
  // AES-128 / SAMPLE-AES 加密分片无法以原始字节直接合并播放，必须经 FFmpeg 解复用器解密。
  // 此处始终使用 -c copy（流拷贝，不重编码），仅解密并封装为 TS 容器，编码内容与原视频完全一致。
  async function runFfmpegDownload(st, isHls, firstBody) {
    // 用户在探测阶段就点了停止：不再启动 FFmpeg，直接收尾
    if (st.stopRequested) {
      finishDownload(st, { success: true, reason: st.reason || 'stopped' })
      return
    }
    const ffmpegPath = resolveBuiltinFfmpegPath()
    if (!ffmpegPath) {
      logWarn(`DOWNLOAD: task ${st.id} 未找到内置 FFmpeg，回退到 ${isHls ? 'HLS 分片抓取' : 'Node 直连'} 方案`)
      // 内置 FFmpeg 缺失时回退到旧的原始方案（HLS 分片 / Node 直连，仅能处理未加密流）
      if (isHls) return runHlsDownload(st, firstBody || '')
      return runDirectDownload(st)
    }

    const safeTitle = sanitizeFileName(st.title) || 'download'
    st.outputFile = path.join(st.outputDir, `${safeTitle}_${downloadTimestamp()}.ts`)

    // FFmpeg 直接写单个 TS 文件，不再需要分片文件夹
    if (st.segmentsDir) {
      try { fs.rmdirSync(st.segmentsDir) } catch (_) {}
      st.segmentsDir = ''
    }

    const headerArgs = buildFfmpegHeaderArgs(st.headers, false)
    const networkArgs = buildFfmpegNetworkArgs(false, isHls)

    // 复用项目现有的主播放列表解析逻辑：HLS 主列表选最高带宽子流，
    // 与播放器 hls.js 的初始变体选择保持一致，确保下载的是「最终播放出的最优视频流」。
    let ffmpegInputUrl = st.url
    if (isHls && firstBody) {
      const parsed = parseM3u8(firstBody)
      if (parsed.isMaster) {
        const variantUrl = selectBestVariant(parsed.variants, st.url)
        if (variantUrl) ffmpegInputUrl = variantUrl
      }
    }

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-y',
      '-fflags', '+genpts+discardcorrupt',
      '-avoid_negative_ts', 'make_zero',
      ...headerArgs,
      ...networkArgs,
      '-i', ffmpegInputUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'mpegts',
      st.outputFile,
    ]

    logInfo(`DOWNLOAD: ffmpeg parse mode task=${st.id} hls=${isHls} → ${st.outputFile}`)
    logInfo(`DOWNLOAD: task ${st.id} ffmpeg=${ffmpegPath} input=${ffmpegInputUrl.substring(0, 160)} headers=${summarizeHeadersForLog(st.headers)} headerArgs=${headerArgs.length}个`)
    downloadSendProgress(st, { phase: 'downloading', currentSegment: st.url })

    // FFmpeg 直接写文件，通过定时读取文件大小统计真实已下载字节数，并主动推送进度
    const bytesTimer = setInterval(() => {
      if (st.done) return
      try {
        const s = fs.statSync(st.outputFile)
        st.totalBytes = s.size
      } catch (_) {}
      downloadSendProgress(st, { phase: 'downloading' })
    }, 1000)

    await new Promise((resolve) => {
      const child = spawn(ffmpegPath, args, { windowsHide: true })
      st.ffmpegProc = child
      logInfo(`DOWNLOAD: task ${st.id} ffmpeg 进程已启动 pid=${child.pid}`)
      let stderrTail = ''
      child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString()).slice(-1000) })
      child.on('error', (e) => { logError(`DOWNLOAD: task ${st.id} ffmpeg 启动失败: ${e.message}`); st.ffmpegProc = null; resolve({ ok: false, err: e.message }) })
      child.on('close', (code) => {
        st.ffmpegProc = null
        logInfo(`DOWNLOAD: task ${st.id} ffmpeg 退出 code=${code} stopRequested=${st.stopRequested} stderr=${stderrTail.slice(-300)}`)
        // 点播：FFmpeg 读到 ENDLIST 后自动退出 code=0；
        // 直播：由 stop/6h 超时 kill 结束（code=null 表示被信号终止）。
        if (code === 0 || st.stopRequested || code === null) resolve({ ok: true })
        else resolve({ ok: false, err: `ffmpeg 退出码 ${code}: ${stderrTail.slice(-500)}` })
      })
    }).then((r) => {
      clearInterval(bytesTimer)
      if (st.done) return
      if (r.ok) {
        const reason = st.reason || (st.stopRequested ? 'stopped' : 'complete')
        finishDownload(st, { success: true, reason, outputFile: st.outputFile })
      } else {
        finishDownload(st, { success: false, reason: 'error', error: r.err })
      }
    })
  }

  // 直播流缓冲窗口耗尽后，最多等这么久就尝试重解析一次性 token 地址拿新窗口
  const LIVE_STALL_RESOLVE_MS = 8000
  // 两次 token 重解析之间的最小间隔，避免对站点解析接口造成过频请求
  const LIVE_RESOLVE_INTERVAL_MS = 60000

  // 识别「需要持续追流」的 HLS 直播流：
  // 1. 无 #EXT-X-ENDLIST 的经典直播滑动窗口；
  // 2. 央视频/央视 CDN 的时移直播（ysp.cctv.cn / timeshift），
  //    这类清单可能带 ENDLIST 但只返回当前固定缓冲窗口，分片序列不随时间推进，
  //    必须周期性重解析一次性 token 地址才能拿到后续分片。
  function detectLiveHlsStream(url, parsed) {
    if (!parsed.endList) return true
    const lower = String(url || '').toLowerCase()
    if (/ysp\.cctv\.cn/i.test(lower) || /tlivecloud/i.test(lower) || /[?&]timeshift=/i.test(lower)) return true
    return false
  }

  // 直播续签：重新解析一次性 token 地址并拉取最新播放清单。
  // 返回 { url, text } 或 null（无法续签/地址未变化时保持原清单继续轮询）。
  // 每次尝试都会刷新 lastResolveTime，避免失败时高频重试。
  async function refreshLivePlaylist(st, currentUrl) {
    let meta = st.siteMeta
    if (!meta || !meta.site || meta.site === 'generic') {
      try { meta = sniffer.inferSiteMetaFromUrl(currentUrl) || null } catch (_) { meta = null }
    }
    if (!meta || !meta.site || meta.site === 'generic') {
      logInfo(`DOWNLOAD: task ${st.id} 直播续签跳过（无法从地址推断站点元数据，继续轮询原清单）`)
      st.lastResolveTime = Date.now()
      return null
    }
    try {
      sniffer.clearPlayUrlCache()
      const list = await sniffer.resolvePlayUrl(meta)
      const fresh = list && list[0]
      if (!fresh || !fresh.url) {
        logWarn(`DOWNLOAD: task ${st.id} 直播续签失败（未取得新地址）`)
        st.lastResolveTime = Date.now()
        return null
      }
      if (fresh.url === currentUrl) {
        // 地址未变化说明窗口尚未推进，继续轮询原清单
        st.lastResolveTime = Date.now()
        return null
      }
      if (fresh.headers && typeof fresh.headers === 'object') {
        st.headers = { ...(st.headers || {}), ...fresh.headers }
      }
      const resp = await downloadFetchBuffer(fresh.url, st.headers).catch(() => null)
      st.lastResolveTime = Date.now()
      if (!resp || resp.status !== 200 || !resp.body) {
        logWarn(`DOWNLOAD: task ${st.id} 直播续签后拉取新清单失败 status=${resp && resp.status}`)
        return null
      }
      logInfo(`DOWNLOAD: task ${st.id} 直播续签成功 新清单=${fresh.url.substring(0, 160)}`)
      return { url: fresh.url, text: resp.body.toString('utf8') }
    } catch (e) {
      logWarn(`DOWNLOAD: task ${st.id} 直播续签异常: ${(e && e.message) || e}`)
      st.lastResolveTime = Date.now()
      return null
    }
  }

  async function runHlsDownload(st, firstBody) {
    let playlistUrl = st.url
    let playlistText = firstBody || ''

    logInfo(`DOWNLOAD: task ${st.id} HLS 分片抓取模式 playlist=${playlistUrl.substring(0, 160)} headers=${summarizeHeadersForLog(st.headers)}`)
    let parsed = parseM3u8(playlistText)
    if (parsed.isMaster) {
      logInfo(`DOWNLOAD: task ${st.id} 检测到 HLS 主播放列表，候选变体数=${parsed.variants.length}`)
      const variantUrl = selectBestVariant(parsed.variants, playlistUrl)
      if (!variantUrl) {
        logError(`DOWNLOAD: task ${st.id} 无法从主播放列表解析分片地址`)
        finishDownload(st, { success: false, reason: 'error', error: '无法从主播放列表解析分片地址' })
        return
      }
      logInfo(`DOWNLOAD: task ${st.id} 选择变体子流=${variantUrl.substring(0, 160)}`)
      playlistUrl = variantUrl
      const resp = await downloadFetchBuffer(playlistUrl, st.headers).catch(() => null)
      if (st.stopRequested) {
        finishDownload(st, { success: false, reason: st.reason || 'stopped' })
        return
      }
      if (!resp || resp.status !== 200 || !resp.body) {
        finishDownload(st, { success: false, reason: 'error', error: '获取媒体播放列表失败' })
        return
      }
      playlistText = resp.body.toString('utf8')
      parsed = parseM3u8(playlistText)
    }

    // 加密分片无法以原始字节直接合并播放，回退 FFmpeg -c copy 解密
    // （仅解封装解密 + 流拷贝，不重编码，输出编码仍与原视频一致）
    if (parsed.encrypted) {
      logInfo(`DOWNLOAD: task ${st.id} 检测到 HLS 加密流，回退 FFmpeg -c copy 解密（不转码）`)
      return runFfmpegDownload(st, true, playlistText)
    }

    // 直播流识别：无 ENDLIST 的滑动窗口，或央视频/央视时移固定缓冲窗口。
    // 直播流不因「当前清单内分片全部下载完」而自动结束，而是持续追流直到用户手动停止。
    st.isLive = detectLiveHlsStream(playlistUrl, parsed)
    if (st.isLive) {
      try { st.siteMeta = sniffer.inferSiteMetaFromUrl(playlistUrl) || null } catch (_) { st.siteMeta = null }
      logInfo(`DOWNLOAD: task ${st.id} 识别为直播流（持续拉取后续缓冲直到手动停止），endList=${parsed.endList} segments=${parsed.segments.length} site=${st.siteMeta && st.siteMeta.site ? st.siteMeta.site : 'generic'}`)
    }

    if (parsed.segments.length) st.lastNewSegmentTime = Date.now()

    while (true) {
      if (st.stopRequested) break

      if (Date.now() - st.startTime >= st.maxDurationMs) {
        st.stopRequested = true
        st.reason = 'timeout'
        logInfo('DOWNLOAD: max duration (6h) reached, auto-stopping')
        break
      }

      const p = parseM3u8(playlistText)
      let downloadedAny = false

      for (const seg of p.segments) {
        if (st.stopRequested) break
        if (st.processedSeq.has(seg.seq)) continue

        const segUrl = resolveUrl(playlistUrl, seg.uri)
        const fileName = `seg_${String(seg.seq).padStart(10, '0')}${resolveSegmentExt(seg.uri)}`
        const filePath = path.join(st.segmentsDir, fileName)

        const r = await downloadSegment(segUrl, st.headers, filePath, seg.seq, st)
        st.processedSeq.add(seg.seq)
        if (r.ok) {
          st.downloadedSeq.add(seg.seq)
          st.segmentFiles.push({ file: filePath, seq: seg.seq })
          st.segmentCount++
          downloadedAny = true
          st.lastNewSegmentTime = Date.now()
          downloadSendProgress(st, { phase: 'downloading', currentSegment: seg.uri })
        }
      }

      if (!st.isLive && p.endList) {
        const allDone = p.segments.every(s => st.processedSeq.has(s.seq))
        if (allDone) {
          st.stopRequested = true
          st.reason = 'complete'
          logInfo('DOWNLOAD: VOD complete (all segments downloaded)')
          break
        }
      } else if (st.isLive) {
        // 直播：不因「当前缓冲窗口下完」而结束。窗口耗尽且距上次续签足够久时，
        // 重新解析一次性 token 地址拿新窗口继续追流，直到用户手动停止或 6h 超时。
        const stalledMs = Date.now() - st.lastNewSegmentTime
        if (stalledMs > LIVE_STALL_RESOLVE_MS && Date.now() - st.lastResolveTime > LIVE_RESOLVE_INTERVAL_MS) {
          const refreshed = await refreshLivePlaylist(st, playlistUrl)
          if (st.stopRequested) break
          if (refreshed) {
            playlistUrl = refreshed.url
            playlistText = refreshed.text
            st.lastNewSegmentTime = Date.now()
            continue
          }
        }
      } else if (Date.now() - st.lastNewSegmentTime > 90000) {
        // 非直播且无 ENDLIST 的兜底：90s 无新分片视为结束
        st.stopRequested = true
        st.reason = 'complete'
        logInfo('DOWNLOAD: stream stalled 90s, assuming complete')
        break
      }

      const interval = Math.max(1000, Math.min((p.targetDuration || 4) * 1000 * 0.5, 6000))
      await downloadSleep(interval, st)
      if (st.stopRequested) break

      const resp = await downloadFetchBuffer(playlistUrl, st.headers).catch(() => null)
      if (st.stopRequested) break
      if (!resp || resp.status !== 200 || !resp.body) {
        await downloadSleep(2000, st)
        continue
      }
      playlistText = resp.body.toString('utf8')
    }

    await mergeSegments(st)
  }

  // 终止下载请求：兼容 Node 原生 http(s) 请求（destroy）与 Electron net.request（abort）
  function destroyDownloadRequest(req) {
    if (!req) return
    try { if (typeof req.destroy === 'function') req.destroy() } catch (_) {}
    try { if (typeof req.abort === 'function') req.abort() } catch (_) {}
  }

  // Node.js 原生栈直链下载（兜底路径）
  function downloadDirectToFileNode(st, url, headers, outputPath, redirectsLeft, onChunk) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
      let parsed
      try { parsed = new URL(url) } catch (_) { return reject(new Error('Malformed URL')) }
      const sendHeaders = buildReqHeaders(parsed, headers)
      const protocol = parsed.protocol === 'https:' ? https : http
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: sendHeaders,
        timeout: 30000,
        rejectUnauthorized: false,
        family: getIpFamily(parsed),
        agent: parsed.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
      }
      let ws = null
      let settled = false
      const cleanup = () => { if (ws) { try { ws.destroy() } catch (_) {} ws = null } }
      const req = protocol.request(options, (res) => {
        const status = res.statusCode || 200
        const loc = res.headers.location || ''
        // 下载隔离环境：不把响应 Set-Cookie 写入全局 CookieJar，避免污染播放器会话
        if (status >= 300 && status < 400 && loc) {
          res.resume()
          resolve(downloadDirectToFileNode(st, resolveUrl(parsed.href, loc), headers, outputPath, redirectsLeft - 1, onChunk))
          return
        }
        if (status !== 200) {
          res.resume()
          return reject(new Error('HTTP ' + status))
        }
        ws = fs.createWriteStream(outputPath, { flags: 'w' })
        ws.on('error', (e) => { if (!settled) { settled = true; cleanup(); reject(e) } })
        res.on('data', (c) => {
          try { onChunk(c.length) } catch (e) { settled = true; res.destroy(); cleanup(); reject(e); return }
          ws.write(c)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          ws.end(() => resolve(outputPath))
        })
        res.on('error', (e) => { if (!settled) { settled = true; cleanup(); reject(e) } })
      })
      st.currentRequest = req
      req.on('error', (e) => { if (!settled) { settled = true; cleanup(); reject(e) } })
      req.on('timeout', () => { req.destroy(); if (!settled) { settled = true; cleanup(); reject(new Error('timeout')) } })
      req.end()
    })
  }

  // 直链下载主路径：net.request（Chromium 网络栈）模拟浏览器 TLS 指纹并复用会话 Cookie，
  // 兼容只认浏览器栈的直播 CDN（如 live.ottiptv.cc 斗鱼网关：Node 原生栈会被静默限速到
  // 几乎停摆导致下载卡住）。主路径失败（传输错误/超时/403/5xx/错误内容类型）回退 Node 原生栈兜底。
  function downloadDirectToFile(st, url, headers, outputPath, redirectsLeft, onChunk) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
      let parsed
      try { parsed = new URL(url) } catch (_) { return reject(new Error('Malformed URL')) }

      const sendHeaders = buildReqHeaders(parsed, headers)
      const req = net.request({ method: 'GET', url: parsed.href })

      // 经 Electron net API 下发请求头。Host/Content-Length 是受限头，跳过；
      // Referer 若为 https 而请求为 http 会被 Chromium 降级拦截，改为经 webRequest 注入。
      const injectHeaders = {}
      for (const [key, val] of Object.entries(sendHeaders)) {
        const lk = key.toLowerCase()
        if (lk === 'host' || lk === 'content-length') continue
        if (lk === 'referer') { if (val) injectHeaders[key] = val; continue }
        try { req.setHeader(key, val) } catch (_) {}
      }
      if (Object.keys(injectHeaders).length) {
        proxyFetchHeaderInjections.set(parsed.href, injectHeaders)
      }

      let ws = null
      let settled = false
      let decided = false
      let timeout = null
      const cleanup = () => { if (ws) { try { ws.destroy() } catch (_) {} ws = null } }

      const fallbackToNode = (reason) => {
        if (decided) return
        decided = true
        if (timeout) clearTimeout(timeout)
        proxyFetchHeaderInjections.delete(parsed.href)
        try { req.abort() } catch (_) {}
        logWarn(`DOWNLOAD-CR: net.request 失败(${reason || 'unknown'})，回退 Node 原生栈 url=${url.substring(0, 80)}`)
        resolve(downloadDirectToFileNode(st, url, headers, outputPath, redirectsLeft, onChunk))
      }

      timeout = setTimeout(() => {
        proxyFetchHeaderInjections.delete(parsed.href)
        if (!decided) fallbackToNode('timeout')
      }, 15000)

      req.on('response', (res) => {
        proxyFetchHeaderInjections.delete(parsed.href)
        const status = res.statusCode || 200
        const loc = (res.headers['location'] || res.headers['Location'] || '')
        const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()

        // 与播放器拉流同策略：把响应 Set-Cookie 写回全局 CookieJar，保持会话续热
        const setCookieData = extractSetCookieHeaders(res.headers)
        if (setCookieData) {
          try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
        }

        if ([301, 302, 303, 307, 308].includes(status) && loc) {
          decided = true
          if (timeout) clearTimeout(timeout)
          res.destroy()
          resolve(downloadDirectToFile(st, resolveUrl(parsed.href, loc), headers, outputPath, redirectsLeft - 1, onChunk))
          return
        }

        // 403/5xx/明显非流式内容类型：回退 Node 原生栈（部分 CDN 对 Node 栈更友好）
        if (status === 403 || status >= 500 || /^(text\/html|text\/plain|application\/json|application\/xml)/.test(ct)) {
          res.resume()
          fallbackToNode(status >= 400 ? `CDN ${status}` : `content-type ${ct}`)
          return
        }
        if (status !== 200) {
          res.resume()
          decided = true
          if (timeout) clearTimeout(timeout)
          return reject(new Error('HTTP ' + status))
        }

        // 成功建立流式通道：开始写盘，此后不再回退
        decided = true
        if (timeout) clearTimeout(timeout)
        ws = fs.createWriteStream(outputPath, { flags: 'w' })
        ws.on('error', (e) => { if (!settled) { settled = true; cleanup(); reject(e) } })
        res.on('data', (c) => {
          try { onChunk(c.length) } catch (e) { settled = true; res.destroy(); req.abort(); cleanup(); reject(e); return }
          ws.write(c)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          ws.end(() => resolve(outputPath))
        })
        res.on('error', (e) => { if (!settled) { settled = true; cleanup(); reject(e) } })
      })

      st.currentRequest = req
      req.on('error', (e) => {
        proxyFetchHeaderInjections.delete(parsed.href)
        if (!decided) fallbackToNode(e.message || e.code)
      })
      req.end()
    })
  }

  async function runDirectDownload(st) {
    const safeTitle = sanitizeFileName(st.title) || 'download'
    // 直链下载不需要分片文件夹，清理掉 startDownloadTask 预先创建的空目录
    if (st.segmentsDir) {
      try { fs.rmdirSync(st.segmentsDir) } catch (_) {}
      st.segmentsDir = ''
    }
    // 直接落盘原始字节流，保留原视频容器格式（flv/mp4/ts/mkv...），不转码不重封装
    const streamExt = resolveStreamExt(st.url, '.flv')
    st.outputFile = path.join(st.outputDir, `${safeTitle}_${downloadTimestamp()}${streamExt}`)
    logInfo(`DOWNLOAD: task ${st.id} direct stream mode url=${st.url.substring(0, 160)} headers=${summarizeHeadersForLog(st.headers)} → ${st.outputFile}`)
    try {
      await downloadDirectToFile(st, st.url, st.headers, st.outputFile, 20, (chunkLen) => {
        if (st.stopRequested) throw new Error('aborted')
        st.totalBytes += chunkLen
      })
      if (st.done) return
      finishDownload(st, { success: true, reason: st.reason || 'stopped', outputFile: st.outputFile })
    } catch (e) {
      if (st.done) return
      if (st.stopRequested) {
        finishDownload(st, { success: true, reason: st.reason || 'stopped', outputFile: st.outputFile })
      } else {
        logError(`DOWNLOAD: task ${st.id} direct 下载失败: ${e.message}`)
        finishDownload(st, { success: false, reason: 'error', error: e.message })
      }
    }
  }

  async function runDownloadLoop(st) {
    try {
      const lower = st.url.split('?')[0].split('#')[0].toLowerCase()
      const videoExtRe = /\.(m3u8|m3u|flv|mp4|ts|mkv|avi|mov|webm)$/i
      const hasKnownExt = videoExtRe.test(lower)
      let isHls = lower.endsWith('.m3u8') || lower.endsWith('.m3u')
      let firstBody = ''

      logInfo(`DOWNLOAD: task ${st.id} 进入下载循环 url=${st.url.substring(0, 160)} hasKnownExt=${hasKnownExt} isHls=${isHls} headers=${summarizeHeadersForLog(st.headers)}`)

      // m3u8 播放列表是几 KB 的小文本，拉取用于主列表变体选择（复用 selectBestVariant）；
      // 未知扩展名则预取探测格式；其余已知扩展名的直链直接进入原始流下载，
      // 避免对无限直播流/大文件做整段预取造成卡死或内存膨胀。
      // 探测使用 downloadProbe：只读取响应头部即可判定 HLS/直链，非 HLS 无限流立即断开。
      if (isHls || !hasKnownExt) {
        logInfo(`DOWNLOAD: task ${st.id} 预取探测流格式 url=${st.url.substring(0, 160)}`)
        const resp = await downloadProbe(st, st.url, st.headers).catch((e) => {
          logError(`DOWNLOAD: task ${st.id} 预取探测异常: ${e.message}`)
          return null
        })
        if (st.done) return
        if (st.stopRequested) {
          finishDownload(st, { success: false, reason: st.reason || 'stopped' })
          return
        }
        if (!resp || resp.status !== 200 || (resp.isHls && !resp.body)) {
          const detail = resp ? `status=${resp.status} contentType=${resp.contentType || ''} bodyLen=${resp.body ? resp.body.length : 0}` : 'resp=null'
          logError(`DOWNLOAD: task ${st.id} 预取探测失败，无法获取视频流: ${detail}`)
          finishDownload(st, { success: false, reason: 'error', error: '无法获取视频流（HTTP ' + (resp ? resp.status : 'error') + '）' })
          return
        }
        if (resp.isHls) {
          isHls = true
          firstBody = resp.body.toString('utf8')
        }
        logInfo(`DOWNLOAD: task ${st.id} 预取探测成功 status=${resp.status} contentType=${resp.contentType || ''} bodyLen=${resp.body ? resp.body.length : 0} isPlaylist=${isHls} firstLine=${isHls ? firstBody.split('\n')[0].slice(0, 80) : '(二进制直链流)'}`)
      }

      // 下载原始视频流，不进行转码/重封装：
      // - HLS：抓取原始 .ts 分片后按原始字节顺序拼接合并（runHlsDownload，加密流内部回退 FFmpeg -c copy 解密）
      // - 直链：按原始字节直接落盘（runDirectDownload，保留原始扩展名）
      if (isHls) {
        await runHlsDownload(st, firstBody)
      } else {
        await runDirectDownload(st)
      }
    } catch (e) {
      if (st.done) return
      logError(`DOWNLOAD: task ${st.id} 下载循环异常: ${e.message}`)
      finishDownload(st, { success: false, reason: 'error', error: e.message })
    }
  }

  ipcMain.handle('download:selectFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择下载文件保存文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { success: false, directoryPath: '' }
    return { success: true, directoryPath: result.filePaths[0] }
  })

  // 序列化任务供渲染层展示（剔除不可序列化的内部字段）
  function serializeTask(st) {
    return {
      id: st.id,
      status: st.status,
      active: st.active,
      merging: st.merging,
      done: st.done,
      success: st.success,
      reason: st.reason,
      error: st.error,
      elapsed: st.startTime ? Math.round((Date.now() - st.startTime) / 1000) : 0,
      segmentCount: st.segmentCount,
      totalBytes: st.totalBytes,
      outputFile: st.outputFile,
      outputDir: st.outputDir,
      segmentsDir: st.segmentsDir,
      cleanupMode: st.cleanupMode,
      title: st.title,
      url: st.url,
    }
  }

  ipcMain.handle('download:start', async (_event, params) => {
    const { url, headers, cleanupMode, title } = params || {}
    let outputDir = (params && params.outputDir) || ''
    logInfo(`DOWNLOAD: start 请求 url=${(url || '').substring(0, 160)} headers=${summarizeHeadersForLog(headers)} title=${title || ''} outputDir=${outputDir || '(未指定)'} cleanupMode=${cleanupMode}`)
    if (!url || !/^https?:\/\//i.test(url)) {
      logWarn(`DOWNLOAD: start 拒绝，无效地址: ${url || '(空)'}`)
      return { success: false, error: '未提供有效的视频流地址' }
    }

    // 去重：同链接若已在下载/排队中，或已成功下载完成，则跳过后续请求
    for (const t of downloadTasks.values()) {
      if (t.url === url) {
        if (!t.done) return { success: true, skipped: true, reason: '该频道已在下载或排队中', id: t.id }
        if (t.success) return { success: true, skipped: true, reason: '该频道已下载完成', id: t.id }
      }
    }

    if (!outputDir) {
      outputDir = resolveDefaultDownloadDir()
      logInfo(`DOWNLOAD: 未选择保存文件夹，使用默认目录: ${outputDir}`)
    }

    try {
      fs.mkdirSync(outputDir, { recursive: true })
    } catch (e) {
      return { success: false, error: '无法创建保存文件夹: ' + e.message }
    }

    // 隔离：把下载目标 URL 的全局 Cookie 快照固化到 headers。
    // 后续所有分片/播放列表请求都带显式 Cookie，不再从全局 CookieJar 动态读取，
    // 从而避免切换频道后全局 CookieJar 变化污染正在后台进行的下载任务。
    let snapHeaders = headers || {}
    try {
      const hasExplicitCookie = Object.keys(snapHeaders).some(k => k.toLowerCase() === 'cookie')
      if (!hasExplicitCookie) {
        const cookieSnapshot = getCookiesForUrl(url)
        if (cookieSnapshot) snapHeaders = { ...snapHeaders, 'Cookie': cookieSnapshot }
        logInfo(`DOWNLOAD: Cookie 快照 ${cookieSnapshot ? `成功(${cookieSnapshot.length} chars)` : '为空（全局 CookieJar 中无该域 Cookie）'} 原始 headers=${summarizeHeadersForLog(headers)}`)
      } else {
        logInfo(`DOWNLOAD: 使用调用方显式传入的 Cookie(${(snapHeaders.Cookie || snapHeaders.cookie || '').length} chars)`)
      }
    } catch (_) {}

    const id = downloadNextId++
    const st = makeDownloadTask(id, {
      url,
      headers: snapHeaders,
      outputDir,
      cleanupMode,
      title,
    })
    downloadTasks.set(id, st)
    logInfo(`DOWNLOAD: enqueue task ${id} url=${url.substring(0, 160)} dir=${outputDir} cleanup=${st.cleanupMode} headers=${summarizeHeadersForLog(snapHeaders)}`)

    // 并发未满立即启动，否则排队等待
    scheduleNextDownload()
    return { success: true, id, queued: st.status === 'queued', maxConcurrent: downloadMaxConcurrent }
  })

  ipcMain.handle('download:stop', async (_event, taskId) => {
    const st = taskId ? downloadTasks.get(taskId) : null
    if (!st) return { success: false, error: '任务不存在' }
    if (st.done) return { success: false, error: '任务已结束' }
    // 排队中尚未开始的任务：直接结束，无需启动再停止
    if (st.status === 'queued') {
      st.stopRequested = true
      st.reason = 'stopped'
      finishDownload(st, { success: false })
      return { success: true }
    }
    st.stopRequested = true
    st.reason = 'stopped'
    if (st.currentRequest) { destroyDownloadRequest(st.currentRequest) }
    if (st.ffmpegProc) { try { forceKillProcessTree(st.ffmpegProc.pid) } catch (_) {} }
    logInfo(`DOWNLOAD: stop requested for task ${st.id}`)
    // 兜底看门狗：正常情况下下载循环会在几百毫秒内检测到 stopRequested 并收尾；
    // 若循环卡在某个无超时的网络请求 / 续签解析上无法及时退出，则 5 秒后强制结束任务。
    if (st.stopWatchdog) clearTimeout(st.stopWatchdog)
    st.stopWatchdog = setTimeout(() => {
      if (!st.done) {
        logWarn(`DOWNLOAD: task ${st.id} 停止看门狗触发，强制结束`)
        finishDownload(st, { success: false, reason: 'stopped' })
      }
    }, 5000)
    return { success: true }
  })

  ipcMain.handle('download:setMaxConcurrent', async (_event, value) => {
    const n = parseInt(value, 10)
    if (!Number.isFinite(n)) return { success: false, error: '参数无效' }
    downloadMaxConcurrent = Math.max(1, Math.min(10, n))
    scheduleNextDownload()
    return { success: true, maxConcurrent: downloadMaxConcurrent }
  })

  ipcMain.handle('download:list', async () => {
    return {
      success: true,
      maxConcurrent: downloadMaxConcurrent,
      tasks: [...downloadTasks.values()].map(serializeTask),
    }
  })

  ipcMain.handle('download:status', async () => {
    const tasks = [...downloadTasks.values()].map(serializeTask)
    return {
      success: true,
      maxConcurrent: downloadMaxConcurrent,
      activeCount: countActiveDownloads(),
      tasks,
    }
  })

  ipcMain.handle('download:openFolder', async (_event, taskId, outputDir) => {
    const st = taskId ? downloadTasks.get(taskId) : null
    const dir = (st && (st.outputDir || (st.outputFile ? path.dirname(st.outputFile) : '')))
      || (outputDir && outputDir.trim())
      || resolveDefaultDownloadDir()
    if (!dir) return { success: false, error: '暂无保存目录' }
    try {
      const err = await shell.openPath(dir)
      if (err) return { success: false, error: err }
      return { success: true, directoryPath: dir }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })

app.on('window-all-closed', () => {
  logInfo('APP: window-all-closed, cleaning up sessions')
  stopRecordingInternal()
  for (const st of downloadTasks.values()) abortDownload(st)
  downloadTasks.clear()
  closeHbtvBrowser()
  for (const [id, session] of streamSessions) {
    session.active = false
  }
  streamSessions.clear()
  for (const [id, fs] of ffmpegSessions) {
    fs.active = false
    try { fs.proc.kill('SIGTERM') } catch (_) {}
    try { fs.server.close() } catch (_) {}
  }
  ffmpegSessions.clear()
  for (const [id, ms] of mpvSessions) {
    ms.active = false
    try { ms.proc.kill('SIGTERM') } catch (_) {}
  }
  mpvSessions.clear()
  for (const [id, vs] of vlcSessions) {
    vs.active = false
    try { vs.proc.kill('SIGTERM') } catch (_) {}
  }
  vlcSessions.clear()
  if (proxyServer) {
    try { proxyServer.close() } catch (_) {}
    proxyServer = null
  }
  localFileSessions.clear()
  if (localFileServer) {
    try { localFileServer.close() } catch (_) {}
    localFileServer = null
  }
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})