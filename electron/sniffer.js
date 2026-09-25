const { BrowserWindow, session } = require('electron')
const { URL } = require('url')
const path = require('path')
const https = require('https')

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

      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

// Site detector registry
const SITE_DETECTORS = [
  {
    name: 'bilibili',
    match: (url) => /bilibili\.com\/video\//i.test(url),
    generate: generateBilibiliUrls,
  },
  {
    name: 'cctv',
    match: (url) => /tv\.cctv\.com\/live\//i.test(url) || /cctv\.com\/live/i.test(url),
    generate: generateCctvUrls,
  },
  {
    name: 'iqilu',
    match: (url) => /v\.iqilu\.com/i.test(url),
    generate: generateIqiluUrls,
  },
  {
    name: 'tv-station',
    match: (url) => /(gdtv|cztv|gxtv|wasu|7sefun|acgkkkk)\./i.test(url),
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
    { regex: /(https?:\/\/[^\s"'<>]+?\/(?:player|embed|video|play|live)\/[^\s"'<>]+)/gi, prio: 7 },
  ]

  for (const { regex } of patterns) {
    let match
    while ((match = regex.exec(html)) !== null) {
      let url = match[1] || match[0]
      url = url.replace(/[,;:!?)\]}>\s]+$/, '').trim()
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

  // Filter out the page URL itself (leaked by /video/ path patterns)
  if (baseUrl) {
    const baseClean = baseUrl.replace(/\/$/, '')
    return found.filter(u => {
      const cleanU = u.replace(/\/$/, '')
      return cleanU !== baseClean && cleanU !== baseClean + '/'
    })
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
  if (lower.endsWith('.avi') || lower.endsWith('.wmv') || lower.endsWith('.m4v')) return 'mp4'
  if (/^rtmp[s]?:\/\//i.test(url)) return 'rtmp'
  if (/^rtsp:\/\//i.test(url)) return 'rtsp'
  if (/m3u8/i.test(url)) return 'm3u8'
  if (/mp4/i.test(url)) return 'mp4'
  if (/flv/i.test(url)) return 'flv'
  return 'unknown'
}

// ===== Deep sniff =====

function deepSniffUrls(pageUrl) {
  return new Promise((resolve) => {
    const capturedUrls = []
    const extractedMetadata = { site: null }
    const partitionKey = 'sniff-' + Date.now() + '-' + Math.random().toString(36).slice(2)
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
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
  guessFormatFromUrl,
  probeContentTypeFast,
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
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...opts.headers,
      },
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
    req.end()
  })
}

async function resolvePlayUrl(siteMeta) {
  if (!siteMeta || !siteMeta.site) return []
  
  let { site, bvid, cid, pid, pageUrl } = siteMeta
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  
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
  
  // === CCTV ===
  if (site === 'cctv') {
    try {
      const sess = session.defaultSession
      const fresh = []

      if (pid) {
        // Use vdnad.apps.cntv.cn (NOT vdn.apps.cntv.cn) with JSONP response wrapper
        const ref = pageUrl || 'https://tv.cctv.com/'
        const resp = await sess.fetch(
          `https://vdnad.apps.cntv.cn/api/getHttpStream?pid=${pid}`,
          { headers: { 'User-Agent': ua, 'Referer': ref, 'Origin': 'https://tv.cctv.com' } }
        )
        if (resp.ok) {
          const text = await resp.text()
          // Response is JSONP: var html5VideoData = '...' or plain JSON
          let jsonStr = text
          const jsonpM = text.match(/var\s+html5VideoData\s*=\s*'([^']*)'/i)
            || text.match(/html5VideoData\s*=\s*({[^]*})/i)
          if (jsonpM) jsonStr = jsonpM[1] || jsonpM[2]

          try {
            const data = JSON.parse(jsonStr)
            if (data?.hls_url) fresh.push({ url: data.hls_url, format: 'm3u8', isLive: true })
            if (data?.flv_url) fresh.push({ url: data.flv_url, format: 'flv', isLive: true })
            if (data?.video) fresh.push({ url: data.video, format: 'm3u8', isLive: true })
            if (data?.url) fresh.push({ url: data.url, format: 'm3u8', isLive: true })
            if (data?.data?.hls_url) fresh.push({ url: data.data.hls_url, format: 'm3u8', isLive: true })
          } catch (_) {}
        }
      }

      return fresh
    } catch (_) { return [] }
  }
  
  // === iqilu ===
  if (site === 'iqilu') {
    try {
      const sess = session.defaultSession
      // iqilu uses config-based API, try to get fresh URL from page data
      if (pid) {
        const resp = await sess.fetch(`https://api.iqilu.com/live/getStream?pid=${pid}`, {
          headers: { 'User-Agent': ua, 'Referer': 'https://v.iqilu.com/', 'Origin': 'https://v.iqilu.com' }
        })
        if (resp.ok) {
          const data = await resp.json()
          if (data?.url) return [{ url: data.url, format: 'm3u8', isLive: true }]
          if (data?.data?.url) return [{ url: data.data.url, format: 'm3u8', isLive: true }]
          if (data?.hls_url) return [{ url: data.hls_url, format: 'm3u8', isLive: true }]
        }
      }
      return []
    } catch (_) { return [] }
  }
  
  return []
}