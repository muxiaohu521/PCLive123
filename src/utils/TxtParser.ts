type JsonObject = Record<string, unknown>

const DEFAULT_GROUP = '直播'
const LEGACY_DEFAULT = 'Ungrouped'

const TITLE_PATTERN = /.*,(.+?)$/
const GROUP_PATTERN = /group-title="(.*?)"/
const TVG_LOGO_PATTERN = /tvg-logo="(.*?)"/
const TVG_NAME_PATTERN = /tvg-name="(.*?)"/
const TVG_ID_PATTERN = /tvg-id="(.*?)"/
const TVG_CHNO_PATTERN = /tvg-chno="(.*?)"/
const TVG_SHIFT_PATTERN = /tvg-shift="(.*?)"/
const UA_PATTERN = /http-user-agent="(.*?)"/
const CATCHUP_PATTERN = /catchup="(.*?)"/
const CATCHUP_SRC_PATTERN = /catchup-source="(.*?)"/
const CATCHUP_REPL_PATTERN = /catchup-replace="(.*?)"/
const CATCHUP_DAYS_PATTERN = /catchup-days="(.*?)"/
const EXTVLCOPT_REFERER = /http-referrer[:=]\s*(.+)$/i
const EXTVLCOPT_UA_VLC = /http-user-agent[:=]\s*(.+)$/i
const EXTVLCOPT_ORIGIN = /http-origin[:=]\s*(.+)$/i
const EXTGRP_PATTERN = /^#EXTGRP:\s*(.+?)\s*$/i
const KODIPROP_PATTERN = /^#KODIPROP:\s*(.+?)\s*$/i
const PLAYLIST_PATTERN = /^#PLAYLIST:\s*(.+?)\s*$/i
const RADIO_PATTERN = /radio="(true|false)"/i
const QUALITY_PATTERN = /\[(\d{3,4}[Pp]|4[Kk]|8[Kk]|高清|超清|蓝光|HDR|杜比)\]|<(\d{3,4}[Pp]|4[Kk]|8[Kk])>/g

export function safeStr(v: unknown, d: string = ''): string {
  return typeof v === 'string' ? v : d
}

export function stripJsonComments(str: string): string {
  let result = str.replace(/^\s*\/\/[^\r\n]*/gm, '').replace(/,(\s*\r?\n\s*[}\]])/g, '$1')
  result = stripHashComments(result)
  result = fixUnquotedKeysAndValues(result)
  result = sanitizeJsonControlChars(result)
  result = result.replace(/,(\s*\r?\n\s*[}\]])/g, '$1').replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')
  return result
}

function stripHashComments(str: string): string {
  let result = ''
  let i = 0
  let inString = false
  let escaped = false

  while (i < str.length) {
    const ch = str[i]
    if (escaped) { result += ch; escaped = false; i++; continue }
    if (ch === '\\' && inString) { escaped = true; result += ch; i++; continue }
    if (ch === '"') { inString = !inString; result += ch; i++; continue }

    if (!inString && ch === '#') {
      while (i < str.length && str[i] !== '\n' && str[i] !== '\r') i++
      continue
    }
    result += ch
    i++
  }
  return result
}

function fixUnquotedKeysAndValues(str: string): string {
  let result = ''
  let i = 0
  let inString = false
  let escaped = false

  while (i < str.length) {
    const ch = str[i]
    if (escaped) { result += ch; escaped = false; i++; continue }
    if (ch === '\\' && inString) { escaped = true; result += ch; i++; continue }
    if (ch === '"') { inString = !inString; result += ch; i++; continue }
    if (ch === "'" && !inString) { result += '"'; i++; continue }

    if (inString) { result += ch; i++; continue }

    if (ch === '{' || ch === ',' || ch === '[') {
      result += ch
      i++
      while (i < str.length && (str[i] === ' ' || str[i] === '\t' || str[i] === '\r' || str[i] === '\n')) {
        result += str[i]; i++
      }
      if (i < str.length && str[i] !== '"' && str[i] !== '}' && str[i] !== ']' && str[i] !== '[' && str[i] !== '{') {
        result += '"'
        while (i < str.length) {
          const c = str[i]
          if (c === ':' || c === ',' || c === '}' || c === ']' || c === '\n' || c === '\r') {
            result += '"'
            break
          }
          if (c === '"') { result += '\\"'; i++; continue }
          result += c
          i++
        }
        if (i < str.length) result += str[i]
        i++
        continue
      }
      continue
    }

    if (ch === ':') {
      result += ch
      i++
      while (i < str.length && (str[i] === ' ' || str[i] === '\t' || str[i] === '\r' || str[i] === '\n')) {
        result += str[i]; i++
      }
      if (i < str.length) {
        const next = str[i]
        if (next !== '"' && next !== '{' && next !== '[' &&
            !(next >= '0' && next <= '9') && next !== '-' &&
            !str.substring(i, i + 4).startsWith('true') &&
            !str.substring(i, i + 5).startsWith('false') &&
            !str.substring(i, i + 4).startsWith('null')) {
          result += '"'
          while (i < str.length) {
            const c = str[i]
            if (c === ',' || c === '}' || c === ']' || c === '\n' || c === '\r') {
              result += '"'
              break
            }
            if (c === '"') { result += '\\"'; i++; continue }
            result += c
            i++
          }
          if (i < str.length) result += str[i]
          i++
          continue
        }
      }
      continue
    }

    result += ch
    i++
  }
  return result
}

