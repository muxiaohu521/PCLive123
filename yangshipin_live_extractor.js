/**
 * 央视频 (yangshipin.cn) 直播流提取脚本
 * 从 https://www.yangshipin.cn/tv/home 获取所有央视频直播频道的流地址
 *
 * 用法: node yangshipin_live_extractor.js
 *
 * 策略:
 *   1. 抓取央视频直播首页 HTML，从内嵌 JSON/JS 数据中提取频道列表及 pid
 *   2. 对每个频道，调用央视频 API 获取实时流地址 (hls_url / flv_url)
 *   3. 汇总输出为 JSON 格式
 */

const https = require('https')
const http = require('http')
const { URL } = require('url')

// ========================= 配置 =========================
const BASE_URL = 'https://www.yangshipin.cn'
const LIVE_HOME = BASE_URL + '/tv/home'
const REQUEST_TIMEOUT = 12000
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
}

// ========================= 工具函数 =========================

function fetchJson(url, referer = BASE_URL + '/') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        'Referer': referer,
        'Origin': BASE_URL,
        'Accept': 'application/json, text/plain, */*',
      },
      rejectUnauthorized: false,
      timeout: REQUEST_TIMEOUT,
    }

    const req = mod.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body, json: JSON.parse(body) })
        } catch {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body, json: null })
        }
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
    req.end()
  })
}

function fetchText(url, referer = BASE_URL + '/') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const mod = parsed.protocol === 'https:' ? https : http
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        'Referer': referer,
        'Origin': BASE_URL,
      },
      rejectUnauthorized: false,
      timeout: REQUEST_TIMEOUT,
    }

    const req = mod.request(opts, (res) => {
      // Handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location, referer).then(resolve).catch(reject)
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body })
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
    req.end()
  })
}

// ========================= 第1步: 获取频道列表 =========================

/**
 * 从央视频直播首页提取频道信息
 * 策略：抓取 HTML，从 <script> 标签和全局变量中解析频道列表
 */
