const { BrowserWindow, session: electronSession } = require('electron')
const { URL } = require('url')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')
const { BROWSER_UA, MOBILE_UA } = require('./ua')

const SNIFF_TIMEOUT = 15000
const LOAD_PAGE_TIMEOUT = 18000
const STEALTH_PRELOAD = path.join(__dirname, 'sniffer-preload.js')

// Direct media URL patterns
const directMediaPatterns = [
  /\.m3u8(\?.*)?$/i, /\.mp4(\?.*)?$/i, /\.flv(\?.*)?$/i,
  /\.ts(\?.*)?$/i, /\.mpd(\?.*)?$/i, /\.mkv(\?.*)?$/i,
  /\.webm(\?.*)?$/i, /\.mov(\?.*)?$/i, /\.avi(\?.*)?$/i,
  /\.wmv(\?.*)?$/i, /\.m4v(\?.*)?$/i, /\.ogv(\?.*)?$/i,
  /\.m3u(\?.*)?$/i, /\.m4a(\?.*)?$/i, /\.aac(\?.*)?$/i,
]

// Video stream URL patterns for webRequest interception
const videoUrlFilters = [
  '*://*/*.m3u8*', '*://*/*.mp4*', '*://*/*.flv*',
  '*://*/*.ts*', '*://*/*.mpd*', '*://*/*.mkv*',
  '*://*/*.webm*', '*://*/*.mov*', '*://*/*.avi*',
  '*://*/*.m4v*', '*://*/*.wmv*', '*://*/*.m4s*',
  '*://*/live/*', '*://*/stream/*', '*://*/hls/*',
  '*://*/*video*', '*://*/*play*', '*://*/*media*',
  '*://*/pull/*', '*://*/push/*',
  'rtmp://*', 'rtmps://*', 'rtsp://*',
  'thunder://*', 'magnet:*',
]

// DOM extraction script — runs after page load, extracts video sources + site metadata
const DOM_EXTRACT_SCRIPT = `
(function() {
  const urls = []
  const metadata = {}
  const addUrl = (u) => {
    if (u && typeof u === 'string' && /^https?:\\/\\//i.test(u)) {
      urls.push(u)
    }
  }

  // === video/audio elements ===
  document.querySelectorAll('video').forEach(v => {
    if (v.src) addUrl(v.src)
    if (v.currentSrc) addUrl(v.currentSrc)
    v.querySelectorAll('source').forEach(s => { if (s.src) addUrl(s.src) })
  })
  document.querySelectorAll('audio').forEach(a => {
    if (a.src) addUrl(a.src)
    if (a.currentSrc) addUrl(a.currentSrc)
  })

  // === iframe/object/embed ===
  document.querySelectorAll('iframe').forEach(f => { if (f.src) addUrl(f.src) })
  document.querySelectorAll('object, embed').forEach(el => {
    if (el.data) addUrl(el.data)
    if (el.src) addUrl(el.src)
  })

  // === Common global player variables ===
  try {
    const globals = [
      'player_data', 'video_data', 'player_aaaa', 'playinfo', '__playinfo__',
      'playerConfig', 'player_config', 'config', 'CONFIG', 'playData',
      'live_data', 'roomInfo', 'streamInfo', 'sourceInfo'
    ]
    for (const g of globals) {
      const d = window[g]
      if (!d) continue
      if (typeof d === 'object') {
        if (d.url) addUrl(d.url)
        if (d.video_url) addUrl(d.video_url)
        if (d.stream_url) addUrl(d.stream_url)
        if (d.source) addUrl(d.source)
        if (d.src) addUrl(d.src)
        if (d.file) addUrl(d.file)
        if (d.play_url) addUrl(d.play_url)
        if (d.playurl) addUrl(d.playurl)
        if (d.hls_url) addUrl(d.hls_url)
        if (d.flv_url) addUrl(d.flv_url)
        if (d.rtmp_url) addUrl(d.rtmp_url)
        if (d.video) {
          if (Array.isArray(d.video)) d.video.forEach(v => { if (v.url) addUrl(v.url); if (v.baseUrl) addUrl(v.baseUrl); if (v.base_url) addUrl(v.base_url) })
          else if (typeof d.video === 'object') { if (d.video.url) addUrl(d.video.url); if (d.video.baseUrl) addUrl(d.video.baseUrl) }
        }
        if (d.audio) {
          if (Array.isArray(d.audio)) d.audio.forEach(a => { if (a.url) addUrl(a.url); if (a.baseUrl) addUrl(a.baseUrl) })
          else if (typeof d.audio === 'object') { if (d.audio.url) addUrl(d.audio.url); if (d.audio.baseUrl) addUrl(d.audio.baseUrl) }
        }
        if (Array.isArray(d.sources)) d.sources.forEach(s => { if (s.url) addUrl(s.url); if (s.file) addUrl(s.file) })
        if (Array.isArray(d.playlist)) d.playlist.forEach(p => { if (p.file) addUrl(p.file); if (p.url) addUrl(p.url) })
        if (Array.isArray(d.streams)) d.streams.forEach(s => { if (s.url) addUrl(s.url) })
      }
      // JSON-serialize the entire object to extract any embedded URLs later
      try {
        const json = JSON.stringify(d)
        const m = json.match(/(https?:\\/\\/[^"\\\\s]*?\\.(?:m3u8|m3u|mp4|flv|ts|mpd|mkv|webm|mov)[^"\\\\s]*)/gi)
        if (m) m.forEach(addUrl)
      } catch(_) {}
    }
  } catch(_) {}

  // === Site-specific metadata extraction ===
  try {
    // Store the page URL in metadata for API resolution
    metadata.pageUrl = location.href
    
    // Bilibili
    if (window.__INITIAL_STATE__) {
      const s = window.__INITIAL_STATE__
      if (s.videoData) {
        metadata.site = 'bilibili'
        metadata.bvid = s.videoData.bvid || s.bvid
        metadata.cid = s.videoData.cid
        metadata.aid = s.videoData.aid
        metadata.title = s.videoData.title
      }
    }
    if (window.__playinfo__) {
      metadata.site = metadata.site || 'bilibili'
      metadata.playinfo = window.__playinfo__
    }
    // CCTV
    if (window.player_data || window.tv_channel) {
      metadata.site = metadata.site || 'cctv'
      if (window.player_data) {
        metadata.pid = window.player_data.pid || window.player_data.videoCenterId
        metadata.title = window.player_data.title
      }
      if (window.tv_channel) {
        metadata.channelId = window.tv_channel.channelId
      }
    }
    // iqilu — has window.config with source/url
    if (window.config) {
      if (window.config.source || window.config.url || window.config.pid) {
        metadata.site = metadata.site || 'iqilu'
        metadata.pid = window.config.pid || window.config.channelId || null
      }
    }
    // gdtv — has window.GDTV_OPT or __NEXT_DATA__
    if (window.GDTV_OPT || (window.__NEXT_DATA__ && location.hostname.includes('gdtv'))) {
      metadata.site = metadata.site || 'gdtv'
      try {
        const nd = window.__NEXT_DATA__
        if (nd && nd.props && nd.props.pageProps) {
          metadata.pid = nd.props.pageProps.channelId || nd.props.pageProps.id
        }
      } catch(_) {}
    }
    // cztv — uses CMS-like config
    if (location.hostname.includes('cztv.com')) {
      metadata.site = metadata.site || 'cztv'
      try {
        if (window.liveInfo) metadata.pid = window.liveInfo.channelId
        if (window.playData) metadata.pid = window.playData.id
      } catch(_) {}
    }
    // gxtv
    if (location.hostname.includes('gxtv.cn')) {
      metadata.site = metadata.site || 'gxtv'
    }
    // yangshipin.cn (央视频)
    if (location.hostname.includes('yangshipin.cn')) {
      metadata.site = metadata.site || 'yangshipin'
      const yspPidMatch = location.href.match(/[?&]pid=(\d+)/)
      if (yspPidMatch) metadata.pid = yspPidMatch[1]
    }
    // lotustv.mo (澳门莲花卫视)
    if (location.hostname.includes('lotustv.mo')) {
      metadata.site = metadata.site || 'lotustv'
    }
    // mgtv.com (芒果TV)
    if (location.hostname.includes('mgtv.com')) {
      metadata.site = metadata.site || 'mgtv'
    }
    // kankanews.com (看看新闻)
    if (location.hostname.includes('kankanews.com')) {
      metadata.site = metadata.site || 'kankanews'
    }
    // hebrts.cn (河北网络广播电视台)
    if (location.hostname.includes('hebrts.cn')) {
      metadata.site = metadata.site || 'hebrtv'
    }
    // dbw.cn (东北网/黑龙江)
    if (location.hostname.includes('dbw.cn')) {
      metadata.site = metadata.site || 'dbw'
    }
    // gzstv.com (贵州网络广播电视台)
    if (location.hostname.includes('gzstv.com')) {
      metadata.site = metadata.site || 'gzstv'
    }
    // fjtv.net (福建网络广播电视台)
    if (location.hostname.includes('fjtv.net')) {
      metadata.site = metadata.site || 'fjtv'
    }
    // snrtv.com (陕西网络广播电视台)
    if (location.hostname.includes('snrtv.com')) {
      metadata.site = metadata.site || 'snrtv'
    }
    // nmtv.cn (奔腾融媒/内蒙古)
    if (location.hostname.includes('nmtv.cn')) {
      metadata.site = metadata.site || 'nmtv'
    }
    // sxrtv.com (山西网络广播电视台)
    if (location.hostname.includes('sxrtv.com')) {
      metadata.site = metadata.site || 'sxrtv'
    }
    // hnntv.cn (海南网络广播电视台)
    if (location.hostname.includes('hnntv.cn')) {
      metadata.site = metadata.site || 'hnntv'
    }
    // jxntv.cn (江西网络广播电视台)
    if (location.hostname.includes('jxntv.cn')) {
      metadata.site = metadata.site || 'jxntv'
    }
    // qtv.com.cn (青岛网络广播电视台)
    if (location.hostname.includes('qtv.com.cn')) {
      metadata.site = metadata.site || 'qtv'
    }
    // live.jstv.com (江苏卫视)
    if (location.hostname.includes('live.jstv.com') || location.hostname.includes('jstv.com')) {
      metadata.site = metadata.site || 'jstv'
    }
    // 7sefun / acgkkkk — video player sites
    if (/7sefun|acgkkkk/i.test(location.hostname)) {
      metadata.site = metadata.site || 'video-player-site'
    }
    // Douyin / xiaohongshu (WebSocket + anti-bot, limited extraction)
    if (window.__NUXT__ || window.__NEXT_DATA__) {
      metadata.site = metadata.site || 'ssr-app'
      try {
        const json = JSON.stringify(window.__NUXT__ || window.__NEXT_DATA__)
        const m = json.match(/(https?:\\/\\/[^"\\\\s]*?\\.(?:m3u8|mp4|flv|m3u|ts)[^"\\\\s]*)/gi)
        if (m) m.forEach(addUrl)
      } catch(_) {}
    }
    // Generic: extract video URLs from any JSON on the page (scripts, data attributes, etc.)
    try {
      const scripts = document.querySelectorAll('script')
      for (const s of scripts) {
        if (!s.textContent) continue
        const m = s.textContent.match(/(https?:\\/\\/[^"\\s'<>]*?\\.(?:m3u8|mp4|flv|m3u|ts|mpd)[^\\s"'<>]*)/gi)
        if (m && m.length <= 50) m.forEach(addUrl)
      }
    } catch(_) {}
    // Also check script[type="application/json"] and script[data-name]
    try {
      document.querySelectorAll('script[type="application/json"], script[data-name], script[id]').forEach(el => {
        if (!el.textContent) return
        try {
          const d = JSON.parse(el.textContent)
          const s = JSON.stringify(d)
          const m = s.match(/(https?:\\/\\/[^"\\s]*?\\.(?:m3u8|mp4|flv|m3u|ts|mpd|m4s)[^"\\s]*)/gi)
          if (m && m.length <= 30) m.forEach(addUrl)
        } catch(_) {}
      })
    } catch(_) {}
  } catch(_) {}

  // === Page HTML fallback ===
  try {
    const pageHtml = document.documentElement.outerHTML
    const patterns = [
      /(https?:\\/\\/[^\\s"'<>]+?\\.m3u8[^\\s"'<>]*)/gi,
      /(https?:\\/\\/[^\\s"'<>]+?\\.mp4[^\\s"'<>]*)/gi,
      /(https?:\\/\\/[^\\s"'<>]+?\\.flv[^\\s"'<>]*)/gi,
      /(https?:\\/\\/[^\\s"'<>]+?\\.ts[^\\s"'<>]*)/gi,
    ]
    for (const p of patterns) {
      let m
      while ((m = p.exec(pageHtml)) !== null) {
        addUrl(m[1])
      }
    }
  } catch(_) {}

  return JSON.stringify({ urls: [...new Set(urls)], metadata })
})()
`

// ===== Site-specific fresh URL generators =====
// These call the site's API from within the sniff BrowserWindow's session,
// producing guaranteed-fresh URLs that won't immediately expire.

function generateBilibiliUrls(pageUrl, metadata, sniffSession) {
  return new Promise((resolve) => {
    const results = []
    try {
      let bvid = metadata.bvid
      let cid = metadata.cid
      if (!bvid) {
        const m = pageUrl.match(/BV[a-zA-Z0-9]{10}/)
        if (m) bvid = m[0]
      }
      if (!bvid) return resolve(results)

      const ua = BROWSER_UA
      const apiHeaders = { 'User-Agent': ua, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com', 'Accept': 'application/json, */*' }
      const apiPromises = []

      const fetchJson = (url) => sniffSession.fetch(url, { headers: apiHeaders }).then(r => r.json()).catch(() => null)

      if (cid) {
        apiPromises.push(
          fetchJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=1&fourk=1`).then(parseBilibiliResponse)
        )
        apiPromises.push(
          fetchJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16`).then(parseBilibiliResponse)
        )
      }

      // Also try without cid to discover cid
      apiPromises.push(
        fetchJson(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`).then(data => {
          if (data && data.data && Array.isArray(data.data) && data.data[0] && data.data[0].cid) {
            const c = data.data[0].cid
            return fetchJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${c}&fnval=1`).then(parseBilibiliResponse)
          }
          return []
        }).catch(() => [])
      )

      Promise.allSettled(apiPromises).then(all => {
        all.forEach(r => {
          if (r.status === 'fulfilled' && Array.isArray(r.value)) {
            r.value.forEach(u => results.push(u))
          }
        })
        resolve(results)
      })
    } catch (_) {
      resolve(results)
    }
  })
}

function parseBilibiliResponse(data) {
  const urls = []
  if (!data || !data.data) return urls

  // Priority 1: durl (combined mp4 with audio — best compatibility)
  if (data.data.durl && Array.isArray(data.data.durl)) {
    data.data.durl.forEach(d => { if (d.url) urls.push(d.url) })
  }
  if (data.data.url) urls.push(data.data.url)

  // Priority 2: dash (separate video+audio — needs hls.js/mpegts.js)
  const dash = data.data.dash
  if (dash) {
    if (Array.isArray(dash.video)) {
      dash.video.forEach(v => {
        if (v.baseUrl) urls.push(v.baseUrl)
        if (v.base_url) urls.push(v.base_url)
        if (v.backupUrl) urls.push(v.backupUrl)
        if (Array.isArray(v.backup_url)) v.backup_url.forEach(u => urls.push(u))
      })
    }
    if (Array.isArray(dash.audio)) {
      dash.audio.forEach(a => {
        if (a.baseUrl) urls.push(a.baseUrl)
        if (a.base_url) urls.push(a.base_url)
        a.backupUrl && urls.push(a.backupUrl)
      })
    }
  }
  return [...new Set(urls)]
}

function generateCctvUrls(pageUrl, metadata, sniffSession) {
  return new Promise((resolve) => {
    const results = []
    try {
      if (!metadata.pid) return resolve(results)

      const pid = metadata.pid
      const ua = BROWSER_UA
      const apiHeaders = { 'User-Agent': ua, 'Referer': 'https://tv.cctv.com/', 'Origin': 'https://tv.cctv.com' }
      const fetchJson = (url) => sniffSession.fetch(url, { headers: apiHeaders }).then(r => r.json()).catch(() => null)

      const apis = [
        fetchJson(`https://vdnad.apps.cntv.cn/api/getHttpStream?pid=${pid}`).then(d => {
          if (d?.hls_url) results.push(d.hls_url)
          if (d?.flv_url) results.push(d.flv_url)
          if (d?.video) results.push(d.video)
          if (d?.url) results.push(d.url)
        }),
        fetchJson(`https://vdn.apps.cntv.cn/api/getLiveSource?pid=${pid}`).then(d => {
          if (d?.hls_url) results.push(d.hls_url)
          if (d?.data?.hls_url) results.push(d.data.hls_url)
          if (d?.url) results.push(d.url)
        }),
        fetchJson(`https://api.cntv.cn/video/videoinfoByGuid?serviceId=tvcctv&guid=${pid}`).then(d => {
          if (d?.hls_url) results.push(d.hls_url)
          if (d?.flv_url) results.push(d.flv_url)
          if (d?.url) results.push(d.url)
        }),
        fetchJson(`https://api.cntv.cn/NewLive/getLiveStream?pid=${pid}`).then(d => {
          if (d?.hls_url) results.push(d.hls_url)
          if (d?.flv_url) results.push(d.flv_url)
          if (d?.url) results.push(d.url)
        }),
      ]

      const deadline = setTimeout(() => resolve(results), 8000)
      Promise.allSettled(apis).then(() => {
        clearTimeout(deadline)
        resolve(results)
      })
    } catch (_) {
      resolve(results)
    }
  })
}

function generateIqiluUrls(pageUrl, metadata, sniffSession) {
  return new Promise((resolve) => {
    try {
      // iqilu uses config.source or config stream config
      const results = []
      if (metadata.config) {
        try {
          const cfg = JSON.parse(metadata.config)
          if (cfg.url) results.push(cfg.url)
          if (cfg.source) results.push(cfg.source)
          if (cfg.stream) results.push(cfg.stream)
        } catch (_) {}
      }
      resolve(results)
    } catch (_) {
      resolve([])
    }
  })
}

// Generic: try common video API patterns for any site
function generateGenericUrls(pageUrl, sniffSession) {
  return new Promise((resolve) => {
    const results = []
    try {
      const parsed = new URL(pageUrl)
      const host = parsed.hostname

      // 7sefun.top / similar video sites — often have iframe with direct play URL
      // gdtv.cn / cztv.com / gxtv.cn — often have API endpoints
      // These sites typically embed the stream URL in JS vars, already captured by DOM extraction

      // For TV station sites, try common API patterns
      if (/(gdtv|cztv|gxtv|iqilu|wasu)\./i.test(host)) {
        // Try common live channel API
        const chIdMatch = pageUrl.match(/[Cc]hannel(?:Id|ID|id)[=_]?([a-zA-Z0-9]+)/)
        if (chIdMatch) {
          const chId = chIdMatch[1]
          const apis = [
            `https://${host}/api/live/channel/${chId}`,
            `https://${host}/api/stream/${chId}`,
            `https://${host}/live/api/${chId}`,
          ]
          Promise.allSettled(
            apis.map(api => fetchFromSession(sniffSession, api).catch(() => null))
          ).then(all => {
            all.forEach(r => {
              if (r.status === 'fulfilled' && r.value) {
                const body = typeof r.value === 'string' ? r.value : JSON.stringify(r.value)
                const m = body.match(/(https?:\/\/[^\s"'<>]*?\.(?:m3u8|mp4|flv|m3u|ts)[^\s"'<>]*)/gi)
                if (m) m.forEach(u => results.push(u))
              }
            })
            resolve([...new Set(results)])
          })
          return
        }
      }
      resolve(results)
    } catch (_) {
      resolve([])
    }
  })
}

// ============================================================
// 广东台荔枝网 (gdtv.cn) —— 官方流解析
// 取流链路对齐 gdtv-main/iptv-main/extractors/gdtv/session.js（2026-09 之后官网校验）：
//   1) getParam 接口取初始化节点（带 HMAC-SHA256 签名头）
//   2) 节点尾缀 -1 时经 WebSocket 换取会话节点
//   3) 频道详情接口先 OPTIONS 预检，再带签名头请求，解析 playUrl.hd
// 官方流地址仅两种 CDN（都带短效签名）：
//   tcdn.itouchtv.cn/live/...m3u8?t_token=...        （约 2 分钟）
//   lbplay.grtn.cn/live/...m3u8?auth_key={ts}-{}-{}-{md5}
// 省略预检/签名时接口可能仍回 200 但下发短令牌导致 HLS 403，
// 因此必须严格执行：签名头(HMAC-SHA256) + 预检 + 会话节点。
// ============================================================

const GDTV_ORIGIN = 'https://www.gdtv.cn'
const GDTV_PARAM_URL = 'https://tcdn-api.itouchtv.cn/getParam'
const GDTV_SOCKET_URL = 'wss://tcdn-ws.itouchtv.cn:3800/connect'
const GDTV_CHANNEL_API = 'https://gdtv-api.gdtv.cn/api/tv/v2/tvChannel'
// 官网 WebAssembly 签名模块里 gdtv-api / tcdn-api 的 keyset（非用户凭据，易变实现细节）
const GDTV_CA_KEY = '89541943007407288657755311868534'
const GDTV_CA_SECRET = 'dfkcY1c3sfuw1Cii9DWj8UO3iQy2hqlDxyvDXd1oVMxwYVDSgeB6phO9eW1dfuwX'
const GDTV_CLIENT = 'WEB_PC'
const GDTV_UA = BROWSER_UA
const GDTV_TIMEOUT_MS = 20000
const GDTV_PREFLIGHT_HEADERS = 'content-type,x-itouchtv-ca-key,x-itouchtv-ca-signature,x-itouchtv-ca-timestamp,x-itouchtv-client,x-itouchtv-device-id'
// 会话级设备号：进程内复用，避免每次取流换新号
const GDTV_DEVICE_ID = `WEB_${crypto.randomUUID()}`

function gdtvExtractChannelId(pageUrl) {
  const s = pageUrl || ''
  const m = s.match(/\/tvChannelDetail\/(\d+)/i) || s.match(/\/channelDetail\/(\d+)/i)
  return m ? m[1] : null
}

function gdtvIsOfficialStreamUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    if (!u.pathname.startsWith('/live/') || !/\.m3u8$/i.test(u.pathname)) return false
    if (u.hostname === 'tcdn.itouchtv.cn') return u.searchParams.has('t_token')
    if (u.hostname === 'lbplay.grtn.cn') {
      const ak = u.searchParams.get('auth_key') || ''
      return /^\d{10}-\w+-\w+-[0-9a-f]{32}$/.test(ak)
    }
    return false
  } catch (_) { return false }
}

const GDTV_STREAM_KEYS = ['streamUrl', 'liveUrl', 'playUrl', 'hlsUrl', 'hls_url', 'stream_url', 'flv_url', 'm3u8', 'flv', 'rtmp', 'mp4', 'url']

function gdtvCollectStreamUrls(data, results, depth) {
  if (!data || depth > 6) return
  if (typeof data === 'string') {
    const s = data.trim()
    if (gdtvIsOfficialStreamUrl(s)) {
      results.push(s)
      return
    }
    // 值可能是 JSON 字符串（如 playUrl 被序列化），递归解析
    try { gdtvCollectStreamUrls(JSON.parse(s), results, depth + 1) } catch (_) {}
    return
  }
  if (Array.isArray(data)) { for (const d of data) gdtvCollectStreamUrls(d, results, depth + 1); return }
  if (typeof data === 'object') {
    for (const k of Object.keys(data)) {
      const v = data[k]
      if (typeof v === 'string') {
        if (GDTV_STREAM_KEYS.includes(k)) {
          if (gdtvIsOfficialStreamUrl(v)) results.push(v)
          else { try { gdtvCollectStreamUrls(JSON.parse(v), results, depth + 1) } catch (_) {} }
        }
      } else if (v && typeof v === 'object') {
        gdtvCollectStreamUrls(v, results, depth + 1)
      }
    }
  }
}

function gdtvExtractStreamFromHtml(html) {
  if (!html) return null
  const patterns = [
    /https?:\/\/tcdn\.itouchtv\.cn\/live\/[^"'\s<>]*?\.m3u8[^"'\s<>]*/gi,
    /https?:\/\/lbplay\.grtn\.cn\/live\/[^"'\s<>]*?\.m3u8[^"'\s<>]*/gi,
    /https?:\/\/[^"'\s<>]*?\.m3u8\?[^"'\s<>]*?(?:t_token|auth_key)=[^"'\s<>]*/gi,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(html)) !== null) {
      const url = m[0].replace(/[,;:!?)\]}>`\s]+$/, '').trim()
      if (gdtvIsOfficialStreamUrl(url)) return url
    }
  }
  return null
}

// 官网签名请求头：签的是发出去的完整 URL（参数顺序、编码不能变）
function gdtvSignedHeaders(url, now = Date.now()) {
  const timestamp = String(Math.floor(Number(now)))
  if (!/^\d{13}$/.test(timestamp)) throw new Error('请求时间无效')
  return {
    'X-ITOUCHTV-Ca-Key': GDTV_CA_KEY,
    'X-ITOUCHTV-Ca-Signature': crypto.createHmac('sha256', GDTV_CA_SECRET).update(`GET\n${url}\n${timestamp}\n`).digest('base64'),
    'X-ITOUCHTV-Ca-Timestamp': timestamp,
    'X-ITOUCHTV-CLIENT': GDTV_CLIENT,
  }
}

// 带签名头 + 设备号的 JSON 请求（走无浏览器网络栈的 session.defaultSession.fetch）
function gdtvRequestJson(url) {
  return session.defaultSession.fetch(url, {
    timeout: GDTV_TIMEOUT_MS,
    headers: {
      ...gdtvSignedHeaders(url),
      'X-ITOUCHTV-DEVICE-ID': GDTV_DEVICE_ID,
      'User-Agent': GDTV_UA,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Origin': GDTV_ORIGIN,
      'Referer': `${GDTV_ORIGIN}/`,
    },
  }).then(resp => {
    if (!resp || !resp.ok) throw new Error(`广东台接口返回 HTTP ${resp ? resp.status : 'unknown'}`)
    return resp.json()
  })
}

// 初始化节点尾缀 -1 时，经 WebSocket 换取会话节点
function gdtvReceiveNode(initialNode, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') {
      reject(new Error('当前运行环境不支持 WebSocket'))
      return
    }
    let settled = false
    let ws
    let timer
    const finish = (err, node) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws && ws.close() } catch (_) {}
      if (err) reject(err)
      else resolve(node)
    }
    ws = new WebSocket(GDTV_SOCKET_URL, {
      headers: { Origin: GDTV_ORIGIN, 'User-Agent': GDTV_UA },
    })
    timer = setTimeout(() => finish(new Error('广东台会话节点获取超时')), timeoutMs)
    ws.onopen = () => {
      try { ws.send(JSON.stringify({ route: 'getwsparam', message: initialNode })) }
      catch (_) { finish(new Error('广东台会话参数发送失败')) }
    }
    ws.onerror = () => finish(new Error('广东台 WebSocket 连接失败'))
    ws.onclose = () => finish(new Error('广东台 WebSocket 提前关闭'))
    ws.onmessage = (event) => {
      let data
      try { data = JSON.parse(event.data) } catch (_) { return }
      if (!data || data.status !== 201) return
      const node = data.wsnode
      if (typeof node !== 'string' || !node || node.length > 8192) {
        finish(new Error('广东台返回的会话节点无效'))
        return
      }
      finish(null, node)
    }
  })
}

// 完整取流链路：getParam → (WebSocket) → 频道预检 → 频道详情 → playUrl.hd
async function gdtvCaptureStream(chId, timeoutMs = GDTV_TIMEOUT_MS) {
  const initial = await gdtvRequestJson(GDTV_PARAM_URL)
  let node = initial && initial.node
  if (typeof node !== 'string' || !node || node.length > 8192) {
    throw new Error('广东台返回的初始化节点无效')
  }
  if (node.endsWith('-1')) {
    node = await gdtvReceiveNode(node, timeoutMs)
  }

  const url = `${GDTV_CHANNEL_API}/${chId}?tvChannelPk=${chId}&node=${Buffer.from(node, 'latin1').toString('base64')}`

  // 预检必须针对本次含 node 的完整频道 URL，否则下发的短令牌导致 HLS 403
  const preflight = await session.defaultSession.fetch(url, {
    method: 'OPTIONS',
    timeout: GDTV_TIMEOUT_MS,
    headers: {
      'Origin': GDTV_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': GDTV_PREFLIGHT_HEADERS,
    },
  })
  if (!preflight || !preflight.ok) {
    throw new Error(`广东台频道预检返回 HTTP ${preflight ? preflight.status : 'unknown'}`)
  }

  const detail = await gdtvRequestJson(url)
  if (Number(detail && detail.pk) !== Number(chId)) {
    throw new Error('广东台返回的频道不匹配')
  }
  let streams
  try { streams = JSON.parse(detail.playUrl) } catch (_) { throw new Error('广东台播放地址格式无效') }
  const stream = streams && (streams.hd || Object.values(streams).find(s => gdtvIsOfficialStreamUrl(s)))
  if (!gdtvIsOfficialStreamUrl(stream)) {
    throw new Error('官网没有返回有效的广东台 HLS 地址')
  }
  return stream
}

// 视频流解析线路（resolvePlayUrlCore → 走此函数）：返回 { url, headers }
async function resolveGdtvPlayUrl(pageUrl, ua) {
  const chId = gdtvExtractChannelId(pageUrl)
  if (!chId) return null
  try {
    const url = await gdtvCaptureStream(chId)
    return {
      url,
      headers: { 'User-Agent': ua || GDTV_UA, 'Referer': `${GDTV_ORIGIN}/` },
    }
  } catch (_) {
    return null
  }
}

// 网页嗅探（SITE_DETECTORS / generateFreshUrls 走此函数）：返回 URL 字符串数组
function generateGdtvUrls(pageUrl, metadata, sniffSession) {
  return new Promise((resolve) => {
    const results = []
    try {
      const md = metadata || {}
      const chId = md.channelId || md.id || gdtvExtractChannelId(pageUrl)
      if (!chId) return resolve(results)

      // 官网频道详情需签名 + 预检 + 会话节点，直接复用完整取流链路
      gdtvCaptureStream(chId).then(url => {
        if (url) {
          results.push(url)
          // 嗅探路径同样记录「流地址 → 站点元数据」，保证代理层 403 后能自动续签
          recordResolvedSiteMeta(url, { site: 'gdtv', pageUrl })
        }
      }).catch(() => {}).finally(() => {
        resolve([...new Set(results)])
      })
    } catch (_) {
      resolve(results)
    }
  })
}

// Site detector registry
const SITE_DETECTORS = [
  {
    name: 'gdtv',
    match: (url) => /gdtv\.cn/i.test(url),
    generate: generateGdtvUrls,
  },
  {
    name: 'bilibili',
    match: (url) => /bilibili\.com\/video\//i.test(url),
    generate: generateBilibiliUrls,
  },
  {
    name: 'cctv',
    match: (url) => /tv\.cctv\.com\/live\//i.test(url) || /cctv\.com\/live/i.test(url) || /yangshipin\.cn/i.test(url),
    generate: generateCctvUrls,
  },
  {
    name: 'iqilu',
    match: (url) => /v\.iqilu\.com/i.test(url),
    generate: generateIqiluUrls,
  },
  {
    name: 'lotustv',
    match: (url) => /lotustv\.mo/i.test(url),
    generate: generateGenericUrls,
  },
  {
    name: 'mgtv',
    match: (url) => /mgtv\.com/i.test(url),
    generate: generateGenericUrls,
  },
  {
    name: 'tv-station',
    match: (url) => /(gdtv|cztv|gxtv|wasu|7sefun|acgkkkk|hebrts|dbw|gzstv|fjtv|snrtv|nmtv|sxrtv|hnntv|jxntv|qtv\.com\.cn|live\.jstv|jstv\.com|kankanews)\./i.test(url) || /lxtv\./i.test(url),
    generate: generateGenericUrls,
  },
]

// Helper: fetch JSON from within the sniffer's session (preserves cookies/session)
// The referrerHost param allows overriding Referer for sites that require specific origin
// (e.g. Bilibili API requires Referer: https://www.bilibili.com/)
function fetchFromSession(sess, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const net = require(parsed.protocol === 'https:' ? 'https' : 'http')
    const referrerHost = opts.referrerHost || parsed.hostname
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': `${parsed.protocol}//${referrerHost}/`,
        'Origin': `${parsed.protocol}//${referrerHost}`,
        ...opts.headers
      },
      rejectUnauthorized: false,
      timeout: 10000,
    }

    // Use session cookies
    sess.cookies.get({ url }).then(cookies => {
      if (cookies && cookies.length > 0) {
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
        reqOptions.headers['Cookie'] = cookieStr
      }
    }).catch(() => {}).finally(() => {
      const req = net.request(reqOptions, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8')
            const data = JSON.parse(body)
            resolve(data)
          } catch (_) {
            resolve(null)
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })
  })
}

// ===== HTML regex extraction =====