function sanitizeJsonControlChars(str: string): string {
  let inString = false
  let escaped = false
  let result = ''
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (escaped) {
      result += ch
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      result += ch
      continue
    }
    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }
    if (inString && ch.charCodeAt(0) < 0x20) {
      if (ch === '\t') result += '\\t'
      else if (ch === '\n') result += '\\n'
      else if (ch === '\r') result += '\\r'
      else result += '\\u' + ('000' + ch.charCodeAt(0).toString(16)).slice(-4)
      continue
    }
    result += ch
  }
  return result
}

export function isJson(str: string): boolean {
  try { JSON.parse(stripJsonComments(str.trim())); return true } catch (_) { return false }
}

function isUrl(s: string): boolean {
  return /^(https?|rtmp|rtsp|rtp|mms|p2p|mitv|tvbus|mitv|pci):\/\/|^\/\//i .test(s)
}

export function detectAndDecode(buffer: ArrayBuffer): string {
  const arr = new Uint8Array(buffer)

  // 1. BOM 检测
  if (arr.length >= 3 && arr[0] === 0xEF && arr[1] === 0xBB && arr[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(arr.subarray(3))
  }
  if (arr.length >= 2 && arr[0] === 0xFF && arr[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(arr)
  }
  if (arr.length >= 2 && arr[0] === 0xFE && arr[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(arr)
  }

  // 2. 以 UTF-8（非 fatal）解码，统计 U+FFFD 替换字符数量来判断乱码程度
  const utf8Result = new TextDecoder('utf-8', { fatal: false }).decode(arr)
  const brokenCount = (utf8Result.match(/\uFFFD/g) || []).length

  // 无乱码或乱码占比低于 0.5%，直接返回 UTF-8 结果
  if (brokenCount === 0 || (utf8Result.length > 0 && brokenCount / utf8Result.length < 0.005)) {
    return utf8Result
  }

  // 3. 中文编码回退：GBK / GB2312 / GB18030
  const gbkEncodings = ['gbk', 'gb2312', 'gb18030']
  for (const enc of gbkEncodings) {
    try {
      const result = new TextDecoder(enc, { fatal: false }).decode(arr)
      const resultBroken = (result.match(/\uFFFD/g) || []).length
      if (resultBroken < brokenCount) {
        return result
      }
    } catch {
      // 当前环境不支持该编码，尝试下一个
    }
  }

  // 4. 繁体中文 Big5 回退
  try {
    const big5Result = new TextDecoder('big5', { fatal: false }).decode(arr)
    const big5Broken = (big5Result.match(/\uFFFD/g) || []).length
    if (big5Broken < brokenCount) {
      return big5Result
    }
  } catch {
    // Big5 不支持
  }

  // 5. 最终回退 UTF-8
  return utf8Result
}

function extractQuality(title: string): string {
  const matches = title.match(QUALITY_PATTERN)
  if (!matches) return ''
  const cleaned = matches.map(m => m.replace(/[\[\]<>]/g, ''))
  return [...new Set(cleaned)].join(',')
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  '#x2f': '/',
  '#47': '/',
}

function sanitizeUrl(url: string): string {
  let result = url
  let prev = ''
  while (prev !== result) {
    prev = result
    result = result.replace(/&(amp|lt|gt|quot|apos|#39|#x2f|#47);/gi, (_, entity) => {
      return HTML_ENTITY_MAP[entity.toLowerCase()] || entity
    })
    result = result.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    result = result.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }
  return result
}

function get(line: string, pattern: RegExp): string {
  const m = line.match(pattern)
  return m ? m[1].trim() : ''
}

function put(obj: Record<string, unknown>, key: string, val: string) {
  if (val) obj[key] = val
}

function normGroup(name: string): string {
  if (!name) return DEFAULT_GROUP
  name = name.trim()
  return (!name || name === LEGACY_DEFAULT) ? DEFAULT_GROUP : name
}

function findGroup(groups: JsonObject[], name: string): JsonObject {
  name = normGroup(name)
  const g = groups.find(g => g.group === name)
  if (g) return g
  const ng: JsonObject = { group: name, channels: [] }
  groups.push(ng)
  return ng
}

function findChannel(channels: JsonObject[], name: string): JsonObject | null {
  return channels.find(c => safeStr(c.name, '') === name) || null
}

function mergeMeta(dst: Record<string, unknown>, src: Record<string, unknown>) {
  for (const k of Object.keys(src)) dst[k] = src[k]
}

function buildMeta(line: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  put(obj, 'logo', get(line, TVG_LOGO_PATTERN))
  put(obj, 'tvg-id', get(line, TVG_ID_PATTERN))
  put(obj, 'tvg-name', get(line, TVG_NAME_PATTERN))
  put(obj, 'tvg-chno', get(line, TVG_CHNO_PATTERN))
  put(obj, 'tvg-shift', get(line, TVG_SHIFT_PATTERN))
  put(obj, 'ua', get(line, UA_PATTERN))
  const radio = get(line, RADIO_PATTERN)
  if (radio) obj.isRadio = radio === 'true'
  const type = get(line, CATCHUP_PATTERN)
  const src = get(line, CATCHUP_SRC_PATTERN)
  const repl = get(line, CATCHUP_REPL_PATTERN)
  const days = get(line, CATCHUP_DAYS_PATTERN)
  if (type || src || repl || days) obj['catchup'] = { type, source: src, replace: repl, days }
  return obj
}

function buildSetting(line: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  const getVal = (k: string) => {
    const i = line.indexOf(k)
    if (i < 0) return ''
    return line.substring(i + k.length).trim()
  }
  put(obj, 'ua', getVal('ua'))
  put(obj, 'parse', getVal('parse'))
  put(obj, 'click', getVal('click'))
  put(obj, 'format', getVal('format'))
  put(obj, 'origin', getVal('origin'))
  put(obj, 'referer', getVal('referer'))
  if (line.startsWith('header')) {
    try { obj['header'] = JSON.parse(getVal('header')) } catch (_) {}
  }
  if (line.startsWith('#EXTHTTP:')) {
    try { obj['header'] = JSON.parse(line.split('#EXTHTTP:')[1].trim()) } catch (_) {}
  }
  return obj
}

function isSetting(line: string): boolean {
  return /^(ua|parse|click|header|format|origin|referer)\b/i.test(line) || line.startsWith('#EXTHTTP:')
}

function mergeChannel(dst: JsonObject, src: JsonObject) {
  const dUrls = (dst.urls as string[]) || []
  const sUrls = (src.urls as string[]) || []
  for (const u of sUrls) {
    if (isUrl(u) && !dUrls.includes(u)) dUrls.push(u)
  }
  dst.urls = dUrls
  for (const k of Object.keys(src)) {
    if (k === 'urls') continue
    const v = dst[k]
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
      dst[k] = src[k]
    }
  }
}

function addChannel(group: JsonObject, channel: JsonObject) {
  const channels = group.channels as JsonObject[]
  const name = safeStr(channel.name, '')
  const exist = name ? findChannel(channels, name) : null
  if (exist) {
    mergeChannel(exist, channel)
  } else {
    channels.push(channel)
  }
}

function parseM3u(str: string): JsonObject[] {
  const groups: JsonObject[] = []
  const lines = str.replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
  let curGroup: JsonObject | null = null
  let pending: JsonObject | null = null
  let pendingMeta: Record<string, unknown> = {}
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#EXTM3U')) { mergeMeta(pendingMeta, buildMeta(line)); continue }
    if (isSetting(line)) { mergeMeta(pendingMeta, buildSetting(line)); continue }
    if (line.startsWith('#EXTGRP:')) {
      const grpMatch = line.match(EXTGRP_PATTERN)
      if (grpMatch) curGroup = findGroup(groups, grpMatch[1])
      continue
    }
    if (line.startsWith('#KODIPROP:')) {
      const kodiMatch = line.match(KODIPROP_PATTERN)
      if (kodiMatch) pendingMeta.kodiProps = kodiMatch[1]
      continue
    }
    if (line.startsWith('#PLAYLIST:')) {
      const plMatch = line.match(PLAYLIST_PATTERN)
      if (plMatch) pendingMeta.playlistName = plMatch[1]
      continue
    }
    if (line.startsWith('#EXTINF') || line.includes('#EXTINF')) {
      const gName = normGroup(get(line, GROUP_PATTERN))
      curGroup = findGroup(groups, gName)
      const rawTitle = get(line, TITLE_PATTERN)
      pending = { name: rawTitle }
      const quality = extractQuality(rawTitle)
      if (quality) (pending as any).quality = quality
      mergeMeta(pending as Record<string, unknown>, buildMeta(line))
      mergeMeta(pending as Record<string, unknown>, pendingMeta)
      pendingMeta = {}
      continue
    }
    if (line.startsWith('#EXTVLCOPT:')) {
      const ref = get(line, EXTVLCOPT_REFERER)
      const ua = get(line, EXTVLCOPT_UA_VLC)
      const origin = get(line, EXTVLCOPT_ORIGIN)
      if (ref) pendingMeta.referer = ref
      if (ua) pendingMeta.ua = ua
      if (origin) pendingMeta.origin = origin
      continue
    }
    if (line.startsWith('#')) continue
    if (!curGroup) curGroup = findGroup(groups, DEFAULT_GROUP)
    if (!pending) pending = {}
    const parts = line.split('|', 2)
    const url = sanitizeUrl(parts[0].trim())
    if (!isUrl(url)) continue
    if (parts.length > 1) {
      mergeMeta(pendingMeta, buildSetting(parts[1]))
    }
    mergeMeta(pending as Record<string, unknown>, pendingMeta)
    const urls: string[] = (pending as any).urls || []
    if (!urls.includes(url)) urls.push(url)
    ;(pending as any).urls = urls
    addChannel(curGroup, pending)
    pendingMeta = {}
  }
  return groups
}

function parseTxt(str: string): JsonObject[] {
  const groups: JsonObject[] = []
  const lines = str.replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
  let curGroup: JsonObject | null = null
  let pendingMeta: Record<string, unknown> = {}
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('#')) { if (isSetting(line)) mergeMeta(pendingMeta, buildSetting(line)); continue }
    if (line.includes('#genre#')) {
      curGroup = findGroup(groups, line.split(',')[0].trim())
      pendingMeta = {}
      continue
    }
    const split = line.includes(',') ? line.split(',', 2) : line.split('\t', 2)
    if (split.length < 2) continue
    if (!curGroup) curGroup = findGroup(groups, DEFAULT_GROUP)
    const channel: JsonObject = { name: split[0].trim() }
    mergeMeta(channel, pendingMeta)
    const urlPart = split[1].trim()
    const urls: string[] = []
    for (const part of urlPart.split('#')) {
      const rawUrl = part.trim()
      const u = sanitizeUrl(rawUrl.split(/\s+/)[0])
      if (isUrl(u) && !urls.includes(u)) urls.push(u)
    }
    if (!urls.length) continue
    channel.urls = urls
    addChannel(curGroup, channel)
    pendingMeta = {}
  }
  return groups
}