async function extractChannelList() {
  console.log('[1/4] 获取央视频直播首页 HTML...')
  const result = await fetchText(LIVE_HOME)
  if (!result.ok) {
    throw new Error(`获取首页失败: HTTP ${result.status}`)
  }
  const html = result.body

  // 尝试从多种数据源中提取频道信息
  const channels = []

  // --- 策略A: 从 <script id="__NEXT_DATA__" type="application/json"> 提取 ---
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i)
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1])
      console.log('  [√] 找到 __NEXT_DATA__ (Next.js SSR 数据)')
      const extracted = extractChannelsFromNextData(nextData)
      channels.push(...extracted)
    } catch (e) {
      console.log('  [×] __NEXT_DATA__ 解析失败:', e.message)
    }
  }

  // --- 策略B: 从 window.__NUXT__ / window.__DATA__ 提取 ---
  const nuxtMatch = html.match(/window\.__NUXT__\s*=\s*([\s\S]*?);/i)
    || html.match(/window\.__DATA__\s*=\s*([\s\S]*?);/i)
  if (nuxtMatch) {
    try {
      const nuxtData = JSON.parse(nuxtMatch[1])
      console.log('  [√] 找到 window.__NUXT__ / __DATA__')
      const extracted = extractChannelsFromNuxtData(nuxtData)
      channels.push(...extracted)
    } catch (e) {
      console.log('  [×] __NUXT__ 解析失败:', e.message)
    }
  }

  // --- 策略C: 从所有 <script> 标签中搜索频道相关 JSON ---
  if (channels.length === 0) {
    console.log('  [→] 从所有 script 标签中搜索频道数据...')
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
    let scriptMatch
    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      const content = scriptMatch[1]
      // 查找 { "data": { "list": [...] } } 之类的结构
      const listMatch = content.match(/"list"\s*:\s*\[/)
      if (!listMatch) continue

      // 尝试提取 JSON 片段
      try {
        const jsonCandidates = content.match(/\{[^}]*"list"\s*:\s*\[[\s\S]*?\]\s*\}/g)
        if (jsonCandidates) {
          for (const candidate of jsonCandidates) {
            try {
              const parsed = JSON.parse(candidate)
              const extracted = extractChannelsFromList(parsed.list || [])
              if (extracted.length > 0) {
                channels.push(...extracted)
              }
            } catch (_) { /* skip invalid JSON fragments */ }
          }
        }
      } catch (_) { /* skip */ }
    }
  }

  // --- 策略D: 搜索常见的频道 ID 模式 (pid=xxx / liveId=xxx / channel_id=xxx) ---
  if (channels.length === 0) {
    console.log('  [→] 从 HTML 中搜索频道 pid/id 模式...')
    const pidMatches = html.match(/["']pid["']\s*:\s*["']([^"']+)["']/gi) || []
    const liveIdMatches = html.match(/["']live_?id["']\s*:\s*["']([^"']+)["']/gi) || []
    const allIdMatches = [...new Set([...pidMatches, ...liveIdMatches])]

    for (const match of allIdMatches) {
      const valMatch = match.match(/:\s*["']([^"']+)["']/)
      if (valMatch) {
        const id = valMatch[1]
        if (id && id.length > 3 && !channels.find((c) => c.id === id)) {
          channels.push({ id, title: '(从 HTML 解析)', platform: 'yangshipin' })
        }
      }
    }
  }

  // 去重
  const unique = []
  const seen = new Set()
  for (const ch of channels) {
    if (!seen.has(ch.id)) {
      seen.add(ch.id)
      unique.push(ch)
    }
  }

  console.log(`  [→] 共提取到 ${unique.length} 个频道`)
  return unique
}

function extractChannelsFromNextData(data) {
  const channels = []
  try {
    const json = JSON.stringify(data)
    const props = data?.props?.pageProps || data?.pageProps || data?.props || data

    // 遍历可能的字段
    const candidates = [
      props?.list,
      props?.liveList,
      props?.channelList,
      props?.channels,
      props?.data?.list,
      props?.data?.liveList,
      props?.data?.channelList,
      props?.data?.channels,
      props?.result?.list,
      props?.result?.data,
    ]

    for (const list of candidates) {
      if (Array.isArray(list)) {
        const extracted = extractChannelsFromList(list, json)
        channels.push(...extracted)
        if (extracted.length > 0) break
      }
    }

    // 如果以上都没有，尝试深度搜索
    if (channels.length === 0) {
      const idPattern = /"pid":"([^"]+)"|"live_id":"([^"]+)"|"liveId":"([^"]+)"|"channel_id":"([^"]+)"|"channelId":"([^"]+)"/g
      let m
      while ((m = idPattern.exec(json)) !== null) {
        const id = m[1] || m[2] || m[3] || m[4] || m[5]
        if (id && id.length > 3 && id.length < 64 && !channels.find((c) => c.id === id)) {
          channels.push({ id, title: '(从JSON提取)', platform: 'yangshipin' })
        }
      }
    }
  } catch (_) { /* ignore */ }
  return channels
}

function extractChannelsFromNuxtData(data) {
  // 类似 __NEXT_DATA__ 的处理
  const channels = []
  try {
    const json = JSON.stringify(data)

    // Nuxt 常见数据路径
    const candidates = [
      data?.data,
      data?.state,
      data?.serverRendered && data,
      data?.[0],
    ]

    for (const candidate of candidates) {
      if (!candidate) continue
      const jsonStr = JSON.stringify(candidate)
      const idPattern = /"pid":"([^"]+)"|"live_id":"([^"]+)"|"liveId":"([^"]+)"|"channel_id":"([^"]+)"|"channelId":"([^"]+)"/g
      let m
      while ((m = idPattern.exec(jsonStr)) !== null) {
        const id = m[1] || m[2] || m[3] || m[4] || m[5]
        if (id && id.length > 3 && id.length < 64 && !channels.find((c) => c.id === id)) {
          channels.push({ id, title: '(从NUXT提取)', platform: 'yangshipin' })
        }
      }
    }
  } catch (_) { /* ignore */ }
  return channels
}

function extractChannelsFromList(list, fullJson) {
  const channels = []
  if (!Array.isArray(list)) return channels

  for (const item of list) {
    const id =
      item.pid ||
      item.live_id ||
      item.liveId ||
      item.channel_id ||
      item.channelId ||
      item.id ||
      item.guid ||
      ''
    const title =
      item.title ||
      item.name ||
      item.channelName ||
      item.channel_name ||
      item.label ||
      ''

    if (id && id.length > 3) {
      const ch = { id, title: title || '(未知频道)', platform: 'yangshipin' }
      channels.push(ch)
    }
  }

  return channels
}

// ========================= 第2步: 尝试央视频 API 获取频道列表 =========================

/**
 * 尝试直接调用央视频 API 获取频道列表
 * 央视频可能使用的 API 端点
 */
async function tryYangshipinApis() {
  console.log('[2/4] 尝试央视频 API 获取频道列表...')

  const apis = [
    // 主要API端点
    `${BASE_URL}/api/v1/live/list`,
    `${BASE_URL}/api/v1/live/channel_list`,
    `${BASE_URL}/api/v1/tv/channel_list`,
    `${BASE_URL}/api/v1/channel/list`,
    // 备选端点
    `${BASE_URL}/api/v2/live/list`,
    `${BASE_URL}/api/live/list`,
    `${BASE_URL}/api/v1/live/category_list`,
  ]

  for (const api of apis) {
    try {
      console.log(`  [→] 尝试: ${api}`)
      const result = await fetchJson(api)
      if (result.ok && result.json) {
        console.log(`  [√] API 成功: ${api} (HTTP ${result.status})`)

        // 解析返回数据
        const channels = extractChannelsFromApiResponse(result.json)
        if (channels.length > 0) {
          console.log(`  [→] 从 API 提取到 ${channels.length} 个频道`)
          return channels
        }
      }
    } catch (e) {
      // 继续尝试下一个
    }
  }

  console.log('  [×] 所有已知 API 端点均失败')
  return []
}

function extractChannelsFromApiResponse(data) {
  const channels = []
  const json = JSON.stringify(data)

  // 通用解析：找 list / data / items 数组
  const listCandidates = [
    data?.data?.list,
    data?.data?.items,
    data?.data?.channels,
    data?.data?.live_list,
    data?.data?.liveList,
    data?.list,
    data?.items,
    data?.channels,
    data?.result?.list,
    data?.result?.data,
    data?.body?.list,
    data?.body?.data,
  ]

  for (const list of listCandidates) {
    if (Array.isArray(list) && list.length > 0) {
      for (const item of list) {
        const id =
          item.pid ||
          item.live_id ||
          item.liveId ||
          item.channel_id ||
          item.channelId ||
          item.id ||
          item.guid ||
          ''
        const title =
          item.title ||
          item.name ||
          item.channelName ||
          item.channel_name ||
          item.label ||
          ''

        if (id && id.length > 3) {
          channels.push({ id, title: title || '(未知)', platform: 'yangshipin' })
        }
      }
      if (channels.length > 0) break
    }
  }

  // 如果 list 没找到，尝试从整个 JSON 中提取 pid
  if (channels.length === 0) {
    const idPattern = /"pid":"([^"]+)"|"live_id":"([^"]+)"|"liveId":"([^"]+)"|"channel_id":"([^"]+)"|"channelId":"([^"]+)"/g
    let m
    const seenIds = new Set()
    while ((m = idPattern.exec(json)) !== null) {
      const id = m[1] || m[2] || m[3] || m[4] || m[5]
      if (id && !seenIds.has(id) && id.length > 3 && id.length < 64) {
        seenIds.add(id)
        channels.push({ id, title: '(从API提取)', platform: 'yangshipin' })
      }
    }
  }

  return channels
}

