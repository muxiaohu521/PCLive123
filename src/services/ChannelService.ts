import { parseToJsonArray, safeStr, stripJsonComments, isJson, detectAndDecode } from '@/utils/TxtParser'
import { createChannel, buildChannelGroup, scoreChannelUrl } from '@/models/LiveChannelItem'
import { APP_CONFIG, isElectron } from '@/constants'
import { logger } from '@/utils/logger'
import { isAdChannelName } from '@/utils/AdFilter'
import { crawlSourceUrlsFromHtml } from '@/utils/SourceCrawler'
import type { LiveChannelGroup, LiveSourceGroup, LiveChannelItem, CacheStorageEntry } from '@/models/LiveChannelItem'
import type { Ref } from 'vue'
import { getOptimalThreadCount, runParallel } from '@/utils/ThreadPool'


const FETCH_TIMEOUT = APP_CONFIG.FETCH_TIMEOUT
const STALL_TIMEOUT_MS = 300000 // effectively disabled: let all sub-sources complete
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 2000

function stripBackticks(s: string): string {
  return s.replace(/^`|`$/g, '').trim()
}

function resolveRelativeUrl(baseUrl: string, targetUrl: string): string {
  if (!targetUrl) return targetUrl
  if (/^https?:\/\//i.test(targetUrl)) return targetUrl
  try {
    return new URL(targetUrl, baseUrl).href
  } catch {
    const base = baseUrl.replace(/\/[^/]*$/, '/')
    const resolved = base + targetUrl.replace(/^\.\//, '')
    if (/^https?:\/\//i.test(resolved)) return resolved
    return targetUrl
  }
}

// ============ URL Suffix Stripping & Sanitization (from test_dongli.py) ============

const URL_SUFFIX_UA_RE = /[|$]User-Agent=([^|$]+)/i
const URL_SUFFIX_REF_RE = /[|$]Referer=([^|$]+)/i
const URL_SUFFIX_ORIGIN_RE = /[|$]Origin=([^|$]+)/i

function stripUrlSuffix(url: string): { cleanUrl: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  let clean = url

  const uaMatch = url.match(URL_SUFFIX_UA_RE)
  const refMatch = url.match(URL_SUFFIX_REF_RE)
  const originMatch = url.match(URL_SUFFIX_ORIGIN_RE)

  if (uaMatch) headers['User-Agent'] = uaMatch[1].trim()
  if (refMatch) headers['Referer'] = refMatch[1].trim()
  if (originMatch) headers['Origin'] = originMatch[1].trim()

  const pipeIdx = clean.indexOf('|')
  if (pipeIdx >= 0) clean = clean.substring(0, pipeIdx)
  const dollarSplit = clean.split(/[#$]/, 2)
  if (dollarSplit[0] && /^https?:\/\//i.test(dollarSplit[0])) clean = dollarSplit[0]

  return { cleanUrl: clean.trim(), headers }
}

function sanitizeUrl(url: string): string {
  try {
    new URL(url)
    return url
  } catch {
    try {
      const encoded = encodeURI(url)
      new URL(encoded)
      return encoded
    } catch {
      return url
    }
  }
}

// ============ Image/Binary Content Detection (from test_dongli.py) ============

const IMAGE_SIGNATURES: Array<{ sig: number[]; label: string }> = [
  { sig: [0xff, 0xd8, 0xff], label: 'JPEG' },
  { sig: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
  { sig: [0x47, 0x49, 0x46, 0x38], label: 'GIF' },
  { sig: [0x42, 0x4d], label: 'BMP' },
  { sig: [0x52, 0x49, 0x46, 0x46], label: 'RIFF/WEBP' },
  { sig: [0x00, 0x00, 0x01, 0x00], label: 'ICO' },
]

function isImageContent(data: Uint8Array): boolean {
  if (!data || data.length < 4) return false
  for (const { sig } of IMAGE_SIGNATURES) {
    if (sig.every((b, i) => data[i] === b)) return true
  }
  const head = new TextDecoder('ascii').decode(data.slice(0, 100)).toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return true
  return false
}

// ============ Binary Latin-1 Stego Scan (from test_dongli.py) ============

const STEGO_MARKER_RE = /[A-Za-z0-9]{8}\*\*/

function bytesToLatin1(bytes: Uint8Array): string {
  return new TextDecoder('latin-1').decode(bytes)
}

async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const stream = new Response(bytes as unknown as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))
      const buf = await new Response(stream).arrayBuffer()
      return new Uint8Array(buf)
    } catch { return bytes }
  }
  return bytes
}

function multiEncodingDecode(bytes: Uint8Array): string {
  for (const enc of ['utf-8', 'gb18030', 'gbk', 'big5']) {
    try {
      const result = new TextDecoder(enc, { fatal: false }).decode(bytes)
      const brokenCount = (result.match(/\uFFFD/g) || []).length
      if (brokenCount < result.length * 0.01) return result
    } catch { continue }
  }
  return new TextDecoder('latin-1').decode(bytes)
}

function tryStegoDecode(cleanedB64: string): Promise<string | null> {
  if (cleanedB64.length < 20) return Promise.resolve(null)
  for (const b64Text of [cleanedB64, cleanedB64.replace(/\s/g, '')]) {
    try {
      const binary = atob(b64Text)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return gunzipIfNeeded(bytes).then(decompressed => multiEncodingDecode(decompressed))
    } catch { continue }
  }
  return Promise.resolve(null)
}

async function extractBmpStegoFromBytes(data: Uint8Array): Promise<string | null> {
  if (!data || data.length < 20) return null
  const text = bytesToLatin1(data)
  return extractBmpStegoFromText(text)
}

async function extractBmpStegoFromText(text: string): Promise<string | null> {
  if (!text || text.length < 20) return null
  const markerMatch = text.match(STEGO_MARKER_RE)
  if (!markerMatch) return null
  const afterMarker = text.substring(text.indexOf(markerMatch[0]) + 10)
  const cleanedB64 = afterMarker.replace(/[^A-Za-z0-9+/=\r\n]/g, '')
  return tryStegoDecode(cleanedB64)
}

// GitHub mirrors for raw.githubusercontent.com (from test_dongli.py)
// 同域名也用于代理前缀检测与剥离
const GITHUB_MIRRORS = [
  'https://gh-proxy.org/',
  'https://mirror.ghproxy.com/',
  'https://gh.llkk.cc/',
  'https://gh.jiasu.in/',
  'https://github.moeyy.xyz/',
  'https://gh.con.sh/',
  'https://gh.api.99988866.xyz/',
]

function stripGhProxy(url: string): { strippedUrl: string; wasProxied: boolean } {
  for (const mirror of GITHUB_MIRRORS) {
    if (url.startsWith(mirror)) {
      const inner = url.substring(mirror.length)
      if (/^https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/.+/i.test(inner)) {
        return { strippedUrl: inner, wasProxied: true }
      }
      return { strippedUrl: inner, wasProxied: true }
    }
  }
  // URL 本身可能就是 raw.githubusercontent.com（无需剥离）
  if (/^https?:\/\/(?:raw\.githubusercontent\.com|github\.com)\/.+/i.test(url)) {
    return { strippedUrl: url, wasProxied: false }
  }
  return { strippedUrl: url, wasProxied: false }
}

// Channel URL quality scoring: stream URLs get priority, junk extensions get blocked
export function filterAndRankUrls(urls: string[]): string[] {
  if (!urls || urls.length === 0) return []
  const scored = urls
    .map(u => ({ url: u, score: scoreChannelUrl(u) }))
    .filter(item => item.score >= 0)
  scored.sort((a, b) => a.score - b.score)
  return scored.map(item => item.url)
}

// --- Crypto utilities for FindResult ---

function rightPadding(str: string, padChar: string, len: number): string {
  return (str + padChar.repeat(len)).substring(0, len)
}

function hexToUint8Array(hexStr: string): Uint8Array {
  const len = hexStr.length / 2
  const arr = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    arr[i] = parseInt(hexStr.substring(i * 2, i * 2 + 2), 16)
  }
  return arr
}

function atobToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

function stringToUint8Array(str: string): Uint8Array {
  const arr = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff
  return arr
}

async function aesCbcDecrypt(keyBytes: Uint8Array, ivBytes: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as globalThis.BufferSource, { name: 'AES-CBC' }, false, ['decrypt'])
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes as globalThis.BufferSource }, cryptoKey, data as globalThis.BufferSource)
  return new TextDecoder('utf-8').decode(decrypted)
}

async function aesEcbDecrypt(keyBytes: Uint8Array, data: Uint8Array): Promise<string | null> {
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as globalThis.BufferSource, { name: 'AES-ECB' } as AesKeyAlgorithm, false, ['decrypt'])
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-ECB' } as AesCbcParams, cryptoKey, data as globalThis.BufferSource)
    return new TextDecoder('utf-8').decode(decrypted)
  } catch {
    return null
  }
}