function normalizeJson(groups: JsonObject[]): JsonObject[] {
  const allFlat = groups.length > 0 && groups.every(g => !g.channels && !g.channel && (g.name || g.title) && (g.url || (g.urls && Array.isArray(g.urls) && g.urls.length > 0)))
  if (allFlat) {
    const outG: JsonObject = { group: DEFAULT_GROUP, channels: [] }
    for (const g of groups) {
      const ch = normalizeChannelItem(g)
      addChannel(outG, ch)
    }
    return [(outG.channels as any[]).length > 0 ? outG : { group: DEFAULT_GROUP, channels: [] }]
  }

  const result: JsonObject[] = []
  for (const g of groups) {
    const outG: JsonObject = { group: normGroup(safeStr(g.group, '') || safeStr(g.name, DEFAULT_GROUP)), channels: [] }
    let chs = g.channels || g.channel
    if (chs && Array.isArray(chs)) {
      for (const raw of chs) {
        const ch = normalizeChannelItem(raw)
        if (raw.click) ch.click = safeStr(raw.click)
        if (raw.format) ch.format = safeStr(raw.format)
        if (raw.origin) ch.origin = safeStr(raw.origin)
        if (raw.referer) ch.referer = safeStr(raw.referer)
        if (raw['tvg-chno']) ch['tvg-chno'] = safeStr(raw['tvg-chno'])
        if (raw.catchup && typeof raw.catchup === 'object') ch.catchup = raw.catchup
        addChannel(outG, ch)
      }
    } else if (g.name || g.title) {
      const ch = normalizeChannelItem(g)
      addChannel(outG, ch)
    }
    if (!(outG.channels as any[]).length) (outG.channels as any[]) = []
    result.push(outG)
  }
  return result
}

