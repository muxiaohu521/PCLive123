const dns = require('dns')
dns.setDefaultResultOrder('ipv4first')

const { app, BrowserWindow, ipcMain, dialog, session, net, shell } = require('electron')
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
})
dlna.setLogCallback((level, msg) => {
  if (level === 'ERROR') logError(msg)
  else if (level === 'WARN') logWarn(msg)
  else logInfo(msg)
})
const sniffer = require('./sniffer')
const yspHandler = require('./ysp_handler')
const os = require('os')
const { purifyM3u8Playlist } = require('./m3u8Purifier')

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')

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
let floatVideoInfo = null

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
      webSecurity: false  // Required: renderer loads file:// URLs for local video & fetch() for HLS.js/mpegts.js cross-origin playback
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
    const [w, h] = mainWindow.getSize()
    store.set('windowBounds', { width: w, height: h })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
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
    'User-Agent': reqHeaders['User-Agent'] || 'AptvPlayer-UA',
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

function isDirectFormatUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return /\.(m3u8|m3u|flv|f4v|mp4|m4v|mov|mkv|webm|ts|m2ts|mts|mpd|ism|smil|aac|mp3|ogg|ogv|wav|avi|wmv|rm|rmvb)(\?|&|$)/i.test(pathname)
  } catch (_) {
    return false
  }
}