async function FindResult(rawContent: string, configKey?: string): Promise<string> {
  let content = rawContent
  try {
    if (isJson(content)) return content

    // 1. BMP stego marker in text content (after text decode)
    const stegoTextResult = await extractBmpStegoFromText(content)
    if (stegoTextResult) {
      content = stegoTextResult
      logger.log('[FindResult] BMP stego from text decoded, length:', content.length)
    }

    content = content.trim()

    // 2. 2423 AES-CBC decryption
    if (content.startsWith('2423')) {
      logger.log('[FindResult] 2423 encrypted content detected')
      content = content.replace(/\s+/g, '')
      const idx2324 = content.indexOf('2324')
      if (idx2324 >= 0) {
        const dataHex = content.substring(idx2324 + 4, content.length - 26)
        const byteBuf = hexToUint8Array(content)
        const binaryStr = bytesToLatin1(byteBuf).toLowerCase()
        const keyIdx = binaryStr.indexOf('$#')
        const ivIdx = binaryStr.indexOf('#$')
        if (keyIdx >= 0 && ivIdx > keyIdx) {
          const key = rightPadding(binaryStr.substring(keyIdx + 2, ivIdx), '0', 16)
          const iv = rightPadding(binaryStr.substring(binaryStr.length - 13), '0', 16)

          const dataBytes = new Uint8Array(dataHex.match(/.{1,2}/g)!.map(b => parseInt(b, 16)))
          const keyBytes = stringToUint8Array(key).slice(0, 16)
          const ivBytes = stringToUint8Array(iv).slice(0, 16)

          content = await aesCbcDecrypt(keyBytes, ivBytes, dataBytes)
          logger.log('[FindResult] 2423 AES-CBC decrypted, length:', content.length)
        }
      }
    } else if (configKey && !isJson(content)) {
      // 3. AES-ECB decrypt with config key
      logger.log('[FindResult] Attempting AES-ECB decrypt with config key')
      const keyBytes = stringToUint8Array(rightPadding(configKey, '0', 16)).slice(0, 16)
      try {
        const dataBytes = new Uint8Array(content.match(/.{1,2}/g)?.map(b => parseInt(b, 16)) || [])
        if (dataBytes.length > 0) {
          const result = await aesEcbDecrypt(keyBytes, dataBytes)
          if (result) {
            content = result
            logger.log('[FindResult] AES-ECB decrypted, length:', content.length)
          }
        }
      } catch (_) {}
    }

    // 4. Pure base64 + gzip decode
    if (!isJson(content) && content.length > 40) {
      const cleanedContent = content.replace(/\s/g, '')
      if (/^[A-Za-z0-9+/=]+$/.test(cleanedContent)) {
        try {
          const binary = atob(cleanedContent)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

          const decompressed = await gunzipIfNeeded(bytes)
          const decoded = multiEncodingDecode(decompressed)

          const trimmed = decoded.trim()
          if (trimmed.startsWith('{') || trimmed.startsWith('[') ||
              trimmed.startsWith('#EXTM3U') || trimmed.includes(',http')) {
            content = decoded
            logger.log('[FindResult] Base64 + gzip decoded, length:', content.length)
          } else {
            const plainDecoded = atobToUtf8(cleanedContent)
            if (plainDecoded.trim().startsWith('{') || plainDecoded.trim().startsWith('[') ||
                plainDecoded.trim().startsWith('#EXTM3U') || plainDecoded.includes(',http')) {
              content = plainDecoded
              logger.log('[FindResult] Base64 decoded (no gzip), length:', content.length)
            }
          }
        } catch (_) {}
      }
    }

    // 5. Extract M3U redirect URL from plain text
    if (!isJson(content) && /^https?:\/\//i.test(content.trim())) {
      const urlMatch = content.trim().match(/^(https?:\/\/[^\s]+\.(?:m3u|m3u8))/i)
      if (urlMatch) {
        content = urlMatch[0]
        logger.log('[FindResult] M3U URL extracted:', content.substring(0, 80))
      }
    }
  } catch (_) {}
  logger.log('[FindResult] Final content format:', isJson(content) ? 'JSON' : content.startsWith('#EXTM3U') ? 'M3U' : content.startsWith('http') ? 'URL' : 'unknown')
  return content
}

// --- End Crypto utilities ---