export function parseToJsonArray(str: string): JsonObject[] {
  if (!str || !str.trim()) return []
  const s = str.replace(/^\uFEFF/, '').trim()
  try {
    const el = JSON.parse(s)
    if (Array.isArray(el)) return normalizeJson(el)
    if (el && typeof el === 'object' && !Array.isArray(el)) {
      return parseJsonObject(el)
    }
  } catch (_) {}
  if (s.startsWith('#EXTM3U')) return parseM3u(s)
  return parseTxt(s)
}

function parseFromBuffer(buffer: ArrayBuffer): JsonObject[] {
  if (!buffer || buffer.byteLength === 0) return []
  const str = detectAndDecode(buffer)
  return parseToJsonArray(str)
}

function parseJsonObject(obj: Record<string, unknown>): JsonObject[] {
  const result: JsonObject[] = []

  if (obj.channels && Array.isArray(obj.channels)) {
    const channels: JsonObject[] = []
    const grp: JsonObject = {
      group: safeStr(obj.group || obj.name, DEFAULT_GROUP),
      channels
    }
    for (const ch of obj.channels as any[]) {
      if (typeof ch === 'object' && ch !== null) {
        channels.push(normalizeChannelItem(ch))
      }
    }
    if (channels.length > 0) result.push(grp)
  }

  if (obj.groups && Array.isArray(obj.groups)) {
    for (const g of obj.groups as any[]) {
      if (typeof g === 'object' && g !== null) {
        const channels: JsonObject[] = []
        const grp: JsonObject = {
          group: safeStr(g.group || g.name, DEFAULT_GROUP),
          channels
        }
        const chs = g.channels || g.channel
        if (chs && Array.isArray(chs)) {
          for (const ch of chs) {
            if (typeof ch === 'object' && ch !== null) {
              channels.push(normalizeChannelItem(ch))
            }
          }
        }
        if (channels.length > 0) result.push(grp)
      }
    }
  }

  const entries = Object.entries(obj)
  const configKeys = new Set(['lives', 'sites', 'urls', 'spider', 'parses', 'flags', 'rules', 'hosts', 'proxy', 'wallpaper', 'doh'])
  const groupLikeEntries = entries.filter(([k, v]) => !configKeys.has(k) && Array.isArray(v) && v.length > 0 && typeof v[0] === 'object')
  if (groupLikeEntries.length > 0 && result.length === 0) {
    for (const [key, val] of groupLikeEntries) {
      const channels: JsonObject[] = []
      const grp: JsonObject = { group: key, channels }
      for (const ch of val as any[]) {
        if (typeof ch === 'object' && ch !== null) {
          channels.push(normalizeChannelItem(ch))
        }
      }
      if (channels.length > 0) result.push(grp)
    }
  }

  const stringLikeEntries = entries.filter(([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'string')
  if (stringLikeEntries.length > 0 && result.length === 0) {
    for (const [key, val] of stringLikeEntries) {
      const channels: JsonObject[] = []
      const grp: JsonObject = { group: key, channels }
      const arr = val as string[]
      for (let i = 0; i < arr.length; i += 2) {
        if (i + 1 < arr.length && isUrl(arr[i + 1])) {
          channels.push(normalizeChannelItem({ name: arr[i], url: arr[i + 1] }))
        }
      }
      if (channels.length > 0) result.push(grp)
    }
  }

  if (result.length === 0 && obj.name && obj.url && isUrl(safeStr(obj.url))) {
    result.push({
      group: safeStr(obj.group || obj['tvg-group'], DEFAULT_GROUP),
      channels: [normalizeChannelItem(obj)]
    })
  }

  return result
}

function normalizeChannelItem(raw: any): JsonObject {
  const ch: JsonObject = {}
  if (raw.name) ch.name = safeStr(raw.name)
  if (raw.urls && Array.isArray(raw.urls)) ch.urls = raw.urls.filter(isUrl)
  else if (raw.url && isUrl(raw.url)) ch.urls = [raw.url]
  if (raw.logo) ch.logo = safeStr(raw.logo)
  if (raw.ua) ch.ua = safeStr(raw.ua)
  if (raw['tvg-id']) ch['tvg-id'] = safeStr(raw['tvg-id'])
  if (raw['tvg-name']) ch['tvg-name'] = safeStr(raw['tvg-name'])
  if (raw.parse !== undefined) ch.parse = Number(raw.parse)
  if (raw.header && typeof raw.header === 'object') ch.header = raw.header
  return ch
}