function extractVideoUrlsFromHtml(html, baseUrl) {
  const found = []
  const seen = new Set()

  const patterns = [
    { regex: /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.m3u8[^\s"'<>\[\]{}|\\^`]*)/gi, prio: 1 },
    { regex: /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.mp4[^\s"'<>\[\]{}|\\^`]*)/gi, prio: 2 },
    { regex: /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.flv[^\s"'<>\[\]{}|\\^`]*)/gi, prio: 2 },
    { regex: /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.mpd[^\s"'<>\[\]{}|\\^`]*)/gi, prio: 3 },
    { regex: /(https?:\/\/[^\s"'<>\[\]{}|\\^`]+?\.ts[^\s"'<>\[\]{}|\\^`]*)/gi, prio: 4 },
    { regex: /(rtmp[ts]?:\/\/[^\s"'<>\[\]{}|\\^`]+)/gi, prio: 3 },
    { regex: /(rtsp:\/\/[^\s"'<>\[\]{}|\\^`]+)/gi, prio: 3 },
    { regex: /"url"\s*:\s*"(https?:\/\/[^"]*?(?:m3u8|mp4|flv|stream|live|play|hls)[^"]*)"/gi, prio: 5 },
    { regex: /'url'\s*:\s*'(https?:\/\/[^']*?(?:m3u8|mp4|flv|stream|live|play|hls)[^']*)'/gi, prio: 5 },
    { regex: /"src"\s*:\s*"(https?:\/\/[^"]*?(?:m3u8|mp4|flv|stream|live|play|hls)[^"]*)"/gi, prio: 5 },
    { regex: /"video_url"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /"stream_url"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /"play_url"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /"playurl"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /"file"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /"hls_url"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /"flv_url"\s*:\s*"(https?:\/\/[^"]+?)"/gi, prio: 5 },
    { regex: /[?&](?:url|src|video|play|stream|live|file)=((?:https?:)?\/\/[^&\s"'<>\[\]{}]+)/gi, prio: 6 },
    { regex: /atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/g, prio: 7 },
    { regex: /(thunder:\/\/[^\s"'<>]+)/gi, prio: 8 },
    { regex: /(magnet:\?xt=urn:btih:[^\s"'<>]+)/gi, prio: 8 },
    { regex: /var\s+\w+\s*=\s*["'](https?:\/\/[^"']+?(?:m3u8|mp4|flv|stream|live)[^"']*?)["']/gi, prio: 6 },
    { regex: /let\s+\w+\s*=\s*["'](https?:\/\/[^"']+?(?:m3u8|mp4|flv|stream|live)[^"']*?)["']/gi, prio: 6 },
    { regex: /const\s+\w+\s*=\s*["'](https?:\/\/[^"']+?(?:m3u8|mp4|flv|stream|live)[^"']*?)["']/gi, prio: 6 },
    { regex: /(https?:\/\/[^\s"'<>`]+?\/(?:player|embed|video|play|live)\/[^\s"'<>`]+)/gi, prio: 7 },
  ]

  for (const { regex } of patterns) {
    let match
    while ((match = regex.exec(html)) !== null) {
      let url = match[1] || match[0]
      url = url.replace(/[,;:!?)\]}>`\s]+$/, '').trim()
      if (url && url.length > 10 && !seen.has(url)) {
        seen.add(url)
        found.push(url)
      }
    }
  }

  // Decode base64 atob calls
  const b64Matches = html.matchAll(/atob\s*\(\s*["']([A-Za-z0-9+/=]{20,})["']\s*\)/g)
  for (const bm of b64Matches) {
    try {
      const decoded = Buffer.from(bm[1], 'base64').toString('utf8')
      if (/^https?:\/\//i.test(decoded) && !seen.has(decoded)) {
        seen.add(decoded)
        found.push(decoded)
      }
    } catch (_) {}
  }

  // 过滤静态资源：SPA 站点常把播放器 SDK 的 CSS/JS 放在 /player/、/live/ 等路径下，
  // 会被上面的路径正则误判成直播流（典型案例：芒果TV 的 tcplayer.min.css）。
  const STATIC_RESOURCE_RE = /\.(css|js|mjs|json|png|jpe?g|gif|svg|ico|bmp|webp|woff2?|ttf|otf|eot|map|html?|xml|txt)(\?|#|$)/i
  // 过滤「网页型」地址：/embed/、/player/ 等路径且不带媒体后缀的是播放器嵌入页，
  // 直接交给播放器必然失败（典型案例：澳门莲花卫视的 cloud.quklive.com/cloud/a/embed/xxx）。
  const EMBED_PAGE_RE = /\/\/(?:[^/]+\/)*(?:embed|player)\//i
  const MEDIA_SUFFIX_RE = /\.(m3u8|m3u|mp4|flv|mpd|ts|m2ts|mov|webm|mkv|m4v)(\?|#|$)/i
  const kept = found.filter(u => {
    if (STATIC_RESOURCE_RE.test(u)) return false
    if (EMBED_PAGE_RE.test(u) && !MEDIA_SUFFIX_RE.test(u)) return false
    return true
  })

  // Filter out the page URL itself (leaked by /video/ path patterns)
  if (baseUrl) {
    const baseClean = baseUrl.replace(/\/$/, '')
    return kept.filter(u => {
      const cleanU = u.replace(/\/$/, '')
      return cleanU !== baseClean && cleanU !== baseClean + '/'
    })
  }

  return kept
}

function guessFormatFromUrl(url) {
  const lower = url.split('?')[0].split('#')[0].toLowerCase()
  if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'm3u8'
  if (lower.endsWith('.flv')) return 'flv'
  if (lower.endsWith('.mp4') || lower.endsWith('.mov') || lower.endsWith('.webm') || lower.endsWith('.mkv')) return 'mp4'
  if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return 'ts'
  if (lower.endsWith('.mpd')) return 'mpd'
  if (lower.endsWith('.avi') || lower.endsWith('.wmv') || lower.endsWith('.m4v')) return 'mp4'
  if (/^rtmp[s]?:\/\//i.test(url)) return 'rtmp'
  if (/^rtsp:\/\//i.test(url)) return 'rtsp'
  if (/m3u8/i.test(url)) return 'm3u8'
  if (/mp4/i.test(url)) return 'mp4'
  if (/flv/i.test(url)) return 'flv'
  return 'unknown'
}

// ===== 流地址合法性硬性校验 =====
// 视频流解析模式严禁加载网页，因此解析器返回的地址必须是「可直接被播放器/FFmpeg 打开」的媒体流。
// 以下类别一律判定为不可播放，必须在返回给前端之前丢弃：
//   1) 静态资源（css/js/json/图片/字体/html）
//   2) 网页地址（path 以 / 结尾，或 /embed/、/player/ 等播放器嵌入页）
//   3) 业务接口地址（/api/ 路径且不带媒体后缀，典型如 JSON 频道列表接口）
// 注意：部分平台的直播流地址本身不带媒体后缀（如芒果TV 的 /nn_live/nn_x64/xxx），
// 因此这里只做「排除法」，不用「必须带后缀」的正向校验，避免误杀合法流。
const UNPLAYABLE_STATIC_RE = /\.(css|js|mjs|json|png|jpe?g|gif|svg|ico|bmp|webp|woff2?|ttf|otf|eot|map|html?|xml|txt)(\?|#|$)/i
const UNPLAYABLE_EMBED_RE = /\/\/(?:[^/]+\/)*(?:embed|player)\//i
const UNPLAYABLE_API_RE = /\/api\//i
const MEDIA_SUFFIX_TEST_RE = /\.(m3u8|m3u|mp4|flv|mpd|ts|m2ts|mov|webm|mkv|m4v)(\?|#|$)/i
const LOCAL_PROXY_TEST_RE = /^http:\/\/127\.0\.0\.1:\d+\//i

function isUnplayableStreamUrl(url) {
  if (!url || typeof url !== 'string') return true
  const trimmed = url.trim()
  if (trimmed.length < 8) return true
  // 本地代理入口是可信的内部地址
  if (LOCAL_PROXY_TEST_RE.test(trimmed)) return false
  // rtmp/rtsp 协议本身即为流协议
  if (/^(rtmp[s]?|rtsp):\/\//i.test(trimmed)) return false
  if (!/^https?:\/\//i.test(trimmed)) return true
  const hasMediaSuffix = MEDIA_SUFFIX_TEST_RE.test(trimmed)
  if (UNPLAYABLE_STATIC_RE.test(trimmed)) return true
  if (UNPLAYABLE_EMBED_RE.test(trimmed) && !hasMediaSuffix) return true
  if (UNPLAYABLE_API_RE.test(trimmed) && !hasMediaSuffix) return true
  try {
    const pathname = new URL(trimmed).pathname
    // 纯网页地址（path 以 / 结尾，且不含媒体后缀）
    if (!hasMediaSuffix && pathname.endsWith('/')) return true
  } catch (_) {
    return true
  }
  return false
}

// ===== Deep sniff =====

function deepSniffUrls(pageUrl) {
  return new Promise((resolve) => {
    const capturedUrls = []
    const extractedMetadata = { site: null }
    // 复用固定分区，避免每次嗅探都新建 in-memory session 造成内存累积（Electron 的 Session 无 close 方法）
    const partitionKey = 'deep-sniff'
    const sniffSession = session.fromPartition(partitionKey, { cache: false })

    // WebRequest interceptor
    const interceptor = (details, callback) => {
      const url = details.url
      if (url && !capturedUrls.find(c => c.url === url)) {
        capturedUrls.push({
          url,
          source: details.resourceType || 'network',
          timestamp: Date.now(),
        })
      }
      // Extract CCTV pid from API calls if DOM script missed it
      if (!extractedMetadata.pid && url) {
        try {
          // vdn.apps.cntv.cn/api/getHttpStream?pid=XXXX
          let m = url.match(/[?&]pid=([^&]+)/)
          if (m && m[1]) {
            if (!extractedMetadata.site) extractedMetadata.site = 'cctv'
            extractedMetadata.pid = m[1]
          }
          // api.cntv.cn/video/videoinfoByGuid?serviceId=tvcctv&guid=XXXX
          m = url.match(/[?&]guid=([^&]+)/)
          if (m && m[1] && /cntv\.cn/.test(url)) {
            if (!extractedMetadata.site) extractedMetadata.site = 'cctv'
            extractedMetadata.pid = extractedMetadata.pid || m[1]
          }
        } catch (_) {}
      }
      callback({})
    }
    sniffSession.webRequest.onBeforeRequest({ urls: videoUrlFilters }, interceptor)

    let resolved = false
    const finish = (extraUrls = [], metadata = {}) => {
      if (resolved) return
      resolved = true
      try {
        if (sniffWin && !sniffWin.isDestroyed()) sniffWin.close()
      } catch (_) {}
      // 移除本轮的 webRequest 拦截器，防止复用固定分区时监听器无限累积
      try { sniffSession.webRequest.onBeforeRequest(null) } catch (_) {}
      // Merge metadata from DOM extraction
      if (metadata.site) extractedMetadata.site = metadata.site
      if (metadata.bvid) extractedMetadata.bvid = metadata.bvid
      if (metadata.cid) extractedMetadata.cid = metadata.cid
      if (metadata.aid) extractedMetadata.aid = metadata.aid
      if (metadata.pid) extractedMetadata.pid = metadata.pid
      if (metadata.title) extractedMetadata.title = metadata.title
      if (metadata.pageUrl) extractedMetadata.pageUrl = metadata.pageUrl
      if (metadata.config) extractedMetadata.config = metadata.config
      if (metadata.channelId) extractedMetadata.channelId = metadata.channelId
      const allUrls = [...extraUrls.map(u => ({ url: u, source: 'dom', timestamp: Date.now() })), ...capturedUrls]
      resolve({ urls: allUrls, metadata: extractedMetadata, session: sniffSession })
    }

    const sniffWin = new BrowserWindow({
      width: 1280,
      height: 720,
      show: false,
      frame: false,
      webPreferences: {
        preload: STEALTH_PRELOAD,
        session: sniffSession,
        nodeIntegration: false,
        contextIsolation: false,  // preload runs in same world for stealth patches
        webSecurity: false,
        sandbox: true,
        javascript: true,
        images: true,
        plugins: true,
      },
    })

    sniffWin.webContents.on('did-finish-load', () => {
      sniffWin.webContents.executeJavaScript(DOM_EXTRACT_SCRIPT).then(result => {
        if (result && typeof result === 'string') {
          try {
            const parsed = JSON.parse(result)
            if (parsed.urls && Array.isArray(parsed.urls)) {
              if (parsed.metadata) Object.assign(extractedMetadata, parsed.metadata)
              finish(parsed.urls, parsed.metadata)
            }
          } catch (_) {
            // result might be direct URL array (old format)
            try {
              const arr = JSON.parse(result)
              if (Array.isArray(arr)) finish(arr)
            } catch (__) {}
          }
        }
      }).catch(() => {})
    })

    sniffWin.webContents.on('did-fail-load', (_e, _code, _desc) => {
      // Even on failure, we might have captured network URLs
    })

    sniffWin.loadURL(pageUrl, {
      userAgent: BROWSER_UA,
    }).catch(() => {})

    // Fallback timeout
    setTimeout(() => finish(), SNIFF_TIMEOUT)
  })
}

// ===== Generate fresh playable URLs for known sites =====
// Called AFTER deep sniff completes, uses the extracted metadata + sniffer session
// to call site APIs and get fresh (non-expiring) URLs

async function generateFreshUrls(pageUrl, metadata, sniffSession) {
  const results = []
  for (const detector of SITE_DETECTORS) {
    if (detector.match(pageUrl)) {
      try {
        const urls = await detector.generate(pageUrl, metadata, sniffSession)
        urls.forEach(u => { if (u && !results.includes(u)) results.push(u) })
      } catch (_) {}
    }
  }
  return results
}

// ===== URL format probing =====

function probeContentTypeFast(url, httpMods) {
  return new Promise((resolve) => {
    if (!/^https?:\/\//i.test(url)) {
      resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false })
      return
    }
    let parsed
    try { parsed = new URL(url) } catch (_) {
      resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false })
      return
    }
    const httpMod = parsed.protocol === 'https:' ? httpMods.https : httpMods.http
    const req = httpMod.request(parsed, {
      method: 'HEAD',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*' },
      rejectUnauthorized: false,
      timeout: 5000,
    }, res => {
      const status = res.statusCode || 200
      const ct = (res.headers['content-type'] || '').toLowerCase()
      const loc = (res.headers['location'] || '')
      res.destroy()
      if ([301, 302, 303, 307, 308].includes(status) && loc) {
        probeContentTypeFast(loc, httpMods).then(resolve)
        return
      }
      let format = guessFormatFromUrl(url)
      let isPlaylist = false
      let isFlv = false
      if (ct.includes('mpegurl') || ct.includes('m3u8')) { format = 'm3u8'; isPlaylist = true }
      else if (ct.includes('flv')) { format = 'flv'; isFlv = true }
      else if (ct.includes('mp2t') || ct.includes('mpeg')) { format = 'ts' }
      else if (ct.includes('mp4')) { format = 'mp4' }
      resolve({ format, contentType: ct, finalUrl: parsed.href, isPlaylist, isFlv })
    })
    req.on('error', () => resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false }))
    req.setTimeout(5000, () => { req.destroy(); resolve({ format: guessFormatFromUrl(url), contentType: '', finalUrl: url, isPlaylist: false, isFlv: false }) })
    req.end()
  })
}

module.exports = {
  directMediaPatterns,
  extractVideoUrlsFromHtml,
  deepSniffUrls,
  generateFreshUrls,
  resolvePlayUrl,
  inferSiteMetaFromUrl,
  isUnplayableStreamUrl,
  guessFormatFromUrl,
  probeContentTypeFast,
  clearPlayUrlCache,
  DOM_EXTRACT_SCRIPT,
}

// ===== Resolve playable URL at play-time =====
// Called when user clicks "play" on a sniff result that has siteMeta.
// Generates a FRESH URL right now (not stale from sniff phase).
// Uses session.defaultSession.fetch() which shares the app's browser cookies/network.

/**
 * Simple HTTPS JSON fetch as fallback (uses Node.js http module, not Electron session)
 */
function simpleHttpsFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const body = opts.body == null ? null : opts.body
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/json, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...opts.headers,
    }
    if (body != null && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = Buffer.byteLength(body)
    }
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers,
      rejectUnauthorized: false,
      timeout: 10000,
    }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, json: () => Promise.resolve(JSON.parse(d)), text: () => d }) }
        catch (_) { resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, json: () => Promise.reject(new Error('parse')), text: () => d }) }
      })
    })
    req.on('error', e => reject(e))
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    if (body != null) req.write(body)
    req.end()
  })
}

// ============================================================
// 无浏览器 HTTP 抓取器（视频流解析模式唯一网络出口）
// 视频流解析模式严禁加载网页、严禁使用浏览器网络栈，
// 所有解析请求统一走 Node.js 原生 http/https，返回对象兼容 fetch Response 的最小接口
// （ok / status / headers / text / arrayBuffer / json / buffer），可直接替换 session.fetch。
// ============================================================

const BROWSERLESS_UA = BROWSER_UA
const BROWSERLESS_MAX_REDIRECTS = 5
const BROWSERLESS_TIMEOUT = 15000

function browserlessFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (_) {
      reject(new Error('invalid url: ' + url))
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('unsupported protocol: ' + parsed.protocol))
      return
    }
    const rawBody = opts.body == null ? null : opts.body
    const body = rawBody == null ? null : (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    const method = (opts.method || 'GET').toUpperCase()
    const headers = Object.assign({
      'User-Agent': BROWSERLESS_UA,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, opts.headers || {})
    if (body != null) headers['Content-Length'] = body.length
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false,
      servername: parsed.hostname,
    }, (res) => {
      const status = res.statusCode || 0
      const location = res.headers['location']
      if ([301, 302, 303, 307, 308].includes(status) && location && (opts._redirects || 0) < BROWSERLESS_MAX_REDIRECTS) {
        res.resume()
        let nextUrl
        try { nextUrl = new URL(location, url).toString() } catch (_) { nextUrl = null }
        if (nextUrl) {
          resolve(browserlessFetch(nextUrl, Object.assign({}, opts, { _redirects: (opts._redirects || 0) + 1 })))
          return
        }
      }
      const chunks = []
      let stream = res
      const enc = String(res.headers['content-encoding'] || '').toLowerCase()
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip())
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())
      stream.on('data', (c) => chunks.push(Buffer.from(c)))
      stream.on('error', () => {})
      stream.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({
          ok: status >= 200 && status < 300,
          status,
          url,
          headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
          text: () => Promise.resolve(buf.toString('utf8')),
          arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          buffer: () => Promise.resolve(buf),
          json: () => new Promise((res2, rej2) => {
            try { res2(JSON.parse(buf.toString('utf8'))) } catch (e) { rej2(e) }
          }),
        })
      })
    })
    req.on('error', (e) => reject(e))
    req.setTimeout(opts.timeout || BROWSERLESS_TIMEOUT, () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    if (body != null) req.write(body)
    req.end()
  })
}

// 解析链路网络出口统一替换：
// 所有 resolvePlayUrl 解析器里的 session.defaultSession.fetch 一律走上面的 Node.js 原生 http，
// 不再经过 Chromium 网络栈，因此视频流解析模式既不加载网页也不依赖浏览器。
// fromPartition 仅保留给「网页嗅探」模式自建 webview 使用，与流解析无关。
const session = {
  fromPartition: (...args) => electronSession.fromPartition(...args),
  defaultSession: { fetch: browserlessFetch },
}

// ============================================================
// 央视频 (www.yangshipin.cn) 专有解析器
// 唯一合法参照：YangshipinParser.java 的 www.yangshipin.cn 解析逻辑，
// 且仅采用 IJK 模式实际使用的默认主路径——JCE 协议（jacc.ysp.cctv.cn）。
//   CAPI(ProtoBuf, 浏览器 UA) 获取 pid→channelId
//   → JCE 协议（jacc.ysp.cctv.cn）获取 m3u8
// 不参考 APK 端（TEA cKey / PLATFORM / device=iPhone），
// 也不参考 bkliveinfo 降级路径。
// ============================================================

const YSP_CAPI_URL = 'https://capi.yangshipin.cn/api/oms/pc/page/PG00000004'
const YSP_CAPI_UA = BROWSER_UA
const YSP_REFERER = 'https://live.cctv.cn/'
const YSP_CAPI_CACHE_TTL = 24 * 60 * 60 * 1000

// 播放地址缓存 5 分钟：命中缓存时完全不发起任何网络请求，避免重复解析消耗 CDN 的放行名额。
const YSP_PLAY_URL_CACHE_TTL = 5 * 60 * 1000

// JCE 协议常量（对齐 YangshipinParser.java 的 IJK 默认主路径）
const YSP_JCE_URL = 'https://jacc.ysp.cctv.cn'
const YSP_JCE_VER_NAME = '3.2.7.26212'
const YSP_JCE_VER_CODE = '302070'
const YSP_JCE_APP_ID = '1200013'
const YSP_JCE_QMF_APP_ID = 10012
const YSP_JCE_QMF_PLATFORM = 1
const YSP_JCE_BIZ_ID = 0
const YSP_JCE_CHAN_ID = '10070'
const YSP_JCE_CMD_TIMESHIFT = 25312
const YSP_JCE_DEVICE_MODEL = 'Pixel 6'
const YSP_JCE_DEAD_CACHE_TTL_MS = 30 * 60 * 1000

// ---- bkliveinfo 备用协议（对齐 cctv-view-main 的 YspCKeyProtocol）----
// 用于 JCE 稳定返回死域名（liverecord.video.cloud.cctv.com）的频道：
// CCTV-11/12/14/15/16/17、CCTV-16 4K、CCTV-4K 等。播放列表地址为一次性令牌，
// 每次解析都重新请求 bkliveinfo 换新地址。
const YSP_BK_URL = 'https://bkliveinfo.ysp.cctv.cn/'
const YSP_BK_PLATFORM = 4330403
const YSP_BK_APP_VERSION = 'V8.22.1035.3031'
const YSP_BK_UA = 'qqlive'
const YSP_BK_REFERER = 'https://live.cctv.cn/'
// bkliveinfo 播放列表地址为一次性令牌，短缓存避免返回已消费的旧地址。
const YSP_BK_PLAY_URL_CACHE_TTL = 30 * 1000
const YSP_BK_TEA_KEY = Buffer.from('59b2f7cf725ef43c34fdd7c123411ed3', 'hex')
const YSP_BK_GUARD_KEY = Buffer.from('110DBEC10C23E7D2E56A1CAD6914EF1B', 'hex')
const YSP_BK_CKEY_XOR = Buffer.from('842eed08f066e6ea48b4caa991ed6ff3', 'hex')
const YSP_BK_GUARD_XOR = Buffer.from('b3c953a06913ad4d', 'hex')
const YSP_BK_TEA_DELTA = 0x9e3779b9
const YSP_BK_TEA_ROUNDS = 16
// spvcode：与 cctv-view-main 一致（"H(30:1080,60:1080|30:1080,60:1080)" 的 base64）
const YSP_BK_SPVCODE = Buffer.from('H(30:1080,60:1080|30:1080,60:1080)').toString('base64')

// 内置 pid -> sid 兜底映射（来自 cctv-view-main ChannelManager.kt）。
// CAPI 接口对部分卫视频道（吉林/云南/甘肃/青海/宁夏/西藏等）不返回 sid，此处硬编码兜底。
const YSP_BUILTIN_SID = {
  '600001859': '2024078201', // CCTV-1 综合
  '600001800': '2024075401', // CCTV-2 财经
  '600001801': '2024068501', // CCTV-3 综艺
  '600001814': '2029797101', // CCTV-4 中文国际
  '600001818': '2024078401', // CCTV-5 体育
  '600001817': '2024078001', // CCTV-5+ 体育赛事
  '600108442': '2013693901', // CCTV-6 电影
  '600004092': '2024072001', // CCTV-7 国防军事
  '600001803': '2029793001', // CCTV-8 电视剧
  '600004078': '2024078601', // CCTV-9 纪录
  '600001805': '2024078701', // CCTV-10 科教
  '600001806': '2027248701', // CCTV-11 戏曲
  '600001807': '2027248801', // CCTV-12 社会与法
  '600001811': '2029797201', // CCTV-13 新闻
  '600001809': '2027248901', // CCTV-14 少儿
  '600001815': '2027249001', // CCTV-15 音乐
  '600098637': '2027249101', // CCTV-16 奥林匹克-HD
  '600099502': '2027249301', // CCTV-16 奥林匹克-4K
  '600001810': '2027249401', // CCTV-17 农业农村
  '600002264': '2029810301', // CCTV-4K
  '600156816': '2026774101', // CCTV-8K
  '600014550': '2024181701', // CGTN
  '600190402': '2025561303', // 云南卫视
  '600002309': '2024052703', // 北京卫视
  '600002521': '2024171103', // 江苏卫视
  '600002483': '2024054503', // 东方卫视
  '600002520': '2024054703', // 浙江卫视
  '600002475': '2024054803', // 湖南卫视
  '600002508': '2024171203', // 湖北卫视
  '600002485': '2024060903', // 广东卫视
  '600002509': '2024060703', // 广西卫视
  '600002498': '2029797003', // 黑龙江卫视
  '600002506': '2024055603', // 海南卫视
  '600002531': '2024061103', // 重庆卫视
  '600002481': '2024061303', // 深圳卫视
  '600002516': '2024061403', // 四川卫视
  '600002525': '2029797303', // 河南卫视
  '600002484': '2024061503', // 福建/东南卫视
  '600002490': '2024061603', // 贵州卫视
  '600002503': '2024061703', // 江西卫视
  '600002505': '2024171303', // 辽宁卫视
  '600002532': '2024171403', // 安徽卫视
  '600002493': '2024171503', // 河北卫视
  '600002513': '2029787903', // 山东卫视
  '600152137': '2019927003', // 天津卫视
  '600190405': '2025561503', // 吉林卫视
  '600190400': '2029795103', // 陕西卫视
  '600190408': '2025561703', // 甘肃卫视
  '600190737': '2025608503', // 宁夏卫视
  '600190401': '2025561203', // 内蒙古卫视
  '600190407': '2025560803', // 山西卫视
  '600190406': '2025559103', // 青海卫视
  '600190403': '2025558003', // 西藏卫视
  '600152138': '2019927403', // 新疆卫视
  '600171827': '2022823801', // 教育电视台
}

// JCE 稳定返回死域名、必须走 bkliveinfo 的频道 pid 名单（对应 FORCE_BK）。
const YSP_FORCE_BK_PIDS = new Set([
  '600001806', // CCTV-11
  '600001807', // CCTV-12
  '600001809', // CCTV-14
  '600001815', // CCTV-15
  '600098637', // CCTV-16
  '600001810', // CCTV-17
  '600099502', // CCTV-16 4K
  '600002264', // CCTV-4K
])

let yspPidToChannelId = null
let yspCapiCacheTimestamp = 0
let yspJceGuid = null
let yspPlayUrlCache = new Map() // pid -> { url, headers, expireAt }
let yspJceDeadCache = new Map() // pid -> 失效截止时间戳（命中 dead CDN 后 30 分钟内不再重试）

// ---- JCE 协议编码（对齐 YangshipinParser.java 的 JceWriter / wrapJcePacket）----

class YspJceWriter {
  constructor() {
    this.chunks = []
  }
  writeByte(b) {
    this.chunks.push(Buffer.from([b & 0xff]))
  }
  writeHead(typ, tag) {
    if (tag < 15) {
      this.writeByte(((tag & 0xf) << 4) | (typ & 0xf))
    } else {
      this.writeByte(0xf0 | (typ & 0xf))
      this.writeByte(tag)
    }
  }
  writeByteVal(v, tag) {
    if (v === 0) this.writeHead(12, tag)
    else { this.writeHead(0, tag); this.writeByte(v) }
  }
  writeShortVal(v, tag) {
    if (v >= -128 && v <= 127) this.writeByteVal(v, tag)
    else { this.writeHead(1, tag); this.writeByte((v >> 8) & 0xff); this.writeByte(v & 0xff) }
  }
  writeIntVal(v, tag) {
    if (v >= -32768 && v <= 32767) this.writeShortVal(v, tag)
    else { this.writeHead(2, tag); this.writeIntBE(v) }
  }
  writeLongVal(v, tag) {
    if (v >= -2147483648 && v <= 2147483647) this.writeIntVal(v, tag)
    else { this.writeHead(3, tag); this.writeInt64BE(v) }
  }
  writeStringVal(s, tag) {
    if (s == null) return
    const data = Buffer.from(String(s), 'utf8')
    if (data.length > 255) {
      this.writeHead(7, tag)
      this.writeIntBE(data.length)
      this.chunks.push(data)
    } else {
      this.writeHead(6, tag)
      this.writeByte(data.length)
      this.chunks.push(data)
    }
  }
  writeBytesVal(data, tag) {
    this.writeHead(13, tag)
    this.writeHead(0, 0)
    this.writeIntVal(data.length, 0)
    this.chunks.push(data)
  }
  writeStructBegin(tag) { this.writeHead(10, tag) }
  writeStructEnd() { this.writeHead(11, 0) }
  writeFloatVal(v, tag) {
    this.writeHead(4, tag)
    const b = Buffer.alloc(4)
    b.writeFloatBE(v, 0)
    this.chunks.push(b)
  }
  writeDoubleVal(v, tag) {
    this.writeHead(5, tag)
    const b = Buffer.alloc(8)
    b.writeDoubleBE(v, 0)
    this.chunks.push(b)
  }
  writeIntBE(v) {
    const b = Buffer.alloc(4)
    b.writeInt32BE(v, 0)
    this.chunks.push(b)
  }
  writeInt64BE(v) {
    const b = Buffer.alloc(8)
    b.writeBigInt64BE(BigInt(v), 0)
    this.chunks.push(b)
  }
  toBytes() {
    return Buffer.concat(this.chunks)
  }
}

function yspGetJceGuid() {
  if (yspJceGuid) return yspJceGuid
  const chars = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 32; i++) s += chars[crypto.randomInt(16)]
  yspJceGuid = s
  return s
}

function yspBuildQua(w) {
  w.writeStringVal(YSP_JCE_VER_NAME, 0)
  w.writeStringVal(YSP_JCE_VER_CODE, 1)
  w.writeIntVal(1080, 2)
  w.writeIntVal(2400, 3)
  w.writeIntVal(3, 4)
  w.writeStringVal('12', 5)
  w.writeIntVal(1, 6)
  w.writeIntVal(1, 7)
  w.writeIntVal(420, 8)
  w.writeStringVal(YSP_JCE_CHAN_ID, 9)
  for (let i = 10; i <= 14; i++) w.writeStringVal('', i)
  w.writeStructBegin(15)
  w.writeIntVal(0, 0)
  w.writeByteVal(0, 1)
  w.writeStringVal('', 2)
  w.writeStructEnd()
  w.writeStringVal('', 16)
  w.writeStringVal('', 17)
  w.writeStringVal('', 18)
  w.writeStructBegin(19)
  w.writeIntVal(0, 0)
  w.writeFloatVal(0, 1)
  w.writeFloatVal(0, 2)
  w.writeLongVal(0, 3)
  w.writeStructEnd()
  const guid = yspGetJceGuid()
  w.writeStringVal(guid.substring(0, 16), 20)
  w.writeStringVal(YSP_JCE_DEVICE_MODEL, 21)
  w.writeIntVal(1, 22)
  for (let i = 23; i <= 26; i++) w.writeIntVal(0, i)
  w.writeStringVal('', 27)
  w.writeStringVal('', 28)
  w.writeStringVal(guid, 29)
}

function yspBuildJceHead(w, cmd, reqid) {
  w.writeIntVal(reqid, 0)
  w.writeIntVal(cmd, 1)
  w.writeStructBegin(2)
  yspBuildQua(w)
  w.writeStructEnd()
  w.writeStringVal(YSP_JCE_APP_ID, 3)
  w.writeStringVal(yspGetJceGuid(), 4)
  w.writeHead(9, 5)
  w.writeIntVal(0, 0)
  w.writeStructBegin(6)
  w.writeStructEnd()
  w.writeHead(9, 7)
  w.writeIntVal(0, 0)
  w.writeIntVal(0, 8)
  w.writeIntVal(0, 9)
  w.writeIntVal(0, 10)
}

function yspWrapJcePacket(cmd, body, reqid) {
  const w = new YspJceWriter()
  w.writeStructBegin(0)
  yspBuildJceHead(w, cmd, reqid)
  w.writeStructEnd()
  w.writeBytesVal(body, 1)
  const reqcmd = w.toBytes()

  const inner = []
  inner.push(Buffer.from([0x26])) // '&'
  const innerLenBuf = Buffer.alloc(4)
  innerLenBuf.writeUInt32BE(reqcmd.length + 17, 0)
  inner.push(innerLenBuf)
  inner.push(Buffer.from([0x01]))
  inner.push(Buffer.alloc(10))
  inner.push(reqcmd)
  inner.push(Buffer.from([0x28])) // '('
  const innerBytes = Buffer.concat(inner)

  const comp = zlib.gzipSync(innerBytes)

  const out = []
  out.push(Buffer.from([0x13]))
  out.push(Buffer.alloc(4)) // 总长度占位，最后回填
  out.push(Buffer.from([0x00, 0x02]))
  out.push(Buffer.from([0xff, 0x01])) // 65281
  out.push(Buffer.from([(cmd >> 8) & 0xff, cmd & 0xff]))
  out.push(Buffer.from([0x00, 0x00]))

  const reqidBuf = Buffer.alloc(8)
  reqidBuf.writeBigInt64BE(BigInt(reqid), 0)
  out.push(reqidBuf)

  const b531 = Buffer.alloc(4)
  b531.writeInt32BE(531, 0)
  out.push(b531)

  const qmfBuf = Buffer.alloc(4)
  qmfBuf.writeInt32BE(YSP_JCE_QMF_APP_ID, 0)
  out.push(qmfBuf)

  const bizBuf = Buffer.alloc(8)
  bizBuf.writeBigInt64BE(BigInt(YSP_JCE_BIZ_ID), 0)
  out.push(bizBuf)

  const guidBytes = Buffer.from(yspGetJceGuid(), 'utf8')
  const guidField = Buffer.alloc(32)
  guidBytes.copy(guidField, 0, 0, Math.min(32, guidBytes.length))
  out.push(guidField)

  out.push(Buffer.from([YSP_JCE_QMF_PLATFORM & 0xff]))

  const verBuf = Buffer.alloc(4)
  verBuf.writeInt32BE(parseInt(YSP_JCE_VER_CODE, 10), 0)
  out.push(verBuf)

  out.push(Buffer.alloc(6))
  out.push(Buffer.from([0x00]))
  out.push(Buffer.from([0x00, 0x00]))
  out.push(Buffer.from([0x00, 0x00]))

  const innerLenField = Buffer.alloc(4)
  innerLenField.writeInt32BE(innerBytes.length, 0)
  out.push(innerLenField)

  out.push(comp)
  out.push(Buffer.from([0x03]))

  const result = Buffer.concat(out)
  const totalLen = result.length
  result[1] = (totalLen >> 24) & 0xff
  result[2] = (totalLen >> 16) & 0xff
  result[3] = (totalLen >> 8) & 0xff
  result[4] = totalLen & 0xff
  return result
}

// 简易 ProtoBuf 解析器（仅解 tag=2 嵌套/字符串 + tag=0 varint），与网页版 capi 返回结构一致
function yspParseProtobuf(raw, depth) {
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  const result = {}
  let offset = 0

  function readVarint() {
    let value = 0
    let shift = 0
    while (offset < data.length) {
      const b = data[offset++]
      value |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    return value >>> 0
  }

  while (offset < data.length) {
    const tag = readVarint()
    const fid = tag >>> 3
    const wire = tag & 0x07
    let val = null

    if (wire === 0) {
      val = readVarint()
    } else if (wire === 2) {
      const length = readVarint()
      const sub = data.subarray(offset, offset + length)
      offset += length
      if (depth < 5) {
        try {
          const text = sub.toString('utf8')
          let hasCtrl = false
          for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i)
            if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) { hasCtrl = true; break }
          }
          if (hasCtrl) {
            val = yspParseProtobuf(sub, depth + 1)
          } else {
            val = text
          }
        } catch (_) {
          val = sub
        }
      } else {
        val = sub
      }
    } else if (wire === 1) {
      offset += 8
      continue
    } else if (wire === 5) {
      offset += 4
      continue
    } else {
      offset++
      continue
    }

    const existing = result[fid]
    if (existing === undefined) {
      result[fid] = val
    } else if (Array.isArray(existing)) {
      existing.push(val)
    } else {
      result[fid] = [existing, val]
    }
  }
  return result
}

function yspToInt(v) {
  if (typeof v === 'number') return v
  if (v == null) return 0
  const n = Number(v)
  return Number.isNaN(n) ? 0 : n
}

function yspToString(v) {
  if (v == null) return null
  if (typeof v === 'string') return v
  if (Buffer.isBuffer(v)) return v.toString('utf8')
  return String(v)
}

async function yspFetchCapiChannelList() {
  const now = Date.now()
  if (yspPidToChannelId && (now - yspCapiCacheTimestamp) < YSP_CAPI_CACHE_TTL) return

  const map = {}
  try {
    const capiUrl = `${YSP_CAPI_URL}?t=${now}`
    const resp = await session.defaultSession.fetch(capiUrl, {
      headers: {
        'User-Agent': YSP_CAPI_UA,
        'Referer': 'https://www.yangshipin.cn/',
        'yspappid': '519748109',
        'platform': '109',
        'app-platform': 'pc',
        'app-version': '1.0.0',
      },
    })
    if (!resp.ok) return

    const buf = Buffer.from(await resp.arrayBuffer())
    const root = yspParseProtobuf(buf, 0)
    const retCode = yspToInt(root[1])
    if (retCode !== 200) return

    const page = root[2]
    if (!page || typeof page !== 'object' || Array.isArray(page)) return
    const modules = page[2]
    if (!modules || typeof modules !== 'object' || Array.isArray(modules)) return

    let chList = modules[15]
    if (chList == null) return
    if (!Array.isArray(chList)) chList = [chList]

    for (const chObj of chList) {
      if (!chObj || typeof chObj !== 'object' || Array.isArray(chObj)) continue
      const pid = yspToString(chObj[4])
      const cid = yspToString(chObj[6])
      if (pid && cid) map[pid] = cid
    }

    yspPidToChannelId = map
    yspCapiCacheTimestamp = now
  } catch (_) {
    /* ignore */
  }
}

// ---- JCE 协议解码（对齐 YangshipinParser.java 的 JceReader / unwrapJceResponse）----

class YspJceReader {
  constructor(data, off, end) {
    this.data = data
    this.p = off
    this.end = end
  }
  hasMore() { return this.p < this.end }
  u8() { return this.data[this.p++] & 0xff }
  head() {
    const b = this.u8()
    let typ = b & 0xf
    let tag = (b >> 4) & 0xf
    if (tag === 15) tag = this.u8()
    return { typ, tag }
  }
  readInt() {
    const v = this.data.readInt32BE(this.p)
    this.p += 4
    return v
  }
  readLong() {
    const v = this.data.readBigInt64BE(this.p)
    this.p += 8
    return v
  }
  decodeInt() {
    const h = this.head()
    if (h.typ === 0) return this.u8()
    if (h.typ === 1) { const v = (this.data[this.p] << 8) | this.data[this.p + 1]; this.p += 2; return v }
    if (h.typ === 2) return this.readInt()
    if (h.typ === 12) return 0
    return 0
  }
  valueForType(t) {
    switch (t) {
      case 0: return this.u8()
      case 1: { const v = (this.data[this.p] << 8) | this.data[this.p + 1]; this.p += 2; return v }
      case 2: return this.readInt()
      case 3: return this.readLong()
      case 4: { this.p += 4; return null }
      case 5: { this.p += 8; return null }
      case 6: { const n = this.u8(); return this.safeString(n) }
      case 7: { const n = this.readInt(); return this.safeString(n) }
      case 8: return this.readMap()
      case 9: return this.readList()
      case 10: return this.readStruct()
      case 11: return null
      case 12: return 0
      case 13: {
        this.head()
        const count = this.decodeInt()
        const raw = this.data.subarray(this.p, this.p + count)
        this.p += count
        return raw
      }
      default: return null
    }
  }
  fieldValue() {
    const h = this.head()
    return this.valueForType(h.typ)
  }
  safeString(len) {
    const s = this.data.toString('utf8', this.p, this.p + len)
    this.p += len
    return s
  }
  readStruct() {
    const m = {}
    while (this.hasMore()) {
      const h = this.head()
      if (h.typ === 11) break
      m[h.tag] = this.valueForType(h.typ)
    }
    return m
  }
  readMap() {
    const n = this.decodeInt()
    const m = new Map()
    for (let i = 0; i < n && this.hasMore(); i++) {
      const k = this.fieldValue()
      const v = this.fieldValue()
      m.set(k, v)
    }
    return m
  }
  readList() {
    const n = this.decodeInt()
    const list = []
    for (let i = 0; i < n && this.hasMore(); i++) list.push(this.fieldValue())
    return list
  }
}

function yspUnwrapJceResponse(data) {
  if (data.length < 90 || data[0] !== 0x13) return null
  const flags = (((data[21] & 0xff) << 24) | ((data[22] & 0xff) << 16) | ((data[23] & 0xff) << 8) | (data[24] & 0xff)) >>> 0
  const payloadLen = data.length - 90
  let payload
  if (flags & 2) {
    payload = zlib.gunzipSync(data.subarray(89, 89 + payloadLen))
  } else {
    payload = data.subarray(89, 89 + payloadLen)
  }
  if (payload.length < 17 || payload[0] !== 0x26 || payload[payload.length - 1] !== 0x28) return null
  const r = new YspJceReader(payload, 16, payload.length - 1)
  const rc = r.readStruct()
  return rc[1] || null
}

class YspDeadHostError extends Error {}

// 主路径：JCE 协议（jacc.ysp.cctv.cn），IJK 模式实际使用的默认解析逻辑。
// 响应 body 为 JCE struct：0=errCode(int)、1=errMsg(string)、2=m3u8Url(string)。
async function yspJceTimeshiftUrl(pid, sid) {
  const bodyW = new YspJceWriter()
  bodyW.writeStringVal(pid, 0)
  bodyW.writeStringVal(sid, 1)
  const nowSec = Math.floor(Date.now() / 1000)
  bodyW.writeLongVal(nowSec - 300, 2)
  bodyW.writeLongVal(nowSec, 3)
  bodyW.writeStringVal('fhd', 4)
  const body = bodyW.toBytes()

  const reqid = Date.now() & 0x7fffffff
  const packet = yspWrapJcePacket(YSP_JCE_CMD_TIMESHIFT, body, reqid)

  const resp = await session.defaultSession.fetch(YSP_JCE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: packet,
  })
  if (!resp || resp.status !== 200) throw new Error('JCE HTTP ' + (resp ? resp.status : 'error'))

  const respBody = yspUnwrapJceResponse(await resp.buffer())
  if (!respBody || respBody.length === 0) throw new Error('JCE empty response')

  const r = new YspJceReader(respBody, 0, respBody.length)
  const bodyMap = r.readStruct()
  const errCode = typeof bodyMap[0] === 'number' ? bodyMap[0] : 0
  if (errCode !== 0) {
    const errMsg = typeof bodyMap[1] === 'string' ? bodyMap[1] : ''
    throw new Error('JCE errCode=' + errCode + ' ' + errMsg)
  }
  const m3u8Url = bodyMap[2]
  if (!m3u8Url || typeof m3u8Url !== 'string' || m3u8Url.length === 0) {
    throw new Error('JCE empty m3u8')
  }
  if (m3u8Url.includes('liverecord.video.cloud.cctv.com')) {
    throw new YspDeadHostError('JCE dead CDN host')
  }
  return m3u8Url
}

// ============================================================
// bkliveinfo 备用协议（对齐 cctv-view-main YspCKeyProtocol）
// TEA 加密生成 cKey 票据，请求 bkliveinfo.ysp.cctv.cn 换取明文 HLS 播放地址。
// 播放列表地址为一次性令牌，每次解析都重新请求换新。
// ============================================================

function yspBe32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0, 0)
  return b
}

function yspLpStr(s) {
  const d = Buffer.from(String(s), 'utf8')
  const out = Buffer.alloc(2 + d.length)
  out.writeUInt16BE(d.length, 0)
  d.copy(out, 2)
  return out
}

function yspLpBytes(b) {
  const out = Buffer.alloc(2 + b.length)
  out.writeUInt16BE(b.length, 0)
  b.copy(out, 2)
  return out
}

function yspTail5(s) {
  if (s == null || s.length < 5) return ''
  return s.slice(-5)
}

function yspXor(buf, mask) {
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ mask[i % mask.length]
  return out
}

function yspHexUpper(buf) {
  return buf.toString('hex').toUpperCase()
}

function yspB64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '_').replace(/\//g, '-').replace(/=+$/, '')
}

function yspCksum(buf) {
  let v = 0
  for (let i = 0; i < buf.length; i++) {
    v = (0x83 * v + buf[i]) & 0x7fffffff
  }
  return v >>> 0
}

// TEA 分组加密（16 轮，delta=0x9E3779B9）
function yspTeaBlock(block, key) {
  let y = block.readUInt32BE(0)
  let z = block.readUInt32BE(4)
  const k0 = key.readUInt32BE(0)
  const k1 = key.readUInt32BE(4)
  const k2 = key.readUInt32BE(8)
  const k3 = key.readUInt32BE(12)
  let s = 0
  for (let i = 0; i < YSP_BK_TEA_ROUNDS; i++) {
    s = (s + YSP_BK_TEA_DELTA) >>> 0
    const a = ((z << 4) + k0) >>> 0
    const b = (z + s) >>> 0
    const c = ((z >>> 5) + k1) >>> 0
    y = (y + (a ^ b ^ c)) >>> 0
    const d = ((y << 4) + k2) >>> 0
    const e = (y + s) >>> 0
    const f = ((y >>> 5) + k3) >>> 0
    z = (z + (d ^ e ^ f)) >>> 0
  }
  const out = Buffer.alloc(8)
  out.writeUInt32BE(y, 0)
  out.writeUInt32BE(z, 4)
  return out
}

// TEA/CBC 风格分组加密（含随机填充 + 末尾 7 字节零）
function yspTeaPkt(data, key) {
  const padLen = (8 - ((data.length + 10) % 8)) % 8
  const plain = Buffer.alloc(1 + padLen + 2 + data.length + 7)
  const rnd = crypto.randomBytes(padLen + 9)
  plain[0] = (rnd[0] & 0xf8) | padLen
  rnd.copy(plain, 1, 1, 1 + padLen)
  rnd.copy(plain, 1 + padLen, padLen + 1, padLen + 3)
  data.copy(plain, 1 + padLen + 2)

  const out = Buffer.alloc(plain.length)
  let prevPlain = Buffer.alloc(8)
  let prevCipher = Buffer.alloc(8)
  for (let off = 0; off < plain.length; off += 8) {
    const src = plain.subarray(off, off + 8)
    const mixed = Buffer.alloc(8)
    for (let i = 0; i < 8; i++) mixed[i] = src[i] ^ prevCipher[i]
    const enc = yspTeaBlock(mixed, key)
    for (let i = 0; i < 8; i++) out[off + i] = enc[i] ^ prevPlain[i]
    prevPlain = mixed
    prevCipher = enc
  }
  return out
}

function yspCkGuard(ts, guid) {
  const body = Buffer.concat([
    yspBe32(ts),
    yspLpStr(yspTail5(guid)),
    yspLpStr(yspTail5('null')),
    yspLpStr(yspTail5('null')),
    yspLpStr('-1'),
  ])
  const plain = yspLpBytes(body)
  let enc = yspTeaPkt(plain, YSP_BK_GUARD_KEY)
  enc = Buffer.concat([enc, yspBe32(yspCksum(plain))])
  enc = yspXor(enc, YSP_BK_GUARD_XOR)
  return yspHexUpper(enc)
}

function yspBuildCkPacket(channelId, ts, guid, guard, uid) {
  const body = Buffer.concat([
    Buffer.from('0000004200000004000004d2', 'hex'),
    yspBe32(YSP_BK_PLATFORM),
    yspBe32(0),
    yspBe32(ts),
    yspLpStr('dcgh'),
    yspLpStr('_zj1A5Gh6QYcxWjIUGos2w=='),
    yspLpStr(YSP_BK_APP_VERSION),
    yspLpStr(channelId),
    yspLpStr(guid),
    yspBe32(1),
    yspBe32(1),
    yspLpStr(uid),
    yspLpStr('nil'),
    yspLpStr('57eab0c4-2c58-44c6-8ae9-dd2757525dc5'),
    yspLpStr('nil'),
    yspLpStr('v0.1.000'),
    yspLpStr('com.cctv.yangshipin.app.iphone'),
    yspLpStr(String(YSP_BK_PLATFORM)),
    yspLpStr('ex_json_bus'),
    yspLpStr('ex_json_vs'),
    yspLpStr(guard),
  ])

  const packet = Buffer.alloc(2 + body.length)
  packet.writeUInt16BE(body.length, 0)
  body.copy(packet, 2)
  packet.writeUInt32BE(yspCksum(packet) >>> 0, 18)
  return packet
}

function yspCreateCKey(channelId) {
  const ts = Math.floor(Date.now() / 1000)
  const hexChars = '0123456789abcdef'
  let guid = ''
  for (let i = 0; i < 16; i++) guid += hexChars[crypto.randomInt(16)]
  const guard = yspCkGuard(ts, guid)
  let uid = ''
  for (let i = 0; i < 4; i++) uid += hexChars[crypto.randomInt(16)]
  uid = uid.toUpperCase()

  const packet = yspBuildCkPacket(channelId, ts, guid, guard, uid)
  let enc = yspTeaPkt(packet, YSP_BK_TEA_KEY)
  enc = Buffer.concat([enc, yspBe32(yspCksum(packet))])
  enc = yspXor(enc, YSP_BK_CKEY_XOR)
  const cKey = '--01' + yspB64Url(enc)

  const upperChars = '0123456789ABCDEF'
  let flowId = ''
  for (let i = 0; i < 32; i++) flowId += upperChars[crypto.randomInt(16)]
  flowId += '_' + YSP_BK_PLATFORM

  return { cKey, guid, ts, flowId }
}

// 请求 bkliveinfo，返回 { url, headers }（headers 含 Referer + UID）。
async function yspBkResolveUrl(pid, channelId, defn) {
  defn = defn || 'fhd'
  const t = yspCreateCKey(channelId)
  const params = {
    atime: '120',
    livepid: pid,
    cnlid: channelId,
    appVer: YSP_BK_APP_VERSION,
    app_version: '300090',
    caplv: '1',
    cmd: '2',
    defn: defn,
    device: 'iPhone',
    encryptVer: '4.2',
    getpreviewinfo: '0',
    hevclv: '0',
    lang: 'zh-Hans_CN',
    livequeue: '0',
    logintype: '1',
    nettype: '1',
    newnettype: '1',
    newplatform: String(YSP_BK_PLATFORM),
    platform: String(YSP_BK_PLATFORM),
    sdtfrom: 'v3021',
    spacode: '23',
    spaudio: '1',
    spdemuxer: '6',
    spdrm: '2',
    spdynamicrange: '1',
    spflv: '1',
    spflvaudio: '1',
    sphdrfps: '60',
    sphttps: '1',
    spvcode: YSP_BK_SPVCODE,
    spvideo: '4',
    stream: '1',
    system: '1',
    sysver: 'ios18.2.1',
    uhd_flag: '0',
    cKey: t.cKey,
    guid: t.guid,
    fntick: String(t.ts),
    flowid: t.flowId,
    playbacktime: '0',
  }

  const qs = Object.keys(params)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&')
  const url = YSP_BK_URL + '?' + qs

  const resp = await session.defaultSession.fetch(url, {
    headers: {
      'User-Agent': YSP_BK_UA,
      'Accept': 'application/json',
      'Referer': YSP_BK_REFERER,
    },
  })
  if (!resp || resp.status !== 200) throw new Error('bkliveinfo HTTP ' + (resp ? resp.status : 'error'))

  let json
  try {
    json = await resp.json()
  } catch (_) {
    throw new Error('bkliveinfo invalid JSON')
  }

  const iret = Number(json.iretcode)
  if (iret !== 0) {
    throw new Error('bkliveinfo iretcode=' + iret + ' errinfo=' + (json.errinfo || ''))
  }

  const urls = []
  if (json.playurl) urls.push(String(json.playurl))
  const backups = json.backurl_list || json.backurlList || json.backurl
  if (Array.isArray(backups)) {
    for (const it of backups) {
      if (typeof it === 'string') urls.push(it)
      else if (it && typeof it === 'object') urls.push(it.url || it.playurl || '')
    }
  } else if (typeof backups === 'string') {
    for (const u of backups.split(/[;,]/)) if (u.trim()) urls.push(u.trim())
  }

  const usable = [...new Set(urls)].filter((u) => u && u.includes('.cctv.'))
  if (usable.length === 0) throw new Error('bkliveinfo no usable playurl')

  const headers = { Referer: YSP_BK_REFERER }
  const hh = json.http_header || {}
  if (hh && hh.UID) headers.UID = String(hh.UID)

  return { url: usable[0], headers }
}

async function resolveYangshipinPlayUrl(pid, forceRefresh) {
  if (!pid) return null
  // 强制刷新：一次性 token 已消费/过期后重新签发，必须清掉播放地址缓存与死域名缓存，
  // 否则会命中旧的失效地址（央视频 CDN 对已消费 token 返回 403 / 缓冲空洞）。
  if (forceRefresh) clearPlayUrlCache()
  await yspFetchCapiChannelList()
  // CAPI 动态 sid 优先；CAPI 对部分卫视频道不返回 sid，用内置映射兜底。
  let channelId = yspPidToChannelId ? yspPidToChannelId[pid] : null
  if (!channelId) channelId = YSP_BUILTIN_SID[pid] || null
  if (!channelId) return null

  const now = Date.now()

  // 优先命中播放地址缓存，命中后零网络请求。
  const cached = yspPlayUrlCache.get(pid)
  if (cached && now < cached.expireAt) {
    return { url: cached.url, headers: { ...cached.headers } }
  }

  const cacheResult = (url, headers, ttl) => {
    yspPlayUrlCache.set(pid, { url, headers, expireAt: Date.now() + (ttl || YSP_PLAY_URL_CACHE_TTL) })
    return { url, headers: { ...headers } }
  }

  // JCE 稳定返回死域名的频道（CCTV-11/12/14/15/16/17、4K 等）直接走 bkliveinfo 备用协议。
  if (YSP_FORCE_BK_PIDS.has(pid)) {
    const r = await yspBkResolveUrl(pid, channelId)
    return cacheResult(r.url, r.headers, YSP_BK_PLAY_URL_CACHE_TTL)
  }

  // 主路径：JCE 协议。命中死域名时切换 bkliveinfo 备用协议。
  const deadUntil = yspJceDeadCache.get(pid)
  if (deadUntil == null || now > deadUntil) {
    try {
      const m3u8Url = await yspJceTimeshiftUrl(pid, channelId)
      yspJceDeadCache.delete(pid)
      return cacheResult(m3u8Url, { Referer: YSP_REFERER })
    } catch (e) {
      if (e instanceof YspDeadHostError) {
        yspJceDeadCache.set(pid, now + YSP_JCE_DEAD_CACHE_TTL_MS)
        try {
          const r = await yspBkResolveUrl(pid, channelId)
          return cacheResult(r.url, r.headers, YSP_BK_PLAY_URL_CACHE_TTL)
        } catch (bkErr) {
          console.warn(`[sniffer] yangshipin bkliveinfo 回退失败 pid=${pid}: ${(bkErr && bkErr.message) || bkErr}`)
        }
      }
    }
  }
  return null
}

// 解析失败时清空播放地址缓存，下次解析重新取新签名地址，避免持续命中已失效的旧地址。
// 同时清空 JCE 死域名缓存：强制刷新（forceRefresh）时必须重试 JCE 主路径，
// 否则一次偶然的死域名会让后续所有续签都跳过 JCE 直接走 bkliveinfo。
function clearPlayUrlCache() {
  yspPlayUrlCache.clear()
  yspJceDeadCache.clear()
}

// ============================================================
// 山西网络广播电视台 (sxrtv.com)
// 完整继承 YSPlayer1.5 SxrtvParser：
//   1) info.json 接口 MD5 签名：token = md5(now + PATH + "Dream")
//   2) 解析 channels 取各频道最高码率 n 与源站 l
//   3) 流地址 = origin + /lsdream/<code>/<rate>/<key>.m3u8，
//      key 按上海时区当天零点动态计算（dynamicPath 为 false 时用 "live"）
// ============================================================

const SXRTV_PROVINCE_HOST = 'livehhhttps.sxrtv.com'
const SXRTV_PROVINCE_INFO_PATH = '/lsdream/336E7E6818120C00FA7E8129A9999A10/info.json'
const SXRTV_PROVINCE_INFO_ORIGIN = 'https://' + SXRTV_PROVINCE_HOST

const SXRTV_PROVINCE_CHANNELS = [
  { channelCode: 'q8RVWgs', name: '山西卫视' },
  { channelCode: 'lce1mC4', name: '黄河电视台' },
  { channelCode: '4j01KWX', name: '山西经济与科技' },
  { channelCode: 'Md571Kv', name: '山西影视' },
  { channelCode: 'p4y5do9', name: '山西社会与法治' },
  { channelCode: 'agmpyEk', name: '山西文体生活' },
]

const SXRTV_SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function sxrtvShanghaiMidnight(nowMs) {
  const shanghaiNow = new Date(nowMs + SXRTV_SHANGHAI_OFFSET_MS)
  return Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate()) - SXRTV_SHANGHAI_OFFSET_MS
}

function sxrtvProvinceDailyKey(channelCode, nowMs) {
  if (!channelCode || !/^[A-Za-z0-9]{7}$/.test(channelCode)) return 'live'

  const midnight = sxrtvShanghaiMidnight(nowMs)
  const weekday = new Date(midnight + SXRTV_SHANGHAI_OFFSET_MS).getUTCDay()

  let sum = 0
  let previous = -1
  let delta = 0
  for (let i = 0; i < channelCode.length; i++) {
    const current = channelCode.charCodeAt(i)
    sum += current
    if (previous !== -1) delta += previous - current
    previous = current
  }
  sum += delta

  let dateCode = midnight.toString(36)
  let dateCodeSum = 0
  for (let i = 0; i < dateCode.length; i++) dateCodeSum += dateCode.charCodeAt(i)
  dateCode = dateCode.substring(5) + dateCode.substring(0, 5)

  const checksum = Math.abs(dateCodeSum - sum)
  const mixed = sum.toString(36).split('').reverse().join('') + dateCode
  const head = mixed.substring(0, Math.min(4, mixed.length))
  const tail = mixed.substring(Math.min(4, mixed.length))

  const parity = weekday % 2
  let result = ''
  for (let i = 0; i < channelCode.length; i++) {
    if (i % 2 === parity) {
      result += mixed.charAt(i % mixed.length)
      continue
    }
    if (i === 0) {
      result += head.length > 0 ? head.charAt(0) : channelCode.charAt(i)
    } else {
      const prior = channelCode.charAt(i - 1)
      const pos = head.indexOf(prior)
      if (pos === -1) result += prior
      else result += pos < tail.length ? tail.charAt(pos) : prior
    }
  }
  const keyRaw = checksum.toString(36).split('').reverse().join('') + result
  return keyRaw.substring(0, channelCode.length)
}

let sxrtvInfoCache = null
const sxrtvStreamCache = new Map()

async function sxrtvFetchInfo(ua) {
  const now = Date.now()
  const tsHex = now.toString(16)
  const token = md5Hex(now + SXRTV_PROVINCE_INFO_PATH + 'Dream')
  const infoUrl = SXRTV_PROVINCE_INFO_ORIGIN + SXRTV_PROVINCE_INFO_PATH + '?t=' + tsHex + '&token=' + token

  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.sxrtv.com/tv/index.shtml',
    'Origin': 'https://www.sxrtv.com',
  }
  const resp = await session.defaultSession.fetch(infoUrl, { headers })
  if (!resp || resp.status !== 200) throw new Error('HTTP ' + (resp && resp.status))

  const data = await resp.json()
  const channels = data.channels
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('info.json has no channels')

  const cache = { channels: {}, dynamicPath: false, expiresAt: now + 5 * 60 * 1000, hardExpiresAt: now + 24 * 60 * 60 * 1000, retryAt: 0 }
  const play = data.play
  if (play) {
    const dlVal = play.dl
    if (dlVal != null) {
      if (typeof dlVal === 'boolean') cache.dynamicPath = dlVal
      else {
        const s = String(dlVal).trim()
        cache.dynamicPath = s.length > 0 && s !== '0' && s.toLowerCase() !== 'false'
      }
    }
  }

  for (const item of channels) {
    const code = item.i || ''
    if (!code || code.length > 10) continue
    const rates = item.r
    if (!Array.isArray(rates) || rates.length === 0) continue
    let maxRate = 0
    for (const r of rates) { const n = (r && r.n) || 0; if (n > maxRate) maxRate = n }
    if (maxRate <= 0) continue
    const host = item.l || ''
    let channelOrigin = SXRTV_PROVINCE_INFO_ORIGIN
    if (host) channelOrigin = host.startsWith('http') ? host : 'https://' + host
    cache.channels[code] = { rate: maxRate, origin: channelOrigin }
  }
  if (Object.keys(cache.channels).length === 0) throw new Error('no valid channels in info.json')
  return cache
}

async function sxrtvEnsureInfo(ua) {
  const now = Date.now()
  const cache = sxrtvInfoCache
  if (cache && (cache.expiresAt > now || cache.retryAt > now)) return cache
  try {
    const fresh = await sxrtvFetchInfo(ua)
    sxrtvInfoCache = fresh
    return fresh
  } catch (_) {
    if (cache) { cache.retryAt = now + 10 * 1000; return cache }
  }
  return cache
}

async function sxrtvGetProvinceStreamUrl(def, ua) {
  const now = Date.now()
  const sc = sxrtvStreamCache.get(def.channelCode)
  if (sc && sc.expiresAt > now) return sc.url

  const info = await sxrtvEnsureInfo(ua)
  if (!info) { if (sc) return sc.url; return null }

  const ci = info.channels[def.channelCode]
  if (!ci) return null

  const key = info.dynamicPath ? sxrtvProvinceDailyKey(def.channelCode, now) : 'live'
  const streamUrl = ci.origin + '/lsdream/' + def.channelCode + '/' + ci.rate + '/' + key + '.m3u8'

  sxrtvStreamCache.set(def.channelCode, { url: streamUrl, expiresAt: now + 2 * 60 * 1000 })
  return streamUrl
}

async function resolveSxrtvPlayUrl(pageUrl, ua) {
  let def = null
  if (pageUrl) {
    const hashIdx = pageUrl.indexOf('#')
    if (hashIdx >= 0 && hashIdx + 1 < pageUrl.length) {
      const code = pageUrl.substring(hashIdx + 1)
      for (const d of SXRTV_PROVINCE_CHANNELS) {
        if (d.channelCode === code) { def = d; break }
      }
    }
  }
  if (!def) def = SXRTV_PROVINCE_CHANNELS[0]

  const streamUrl = await sxrtvGetProvinceStreamUrl(def, ua)
  if (!streamUrl) return null
  return {
    url: streamUrl,
    headers: {
      'Referer': 'https://www.sxrtv.com/tv/index.shtml',
      'Origin': 'https://www.sxrtv.com',
      'User-Agent': ua,
    },
  }
}

// ============================================================
// 陕西网络广播电视台 (live.snrtv.com)
// 完整继承 YSPlayer1.5 SnrtvParser：
//   1) 抓取 stream.js，正则提取 sTV/sRadio 两个密文
//   2) AES-128-CBC/NoPadding 解密：key = sTV[0:16]，iv = sRadio[0:16]，密文 = base64(sTV[16:])
//   3) 解析 JSON 的 sxbc 分组，过滤 host==stream.snrtv.com 且 path 以 .m3u8 结尾
//   4) 按 URL 末尾段 key 匹配，追加 ?_=<秒级时间戳> 避免缓存
// ============================================================

const SXRTV_CATALOG_URL = 'https://toutiao.cnwest.com/static/v1/group/stream.js'
const SXRTV_CATALOG_REFRESH_MS = 5 * 60 * 1000
const SXRTV_CATALOG_HARD_TTL_MS = 24 * 60 * 60 * 1000

function snrtvUndress(keyStr, ivStr, cipherB64) {
  try {
    const key = Buffer.from(keyStr, 'utf8')
    const iv = Buffer.from(ivStr, 'utf8')
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    decipher.setAutoPadding(false)
    const buf = Buffer.from(cipherB64, 'base64')
    const dec = Buffer.concat([decipher.update(buf), decipher.final()])
    let end = dec.length
    while (end > 0 && dec[end - 1] === 0) end--
    return dec.slice(0, end).toString('utf8')
  } catch (_) { return '' }
}

let snrtvCatalogCache = null
let snrtvCatalogRefreshAt = 0
let snrtvCatalogHardExpiresAt = 0

function snrtvDecodeCatalog(script) {
  const tvMatcher = /\bvar\s+sTV\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(script || '')
  const radioMatcher = /\bvar\s+sRadio\s*=\s*"([A-Za-z0-9+/=]+)"/.exec(script || '')
  if (!tvMatcher || !radioMatcher) return null

  const sTv = tvMatcher[1]
  const sRadio = radioMatcher[1]
  if (sTv.length < 32 || sRadio.length < 16) return null

  const plain = snrtvUndress(sTv.substring(0, 16), sRadio.substring(0, 16), sTv.substring(16))
  if (!plain) return null

  let data
  try { data = JSON.parse(plain) } catch (_) { return null }
  const sxbc = data && data.sxbc
  if (!sxbc) return null

  const urls = {}
  for (const key of Object.keys(sxbc)) {
    const ch = sxbc[key]
    if (!ch) continue
    const m3u8 = ch.m3u8 || ''
    if (!m3u8) continue
    try {
      const parsed = new URL(m3u8)
      if (parsed.hostname !== 'stream.snrtv.com') continue
      if (!parsed.pathname || !parsed.pathname.endsWith('.m3u8')) continue
      urls[key] = m3u8
    } catch (_) {}
  }
  if (Object.keys(urls).length === 0) return null
  return urls
}

async function snrtvGetCatalog() {
  const now = Date.now()
  if (snrtvCatalogCache && now < snrtvCatalogRefreshAt) return snrtvCatalogCache

  try {
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Referer': 'http://live.snrtv.com/',
    }
    const resp = await session.defaultSession.fetch(SXRTV_CATALOG_URL, { headers })
    if (!resp || resp.status !== 200) throw new Error('HTTP ' + (resp && resp.status))
    const script = await resp.text()
    const fresh = snrtvDecodeCatalog(script)
    if (!fresh) throw new Error('decode failed')
    snrtvCatalogCache = fresh
    snrtvCatalogRefreshAt = now + SXRTV_CATALOG_REFRESH_MS
    snrtvCatalogHardExpiresAt = now + SXRTV_CATALOG_HARD_TTL_MS
    return fresh
  } catch (_) {
    if (snrtvCatalogCache && now < snrtvCatalogHardExpiresAt) {
      snrtvCatalogRefreshAt = now + SXRTV_CATALOG_REFRESH_MS
      return snrtvCatalogCache
    }
    return null
  }
}

async function resolveSnrtvPlayUrl(pageUrl) {
  let key = null
  if (pageUrl) {
    const lastSlash = pageUrl.lastIndexOf('/')
    if (lastSlash >= 0) {
      key = pageUrl.substring(lastSlash + 1)
      const q = key.indexOf('?')
      if (q >= 0) key = key.substring(0, q)
    }
  }
  if (!key) return null

  const catalog = await snrtvGetCatalog()
  if (!catalog) return null

  const m3u8Url = catalog[key]
  if (!m3u8Url) return null

  return {
    url: m3u8Url + '?_=' + Math.floor(Date.now() / 1000),
    headers: { 'Referer': 'http://live.snrtv.com/' },
  }
}

// ============================================================
// 央视网 (tv.cctv.com)
// 完整继承 YSPlayer1.5 CctvParser：
//   1) version.json -> emconfig.1001.channelFilePath（加密频道配置 URL）
//   2) 下载加密配置，用 liveplayer.js 提取的 AES key/iv 解密
//   3) 解析 live_policy/live_policy_ext 的 cn_manifest/fn_manifest 模板
//   4) 按模板优先级 + CDN 优先级选流，channelId 从 URL /live/xxx/ 提取
//   5) convertCdrmToHls 把 dh5.cntv / asp/h5e 转成普通 HLS
// ============================================================

const CCTV_VERSION_URL = 'https://api.live.cntv.cn/livestatic/zs/livestatic_config/pcweb/version.json'
const CCTV_LIVEPLAYER_ALT_URLS = [
  'https://js.player.cntv.cn/creator/liveplayer.js',
  'https://player.cntv.cn/html5Player/js/liveplayer.js',
]
const CCTV_CACHE_TTL_MS = 10 * 60 * 1000
const CCTV_KEY_CACHE_TTL_MS = 60 * 60 * 1000
const CCTV_UA_MOBILE = MOBILE_UA

const CCTV_CDN_PRIORITY = [
  'myqcloud.com', 'myalicdn.com', 'live.cntv.cn',
  'cntv.wscdns.com', 'cdn.cctv.cn', 'bdydns.com',
]

const CCTV_TEMPLATE_PRIORITY = [
  'hls_cdrm', 'hls_cdrm_timeshift', 'hls_cdrm_av1',
  'hls_nd', 'hls_nd_timeshift', 'hls_nd_4k',
]

const CCTV_CHANNEL_NAMES = {
  cctv1: 'CCTV-1综合', cctv2: 'CCTV-2财经', cctv3: 'CCTV-3综艺',
  cctv4: 'CCTV-4中文国际', cctv5: 'CCTV-5体育', cctv5plus: 'CCTV-5+体育赛事',
  cctv6: 'CCTV-6电影', cctv7: 'CCTV-7国防军事', cctv8: 'CCTV-8电视剧',
  cctv9: 'CCTV-9纪录', cctv10: 'CCTV-10科教', cctv11: 'CCTV-11戏曲',
  cctv12: 'CCTV-12社会与法', cctv13: 'CCTV-13新闻', cctv14: 'CCTV-14少儿',
  cctv15: 'CCTV-15音乐', cctv16: 'CCTV-16奥林匹克', cctv17: 'CCTV-17农业农村',
  cctv4k: 'CCTV-4K超高清', cctv8k: 'CCTV-8K超高清', '4kcctv16': 'CCTV-16 4K',
  cctvchild: 'CCTV-少儿', cctvjilu: 'CCTV-纪录',
  cctveurope: 'CGTN欧洲', cctvamerica: 'CGTN美洲', cctvdocument: 'CGTN纪录',
  cetv1: '中国教育1', cetv2: '中国教育2', cetv3: '中国教育3', cetv4: '中国教育4',
  anhui: '安徽卫视', beijing: '北京卫视', btv1: '北京卫视', chongqing: '重庆卫视',
  dongfang: '东方卫视', dongnan: '东南卫视', gansu: '甘肃卫视', guangdong: '广东卫视',
  guangxi: '广西卫视', guizhou: '贵州卫视', hebei: '河北卫视', heilongjiang: '黑龙江卫视',
  henan: '河南卫视', hubei: '湖北卫视', hunan: '湖南卫视', jiangxi: '江西卫视',
  jilin: '吉林卫视', liaoning: '辽宁卫视', neimenggu: '内蒙古卫视', ningxia: '宁夏卫视',
  qinghai: '青海卫视', shandong: '山东卫视', shan1xi: '陕西卫视', shan3xi: '山西卫视',
  shenzhen: '深圳卫视', sichuan: '四川卫视', tianjin: '天津卫视', xinjiang: '新疆卫视',
  xizang: '西藏卫视', yunnan: '云南卫视', zhejiang: '浙江卫视',
}

const CCTV_CHANNEL_ALIAS = { beijing: 'btv1', zhejiang: null, hunan: null }

let cctvCachedAesKey = null
let cctvCachedAesIv = null
let cctvKeyCacheTimestamp = 0
let cctvChannelUrlCache = null
let cctvChannelCacheTimestamp = 0

function cctvExtractChannelId(url) {
  if (!url) return null
  const m = /\/live\/([a-z0-9]+)\/?/i.exec(url)
  if (m) return m[1].toLowerCase()
  return null
}

function cctvConvertCdrmToHls(url) {
  if (!url) return url
  let changed = false
  if (url.includes('dh5.cntv.')) { url = url.replace('dh5.cntv.', 'hls.cntv.'); changed = true }
  if (url.includes('/asp/h5e/hls/')) { url = url.replace('/asp/h5e/hls/', '/asp/hls/'); changed = true }
  if (!changed && url.includes('/asp/h5e/')) { url = url.replace('/asp/h5e/', '/asp/'); changed = true }
  return url
}

function cctvCdnScore(url) {
  for (let i = 0; i < CCTV_CDN_PRIORITY.length; i++) {
    if (url.includes(CCTV_CDN_PRIORITY[i])) return i
  }
  return CCTV_CDN_PRIORITY.length
}

function cctvPickSingleTemplate(manifest) {
  for (const tkey of CCTV_TEMPLATE_PRIORITY) {
    const urls = manifest[tkey]
    if (!Array.isArray(urls) || urls.length === 0) continue
    const withPlaceholder = []
    const withoutPlaceholder = []
    for (const u of urls) {
      if (!u) continue
      if (u.includes('${channel}')) withPlaceholder.push(u)
      else withoutPlaceholder.push(u)
    }
    const candidates = withPlaceholder.length ? withPlaceholder : withoutPlaceholder
    if (candidates.length === 0) continue
    candidates.sort((a, b) => cctvCdnScore(a) - cctvCdnScore(b))
    return candidates[0]
  }
  return null
}

function cctvParseChannelConfig(json) {
  const channels = {}
  try {
    const root = JSON.parse(json)
    for (const arr of [root.live_policy, root.live_policy_ext]) {
      if (!Array.isArray(arr)) continue
      for (const group of arr) {
        if (!group) continue
        let manifest = group.cn_manifest
        if (!manifest) manifest = group.fn_manifest
        if (!manifest) continue
        const hls720Url = cctvPickSingleTemplate(manifest)
        if (!hls720Url) continue
        const chList = group.channels
        if (!Array.isArray(chList)) continue
        for (const ch of chList) {
          if (!ch) continue
          const channelId = ch.channel || ''
          if (!channelId) continue
          if (Object.prototype.hasOwnProperty.call(CCTV_CHANNEL_NAMES, channelId)) {
            channels[channelId] = hls720Url.includes('${channel}')
              ? hls720Url.replace('${channel}', channelId)
              : hls720Url
          }
        }
      }
    }
  } catch (_) {}
  return channels
}

function cctvAesDecryptWithKeyIv(base64Data, key, iv) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    const plain = Buffer.concat([decipher.update(Buffer.from(base64Data, 'base64')), decipher.final()])
    return plain.toString('utf8')
  } catch (_) { return null }
}

function cctvExtractKeyIvCandidates(js) {
  const keyCandidates = []
  const ivCandidates = []
  let m
  const keyRe = /["']([A-Za-z0-9+/]{43}=)["']/g
  while ((m = keyRe.exec(js))) {
    const kb = Buffer.from(m[1], 'base64')
    if (kb.length === 32) keyCandidates.push(kb)
  }
  const ivRe = /["']([A-Za-z0-9+/]{22}==)["']/g
  while ((m = ivRe.exec(js))) {
    const ib = Buffer.from(m[1], 'base64')
    if (ib.length === 16) ivCandidates.push(ib)
  }
  return { keyCandidates, ivCandidates }
}

async function cctvFetchLiveplayerJs() {
  const headers = {
    'Referer': 'https://tv.cctv.com/',
    'User-Agent': CCTV_UA_MOBILE,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  for (const url of CCTV_LIVEPLAYER_ALT_URLS) {
    try {
      const resp = await session.defaultSession.fetch(url, { headers })
      if (resp && resp.status === 200) {
        const text = await resp.text()
        if (text) return text
      }
    } catch (_) {}
  }
  return null
}

function cctvAesDecryptDynamic(base64Data, keyCandidates, ivCandidates) {
  for (const key of keyCandidates) {
    for (const iv of ivCandidates) {
      const r = cctvAesDecryptWithKeyIv(base64Data, key, iv)
      if (r && (r.startsWith('{') || r.startsWith('['))) {
        cctvCachedAesKey = key
        cctvCachedAesIv = iv
        cctvKeyCacheTimestamp = Date.now()
        return r
      }
    }
  }
  return null
}

async function cctvGetAesKeyIv() {
  const now = Date.now()
  if (cctvCachedAesKey && cctvCachedAesIv && (now - cctvKeyCacheTimestamp) < CCTV_KEY_CACHE_TTL_MS) {
    return { key: cctvCachedAesKey, iv: cctvCachedAesIv }
  }
  const js = await cctvFetchLiveplayerJs()
  if (!js) return null
  const { keyCandidates, ivCandidates } = cctvExtractKeyIvCandidates(js)
  if (keyCandidates.length === 0 || ivCandidates.length === 0) return null
  cctvCachedAesKey = keyCandidates[0]
  cctvCachedAesIv = ivCandidates[0]
  cctvKeyCacheTimestamp = now
  return { key: cctvCachedAesKey, iv: cctvCachedAesIv }
}

async function cctvAesDecrypt(base64Data) {
  const keyIv = await cctvGetAesKeyIv()
  if (keyIv) {
    const r = cctvAesDecryptWithKeyIv(base64Data, keyIv.key, keyIv.iv)
    if (r) return r
  }
  const js = await cctvFetchLiveplayerJs()
  if (!js) return null
  const { keyCandidates, ivCandidates } = cctvExtractKeyIvCandidates(js)
  return cctvAesDecryptDynamic(base64Data, keyCandidates, ivCandidates)
}

async function cctvFetchAndDecryptChannels(ua) {
  const headers = { 'User-Agent': ua, 'Referer': 'https://tv.cctv.com/' }
  const versionResp = await session.defaultSession.fetch(CCTV_VERSION_URL, { headers })
  if (!versionResp || versionResp.status !== 200) return null
  const versionJson = await versionResp.json()
  const emconfig = versionJson && versionJson.emconfig
  const configUrl = emconfig && emconfig['1001'] && emconfig['1001'].channelFilePath
  if (!configUrl) return null

  const configResp = await session.defaultSession.fetch(configUrl, { headers })
  if (!configResp || configResp.status !== 200) return null
  const encryptedB64 = (await configResp.text()).trim()
  const json = await cctvAesDecrypt(encryptedB64)
  if (!json) return null
  return cctvParseChannelConfig(json)
}

async function cctvGetChannelUrls(ua) {
  const now = Date.now()
  if (cctvChannelUrlCache && (now - cctvChannelCacheTimestamp) < CCTV_CACHE_TTL_MS) {
    return cctvChannelUrlCache
  }
  cctvChannelUrlCache = await cctvFetchAndDecryptChannels(ua)
  cctvChannelCacheTimestamp = Date.now()
  return cctvChannelUrlCache
}

async function resolveCctvPlayUrl(pageUrl, ua) {
  const channelId = cctvExtractChannelId(pageUrl)
  if (!channelId) return null

  const channels = await cctvGetChannelUrls(ua)
  if (!channels) return null

  let resolvedId = channelId
  if (Object.prototype.hasOwnProperty.call(CCTV_CHANNEL_ALIAS, channelId)) {
    const alias = CCTV_CHANNEL_ALIAS[channelId]
    if (alias == null) return null
    resolvedId = alias
  }

  let m3u8Url = channels[resolvedId]
  if (!m3u8Url) return null
  m3u8Url = cctvConvertCdrmToHls(m3u8Url)

  return {
    url: m3u8Url,
    headers: {
      'User-Agent': ua,
      'Origin': 'https://tv.cctv.com',
      'Referer': 'https://tv.cctv.com/',
    },
  }
}

// ============================================================
// 海南网络广播电视台 (hnntv.cn)
// 完整继承 YSPlayer1.5 HnntvParser：
//   1) 页面 channelId -> 频道 code 映射
//   2) GET ps.hnntv.cn/ps/livePlayUrl?channelCode=<code>&appCode=&token=
//   3) 取 resultSet[0].url，解析 _upt 末十位秒级过期时间，缓存复用至过期前 5 分钟
// ============================================================

const HNTV_PLAY_API = 'https://ps.hnntv.cn/ps/livePlayUrl'

const HNTV_CHANNEL_BY_ID = {
  '13': { id: '13', name: '海南卫视', code: 'STHaiNan_channel_lywsgq' },
  '5': { id: '5', name: '三沙卫视', code: 'STHaiNan_channel_ssws' },
  '1': { id: '1', name: '海南自贸', code: 'jjpd' },
  '3': { id: '3', name: '海南新闻', code: 'STHaiNan_channel_xwpd' },
  '4': { id: '4', name: '海南社会与法', code: 'ggpd' },
  '6': { id: '6', name: '海南文旅', code: 'wlpd' },
  '7': { id: '7', name: '海南少儿', code: 'sepd' },
}

const hnntvStreamCache = new Map()

function hnntvExtractExpiry(url) {
  try {
    const m = /[?&]_upt=([0-9a-f]{8}(\d{10}))/i.exec(url)
    if (m) return parseInt(m[2], 10) * 1000
  } catch (_) {}
  return 0
}

async function hnntvGetSignedStream(def, ua) {
  const now = Date.now()
  const cache = hnntvStreamCache.get(def.id)
  if (cache && cache.validUntil > now) {
    if (cache.refreshAt > now || cache.retryAt > now) return cache.url
  }

  try {
    const headers = {
      'User-Agent': ua,
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.hnntv.cn',
      'Referer': 'https://www.hnntv.cn/',
    }
    const resp = await session.defaultSession.fetch(
      HNTV_PLAY_API + '?channelCode=' + def.code + '&appCode=&token=', { headers })
    if (!resp || resp.status !== 200) return hnntvUseFallback(def, now)

    const json = await resp.json()
    const businessCode = json.businessCode
    const resultSet = json.resultSet
    if (businessCode !== 200 || !Array.isArray(resultSet) || resultSet.length === 0) {
      return hnntvUseFallback(def, now)
    }

    const signedUrl = resultSet[0].url || ''
    if (!signedUrl || !signedUrl.includes('.m3u8')) return hnntvUseFallback(def, now)

    const expiresAt = hnntvExtractExpiry(signedUrl)
    const validUntil = expiresAt > 0 ? expiresAt - 5 * 60 * 1000 : now + 90 * 60 * 1000

    const entry = {
      url: signedUrl,
      validUntil,
      refreshAt: Math.min(now + 90 * 60 * 1000, validUntil),
      retryAt: 0,
    }
    hnntvStreamCache.set(def.id, entry)
    return entry.url
  } catch (_) {
    return hnntvUseFallback(def, now)
  }
}

function hnntvUseFallback(def, now) {
  const cache = hnntvStreamCache.get(def.id)
  if (cache && cache.validUntil > now + 5 * 60 * 1000) {
    cache.retryAt = now + 60 * 1000
    return cache.url
  }
  return null
}

async function resolveHnntvPlayUrl(pageUrl, ua) {
  const m = /[?&]channelId=(\d{1,3})(?:&|$)/i.exec(pageUrl || '')
  const channelId = m ? m[1] : null
  let def = HNTV_CHANNEL_BY_ID[channelId]
  if (!def) def = HNTV_CHANNEL_BY_ID['13']

  const streamUrl = await hnntvGetSignedStream(def, ua)
  if (!streamUrl) return null
  return {
    url: streamUrl,
    headers: {
      'User-Agent': ua,
      'Referer': 'https://www.hnntv.cn/',
      'Origin': 'https://www.hnntv.cn',
    },
  }
}

// ============================================================
// 广西网络广播电视台 (gxtv.cn)
// 完整继承 YSPlayer1.5 GxtvParser + GxtvTsDecrypt：
//   POST channelList 接口 -> 按 UUID->rawName 匹配频道 -> 提取 m3u8
//   -> 校验可访问 -> 启动本地代理；若返回 encodingId/encodingKey，
//   启用 GxtvTsDecrypt 对 TS 分片做 AES-128-ECB + 块交换解密
// ============================================================

const GXTV_API_URL = 'https://api2019.gxtv.cn/memberApi/channel/channelList'

const GXTV_UUID_TO_RAWNAME = {
  'e7a7ab7df9fe11e88bcfe41f13b60c62': '广西卫视',
  'f3335975f9fe11e88bcfe41f13b60c62': '综艺旅游频道',
  'fdbaf085f9fe11e88bcfe41f13b60c62': '都市频道',
  '5e923d82058e11e9ba67e41f13b60c62': '影视频道',
  '9dfd8600075811e9ba67e41f13b60c62': '新闻频道',
  'bfa17b64157f11e999f0e41f13b60c62': '国际频道',
  '78dbfd44e6b74ab687204d2d8113cbf5': '移动数字电视频道',
  'ffa6b6e1b32b4a16a73eb3ef66f8bfc7': '中国教育电视台CETV-1频道',
  '80d0ffb42c114eaf9663708629ff0a3e': '中国教育电视台CETV-2频道',
  '67eace939278435bb4bca90800fb4225': '中国教育电视台CETV-4频道',
}

function gxtvExtractUuid(url) {
  if (!url) return null
  let m = /channelivePlay_([0-9a-fA-F]{32})/.exec(url)
  if (m) return m[1]
  m = /([0-9a-fA-F]{32})/.exec(url)
  if (m) return m[1]
  return null
}

function gxtvGuessChannelName(url) {
  if (!url) return null
  for (const key of Object.keys(GXTV_UUID_TO_RAWNAME)) {
    if (url.includes(key)) return GXTV_UUID_TO_RAWNAME[key]
  }
  return null
}

function gxtvStreamUrlOf(row) {
  const fields = ['encodeM3u8', 'decodeM3u8', 'source0M3u8', 'channelM3u8', 'subjectM3u8']
  for (const field of fields) {
    const val = (row[field] || '').trim()
    if (!val || !val.startsWith('http')) continue
    if (val.includes('.m3u8')) return val
  }
  return null
}

// 广西台 encodeM3u8 是「单变体」主播放列表（含 #EXT-X-STREAM-INF，变体 URI 为相对路径）：
//   #EXT-X-STREAM-INF:...BANDWIDTH=...
//   xxxx-1.m3u8
// 若直接把主列表交给前端，hls.js 会通过 /seg/ 拉取变体播放列表，而变体内部的分片
// 地址同样是相对路径，会被解析到 /seg/ 目录导致 404。这里先下钻到真正的媒体播放列表。
async function gxtvResolveMediaPlaylist(m3u8Url, cdnHeaders) {
  let current = m3u8Url
  for (let depth = 0; depth < 4; depth++) {
    const resp = await session.defaultSession.fetch(current, { headers: cdnHeaders })
    if (!resp || resp.status !== 200) return null
    const text = await resp.text()
    // 媒体播放列表不含 #EXT-X-STREAM-INF，已是可直接播放的层级
    if (text.indexOf('#EXT-X-STREAM-INF') < 0) return current
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    if (lines.length === 0) return null
    let variant = lines[0]
    if (!/^https?:\/\//i.test(variant)) {
      variant = current.substring(0, current.lastIndexOf('/') + 1) + variant
    }
    current = variant
  }
  return null
}

// ====== GxtvTsDecrypt JS 移植 ======
const GXTV_TS_PACKET_SIZE = 188
const GXTV_KEY_SALT = '01234568'

function gxtvCharCodeSum(text) {
  let total = 0
  if (text) for (let i = 0; i < text.length; i++) total += text.charCodeAt(i)
  return total
}

function gxtvEncryptionMarker(pes) {
  if (pes.length < 25 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null
  const flags = pes[7] & 0xff
  if ((flags & 0x01) === 0) return null

  const ptsDtsFlags = flags >>> 6
  let extensionOffset
  if (ptsDtsFlags === 2) extensionOffset = 5
  else if (ptsDtsFlags === 3) extensionOffset = 10
  else if ((flags & 0x20) !== 0) extensionOffset = 6
  else if ((flags & 0x10) !== 0) extensionOffset = 3
  else if ((flags & 0x08) !== 0) extensionOffset = 1
  else if ((flags & 0x04) !== 0) extensionOffset = 1
  else if ((flags & 0x02) !== 0) extensionOffset = 2
  else extensionOffset = 0

  const extensionFlagsAt = 9 + extensionOffset
  const markerAt = 19 + extensionOffset
  if (markerAt >= pes.length || (pes[extensionFlagsAt] & 0x80) === 0) return null

  const marker = pes[markerAt] & 0xff
  return [marker & 0x3f, (marker & 0x80) !== 0 ? 1 : 0, (marker & 0x40) !== 0 ? 1 : 0]
}

function gxtvDecryptPayloadV2(payload, aesKey, customId, contentId) {
  if (payload.length === 0) return false

  let blocks = (gxtvCharCodeSum(customId) + gxtvCharCodeSum(contentId)) % 32
  if (blocks < 4) blocks = 4

  const blockLength = Math.floor(payload.length / blocks)
  if (blockLength <= 0) return false

  const encryptedOffset = Math.floor(blockLength / 2)
  const encryptedLength = Math.floor((payload.length - encryptedOffset - 1) / 16) * 16

  if (encryptedLength > 0) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
      decipher.setAutoPadding(false)
      const encrypted = payload.slice(encryptedOffset, encryptedOffset + encryptedLength)
      const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
      plain.copy(payload, encryptedOffset)
    } catch (_) { return false }
  }

  if (blockLength > 0 && blocks > 1) {
    // Buffer.slice() 返回的是「视图」而非拷贝，后续 copyWithin 会覆盖末块内存，
    // 导致 lastBlock 内容被污染；这里必须显式拷贝一份（与 Java System.arraycopy 语义一致）。
    const lastBlock = Buffer.from(payload.slice((blocks - 1) * blockLength, blocks * blockLength))
    const middleLen = (blocks - 2) * blockLength
    if (middleLen > 0) {
      payload.copyWithin(2 * blockLength, blockLength, blockLength + middleLen)
    }
    lastBlock.copy(payload, blockLength)
  }
  return true
}

function gxtvFlushPes(buffer, builder, aesKey, customId, contentId) {
  let totalLen = 0
  for (const s of builder.slices) totalLen += (s[1] - s[0])
  const pes = Buffer.alloc(totalLen)
  let offset = 0
  for (const s of builder.slices) {
    const len = s[1] - s[0]
    buffer.copy(pes, offset, s[0], s[1])
    offset += len
  }

  const marker = gxtvEncryptionMarker(pes)
  if (!marker || marker[0] !== 2) return false

  const pesHeaderDataLen = pes[8] & 0xff
  const payloadAt = 9 + pesHeaderDataLen
  if (payloadAt >= pes.length) return false

  const pesPayload = Buffer.alloc(pes.length - payloadAt)
  pes.copy(pesPayload, 0, payloadAt)
  if (!gxtvDecryptPayloadV2(pesPayload, aesKey, customId, contentId)) return false
  pesPayload.copy(pes, payloadAt)

  let pesByteOffset = 0
  for (const s of builder.slices) {
    const sliceLen = s[1] - s[0]
    pes.copy(buffer, s[0], pesByteOffset, pesByteOffset + sliceLen)
    pesByteOffset += sliceLen
  }
  return true
}

function gxtvTsDecrypt(buffer, customId, contentId) {
  if (!buffer || buffer.length < GXTV_TS_PACKET_SIZE || !customId || !contentId) return 0
  const aesKey = crypto.createHash('md5').update(GXTV_KEY_SALT + customId, 'utf8').digest()
  const active = new Map()
  let decrypted = 0

  for (let packetAt = 0; packetAt + GXTV_TS_PACKET_SIZE <= buffer.length; packetAt += GXTV_TS_PACKET_SIZE) {
    if (buffer[packetAt] !== 0x47) continue

    const packetByte1 = buffer[packetAt + 1] & 0xff
    const payloadUnitStart = (packetByte1 & 0x40) !== 0
    const pid = ((packetByte1 & 0x1f) << 8) | (buffer[packetAt + 2] & 0xff)
    const adaptationControl = (buffer[packetAt + 3] >>> 4) & 0x03

    if (adaptationControl === 0 || adaptationControl === 2) continue

    let payloadAt = packetAt + 4
    if (adaptationControl === 3) {
      const afLen = buffer[payloadAt] & 0xff
      payloadAt += 1 + afLen
    }
    const packetEnd = packetAt + GXTV_TS_PACKET_SIZE
    if (payloadAt >= packetEnd) continue

    if (payloadUnitStart) {
      const prev = active.get(pid)
      if (prev && prev.slices.length > 0) {
        if (gxtvFlushPes(buffer, prev, aesKey, customId, contentId)) decrypted++
      }
      active.delete(pid)

      if (payloadAt + 3 <= packetEnd
          && buffer[payloadAt] === 0
          && buffer[payloadAt + 1] === 0
          && buffer[payloadAt + 2] === 1) {
        active.set(pid, { slices: [[payloadAt, packetEnd]] })
      }
    } else {
      const builder = active.get(pid)
      if (builder) builder.slices.push([payloadAt, packetEnd])
    }
  }

  for (const builder of active.values()) {
    if (builder.slices.length > 0) {
      if (gxtvFlushPes(buffer, builder, aesKey, customId, contentId)) decrypted++
    }
  }
  return decrypted
}

async function resolveGxtvPlayUrl(pageUrl, ua) {
  const channelUuid = gxtvExtractUuid(pageUrl)
  const expectedRawName = channelUuid != null ? GXTV_UUID_TO_RAWNAME[channelUuid] : null

  const apiHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://tv.gxtv.cn/',
    'User-Agent': ua,
    'Accept': 'application/json',
  }
  const resp = await session.defaultSession.fetch(GXTV_API_URL, {
    method: 'POST',
    headers: apiHeaders,
    body: 'pageNo=1&pageSize=1000&liveMethod=0',
  })
  if (!resp || resp.status !== 200) return null
  const apiJson = await resp.json()
  if (!apiJson || apiJson.code !== 0) return null
  const rows = (apiJson.data && apiJson.data.rows) || []

  let m3u8Url = null
  let encodingId = ''
  let encodingKey = ''
  let channelName = '广西'

  for (const row of rows) {
    if ((row.state || 0) !== 1) continue
    if ((row.showChannel || 0) !== 1) continue
    const rname = (row.name || '').trim()
    let match = false
    if (expectedRawName != null) {
      match = expectedRawName === rname
    } else {
      const rowId = row.id || ''
      match = rowId !== '' && pageUrl.includes(rowId)
    }
    if (!match) continue
    channelName = rname
    m3u8Url = gxtvStreamUrlOf(row)
    encodingId = (row.encodingId || '').trim()
    encodingKey = (row.encodingKey || '').trim()
    break
  }

  if (!m3u8Url && expectedRawName == null) {
    const guessName = gxtvGuessChannelName(pageUrl)
    if (guessName) {
      for (const row of rows) {
        if ((row.state || 0) !== 1) continue
        if ((row.showChannel || 0) !== 1) continue
        const rname = (row.name || '').trim()
        if (rname === guessName || rname.includes(guessName) || guessName.includes(rname)) {
          channelName = rname
          m3u8Url = gxtvStreamUrlOf(row)
          encodingId = (row.encodingId || '').trim()
          encodingKey = (row.encodingKey || '').trim()
          break
        }
      }
    }
  }

  if (!m3u8Url) return null

  const cdnHeaders = {
    'Referer': 'https://tv.gxtv.cn/',
    'User-Agent': ua,
  }

  // 下钻到媒体播放列表，避免把「单变体主列表」交给前端导致相对分片地址解析失败
  const mediaUrl = await gxtvResolveMediaPlaylist(m3u8Url, cdnHeaders)
  if (mediaUrl) {
    m3u8Url = mediaUrl
  } else {
    // 下钻失败（主列表不可访问或畸形）时退回原地址，保持旧行为
    const m3u8Resp = await session.defaultSession.fetch(m3u8Url, { headers: cdnHeaders })
    if (!m3u8Resp || m3u8Resp.status !== 200) return null
  }

  const m3u8Base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1)

  let segmentTransformer = null
  if (encodingId && encodingKey) {
    segmentTransformer = (data) => {
      gxtvTsDecrypt(data, encodingId, encodingKey)
      return data
    }
  }

  const port = await createLocalProxy({
    key: 'gxtv:' + channelName,
    m3u8Url,
    m3u8Base,
    headers: cdnHeaders,
    ua,
    segmentTransformer,
    defaultOrigin: 'https://tv.gxtv.cn',
    defaultReferer: 'https://tv.gxtv.cn/',
  })
  return {
    url: `http://127.0.0.1:${port}/proxy.m3u8`,
    headers: { 'Referer': 'https://tv.gxtv.cn/' },
  }
}

// ============================================================
// 江苏荔枝网 (live.jstv.com)
// 完整继承 YSPlayer1.5 JstvParser：
//   1) GetWebToken 鉴权（MD5 签名 + 时间戳逐字节混淆）
//   2) 频道列表接口（Bearer token）
//   3) 流地址短效签名 txSecret = MD5(SECRET + 流名 + txTime)
// ============================================================

const JSTV_APP_ID = '3b93c452b851431c8b3a076789ab1e14'
const JSTV_APP_SECRET = '9dd4b0400f6e4d558f2b3497d734c2b4'
const JSTV_AUTH_URL = 'https://api-auth-lizhi.jstv.com/JwtAuth/GetWebToken'
const JSTV_CHANNEL_LIST_URL = 'https://publish-lizhi.jstv.com/nav/8385'
// 2026-11-09 核对官网 JS（live.jstv.com/assets/js/311.ea166a1e.js 的 encodeLiveUrl）：
// 流签名密钥已更新，旧参数 'wrf2yJaCwC8HX3cfJz8P' 会令全部频道的 HLS 返回 403。
// 密钥在官网前端 JS 中以 atob(字符串.slice(6,-3)) 混淆存储，会随官网重新发布而变更，
// 因此同时实现 jstvFetchStreamSecret() 自动云端抓取。
// 【测试】硬编码兜底值已注释：抓取失败时密钥为 null，签名直接失效以便暴露问题。
// const JSTV_STREAM_SECRET = 'enxG6z6eEWFWKHeTFNQ8'
const JSTV_PAGE_URL = 'https://live.jstv.com/'
const JSTV_SECRET_CACHE_TTL_MS = 30 * 60 * 1000
const JSTV_STREAM_HOST = 'litchi-play-encrypted-site.jstv.com'
const JSTV_STREAM_TTL_SECONDS = 180
const JSTV_TOKEN_CACHE_TTL_MS = 10 * 60 * 1000
const JSTV_TOKEN_RETRY_MS = 15 * 1000
const JSTV_CHANNEL_CACHE_TTL_MS = 4 * 60 * 60 * 1000
const JSTV_CHANNEL_RETRY_MS = 60 * 1000

const JSTV_CHANNEL_ID_TO_EXTRA_ID = { '660': '670', '659': '676' }
const JSTV_CHANNEL_NAMES = {
  '670': '江苏卫视', '676': '江苏卫视4K', '669': '江苏城市',
  '663': '江苏综艺', '664': '江苏影视', '668': '江苏新闻',
  '666': '江苏教育', '665': '江苏体育休闲', '667': '优漫卡通', '671': '江苏国际',
}

let jstvCachedToken = null
let jstvTokenExpiresAt = 0
let jstvTokenRetryAfter = 0
let jstvCachedChannels = null
let jstvChannelCacheExpiresAt = 0
let jstvChannelRetryAfter = 0
let jstvStreamSecret = null   // 当前生效密钥（仅自动抓取成功后被更新；测试期无硬编码兜底）
let jstvStreamSecretCheckedAt = 0           // 上次抓取密钥的时间戳
let jstvStreamSecretPromise = null          // 并发去重：进行中的抓取

function md5Hex(str) {
  return crypto.createHash('md5').update(String(str), 'utf8').digest('hex')
}

function jstvTransformByte(b) {
  const hi = (b & 0xf0) ^ 0xf0
  const lo = ((b & 0x0f) + 1) & 0x0f
  return hi | lo
}

function jstvEncodeTimestamp(seconds) {
  const value = seconds | 0
  const b0 = jstvTransformByte(value & 0xff)
  const b1 = jstvTransformByte((value >>> 8) & 0xff)
  const b2 = jstvTransformByte((value >>> 16) & 0xff)
  const b3 = jstvTransformByte((value >>> 24) & 0xff)
  return b3 | (b2 << 8) | (b1 << 16) | (b0 << 24)
}

function jstvFlattenForSign(value) {
  if (value == null) return 'null'
  if (Array.isArray(value)) {
    let s = ''
    for (const v of value) s += jstvFlattenForSign(v)
    return s
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    let s = ''
    for (const k of keys) s += k + jstvFlattenForSign(value[k])
    return s
  }
  return String(value)
}

function jstvBuildAuthRequest(nowMillis, uuid) {
  const seconds = Math.floor(nowMillis / 1000)
  const body = { platform: 41, uuid, appId: JSTV_APP_ID }
  const path = '/JwtAuth/GetWebToken?AppID=' + JSTV_APP_ID
  const signInput = JSTV_APP_SECRET + path + jstvFlattenForSign(body) + seconds
  const sign = md5Hex(signInput)
  const tt = jstvEncodeTimestamp(seconds)
  const url = `${JSTV_AUTH_URL}?AppID=${JSTV_APP_ID}&TT=${tt}&Sign=${sign}`
  return { url, body: JSON.stringify(body) }
}

function jstvExtractJwtExpiry(token) {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return 0
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const claims = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    return (claims.exp || 0) * 1000
  } catch (_) { return 0 }
}

async function jstvGetAccessToken(ua) {
  const now = Date.now()
  if (jstvCachedToken && jstvTokenExpiresAt > now + 120000) return jstvCachedToken
  if (jstvTokenRetryAfter > now) throw new Error('jstv auth temporarily unavailable')

  const authReq = jstvBuildAuthRequest(now, crypto.randomBytes(16).toString('hex'))
  const resp = await session.defaultSession.fetch(authReq.url, {
    method: 'POST',
    headers: { 'User-Agent': ua, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: authReq.body,
  })
  if (!resp || resp.status !== 200) {
    jstvTokenRetryAfter = now + JSTV_TOKEN_RETRY_MS
    throw new Error('jstv auth HTTP ' + (resp && resp.status))
  }
  const payload = await resp.json()
  const token = (payload && payload.data && payload.data.accessToken) || ''
  if (!token) {
    jstvTokenRetryAfter = now + JSTV_TOKEN_RETRY_MS
    throw new Error('jstv auth no accessToken')
  }
  let expiry = jstvExtractJwtExpiry(token)
  if (expiry <= 0) expiry = now + 8 * 60 * 1000
  jstvCachedToken = token
  jstvTokenExpiresAt = Math.min(expiry, now + JSTV_TOKEN_CACHE_TTL_MS)
  jstvTokenRetryAfter = 0
  return token
}

async function jstvFetchChannelList(token, ua) {
  const now = Date.now()
  if (jstvCachedChannels && jstvChannelCacheExpiresAt > now) return jstvCachedChannels
  if (jstvChannelRetryAfter > now) {
    if (jstvCachedChannels) return jstvCachedChannels
    throw new Error('jstv channel list temporarily unavailable')
  }
  const resp = await session.defaultSession.fetch(JSTV_CHANNEL_LIST_URL, {
    headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Authorization': 'Bearer ' + token },
  })
  if (!resp || resp.status !== 200) {
    jstvChannelRetryAfter = now + JSTV_CHANNEL_RETRY_MS
    throw new Error('jstv channel list HTTP ' + (resp && resp.status))
  }
  const payload = await resp.json()
  const articles = (payload && payload.data && payload.data.articles) || []
  const rows = []
  for (const a of articles) {
    if (!a) continue
    const extraId = String(a.extraId || '').trim()
    if (!/^\d{1,8}$/.test(extraId)) continue
    const rawName = String(a.title || '').trim()
    const extraJson = a.extraJson
    if (!extraJson) continue
    const streamUrl = String(extraJson.url || '').trim()
    if (!/^https?:\/\/[^/]*jstv\.com\/.+\.m3u8$/i.test(streamUrl)) continue
    const name = JSTV_CHANNEL_NAMES[extraId] || rawName
    if (!name) continue
    rows.push({ extraId, name, rawUrl: streamUrl })
  }
  if (rows.length === 0) {
    jstvChannelRetryAfter = now + JSTV_CHANNEL_RETRY_MS
    throw new Error('jstv channel list empty')
  }
  jstvCachedChannels = rows
  jstvChannelCacheExpiresAt = now + JSTV_CHANNEL_CACHE_TTL_MS
  jstvChannelRetryAfter = 0
  return rows
}

// 抓取纯文本资源（本文件已统一走 Node 原生 https 网络栈，见 session.defaultSession.fetch 重定义）
async function jstvHttpGetText(url) {
  try {
    const resp = await session.defaultSession.fetch(url, { headers: { 'Accept': '*/*' } })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

// 官网把密钥混淆成 "prefix + base64(密钥) + suffix" 形态，例如
//   "L3EN4P" + base64("enxG6z6eEWFWKHeTFNQ8") + "QOW"
// 从整串里找出「能 base64 解码为字母数字串」的最长子串即为密钥。
function jstvDecodeObfuscatedSecret(obf) {
  if (!obf) return null
  const candidates = []
  for (let end = 24; end <= obf.length; end++) {
    if (obf[end - 1] !== '=') continue
    for (let start = 0; start <= end - 24; start++) {
      const sub = obf.slice(start, end)
      if (sub.length % 4 !== 0) continue
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sub)) continue
      const eq = sub.indexOf('=')
      if (eq !== -1 && eq < sub.length - 2) continue
      let dec = null
      try { dec = Buffer.from(sub, 'base64').toString('utf8') } catch (_) {}
      if (dec && /^[A-Za-z0-9]{16,48}$/.test(dec)) candidates.push(dec)
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.length - a.length)
  return candidates[0]
}

// 在取流逻辑 chunk 里，围绕 encodeLiveUrl 查找混淆密钥并解码
function jstvExtractSecretFromChunk(js) {
  const idx = js.indexOf('encodeLiveUrl')
  if (idx < 0) return null
  const win = js.slice(Math.max(0, idx - 2500), idx + 500)
  const re = /["']([A-Za-z0-9+/=]{20,80})["']/g
  let m
  while ((m = re.exec(win)) !== null) {
    const s = jstvDecodeObfuscatedSecret(m[1])
    if (s) return s
  }
  return null
}

// 三步自动抓取密钥：首页 HTML -> app 入口 JS -> 取流逻辑 chunk
async function jstvFetchStreamSecret() {
  const pageHtml = await jstvHttpGetText(JSTV_PAGE_URL)
  if (!pageHtml) return null
  const appMatch = pageHtml.match(/assets\/js\/app\.[a-f0-9]+\.js/)
  if (!appMatch) return null

  const appJs = await jstvHttpGetText(JSTV_PAGE_URL + appMatch[0])
  if (!appJs) return null
  const hashMatch = appJs.match(/assets\/js\/"\+e\+"\.([a-f0-9]+)\.js/)
  const chunkMatch = appJs.match(/\.e\((\d+)\)/)
  if (!hashMatch || !chunkMatch) return null

  const chunkUrl = `${JSTV_PAGE_URL}assets/js/${chunkMatch[1]}.${hashMatch[1]}.js`
  const chunkJs = await jstvHttpGetText(chunkUrl)
  if (!chunkJs) return null
  return jstvExtractSecretFromChunk(chunkJs)
}

// 带冷却期与并发去重的密钥刷新；抓取失败时沿用现有密钥（首次为硬编码兜底值）
async function jstvEnsureStreamSecret() {
  const now = Date.now()
  if (jstvStreamSecretCheckedAt && now - jstvStreamSecretCheckedAt < JSTV_SECRET_CACHE_TTL_MS) {
    return jstvStreamSecret
  }
  if (jstvStreamSecretPromise) return jstvStreamSecretPromise
  jstvStreamSecretPromise = (async () => {
    try {
      const s = await jstvFetchStreamSecret()
      if (s) jstvStreamSecret = s
    } catch (_) { /* 抓取失败则沿用现有密钥 */ }
    finally {
      jstvStreamSecretCheckedAt = Date.now()
      jstvStreamSecretPromise = null
    }
    return jstvStreamSecret
  })()
  return jstvStreamSecretPromise
}

function jstvSignStreamUrl(rawUrl) {
  const u = new URL(rawUrl)
  const path = u.pathname
  const streamName = path.substring(path.lastIndexOf('/') + 1).replace(/\.m3u8$/, '')
  const txTime = Math.floor(Date.now() / 1000 + JSTV_STREAM_TTL_SECONDS).toString(16)
  const txSecret = md5Hex(jstvStreamSecret + streamName + txTime)
  return `https://${JSTV_STREAM_HOST}${path}?txSecret=${txSecret}&txTime=${txTime}`
}

async function resolveJstvPlayUrl(channelId, ua) {
  const secretPromise = jstvEnsureStreamSecret() // 并行刷新签名密钥，签名前 await 即可
  const token = await jstvGetAccessToken(ua)
  const channels = await jstvFetchChannelList(token, ua)
  let extraId = JSTV_CHANNEL_ID_TO_EXTRA_ID[channelId] || channelId
  let ch = channels.find(c => c.extraId === extraId)
  if (!ch) ch = channels.find(c => c.extraId === channelId)
  if (!ch) return null
  await secretPromise
  const signedUrl = jstvSignStreamUrl(ch.rawUrl)
  return {
    url: signedUrl,
    headers: { 'User-Agent': ua, 'Origin': 'https://live.jstv.com', 'Referer': 'https://live.jstv.com/' },
  }
}

// ============================================================
// 齐鲁网 (v.iqilu.com)
// 完整继承 YSPlayer1.5 IqiluParser：
//   1) 抓取频道页 HTML，提取页面变量 _pdCid/dF/aF/mxpx/aly
//   2) 签名 sign = MD5(pdCid + 毫秒时间戳 + signSecret)
//   3) 请求体用 AES-128-CBC 加密（key=aly，IV=16个'0'字符 0x30）
//   4) 响应 AES-CBC 解密后取 data 即 m3u8
// ============================================================

const IQILU_ZERO_IV = Buffer.from('0000000000000000', 'utf8')
const IQILU_VAR_PAT = /var\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g

function iqiluAesEncrypt(plain, keyStr) {
  try {
    const key = Buffer.from(keyStr, 'utf8')
    const cipher = crypto.createCipheriv('aes-128-cbc', key, IQILU_ZERO_IV)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return enc.toString('base64')
  } catch (_) { return null }
}

function iqiluAesDecrypt(base64Data, keyStr) {
  try {
    const key = Buffer.from(keyStr, 'utf8')
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, IQILU_ZERO_IV)
    const buf = Buffer.from(base64Data, 'base64')
    const dec = Buffer.concat([decipher.update(buf), decipher.final()])
    return dec.toString('utf8')
  } catch (_) { return null }
}

function iqiluExtractVars(html) {
  const vars = {}
  let m
  IQILU_VAR_PAT.lastIndex = 0
  while ((m = IQILU_VAR_PAT.exec(html)) !== null) {
    if (m[1] && m[2] && !(m[1] in vars)) vars[m[1]] = m[2]
  }
  return vars
}

async function iqiluHttpGetText(url, headers) {
  try {
    const r = await simpleHttpsFetch(url, { headers })
    if (r && r.ok) return await r.text()
  } catch (_) {}
  try {
    const resp = await session.defaultSession.fetch(url, { headers })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

async function iqiluHttpPostText(url, headers, body) {
  try {
    const r = await simpleHttpsFetch(url, { method: 'POST', headers, body })
    if (r && r.ok) return await r.text()
  } catch (_) {}
  try {
    const resp = await session.defaultSession.fetch(url, { method: 'POST', headers, body })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

// 把 iqilu 换票得到的「主播放列表」解析成「媒体播放列表」地址。
// 多数频道（山东卫视/齐鲁/生活等）换票直接返回媒体播放列表（含 .ts 分片）；
// 但山东新闻频道（ggpd）返回的是主播放列表（#EXT-X-STREAM-INF 变体），
// 变体指向 100ycdn.com 的嵌套媒体播放列表（带 wsSession/wsIPSercert 等会话 token）。
// 本地代理只对顶层 m3u8 做一层分片地址改写，无法递归解析主播放列表，
// 因此需在解析阶段就把主播放列表解析成媒体播放列表地址，再交给前端/代理。
async function resolveIqiluMasterToMedia(url, headers) {
  try {
    const text = await iqiluHttpGetText(url, headers)
    if (!text || !/#EXT-X-STREAM-INF/i.test(text)) return url
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      if (/\.m3u8(\?|$)/i.test(t)) {
        try { return new URL(t, url).toString() } catch (_) {}
      }
    }
  } catch (_) {}
  return url
}

async function resolveIqiluPlayUrl(pageUrl, ua) {
  const headers = {
    'User-Agent': ua,
    'Referer': 'https://v.iqilu.com/',
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  const html = await iqiluHttpGetText(pageUrl, headers)
  if (!html) return null

  const vars = iqiluExtractVars(html)
  const pdCid = vars._pdCid
  const dF = vars.dF
  const aF = vars.aF
  const signSecret = vars.mxpx
  const aesKey = vars.aly
  const endpoint = (dF && aF) ? (dF + aF) : ''

  const valid = !!(
    pdCid && /^\d{1,8}$/.test(pdCid)
    && endpoint && endpoint.startsWith('https://feiying.litenews.cn')
    && signSecret && signSecret.length === 16
    && aesKey && aesKey.length === 16
  )
  if (!valid) {
    // 认证参数缺失时，尝试从页面直接提取 m3u8
    const direct = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i)
    if (direct) return { url: direct[0], headers }
    return null
  }

  const tsStr = String(Date.now())
  const sign = md5Hex(pdCid + tsStr + signSecret)
  const exchangeUrl = `${endpoint}?t=${tsStr}&s=${sign}`

  const encBody = iqiluAesEncrypt(`{"channelMark":"${pdCid}"}`, aesKey)
  if (!encBody) return null

  const postHeaders = {
    'User-Agent': ua,
    'Content-Type': 'text/plain',
    'Origin': 'https://v.iqilu.com',
    'Referer': 'https://v.iqilu.com/',
    'Accept': '*/*',
  }
  const exText = await iqiluHttpPostText(exchangeUrl, postHeaders, encBody)
  if (!exText) return null

  const decrypted = iqiluAesDecrypt(exText.trim(), aesKey)
  if (!decrypted) return null

  let data
  try { data = JSON.parse(decrypted) } catch (_) { return null }
  if (data.code !== 1) return null

  let url = ''
  if (typeof data.data === 'string' && data.data.startsWith('http')) {
    url = data.data
  } else if (data.data && typeof data.data === 'object') {
    url = data.data.playUrl || data.data.streamUrl || ''
  }
  if (!url) return null

  const streamHeaders = { 'User-Agent': ua, 'Origin': 'https://v.iqilu.com', 'Referer': pageUrl, 'Accept': '*/*' }
  const finalUrl = await resolveIqiluMasterToMedia(url, streamHeaders)
  if (!finalUrl) return null

  return {
    url: finalUrl,
    headers: streamHeaders,
  }
}

// ============================================================
// 青岛网络电视台 (www.qtv.com.cn)
// 完整继承 YSPlayer1.5 QtvParser + ArcvideoDecryptor + LocalHttpProxy：
//   1) 抓取频道页提取 channelName
//   2) manifest.m3u8 的 TS 分片为 Arcvideo 加密，需 AES-CBC 解密
//   3) 主密钥从 player.min.js 动态提取 ott+words，后备 "qdxmtottarcvidet"
//   4) 本地 HTTP 代理中转：m3u8 重写为 /seg/<远端URL>，分片解密后回传
// 仅纯 HTTP 逻辑 + 本地解密中转，严禁加载网页。
// ============================================================

const ARCVIDEO_MAGIC = Buffer.from('ARCVIDEO-PROTECTED', 'utf8')
const ARCVIDEO_ZERO_IV = Buffer.alloc(16)
const ARCVIDEO_HEADER_BYTES = 28
const ARCVIDEO_PLAYER_JS_URL = 'http://video10.qtv.com.cn/drm/player.min.js'
const ARCVIDEO_FALLBACK_MASTER_KEY = Buffer.from('qdxmtottarcvidet', 'utf8')

let arcvideoMasterKey = null
let arcvideoMasterKeyFetched = false

function arcvideoHexToBytes(hex) {
  const out = Buffer.alloc(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16)
  return out
}

async function arcvideoFetchMasterKey(ua) {
  if (arcvideoMasterKey) return arcvideoMasterKey
  if (arcvideoMasterKeyFetched) return ARCVIDEO_FALLBACK_MASTER_KEY
  try {
    const resp = await session.defaultSession.fetch(ARCVIDEO_PLAYER_JS_URL, {
      headers: { 'Referer': 'https://www.qtv.com.cn/', 'Accept': '*/*', 'User-Agent': ua },
    })
    if (!resp || resp.status !== 200) { arcvideoMasterKeyFetched = true; return ARCVIDEO_FALLBACK_MASTER_KEY }
    const js = await resp.text()
    const ott = js.match(/ott\s*=\s*"([0-9a-fA-F]+)"/)
    const words = js.match(/words\s*=\s*"([0-9a-fA-F]+)"/)
    if (!ott || !words) { arcvideoMasterKeyFetched = true; return ARCVIDEO_FALLBACK_MASTER_KEY }
    const ottBytes = arcvideoHexToBytes(ott[1])
    const wordsBytes = arcvideoHexToBytes(words[1])
    if (ottBytes.length + wordsBytes.length !== 16) { arcvideoMasterKeyFetched = true; return ARCVIDEO_FALLBACK_MASTER_KEY }
    arcvideoMasterKey = Buffer.concat([ottBytes, wordsBytes])
    arcvideoMasterKeyFetched = true
    return arcvideoMasterKey
  } catch (_) {
    arcvideoMasterKeyFetched = true
    return ARCVIDEO_FALLBACK_MASTER_KEY
  }
}

function arcvideoAesCbcDecrypt(key, data) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, ARCVIDEO_ZERO_IV)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

function arcvideoIsProtected(data) {
  if (!data || data.length < ARCVIDEO_HEADER_BYTES + 16) return false
  for (let i = 0; i < ARCVIDEO_MAGIC.length; i++) {
    if (data[i] !== ARCVIDEO_MAGIC[i]) return false
  }
  return true
}

function arcvideoDecrypt(data, masterKey) {
  if (!arcvideoIsProtected(data)) return data
  try {
    const packetSize = data[19] & 0xff
    const plainLength = ((data[20] & 0xff) << 24) | ((data[21] & 0xff) << 16)
      | ((data[22] & 0xff) << 8) | (data[23] & 0xff)
    if (packetSize === 0 || plainLength === 0 || plainLength % packetSize !== 0) return data

    const keyOffset = ((data[32] & 0xff) + 1) * packetSize
    const cipherLength = Math.ceil(plainLength / 16) * 16
    const keyAt = Math.min(keyOffset, plainLength) + ARCVIDEO_HEADER_BYTES

    if (data.length < keyAt + 16) return data

    const segmentKey = arcvideoAesCbcDecrypt(masterKey, data.subarray(keyAt, keyAt + 16))

    let cipher
    if (keyOffset < cipherLength) {
      const head = ARCVIDEO_HEADER_BYTES + keyOffset
      const tail = head + 16
      if (data.length < tail + (cipherLength - keyOffset)) return data
      const prefix = data.subarray(ARCVIDEO_HEADER_BYTES, head)
      const suffix = data.subarray(tail, tail + (cipherLength - keyOffset))
      cipher = Buffer.concat([prefix, suffix])
    } else {
      cipher = data.subarray(ARCVIDEO_HEADER_BYTES, ARCVIDEO_HEADER_BYTES + cipherLength)
      if (cipher.length % 16 !== 0) return data
    }

    let plain = arcvideoAesCbcDecrypt(segmentKey, cipher)
    if (plain.length > plainLength) plain = plain.subarray(0, plainLength)
    return plain
  } catch (_) { return data }
}

// 本地 HTTP 代理：中转 m3u8 + TS 分片（可选分片解密、可选入口 URL 刷新），
// 仅监听 127.0.0.1，供播放器直接消费。严禁加载网页。
const liveProxies = new Map()

function stopLiveProxy(key) {
  const p = liveProxies.get(key)
  if (p) {
    try { p.server.close() } catch (_) {}
    liveProxies.delete(key)
  }
}

async function createLocalProxy(opts) {
  // opts: { key, m3u8Url, m3u8Base, headers, ua, segmentTransformer, entryRefresher, defaultOrigin, defaultReferer }
  stopLiveProxy(opts.key)
  const M3U8_CACHE_MS = 500
  let m3u8Url = opts.m3u8Url
  const m3u8Base = opts.m3u8Base.endsWith('/') ? opts.m3u8Base : opts.m3u8Base + '/'
  const m3u8QuerySuffix = m3u8Url.includes('?') ? m3u8Url.substring(m3u8Url.indexOf('?')) : ''
  let m3u8Cache = null
  let lastM3u8Fetch = 0

  async function doFetchM3u8() {
    const now = Date.now()
    const resp = await session.defaultSession.fetch(m3u8Url, {
      headers: Object.assign({
        'User-Agent': opts.ua, 'Accept': '*/*', 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache',
      }, opts.headers),
    })
    if (!resp || resp.status !== 200) return null
    m3u8Cache = Buffer.from(await resp.arrayBuffer())
    lastM3u8Fetch = now
    return m3u8Cache
  }

  async function fetchM3u8() {
    const now = Date.now()
    if (m3u8Cache && now - lastM3u8Fetch < M3U8_CACHE_MS) return m3u8Cache
    let result = await doFetchM3u8()
    if (result) return result
    if (opts.entryRefresher) {
      const newUrl = await opts.entryRefresher(m3u8Url)
      if (newUrl && newUrl !== m3u8Url) {
        m3u8Url = newUrl
        result = await doFetchM3u8()
        if (result) return result
      }
    }
    return m3u8Cache
  }

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = (req.url || '').split('?')[0]
      if (pathname === '/proxy.m3u8') {
        const m3u8 = await fetchM3u8()
        if (!m3u8) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not Found'); return }
        const body = m3u8.toString('utf8')
        let out = ''
        for (const line of body.split(/\r?\n/)) {
          if (!line.startsWith('#') && line.trim() !== '') {
            let fullUrl
            if (line.startsWith('http://') || line.startsWith('https://')) fullUrl = line
            else {
              fullUrl = m3u8Base + line
              if (m3u8QuerySuffix && !line.includes('?')) fullUrl += m3u8QuerySuffix
            }
            const encoded = encodeURIComponent(fullUrl)
            out += `http://127.0.0.1:${port}/seg/${encoded}\r\n`
          } else {
            out += line + '\r\n'
          }
        }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': Buffer.byteLength(out),
          'Access-Control-Allow-Origin': '*',
          'Connection': 'close',
        })
        res.end(out)
      } else if (pathname.startsWith('/seg/')) {
        const remoteUrl = decodeURIComponent(pathname.substring(5))
        const resp = await session.defaultSession.fetch(remoteUrl, {
          headers: Object.assign({
            'User-Agent': opts.ua, 'Accept': '*/*',
            'Origin': opts.defaultOrigin || 'https://www.qtv.com.cn',
            'Referer': opts.defaultReferer || 'https://www.qtv.com.cn/',
            'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache',
          }, opts.headers),
        })
        if (!resp || resp.status !== 200) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not Found'); return }
        let segmentData = Buffer.from(await resp.arrayBuffer())
        if (opts.segmentTransformer) segmentData = opts.segmentTransformer(segmentData)
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Content-Length': segmentData.length,
          'Access-Control-Allow-Origin': '*',
          'Connection': 'close',
        })
        res.end(segmentData)
      } else {
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not Found')
      }
    } catch (_) {
      try { res.writeHead(500); res.end('Error') } catch (_e) {}
    }
  })

  let port = 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = server.address().port

  liveProxies.set(opts.key, { server, port })
  return port
}

async function resolveQtvPlayUrl(pageUrl, ua) {
  const headers = { 'User-Agent': ua, 'Referer': 'https://www.qtv.com.cn/', 'Accept': '*/*' }
  const resp = await session.defaultSession.fetch(pageUrl, { headers })
  if (!resp || resp.status !== 200) return null
  const html = await resp.text()

  let channelName = null
  const cn = html.match(/channelName:\s*'([^']+)'/)
  if (cn) channelName = cn[1]
  if (!channelName) {
    const lc = html.toLowerCase()
    for (const name of ['qtv1at', 'qtv2at', 'qtv3at', 'qtv4at', 'qtv6at']) {
      if (lc.includes(name)) { channelName = name; break }
    }
  }
  if (!channelName) {
    const um = pageUrl.match(/tv_qtv(\d+)/)
    if (um) channelName = 'qtv' + um[1] + 'at'
  }
  if (!channelName && pageUrl.includes('/live/tv/')) channelName = 'qtv1at'
  if (!channelName) return null

  const m3u8Url = `http://video10.qtv.com.cn/drm/${channelName}/manifest.m3u8`
  const m3u8Base = `http://video10.qtv.com.cn/drm/${channelName}/`
  const cdnHeaders = {
    'Referer': 'https://www.qtv.com.cn/',
    'Origin': 'https://www.qtv.com.cn',
    'User-Agent': ua,
  }

  const masterKey = await arcvideoFetchMasterKey(ua)

  const m3u8Resp = await session.defaultSession.fetch(m3u8Url, { headers: cdnHeaders })
  if (!m3u8Resp || m3u8Resp.status !== 200) return null

  const port = await createLocalProxy({
    key: 'qtv:' + channelName,
    m3u8Url,
    m3u8Base,
    headers: cdnHeaders,
    ua,
    segmentTransformer: (data) => arcvideoDecrypt(data, masterKey),
    defaultOrigin: 'https://www.qtv.com.cn',
    defaultReferer: 'https://www.qtv.com.cn/',
  })
  return {
    url: `http://127.0.0.1:${port}/proxy.m3u8`,
    headers: { 'Referer': 'https://www.qtv.com.cn/' },
  }
}

// ============================================================
// 澳门莲花卫视 (lotustv.mo)
// 站点真实结构（实测）：
//   1) 官网首页 https://www.lotustv.mo/ 的直播区是跨域 iframe：
//      https://cloud.quklive.com/cloud/a/embed/<activityId>
//   2) 该 embed 页面内联 var videoUrl / var hlsUrl，这才是当前有效的 m3u8：
//      https://play-xxx.quklive.com/live/<activityId>.m3u8?token=...&auth_key=...
//   3) 遗留页 https://www.lotustv.mo/live 仍内联 new QPlayer({url:'...'})，
//      但其中 auth_key 早已过期（实测返回 404），只能作为最后兜底
// 因此解析链路必须是「站点页面 → quklive embed → m3u8」，只读取 HTML 文本，
// 不加载任何浏览器页面；入口 URL 4 分钟缓存，分片地址自带 auth_key 由本地代理透传。
// ============================================================

const LOTUSTV_HOME_PAGE = 'https://www.lotustv.mo/'
const LOTUSTV_LIVE_PAGE = 'https://www.lotustv.mo/live'
const LOTUSTV_ENTRY_TTL_MS = 4 * 60 * 1000
const LOTUSTV_ORIGIN = 'https://www.lotustv.mo'
const LOTUSTV_REFERER = 'https://www.lotustv.mo/'
const LOTUSTV_STREAM_HOST_RE = /^play-[a-z0-9-]+\.quklive\.com$/i
const LOTUSTV_EMBED_PATH_RE = /\/cloud\/a\/embed\/[A-Za-z0-9_-]+/

let lotustvCurrentEntryUrl = null
let lotustvEntryFetchTime = 0

// 统一处理 // 开头、相对路径、以及 JS/JSON 字符串里的 \/ 与 \u002F 转义
function lotustvNormalizeUrl(raw, baseUrl) {
  if (!raw) return null
  let s = String(raw).trim()
  s = s.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/')
  if (!s) return null
  if (s.startsWith('//')) s = 'https:' + s
  if (!/^https?:\/\//i.test(s)) {
    try { s = new URL(s, baseUrl || LOTUSTV_HOME_PAGE).toString() } catch (_) { return null }
  }
  return s
}

// 只接受 quklive 直播 CDN 的 .m3u8（play-xxx.quklive.com/live/xxx.m3u8）
function lotustvIsStreamUrl(url) {
  try {
    const parsed = new URL(url)
    return LOTUSTV_STREAM_HOST_RE.test(parsed.hostname) &&
      /^\/live\//i.test(parsed.pathname) &&
      /\.m3u8$/i.test(parsed.pathname)
  } catch (_) { return false }
}

// 从页面文本里提取候选流地址：既覆盖 QPlayer({url:...}) 配置，也覆盖 embed 页的
// var videoUrl / var hlsUrl 变量，以及任何裸露的 quklive 直播 m3u8
function lotustvExtractStreamUrls(html, baseUrl) {
  if (!html) return []
  const out = []
  const push = (raw) => {
    const full = lotustvNormalizeUrl(raw, baseUrl)
    if (full && lotustvIsStreamUrl(full) && out.indexOf(full) === -1) out.push(full)
  }

  const kvRe = /(?:videoUrl|hlsUrl|playUrl|m3u8Url|m3u8|url|src)\s*[:=]\s*["'`]([^"'`\s<>]+)["'`]/gi
  let m
  while ((m = kvRe.exec(html)) !== null) push(m[1])

  const rawRe = /(?:https?:)?\/\/[a-z0-9-]+\.quklive\.com\/live\/[^\s"'`<>\\]+/gi
  while ((m = rawRe.exec(html)) !== null) push(m[0])

  return out
}

function lotustvExtractEmbedUrls(html, baseUrl) {
  if (!html) return []
  const out = []
  const add = (raw) => {
    const full = lotustvNormalizeUrl(raw, baseUrl)
    if (full && out.indexOf(full) === -1) out.push(full)
  }
  const abs = html.match(/(?:https?:)?\/\/[a-z0-9-]+\.quklive\.com\/cloud\/a\/embed\/[A-Za-z0-9_-]+/gi) || []
  for (const u of abs) add(u)
  const rel = html.match(/\/cloud\/a\/embed\/[A-Za-z0-9_-]+/g) || []
  for (const u of rel) add('https://cloud.quklive.com' + u)
  return out
}

async function lotustvFetchHtml(url, ua) {
  let referer = LOTUSTV_REFERER
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host.indexOf('quklive.com') !== -1) referer = 'https://cloud.quklive.com/'
  } catch (_) {}
  try {
    const resp = await session.defaultSession.fetch(url, {
      headers: {
        'User-Agent': ua,
        'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Cache-Control': 'no-cache, no-store',
      },
    })
    if (!resp || resp.status !== 200) return null
    return await resp.text()
  } catch (_) { return null }
}

// auth_key 失效时上游会返回 404/403；必须校验正文确实是 HLS 播放列表，
// 否则会建出一个只会返回 404 的本地代理
async function lotustvProbeStream(url, ua) {
  try {
    const resp = await session.defaultSession.fetch(url, {
      headers: {
        'User-Agent': ua,
        'Referer': LOTUSTV_REFERER,
        'Accept': 'application/vnd.apple.mpegurl, */*',
      },
    })
    if (!resp || resp.status !== 200) return false
    const text = await resp.text()
    return /#EXTM3U/i.test(text)
  } catch (_) { return false }
}

async function lotustvResolveEntryUrl(pageUrl, ua) {
  const pages = []
  const addPage = (u) => { if (u && pages.indexOf(u) === -1) pages.push(u) }
  const embeds = []
  const addEmbed = (u) => { if (u && embeds.indexOf(u) === -1) embeds.push(u) }

  if (pageUrl) {
    if (LOTUSTV_EMBED_PATH_RE.test(pageUrl)) addEmbed(lotustvNormalizeUrl(pageUrl, LOTUSTV_HOME_PAGE))
    else addPage(pageUrl)
  }
  addPage(LOTUSTV_HOME_PAGE)
  addPage(LOTUSTV_LIVE_PAGE)

  const embedStreams = []
  const pageStreams = []
  const addStream = (list, url) => { if (list.indexOf(url) === -1) list.push(url) }

  for (const page of pages) {
    const html = await lotustvFetchHtml(page, ua)
    if (!html) continue
    for (const s of lotustvExtractStreamUrls(html, page)) addStream(pageStreams, s)
    for (const e of lotustvExtractEmbedUrls(html, page)) addEmbed(e)
  }

  // embed 页面里的 videoUrl 是当前最新签名的地址，优先级高于站点页面内联的旧地址
  for (const embed of embeds) {
    const html = await lotustvFetchHtml(embed, ua)
    if (!html) continue
    for (const s of lotustvExtractStreamUrls(html, embed)) addStream(embedStreams, s)
  }

  for (const cand of embedStreams.concat(pageStreams)) {
    if (await lotustvProbeStream(cand, ua)) return cand
  }
  return null
}

async function lotustvFetchEntryUrl(ua, forceRefresh, pageUrl) {
  if (!forceRefresh) {
    const now = Date.now()
    if (lotustvCurrentEntryUrl && (now - lotustvEntryFetchTime) < LOTUSTV_ENTRY_TTL_MS) {
      return lotustvCurrentEntryUrl
    }
  }
  const entry = await lotustvResolveEntryUrl(pageUrl, ua)
  // 解析整体失败时保留旧缓存（可能只是上游临时 5xx），由调用方探测决定是否可用
  if (!entry) return lotustvCurrentEntryUrl
  lotustvCurrentEntryUrl = entry
  lotustvEntryFetchTime = Date.now()
  return entry
}

async function resolveLotustvPlayUrl(pageUrl, ua) {
  let hlsUrl = await lotustvFetchEntryUrl(ua, false, pageUrl)
  if (!hlsUrl) return null

  // 缓存中的地址可能已随 auth_key 过期，此时强制重新走一遍页面→embed 解析
  if (!(await lotustvProbeStream(hlsUrl, ua))) {
    hlsUrl = await lotustvFetchEntryUrl(ua, true, pageUrl)
    if (!hlsUrl || !(await lotustvProbeStream(hlsUrl, ua))) return null
  }

  const m3u8Base = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1)
  const cdnHeaders = {
    'Referer': LOTUSTV_REFERER,
    'User-Agent': ua,
    'Accept': 'application/vnd.apple.mpegurl, */*',
  }

  const port = await createLocalProxy({
    key: 'lotustv',
    m3u8Url: hlsUrl,
    m3u8Base,
    headers: cdnHeaders,
    ua,
    defaultOrigin: LOTUSTV_ORIGIN,
    defaultReferer: LOTUSTV_REFERER,
    entryRefresher: async () => lotustvFetchEntryUrl(ua, true, pageUrl),
  })

  return {
    url: `http://127.0.0.1:${port}/proxy.m3u8`,
    headers: { 'Referer': LOTUSTV_REFERER },
  }
}


// ============================================================
// 芒果TV (mgtv.com)
// 完整继承 YSPlayer1.5 MgtvParser：
//   1) live/source API，MD5 签名 = SIGN_SECRET + 排序后 key+value 串 + SIGN_SECRET（大写）
//   2) 从 sources 选 definition 最高、同档优先 H.264 的 .m3u8
//   3) 校验域名白名单（mgtv.com / hitv.com / imgo.tv）
// ============================================================

const MGTV_LIVE_SOURCE_URL = 'https://pwlp.bz.mgtv.com/v1/live/source'
// 【测试】硬编码兜底值已注释：抓取失败时密钥为 null，签名直接失效以便暴露问题。
// const MGTV_SIGN_SECRET = 'LMFwh1k1m@pvt#Pt'
const MGTV_DEVICE_ID = crypto.randomUUID()

// ---- 签名密钥自动抓取 ----
const MGTV_PAGE_URL = 'https://www.mgtv.com/l/1000278.html'
const MGTV_VPLAYER_URL_BASE = 'https://s1.hitv.com/libs/vplayer/'
const MGTV_SIGN_SECRET_CACHE_TTL_MS = 30 * 60 * 1000
const MGTV_VPLAYER_VERSION_PAT = /vplayer\/([0-9.]+)\/vplayer\.min\.js/
const MGTV_SECRET_PAT = /clientSecret[^;]{0,120}?:"([^"]+)"/

let mgtvSignSecret = null               // 当前生效密钥（仅自动抓取成功后被更新；测试期无硬编码兜底）
let mgtvSignSecretCheckedAt = 0
let mgtvSignSecretPromise = null

const MGTV_CHANNEL_NAMES = {
  '2778': '湖南卫视',
  '287': '金鹰卡通',
  '280': '湖南经视',
  '344': '湖南娱乐',
  '221': '湖南电影',
  '346': '湖南都市',
  '484': '湖南电视剧',
  '316': '金鹰纪实',
  '261': '湖南爱晚',
  '229': '湖南国际',
  '218': '快乐垂钓',
  '269': '长沙新闻综合',
  '254': '长沙政法',
}

const MGTV_SLUG_TO_ID = [
  ['287', '287'],
  ['hunan', '2778'],
  ['jingji', '280'],
  ['yule', '344'],
  ['dianying', '221'],
  ['dushi', '346'],
  ['dianshiju', '484'],
  ['jinian', '316'],
  ['aiwan', '261'],
  ['guoji', '229'],
  ['chuidiao', '218'],
  ['changsha1', '269'],
  ['changsha2', '254'],
]

function mgtvMatchChannelId(url) {
  if (!url) return '287'
  // 1) 优先从查询参数提取 cameraId: /live/?cameraId=484
  const qsM = url.match(/[?&]cameraId=(\d{3,4})(&|$)/i)
  if (qsM && qsM[1] && MGTV_CHANNEL_NAMES[qsM[1]]) return qsM[1]
  // 2) 匹配芒果TV /z/activityId/cameraId 旧路由格式
  const m = url.match(/\/z\/\d+\/(\d{3,4})(\/|$)/)
  if (m && m[1] && MGTV_CHANNEL_NAMES[m[1]]) return m[1]
  // 3) 兜底：URL 末尾提取 3-4 位数字 cameraId（兼容旧的 /live/cameraId/ 格式）
  const m2 = url.match(/\/(\d{3,4})\/?$/)
  if (m2 && m2[1] && MGTV_CHANNEL_NAMES[m2[1]]) return m2[1]
  // 4) 兼容 slug 形式（hunan/jingji/dushi/...）
  const lower = url.toLowerCase()
  for (const [slug, id] of MGTV_SLUG_TO_ID) {
    if (lower.includes(slug)) return id
  }
  return '287'
}

function mgtvBuildRawParams(channelId) {
  return {
    cameraId: channelId,
    activityId: '',
    platform: '4',
    appVersion: 'imgotv-pch5-1.2.3',
    clientKey: 'pcweb',
    auth_mode: '1',
    local_definition: '',
    init_definition: '2',
    did: MGTV_DEVICE_ID,
    uid: '',
    token: '',
    _t: String(Date.now()),
    deviceId: MGTV_DEVICE_ID,
    hdts: 'h265,h264',
    lls: '1',
    supportFlv: '1',
  }
}

async function mgtvHttpGetText(url) {
  try {
    const resp = await session.defaultSession.fetch(url, { headers: { 'Accept': '*/*' } })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

// 两步自动抓取签名密钥：频道页 HTML -> vplayer.min.js，密钥以明文 clientSecret 出现
async function mgtvFetchSignSecret() {
  const html = await mgtvHttpGetText(MGTV_PAGE_URL)
  if (!html) return null
  const verMatch = html.match(MGTV_VPLAYER_VERSION_PAT)
  if (!verMatch) return null

  const vplayerJs = await mgtvHttpGetText(MGTV_VPLAYER_URL_BASE + verMatch[1] + '/vplayer.min.js')
  if (!vplayerJs) return null
  const secretMatch = vplayerJs.match(MGTV_SECRET_PAT)
  return secretMatch ? secretMatch[1] : null
}

// 带冷却期与并发去重的密钥刷新；抓取失败时沿用现有密钥（测试期初始为 null）
async function mgtvEnsureSignSecret() {
  const now = Date.now()
  if (mgtvSignSecretCheckedAt && now - mgtvSignSecretCheckedAt < MGTV_SIGN_SECRET_CACHE_TTL_MS) {
    return mgtvSignSecret
  }
  if (mgtvSignSecretPromise) return mgtvSignSecretPromise
  mgtvSignSecretPromise = (async () => {
    try {
      const s = await mgtvFetchSignSecret()
      if (s) mgtvSignSecret = s
    } catch (_) { /* 抓取失败则沿用现有密钥 */ }
    finally {
      mgtvSignSecretCheckedAt = Date.now()
      mgtvSignSecretPromise = null
    }
    return mgtvSignSecret
  })()
  return mgtvSignSecretPromise
}

function mgtvSignRawParams(params, secret) {
  const keys = Object.keys(params).sort()
  let flat = ''
  for (const k of keys) {
    const v = params[k]
    if (v != null) flat += k + v
  }
  return md5Hex(secret + flat + secret).toUpperCase()
}

function mgtvBuildQuery(params) {
  const keys = Object.keys(params).sort()
  const parts = []
  for (const k of keys) {
    let v = params[k]
    if (v == null) v = ''
    parts.push(k + '=' + encodeURIComponent(v))
  }
  return parts.join('&')
}

function mgtvIsOfficialStreamUrl(raw) {
  if (!raw) return false
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return false
    if (!u.pathname.toLowerCase().endsWith('.m3u8')) return false
    const host = u.hostname
    return host === 'mgtv.com' || host.endsWith('.mgtv.com')
      || host === 'hitv.com' || host.endsWith('.hitv.com')
      || host === 'imgo.tv' || host.endsWith('.imgo.tv')
  } catch (_) { return false }
}

function mgtvSelectHighestSource(data) {
  if (!data) return null
  const sources = data.sources || []
  const candidates = []
  for (const s of sources) {
    if (!s) continue
    const fmt = (s.format || '').toLowerCase()
    if (fmt !== '.m3u8') continue
    const rawUrl = s.url || ''
    if (!rawUrl) continue
    if (!mgtvIsOfficialStreamUrl(rawUrl)) continue
    candidates.push(s)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const aDef = a.definition || 0
    const bDef = b.definition || 0
    if (aDef !== bDef) return bDef - aDef
    const aH264 = /(h264|avc)/i.test(a.videoFormat || '')
    const bH264 = /(h264|avc)/i.test(b.videoFormat || '')
    return (bH264 ? 1 : 0) - (aH264 ? 1 : 0)
  })
  return candidates[0].url || null
}

async function mgtvFetchLiveSource(channelId, ua) {
  const secretPromise = mgtvEnsureSignSecret() // 并行刷新签名密钥，签名前 await 即可
  const params = mgtvBuildRawParams(channelId)
  const secret = await secretPromise
  const sign = mgtvSignRawParams(params, secret)
  const url = `${MGTV_LIVE_SOURCE_URL}?${mgtvBuildQuery(params)}&_support=10000000&sign=${sign}`
  const headers = {
    'User-Agent': ua, 'Origin': 'https://www.mgtv.com', 'Referer': 'https://www.mgtv.com/', 'Accept': 'application/json',
  }
  const resp = await session.defaultSession.fetch(url, { headers })
  if (!resp || resp.status !== 200) return null
  const root = await resp.json()
  if ((root.code ?? -1) !== 0) return null
  return mgtvSelectHighestSource(root.data)
}

async function resolveMgtvPlayUrl(pageUrl, ua) {
  const channelId = mgtvMatchChannelId(pageUrl)
  const m3u8Url = await mgtvFetchLiveSource(channelId, ua)
  if (!m3u8Url) return null
  return {
    url: m3u8Url,
    headers: { 'User-Agent': ua, 'Origin': 'https://www.mgtv.com', 'Referer': 'https://www.mgtv.com/' },
  }
}

// ============================================================
// 看看新闻 (kankanews.com, SMG)
// 完整继承 YSPlayer1.5 KankanewsParser：
//   1) kapi 签名头：platform/version/nonce/timestamp/Api-Version/业务参数
//      排序后 key=value& 拼接 + SIGN_SALT，MD5 两次
//   2) live_address 为 RSA 公钥加密（RSA/ECB/NoPadding + PKCS#1 v1.5 签名块去填充）
//   3) 流 token 绑定出口 IP 与 UA，必须本地代理中转并定时刷新签名 URL
// ============================================================

const KANKANEWS_UA_DESKTOP = BROWSER_UA
const KANKANEWS_CHANNEL_DETAIL_URL = 'https://kapi.kankanews.com/content/pc/tv/channel/detail'
const KANKANEWS_PROGRAM_LIST_URL = 'https://kapi.kankanews.com/content/pc/tv/programs'
const KANKANEWS_PROGRAM_DETAIL_URL = 'https://kapi.kankanews.com/content/pc/tv/program/detail'
// const KANKANEWS_SIGN_SALT = '28c8edde3d61a0411511d3b1866f0636'
const KANKANEWS_APP_VERSION = '2.45.2'
const KANKANEWS_API_VERSION = 'v1'
const KANKANEWS_NONCE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const KANKANEWS_UUID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const KANKANEWS_DEFAULT_REFRESH_MS = 150 * 1000
const KANKANEWS_DETAIL_RETRY_MS = 60 * 1000
const KANKANEWS_EXPIRY_SKEW_MS = 5 * 60 * 1000

// ---- 签名盐自动抓取：首页 HTML -> app.<version>.js，盐以 +="<32位hex>" 形式出现 ----
const KANKANEWS_PAGE_URL = 'https://live.kankanews.com/huikan/'
const KANKANEWS_SIGN_SALT_CACHE_TTL_MS = 30 * 60 * 1000
const KANKANEWS_APP_JS_PAT = /\/_knews_nuxt\/js\/app\.v[\d.]+\.js/
const KANKANEWS_SIGN_SALT_PAT = /\+="([0-9a-f]{32})"/

let kankanewsSignSalt = null        // 当前生效盐（仅自动抓取成功后更新；测试期无硬编码兜底）
let kankanewsSignSaltCheckedAt = 0
let kankanewsSignSaltPromise = null

const KANKANEWS_STREAM_PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDP5hzPUW5RFeE2xBT1ERB3hHZI\n' +
  'Votn/qatWhgc1eZof09qKjElFN6Nma461ZAwGpX4aezKP8Adh4WJj4u2O54xCXDt\n' +
  'wzKRqZO2oNZkuNmF2Va8kLgiEQAAcxYc8JgTN+uQQNpsep4n/o1sArTJooZIF17E\n' +
  'tSqSgXDcJ7yDj5rc7wIDAQAB\n' +
  '-----END PUBLIC KEY-----'

const KANKANEWS_CHANNELS = [
  { id: '1', name: '东方卫视' },
  { id: '2', name: '上海新闻综合' },
  { id: '11', name: '魔都眼' },
  { id: '5', name: '第一财经' },
  { id: '12', name: '新纪实' },
  { id: '10', name: '五星体育' },
  { id: '4', name: '上海都市' },
  { id: '9', name: '哈哈炫动' },
]

// 官网明确停供（版权屏蔽/无当前节目/无地址）时不能沿用旧 token；
// 只有临时网络故障才允许复用尚有效的缓存。
class KankanewsChannelUnavailableError extends Error {}

const kankanewsDetailCache = new Map()
let kankanewsDeviceUuid = null

function kankanewsRandomString(length, alphabet) {
  let s = ''
  for (let i = 0; i < length; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

function kankanewsGetDeviceUuid() {
  if (!kankanewsDeviceUuid) kankanewsDeviceUuid = kankanewsRandomString(21, KANKANEWS_UUID_ALPHABET)
  return kankanewsDeviceUuid
}

async function kankanewsHttpGetText(url) {
  try {
    const resp = await session.defaultSession.fetch(url, { headers: { 'Accept': '*/*' } })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

// 两步自动抓取签名盐：首页 HTML -> app.<version>.js，盐以 +="<32位hex>" 形式出现
async function kankanewsFetchSignSalt() {
  const html = await kankanewsHttpGetText(KANKANEWS_PAGE_URL)
  if (!html) return null
  const jsMatch = html.match(KANKANEWS_APP_JS_PAT)
  if (!jsMatch) return null
  const appJs = await kankanewsHttpGetText('https://live.kankanews.com' + jsMatch[0])
  if (!appJs) return null
  const saltMatch = appJs.match(KANKANEWS_SIGN_SALT_PAT)
  return saltMatch ? saltMatch[1] : null
}

// 带冷却期与并发去重的盐刷新；抓取失败时沿用现有盐（测试期初始为 null）
async function kankanewsEnsureSignSalt() {
  const now = Date.now()
  if (kankanewsSignSaltCheckedAt && now - kankanewsSignSaltCheckedAt < KANKANEWS_SIGN_SALT_CACHE_TTL_MS) {
    return kankanewsSignSalt
  }
  if (kankanewsSignSaltPromise) return kankanewsSignSaltPromise
  kankanewsSignSaltPromise = (async () => {
    try {
      const s = await kankanewsFetchSignSalt()
      if (s) kankanewsSignSalt = s
    } catch (_) { /* 抓取失败则沿用现有盐 */ }
    finally {
      kankanewsSignSaltCheckedAt = Date.now()
      kankanewsSignSaltPromise = null
    }
    return kankanewsSignSalt
  })()
  return kankanewsSignSaltPromise
}

async function kankanewsBuildSignedHeaders(extraParams, nonce, uuid, nowMs) {
  const salt = await kankanewsEnsureSignSalt()
  const all = {
    platform: 'pc',
    version: KANKANEWS_APP_VERSION,
    nonce,
    timestamp: String(Math.floor(nowMs / 1000)),
    'Api-Version': KANKANEWS_API_VERSION,
  }
  for (const [k, v] of extraParams) all[k] = v
  const keys = Object.keys(all).sort()
  let canonical = ''
  for (const k of keys) canonical += `${k}=${all[k]}&`
  canonical += (salt || '')
  const sign = md5Hex(md5Hex(canonical))
  return {
    nonce,
    timestamp: all.timestamp,
    sign,
    'm-uuid': uuid,
    'Api-Version': KANKANEWS_API_VERSION,
    platform: 'pc',
    version: KANKANEWS_APP_VERSION,
    Accept: 'application/json',
    Origin: 'https://live.kankanews.com',
    Referer: 'https://live.kankanews.com/huikan/',
  }
}

function kankanewsFindChannel(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.search) {
      for (const part of u.search.substring(1).split('&')) {
        if (part.startsWith('id=')) {
          const id = part.substring(3)
          for (const def of KANKANEWS_CHANNELS) if (def.id === id) return def
        }
      }
    }
  } catch (_) {}
  return KANKANEWS_CHANNELS[0]
}

function kankanewsUnpadSignedBlock(block) {
  if (block.length < 12 || block[0] !== 0 || block[1] !== 1) throw new Error('RSA signed block header invalid')
  let separator = 2
  while (separator < block.length && block[separator] === 0xFF) separator++
  if (separator < 10 || block[separator] !== 0) throw new Error('RSA signed block padding invalid')
  return block.subarray(separator + 1)
}

function kankanewsDecryptLiveAddress(encrypted) {
  if (!encrypted || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error('invalid encrypted play_url format')
  const blockSize = 128
  const data = Buffer.from(encrypted, 'base64')
  if (data.length === 0 || data.length % blockSize !== 0) throw new Error('encrypted data block alignment error')
  const out = []
  for (let offset = 0; offset < data.length; offset += blockSize) {
    const block = crypto.publicDecrypt(
      { key: KANKANEWS_STREAM_PUBLIC_KEY_PEM, padding: crypto.constants.RSA_NO_PADDING },
      data.subarray(offset, offset + blockSize))
    out.push(kankanewsUnpadSignedBlock(block))
  }
  return Buffer.concat(out).toString('utf8')
}

function kankanewsIsValidStreamUrl(raw) {
  if (!raw) return false
  try {
    const u = new URL(raw)
    const host = u.hostname
    if (host !== 'kksmg.com' && !host.endsWith('.kksmg.com')) return false
    if (!u.pathname.toLowerCase().endsWith('.m3u8')) return false
    if (!u.search) return false
    return true
  } catch (_) { return false }
}

function kankanewsStreamExpiry(rawUrl) {
  try {
    const u = new URL(rawUrl)
    const token = u.searchParams.get('token')
    if (!token) return 0
    const parts = token.split('.')
    if (parts.length < 2) return 0
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8')
    const jwt = JSON.parse(payload)
    const exp = jwt.exp || 0
    return exp > 0 ? exp * 1000 : 0
  } catch (_) { return 0 }
}

async function kankanewsFetchProgramAddress(def, uuid, ua, now) {
  const date = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const nonce = kankanewsRandomString(8, KANKANEWS_NONCE_ALPHABET)
  // 节目单/节目详情验签与随后代理分片必须用同一个 UA：
  // 官网把 UA 的 MD5 写进播放 token，混用移动端 UA 会导致 CDN 403。
  const progListHeaders = await kankanewsBuildSignedHeaders([['channel_id', def.id], ['date', date]], nonce, uuid, now)
  progListHeaders['User-Agent'] = ua || KANKANEWS_UA_DESKTOP

  const listResp = await session.defaultSession.fetch(`${KANKANEWS_PROGRAM_LIST_URL}?channel_id=${def.id}&date=${date}`, { headers: progListHeaders })
  if (!listResp || listResp.status !== 200) throw new Error('program list HTTP ' + (listResp && listResp.status))
  const listPayload = await listResp.json()
  if (listPayload.code !== '1000') throw new Error('program list code: ' + listPayload.code)
  const programs = (listPayload.result && listPayload.result.programs) || []
  if (!Array.isArray(programs) || !programs.length) throw new KankanewsChannelUnavailableError('官网节目单中没有当前正在播出的节目')

  // 与官网一致：直接取第一个落在当前时间窗口内的节目，再单独判断版权屏蔽。
  const currentProgram = programs.find(prog => prog.id
    && Number(prog.start_time) * 1000 <= now && now < Number(prog.end_time) * 1000)
  if (!currentProgram) throw new KankanewsChannelUnavailableError('官网节目单中没有当前正在播出的节目')
  const programEnd = Number(currentProgram.end_time) * 1000
  if (Number(currentProgram.is_shield) === 1) {
    throw new KankanewsChannelUnavailableError(`当前节目「${currentProgram.name || '未命名'}」因版权限制，官网暂停网络直播`)
  }

  const programId = currentProgram.id || ''
  if (!programId) throw new Error('program id is empty')

  const detailHeaders = await kankanewsBuildSignedHeaders([['channel_program_id', programId]], kankanewsRandomString(8, KANKANEWS_NONCE_ALPHABET), uuid, now)
  detailHeaders['User-Agent'] = ua || KANKANEWS_UA_DESKTOP

  const detailResp = await session.defaultSession.fetch(`${KANKANEWS_PROGRAM_DETAIL_URL}?channel_program_id=${programId}`, { headers: detailHeaders })
  if (!detailResp || detailResp.status !== 200) throw new Error('program detail HTTP ' + (detailResp && detailResp.status))
  const detailPayload = await detailResp.json()
  if (detailPayload.code !== '1000') throw new Error('program detail code: ' + detailPayload.code)
  const detailResult = detailPayload.result
  if (!detailResult) throw new Error('no result in program detail')
  const channelInfo = detailResult.channel_info
  if (!channelInfo) throw new Error('no channel_info in program detail')
  if (String(channelInfo.id) !== def.id || String(detailResult.channel_id) !== def.id) {
    throw new Error('program detail channel id mismatch')
  }
  if (Number(detailResult.is_shield) === 1) {
    throw new KankanewsChannelUnavailableError(`当前节目「${currentProgram.name || '未命名'}」因版权限制，官网暂停网络直播`)
  }
  return { liveAddress: channelInfo.live_address || '', programEnd }
}

async function kankanewsFetchDetail(def, ua, now) {
  const nonce = kankanewsRandomString(8, KANKANEWS_NONCE_ALPHABET)
  const uuid = kankanewsGetDeviceUuid()
  const signedHeaders = await kankanewsBuildSignedHeaders([['channel_id', def.id]], nonce, uuid, now)
  signedHeaders['User-Agent'] = ua || KANKANEWS_UA_DESKTOP

  const resp = await session.defaultSession.fetch(`${KANKANEWS_CHANNEL_DETAIL_URL}?channel_id=${def.id}`, { headers: signedHeaders })
  if (!resp || resp.status !== 200) throw new Error('API HTTP ' + (resp && resp.status))
  const payload = await resp.json()
  if (payload.code !== '1000') throw new Error('API code: ' + payload.code)
  const result = payload.result
  if (!result) throw new Error('no result in API response')

  let liveAddress = null
  let programEnd = 0
  if (Number(result.is_exist_program) === 1) {
    // 官网有节目单的频道已不再从频道详情发放地址，需查当前节目读
    // program/detail.channel_info.live_address。此处不回退频道详情的空地址。
    const program = await kankanewsFetchProgramAddress(def, uuid, ua, now)
    liveAddress = program.liveAddress
    programEnd = program.programEnd
  } else {
    liveAddress = result.live_address || ''
  }
  if (!liveAddress) throw new KankanewsChannelUnavailableError('官网当前未提供直播地址，请稍后重试')

  const decrypted = kankanewsDecryptLiveAddress(liveAddress)
  if (!kankanewsIsValidStreamUrl(decrypted)) throw new Error('invalid stream URL')

  const tokenExpiry = kankanewsStreamExpiry(decrypted)
  const apiTtlMs = Math.max(30 * 1000, (result.limit_time || 180) * 1000 - 30 * 1000)
  // 有效期同时受 token 过期时间与节目结束时间约束，避免跨节目沿用旧流。
  const validUntil = Math.min(tokenExpiry > 0 ? tokenExpiry : now + 30 * 60 * 1000, programEnd || Infinity)

  return {
    streamUrl: decrypted,
    validUntil,
    refreshAt: Math.min(now + Math.min(KANKANEWS_DEFAULT_REFRESH_MS, apiTtlMs), validUntil),
    retryAt: 0,
  }
}

async function kankanewsGetStreamUrl(def, ua, forceRefresh) {
  const now = Date.now()
  if (!forceRefresh) {
    const cache = kankanewsDetailCache.get(def.id)
    if (cache && cache.validUntil > now && (cache.refreshAt > now || cache.retryAt > now)) return cache.streamUrl
  }
  try {
    const fresh = await kankanewsFetchDetail(def, ua, now)
    kankanewsDetailCache.set(def.id, fresh)
    return fresh.streamUrl
  } catch (e) {
    // 官网明确停供（版权屏蔽/无当前节目/无地址）时不能沿用旧 token，直接失败；
    // 只有临时网络故障才允许复用尚有效的缓存。
    if (e instanceof KankanewsChannelUnavailableError) {
      kankanewsDetailCache.delete(def.id)
      return null
    }
    if (!forceRefresh) {
      const cache = kankanewsDetailCache.get(def.id)
      if (cache && cache.validUntil > now + KANKANEWS_EXPIRY_SKEW_MS) {
        cache.retryAt = now + KANKANEWS_DETAIL_RETRY_MS
        return cache.streamUrl
      }
    }
  }
  return null
}

async function resolveKankanewsPlayUrl(pageUrl, ua) {
  let def = kankanewsFindChannel(pageUrl)
  if (!def) def = KANKANEWS_CHANNELS[0]
  stopLiveProxy('kankanews:' + def.id)

  const streamUrl = await kankanewsGetStreamUrl(def, ua, false)
  if (!streamUrl) return null

  const cdnHeaders = {
    'User-Agent': ua,
    'Referer': 'https://live.kankanews.com/huikan/',
    'Origin': 'https://live.kankanews.com',
    'Accept': 'application/vnd.apple.mpegurl, */*',
  }

  // 部分频道（如上海都市）的流地址是 master 变体列表，其内部媒体播放列表的
  // 分片为相对路径。若不先下钻到真正的媒体播放列表，本地代理会把这些相对分片
  // 解析到 /seg/ 目录而 404。这里复用广西台的下钻逻辑，master 则下钻到 media，
  // 本身就是 media 播放列表时原样返回（其余频道不受影响）。
  const mediaUrl = (await gxtvResolveMediaPlaylist(streamUrl, cdnHeaders)) || streamUrl
  const m3u8Base = mediaUrl.substring(0, mediaUrl.lastIndexOf('/') + 1)

  const port = await createLocalProxy({
    key: 'kankanews:' + def.id,
    m3u8Url: mediaUrl,
    m3u8Base,
    headers: cdnHeaders,
    ua,
    defaultOrigin: 'https://live.kankanews.com',
    defaultReferer: 'https://live.kankanews.com/huikan/',
    entryRefresher: async () => {
      const newMaster = await kankanewsGetStreamUrl(def, ua, true)
      if (!newMaster) return null
      return (await gxtvResolveMediaPlaylist(newMaster, cdnHeaders)) || newMaster
    },
  })
  return {
    url: `http://127.0.0.1:${port}/proxy.m3u8`,
    headers: { 'Referer': 'https://live.kankanews.com/huikan/' },
  }
}

// ============================================================
// 福建网络广播电视台 (live.fjtv.net)
// 完整继承 YSPlayer1.5 FjtvParser：
//   channel_info.php API，MD5 签名 = md5(API_KEY&API_SECRET&API_VERSION&timestamp)
//   请求头携带 X-API-* 鉴权；流地址校验域名白名单 + 路径 + _upt 参数
// ============================================================

const FJTV_API_URL = 'https://live.fjtv.net/m2o/channel/channel_info.php'
const FJTV_API_KEY = '877a9ba7a98f75b90a9d49f53f15a858'
const FJTV_API_SECRET = '68a04b8177bdc9e5e16a89e6777a7b66'
const FJTV_API_VERSION = '1.0.0'
const FJTV_MEDIA_HOSTS = new Set(['live1-fuyun.fjtv.net', 'live2-fuyun.fjtv.net'])
const FJTV_EXPIRY_GUARD_MS = 60 * 1000
const FJTV_UA = BROWSER_UA

const FJTV_PROVINCE_CHANNELS = [
  { id: '665248990102917120', rawName: '综合频道', displayName: '福建综合', path: 'zhpd/hd' },
  { id: '665248966136664064', rawName: '东南卫视', displayName: '东南卫视', path: 'dnpd/hd' },
  { id: '665248914378952704', rawName: '新闻频道', displayName: '福建新闻', path: 'xwpd/hd' },
  { id: '665248752898248704', rawName: '文旅·体育频道', displayName: '福建文旅体育', path: 'dspd/hd' },
  { id: '665248553475870720', rawName: '少儿频道', displayName: '福建少儿', path: 'child/hd' },
  { id: '665248523855695872', rawName: '海峡卫视', displayName: '海峡卫视', path: 'haixiapd/hd' },
]

const FJTV_PATH_TO_CHANNEL = {
  zhpd: FJTV_PROVINCE_CHANNELS[0],
  setv: FJTV_PROVINCE_CHANNELS[1],
  dnpd: FJTV_PROVINCE_CHANNELS[1],
  xwpd: FJTV_PROVINCE_CHANNELS[2],
  dspd: FJTV_PROVINCE_CHANNELS[3],
  sepd: FJTV_PROVINCE_CHANNELS[4],
  child: FJTV_PROVINCE_CHANNELS[4],
  hxtv: FJTV_PROVINCE_CHANNELS[5],
  haixiapd: FJTV_PROVINCE_CHANNELS[5],
}

const fjtvCache = new Map()

function fjtvExtractPathSegment(url) {
  const m = /live\.fjtv\.net\/([a-z]+)\/?/.exec(url)
  return m ? m[1] : null
}

function fjtvGetQueryParam(query, key) {
  if (!query || !key) return null
  for (const pair of query.split('&')) {
    const idx = pair.indexOf('=')
    if (idx > 0 && key === pair.substring(0, idx)) return pair.substring(idx + 1)
  }
  return null
}

function fjtvValidateStream(raw, expectedPath) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    if (!FJTV_MEDIA_HOSTS.has(u.hostname)) return null
    const expectedFull = '/' + expectedPath + '/live.m3u8'
    if (expectedFull !== u.pathname) return null
    const upt = fjtvGetQueryParam(u.search.substring(1), '_upt')
    if (!upt) return null
    if (!/^[0-9a-f]{8}[0-9]{10}$/i.test(upt)) return null
    return raw
  } catch (_) { return null }
}

function fjtvExtractExpiry(url) {
  try {
    const u = new URL(url)
    const upt = fjtvGetQueryParam(u.search.substring(1), '_upt')
    if (upt && upt.length >= 10) {
      const ts = upt.substring(upt.length - 10)
      return parseInt(ts, 10) * 1000
    }
  } catch (_) {}
  return Date.now() + 60 * 1000
}

async function fjtvGetSignedStream(ch) {
  const now = Date.now()
  const cached = fjtvCache.get(ch.id)
  if (cached && cached.expiresAt > now + FJTV_EXPIRY_GUARD_MS) return cached.url

  const timestamp = String(Math.floor(now / 1000))
  const raw = `${FJTV_API_KEY}&${FJTV_API_SECRET}&${FJTV_API_VERSION}&${timestamp}`
  const signature = md5Hex(raw)

  const headers = {
    'User-Agent': BROWSER_UA,
    'X-API-TIMESTAMP': timestamp,
    'X-API-KEY': FJTV_API_KEY,
    'X-AUTH-TYPE': 'md5',
    'X-API-VERSION': FJTV_API_VERSION,
    'X-API-SIGNATURE': signature,
    'Accept': 'application/json, text/plain, */*',
  }
  const url = `${FJTV_API_URL}?channel_id=${ch.id}`

  const resp = await session.defaultSession.fetch(url, { headers })
  if (!resp || resp.status !== 200) {
    if (cached) return cached.url
    throw new Error('API HTTP ' + (resp && resp.status))
  }
  let arr
  try { arr = await resp.json() } catch (_) {
    if (cached) return cached.url
    throw new Error('API 返回非 JSON')
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    if (cached) return cached.url
    throw new Error('API 返回空')
  }
  const row = arr[0]
  if (!row) {
    if (cached) return cached.url
    throw new Error('API 返回格式错误')
  }
  const rowId = row.id || ''
  const rowName = row.name || ''
  if (ch.id !== rowId || ch.rawName !== rowName.trim()) {
    if (cached) return cached.url
    throw new Error('频道身份校验失败')
  }

  const streams = row.channel_stream || []
  let streamM3u8 = null
  for (const s of streams) {
    if (s && (s.is_main || 0) === 1) {
      const m3u8 = s.m3u8 || ''
      if (m3u8) { streamM3u8 = m3u8; break }
    }
  }
  if (!streamM3u8) {
    for (const s of streams) {
      if (s) {
        const m3u8 = s.m3u8 || ''
        if (m3u8) { streamM3u8 = m3u8; break }
      }
    }
  }
  if (!streamM3u8) streamM3u8 = row.m3u8 || ''
  if (!streamM3u8) {
    if (cached) return cached.url
    throw new Error('未找到可用 HLS 流')
  }

  const validated = fjtvValidateStream(streamM3u8, ch.path)
  if (!validated) {
    if (cached) return cached.url
    throw new Error('流地址校验失败')
  }
  const entry = { url: validated, expiresAt: fjtvExtractExpiry(validated) }
  fjtvCache.set(ch.id, entry)
  return validated
}

async function resolveFjtvPlayUrl(pageUrl) {
  const pathSeg = fjtvExtractPathSegment(pageUrl)
  if (!pathSeg) return null
  const ch = FJTV_PATH_TO_CHANNEL[pathSeg]
  if (!ch) return null
  const m3u8Url = await fjtvGetSignedStream(ch)
  if (!m3u8Url) return null
  return {
    url: m3u8Url,
    headers: { 'Referer': 'https://live.fjtv.net/', 'User-Agent': FJTV_UA },
  }
}

// ============================================================
// 江西网络广播电视台 (jxntv.cn)
// 完整继承 YSPlayer1.5 JxntvParser：
//   固定频道表按 URL route 识别；liveauth/pc 接口 POST 鉴权，
//   Authorization = md5(t + stream + etag + salt)，返回短效 token 拼接 HLS 直连
// ============================================================

const JXNTV_AUTH_API = 'https://cdnauth.jxgdw.com/liveauth/pc'
const JXNTV_MEDIA_BASE = 'https://yun-live.jxtvcn.com.cn/live-jxtv/'
// 【测试】硬编码兜底值已注释：抓取失败时盐为 null，签名直接失效以便暴露问题。
// const JXNTV_AUTH_SALT = 'gXmNaQROStYfd'
const JXNTV_ETAG_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678oOLl9gqVvUuI1'
const JXNTV_TOKEN_TTL_MS = 45 * 1000
const JXNTV_PAGE_URL = 'https://www.jxntv.cn/live/'
const JXNTV_SALT_CACHE_TTL_MS = 30 * 60 * 1000
const JXNTV_INDEX_JS_PAT = /\/assets\/index-([A-Za-z0-9_-]+)\.js/
const JXNTV_CHARSET_PAT = /"([A-Za-z0-9]{55,70})"/
const JXNTV_SALT_IDX_PAT = /\[\s*(\d+(?:\s*,?\s*\d+){10,20})\s*\]\s*\[/

let jxntvAuthSalt = null               // 当前生效盐（仅自动抓取成功后被更新；测试期无硬编码兜底）
let jxntvAuthSaltCheckedAt = 0
let jxntvAuthSaltPromise = null

const JXNTV_CHANNEL_BY_ROUTE = {
  jxtv1: { route: 'jxtv1', streamName: 'tv_jxtv1.m3u8', name: '江西卫视' },
  jxtv2: { route: 'jxtv2', streamName: 'tv_jxtv2.m3u8', name: '江西都市' },
  jxtv3: { route: 'jxtv3', streamName: 'tv_jxtv3_hd.m3u8', name: '江西经济生活' },
  jxtv5: { route: 'jxtv5', streamName: 'tv_jxtv5.m3u8', name: '江西公共农业' },
  jxtv6: { route: 'jxtv6', streamName: 'tv_jxtv6.m3u8', name: '江西少儿' },
  jxtv7: { route: 'jxtv7', streamName: 'tv_jxtv7.m3u8', name: '江西新闻' },
  jxtv8: { route: 'jxtv8', streamName: 'tv_jxtv8.m3u8', name: '江西移动电视' },
  tcpd: { route: 'tcpd', streamName: 'tv_taoci.m3u8', name: '江西陶瓷' },
}

let jxntvDeviceUuid = null
const jxntvCache = new Map()

function jxntvInitDeviceUuid(userAgent) {
  if (jxntvDeviceUuid) return
  const ua = userAgent || BROWSER_UA
  jxntvDeviceUuid = md5Hex('jxntv:' + ua).substring(0, 12)
}

function jxntvExtractRoute(url) {
  const m = /\/#\/([a-z0-9_]+)/i.exec(url || '')
  return m ? m[1] : null
}

function jxntvMakeEtag() {
  let s = ''
  for (let i = 0; i < 8; i++) {
    s += JXNTV_ETAG_CHARS[Math.floor(Math.random() * JXNTV_ETAG_CHARS.length)]
  }
  return s
}

async function jxntvHttpGetText(url) {
  try {
    const resp = await session.defaultSession.fetch(url, { headers: { 'Accept': '*/*' } })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

// 三步自动抓取签名盐：首页 HTML -> 入口 JS -> 匹配唯一字符集 + 唯一索引数组逐位拼接
async function jxntvFetchAuthSalt() {
  const html = await jxntvHttpGetText(JXNTV_PAGE_URL)
  if (!html) return null
  const idxMatch = html.match(JXNTV_INDEX_JS_PAT)
  if (!idxMatch) return null

  const indexJs = await jxntvHttpGetText(JXNTV_PAGE_URL + 'assets/index-' + idxMatch[1] + '.js')
  if (!indexJs) return null
  const charsetMatch = indexJs.match(JXNTV_CHARSET_PAT)
  if (!charsetMatch) return null
  const charset = charsetMatch[1]

  const idxArrMatch = indexJs.match(JXNTV_SALT_IDX_PAT)
  if (!idxArrMatch) return null
  const indices = idxArrMatch[1].split(/[,\s]+/).filter(Boolean).map(Number)

  let salt = ''
  for (const i of indices) salt += charset[i]
  return salt
}

// 带冷却期与并发去重的盐刷新；抓取失败时沿用现有盐（测试期初始为 null）
async function jxntvEnsureAuthSalt() {
  const now = Date.now()
  if (jxntvAuthSaltCheckedAt && now - jxntvAuthSaltCheckedAt < JXNTV_SALT_CACHE_TTL_MS) {
    return jxntvAuthSalt
  }
  if (jxntvAuthSaltPromise) return jxntvAuthSaltPromise
  jxntvAuthSaltPromise = (async () => {
    try {
      const s = await jxntvFetchAuthSalt()
      if (s) jxntvAuthSalt = s
    } catch (_) { /* 抓取失败则沿用现有盐 */ }
    finally {
      jxntvAuthSaltCheckedAt = Date.now()
      jxntvAuthSaltPromise = null
    }
    return jxntvAuthSalt
  })()
  return jxntvAuthSaltPromise
}

async function jxntvGetSignedStream(def, userAgent) {
  const now = Date.now()
  const cache = jxntvCache.get(def.route)
  if (cache && cache.expiresAt > now) return cache.url

  const saltPromise = jxntvEnsureAuthSalt() // 并行刷新签名盐，签名前 await 即可

  const timestamp = String(Math.floor(now / 1000))
  const etag = jxntvMakeEtag()
  const uuid = jxntvDeviceUuid || '000000000000'
  const authSalt = await saltPromise
  const authorization = md5Hex(timestamp + def.streamName + etag + authSalt)
  const body = JSON.stringify({ t: timestamp, stream: def.streamName, uuid })

  const headers = {
    'User-Agent': userAgent || BROWSER_UA,
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': 'https://www.jxntv.cn',
    'Referer': 'https://www.jxntv.cn/live/',
    'Authorization': authorization,
    'ETag': etag,
    'GPU': 'Apple, Apple M1',
  }

  const resp = await session.defaultSession.fetch(JXNTV_AUTH_API, { method: 'POST', headers, body })
  if (!resp || resp.status !== 200) return null
  let json
  try { json = await resp.json() } catch (_) { return null }
  const t = json.t || ''
  const token = json.token || ''
  if (!t || !token || !/^[a-f0-9]{32}$/.test(token)) return null

  const streamUrl = `${JXNTV_MEDIA_BASE}${def.streamName}?source=pc&t=${t}&token=${token}&uuid=${uuid}`
  const entry = { url: streamUrl, expiresAt: now + JXNTV_TOKEN_TTL_MS }
  jxntvCache.set(def.route, entry)
  return streamUrl
}

async function resolveJxntvPlayUrl(pageUrl, ua) {
  jxntvInitDeviceUuid(ua)
  let route = jxntvExtractRoute(pageUrl)
  let def = JXNTV_CHANNEL_BY_ROUTE[route]
  if (!def) def = JXNTV_CHANNEL_BY_ROUTE.jxtv1
  const streamUrl = await jxntvGetSignedStream(def, ua)
  if (!streamUrl) return null
  return {
    url: streamUrl,
    headers: {
      'User-Agent': ua,
      'Origin': 'https://www.jxntv.cn',
      'Referer': 'https://www.jxntv.cn/live/',
    },
  }
}

// ============================================================
// 河北网络广播电视台 (hebrts.cn)
// 完整继承 YSPlayer1.5 HebrtvParser：
//   频道列表接口 getArticleList 拉取 6 路频道，按 URL index 定位；
//   流地址签名 k = md5(liveUri + liveKey + 过期时间戳)，有效期 2 小时
// ============================================================

const HEBRTV_CHANNEL_LIST_URL = 'https://api.cmc.hebrts.cn/cmsback/api/com/article/getArticleList?catalogId=32557&siteId=1'
const HEBRTV_STREAM_HOST = 'tv.pull.hebtv.com'
const HEBRTV_STREAM_TTL_SECONDS = 2 * 60 * 60
const HEBRTV_CHANNEL_TTL_MS = 4 * 60 * 60 * 1000
const HEBRTV_TITLE_MAP = ['河北卫视', '经济生活', '河北都市', '文旅体育', '少儿科教', '三农频道']
const HEBRTV_NAME_OVERRIDES = ['河北卫视', '河北经济生活', '河北都市', '河北文旅体育', '河北少儿科教', '河北三农']

let hebrtvChannelList = null
let hebrtvChannelExpiresAt = 0

function hebrtvExtractIndex(url) {
  const m = /[?&]index=(\d+)/.exec(url || '')
  if (m) {
    const n = parseInt(m[1], 10)
    if (!isNaN(n)) return n
  }
  return -1
}

function hebrtvExtractStreamUrl(item) {
  const liveVideo = item.liveVideo || []
  for (const device of liveVideo) {
    if (!device) continue
    const formats = device.formats || []
    for (const format of formats) {
      if (!format) continue
      let val = format.url || ''
      if (!val) val = format.liveStream || ''
      if (val) return val.trim()
    }
  }
  return null
}

async function hebrtvFetchChannelList() {
  const headers = {
    'User-Agent': BROWSER_UA,
    'Referer': 'https://www.hebrts.cn/19/19js/st/xdszb/index.shtml',
    'Origin': 'https://www.hebrts.cn',
    'Accept': 'application/json',
    'Content-Type': 'application/json;charset=UTF-8',
  }
  const resp = await session.defaultSession.fetch(HEBRTV_CHANNEL_LIST_URL, { method: 'POST', headers, body: '{}' })
  if (!resp || resp.status !== 200) throw new Error('频道接口 HTTP ' + (resp && resp.status))
  const json = await resp.json()
  if (json.returnCode !== '0000') throw new Error('频道接口返回: ' + (json.returnDesc || json.returnCode))
  const returnData = json.returnData
  if (!returnData) throw new Error('频道接口无returnData')
  const news = returnData.news || []
  if (news.length === 0) throw new Error('频道列表为空')

  const titleSet = new Set(HEBRTV_TITLE_MAP)
  const channels = []
  for (const item of news) {
    if (!item) continue
    const title = (item.title || '').trim()
    if (!titleSet.has(title)) continue
    const params = item.appCustomParams || item.appCustomParams1
    if (!params) continue
    const movie = params.movie
    if (!movie) continue
    const liveUri = (movie.liveUri || '').trim()
    const liveKey = (movie.liveKey || '').trim()
    if (!liveUri || !liveKey) continue
    if (!/^\/[A-Za-z0-9][A-Za-z0-9/_.-]*\.m3u8$/.test(liveUri)) continue
    if (!/^[A-Za-z0-9]{3,64}$/.test(liveKey)) continue
    const rawUrl = hebrtvExtractStreamUrl(item)
    if (!rawUrl) continue
    try {
      const parsed = new URL(rawUrl)
      if (parsed.protocol !== 'https:') continue
      if (parsed.hostname !== HEBRTV_STREAM_HOST) continue
      if (liveUri !== parsed.pathname) continue
    } catch (_) { continue }
    channels.push({ id: String(item.id ?? '').trim(), name: title, liveUri, liveKey, url: rawUrl })
  }
  if (channels.length === 0) throw new Error('频道列表中没有可用频道')
  return channels
}

async function hebrtvGetChannelList() {
  const now = Date.now()
  if (hebrtvChannelList && now < hebrtvChannelExpiresAt) return hebrtvChannelList
  try {
    hebrtvChannelList = await hebrtvFetchChannelList()
    hebrtvChannelExpiresAt = now + HEBRTV_CHANNEL_TTL_MS
  } catch (_) {
    if (hebrtvChannelList) hebrtvChannelExpiresAt = now + 60 * 1000
  }
  return hebrtvChannelList
}

function hebrtvSignStreamUrl(ch) {
  const nowSec = Math.floor(Date.now() / 1000)
  const expires = nowSec + HEBRTV_STREAM_TTL_SECONDS
  const k = md5Hex(ch.liveUri + ch.liveKey + expires)
  return `https://${HEBRTV_STREAM_HOST}${ch.liveUri}?t=${expires}&k=${k}`
}

async function resolveHebrtvPlayUrl(pageUrl) {
  const index = hebrtvExtractIndex(pageUrl)
  if (index < 0 || index >= HEBRTV_TITLE_MAP.length) return null
  const channels = await hebrtvGetChannelList()
  if (!channels || channels.length === 0) return null
  const cmsTitle = HEBRTV_TITLE_MAP[index]
  let ch = null
  for (const ci of channels) {
    if (cmsTitle === ci.name) { ch = ci; break }
  }
  if (!ch) return null
  const signedUrl = hebrtvSignStreamUrl(ch)
  return {
    url: signedUrl,
    headers: { 'Referer': 'https://www.hebrts.cn/', 'Origin': 'https://www.hebrts.cn' },
  }
}

// ============================================================
// XXTEA（Corrected Block TEA）加解密
// 完整继承 YSPlayer1.5 Xxtea.java，供内蒙古台接口数据加解密使用
// ============================================================

function xxteaToWords(bytes, includeLength) {
  const size = Math.floor((bytes.length + 3) / 4)
  const words = new Array(includeLength ? size + 1 : size).fill(0)
  for (let i = 0; i < bytes.length; i++) {
    words[i >>> 2] = (words[i >>> 2] | ((bytes[i] & 0xFF) << ((i & 3) << 3))) >>> 0
  }
  if (includeLength) words[size] = bytes.length
  return words
}

function xxteaToKeyWords(key) {
  const words = [0, 0, 0, 0]
  for (let i = 0; i < key.length && i < 16; i++) {
    words[i >>> 2] = (words[i >>> 2] | ((key[i] & 0xFF) << ((i & 3) << 3))) >>> 0
  }
  return words
}

function xxteaToBytes(words, includeLength) {
  let size = words.length * 4
  if (includeLength) {
    const expected = words[words.length - 1]
    size -= 4
    if (expected < size - 3 || expected > size) {
      throw new Error('XXTEA decryption failed: invalid message length')
    }
    size = expected
  }
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    bytes[i] = words[i >>> 2] >>> ((i & 3) << 3)
  }
  return bytes
}

function xxteaEncrypt(data, key) {
  if (!data || data.length === 0) return data
  const words = xxteaToWords(data, true)
  const keyWords = xxteaToKeyWords(key)
  const n = words.length
  const rounds = 6 + Math.floor(52 / n)
  const delta = 0x9E3779B9
  let sum = 0
  let z = words[n - 1]
  for (let q = 0; q < rounds; q++) {
    sum = (sum + delta) >>> 0
    const e = (sum >>> 2) & 3
    for (let p = 0; p < n - 1; p++) {
      const y = words[p + 1]
      let mx = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) >>> 0
      mx = (mx ^ ((sum ^ y) + (keyWords[(p & 3) ^ e] ^ z))) >>> 0
      z = words[p] = (words[p] + mx) >>> 0
    }
    const y = words[0]
    let mx = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) >>> 0
    mx = (mx ^ ((sum ^ y) + (keyWords[((n - 1) & 3) ^ e] ^ z))) >>> 0
    z = words[n - 1] = (words[n - 1] + mx) >>> 0
  }
  return xxteaToBytes(words, false)
}

function xxteaDecrypt(data, key) {
  if (!data || data.length === 0) return data
  const words = xxteaToWords(data, false)
  const keyWords = xxteaToKeyWords(key)
  const n = words.length
  const rounds = 6 + Math.floor(52 / n)
  const delta = 0x9E3779B9
  let sum = (rounds * delta) >>> 0
  let y = words[0]
  for (let q = 0; q < rounds; q++) {
    const e = (sum >>> 2) & 3
    for (let p = n - 1; p > 0; p--) {
      const z = words[p - 1]
      let mx = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) >>> 0
      mx = (mx ^ ((sum ^ y) + (keyWords[(p & 3) ^ e] ^ z))) >>> 0
      y = words[p] = (words[p] - mx) >>> 0
    }
    const z = words[n - 1]
    let mx = (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) >>> 0
    mx = (mx ^ ((sum ^ y) + (keyWords[e] ^ z))) >>> 0
    y = words[0] = (words[0] - mx) >>> 0
    sum = (sum - delta) >>> 0
  }
  return xxteaToBytes(words, true)
}

// ============================================================
// 内蒙古广播电视台 (nmtv.cn, 奔腾融媒)
// 完整继承 YSPlayer1.5 NmtvParser：
//   POST XXTEA 加密 JSON 到 broadcast/list，解密响应按 upstreamId 匹配；
//   白名单校验媒体主机；缓存 30 秒，失败复用旧缓存/回退 URL
// ============================================================

const NMTV_API_URL = 'https://api-bt.nmtv.cn/broadcast/list'
// XXTEA 对称加解密密钥（固定值，非轮换签名盐）。明文位于 assets/index.<hash>.js 的共享 chunk；
// 密钥固定且 chunk 名为通用哈希名、难以稳定定位，故保留硬编码。
const NMTV_XXTEA_KEY = '5b28bae827e651b3'
const NMTV_CACHE_TTL_MS = 30 * 1000
const NMTV_RETRY_MS = 5 * 1000
const NMTV_MEDIA_HOSTS = new Set(['play1-qk.nmtv.cn', 'livestream-bt.nmtv.cn'])

const NMTV_CHANNELS = [
  { upstreamId: 3621481, rawName: '内蒙古卫视', displayName: '内蒙古卫视', fallbackUrl: 'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8' },
  { upstreamId: 2315, rawName: '内蒙古蒙古语卫视', displayName: '内蒙古蒙古语卫视' },
  { upstreamId: 2316, rawName: '新闻综合', displayName: '内蒙古新闻综合' },
  { upstreamId: 2317, rawName: '经济生活', displayName: '内蒙古经济生活' },
  { upstreamId: 2318, rawName: '少儿频道', displayName: '内蒙古少儿' },
  { upstreamId: 2319, rawName: '文体娱乐', displayName: '内蒙古文体娱乐' },
  { upstreamId: 2320, rawName: '农牧频道', displayName: '内蒙古农牧' },
  { upstreamId: 2321, rawName: '内蒙古蒙古语文化频道', displayName: '内蒙古蒙古语文化频道', fallbackUrl: 'http://play1-qk.nmtv.cn/live/1769652109096027.m3u8' },
  { upstreamId: 2331, rawName: '呼和浩特', displayName: '呼和浩特' },
  { upstreamId: 2358, rawName: '包头', displayName: '包头' },
  { upstreamId: 2355, rawName: '乌海', displayName: '乌海' },
  { upstreamId: 2351, rawName: '赤峰', displayName: '赤峰' },
  { upstreamId: 2356, rawName: '呼伦贝尔', displayName: '呼伦贝尔' },
  { upstreamId: 2357, rawName: '兴安盟', displayName: '兴安盟' },
  { upstreamId: 2353, rawName: '通辽', displayName: '通辽' },
  { upstreamId: 2346, rawName: '锡林郭勒', displayName: '锡林郭勒' },
  { upstreamId: 2354, rawName: '乌兰察布', displayName: '乌兰察布' },
  { upstreamId: 2349, rawName: '鄂尔多斯', displayName: '鄂尔多斯' },
  { upstreamId: 2348, rawName: '巴彦淖尔', displayName: '巴彦淖尔' },
  { upstreamId: 2347, rawName: '阿拉善', displayName: '阿拉善' },
]

let nmtvListCache = null

function nmtvFindChannel(url) {
  if (!url) return NMTV_CHANNELS[0]
  try {
    const u = new URL(url)
    const query = u.search.substring(1)
    if (query) {
      for (const part of query.split('&')) {
        if (part.startsWith('id=')) {
          const id = parseInt(part.substring(3), 10)
          if (!isNaN(id)) {
            for (const def of NMTV_CHANNELS) if (def.upstreamId === id) return def
          }
        }
      }
    }
  } catch (_) {}
  return NMTV_CHANNELS[0]
}

function nmtvIsValidMediaUrl(raw, upstreamId) {
  if (!raw) return false
  try {
    const u = new URL(String(raw).trim())
    const host = u.hostname
    if (!NMTV_MEDIA_HOSTS.has(host)) return false
    // 备用入口允许 play1-qk 的 http 地址；其余媒体流必须为 https，且禁止带账号/密码/端口
    const plainFallback = host === 'play1-qk.nmtv.cn' && u.protocol === 'http:'
    const secureMedia = u.protocol === 'https:'
    if (u.username || u.password || u.port || (!plainFallback && !secureMedia)) return false
    if (!/^\/(?:live|nmtv)\/[A-Za-z0-9_./-]+$/.test(u.pathname)) return false
    if (!u.pathname.toLowerCase().endsWith('.m3u8')) return false
    // livestream-bt 域名下的流地址必须与该频道的 upstreamId 一一对应
    if (host === 'livestream-bt.nmtv.cn' && u.pathname !== `/nmtv/${upstreamId}general.m3u8`) return false
    return true
  } catch (_) { return false }
}

function nmtvFindStreamUrl(item) {
  const keys = ['data.streamUrl', 'streamUrl', 'url']
  for (const key of keys) {
    const parts = key.split('.')
    let val = item
    for (const part of parts) {
      if (val && typeof val === 'object') val = val[part]
      else { val = null; break }
    }
    if (typeof val === 'string' && val) return val
  }
  return item.streamUrl || item.url || ''
}

async function nmtvFetchChannelList(userAgent) {
  const keyBytes = Buffer.from(NMTV_XXTEA_KEY, 'utf8')
  const requestBody = '{"type":1,"size":100}'
  const encryptedBody = xxteaEncrypt(Buffer.from(requestBody, 'utf8'), keyBytes)
  const b64Body = Buffer.from(encryptedBody).toString('base64')

  const headers = {
    'User-Agent': userAgent || BROWSER_UA,
    'Accept': 'application/json',
    'Client-Type': 'web',
    'Content-Type': 'application/json',
    'Origin': 'https://www.nmtv.cn',
    'Referer': 'https://www.nmtv.cn/liveTv',
  }
  const resp = await session.defaultSession.fetch(NMTV_API_URL, { method: 'POST', headers, body: b64Body })
  if (!resp || resp.status !== 200) throw new Error('API HTTP ' + (resp && resp.status))
  const responseText = await resp.text()
  if (!responseText) throw new Error('empty API response')

  let envelope
  try {
    envelope = JSON.parse(responseText)
  } catch (_) {
    throw new Error('failed to parse API response: not valid JSON')
  }
  // 官网实际把加密结果再 JSON 序列化一层：整个响应体是一个被引号包裹的加密串，
  // JSON.parse 后得到 string，需先 XXTEA 解密再 JSON.parse 成业务对象。
  if (typeof envelope === 'string') {
    try {
      const decrypted = xxteaDecrypt(Buffer.from(envelope, 'base64'), keyBytes)
      envelope = JSON.parse(Buffer.from(decrypted).toString('utf8'))
    } catch (e2) {
      throw new Error('failed to decrypt API response: ' + e2.message)
    }
  }
  if (!envelope || envelope.code !== 0 || !Array.isArray(envelope.data)) {
    throw new Error('API returned error: ' + ((envelope && envelope.msg) || ''))
  }

  const data = envelope.data
  const now = Date.now()
  const cache = { streams: new Map(), expiresAt: now + NMTV_CACHE_TTL_MS, retryAt: 0 }

  for (const item of data) {
    const id = Number(item && item.id)
    const title = String((item && item.title) || '').trim()
    const streamUrl = nmtvFindStreamUrl(item)
    for (const def of NMTV_CHANNELS) {
      if (def.upstreamId === id && def.rawName === title) {
        if (streamUrl && nmtvIsValidMediaUrl(streamUrl, def.upstreamId)) {
          cache.streams.set(id, { url: streamUrl })
        }
        break
      }
    }
  }
  if (cache.streams.size === 0) throw new Error('no valid channels in API response')
  return cache
}

async function nmtvGetStreamUrl(def, userAgent) {
  const now = Date.now()
  const cache = nmtvListCache
  if (cache && (cache.expiresAt > now || cache.retryAt > now)) {
    const entry = cache.streams.get(def.upstreamId)
    if (entry) return entry.url
  }
  try {
    const fresh = await nmtvFetchChannelList(userAgent)
    nmtvListCache = fresh
    const entry = fresh.streams.get(def.upstreamId)
    if (entry) return entry.url
  } catch (_) {
    if (cache) {
      cache.retryAt = now + NMTV_RETRY_MS
      const entry = cache.streams.get(def.upstreamId)
      if (entry) return entry.url
    }
    if (def.fallbackUrl) return def.fallbackUrl
  }
  return def.fallbackUrl || null
}

async function resolveNmtvPlayUrl(pageUrl, ua) {
  const def = nmtvFindChannel(pageUrl)
  const streamUrl = await nmtvGetStreamUrl(def, ua)
  if (!streamUrl) return null
  return {
    url: streamUrl,
    headers: { 'User-Agent': ua, 'Referer': 'https://www.nmtv.cn/' },
  }
}

// ============================================================
// 贵州网络广播电视台 (gzstv.com)
// 完整继承 YSPlayer1.5 GzstvParser：
//   /tv/{slug} 接口拉取 title/stream_url，校验官方媒体域名与 txSecret/txTime，
//   流地址 30s 刷新 / 2 分钟硬过期，失败复用旧缓存
// ============================================================

const GZSTV_API_ORIGIN = 'https://api.gzstv.com'
const GZSTV_PAGE_ORIGIN = 'https://www.gzstv.com'
const GZSTV_MEDIA_HOST = '9bwaz8y2.gzstv.com'
const GZSTV_MEDIA_PATH_PREFIX = '/live/'
const GZSTV_TOKEN_REFRESH_MS = 30 * 1000
const GZSTV_TOKEN_HARD_TTL_MS = 2 * 60 * 1000
const GZSTV_UA = BROWSER_UA

const GZSTV_CHANNELS = [
  { ref: 'gzstv-satellite', slug: 'ch01', streamName: 'CH01_lo.m3u8', rawName: '贵州卫视', displayName: '贵州卫视' },
  { ref: 'gzstv-public', slug: 'ch02', streamName: 'CH02_lo.m3u8', rawName: '公共频道', displayName: '贵州公共' },
  { ref: 'gzstv-film-arts', slug: 'ch03', streamName: 'CH03_lo.m3u8', rawName: '影视文艺频道', displayName: '贵州影视文艺' },
  { ref: 'gzstv-life', slug: 'ch04', streamName: 'CH04_lo.m3u8', rawName: '大众生活频道', displayName: '贵州大众生活' },
  { ref: 'gzstv-eco-rural', slug: 'ch05', streamName: 'CH05_lo.m3u8', rawName: '生态·乡村频道', displayName: '贵州生态乡村' },
  { ref: 'gzstv-science-health', slug: 'ch06', streamName: 'CH06_lo.m3u8', rawName: '科教健康频道', displayName: '贵州科教健康' },
  { ref: 'gzstv-economy', slug: 'ch09', streamName: 'CH09_lo.m3u8', rawName: '贵州经济频道', displayName: '贵州经济' },
  { ref: 'gzstv-mobile', slug: 'ch13', streamName: 'CH13_lo.m3u8', rawName: '贵州移动电视', displayName: '贵州移动电视' },
]
const GZSTV_CHANNEL_BY_SLUG = {}
for (const ch of GZSTV_CHANNELS) GZSTV_CHANNEL_BY_SLUG[ch.slug] = ch

const gzstvTokenCache = new Map()

function gzstvExtractSlug(url) {
  const m = /\/tv\/(ch\d+)/.exec(url || '')
  return m ? m[1] : null
}

function gzstvGetQueryParam(query, key) {
  if (!query || !key) return null
  for (const pair of query.split('&')) {
    const idx = pair.indexOf('=')
    if (idx > 0 && key === pair.substring(0, idx)) return pair.substring(idx + 1)
  }
  return null
}

function gzstvValidateStreamUrl(raw, expectedStreamName) {
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:') return null
    if (u.hostname !== GZSTV_MEDIA_HOST) return null
    if (!u.pathname.startsWith(GZSTV_MEDIA_PATH_PREFIX)) return null
    if (!u.pathname.toLowerCase().endsWith('.m3u8')) return null
    if (expectedStreamName && u.pathname !== GZSTV_MEDIA_PATH_PREFIX + expectedStreamName) return null
    const txSecret = gzstvGetQueryParam(u.search.substring(1), 'txSecret')
    const txTime = gzstvGetQueryParam(u.search.substring(1), 'txTime')
    if (!txSecret || !/^[a-f0-9]{32}$/i.test(txSecret)) return null
    if (!txTime || !/^[a-f0-9]{8,16}$/i.test(txTime)) return null
    return raw
  } catch (_) { return null }
}

async function gzstvGetSignedStream(channel) {
  const now = Date.now()
  const cached = gzstvTokenCache.get(channel.ref)
  if (cached && (cached.refreshAt > now || cached.hardExpiresAt > now)) return cached.url

  const apiUrl = `${GZSTV_API_ORIGIN}/v1/tv/${channel.slug}/?fields=title,stream_url`
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Origin': GZSTV_PAGE_ORIGIN,
    'Referer': GZSTV_PAGE_ORIGIN + '/tv/' + channel.slug,
    'User-Agent': GZSTV_UA,
  }
  const resp = await session.defaultSession.fetch(apiUrl, { headers })
  if (!resp || resp.status !== 200) {
    if (cached) return cached.url
    throw new Error('API HTTP ' + (resp && resp.status))
  }
  let json
  try { json = await resp.json() } catch (_) {
    if (cached) return cached.url
    throw new Error('API 返回非 JSON')
  }
  const title = json.title || ''
  const streamUrl = json.stream_url || ''
  if (channel.rawName !== title || !streamUrl) {
    if (cached) return cached.url
    throw new Error('API 返回无效 (title=' + title + ')')
  }
  const validated = gzstvValidateStreamUrl(streamUrl, channel.streamName)
  if (!validated) {
    if (cached) return cached.url
    throw new Error('API 返回非官方地址')
  }
  const token = { url: validated, refreshAt: now + GZSTV_TOKEN_REFRESH_MS, hardExpiresAt: now + GZSTV_TOKEN_HARD_TTL_MS }
  gzstvTokenCache.set(channel.ref, token)
  return validated
}

async function resolveGzstvPlayUrl(pageUrl) {
  const slug = gzstvExtractSlug(pageUrl)
  if (!slug) return null
  const channel = GZSTV_CHANNEL_BY_SLUG[slug]
  if (!channel) return null
  const m3u8Url = await gzstvGetSignedStream(channel)
  if (!m3u8Url) return null
  return {
    url: m3u8Url,
    headers: { 'Origin': GZSTV_PAGE_ORIGIN, 'Referer': GZSTV_PAGE_ORIGIN + '/tv/' + channel.slug },
  }
}

// ============================================================
// 东北网 / 黑龙江广播电视台 (dbw.cn)
// 完整继承 YSPlayer1.5 DbwParser：
//   官方直播入口固定地址 idclive.hljtv.com:4430/live/<stream>.m3u8，
//   不带签名，清单/分片不校验 Referer、不挑 UA，播放器直连官方 CDN，
//   纯静态映射，无需任何 HTTP 请求
// ============================================================

const DBW_MEDIA_BASE = 'https://idclive.hljtv.com:4430/live/'

const DBW_CHANNEL_BY_SLUG = {
  'hljws': { name: '黑龙江卫视', stream: 'hljws_own.m3u8' },
  'hljds': { name: '黑龙江都市', stream: 'dushi_hd.m3u8' },
  'hljxw': { name: '黑龙江新闻法治', stream: 'hljxw_hd.m3u8' },
  'heilongjiang': { name: '黑龙江新闻法治', stream: 'hljxw_hd.m3u8' },
  'hljwt': { name: '黑龙江文体', stream: 'hljwy_hd.m3u8' },
  'hljse': { name: '黑龙江少儿', stream: 'hljse_hd.m3u8' },
  'hljys': { name: '黑龙江影视', stream: 'hljys_hd.m3u8' },
  'hljnykj': { name: '黑龙江农业科教', stream: 'hljgg_hd.m3u8' },
}

async function resolveDbwPlayUrl(pageUrl) {
  const m = /\/zhibodan\/zhibo_dan\/([a-z0-9_]+)\/?/i.exec(pageUrl || '')
  const slug = m ? m[1] : null
  let def = DBW_CHANNEL_BY_SLUG[slug]
  if (!def) def = DBW_CHANNEL_BY_SLUG['hljws']
  const streamUrl = DBW_MEDIA_BASE + def.stream
  return {
    url: streamUrl,
    headers: { 'Referer': 'https://www.dbw.cn/' },
  }
}

// ============================================================
// 中国蓝TV / 浙江台 (cztv.com)
// 完整继承 YSPlayer1.5 CztvParser：
//   /liveTV/{channelId} -> playInfo 接口 -> 优选 720P/1080P -> urlList[0]
//   -> auth_key = md5(pathname + "-" + ts + "-0-0-" + AUTH_SALT) 签名
// ============================================================

const CZTV_PLAY_INFO_URL = 'https://zlive-das.cztv.com/zapp/live/tv/channel/playInfo'
// 【测试】硬编码兜底值已注释：抓取失败时盐为 null，签名直接失效以便暴露问题。
// const CZTV_AUTH_SALT = 'CHWr9VybUeBZE1VB'
const CZTV_QUALITY_PREFERENCE = ['720P', '1080P']
const CZTV_PAGE_URL = 'https://www.cztv.com/'
const CZTV_SALT_CACHE_TTL_MS = 30 * 60 * 1000
const CZTV_INDEX_JS_PAT = /\/assets\/index-([A-Za-z0-9_-]+)\.js/
const CZTV_CHUNK_PAT = /directSeedingTV-([A-Za-z0-9_-]+)\.js/
const CZTV_SALT_PAT = /-0-0-([A-Za-z0-9]{10,32})/

let cztvAuthSalt = null               // 当前生效盐（仅自动抓取成功后被更新；测试期无硬编码兜底）
let cztvAuthSaltCheckedAt = 0
let cztvAuthSaltPromise = null

async function cztvHttpGetText(url) {
  try {
    const resp = await session.defaultSession.fetch(url, { headers: { 'Accept': '*/*' } })
    if (resp && resp.status === 200) return await resp.text()
  } catch (_) {}
  return null
}

// 三步自动抓取签名盐：首页 HTML -> 入口 JS -> 取流逻辑 chunk，盐以明文 "-0-0-<盐>" 出现
async function cztvFetchAuthSalt() {
  const html = await cztvHttpGetText(CZTV_PAGE_URL)
  if (!html) return null
  const idxMatch = html.match(CZTV_INDEX_JS_PAT)
  if (!idxMatch) return null

  const indexJs = await cztvHttpGetText(CZTV_PAGE_URL + 'assets/index-' + idxMatch[1] + '.js')
  if (!indexJs) return null
  const chunkMatch = indexJs.match(CZTV_CHUNK_PAT)
  if (!chunkMatch) return null

  const chunkJs = await cztvHttpGetText(CZTV_PAGE_URL + 'assets/directSeedingTV-' + chunkMatch[1] + '.js')
  if (!chunkJs) return null
  const saltMatch = chunkJs.match(CZTV_SALT_PAT)
  return saltMatch ? saltMatch[1] : null
}

// 带冷却期与并发去重的盐刷新；抓取失败时沿用现有盐（测试期初始为 null）
async function cztvEnsureAuthSalt() {
  const now = Date.now()
  if (cztvAuthSaltCheckedAt && now - cztvAuthSaltCheckedAt < CZTV_SALT_CACHE_TTL_MS) {
    return cztvAuthSalt
  }
  if (cztvAuthSaltPromise) return cztvAuthSaltPromise
  cztvAuthSaltPromise = (async () => {
    try {
      const s = await cztvFetchAuthSalt()
      if (s) cztvAuthSalt = s
    } catch (_) { /* 抓取失败则沿用现有盐 */ }
    finally {
      cztvAuthSaltCheckedAt = Date.now()
      cztvAuthSaltPromise = null
    }
    return cztvAuthSalt
  })()
  return cztvAuthSaltPromise
}

async function resolveCztvPlayUrl(pageUrl, ua) {
  const m = /\/liveTV\/(\d+)/.exec(pageUrl || '')
  const channelId = m ? m[1] : null
  if (!channelId) return null

  const saltPromise = cztvEnsureAuthSalt() // 并行刷新签名盐，签名前 await 即可

  const url = `${CZTV_PLAY_INFO_URL}?channelId=${channelId}&platform=WEB`
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/json',
    'Origin': 'https://www.cztv.com',
    'Referer': 'https://www.cztv.com/',
  }
  const resp = await session.defaultSession.fetch(url, { headers })
  if (!resp || resp.status !== 200) return null

  const root = await resp.json()
  if (!root || root.code !== 200) return null
  const data = root.data
  if (!data) return null

  const streams = data.multiBitrateStreamList
  if (!Array.isArray(streams) || streams.length === 0) return null

  const candidates = streams.filter((s) => {
    if (!s) return false
    if (String(s.bitrateCode || '').toUpperCase() === 'AUDIO') return false
    const urlList = s.urlList
    return Array.isArray(urlList) && urlList.length > 0
  })
  if (candidates.length === 0) return null

  let selected = candidates[0]
  for (const pref of CZTV_QUALITY_PREFERENCE) {
    const hit = candidates.find((c) => pref === String(c.bitrateCode || ''))
    if (hit) { selected = hit; break }
  }

  const rawUrl = selected.urlList[0]
  if (!rawUrl) return null

  const channelName = data.channelName || ('频道' + channelId)
  const quality = selected.bitrateCode || '720P'

  // auth_key 签名
  let signedUrl = rawUrl
  try {
    const authSalt = await saltPromise
    const parsed = new URL(rawUrl)
    const timestamp = Date.now()
    const signStr = parsed.pathname + '-' + timestamp + '-0-0-' + authSalt
    const hex = md5Hex(signStr)
    signedUrl = rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'auth_key=' + timestamp + '-0-0-' + hex
  } catch (_) { /* 签名失败用原 URL */ }

  return {
    url: signedUrl,
    headers: {
      'User-Agent': ua,
      'Origin': 'https://www.cztv.com',
      'Referer': 'https://www.cztv.com/',
    },
  }
}

// ============================================================
// 湖北长江云 (news.hbtv.com.cn)
// 完整对齐 iptv-main/extractors/hbtv 与 YSPlayer1.5 HbtvParser：
//   1) 官网频道页内联六套频道的 stream 地址（live21-cjy.hbtv.com.cn，带短效 auth_key）
//   2) 官网下发匿名 client-id Cookie，配合 /ajax/get_cdn_leech 换取带
//      auth_key + extrakey + aalook 三段防盗链参数的正式播放地址
//   3) 该 CDN 对新会话的首次跨域清单请求固定 403、第二次放行；清单与分片都要求官网 Referer。
//      入口短效，故经本地代理全代理：清单 403/过期时 entryRefresher 重新取票并重试一次，
//      Referer/Origin 在服务端补齐，不暴露给播放器（与 YSPlayer1.5 LocalHttpProxy 一致）。
// ============================================================

const HBTV_PAGE_ORIGIN = 'https://news.hbtv.com.cn'
const HBTV_REFERER = 'https://news.hbtv.com.cn/'
const HBTV_CDN_HOST = 'live21-cjy.hbtv.com.cn'
const HBTV_LEECH_API = 'https://news.hbtv.com.cn/ajax/get_cdn_leech'
// 官网直播页是同一份 SPA 外壳，六套频道的 stream 与匿名 client-id Cookie 都内联在 431 页里。
// 与 iptv-main/extractors/hbtv 的 CHANNEL_PAGE_URL 保持一致，统一从这里取。
const HBTV_PAGE_URL = 'https://news.hbtv.com.cn/app/tv/431'

// 六套频道固定映射（频道 id → [显示名, 流路径标识]）
const HBTV_CHANNELS = {
  '431': ['湖北卫视', 'new-hbws'],
  '432': ['湖北经视', 'new-hbjs'],
  '433': ['湖北综合', 'new-hbzh'],
  '435': ['湖北影视', 'new-hbys'],
  '437': ['湖北教育', 'new-hbjy'],
  '438': ['湖北垄上', 'new-hbls'],
}

function hbtvExtractChannelId(url) {
  const m = /\/app\/tv\/(\d+)/i.exec(url || '')
  return m ? m[1] : null
}

function hbtvIsOfficialStreamUrl(url, streamPath) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    if (u.hostname !== HBTV_CDN_HOST) return false
    if (u.pathname !== `/new-hbtv/${streamPath}.m3u8`) return false
    const auth = u.searchParams.get('auth_key') || ''
    const match = /^(\d{10})-[0-9a-f]{32}-\d+-[0-9a-f]{32}$/i.exec(auth)
    if (!match) return false
    // 频道页里短效裸流的 auth_key 即将过期时不能拿去换票，否则 get_cdn_leech 必然失败
    return Number(match[1]) * 1000 > Date.now() + 60 * 1000
  } catch (_) {
    return false
  }
}

function hbtvIsOfficialResolvedUrl(url, streamPath) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== HBTV_CDN_HOST) return false
    if (u.pathname !== `/new-hbtv/${streamPath}.m3u8`) return false
    return !!(u.searchParams.get('auth_key') && u.searchParams.get('extrakey') && u.searchParams.get('aalook'))
  } catch (_) {
    return false
  }
}

function hbtvExtractStreamUrl(html, streamPath) {
  const source = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&')
  const re = new RegExp(
    'https://' + HBTV_CDN_HOST.replace(/\./g, '\\.') + '/new-hbtv/' + streamPath + '\\.m3u8[^"\'\\s<>]*',
    'i',
  )
  const m = re.exec(source)
  return m ? m[0] : null
}

// 官网下发的匿名 client-id 必须由浏览器页面上下文内的 document.cookie 读取（见 main.js
// fetchHbtvManifestViaBrowser）：换票接口 /ajax/get_cdn_leech 与清单请求必须发生在同一个
// 浏览器会话内连续发起，跨会话换出的票会被 CDN 固定 403（_hbtv_verify.js 实测结论）。
// 因此本解析分支只抓官网页、提取内联的短效裸流地址（live21-cjy.hbtv.com.cn，仅 auth_key），
// 不再提前经 session.defaultSession.fetch 换票——那种票对浏览器会话无效。

// 一次取流：抓官网直播页 → 按 streamPath 提取内联 stream 地址。
// 真正换票 + 拉清单由 main.js 的隐藏浏览器在页面上下文内完成（对齐 iptv-main
// extractors/hbtv/session.js 的 page.evaluate 全链路）。
async function hbtvCaptureStream(streamPath, ua) {
  const pageHeaders = {
    'User-Agent': ua,
    'Referer': HBTV_REFERER,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
  const resp = await session.defaultSession.fetch(HBTV_PAGE_URL, {
    headers: pageHeaders,
    // 官网内联的 auth_key 短效，续签时必须拿到全新页面，禁用缓存防止取回过期地址
    cache: 'no-store',
  })
  if (!resp || resp.status !== 200) return null
  const html = await resp.text()

  const streamUrl = hbtvExtractStreamUrl(html, streamPath)
  if (!streamUrl || !hbtvIsOfficialStreamUrl(streamUrl, streamPath)) return null
  return streamUrl
}

async function resolveHbtvPlayUrl(pageUrl, ua) {
  const channelId = hbtvExtractChannelId(pageUrl)
  const def = HBTV_CHANNELS[channelId]
  if (!def) return null
  const streamPath = def[1]

  const streamUrl = await hbtvCaptureStream(streamPath, ua)
  if (!streamUrl) return null

  // 返回官网内联的短效裸流地址（仅 auth_key，无 extrakey/aalook）。统一会话代理的
  // handleStreamRequest 对 hbtv 站点走 fetchHbtvManifestViaBrowser，在隐藏浏览器页面
  // 上下文内完成「读 client-id → /ajax/get_cdn_leech 换票 → 拉清单」，拿到真实 HLS。
  // 分片继续走统一会话代理的 net.request 链路（只校验官网 Referer/Origin）。
  return {
    url: streamUrl,
    headers: {
      'User-Agent': ua,
      'Referer': HBTV_REFERER,
      'Origin': HBTV_PAGE_ORIGIN,
      'Accept': 'application/vnd.apple.mpegurl, */*',
    },
  }
}

// 视频流解析模式对外唯一入口：严禁回退网页。
// 所有站点分支的返回值都必须过一遍合法性校验，确保交给播放器/FFmpeg 的永远是真实媒体流地址，
// 而不是网页、播放器嵌入页、静态资源或 JSON 业务接口。
// 按页面 URL 推断站点标识（纯字符串匹配，不请求网络、不加载网页）。
// 视频流解析模式下用它决定走哪个站点的纯 HTTP 解析分支；
// 未识别的站点返回 site='generic'，由 resolvePlayUrl 的通用 HTTP 兜底处理。
const SITE_HOST_MAP = [
  { re: /bilibili\.com\/video\//i, site: 'bilibili' },
  { re: /(tv\.)?cctv\.com/i, site: 'cctv' },
  { re: /yangshipin\.cn/i, site: 'yangshipin' },
  // 央视频 CDN（*.ysp.cctv.cn）也是央视频站点：CDN 播放地址本身携带 pid 查询参数，
  // 本地流代理在其 m3u8 一次性 token 失效（403）后，需要据此重新走央视频解析拿新签名地址。
  { re: /ysp\.cctv\.cn/i, site: 'yangshipin' },
  { re: /iqilu\.com/i, site: 'iqilu' },
  { re: /lotustv\.mo/i, site: 'lotustv' },
  { re: /quklive\.com/i, site: 'quklive' },
  { re: /hkstv\.tv/i, site: 'hkstv' },
  { re: /sxrtv\.com/i, site: 'sxrtv' },
  { re: /hnntv\.cn/i, site: 'hnntv' },
  { re: /gxtv\.c(?:n|om)/i, site: 'gxtv' },
  { re: /gdtv\.cn/i, site: 'gdtv' },
  { re: /snrtv\.com/i, site: 'snrtv' },
  { re: /jstv\.com/i, site: 'jstv' },
  { re: /qtv\.com\.cn/i, site: 'qtv' },
  { re: /mgtv\.com/i, site: 'mgtv' },
  { re: /kankanews\.com/i, site: 'kankanews' },
  { re: /fjtv\.net/i, site: 'fjtv' },
  { re: /jxntv\.cn/i, site: 'jxntv' },
  { re: /hebrts\.cn/i, site: 'hebrtv' },
  { re: /nmtv\.cn/i, site: 'nmtv' },
  { re: /gzstv\.com/i, site: 'gzstv' },
  { re: /dbw\.cn/i, site: 'dbw' },
  { re: /cztv\.(com|cn)/i, site: 'cztv' },
  { re: /news\.hbtv\.com\.cn/i, site: 'hbtv' },
]

// 解析出的「媒体流地址 → 原始站点元数据」映射。
// 广东台等站点的 CDN 流地址（tcdn.itouchtv.cn / lbplay.grtn.cn）不携带频道 id，
// 且短效 token 约 2 分钟失效。本地流代理在这些地址 403 后需要据此找回原始 pageUrl，
// 才能重新走站点解析接口续签全新签名地址，否则会「播完两个缓冲就断连且不刷新」。
const RESOLVED_URL_SITE_META = new Map()
const RESOLVED_URL_SITE_META_MAX = 500

function recordResolvedSiteMeta(url, meta) {
  if (!url || !meta || !meta.site || meta.site === 'generic') return
  RESOLVED_URL_SITE_META.set(url, meta)
  // 防止短效流地址持续累积导致内存泄漏，只保留最近 N 条
  while (RESOLVED_URL_SITE_META.size > RESOLVED_URL_SITE_META_MAX) {
    const firstKey = RESOLVED_URL_SITE_META.keys().next().value
    RESOLVED_URL_SITE_META.delete(firstKey)
  }
}

function inferSiteMetaFromUrl(pageUrl) {
  const meta = { pageUrl }
  if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) return null
  try { new URL(pageUrl) } catch (_) { return null }

  // 优先查解析结果映射：CDN 流地址本身不含站点信息（也不在 SITE_HOST_MAP 中），
  // 但它在解析时被记录过，能精确找回原始站点与 pageUrl（含广东台频道 id）。
  const cached = RESOLVED_URL_SITE_META.get(pageUrl)
  if (cached && cached.site) {
    return { ...cached, pageUrl: cached.pageUrl || pageUrl }
  }

  for (const entry of SITE_HOST_MAP) {
    if (entry.re.test(pageUrl)) {
      meta.site = entry.site
      break
    }
  }
  if (!meta.site) meta.site = 'generic'

  if (meta.site === 'bilibili') {
    const bv = pageUrl.match(/BV[a-zA-Z0-9]{10}/)
    if (bv) meta.bvid = bv[0]
  }
  if (meta.site === 'yangshipin' || meta.site === 'cctv') {
    const pid = pageUrl.match(/[?&]pid=(\d+)/)
    if (pid) meta.pid = pid[1]
  }
  return meta
}

async function resolvePlayUrl(siteMeta) {
  let list
  try {
    list = await resolvePlayUrlCore(siteMeta)
  } catch (_) {
    return []
  }
  if (!Array.isArray(list)) return []
  const valid = list.filter(item => item && item.url && !isUnplayableStreamUrl(item.url))
  const dropped = list.length - valid.length
  if (dropped > 0) {
    console.warn(`[sniffer] resolvePlayUrl: 丢弃 ${dropped} 个非媒体流地址（网页/静态资源/接口），site=${siteMeta && siteMeta.site}`)
  }

  // 记录「流地址 → 原始站点元数据」，供本地流代理在短效 token 失效（403）后
  // 找回原始 pageUrl 并自动重解析续签。只拷贝 resolvePlayUrlCore 实际消费的字段，
  // 顺带剥离 forceRefresh 等一次性标记，避免污染后续重解析。
  if (siteMeta && siteMeta.site && siteMeta.site !== 'generic') {
    const cleanMeta = { site: siteMeta.site, pageUrl: siteMeta.pageUrl }
    if (siteMeta.bvid) cleanMeta.bvid = siteMeta.bvid
    if (siteMeta.cid) cleanMeta.cid = siteMeta.cid
    if (siteMeta.pid) cleanMeta.pid = siteMeta.pid
    for (const item of valid) {
      if (item && item.url) recordResolvedSiteMeta(item.url, cleanMeta)
    }
  }
  return valid
}

async function resolvePlayUrlCore(siteMeta) {
  if (!siteMeta || !siteMeta.site) return []
  
  let { site, bvid, cid, pid, pageUrl } = siteMeta
  const ua = BROWSER_UA
  
  // === Bilibili ===
  // Extract bvid from pageUrl if not provided in metadata
  if (!bvid && pageUrl) {
    const bvMatch = pageUrl.match(/BV[a-zA-Z0-9]{10}/)
    if (bvMatch) bvid = bvMatch[0]
    if (!site) site = bvid ? 'bilibili' : site
  }
  
  if (site === 'bilibili' && bvid) {
    const baseHeaders = { 'User-Agent': ua, 'Referer': 'https://www.bilibili.com/', 'Origin': 'https://www.bilibili.com', 'Accept': 'application/json, */*' }
    
    // Try Electron session.fetch first, fallback to Node.js https
    const doFetch = async (url) => {
      try {
        const resp = await session.defaultSession.fetch(url, { headers: baseHeaders })
        if (resp.ok) return await resp.json()
        return null
      } catch (_) {}
      try {
        const resp = await simpleHttpsFetch(url, { headers: baseHeaders })
        if (resp.ok) return await resp.json()
        return null
      } catch (_) { return null }
    }
    
    try {
      // If no cid, discover it from pagelist API
      let resolvedCid = cid
      if (!resolvedCid) {
        try {
          const pl = await doFetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`)
          if (pl?.data?.[0]?.cid) resolvedCid = pl.data[0].cid
        } catch (_) {}
      }

      const cidParam = resolvedCid ? `&cid=${resolvedCid}` : ''
      const data = await doFetch(
        `https://api.bilibili.com/x/player/playurl?bvid=${bvid}${cidParam}&fnval=1&fourk=1`
      )
      if (!data?.data) return []
      const fresh = []
      // durl = combined MP4 with audio — best compatibility
      if (data.data.durl && Array.isArray(data.data.durl)) {
        for (const d of data.data.durl) {
          if (d.url) fresh.push({ url: d.url, format: 'mp4', isLive: false })
        }
      }
      if (data.data.url) fresh.push({ url: data.data.url, format: 'mp4', isLive: false })
      // DASH fallback
      if (data.data.dash?.video && Array.isArray(data.data.dash.video)) {
        for (const v of data.data.dash.video) {
          if (v.baseUrl) fresh.push({ url: v.baseUrl, format: 'mp4', isLive: false })
          if (v.base_url) fresh.push({ url: v.base_url, format: 'mp4', isLive: false })
        }
      }
      return fresh
    } catch (_) { return [] }
  }
  
  // === 央视频 (yangshipin.cn) 专有解析：CAPI 频道映射 + JCE 协议主路径 ===
  if (site === 'yangshipin') {
    try {
      const r = await resolveYangshipinPlayUrl(pid, siteMeta.forceRefresh)
      if (r && r.url) {
        return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
      }
      return []
    } catch (_) { return [] }
  }

  // === CCTV (tv.cctv.com)：version.json + 加密配置 AES 解密取流 ===
  if (site === 'cctv') {
    try {
      const r = await resolveCctvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }
  
  // === 齐鲁网 (v.iqilu.com)：页面变量提取 + AES-CBC 交换取流 ===
  if (site === 'iqilu') {
    try {
      const r = await resolveIqiluPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: guessFormatFromUrl(r.url), isLive: true }]
      console.warn(`[sniffer] iqilu: 未解析出有效流地址, pageUrl=${pageUrl}`)
    } catch (e) {
      console.warn(`[sniffer] iqilu: 解析异常 ${(e && e.message) || e}, pageUrl=${pageUrl}`)
    }
    // 齐鲁网页面内嵌 TCPlayer 的静态资源（tcplayer.min.css / tcplayer.min.js），
    // 若继续走通用 HTML 提取，必然把这些播放器资源误判成直播流。
    // 因此专属解析失败时直接返回空，由前端回退到网页模式。
    return []
  }

  // === 澳门莲花卫视 (lotustv.mo / cloud.quklive.com)：页面 → quklive embed → m3u8 + 本地代理 ===
  if (site === 'lotustv' || site === 'quklive') {
    try {
      const r = await resolveLotustvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
      console.warn(`[sniffer] lotustv: 未解析出有效流地址, pageUrl=${pageUrl}`)
    } catch (e) {
      console.warn(`[sniffer] lotustv: 解析异常 ${(e && e.message) || e}, pageUrl=${pageUrl}`)
    }
    // lotustv 页面内嵌的是 quklive 播放器地址（cloud.quklive.com/cloud/a/embed/xxx），
    // 通用兜底会把这种网页型地址误判成直播流，因此这里直接返回空，由前端回退网页模式。
    return []
  }

  if (site === 'hkstv') {
    // 香港卫视根 m3u8 返回的是一个「退化」的主播放列表（单变体、BANDWIDTH=1），
    // 其中变体 URI 指向带会话 token 的媒体播放列表：
    //   #EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1
    //   playlist.m3u8?hls_ctx=<token>
    // 直接把主播放列表交给前端，可能因 BANDWIDTH=1 导致 hls.js 缓冲判定异常、
    // 播完首批切片后不再续播。这里先解析出带 token 的媒体播放列表地址再返回，
    // 让 hls.js 直接加载稳定的直播媒体列表。
    // webcast 服务器会校验 Referer/Origin（来自 www.hkstv.tv 直播页），缺失会被拒绝，
    // 解析与后续分片拉取都必须携带，否则请求直接失败/被拒。
    const HKSTV_REFERER = 'https://www.hkstv.tv/'
    const HKSTV_ORIGIN = 'https://www.hkstv.tv'
    const HKSTV_STREAM_HEADERS = {
      'Referer': HKSTV_REFERER,
      'Origin': HKSTV_ORIGIN,
      'User-Agent': ua,
      'Accept': 'application/vnd.apple.mpegurl, */*',
    }
    const MASTER_URL = 'http://webcast.hkstv.tv/livestream/mutfysrq/playlist.m3u8'
    // 官方 webcast 地址失效/被拒时，退回已验证可用的 HTTPS CDN 镜像，绝不把退化主播放列表
    // （BANDWIDTH=1）交给前端（否则 hls.js 会播完首批切片后停止续播）。
    const CDN_FALLBACKS = [
      'https://piccpndks.v.kcdnvip.com/audio/xianggangweishi_2.m3u8',
      'https://piccpndali.v.myalicdn.com/audio/xianggangweishi_2.m3u8',
    ]
    try {
      const resp = await session.defaultSession.fetch(MASTER_URL, { headers: HKSTV_STREAM_HEADERS })
      if (resp && resp.ok) {
        const text = await resp.text()
        // 变体 URI 可能是相对路径（playlist.m3u8?hls_ctx=...）也可能是绝对 URL，
        // 逐行取第一个非注释的 m3u8 行，并用主播放列表地址解析成绝对地址。
        let mediaUrl = ''
        for (const line of text.split(/\r?\n/)) {
          const t = line.trim()
          if (!t || t.startsWith('#')) continue
          if (/\.m3u8(\?|$)/i.test(t)) {
            try { mediaUrl = new URL(t, MASTER_URL).toString() } catch (_) { mediaUrl = '' }
            if (mediaUrl) break
          }
        }
        if (!mediaUrl) {
          // 兜底：兼容旧的 token 提取方式
          const tokenMatch = text.match(/playlist\.m3u8\?hls_ctx=([A-Za-z0-9_\-]+)/i)
          if (tokenMatch && tokenMatch[1]) mediaUrl = `${MASTER_URL}?hls_ctx=${tokenMatch[1]}`
        }
        if (mediaUrl) {
          return [{
            url: mediaUrl,
            format: 'm3u8',
            isLive: true,
            headers: HKSTV_STREAM_HEADERS,
          }]
        }
      }
    } catch (_) { /* 主播放列表解析失败，回退到已验证 CDN 镜像 */ }
    return CDN_FALLBACKS.map((u) => ({ url: u, format: 'm3u8', isLive: true, headers: {} }))
  }

  // === 山西网络广播电视台 (sxrtv.com)：info.json 签名 + 码率/源站动态拼流 ===
  if (site === 'sxrtv') {
    try {
      const r = await resolveSxrtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 海南网络广播电视台 (hnntv.cn)：play API 签名短效地址 ===
  if (site === 'hnntv') {
    try {
      const r = await resolveHnntvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 广西网络广播电视台 (gxtv.cn)：channelList 接口 + TS 解密代理 ===
  if (site === 'gxtv') {
    try {
      const r = await resolveGxtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 陕西网络广播电视台 (snrtv.com)：解密 stream.js 得到频道 m3u8 表 ===
  if (site === 'snrtv') {
    try {
      const r = await resolveSnrtvPlayUrl(pageUrl)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 江苏荔枝网 (live.jstv.com)：GetWebToken 鉴权 + 流地址短效签名 ===
  if (site === 'jstv') {
    const chMatch = (pageUrl || '').match(/channelId=(\d+)/i)
    const chId = chMatch ? chMatch[1] : '0'
    try {
      const r = await resolveJstvPlayUrl(chId, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 青岛网络电视台 (www.qtv.com.cn)：本地代理 + Arcvideo 分片解密 ===
  if (site === 'qtv') {
    try {
      const r = await resolveQtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 芒果TV (mgtv.com)：live/source MD5 签名接口 ===
  // 芒果TV 页面是 Nuxt SPA，HTML 只有渲染骨架和 CSS/JS 资源链接，不含任何 m3u8，
  // 走通用兜底的正则只会把 tcplayer.min.css 这类静态资源误判成直播流，
  // 因此这里取流失败时直接返回空数组，不再回退通用兜底。
  if (site === 'mgtv') {
    try {
      const r = await resolveMgtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 取流失败：芒果TV 部分频道（如湖南卫视 2778）本身不提供网页直播 */ }
    return []
  }

  // === 看看新闻 (kankanews.com)：RSA 解密 + 本地代理中转 ===
  if (site === 'kankanews') {
    try {
      const r = await resolveKankanewsPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 福建台 (live.fjtv.net)：MD5 签名 API ===
  if (site === 'fjtv') {
    try {
      const r = await resolveFjtvPlayUrl(pageUrl)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 江西台 (jxntv.cn)：liveauth 鉴权 API ===
  if (site === 'jxntv') {
    try {
      const r = await resolveJxntvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 河北台 (hebrts.cn)：频道列表 + MD5 签名 ===
  if (site === 'hebrtv') {
    try {
      const r = await resolveHebrtvPlayUrl(pageUrl)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 湖北长江云 (news.hbtv.com.cn)：频道页 stream → get_cdn_leech 换票 + 统一会话代理自动续签 ===
  if (site === 'hbtv') {
    try {
      const r = await resolveHbtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 内蒙古台 (nmtv.cn)：XXTEA 加密 API ===
  if (site === 'nmtv') {
    try {
      const r = await resolveNmtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 贵州台 (gzstv.com)：/tv/{slug} 接口 ===
  if (site === 'gzstv') {
    try {
      const r = await resolveGzstvPlayUrl(pageUrl)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 东北网 / 黑龙江台 (dbw.cn)：纯静态映射 ===
  if (site === 'dbw') {
    try {
      const r = await resolveDbwPlayUrl(pageUrl)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 浙江台 / 中国蓝TV (cztv.com)：playInfo 接口 + auth_key 签名 ===
  if (site === 'cztv') {
    try {
      const r = await resolveCztvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 广东台 / 荔枝网 (gdtv.cn)：签名 + 预检 + 会话节点的官方取流链路 ===
  if (site === 'gdtv') {
    try {
      const r = await resolveGdtvPlayUrl(pageUrl, ua)
      if (r && r.url) return [{ url: r.url, headers: r.headers || {}, format: 'm3u8', isLive: true }]
    } catch (_) { /* 解析失败则继续走通用兜底 */ }
  }

  // === 通用兜底：未配置专属解析分支的站点，纯逻辑（HTTP 抓取）解析直播流 ===
  // 视频流解析模块严禁加载网页（不新建 BrowserWindow / webview），
  // 只通过 HTTP 请求抓取页面 HTML / 接口 JSON，再用正则提取 m3u8/flv 直播流，
  // 直接把流地址交给播放器。解析不到真实媒体流时返回空数组，
  // 前端只提示失败，不会回退网页版播放。
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) {
    try {
      const sess = session.defaultSession
      const resp = await sess.fetch(pageUrl, {
        headers: { 'User-Agent': ua, 'Referer': pageUrl },
      })
      if (resp && resp.ok) {
        const html = await resp.text()
        const found = extractVideoUrlsFromHtml(html, pageUrl)
        const results = []
        const seen = new Set()
        // 优先 m3u8，其次 flv/mp4/ts
        for (const u of found) {
          if (!u || seen.has(u)) continue
          seen.add(u)
          results.push({ url: u, format: guessFormatFromUrl(u), isLive: true })
        }
        if (results.length > 0) return results
      }
    } catch (_) { /* 抓取/解析失败则返回空数组，由前端回退网页版 */ }
  }

  return []
}

// TEMP DIAG (remove before ship)
module.exports._yspDiag = {
  jceTimeshiftUrl: yspJceTimeshiftUrl,
  bkResolveUrl: yspBkResolveUrl,
  createCKey: yspCreateCKey,
  fetchCapiChannelList: yspFetchCapiChannelList,
  getChannelId: (pid) => (yspPidToChannelId ? yspPidToChannelId[pid] : null) || YSP_BUILTIN_SID[pid] || null,
}