function extractJsonFromHtml(content: string): string {
  if (!content) return ''
  let s = content.trim()
  if (s.startsWith('\ufeff')) s = s.substring(1).trim()

  if (s.startsWith('{') || s.startsWith('[')) return s

  const firstChar = s.charAt(0)
  if (firstChar !== '<' && firstChar !== '\n' && firstChar !== '\r' && firstChar !== ' ') {
    const braceStart = s.indexOf('{')
    const bracketStart = s.indexOf('[')
    if (braceStart >= 0) {
      const start = bracketStart >= 0 && bracketStart < braceStart ? bracketStart : braceStart
      if (start < 100) {
        let extracted = s.substring(start)
        if (start === bracketStart) {
          const nextChar = s.charAt(bracketStart + 1)
          if (nextChar === '{' || nextChar === '"') {
            return extracted
          }
          return s.substring(braceStart)
        }
        return extracted
      }
    } else if (bracketStart >= 0 && bracketStart < 100) {
      const nextChar = s.charAt(bracketStart + 1)
      if (nextChar === '{' || nextChar === '"') {
        return s.substring(bracketStart)
      }
    }
  }

  for (const marker of ['"lives"', '"sites"', '"spider"', '"urls"']) {
    const idx = s.indexOf(marker)
    if (idx < 0) continue
    let braceStart = s.lastIndexOf('{', idx)
    if (braceStart < 0) continue
    let depth = 0
    let inString = false
    let escape = false
    for (let i = braceStart; i < s.length; i++) {
      const ch = s[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') { depth--; if (depth === 0) return s.substring(braceStart, i + 1) }
    }
  }

  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) return s.substring(start, end + 1)

  // Try to extract JSON from <script> tags (common in some TVBox sources)
  const scriptMatches = s.match(/<script[^>]*>([\s\S]*?)<\/script>/gi)
  if (scriptMatches) {
    for (const scriptTag of scriptMatches) {
      const inner = scriptTag.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim()
      // Try direct JSON
      if (inner.startsWith('{') || inner.startsWith('[')) {
        const js = /^(['"])\1/.test(inner) ? inner : inner
        const jStart = js.indexOf('{')
        const jEnd = js.lastIndexOf('}')
        if (jStart >= 0 && jEnd > jStart) return js.substring(jStart, jEnd + 1)
        const bStart = js.indexOf('[')
        const bEnd = js.lastIndexOf(']')
        if (bStart >= 0 && bEnd > bStart) return js.substring(bStart, bEnd + 1)
      }
      // Try var/let/const assignment containing JSON
      const assignMatch = inner.match(/(?:var|let|const)\s+\w+\s*=\s*(\{[\s\S]*\}|\[[\s\S]*\])/)
      if (assignMatch && assignMatch[1]) return assignMatch[1]
      // Try JSON.parse wrapper
      const parseMatch = inner.match(/JSON\.parse\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/)
      if (parseMatch && parseMatch[2]) {
        try {
          const unescaped = parseMatch[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
          if (unescaped.startsWith('{') || unescaped.startsWith('[')) return unescaped
        } catch (_) {}
      }
      // Try base64 inside script
      const b64Match = inner.match(/['"`]([A-Za-z0-9+/=]{40,})['"`]/)
      if (b64Match && b64Match[1]) {
        try {
          const decoded = atobToUtf8(b64Match[1])
          if (decoded.startsWith('{') || decoded.startsWith('[')) return decoded
        } catch (_) {}
      }
    }
  }

  return s
}

function buildSourceGroup(live: any, idx: number): LiveSourceGroup {
  const name = safeStr(live.name, '线路' + (idx + 1))
  const type = safeStr(live.type, '0')
  const url = stripBackticks(safeStr(live.url, safeStr(live.api, '')))
  const ua = safeStr(live.ua, '')
  let header: Record<string, string> = {}
  if (live.header && typeof live.header === 'object') {
    for (const [k, v] of Object.entries(live.header)) header[k] = String(v)
  } else if (ua) {
    header['User-Agent'] = ua
  }
  const playerType = Number(live.playerType) || 2
  return { name, type, url, ua, header, playerType }
}

function extractLivesGroups(jsonStr: string): LiveSourceGroup[] {
  try {
    const cleanJson = stripJsonComments(jsonStr.trim())
    const obj = JSON.parse(cleanJson)
    logger.log('[extractLivesGroups] JSON keys:', Object.keys(obj).join(', '),
      'hasLives:', !!(obj.lives && Array.isArray(obj.lives) && obj.lives.length > 0),
      'hasSites:', !!(obj.sites && Array.isArray(obj.sites) && obj.sites.length > 0),
      'hasUrls:', !!(obj.urls && Array.isArray(obj.urls)),
      'hasSpider:', !!(obj.spider))

    const groups: LiveSourceGroup[] = []

    const defaultSpiderJar = obj.spider && typeof obj.spider === 'string' && obj.spider.length > 5
      ? stripBackticks(obj.spider.split(';')[0].trim())
      : ''

    if (obj.lives && Array.isArray(obj.lives) && obj.lives.length > 0) {
      for (let idx = 0; idx < obj.lives.length; idx++) {
        const entry = obj.lives[idx]
        const grp = buildSourceGroup(entry, idx)
        const pt = Number(entry.playerType) || 2
        if (defaultSpiderJar && pt === 1 && !grp.spiderApi) {
          grp.spiderApi = defaultSpiderJar
          grp.spiderExt = grp.url
          grp.spiderJar = defaultSpiderJar
          logger.log('[extractLivesGroups] Spider assigned to live:', grp.name,
            'spiderApi:', defaultSpiderJar.substring(0, 80))
        }
        if (grp.type === '3') {
          const api = safeStr(entry.api, '')
          const jar = safeStr(entry.jar, '')
          const ext = entry.ext
          const effectiveJar = jar || defaultSpiderJar

          const extUrls: string[] = []
          if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
            for (const v of Object.values(ext)) {
              if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
                extUrls.push(stripBackticks(v))
              }
            }
          } else if (typeof ext === 'string' && /^https?:\/\//i.test(ext)) {
            extUrls.push(stripBackticks(ext))
          }

          if (extUrls.length > 0 && (!grp.url || !/^https?:\/\//i.test(grp.url))) {
            for (let ei = 0; ei < extUrls.length; ei++) {
              const extUrl = extUrls[ei]
              const subName = extUrls.length > 1 ? grp.name + '_' + (ei + 1) : grp.name
              const extGrp = buildSourceGroup({ name: subName, url: extUrl, type: '0' }, idx)
              const spiderApiUrl = api && /^https?:\/\//i.test(api) ? api : effectiveJar
              if (spiderApiUrl && /^https?:\/\//i.test(spiderApiUrl)) {
                extGrp.spiderApi = spiderApiUrl
                extGrp.spiderExt = extUrl
                extGrp.spiderJar = effectiveJar
              }
              groups.push(extGrp)
              logger.log('[extractLivesGroups] Type-3 live ext URL:', subName, extUrl,
                'spider:', spiderApiUrl ? spiderApiUrl.substring(0, 80) : '(none)')
            }
          } else {
            const extStr = typeof ext === 'string' ? stripBackticks(ext) : (ext && typeof ext === 'object' && extUrls.length === 0 ? JSON.stringify(ext) : '')
            if (api && /^https?:\/\//i.test(api)) {
              grp.spiderApi = api
              grp.spiderExt = extStr || grp.url
              grp.spiderJar = effectiveJar
              logger.log('[extractLivesGroups] Spider type=3 live:', grp.name,
                'spiderApi:', api.substring(0, 80),
                'jar:', (effectiveJar || '(none)'))
            } else if (effectiveJar) {
              grp.spiderApi = effectiveJar
              grp.spiderExt = grp.url
              grp.spiderJar = effectiveJar
              logger.log('[extractLivesGroups] Spider type=3 live (fallback):', grp.name,
                'spiderApi:', effectiveJar.substring(0, 80))
            }
            groups.push(grp)
          }
          continue
        }
        groups.push(grp)
      }
    }

    if (obj.urls && Array.isArray(obj.urls) && obj.urls.length > 0) {
      for (let idx = 0; idx < obj.urls.length; idx++) {
        const entry = obj.urls[idx]
        groups.push(typeof entry === 'string' ? buildSourceGroup({ url: entry }, idx) : buildSourceGroup(entry, idx))
      }
    }

    if (obj.rules && Array.isArray(obj.rules) && obj.rules.length > 0) {
      for (let idx = 0; idx < obj.rules.length; idx++) {
        const rule = obj.rules[idx]
        groups.push(typeof rule === 'string' ? buildSourceGroup({ name: '规则' + (idx + 1), url: rule, type: '0' }, idx) : buildSourceGroup(rule, idx))
      }
      logger.log('[extractLivesGroups] Rules sources:', obj.rules.length)
    }

    if (obj.parses && Array.isArray(obj.parses) && obj.parses.length > 0) {
      for (let idx = 0; idx < obj.parses.length; idx++) {
        const parse = obj.parses[idx]
        groups.push(typeof parse === 'string' ? buildSourceGroup({ name: '解析' + (idx + 1), url: parse, type: '0' }, idx) : buildSourceGroup(parse, idx))
      }
      logger.log('[extractLivesGroups] Parses sources:', obj.parses.length)
    }

    if (defaultSpiderJar && /^https?:\/\//i.test(defaultSpiderJar)) {
      const isSpiderCode = /\.(jar|js|ts)(\b|[?#])/i.test(defaultSpiderJar)
      if (isSpiderCode) {
        logger.log('[extractLivesGroups] Spider URL is a code file, not adding as live source:', defaultSpiderJar)
      } else {
        logger.log('[extractLivesGroups] Adding spider as live source:', defaultSpiderJar)
        groups.push(buildSourceGroup({ name: '爬虫源', url: defaultSpiderJar, type: '0' }, 0))
      }
    }

    if (obj.sites && Array.isArray(obj.sites) && obj.sites.length > 0) {
      let addedVod = 0
      let skipped = 0
      for (let idx = 0; idx < obj.sites.length; idx++) {
        const site = obj.sites[idx]
        const siteType = safeStr(site.type, '1')
        if (siteType === '3') {
          const spiderApi = stripBackticks(safeStr(site.api, ''))
          const ext = site.ext
          const extName = safeStr(site.name, 'ext' + (idx + 1))
          const jar = stripBackticks(safeStr(site.jar, ''))
          const effectiveJar = jar || defaultSpiderJar

          const extUrls: string[] = []
          if (ext && typeof ext === 'object' && !Array.isArray(ext)) {
            for (const v of Object.values(ext)) {
              if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
                extUrls.push(stripBackticks(v))
              }
            }
          } else if (typeof ext === 'string' && /^https?:\/\//i.test(ext)) {
            extUrls.push(stripBackticks(ext))
          }

          if (extUrls.length > 0) {
            for (let ei = 0; ei < extUrls.length; ei++) {
              const extUrl = extUrls[ei]
              const subName = extUrls.length > 1 ? `${extName}_${ei + 1}` : extName
              logger.log('[extractLivesGroups] Type-3 site ext URL added:', subName, extUrl, 'jar:', effectiveJar || '(none)')
              const grp = buildSourceGroup({ name: subName, url: extUrl, type: '0' }, idx)
              if (spiderApi && /^https?:\/\//i.test(spiderApi)) {
                grp.spiderApi = spiderApi
                grp.spiderExt = extUrl
                grp.spiderJar = effectiveJar
              }
              groups.push(grp)
            }
          } else if (spiderApi && /^https?:\/\//i.test(spiderApi)) {
            const grp = buildSourceGroup({ name: extName, url: spiderApi, type: '0' }, idx)
            grp.spiderApi = spiderApi
            grp.spiderExt = ''
            grp.spiderJar = effectiveJar
            groups.push(grp)
            logger.log('[extractLivesGroups] Type-3 spider API added:', extName, spiderApi.substring(0, 80), 'jar:', effectiveJar || '(none)')
          }
          skipped++
          continue
        }
        const name = safeStr(site.name, '点播' + (idx + 1))
        const api = stripBackticks(safeStr(site.api, site.url || ''))
        if (!api || api.length < 3) {
          skipped++
          continue
        }
        const ua = safeStr(site.ua, '')
        const header: Record<string, string> = {}
        if (site.header && typeof site.header === 'object') {
          for (const [k, v] of Object.entries(site.header)) header[k] = String(v)
        } else if (ua) {
          header['User-Agent'] = ua
        }
        groups.push({ name, type: siteType === '0' ? '0' : '1', url: api, ua, header, playerType: 2 })
        addedVod++
      }
      logger.log('[extractLivesGroups] VOD sites: added', addedVod, 'skipped', skipped, '(type=3/js parser)')
    }

    return groups
  } catch {
    return []
  }
}

function extractNetworkingConfig(jsonStr: string): { hosts?: string[]; proxy?: { host: string; port: number; username?: string; password?: string } } | null {
  try {
    const obj = JSON.parse(stripJsonComments(jsonStr.trim()))
    const config: { hosts?: string[]; proxy?: { host: string; port: number; username?: string; password?: string } } = {}
    if (obj.hosts && Array.isArray(obj.hosts) && obj.hosts.length > 0) {
      config.hosts = obj.hosts.filter((h: any) => typeof h === 'string')
    }
    if (obj.proxy && typeof obj.proxy === 'object') {
      const proxyObj = Array.isArray(obj.proxy) ? obj.proxy[0] : obj.proxy
      if (proxyObj && typeof proxyObj.host === 'string') {
        config.proxy = {
          host: proxyObj.host,
          port: proxyObj.port || 1080,
          username: proxyObj.username || undefined,
          password: proxyObj.password || undefined,
        }
      }
    }
    return Object.keys(config).length > 0 ? config : null
  } catch { return null }
}

// ============ FETCH DATA (Node native via Electron IPC, no Chromium network stack) ============

async function fetchData(url: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
  if (!headers['User-Agent'] && !headers['user-agent']) {
    headers = { ...headers, 'User-Agent': 'okhttp/3.15.0' }
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (url.startsWith('data:')) {
    const [, payload] = url.split(',', 2)
    if (url.includes(';base64,')) {
      try {
        const binary = atob(payload)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        return new TextDecoder().decode(bytes)
      } catch {
        throw new Error('Invalid base64 data URI')
      }
    }
    return decodeURIComponent(payload)
  }

  if (window.electronAPI?.fetchUrl) {
    let result: string
    if (signal) {
      result = await new Promise<string>((resolve, reject) => {
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
        window.electronAPI!.fetchUrl(url, headers).then(
          r => { signal.removeEventListener('abort', onAbort); resolve(r) },
          e => { signal.removeEventListener('abort', onAbort); reject(e) }
        )
      })
    } else {
      result = await window.electronAPI.fetchUrl(url, headers)
    }
    // Guard against oversized responses
    if (typeof result === 'string' && result.length > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large: ${(result.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`)
    }
    if (typeof result === 'string') return result
    if (result && typeof result === 'object') return JSON.stringify(result)
    return String(result)
  }

  // Browser-native fetch fallback (no Electron IPC available)
  // 使用 detectAndDecode 统一编码检测，与主路径保持一致
  const resp = await fetch(url, {
    method: 'GET',
    headers: headers,
    signal: signal,
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
  }
  const buf = await resp.arrayBuffer()
  if (buf.byteLength > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`)
  }
  const rawBytes = new Uint8Array(buf)

  // Binary-level BMP stego scan on raw bytes (from test_dongli.py)
  const stegoFromBytes = await extractBmpStegoFromBytes(rawBytes)
  if (stegoFromBytes) {
    logger.log('[fetchData] BMP stego extracted from raw bytes, length:', stegoFromBytes.length)
    return stegoFromBytes
  }

  // Check if response is an image (will be detected as binary later)
  if (isImageContent(rawBytes)) {
    logger.log('[fetchData] Response appears to be an image file, trying text decode anyway...')
  }

  return detectAndDecode(buf)
}

async function fetchDataWithRetry(url: string, headers: Record<string, string> = {}, maxRetries: number = 1, signal?: AbortSignal): Promise<string> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
      if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); ctrl.abort() }, { once: true })
      try {
        return await fetchData(url, headers, ctrl.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (e: unknown) {
      lastError = e
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (attempt < maxRetries) {
        const delay = (attempt + 1) * 500
        logger.log('[ChannelService] Fetch failed (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + '), retrying in ' + delay + 'ms:', url)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay)
          if (signal) {
            const onAbort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
            signal.addEventListener('abort', onAbort, { once: true })
          }
        })
      }
    }
  }

  // GitHub mirror fallback (from test_dongli.py fetch_url_smart)
  // 策略：剥离代理前缀 → 直连原始GitHub URL → 失败后轮换镜像站
  if (/github/i.test(url)) {
    const { strippedUrl, wasProxied } = stripGhProxy(url)

    // Step 1: 如果原始URL带了代理前缀，剥离后先尝试直连
    if (wasProxied && strippedUrl !== url) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      logger.log('[ChannelService] Proxy stripped, trying direct:', strippedUrl.substring(0, 80))
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); ctrl.abort() }, { once: true })
        try {
          const result = await fetchData(strippedUrl, headers, ctrl.signal)
          logger.log('[ChannelService] Direct connection succeeded after proxy strip')
          return result
        } finally {
          clearTimeout(timer)
        }
      } catch {
        logger.log('[ChannelService] Direct connection failed, trying mirrors...')
      }
    }

    // Step 2: 直连失败 → 用去代理后的原始GitHub URL依次尝试镜像站
    for (const mirror of GITHUB_MIRRORS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const mirrorUrl = mirror + strippedUrl
      logger.log('[ChannelService] Trying GitHub mirror:', mirrorUrl.substring(0, 80))
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT / 2)
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); ctrl.abort() }, { once: true })
        try {
          const result = await fetchData(mirrorUrl, headers, ctrl.signal)
          logger.log('[ChannelService] GitHub mirror succeeded:', mirror)
          return result
        } finally {
          clearTimeout(timer)
        }
      } catch {
        logger.log('[ChannelService] GitHub mirror failed:', mirror)
      }
    }
  }

  throw lastError
}

// ============ CONTENT DETECTION & PARSING ============

function parseLiveData(text: string): LiveChannelGroup[] {
  const groups = parseToJsonArray(text)
  let channelNum = 0
  return groups.map((g: Record<string, unknown>) => {
    const rawChannels = (g.channels as unknown[]) || []
    const liveChannels = rawChannels
      .filter((raw: any) => !isAdChannelName(raw.name || raw.title || ''))
      .map((raw: any) => {
        const ch = createChannel(raw)
        ch.channelNum = ++channelNum
        return ch
      })
    return buildChannelGroup((g.group as string) || '直播', liveChannels)
  }).filter(g => g.liveChannels.length > 0)
}