function doProxyFetchNode(url, sessionHeaders, redirectsLeft, resolve, reject, depth) {
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
  }

  const req = protocol.request(options, (res) => {
    const status = res.statusCode || 200
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
    const loc = (res.headers['location'] || res.headers['Location'] || '')

    const setCookieData = extractSetCookieHeaders(res.headers)
    if (setCookieData) {
      try { parseSetCookie(setCookieData, parsed.href) } catch (_) {}
    }

    if (status >= 300 && status < 400 && loc) {
      res.resume()
      const nextUrl = resolveUrl(parsed.href, loc)
      doProxyFetchNode(nextUrl, sessionHeaders, redirectsLeft - 1, resolve, reject, depth + 1)
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
    const encoded = reqPath.slice(4)
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

function doProxyFetch(url, sessionHeaders, redirectsLeft, resolve, reject, depth) {
  logVerbose(`PROXY-FETCH: url=${url.substring(0, 100)} depth=${depth}`)
  if (redirectsLeft <= 0) return reject(new Error('Too many redirects'))
  if (!/^https?:\/\//i.test(url)) return reject(new Error('Invalid URL: ' + url))

  let parsed
  try { parsed = new URL(url) } catch (_) { return reject(new Error('Malformed URL: ' + url)) }

  const sendHeaders = buildReqHeaders(parsed, sessionHeaders)

  // Direct format URLs (with clear media extensions) use Node.js http/https
  // for reliable streaming with old CDNs. Others use net.request for browser simulation.
  if (isDirectFormatUrl(url)) {
    logVerbose(`PROXY-FETCH: branch=Node.js (direct format) url=${url.substring(0, 80)}`)
    doProxyFetchNode(url, sessionHeaders, redirectsLeft, resolve, reject, depth)
    return
  }

  logVerbose(`PROXY-FETCH: branch=net.request (browser sim) url=${url.substring(0, 80)}`)
  // Use Electron's net.request (Chromium network stack) with automatic redirect handling.
  const req = net.request({
    method: 'GET',
    url: parsed.href,
  })

  // Apply headers through Electron's net API
  if (sendHeaders) {
    for (const [key, val] of Object.entries(sendHeaders)) {
      try { req.setHeader(key, val) } catch (_) {}
    }
  }

  let resolved = false
  const timeout = setTimeout(() => {
    if (!resolved) { resolved = true; try { req.abort() } catch (_) {}; reject(new Error('timeout')) }
  }, 15000)

  req.on('response', (res) => {
    const status = res.statusCode || 200
    const ct = (res.headers['content-type'] || res.headers['Content-Type'] || '').toLowerCase()
    const loc = (res.headers['location'] || res.headers['Location'] || '')

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
      resolved = true
      clearTimeout(timeout)
      logError(`PROXY RES ERROR depth=${depth}: ${e.message}`)
      reject(e)
    })
  })

  req.on('error', e => {
    if (resolved) return
    resolved = true
    clearTimeout(timeout)
    logWarn(`PROXY REQ ERROR depth=${depth}: ${e.message}, falling back to Node.js`)
    doProxyFetchNode(url, sessionHeaders, redirectsLeft, resolve, reject, depth)
  })

  req.end()
}

// ============ Universal Stream Session Proxy ============
const streamSessions = new Map()
let proxyServer = null
let proxyPort = 0

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

function pipeLiveStream(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft = 8) {
  // Validate and forward to Node.js-based streaming (same as ffmpeg's HTTP client).
  // Chromium net.request is intentionally NOT used here — it fails on many media
  // servers that use non-standard HTTP (missing CRLF, HTTP/1.0, etc.).
  if (!/^https?:\/\//i.test(targetUrl)) {
    if (!clientRes.headersSent) { clientRes.writeHead(400, { 'Access-Control-Allow-Origin': safeCorsOrigin(clientReq) }); clientRes.end('bad url') }
    return
  }

  pipeLiveStreamNode(clientReq, clientRes, targetUrl, sessionHeaders, redirectsLeft)
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

      // For non-playlist streams (TS/FLV): stream-pipe directly, no buffering
      if (session.detectedFormat && session.detectedFormat !== 'm3u8' && reqPath === 'stream') {
        pipeLiveStream(clientReq, clientRes, session.baseUrl, session.headers)
        return
      }

      proxyFetch(session.baseUrl, session.headers, reqPath).then(result => {
        if (!session.active || !streamSessions.has(sessionId)) {
          return
        }
        if (result.isPlaylist) {
          const playlistBaseUrl = result.finalUrl || session.baseUrl
          const rawBody = result.body.toString('utf8')
          const purifiedBody = purifyM3u8Playlist(playlistBaseUrl, rawBody)
          const bodyToRewrite = purifiedBody || rawBody
          const rewrittenBody = rewritePlaylistUrls(
            bodyToRewrite,
            sessionId,
            playlistBaseUrl,
          )
          // Update session baseUrl to the post-redirect URL so subsequent requests
          // don't re-trigger PHP redirectors (which may regenerate tokens).
          if (result.finalUrl && result.finalUrl !== session.baseUrl) {
            session.baseUrl = result.finalUrl
            session.detectedFormat = 'm3u8'
          }
          const respHeaders = {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
            'Cache-Control': 'no-cache',
          }
          clientRes.writeHead(result.status || 200, respHeaders)
          clientRes.end(rewrittenBody)
        } else {
          const respHeaders = {
            'Content-Type': result.contentType || 'application/octet-stream',
            'Access-Control-Allow-Origin': safeCorsOrigin(clientReq),
            'Cache-Control': 'no-cache',
            'Content-Length': result.body.length,
          }
          clientRes.writeHead(result.status || 200, respHeaders)
          clientRes.end(result.body)
        }
      }).catch(err => {
        logError(`PROXY-SVR: fetch error for ${sessionId}: ${err.message}`)
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
      const encoded = toBase64Url(Buffer.from(trimmed))
      result.push(`http://127.0.0.1:${proxyPort}/session/${sessionId}/seg/${encoded}`)
    } else {
      const resolved = resolveUrl(baseUrl, trimmed)
      const encoded = toBase64Url(Buffer.from(resolved))
      result.push(`http://127.0.0.1:${proxyPort}/session/${sessionId}/seg/${encoded}`)
    }
  }

  return result.join('\n')
}

function createStreamSession(baseUrl, headers, detectedFormat) {
  const sessionId = generateId()
  const session = {
    active: true,
    baseUrl,
    headers: headers || {},
    detectedFormat: detectedFormat || null,
  }
  streamSessions.set(sessionId, session)
  logInfo(`SESSION CREATE: ${sessionId} url=${baseUrl.substring(0, 100)} fmt=${detectedFormat || 'auto'}`)
  return sessionId
}

function closeStreamSession(sessionId) {
  const session = streamSessions.get(sessionId)
  if (!session) return
  session.active = false
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
      headers: buildReqHeaders(parsed, { 'User-Agent': 'AptvPlayer-UA' }),
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

app.commandLine.appendSwitch('disable-features', 'BlockInsecurePrivateNetworkRequests')
app.commandLine.appendSwitch('dns-result-order', 'ipv4first')
app.commandLine.appendSwitch('ignore-certificate-errors')

app.whenReady().then(() => {
  logDebug('APP: ready, starting services')
  createWindow()

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
      details.requestHeaders['User-Agent'] = 'AptvPlayer-UA'
    }
    // Inject Referer/Origin for registered video CDN domains
    // This is the standard Electron approach — works for <video>, XHR, fetch, etc.
    let reqHost = ''
    try { reqHost = new URL(details.url).hostname } catch (_) {}
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

  ipcMain.handle('get-store-value', (_event, key) => store.get(key))
  ipcMain.handle('set-store-value', (_event, key, value) => {
    store.set(key, value)
    return true
  })
  ipcMain.handle('delete-store-value', (_event, key) => {
    store.delete(key)
    return true
  })

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
      // Fallback: retry with Chrome UA if primary request failed
      try {
        const fallbackHeaders = { ...headers, 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' }
        logWarn(`FETCH RETRY (fallback UA): ${url}`)
        const result = await fetchUrlWithDns(url, fallbackHeaders, 8)
        debugLog(`FETCH OK (fallback): ${url} size=${(result||'').length}`)
        return result
      } catch (e2) {
        logError(`FETCH FAIL (fallback): ${url}  ${e2.message}  stack=${(e2.stack||'').substring(0,200)}`)
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
  ipcMain.handle('create-stream-session', async (_event, url, headers, detectedFormat) => {
    logDebug(`IPC create-stream-session: url=${(url||'').substring(0, 80)} fmt=${detectedFormat || 'auto'}`)
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
    const { format = 'auto', quality = 'original', position = 0 } = options || {}
    const useHls = format !== 'mpegts'
    const needReencode = quality !== 'original'
    let child = null
    let mirrorServer = null
    let mirrorPort = 0
    let sessionId = generateId()
    try {
      const devices = cachedTVLiveDevices.length > 0
        ? cachedTVLiveDevices
        : await tvlive.discoverTVLiveDevices()
      if (deviceIndex < 0 || deviceIndex >= devices.length) {
        return { success: false, error: 'Device not found' }
      }
      const device = devices[deviceIndex]

      const pcIps = tvlive.getLocalIpAddresses()
      let lanIp = '127.0.0.1'
      let isEmulatorDevice = false

      if (device.host === '127.0.0.1' || device.isEmulator) {
        // 模拟器通过ADB转发连接，稍后使用adb reverse让模拟器访问PC镜像服务器
        isEmulatorDevice = true
        lanIp = '127.0.0.1'
      } else {
        for (const ip of pcIps) {
          if (tvlive.isSameSubnet(ip, device.host)) {
            lanIp = ip
            break
          }
        }
      }
      if (lanIp === '127.0.0.1' && !isEmulatorDevice) {
        const LAN_PREFERENCE = [
          /^192\.168\./,
          /^10\./,
          /^172\.(1[6-9]|2\d|3[01])\./,
        ]
        for (const pref of LAN_PREFERENCE) {
          const found = pcIps.find(ip => pref.test(ip))
          if (found) { lanIp = found; break }
        }
        if (lanIp === '127.0.0.1' && pcIps.length > 0) {
          lanIp = pcIps[0]
        }
      }

      if (!cachedFFmpegPath) {
        try {
          const exts = process.platform === 'win32' ? ['', '.exe'] : ['']
          for (const ext of exts) {
            try {
              const p = path.join(process.resourcesPath, 'ffmpeg' + ext)
              if (fs.existsSync(p)) { cachedFFmpegPath = p; break }
            } catch (_) {}
          }
          if (!cachedFFmpegPath) {
            try {
              const result = await new Promise((res) => {
                execFile('where', ['ffmpeg'], { timeout: 3000 }, (e, stdout) => {
                  if (!e && stdout) res(stdout.trim().split('\n')[0])
                  else res(null)
                })
              })
              if (result) cachedFFmpegPath = result
            } catch (_) {}
          }
        } catch (_) {}
        if (!cachedFFmpegPath) {
          return { success: false, error: 'FFmpeg未找到，请先在悬浮窗中设置FFmpeg路径' }
        }
      }

      const ffmpegPath = cachedFFmpegPath

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

      const networkArgs = isLocalFile ? [
        '-analyzeduration', '100000000', '-probesize', '50000000',
      ] : [
        '-reconnect', '1', '-reconnect_streamed', '1',
        '-reconnect_delay_max', '10', '-timeout', '15000000',
        '-rtbufsize', '16M',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ]

      const qualityScale = { '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 }

      const hlsDir = useHls ? fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-hls-')) : null
      const playlistFile = useHls ? path.join(hlsDir, 'playlist.m3u8') : null

      const videoCodecArgs = needReencode
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-vf', `scale=-2:${qualityScale[quality] || 720}`]
        : ['-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb']

      const extraVideoArgs = needReencode
        ? ['-preset', 'ultrafast', '-crf', '23', '-vf', `scale=-2:${qualityScale[quality] || 720}`]
        : ['-bsf:v', 'h264_mp4toannexb']

      // -ss 仅对本地文件有效，网络直播流无法seek，跳过
      const seekArgs = (isLocalFile && position > 0) ? ['-ss', String(position)] : []
      const rawArgs = [
        '-fflags', '+genpts+discardcorrupt',
        '-avoid_negative_ts', 'make_zero',
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
      })

      child.on('error', (err) => {
        logError(`TVLive: ffmpeg spawn error: ${err.message}`)
        ffmpegExited = true
      })

      child.on('exit', (code) => {
        ffmpegExited = true
        logInfo(`TVLive: ffmpeg ${useHls ? 'HLS' : 'MPEG-TS'} session ${sessionId} exited code=${code}`)
        if (stderrAcc) {
          logError(`TVLive: ffmpeg stderr tail: ${stderrAcc.slice(-500)}`)
        }
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
                logInfo(`TVLive: HLS playlist ready after ${((Date.now() - deadline + 5000) / 1000).toFixed(1)}s wait`)
              } else {
                logWarn(`TVLive: HLS playlist still not ready after 5s timeout for ${clientIp}`)
              }
            }
            if (!fs.existsSync(filePath)) {
              logWarn(`TVLive: HLS file not ready: ${fileName} for ${clientIp}`)
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

        child.stdout.on('data', (chunk) => {
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
            logWarn(`TVLive: MPEG-TS stream unavailable for ${clientIp}`)
            res.writeHead(503, { 'Access-Control-Allow-Origin': safeCorsOrigin(req) })
            res.end('stream unavailable')
            return
          }

          const preBufLen = preBuffer.reduce((s, c) => s + c.length, 0)
          logInfo(`TVLive: MPEG-TS serving to ${clientIp} clients=${clients.size + 1} preBuffer=${preBufLen}bytes`)

          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': safeCorsOrigin(req),
            'Cache-Control': 'no-cache',
          })

          for (const chunk of preBuffer) res.write(chunk)
          clients.add(res)
          req.on('close', () => {
            clients.delete(res)
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

      // 模拟器设备：建立ADB反向转发，让模拟器内127.0.0.1:{mirrorPort} → PC {mirrorPort}
      if (isEmulatorDevice) {
        try {
          const reverseResult = await tvlive.setupAdbReverse(mirrorPort)
          if (reverseResult.success) {
            logInfo(`TVLive: ADB反向转发建立成功 (${reverseResult.serial})，模拟器访问 127.0.0.1:${mirrorPort}`)
          } else {
            logError(`TVLive: ADB反向转发失败: ${reverseResult.error}，模拟器可能无法访问镜像流`)
          }
        } catch (e) {
          logError(`TVLive: ADB反向转发异常: ${e.message}`)
        }
      }

      const proxyUrl = useHls
        ? `http://${lanIp}:${mirrorPort}/playlist.m3u8`
        : `http://${lanIp}:${mirrorPort}/stream`

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
      })

      logInfo(`TVLive: cast ${useHls ? 'HLS' : 'MPEG-TS'} ${needReencode ? quality : '原画'} ${proxyUrl} to ${device.deviceName} (${device.host})`)

      await tvlive.castToTVLiveDevice(device, proxyUrl)
      logInfo(`TVLive: cast SUCCESS to device[${deviceIndex}] (${device.deviceName})`)
      return { success: true, sessionId, proxyUrl }
    } catch (e) {
      logError('TVLive: cast error: ' + e.message)
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

  ipcMain.handle('tlv1-resume', async (_event, deviceIndex, _unused, sessionId) => {
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
  ipcMain.handle('create-float-window', async (_event, videoInfo) => {
    try {
      if (floatWindow && !floatWindow.isDestroyed()) {
        floatWindow.focus()
        if (videoInfo) {
          floatVideoInfo = videoInfo
          floatWindow.webContents.send('float-video-update', videoInfo)
        }
        return true
      }

      floatVideoInfo = videoInfo || null

      floatWindow = new BrowserWindow({
        width: 400,
        height: 300,
        minWidth: 300,
        minHeight: 200,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        transparent: false,
        backgroundColor: '#000000',
        icon: path.join(__dirname, '../public/icon.png'),
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
        }
      })

      floatWindow.setAspectRatio(16 / 9)

      const loadUrl = isDev
        ? `http://localhost:5173/#/float`
        : `file://${path.join(__dirname, '../dist/index.html')}#/float`

      floatWindow.loadURL(loadUrl)

      floatWindow.webContents.once('did-finish-load', () => {
        if (floatVideoInfo) {
          floatWindow.webContents.send('float-video-update', floatVideoInfo)
        }
      })

      floatWindow.on('closed', () => {
        floatWindow = null
        floatVideoInfo = null
      })

      if (isDev) {
        floatWindow.webContents.openDevTools({ mode: 'detach' })
      }

      logInfo('FLOAT-WINDOW: created')
      return true
    } catch (e) {
      logError('FLOAT-WINDOW: create error: ' + e.message)
      return false
    }
  })

  ipcMain.handle('float-window-update', async (_event, videoInfo) => {
    floatVideoInfo = videoInfo
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.webContents.send('float-video-update', videoInfo)
    }
  })

  ipcMain.handle('close-float-window', async () => {
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.close()
    }
    floatWindow = null
    floatVideoInfo = null
  })

  ipcMain.handle('float-window-exists', async () => {
    return !!(floatWindow && !floatWindow.isDestroyed())
  })

  ipcMain.handle('toggle-float-fullscreen', async () => {
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.setFullScreen(!floatWindow.isFullScreen())
    }
  })

  // --- Mirror Signal Relay (WebRTC signaling between main window and float window) ---
  ipcMain.handle('mirror:signal', (event, data) => {
    const isFromMain = event.sender === (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
    const target = isFromMain ? floatWindow : mainWindow
    if (target && !target.isDestroyed()) {
      target.webContents.send('mirror:signal', data)
    }
  })

  // --- Legacy resolve-stream-url (kept for backward compat, now just returns URL as-is) ---
  ipcMain.handle('resolve-stream-url', async (_event, url, headers) => {
    return { finalUrl: url, contentType: 'auto', note: 'no pre-resolution needed' }
  })

  // --- Resolve playable URL at play-time from site metadata ---
  // When user clicks "play" on a sniff result with siteMeta (Bilibili, CCTV, etc.),
  // this generates a FRESH URL from the site's API right now.
  ipcMain.handle('resolve-external-play-url', async (_event, siteMeta) => {
    logDebug(`IPC resolve-external-play-url: site=${(siteMeta?.site || '?')} page=${(siteMeta?.pageUrl || '').substring(0, 50)}`)
    if (!siteMeta || !siteMeta.site) return { success: false, urls: [] }
    try {
      const urls = await sniffer.resolvePlayUrl(siteMeta)
      return { success: true, urls }
    } catch (e) {
      logError('RESOLVE-PLAY-URL: error for site=' + (siteMeta?.site || '?') + ': ' + e.message)
      return { success: false, urls: [], error: e.message }
    }
  })

  // --- URL Sniffer: extract video/stream URLs from a webpage ---
  // Phase 1: Quick HTML regex extraction; Phase 2: Deep sniff with BrowserWindow + webRequest intercept
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
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
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

    // Phase 2: Deep sniff (BrowserWindow + webRequest + JS injection)
    let deepMetadata = null
    let deepSession = null
    try {
      const deepResult = await sniffer.deepSniffUrls(pageUrl)
      if (deepResult && Array.isArray(deepResult.urls)) {
        for (const item of deepResult.urls) {
          if (item.url && !seenUrls.has(item.url)) {
            seenUrls.add(item.url)
          }
        }
        deepMetadata = deepResult.metadata || null
        deepSession = deepResult.session || null
        phase = phase ? 'quick+deep' : 'deep'
      }
    } catch (_) {
      logWarn('SNIFF: deep sniff failed for ' + pageUrl.substring(0, 60))
    }

    // Phase 3: Generate fresh playable URLs from site APIs (Bilibili, CCTV, etc.)
    // These URLs have valid tokens good for ~1 hour for actual playback
    let freshUrlSet = []
    // Auto-detect site from URL even if DOM extraction didn't capture site metadata
    if (!deepMetadata) deepMetadata = {}
    if (!deepMetadata.site) {
      if (/bilibili\.com\/video\//i.test(pageUrl)) { deepMetadata.site = 'bilibili'; deepMetadata.pageUrl = pageUrl }
      else if (/tv\.cctv\.com\/live\//i.test(pageUrl) || /cctv\.com\/live/i.test(pageUrl)) { deepMetadata.site = 'cctv'; deepMetadata.pageUrl = pageUrl }
    }
    if (deepMetadata && deepMetadata.site && deepSession) {
      try {
        freshUrlSet = await sniffer.generateFreshUrls(pageUrl, deepMetadata, deepSession)
        for (const u of freshUrlSet) {
          if (u && !seenUrls.has(u)) seenUrls.add(u)
        }
        if (freshUrlSet.length > 0) phase = phase ? phase + '+fresh' : 'fresh'
      } catch (_) { logWarn('SNIFF: fresh URL generation failed for site=' + (deepMetadata?.site || '?') + ' page=' + pageUrl.substring(0, 60)) }
    }
    if (deepSession) {
      try { deepSession.close() } catch (_) {}
      deepSession = null
    }

    if (seenUrls.size === 0) {
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
  let cachedFFmpegPath = null

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

  ipcMain.handle('ffmpeg:createSession', async (_event, sourceUrl, headers, ffmpegPath, seekTime, inputFormat) => {
    cachedFFmpegPath = ffmpegPath
    logDebug(`IPC ffmpeg:createSession: src=${(sourceUrl||'').substring(0, 80)} seek=${seekTime||0} fmt=${inputFormat||'auto'}`)
    const sessionId = generateId()

    let inputUrl = sourceUrl
    let isLocalFile = false
    if (sourceUrl.startsWith('file://')) {
      try {
        let filePath = decodeURIComponent(sourceUrl.replace(/^file:\/\//, ''))
        if (filePath.startsWith('/') && filePath.length > 2 && filePath.charAt(2) === ':') {
          filePath = filePath.substring(1)
        }
        inputUrl = filePath
        isLocalFile = true
      } catch (_) {}
    }

    logInfo(`FFMPEG: createSession sourceUrl=${sourceUrl} inputUrl=${inputUrl} isLocalFile=${isLocalFile} seekTime=${seekTime}`)

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

    const headerArgs = []
    if (!isLocalFile && headers && typeof headers === 'object') {
      const headerLines = []
      for (const [k, v] of Object.entries(headers)) {
        if (k && v) {
          headerLines.push(`${k}: ${String(v)}`)
        }
      }
      if (headerLines.length > 0) {
        headerArgs.push('-headers', headerLines.join('\r\n') + '\r\n')
      }
    }

    const networkArgs = isLocalFile ? [
      '-analyzeduration', '100000000',
      '-probesize', '50000000',
    ] : [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '10',
      '-timeout', '15000000',
      '-rtbufsize', '16M',
    ]

    const movFlags = 'frag_keyframe+empty_moov+default_base_moof'

    const inputFormatArgs = []
    if (!isLocalFile && typeof inputFormat === 'string' && inputFormat) {
      const fmtMap = { m3u8: 'hls', m3u: 'hls', flv: 'flv', live_flv: 'live_flv', ts: 'mpegts' }
      const ffFmt = fmtMap[inputFormat.toLowerCase()] || inputFormat
      inputFormatArgs.push('-f', ffFmt)
    }

    const seekInputArgs = (isLocalFile && typeof seekTime === 'number' && seekTime > 0)
      ? ['-ss', String(seekTime)]
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
      '-c:v', 'copy',
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
    let bufferChunks = []
    let bufferBytes = 0
    let bufferEnded = false
    let activeResponses = []
    let stderrLines = []

    ffmpegProc.stderr?.on('data', (data) => {
      const text = data.toString()
      const lines = text.trim().split('\n')
      for (const line of lines) {
        stderrLines.push(line)
        if (stderrLines.length > 200) stderrLines.shift()
      }
      debugLog(`FFMPEG: [stderr] ${text.trim().substring(0, 1000)}`)
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
      for (const chunk of bufferChunks) {
        try { res.write(chunk) } catch (_) {}
      }
      if (bufferEnded) {
        debugLog(`FFMPEG: HTTP response end (bufferEnded), chunks=${bufferChunks.length}, bytes=${bufferBytes}`)
        res.end()
      } else {
        activeResponses.push(res)
        debugLog(`FFMPEG: HTTP response streaming, activeResponses=${activeResponses.length}`)
        req.on('close', () => {
          const idx = activeResponses.indexOf(res)
          if (idx >= 0) activeResponses.splice(idx, 1)
          debugLog(`FFMPEG: HTTP client disconnected, remaining=${activeResponses.length}`)
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
        const lastStderr = stderrLines.slice(-30).join('\n')
        logError(`FFMPEG: FAIL ${errorMsg} stderr=${lastStderr.substring(0, 2000)}`)
        resolve({ success: false, error: errorMsg + (lastStderr ? '\nFFmpeg stderr:\n' + lastStderr : '') })
      }

      function tryResolve() {
        if (resolved) return
        if (serverPort && bufferChunks.length > 0) {
          resolved = true
          ffmpegSessions.set(sessionId, { active: true, proc: ffmpegProc, server: ffmpegServer, sessionId })
          logInfo(`FFMPEG SESSION CREATE: ${sessionId} on port ${serverPort}, buffer=${bufferBytes}B`)
          resolve({ success: true, sessionId, proxyUrl: serverProxyUrl, port: serverPort, detectedFormat: 'mp4', duration: probedDuration })
        }
      }

      ffmpegProc.on('error', (err) => {
        logError(`FFMPEG: process spawn error: ${err.message}`)
        failResolve('FFmpeg process error: ' + err.message)
      })

      ffmpegProc.on('close', (code) => {
        const lastStd = stderrLines.slice(-5).join(' | ')
        logInfo(`FFMPEG: process closed, code=${code}, resolved=${resolved}, bufferChunks=${bufferChunks.length}, lastStderr=${lastStd.substring(0, 300)}`)
        if (!resolved) {
          if (code !== 0 && code !== null) {
            failResolve(`FFmpeg exited with code ${code}`)
          } else if (code === 0 && bufferChunks.length === 0) {
            failResolve('FFmpeg exited with code 0 but produced no output')
          }
        }
        const s = ffmpegSessions.get(sessionId)
        if (s) s.active = false
      })

      let stdoutChunkCount = 0
      ffmpegProc.stdout?.on('data', (chunk) => {
        bufferChunks.push(chunk)
        bufferBytes += chunk.length
        stdoutChunkCount++
        while (bufferBytes > MAX_BUFFER_BYTES && bufferChunks.length > 1) {
          const old = bufferChunks.shift()
          bufferBytes -= old.length
        }
        for (const res of activeResponses) {
          try { res.write(chunk) } catch (_) {}
        }
        if (stdoutChunkCount === 1) {
          debugLog(`FFMPEG: first stdout data, chunkSize=${chunk.length}, totalBytes=${bufferBytes}`)
        }
        if (stdoutChunkCount % 100 === 0) {
          debugLog(`FFMPEG: stdout progress, chunks=${stdoutChunkCount}, totalBytes=${bufferBytes}, activeResponses=${activeResponses.length}`)
        }
        tryResolve()
      })

      ffmpegProc.stdout?.on('end', () => {
        bufferEnded = true
        debugLog(`FFMPEG: stdout end, totalChunks=${stdoutChunkCount}, totalBytes=${bufferBytes}`)
        for (const res of activeResponses) {
          try { res.end() } catch (_) {}
        }
        activeResponses = []
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

  // ============ 录屏模块 ============
  // 录屏数据从渲染进程流式写入（MediaRecorder 通过 video.captureStream() 捕获，
  // 直接从 video 元素抓取原始解码画面+音频，不包含任何 UI 遮挡层）
  const recordingState = {
    active: false,
    outputPath: '',
    startTime: 0,
    writeStream: null,
    totalBytes: 0,
  }

  function stopRecordingInternal() {
    if (!recordingState.active) return
    recordingState.active = false
    if (recordingState.writeStream) {
      try { recordingState.writeStream.end() } catch (_) {}
      recordingState.writeStream = null
    }
    const elapsed = ((Date.now() - recordingState.startTime) / 1000).toFixed(1)
    logInfo(`RECORDING: stopped, elapsed=${elapsed}s, bytes=${recordingState.totalBytes}, output=${recordingState.outputPath}`)
  }

  ipcMain.handle('recording:selectOutput', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '选择录屏保存位置',
      defaultPath: `PCLive_${new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)}.webm`,
      filters: [
        { name: 'WebM 视频', extensions: ['webm'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return { success: false, path: '' }
    return { success: true, path: result.filePath }
  })

  ipcMain.handle('recording:startStream', async (_event, { outputPath }) => {
    if (recordingState.active) {
      stopRecordingInternal()
    }
    if (!outputPath) return { success: false, error: '未指定输出路径' }

    recordingState.outputPath = outputPath
    recordingState.startTime = Date.now()
    recordingState.totalBytes = 0
    recordingState.active = true

    recordingState.writeStream = fs.createWriteStream(outputPath, { flags: 'w' })
    recordingState.writeStream.on('error', (err) => {
      logError(`RECORDING: writeStream error: ${err.message}`)
      stopRecordingInternal()
    })

    logInfo(`RECORDING: stream started, output=${outputPath}`)
    return { success: true }
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
    const outputPath = recordingState.outputPath
    stopRecordingInternal()
    return { success: true, elapsed, totalBytes, outputPath }
  })

  ipcMain.handle('recording:status', async () => {
    if (!recordingState.active) {
      return { recording: false }
    }
    const elapsed = Math.round((Date.now() - recordingState.startTime) / 1000)
    return {
      recording: true,
      elapsed,
      totalBytes: recordingState.totalBytes,
      outputPath: recordingState.outputPath,
    }
  })

app.on('window-all-closed', () => {
  logInfo('APP: window-all-closed, cleaning up sessions')
  stopRecordingInternal()
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