// ========================= 第3步: 获取每个频道的直播流 =========================

/**
 * 对频道列表中的每个频道，尝试获取实时流地址
 * 尝试多个 API 端点
 */
async function fetchStreamUrls(channels) {
  console.log(`[3/4] 获取 ${channels.length} 个频道的直播流地址...`)

  const results = []

  for (const channel of channels) {
    console.log(`  [→] 获取: ${channel.title} (${channel.id})`)
    const streams = await fetchChannelStreams(channel)
    if (streams.length > 0) {
      console.log(`    [√] 找到 ${streams.length} 个流`)
      results.push({
        ...channel,
        streams,
      })
    } else {
      console.log(`    [×] 未找到流`)
      results.push({
        ...channel,
        streams: [],
      })
    }
  }

  return results
}

/**
 * 对单个频道尝试多个 API 获取流地址
 */
async function fetchChannelStreams(channel) {
  const streams = []
  const pid = channel.id

  // --- API 1: 央视频自有 API ---
  const yangshipinApis = [
    `${BASE_URL}/api/v1/live/detail?liveId=${pid}`,
    `${BASE_URL}/api/v1/live/detail?live_id=${pid}`,
    `${BASE_URL}/api/v1/live/detail?pid=${pid}`,
    `${BASE_URL}/api/v1/live/stream?liveId=${pid}`,
    `${BASE_URL}/api/v1/live/stream?pid=${pid}`,
    `${BASE_URL}/api/v1/live/play?pid=${pid}`,
    `${BASE_URL}/api/v1/live/play?liveId=${pid}`,
    `${BASE_URL}/api/v2/live/detail?liveId=${pid}`,
    `${BASE_URL}/api/v2/live/detail?pid=${pid}`,
  ]

  for (const api of yangshipinApis) {
    try {
      const result = await fetchJson(api)
      if (result.ok && result.json) {
        const urls = extractStreamUrlsFromResponse(result.json)
        if (urls.length > 0) {
          streams.push(...urls)
          break // 央视频自有API成功，不需要再试CCTV API
        }
      }
    } catch (_) {
      // 继续下一个
    }
  }

  // --- API 2: CCTV/CNTV API (央视频底层可能复用) ---
  if (streams.length === 0) {
    const cntvApis = [
      `https://vdnad.apps.cntv.cn/api/getHttpStream?pid=${pid}`,
      `https://vdn.apps.cntv.cn/api/getLiveSource?pid=${pid}`,
      `https://api.cntv.cn/video/videoinfoByGuid?serviceId=tvcctv&guid=${pid}`,
      `https://api.cntv.cn/NewLive/getLiveStream?pid=${pid}`,
    ]

    for (const api of cntvApis) {
      try {
        const result = await fetchJson(api, BASE_URL + '/')
        if (result.ok && result.json) {
          // vdnad API 可能返回 JSONP: var html5VideoData = '...'
          let jsonData = result.json
          if (!jsonData && typeof result.body === 'string') {
            // 尝试解析 JSONP
            const jsonpMatch =
              result.body.match(/var\s+html5VideoData\s*=\s*'([^']*)'/i) ||
              result.body.match(/html5VideoData\s*=\s*({[\s\S]*})/i)
            if (jsonpMatch) {
              try {
                jsonData = JSON.parse(jsonpMatch[1] || jsonpMatch[2])
              } catch (_) { }
            }
          }

          if (jsonData) {
            const urls = extractStreamUrlsFromResponse(jsonData)
            if (urls.length > 0) {
              streams.push(...urls)
              break
            }
          }
        } else if (result.ok && result.body) {
          // 尝试从非JSON响应中提取
          const jsonpMatch =
            result.body.match(/var\s+html5VideoData\s*=\s*'([^']*)'/i) ||
            result.body.match(/html5VideoData\s*=\s*({[\s\S]*})/i)
          if (jsonpMatch) {
            try {
              const jsonData = JSON.parse(jsonpMatch[1] || jsonpMatch[2])
              const urls = extractStreamUrlsFromResponse(jsonData)
              if (urls.length > 0) {
                streams.push(...urls)
                break
              }
            } catch (_) { }
          }

          // 直接查找 m3u8 等 URL
          const urlMatches = result.body.match(/(https?:\/\/[^\s"'<>]*?\.(?:m3u8|flv|m3u)[^\s"'<>]*)/gi)
          if (urlMatches) {
            for (const u of urlMatches) {
              if (!streams.find((s) => s.url === u)) {
                streams.push({ url: u, format: detectFormat(u), source: api })
              }
            }
            if (streams.length > 0) break
          }
        }
      } catch (_) {
        // 继续下一个
      }
    }
  }

  // 去重
  const unique = []
  const seen = new Set()
  for (const s of streams) {
    if (!seen.has(s.url)) {
      seen.add(s.url)
      unique.push(s)
    }
  }

  return unique
}

/**
 * 从 API 响应 JSON 中提取流 URL
 */
function extractStreamUrlsFromResponse(data) {
  const urls = []

  if (!data) return urls

  // 直接字段
  const directFields = [
    'hls_url', 'flv_url', 'rtmp_url', 'url', 'video',
    'stream_url', 'play_url', 'playurl', 'hlsUrl', 'flvUrl',
  ]
  for (const field of directFields) {
    if (data[field] && typeof data[field] === 'string' && /^https?:\/\//i.test(data[field])) {
      urls.push({ url: data[field], format: detectFormat(data[field]), source: field })
    }
  }

  // data 子对象
  if (data.data && typeof data.data === 'object') {
    for (const field of directFields) {
      if (data.data[field] && typeof data.data[field] === 'string' && /^https?:\/\//i.test(data.data[field])) {
        urls.push({ url: data.data[field], format: detectFormat(data.data[field]), source: 'data.' + field })
      }
    }
  }

  // 流质量列表 (央视频/CNTV 常见格式)
  const streamList = data.streams || data.data?.streams || data.video_list || data.data?.video_list || data.list
  if (Array.isArray(streamList)) {
    for (const s of streamList) {
      const streamUrl = s.url || s.hls_url || s.flv_url || s.play_url || s.stream_url || ''
      if (streamUrl && /^https?:\/\//i.test(streamUrl)) {
        urls.push({
          url: streamUrl,
          format: detectFormat(streamUrl),
          quality: s.quality || s.name || s.label || '',
          source: 'streams',
        })
      }
    }
  }

  // 递归搜索整个 JSON 中的 m3u8/flv 链接（当直接提取失败时）
  if (urls.length === 0) {
    const jsonStr = JSON.stringify(data)
    const matchPattern = /(https?:\/\/[^\s"'<>\\]*?\.(?:m3u8|flv|m3u)(?:\?[^\s"'<>\\]*)?)/gi
    let m
    const seen = new Set()
    while ((m = matchPattern.exec(jsonStr)) !== null) {
      const url = m[1]
      if (!seen.has(url)) {
        seen.add(url)
        urls.push({ url, format: detectFormat(url), source: 'json_deep_search' })
      }
    }
  }

  return urls
}

function detectFormat(url) {
  const lower = url.toLowerCase()
  if (lower.includes('.m3u8') || lower.includes('.m3u')) return 'm3u8'
  if (lower.includes('.flv')) return 'flv'
  if (lower.includes('.mp4')) return 'mp4'
  if (lower.includes('.ts')) return 'ts'
  if (lower.includes('.mpd')) return 'mpd'
  return 'unknown'
}

// ========================= 第4步: 汇总输出 =========================

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  央视频 (yangshipin.cn) 直播流提取工具')
  console.log('═══════════════════════════════════════════')
  console.log(`  目标: ${LIVE_HOME}`)
  console.log('')

  try {
    // Step 1: 从 HTML 提取频道列表
    let channels = await extractChannelList()

    // Step 2: 如果 HTML 提取不到，尝试 API
    if (channels.length === 0) {
      channels = await tryYangshipinApis()
    }

    // 如果两个方法都得到结果，合并
    if (channels.length === 0) {
      const apiChannels = await tryYangshipinApis()
      channels = [...channels, ...apiChannels]
      // 去重
      const unique = []
      const seen = new Set()
      for (const ch of channels) {
        if (!seen.has(ch.id)) {
          seen.add(ch.id)
          unique.push(ch)
        }
      }
      channels = unique
    }

    if (channels.length === 0) {
      console.log('')
      console.log('═══════════════════════════════════════════')
      console.log('  未能提取到任何频道信息')
      console.log('  可能原因:')
      console.log('    1. 央视频页面结构已变更')
      console.log('    2. 需要 Cookie/Token 认证')
      console.log('    3. 网络受限 (可能需要中国大陆IP)')
      console.log('═══════════════════════════════════════════')
      return
    }

    console.log('')
    console.log(`  频道列表 (${channels.length}个):`)
    channels.forEach((ch, i) => console.log(`    ${i + 1}. ${ch.title}  [${ch.id}]`))

    // Step 3: 获取每个频道的实时流
    console.log('')
    const results = await fetchStreamUrls(channels)

    // Step 4: 输出结果
    console.log('')
    console.log('═══════════════════════════════════════════')
    console.log('  提取结果汇总')
    console.log('═══════════════════════════════════════════')

    const successChannels = results.filter((r) => r.streams.length > 0)

    if (successChannels.length > 0) {
      console.log(`\n  成功获取 ${successChannels.length} 个频道的直播流:\n`)
      for (const ch of successChannels) {
        console.log(`  ┌─ ${ch.title} (${ch.id})`)
        for (const s of ch.streams) {
          console.log(`  ├── [${s.format}] ${s.url}`)
          if (s.quality) console.log(`  │   └─ 画质: ${s.quality}`)
        }
        console.log('  │')
      }
    } else {
      console.log('\n  未能获取到任何直播流地址')
    }

    // 输出完整 JSON 结果
    console.log('───────────────────────────────────────────')
    console.log('  JSON 结果:')
    console.log(JSON.stringify(results, null, 2))

    // 同时导出 m3u 播放列表格式
    if (successChannels.length > 0) {
      console.log('')
      console.log('───────────────────────────────────────────')
      console.log('  M3U 播放列表 (可导入 PotPlayer / VLC):')
      console.log('')
      console.log('#EXTM3U')
      for (const ch of successChannels) {
        for (const s of ch.streams) {
          const name = ch.title || ch.id
          const quality = s.quality ? ` [${s.quality}]` : ''
          console.log(`#EXTINF:-1,${name}${quality}`)
          console.log(s.url)
        }
      }
    }

    // 导出到文件
    const fs = require('fs')
    const path = require('path')
    const outDir = path.join(__dirname, 'cache')
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

    // 保存 JSON
    fs.writeFileSync(
      path.join(outDir, 'yangshipin_live.json'),
      JSON.stringify(results, null, 2),
      'utf8'
    )
    console.log(`\n  [√] JSON 已保存到: cache/yangshipin_live.json`)

    // 保存 M3U
    if (successChannels.length > 0) {
      let m3u = '#EXTM3U\n'
      for (const ch of successChannels) {
        for (const s of ch.streams) {
          const name = ch.title || ch.id
          const quality = s.quality ? ` [${s.quality}]` : ''
          m3u += `#EXTINF:-1,${name}${quality}\n${s.url}\n`
        }
      }
      fs.writeFileSync(path.join(outDir, 'yangshipin_live.m3u'), m3u, 'utf8')
      console.log(`  [√] M3U 已保存到: cache/yangshipin_live.m3u`)
    }

    console.log('')
    console.log('═══════════════════════════════════════════')
    console.log('  完成!')
    console.log('═══════════════════════════════════════════')

  } catch (err) {
    console.error('执行出错:', err.message)
    console.error(err.stack)
    process.exit(1)
  }
}

main()