function detectContentFormat(content: string): 'json' | 'json-array' | 'm3u' | 'txt' | 'html' | 'csv' | 'yaml' | 'jsonp' | 'url-list' | 'm3u-redirect' | 'unknown' {
  if (!content || content.length < 4) return 'unknown'
  const s = content.trim()

  if (s.startsWith('#EXTM3U')) return 'm3u'

  if (s.startsWith('{')) {
    try { JSON.parse(stripJsonComments(s)); return 'json' } catch (_) {}
  }
  if (s.startsWith('[')) {
    try { JSON.parse(stripJsonComments(s)); return 'json-array' } catch (_) {}
  }

  const hasNameUrlPair = /^[^\s,]+,[^\s]/.test(s.split('\n')[0].trim())
  if (hasNameUrlPair) return 'txt'

  const first500 = s.substring(0, 500).toLowerCase()
  const htmlMarkers = ['<!doctype', '<html', '<body', '<script', '<head', '<meta', '<div', '<!DOCTYPE']
  if (htmlMarkers.some(m => first500.includes(m))) return 'html'

  const jsMarkers = ['<script', 'type="text/javascript"', 'text/javascript']
  if (jsMarkers.some(m => first500.includes(m))) return 'html'

  try {
    const extracted = extractJsonFromHtml(s)
    if (extracted !== s && (extracted.startsWith('{') || extracted.startsWith('['))) {
      try { JSON.parse(stripJsonComments(extracted)); return 'json' } catch (_) {}
    }
  } catch (_) {}

  if (s.includes('"lives"') || s.includes('"sites"') || s.includes('"spider"') || s.includes('"urls"')) {
    return 'json'
  }

  if (/^https?:\/\//i.test(s.split('\n')[0].trim())) {
    const firstLine = s.split('\n')[0].trim()
    if (/\.(?:m3u8?)(?:\?|$)/i.test(firstLine)) return 'm3u-redirect'
    return 'txt'
  }

  return 'unknown'
}

function isHttpErrorResponse(content: string): boolean {
  if (!content || content.length < 10) return false
  const s = content.trim()
  if (/^(404|403|500|502|503)(\s|:|$)/.test(s)) return true
  const lower = s.substring(0, 200).toLowerCase()
  const errorMarkers = [
    '404 not found', '403 forbidden', '500 internal server error',
    '502 bad gateway', '503 service unavailable', '504 gateway timeout',
    'not found</title>', '<title>error',
  ]
  if (errorMarkers.some(m => lower.includes(m))) return true
  const htmlErrorMatch = lower.match(/<title>\s*(40[34]|50[0-3])\s/i)
  if (htmlErrorMatch) return true
  return false
}

// ============ VOD (Video-On-Demand) XML parsing (TVBox AppYs/CMS format) ============

interface VodVideoItem {
  id: string
  name: string
  note: string
  pic: string
}

function parseVodXmlHome(xml: string): VodVideoItem[] {
  const items: VodVideoItem[] = []
  const videoBlocks = xml.match(/<video>[\s\S]*?<\/video>/gi) || xml.match(/<item>[\s\S]*?<\/item>/gi) || []
  for (const block of videoBlocks) {
    const id = (block.match(/<id>[\s\S]*?<\/id>/i) || [''])[0].replace(/<\/?id>/gi, '').trim()
      .replace(/<!\[CDATA\[|\]\]>/g, '')
    const name = (block.match(/<name>[\s\S]*?<\/name>/i) || [''])[0]
      .replace(/<\/?name>/gi, '').trim()
      .replace(/<!\[CDATA\[|\]\]>/g, '')
    const note = (block.match(/<note>[\s\S]*?<\/note>/i) || [''])[0]
      .replace(/<\/?note>/gi, '').trim()
      .replace(/<!\[CDATA\[|\]\]>/g, '')
    const pic = (block.match(/<pic>[\s\S]*?<\/pic>/i) || [''])[0]
      .replace(/<\/?pic>/gi, '').trim()
      .replace(/<!\[CDATA\[|\]\]>/g, '')
    if (id && name) {
      items.push({ id, name, note: note || '', pic: pic || '' })
    }
  }
  return items
}

function parseVodJsonHome(json: any): VodVideoItem[] {
  const items: VodVideoItem[] = []
  let list: any[] = []
  if (json && json.list && Array.isArray(json.list)) {
    list = json.list
  } else if (json && json.data && Array.isArray(json.data)) {
    list = json.data
  } else if (Array.isArray(json)) {
    list = json
  }
  for (const item of list) {
    const id = item.vod_id || item.id || item.ids || ''
    const name = item.vod_name || item.name || item.title || ''
    const note = item.vod_remarks || item.remarks || item.note || ''
    const pic = item.vod_pic || item.pic || item.img || item.cover || ''
    if (id && name) {
      items.push({ id: String(id), name: String(name), note: String(note), pic: String(pic) })
    }
  }
  return items
}

function parseVodXmlDetail(xml: string): string[] {
  const urls: string[] = []

  const dlBlock = (xml.match(/<dl>[\s\S]*?<\/dl>/i) || [''])[0]
  if (dlBlock) {
    const ddMatches = dlBlock.match(/<dd[^>]*>[\s\S]*?<\/dd>/gi) || []
    for (const dd of ddMatches) {
      const flagMatch = dd.match(/flag="([^"]*)"/i) || dd.match(/flag='([^']*)'/i)
      const flagStr = flagMatch ? flagMatch[1].trim() : '源'
      let url = dd.replace(/<dd[^>]*>/gi, '').replace(/<\/dd>/gi, '').trim()
      url = url.replace(/<!\[CDATA\[|\]\]>/g, '')
      if (url && /^https?:\/\//i.test(url)) {
        urls.push(`${url}$${flagStr}`)
      }
    }
    return urls
  }

  // Apple CMS format: <list from="线路名"> <video><name>..</name><url>..</url></video> </list>
  const listBlocks = xml.match(/<list[\s>][\s\S]*?<\/list>/gi) || []
  if (listBlocks.length > 0) {
    for (const listBlock of listBlocks) {
      const fromMatch = listBlock.match(/from="([^"]*)"/i) || listBlock.match(/from='([^']*)'/i)
      const listFrom = fromMatch ? fromMatch[1].trim() : '源'
      const videoMatches = listBlock.match(/<video>[\s\S]*?<\/video>/gi) || listBlock.match(/<item>[\s\S]*?<\/item>/gi) || []
      for (const video of videoMatches) {
        const nameMatch = (video.match(/<name>[\s\S]*?<\/name>/i) || [''])[0]
        const episodeName = nameMatch.replace(/<\/?name>/gi, '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
        const urlMatch = (video.match(/<url>[\s\S]*?<\/url>/i) || [''])[0]
        let playUrl = urlMatch.replace(/<\/?url>/gi, '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
        if (playUrl && /^https?:\/\//i.test(playUrl)) {
          const flag = episodeName || listFrom
          urls.push(`${playUrl}$${flag}`)
        }
      }
    }
    return urls
  }

  // Apple CMS v2: <video><name>..</name><url>..</url></video> (no <list> wrapper)
  const videoMatches = xml.match(/<video>[\s\S]*?<\/video>/gi) || xml.match(/<item>[\s\S]*?<\/item>/gi) || []
  if (videoMatches.length > 0) {
    for (const video of videoMatches) {
      const nameMatch = (video.match(/<name>[\s\S]*?<\/name>/i) || [''])[0]
      const episodeName = nameMatch.replace(/<\/?name>/gi, '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
      const urlMatch = (video.match(/<url>[\s\S]*?<\/url>/i) || [''])[0]
      let playUrl = urlMatch.replace(/<\/?url>/gi, '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
      if (playUrl && /^https?:\/\//i.test(playUrl)) {
        const flag = episodeName || '源'
        urls.push(`${playUrl}$${flag}`)
      }
    }
  }

  return urls
}

function parseVodJsonDetail(json: any): string[] {
  const urls: string[] = []
  let sources: any[] = []

  // Handle structured play URL format: "name1$url1#name2$url2"
  function parseStructuredPlayUrl(playUrl: string, playFrom: string): void {
    if (!playUrl || typeof playUrl !== 'string') return
    const froms = playFrom ? playFrom.split('$$$').map(s => s.trim()).filter(Boolean) : ['源']
    const chunks = playUrl.split('#')
    for (const chunk of chunks) {
      const parts = chunk.split('$', 2)
      const url = parts.length > 1 ? parts[1] : parts[0]
      const name = parts.length > 1 ? parts[0] : ''
      if (url && /^https?:\/\//i.test(url.trim())) {
        const flag = name || froms[0] || '源'
        urls.push(`${url.trim()}$${flag}`)
      }
    }
  }

  // Handle Apple CMS JSON: list/data may be an object with vod_play_url/vod_play_from
  const listObj = (json && json.list) || (json && json.data)
  if (listObj && typeof listObj === 'object' && !Array.isArray(listObj)) {
    if (listObj.vod_play_url) {
      parseStructuredPlayUrl(listObj.vod_play_url, listObj.vod_play_from || listObj.vod_play_name || '')
      return urls
    }
    // Try extracting URLs from object fields directly
    const urlFields = ['vod_play_url', 'vod_url', 'url', 'play_url', 'link', 'src']
    for (const field of urlFields) {
      if (listObj[field] && typeof listObj[field] === 'string' && /^https?:\/\//i.test(listObj[field])) {
        const flag = listObj.name || listObj.title || listObj.vod_name || '源'
        urls.push(`${listObj[field]}$${flag}`)
      }
    }
    return urls
  }

  if (json && json.list && Array.isArray(json.list)) {
    sources = json.list
  } else if (json && json.data && Array.isArray(json.data)) {
    sources = json.data
  } else if (json && json.vod_urls && Array.isArray(json.vod_urls)) {
    sources = json.vod_urls
  }
  for (const item of sources) {
    if (typeof item === 'string' && /^https?:\/\//i.test(item)) {
      urls.push(`${item}$源`)
    } else if (item && typeof item === 'object') {
      const url = item.url || item.link || item.src || item.vod_url || item.vod_play_url || ''
      const flag = item.name || item.flag || item.title || '源'
      if (url && /^https?:\/\//i.test(url)) {
        urls.push(`${url}$${flag}`)
      }
    }
  }
  return urls
}

function buildVodApiUrl(apiUrl: string, action: string, params: Record<string, string> = {}): string {
  const separator = apiUrl.includes('?') ? '&' : '?'
  const queryParts = [`ac=${action}`]
  for (const [k, v] of Object.entries(params)) {
    queryParts.push(`${k}=${encodeURIComponent(v)}`)
  }
  return apiUrl + separator + queryParts.join('&')
}

async function fetchVodSiteChannels(apiUrl: string, siteName: string, headers: Record<string, string>, signal?: AbortSignal): Promise<LiveChannelGroup | null> {
  const baseApi = apiUrl.replace(/\/*$/, '')
  logger.log('[VOD] Fetching home:', baseApi)

  let homeXml: string
  try {
    if (signal?.aborted) return null; homeXml = await fetchDataWithRetry(buildVodApiUrl(baseApi, 'home'), headers, 1, signal)
  } catch (e) {
    logger.log('[VOD] Home fetch failed for', siteName, e instanceof Error ? e.message : e)
    return null
  }

  let videos = parseVodXmlHome(homeXml)

  if (videos.length === 0) {
    try {
      const homeJson = JSON.parse(stripJsonComments(homeXml.trim()))
      videos = parseVodJsonHome(homeJson)
      if (videos.length > 0) {
        logger.log('[VOD] XML parse failed, JSON fallback found', videos.length, 'videos for', siteName)
      }
    } catch (_) {}
  }

  if (videos.length === 0) {
    logger.log('[VOD] No videos found for', siteName)
    return null
  }
  logger.log('[VOD] Got', videos.length, 'videos from', siteName)

  const CONCURRENCY = 3
  const channels: any[] = []
  let idx = 0

  let detailSuccessCount = 0
  let detailFailCount = 0
  let firstFailPreview = ''

  for (let i = 0; i < videos.length; i += CONCURRENCY) {
    if (signal?.aborted) return null
    const batch = videos.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (v) => {
        try {
          if (signal?.aborted) return null
          let detailData = await fetchData(buildVodApiUrl(baseApi, 'videolist', { ids: v.id }), headers, signal)

          let playUrls = parseVodXmlDetail(detailData)
          if (playUrls.length === 0) {
            try {
              const detailJson = JSON.parse(stripJsonComments(detailData.trim()))
              playUrls = parseVodJsonDetail(detailJson)
            } catch (_) {}
          }
          if (playUrls.length === 0) {
            if (!firstFailPreview) {
              firstFailPreview = detailData.substring(0, 300).replace(/[\r\n]/g, ' ')
            }
            return null
          }

          const label = v.note ? `${v.name} [${v.note}]` : v.name
          return {
            name: label,
            urls: playUrls,
            logo: v.pic || '',
          }
        } catch {
          return null
        }
      })
    )

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        const ch = createChannel(r.value)
        ch.channelNum = ++idx
        channels.push(ch)
        detailSuccessCount++
      } else {
        detailFailCount++
      }
    }
  }

  if (channels.length === 0) {
    logger.log('[VOD] Detail parse failed for all', videos.length, 'videos from', siteName)
    if (firstFailPreview) {
      logger.log('[VOD] First fail preview:', firstFailPreview)
    }
    return null
  }
  logger.log('[VOD] Detail result:', detailSuccessCount, 'success,', detailFailCount, 'failed for', siteName)
  return buildChannelGroup(siteName, channels)
}

// ============ Spider VOD (homeContent) JSON parsing ============

interface SpiderVodItem {
  vod_id: string
  vod_name: string
  vod_pic: string
  vod_remarks: string
  vod_tag?: string
  type_name?: string
}

function parseSpiderVodHome(spiderKey: string, homeData: string): LiveChannelGroup[] {
  if (!homeData || homeData.length < 10) return []

  let json: any
  try {
    json = JSON.parse(stripJsonComments(homeData.trim()))
  } catch {
    logger.log('[SpiderVOD] Failed to parse home JSON for:', spiderKey)
    return []
  }

  if (!json || typeof json !== 'object') return []

  const list: SpiderVodItem[] = json.list || []

  if (list.length === 0) {
    logger.log('[SpiderVOD] No VOD list in home response for:', spiderKey)
    return []
  }

  logger.log('[SpiderVOD] Parsing', list.length, 'VOD items from', spiderKey)

  const groupsMap: Map<string, LiveChannelItem[]> = new Map()
  let channelNum = 0

  for (const item of list) {
    const vodId = item.vod_id || ''
    const vodName = item.vod_name || ''
    const vodPic = item.vod_pic || ''
    const vodRemarks = item.vod_remarks || ''
    const vodTag = item.vod_tag || ''
    const typeName = item.type_name || ''

    if (!vodId || !vodName) continue

    // 广告过滤
    if (isAdChannelName(vodName)) continue

    let label = vodRemarks ? `${vodName} [${vodRemarks}]` : vodName
    if (vodTag) label = `[${vodTag}] ${label}`

    const groupName = typeName || '点播'

    let channels = groupsMap.get(groupName)
    if (!channels) {
      channels = []
      groupsMap.set(groupName, channels)
    }

    const ch = createChannel({
      name: label,
      urls: [`spider://vod/${encodeURIComponent(spiderKey)}/${encodeURIComponent(vodId)}`],
      logo: vodPic,
      header: {},
      parse: 0,
    })
    ch.channelNum = ++channelNum
    channels.push(ch)
  }

  return Array.from(groupsMap.entries()).map(([name, channels]) =>
    buildChannelGroup(name, channels))
}

const FLUSH_THROTTLE_MS = 500
const RATE_LIMIT_MS = 200
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024

function hasChannelCacheAPI(): boolean {
  return isElectron()
    && typeof window.electronAPI!.getChannelCacheEntry === 'function'
    && typeof window.electronAPI!.setChannelCacheEntry === 'function'
}

export async function readCacheEntry(url: string): Promise<CacheStorageEntry | null> {
  if (!hasChannelCacheAPI()) return null
  try {
    const entry = await window.electronAPI!.getChannelCacheEntry(url) as CacheStorageEntry | null
    if (!entry) return null
    return entry
  } catch { return null }
}

export async function writeCacheEntry(url: string, entry: CacheStorageEntry): Promise<void> {
  if (!hasChannelCacheAPI()) return
  try { await window.electronAPI!.setChannelCacheEntry(url, entry) } catch (_) {}
}

async function deleteCacheEntry(url: string): Promise<void> {
  if (!hasChannelCacheAPI()) return
  try { await window.electronAPI!.deleteChannelCacheEntry(url) } catch (_) {}
}


// ============ GROUP MERGE UTILITY ============

function makeGroupKey(subLineName: string, groupName: string): string {
  return JSON.stringify([subLineName, groupName])
}

function mergeChannelGroups(oldGroups: LiveChannelGroup[], newGroups: LiveChannelGroup[]): LiveChannelGroup[] {
  if (oldGroups.length === 0) return newGroups
  if (newGroups.length === 0) return oldGroups

  const resultMap = new Map<string, LiveChannelGroup>()

  for (const g of oldGroups) {
    const key = makeGroupKey(g.subLineName, g.groupName)
    resultMap.set(key, g)
  }

  let overwrittenCount = 0
  let appendedCount = 0

  for (const g of newGroups) {
    const key = makeGroupKey(g.subLineName, g.groupName)
    if (resultMap.has(key)) {
      overwrittenCount++
    } else {
      appendedCount++
    }
    resultMap.set(key, g)
  }

  const preservedCount = oldGroups.length - overwrittenCount
  logger.log('[mergeChannelGroups] Merged:', overwrittenCount, 'overwritten,', appendedCount, 'appended,', preservedCount, 'preserved (total:', resultMap.size, 'groups)')

  return Array.from(resultMap.values())
}

// ============ MAIN CHANNEL SERVICE ============

function filterBySourceIndex(groups: LiveChannelGroup[], sourceIndex: number, configLives?: LiveSourceGroup[] | null): LiveChannelGroup[] {
  if (sourceIndex <= 0) return groups
  if (!configLives || configLives.length <= sourceIndex) return groups
  const targetName = configLives[sourceIndex]?.name
  if (!targetName) return groups
  return groups.filter(g => g.subLineName === targetName)
}

export const ChannelService = {
  async loadChannels(sourceUrl: string, sourceIndex: number = 0, livesGroupsRef?: Ref<LiveSourceGroup[]>, channelGroupsRef?: Ref<LiveChannelGroup[]>, signal?: AbortSignal, skipCache: boolean = false): Promise<LiveChannelGroup[]> {
    if (signal?.aborted) return []

    // Per-call seen URL tracking (avoids cross-call contamination)
    const seenUrls = new Map<string, boolean>()
    const MAX_SEEN_URLS = 200
    let seenUrlInsertOrder: string[] = []
    function addSeenUrl(url: string): void {
      if (seenUrls.has(url)) return
      seenUrls.set(url, true)
      seenUrlInsertOrder.push(url)
      while (seenUrlInsertOrder.length > MAX_SEEN_URLS) {
        const oldest = seenUrlInsertOrder.shift()
        if (oldest) seenUrls.delete(oldest)
      }
    }

    if (window.electronAPI?.fetchUrl) {
      const { setFetchUrlFunc, setFetchUrlFullFunc } = await import('./SpiderService')
      setFetchUrlFunc(
        (url: string, hdrs: Record<string, string>) => window.electronAPI!.fetchUrl(url, hdrs)
      )
      setFetchUrlFullFunc(
        (url: string, hdrs: Record<string, string>) => window.electronAPI!.fetchUrlSpider(url, hdrs)
      )
    }

    if (!skipCache) {
      const cached = await readCacheEntry(sourceUrl)
      if (cached && Array.isArray(cached.data) && cached.data.length > 0) {
        if (Array.isArray(cached.livesGroups) && cached.livesGroups.length > 0 && livesGroupsRef) {
          livesGroupsRef.value = cached.livesGroups
        }
        if (channelGroupsRef) {
          channelGroupsRef.value = filterBySourceIndex(cached.data, sourceIndex, cached.livesGroups)
        }
        logger.log('[ChannelService] Cache valid, loaded from cache:', cached.data.length, 'groups')
        return filterBySourceIndex(cached.data, sourceIndex, cached.livesGroups)
      }
      logger.log('[ChannelService] No valid cache found, will fetch from network')
    }

    logger.log('[ChannelService] Fetching config:', sourceUrl)

    let rawData: string
    try {
      rawData = await fetchDataWithRetry(sourceUrl, {}, 1, signal)
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return []
      const errMsg = e instanceof Error ? e.message : String(e)
      logger.error('[ChannelService] Config fetch failed for:', sourceUrl)
      logger.error('[ChannelService] Error:', errMsg)
      if (errMsg.includes('ENOTFOUND') || errMsg.includes('EAI_AGAIN') || errMsg.includes('getaddrinfo')) {
        logger.error('[ChannelService] → DNS resolution failed (domain may be unreachable or blocked)')
      } else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
        logger.error('[ChannelService] → Connection timed out (server may be down or blocked)')
      } else if (errMsg.includes('ECONNREFUSED')) {
        logger.error('[ChannelService] → Connection refused (server rejected the connection)')
      } else if (errMsg.includes('ECONNRESET')) {
        logger.error('[ChannelService] → Connection reset (server closed the connection)')
      } else if (errMsg.includes('certificate') || errMsg.includes('SSL') || errMsg.includes('TLS')) {
        logger.error('[ChannelService] → SSL/TLS error (certificate issue)')
      } else {
        logger.error('[ChannelService] → Network error:', errMsg)
      }
      return []
    }

    if (!rawData || rawData.length < 10 || isHttpErrorResponse(rawData)) {
      if (rawData && isHttpErrorResponse(rawData)) {
        logger.error('[ChannelService] HTTP error response from:', sourceUrl, 'preview:', rawData.substring(0, 80).replace(/[\r\n]/g, ' '))
      } else {
        logger.error('[ChannelService] Empty/short response from:', sourceUrl, '(length:', rawData?.length || 0, ')')
      }
      return []
    }

    logger.log('[ChannelService] Config data length:', rawData.length,
      'preview:', rawData.substring(0, 200).replace(/[\r\n]/g, ' '))

    let processedConfig = await FindResult(rawData)
    logger.log('[ChannelService] Processed config length:', processedConfig.length,
      'preview:', processedConfig.substring(0, 200).replace(/[\r\n]/g, ' '))

    const jsonData = extractJsonFromHtml(processedConfig)

    // No Electron IPC - skip networking config
    const netConfig = extractNetworkingConfig(jsonData)
    if (netConfig) {
      logger.log('[ChannelService] Networking config detected:', Object.keys(netConfig))
      if (window.electronAPI?.setNetworkingConfig) {
        window.electronAPI.setNetworkingConfig(netConfig as Record<string, unknown>).catch(() => {})
      }
    }

    let configLives = extractLivesGroups(jsonData)

    if (configLives.length === 0) {
      const prefixStripped = extractJsonFromHtml(processedConfig.replace(/^[^{[]+/, ''))
      configLives = extractLivesGroups(prefixStripped)
      if (configLives.length === 0) {
        configLives = extractLivesGroups(extractJsonFromHtml(rawData.replace(/^[^{[]+/, '')))
      }
    }

    if (channelGroupsRef) {
      channelGroupsRef.value = []
    }
    const allGroups: LiveChannelGroup[] = []

    const oldCached = skipCache ? await readCacheEntry(sourceUrl) : null
    const oldCachedGroups: LiveChannelGroup[] = (oldCached && Array.isArray(oldCached.data)) ? oldCached.data : []
    if (oldCachedGroups.length > 0) {
      logger.log('[ChannelService] Found old cached data:', oldCachedGroups.length, 'groups, will perform precise merge')
    }

    let lastMerged: LiveChannelGroup[] = []

    const getMergedResult = (): LiveChannelGroup[] => {
      if (oldCachedGroups.length === 0) return allGroups
      if (allGroups.length === 0) return oldCachedGroups
      return lastMerged.length > 0 ? lastMerged : mergeChannelGroups(oldCachedGroups, allGroups)
    }

    let completedCount = 0
    const flushSnapshot = async () => {
      if (allGroups.length === 0 && oldCachedGroups.length === 0) return
      const merged = mergeChannelGroups(oldCachedGroups, allGroups)
      lastMerged = merged
      const effectiveComplete = oldCachedGroups.length > 0 ? configLives.length : completedCount
      await writeCacheEntry(sourceUrl, {
        data: merged,
        livesGroups: configLives,
        time: Date.now(),
        completedCount: effectiveComplete
      })
      if (channelGroupsRef) channelGroupsRef.value = filterBySourceIndex(merged, sourceIndex, configLives)
    }
    const flushTimer = setInterval(flushSnapshot, FLUSH_THROTTLE_MS)

    let lastGroupAddTime = Date.now()
    let stallAborted = false
    const stallCheckTimer = configLives.length > 0 ? setInterval(() => {
      if (stallAborted) return
      if (Date.now() - lastGroupAddTime > STALL_TIMEOUT_MS) {
        logger.log('[ChannelService] No valid data received for ' + (STALL_TIMEOUT_MS / 1000) + 's, parsing complete')
        stallAborted = true
      }
    }, 1000) : null

    try {
    if (configLives.length === 0) {
      let format = detectContentFormat(processedConfig)
      logger.log('[ChannelService] No TVBox lives found, content format:', format)

      
      // Handle M3U redirect: response is just a URL to an actual M3U playlist
      if (format === 'm3u-redirect') {
        const redirectUrl = processedConfig.trim().split('\n')[0].trim()
        logger.log('[ChannelService] → M3U redirect detected, following:', redirectUrl.substring(0, 80))
        processedConfig = await fetchDataWithRetry(redirectUrl, {}, 1, signal)
        if (processedConfig && processedConfig.length > 50) {
          processedConfig = await FindResult(processedConfig)
          format = detectContentFormat(processedConfig)
          logger.log('[ChannelService] → After redirect, content format:', format)
        }
      }
const looksLikeBinary = format === 'unknown' &&
        (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(processedConfig.substring(0, 500)) ||
         !/[A-Za-z0-9]/.test(processedConfig.substring(0, 200)))
      if (looksLikeBinary) {
        logger.log('[ChannelService] Response appears to be binary/image, trying fallback TVBox paths...')
        const baseForFallback = sourceUrl.replace(/\$.*$/, '').replace(/\/+$/, '')
        for (const tvPath of ['/tv', '/api', '/wex.json', '/tvbox']) {
          if (signal?.aborted) break
          try {
            const fbUrl = baseForFallback + tvPath
            logger.log('[ChannelService] → Fallback try:', fbUrl)
            const fbData = await fetchDataWithRetry(fbUrl, {}, 1, signal)
            if (fbData && fbData.length > 50) {
              const fbProcessed = await FindResult(fbData)
              const fbJson = extractJsonFromHtml(fbProcessed)
              const fbLives = extractLivesGroups(fbJson)
              if (fbLives.length > 0) {
                configLives = fbLives
                logger.log('[ChannelService] → Fallback succeeded at', tvPath, ':', fbLives.length, 'sub-lines')
                break
              }
            }
          } catch (_) {
            logger.log('[ChannelService] → Fallback failed:', tvPath)
          }
        }
      }

      if (configLives.length === 0 && format === 'html') {
        logger.log('[ChannelService] Response is HTML, attempting to crawl for live source links...')
        logger.log('[ChannelService] → HTML preview:', processedConfig.substring(0, 300).replace(/[\r\n]/g, ' '))

        try {
          const crawlResults = crawlSourceUrlsFromHtml(processedConfig, sourceUrl)
          if (crawlResults.length > 0) {
            logger.log('[ChannelService] Crawled', crawlResults.length, 'potential source links from HTML:', crawlResults.map(r => r.url))
            for (const cr of crawlResults) {
              configLives.push({
                name: cr.title.substring(0, 80),
                type: '0',
                url: cr.url,
                ua: '',
                header: {},
                playerType: 2
              })
            }
            if (configLives.length > 0) {
              logger.log('[ChannelService] Using', configLives.length, 'crawled links as sub-lines')
            }
          } else {
            logger.log('[ChannelService] No crawlable links found in HTML, will attempt direct parse')
          }
        } catch (crawlErr: any) {
          logger.warn('[ChannelService] HTML crawl failed:', crawlErr?.message || crawlErr)
        }

        if (configLives.length === 0) {
          const result = parseLiveData(processedConfig)
          const totalCh = result.reduce((s, g) => s + g.liveChannels.length, 0)
          if (totalCh === 0) {
            logger.error('[ChannelService] HTML source unavailable, no channels found:', sourceUrl)
            return []
          }
          logger.log('[ChannelService] HTML parse success:', result.length, 'groups,', totalCh, 'channels')
          allGroups.push(...result)
          lastGroupAddTime = Date.now()
          await flushSnapshot()
          return getMergedResult()
        }
      }


      if (format === 'unknown') {
        logger.error('[ChannelService] Unknown content format for:', sourceUrl)
        logger.error('[ChannelService] → Raw preview (first 300 chars):', processedConfig.substring(0, 300))
        const hasJsonKeys = /"(sites|urls|lives|spider|flags|wallpaper|logo)"/i.test(processedConfig)
        if (hasJsonKeys) {
          logger.error('[ChannelService] → Contains TVBox JSON keys but JSON parse failed - may be malformed JSON or encrypted')
        }
        const hasBase64 = /^[A-Za-z0-9+/=\s]{50,}$/.test(processedConfig.replace(/[\r\n]/g, ''))
        if (hasBase64) {
          logger.error('[ChannelService] → Looks like pure Base64 but decode failed')
        }
      }

      if (format !== 'html') {
        const result = parseLiveData(processedConfig)
        const totalCh = result.reduce((s, g) => s + g.liveChannels.length, 0)
        if (totalCh === 0) {
          logger.error('[ChannelService] Direct parse yielded no channels for format:', format)
          logger.error('[ChannelService] → Content preview:', processedConfig.substring(0, 300))
          return []
        }
        logger.log('[ChannelService] Direct parse success:', result.length, 'groups,', totalCh, 'channels (format:', format, ')')
        allGroups.push(...result)
        lastGroupAddTime = Date.now()
        await flushSnapshot()
        return getMergedResult()
      }
    }

    if (livesGroupsRef) {
      livesGroupsRef.value = configLives
    }

    logger.log('[ChannelService] Found', configLives.length, 'source groups:',
      configLives.map(g => g.name))

    logger.log('[ChannelService] Loop start at index: 0')

    const THREAD_COUNT = getOptimalThreadCount()
    const useParallel = configLives.length > 1 && THREAD_COUNT > 1
    const singleSourceMode = configLives.length === 1 && THREAD_COUNT > 1

    const processSubLine = async (li: number): Promise<void> => {
      if (signal?.aborted || stallAborted) return

      const selected = configLives[li]

      if (selected.type !== '0' && selected.type !== '1' && selected.type !== '3') {
        logger.log('[ChannelService] Source type', selected.type, 'not supported for:', selected.name)
        return
      }

      const subLineName = selected.name || ('线路' + (li + 1))

      // --- VOD (Video-On-Demand) site handling ---
      if (selected.type === '1') {
        const vodApiUrl = resolveRelativeUrl(sourceUrl, selected.url)
        if (!/^https?:\/\//i.test(vodApiUrl)) {
          logger.log('[ChannelService] Skipping VOD with non-HTTP URL:', vodApiUrl)
          return
        }
        if (seenUrls.has(vodApiUrl) && seenUrls.get(vodApiUrl)) {
          logger.log('[ChannelService] VOD URL already loaded, skipping:', vodApiUrl)
          return
        }
        addSeenUrl(vodApiUrl)

        try {
          logger.log('[ChannelService] Fetching VOD site:', selected.name, vodApiUrl)
          const headers: Record<string, string> = { ...selected.header }
          const vodGroup = await fetchVodSiteChannels(vodApiUrl, selected.name, headers, signal)
          if (vodGroup && vodGroup.liveChannels.length > 0) {
            vodGroup.subLineName = subLineName
            logger.log('[ChannelService] VOD site loaded:', selected.name, vodGroup.liveChannels.length, 'items')
            allGroups.push(vodGroup)
            lastGroupAddTime = Date.now()
          } else {
            logger.log('[ChannelService] VOD site returned no content:', selected.name)
          }
        } catch (e: unknown) {
          logger.log('[ChannelService] VOD fetch failed for', selected.name,
            e instanceof Error ? e.message : e)
        }
        if (stallAborted) {
          logger.log('[ChannelService] Stall detected after VOD, skipping:', selected.name)
          return
        }
        return
      }

      const liveUrl = resolveRelativeUrl(sourceUrl, selected.url)

      // Strip URL suffix (|User-Agent=xxx, |Referer=xxx, etc.) and extract headers
      const { cleanUrl, headers: suffixHeaders } = stripUrlSuffix(liveUrl)
      const finalLiveUrl = sanitizeUrl(cleanUrl)
      if (finalLiveUrl !== liveUrl) {
        logger.log('[ChannelService] URL cleaned:', liveUrl.substring(0, 80), '->', finalLiveUrl.substring(0, 80))
      }

      if (!/^https?:\/\//i.test(finalLiveUrl)) {
        logger.log('[ChannelService] Skipping live with non-HTTP URL:', finalLiveUrl)
        return
      }

      if (seenUrls.has(finalLiveUrl) && seenUrls.get(finalLiveUrl)) {
        logger.log('[ChannelService] URL already loaded, skipping duplicate:', finalLiveUrl)
        return
      }
      addSeenUrl(finalLiveUrl)

      const processSubEntry = async (url: string, name: string, headers: Record<string, string>): Promise<void> => {
        if (stallAborted) return
        if (!url || !/^https?:\/\//i.test(url)) return
        const resolved = resolveRelativeUrl(finalLiveUrl, url)
        if (seenUrls.has(resolved) && seenUrls.get(resolved)) return
        addSeenUrl(resolved)
        try {
          let nd = await fetchDataWithRetry(resolved, headers, 1, signal)
          nd = await FindResult(nd)
          const nf = detectContentFormat(nd)
          if (nf === 'html') {
            const ex = extractJsonFromHtml(nd)
            if (ex && ex !== nd && (ex.startsWith('{') || ex.startsWith('['))) {
              try { const t = JSON.parse(stripJsonComments(ex.trim())); if (t && typeof t === 'object') nd = ex } catch (_) {}
            }
          }
          const ng = parseLiveData(nd)
          for (const g of ng) g.subLineName = name || subLineName
          for (const g of ng) allGroups.push(g)
          if (ng.length > 0) lastGroupAddTime = Date.now()
          logger.log('[ChannelService] Sub-entry parsed:', name, '->', ng.length, 'groups')
        } catch (e2: unknown) {
          logger.log('[ChannelService] Sub-entry fetch failed:', name,
            e2 instanceof Error ? e2.message : e2)
        }
      }

      try {
        let liveData: string | null = null

        if (selected.spiderApi) {
          const spiderCodeUrl = selected.spiderJar || selected.spiderApi
          logger.log('[ChannelService] Trying spider for:', selected.name,
            'codeUrl:', spiderCodeUrl.substring(0, 80),
            'jar:', selected.spiderJar || '(none)')
          const { invokeSpiderLive, invokeSpiderHome } = await import('./SpiderService')
          const spiderKey = 'sp_' + (spiderCodeUrl + (selected.spiderExt || '')).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 64)

          const mergedSpiderHeaders = { ...suffixHeaders, ...selected.header }
          const [spiderResult, spiderHomeResult] = await Promise.allSettled([
            invokeSpiderLive(spiderKey, spiderCodeUrl, selected.spiderExt || '', finalLiveUrl, mergedSpiderHeaders),
            invokeSpiderHome(spiderKey, spiderCodeUrl, selected.spiderExt || '', false, mergedSpiderHeaders),
          ])

          if (spiderResult.status === 'fulfilled' && spiderResult.value) {
            liveData = spiderResult.value
            logger.log('[ChannelService] Spider live result length:', liveData.length)
          } else {
            logger.log('[ChannelService] Spider live returned no data for:', selected.name, 'falling back to direct fetch')
          }

          if (spiderHomeResult.status === 'fulfilled' && spiderHomeResult.value) {
            logger.log('[ChannelService] Spider home result length:', spiderHomeResult.value.length)
            try {
              const vodGroups = parseSpiderVodHome(spiderKey, spiderHomeResult.value)
              if (vodGroups.length > 0) {
                for (const vg of vodGroups) {
                  vg.subLineName = subLineName
                  allGroups.push(vg)
                }
                lastGroupAddTime = Date.now()
                logger.log('[ChannelService] Spider VOD:', vodGroups.length, 'groups,',
                  vodGroups.reduce((s, g) => s + g.liveChannels.length, 0), 'items')
              }
            } catch (e: unknown) {
              logger.log('[ChannelService] Spider VOD parse error for', selected.name,
                e instanceof Error ? e.message : e)
            }
          } else {
            logger.log('[ChannelService] Spider home returned no data for:', selected.name)
          }
        }

        if (!liveData) {
          logger.log('[ChannelService] Fetching live data:', finalLiveUrl)
          const headers: Record<string, string> = { ...suffixHeaders, ...selected.header }
          liveData = await fetchDataWithRetry(finalLiveUrl, headers, 1, signal)
        }

        liveData = await FindResult(liveData)

        if (isHttpErrorResponse(liveData)) {
          logger.log('[ChannelService] HTTP error response detected for', selected.name, 'skipping, preview:', liveData.substring(0, 80))
          return
        }

        const liveFormat = detectContentFormat(liveData)
        logger.log('[ChannelService] Live data format:', liveFormat, 'length:', liveData.length)

        if (liveFormat === 'html') {
          const extracted = extractJsonFromHtml(liveData)
          if (extracted && extracted !== liveData && (extracted.startsWith('{') || extracted.startsWith('['))) {
            try {
              const test = JSON.parse(stripJsonComments(extracted.trim()))
              if (test && typeof test === 'object') {
                logger.log('[ChannelService] Extracted JSON from HTML for', selected.name)
                liveData = extracted
              }
            } catch (_) {
              logger.log('[ChannelService] Live data returned HTML for', selected.name, 'trying next...')
              return
            }
          } else {
            logger.log('[ChannelService] Live data returned HTML for', selected.name, 'trying next...')
            return
          }
        }

        logger.log('[ChannelService] Live data length:', liveData.length,
          'first 150:', liveData.substring(0, 150).replace(/\s+/g, ' '))

        if (liveFormat === 'json-array' || (liveFormat === 'json' && liveData.trim().startsWith('['))) {
          try {
            const arr = JSON.parse(stripJsonComments(liveData.trim()))
            if (Array.isArray(arr) && arr.length > 0) {
              const hasNameUrl = arr.every((item: any) =>
                item && typeof item === 'object' && typeof item.name === 'string' && typeof item.url === 'string')
              if (hasNameUrl && !arr.some((item: any) => item.group || item.channels)) {
                logger.log('[ChannelService] Detected TVLive name/url array format with', arr.length, 'entries')
                if (singleSourceMode) {
                  const tvLiveTaskEntries: Array<{ url: string; name: string }> = []
                  for (const entry of arr) {
                    const entryName = safeStr(entry.name, '')
                    let entryUrl = stripBackticks(safeStr(entry.url, ''))
                    if (entryUrl.includes('&&&')) {
                      const parts = entryUrl.split('&&&')
                      entryUrl = parts[0].trim()
                      logger.log('[ChannelService] TVLive &&& split:', entryName, '->', entryUrl)
                    }
                    if (!entryUrl || !/^https?:\/\//i.test(entryUrl)) {
                      logger.log('[ChannelService] TVLive entry skipped (placeholder/invalid):', entryName)
                      continue
                    }
                    tvLiveTaskEntries.push({ url: entryUrl, name: entryName })
                  }
                  if (tvLiveTaskEntries.length > 0) {
                    logger.log('[ChannelService] TVLive parallel:', tvLiveTaskEntries.length, 'entries, threads=', THREAD_COUNT)
                    const tvLiveTasks = tvLiveTaskEntries.map(() => (idx: number) =>
                      processSubEntry(tvLiveTaskEntries[idx].url, tvLiveTaskEntries[idx].name, {}))
                    await runParallel(tvLiveTasks, THREAD_COUNT, signal, RATE_LIMIT_MS)
                  }
                } else {
                  for (const entry of arr) {
                    const entryName = safeStr(entry.name, '')
                    let entryUrl = stripBackticks(safeStr(entry.url, ''))
                    if (entryUrl.includes('&&&')) {
                      const parts = entryUrl.split('&&&')
                      entryUrl = parts[0].trim()
                      logger.log('[ChannelService] TVLive &&& split:', entryName, '->', entryUrl)
                    }
                    if (!entryUrl || !/^https?:\/\//i.test(entryUrl)) {
                      logger.log('[ChannelService] TVLive entry skipped (placeholder/invalid):', entryName)
                      continue
                    }
                    const resolvedEntryUrl = resolveRelativeUrl(finalLiveUrl, entryUrl)
                    if (seenUrls.has(resolvedEntryUrl) && seenUrls.get(resolvedEntryUrl)) {
                      logger.log('[ChannelService] TVLive entry URL already seen:', entryName)
                      continue
                    }
                    addSeenUrl(resolvedEntryUrl)
                    try {
                      let nd = await fetchDataWithRetry(resolvedEntryUrl, {}, 1, signal)
                      nd = await FindResult(nd)
                      const nf = detectContentFormat(nd)
                      if (nf === 'html') {
                        const ex = extractJsonFromHtml(nd)
                        if (ex && ex !== nd && (ex.startsWith('{') || ex.startsWith('['))) {
                          try { const t = JSON.parse(stripJsonComments(ex.trim())); if (t && typeof t === 'object') nd = ex } catch (_) {}
                        }
                      }
                      const ng = parseLiveData(nd)
                      for (const g of ng) { g.subLineName = entryName || subLineName; allGroups.push(g) }
                      if (ng.length > 0) lastGroupAddTime = Date.now()
                      logger.log('[ChannelService] TVLive entry parsed:', entryName, '->', ng.length, 'groups,',
                        ng.reduce((s, g) => s + g.liveChannels.length, 0), 'channels')
                    } catch (e2: unknown) {
                      logger.log('[ChannelService] TVLive entry fetch failed:', entryName,
                        e2 instanceof Error ? e2.message : e2)
                    }
                  }
                }
                return
              }
            }
          } catch (_) {
            logger.debug('[ChannelService] Nested config extraction failed for:', subLineName)
          }
        }

        let groups = parseLiveData(liveData)

        if (groups.length === 0 && liveFormat === 'json') {
          try {
            const liveJson = JSON.parse(stripJsonComments(liveData.trim()))
            const hasLives = liveJson.lives && Array.isArray(liveJson.lives) && liveJson.lives.length > 0
            const hasUrls = liveJson.urls && Array.isArray(liveJson.urls) && liveJson.urls.length > 0
            const hasSites = liveJson.sites && Array.isArray(liveJson.sites) && liveJson.sites.length > 0
            if (hasLives || hasUrls || hasSites) {
              const nestedLives = extractLivesGroups(liveData)
              if (singleSourceMode && nestedLives.length > 0) {
                const nestedTaskEntries: Array<{ url: string; name: string; headers: Record<string, string> }> = []
                for (const nestedLive of nestedLives) {
                  if (nestedLive.type !== '0' && nestedLive.type !== '1' && nestedLive.type !== '3') continue
                  nestedTaskEntries.push({ url: nestedLive.url, name: nestedLive.name || subLineName, headers: { ...nestedLive.header } })
                }
                if (nestedTaskEntries.length > 0) {
                  logger.log('[ChannelService] Nested lives parallel:', nestedTaskEntries.length, 'entries, threads=', THREAD_COUNT)
                  const nestedTasks = nestedTaskEntries.map(() => (idx: number) =>
                    processSubEntry(nestedTaskEntries[idx].url, nestedTaskEntries[idx].name, nestedTaskEntries[idx].headers))
                  await runParallel(nestedTasks, THREAD_COUNT, signal, RATE_LIMIT_MS)
                }
              } else {
                for (const nestedLive of nestedLives) {
                  if (nestedLive.type !== '0' && nestedLive.type !== '1' && nestedLive.type !== '3') continue
                  const nestedUrl = resolveRelativeUrl(finalLiveUrl, nestedLive.url)
                  if (seenUrls.has(nestedUrl) && seenUrls.get(nestedUrl)) continue
                  addSeenUrl(nestedUrl)
                  try {
                    const h = { ...nestedLive.header }
                    let nd = await fetchDataWithRetry(nestedUrl, h, 1, signal)
                    nd = await FindResult(nd)
                    const nf = detectContentFormat(nd)
                    if (nf === 'html') {
                      const ex = extractJsonFromHtml(nd)
                      if (ex && ex !== nd && (ex.startsWith('{') || ex.startsWith('['))) {
                        try { const t = JSON.parse(stripJsonComments(ex.trim())); if (t && typeof t === 'object') nd = ex } catch (_) {}
                      }
                    }
                    const ng = parseLiveData(nd)
                    for (const g of ng) g.subLineName = nestedLive.name || subLineName
                    for (const g of ng) allGroups.push(g)
                    if (ng.length > 0) lastGroupAddTime = Date.now()
                  } catch (_) {
                    logger.log('[ChannelService] Nested sub-line failed:', nestedLive.name)
                  }
                }
              }
            }
          } catch (_) {
            logger.log('[ChannelService] Not nested config, parsing as regular data')
          }
        }

        for (const g of groups) {
          g.subLineName = subLineName
        }
        const totalCh = groups.reduce((s, g) => s + g.liveChannels.length, 0)
        logger.log('[ChannelService] Parsed:', groups.length, 'groups,', totalCh, 'channels (sub-line:', subLineName, ')')

        for (const g of groups) allGroups.push(g)
        if (groups.length > 0) lastGroupAddTime = Date.now()
      } catch (e: unknown) {
        logger.log('[ChannelService] Live data fetch failed for', selected.name,
          e instanceof Error ? e.message : e, 'trying next...')
        if (stallAborted) {
          logger.log('[ChannelService] Stall detected, skipping retries for:', selected.name)
          return
        }
        // --- Per-sub-line retry ---
        let subRetryOk = false
        const SUBLINE_RETRIES = 2
        for (let sr = 0; sr < SUBLINE_RETRIES && !subRetryOk; sr++) {
          if (signal?.aborted) break
          if (sr > 0) {
            await new Promise<void>(r => {
              const t = setTimeout(r, 2000 * Math.pow(2, sr - 1))
              if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r() }, { once: true })
            })
            if (signal?.aborted) break
          }
          try {
            const hdrs: Record<string, string> = { ...suffixHeaders, ...selected.header }
            let rd = await fetchDataWithRetry(finalLiveUrl, hdrs, 1, signal)
            rd = await FindResult(rd)
            if (isHttpErrorResponse(rd)) break
            const rf = detectContentFormat(rd)
            if (rf === 'html') {
              const ex = extractJsonFromHtml(rd)
              if (ex && ex !== rd && (ex.startsWith('{') || ex.startsWith('['))) {
                try { const t = JSON.parse(stripJsonComments(ex.trim())); if (t && typeof t === 'object') rd = ex } catch (_) {}
              }
              if (detectContentFormat(rd) === 'html') break
            }
            let rg = parseLiveData(rd)
            if (rg.length === 0 && rf === 'json') {
              try {
                const rj = JSON.parse(stripJsonComments(rd.trim()))
                if (Array.isArray(rj.lives) || Array.isArray(rj.urls) || Array.isArray(rj.sites)) {
                  const retryNestedLives = extractLivesGroups(rd)
                  if (singleSourceMode && retryNestedLives.length > 0) {
                    const retryTaskEntries: Array<{ url: string; name: string; headers: Record<string, string> }> = []
                    for (const nl of retryNestedLives) {
                      if (nl.type !== '0' && nl.type !== '1' && nl.type !== '3') continue
                      const nu = resolveRelativeUrl(finalLiveUrl, nl.url)
                      if (seenUrls.has(nu)) continue
                      addSeenUrl(nu)
                      retryTaskEntries.push({ url: nu, name: nl.name || subLineName, headers: { ...nl.header } })
                    }
                    if (retryTaskEntries.length > 0) {
                      logger.log('[ChannelService] Retry nested lives parallel:', retryTaskEntries.length, 'entries, threads=', THREAD_COUNT)
                      const retryTasks = retryTaskEntries.map(() => (idx: number) =>
                        processSubEntry(retryTaskEntries[idx].url, retryTaskEntries[idx].name, retryTaskEntries[idx].headers))
                      await runParallel(retryTasks, THREAD_COUNT, signal, RATE_LIMIT_MS)
                    }
                  } else {
                    for (const nl of retryNestedLives) {
                      if (nl.type !== '0' && nl.type !== '1' && nl.type !== '3') continue
                      const nu = resolveRelativeUrl(finalLiveUrl, nl.url)
                      if (seenUrls.has(nu)) continue
                      addSeenUrl(nu)
                      try {
                        let nd = await fetchDataWithRetry(nu, { ...nl.header }, 1, signal)
                        nd = await FindResult(nd)
                        const nf2 = detectContentFormat(nd)
                        if (nf2 === 'html') {
                          const ex2 = extractJsonFromHtml(nd)
                          if (ex2 && ex2 !== nd && (ex2.startsWith('{') || ex2.startsWith('['))) {
                            try { const t2 = JSON.parse(stripJsonComments(ex2.trim())); if (t2 && typeof t2 === 'object') nd = ex2 } catch (_) {}
                          }
                        }
                        const ng2 = parseLiveData(nd)
                        for (const g2 of ng2) g2.subLineName = nl.name || subLineName
                        for (const g2 of ng2) allGroups.push(g2)
                        if (ng2.length > 0) lastGroupAddTime = Date.now()
                      } catch (_) {
                        logger.debug('[ChannelService] Retry nested sub-line failed:', nl.name)
                      }
                    }
                  }
                }
              } catch (_) {
              logger.debug('[ChannelService] Retry JSON parse failed for:', subLineName)
            }
            for (const g of rg) g.subLineName = subLineName
            if (rg.length > 0) {
              for (const g of rg) allGroups.push(g)
              lastGroupAddTime = Date.now()
              subRetryOk = true
              logger.log('[ChannelService] Sub-line retry OK:', subLineName, rg.length, 'groups')
            }
          }
          } catch (_) {
            logger.log('[ChannelService] Sub-line retry', sr + 1, 'fail:', subLineName)
          }
        }
        if (!subRetryOk) return
      }
    }

    if (useParallel) {
      logger.log('[ChannelService] Parallel mode (multi-source): threads=', THREAD_COUNT, 'sub-lines=', configLives.length)
      const tasks = configLives.map(() => (idx: number) => processSubLine(idx))
      await runParallel(tasks, THREAD_COUNT, signal)
    } else if (singleSourceMode) {
      logger.log('[ChannelService] Single-source parallel mode: threads=', THREAD_COUNT, 'processing sub-entries in parallel')
      for (let li = 0; li < configLives.length; li++) {
        if (stallAborted || signal?.aborted) break
        await processSubLine(li)
      }
    } else {
      logger.log('[ChannelService] Sequential mode: sub-lines=', configLives.length)
      for (let li = 0; li < configLives.length; li++) {
        if (stallAborted || signal?.aborted) break
        await processSubLine(li)
      }
    }

    if (stallAborted) {
      if (allGroups.length > 0) {
        completedCount = configLives.length
        logger.log('[ChannelService] Stall detected, saving partial:', allGroups.length, 'groups')
        await flushSnapshot()
        return getMergedResult()
      }
      logger.log('[ChannelService] Stall detected but no data, resetting')
      stallAborted = false
      lastGroupAddTime = Date.now()
    }

    if (allGroups.length === 0) {
      logger.error('[ChannelService] All live groups failed for:', sourceUrl)
      return []
    }

    const totalCh = allGroups.reduce((s, g) => s + g.liveChannels.length, 0)
    logger.log('[ChannelService] Total from all sub-lines:', allGroups.length, 'groups,', totalCh, 'channels')
    completedCount = configLives.length
    await flushSnapshot()
    return filterBySourceIndex(getMergedResult(), sourceIndex, configLives)
    } finally {
      clearInterval(flushTimer)
      if (stallCheckTimer) clearInterval(stallCheckTimer)
    }
  },

  async loadChannelsRobust(sourceUrl: string, options: {
    sourceIndex?: number
    livesGroupsRef?: Ref<LiveSourceGroup[]>
    channelGroupsRef?: Ref<LiveChannelGroup[]>
    signal?: AbortSignal
    skipCache?: boolean
    maxRetries?: number
    retryDelayMs?: number
    clearSeen?: boolean
  } = {}): Promise<LiveChannelGroup[]> {
    const {
      sourceIndex = 0,
      livesGroupsRef,
      channelGroupsRef,
      signal,
      skipCache = false,
      maxRetries = DEFAULT_MAX_RETRIES,
      retryDelayMs = DEFAULT_RETRY_DELAY_MS,
      clearSeen = true,
    } = options

    if (clearSeen) {
      this.clearSeenUrls()
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) return []
      if (attempt > 0 && clearSeen) {
        this.clearSeenUrls()
      }
      try {
        const result = await this.loadChannels(
          sourceUrl, sourceIndex, livesGroupsRef, channelGroupsRef, signal, skipCache
        )
        if (result.length > 0) return result
        if (signal?.aborted) return []
      } catch (e: unknown) {
        if (signal?.aborted) return []
        logger.log('[ChannelService] loadChannels attempt ' + (attempt + 1) + ' failed:',
          e instanceof Error ? e.message : e)
      }
      if (attempt < maxRetries && !signal?.aborted) {
        const delay = retryDelayMs * Math.pow(2, attempt)
        logger.log('[ChannelService] Retrying in ' + delay + 'ms (' + (attempt + 1) + '/' + maxRetries + '):', sourceUrl)
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, delay)
          if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
      }
    }
    logger.log('[ChannelService] All ' + (maxRetries + 1) + ' attempts exhausted for:', sourceUrl)
    return []
  },

  clearSeenUrls(): void {
    // No-op: seenUrls is now per-call local state in loadChannels()
  },

  async clearCache(url?: string): Promise<void> {
    if (url) {
      await deleteCacheEntry(url)
    } else {
      if (hasChannelCacheAPI()) {
        try { await window.electronAPI!.clearChannelCache() } catch (_) {}
      }
    }
  },
}