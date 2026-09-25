/**
 * FormatDetector — 统一的媒体格式检测服务
 *
 * 职责：
 * - 根据 URL 扩展名判断媒体格式
 * - 通过 HEAD 请求探测最终 URL 的格式
 * - 识别重定向网关
 * - 判断不支持的协议
 *
 * 这是纯逻辑服务，不依赖 Vue/Store/ElectronAPI
 */

export const NATIVE_PLAYABLE_EXTS = new Set([
  'mp4', 'm4v', 'm4p', 'mov', 'qt',
  'webm', 'ogv', 'ogg', 'oga',
  'mkv',
  '3gp', '3g2', '3gpp',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'wma', 'ape', 'alac', 'aiff', 'aif',
  'amr', 'awb',
  'ac3', 'eac3',
  'dts', 'dtshd',
  'pcm', 'lpcm',
  'spx',
])

export const MPEGTS_FLV_EXTS = new Set([
  'flv', 'f4v', 'f4a', 'f4p',
])

export const MPEGTS_STREAM_EXTS = new Set([
  'ts', 'm2ts', 'mts', 'm2t', 'tsv',
])

export const HLS_EXTS = new Set([
  'm3u8', 'm3u',
])

export const AUDIO_EXTS = new Set([
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus',
  'wma', 'ape', 'alac', 'aiff', 'aif', 'ogg', 'oga',
  'amr', 'awb',
  'ac3', 'eac3', 'dts', 'dtshd',
  'pcm', 'lpcm', 'spx',
])

export interface ProbeResult {
  format: string
  finalUrl: string
}

export function getLocalExt(url: string): string {
  const clean = url.split('?')[0].split('#')[0]
  const filename = clean.split(/[\\/]/).pop() || clean
  return filename.split('.').pop()?.toLowerCase() || ''
}

export function isNativeExt(lowerPath: string): boolean {
  return /\.(mp4|m4v|m4p|mov|qt|webm|mkv|ogv|ogg|oga|3gp|3g2|3gpp|mp3|m4a|aac|wav|flac|opus|wma|ape|alac|aiff|aif|amr|awb|ac3|eac3|dts|dtshd|pcm|lpcm|spx)$/i.test(lowerPath)
}

export function isDirectFormat(lowerPath: string): boolean {
  return /\.(mp4|flv|ts|m2ts|mov|webm|mkv|mp3|m4a|aac|wav|flac|ogg|oga|opus)$/i.test(lowerPath)
}

export function isUnsupportedProtocol(url: string): string | null {
  if (url.startsWith('rtmp://')) return 'rtmp'
  if (url.startsWith('rtsp://')) return 'rtsp'
  return null
}

export function isRedirectGateway(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname
    const host = parsed.hostname
    const lastSegment = path.split('/').pop() || ''
    const hasExt = lastSegment.includes('.')

    if (path.startsWith('/tv/') && !hasExt) return true
    if (host === 'rihou.cc' && path.startsWith('/tv/')) return true

    if (/\.php\b/.test(path)) return true

    if (/^live\.(ottiptv|metshop|iill)\.cc$/.test(host) && /^\/(huya|douyu|douyin|yy|bilibili)\//.test(path)) return true
    if (/^(www\.)?goodiptv\.club$/.test(host) && /^\/(huya|douyu|yy|bilibili)\//.test(path)) return true

    if (host === 'live.264788.xyz' && path.startsWith('/channel/')) return true

    if (/8505255\.xyz$/.test(host) && !hasExt) return true

    if (/r\.jdshipin\.com$/.test(host)) return true

    if (/\/rtp\//.test(path) || /\/udp\//.test(path)) return true

    if (/\/vipsir\b/.test(path)) return true
    if (/\/info\b/.test(path) && parsed.search) return true
  } catch (_) {}
  return false
}

export function guessFormatFromGatewayPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    const path = decodeURIComponent(parsed.pathname)
    const host = parsed.hostname
    if (path.includes('[mg]')) return 'm3u8'
    if (path.includes('[Pd]')) return 'm3u8'
    if (/\/(huya|douyu|yy)\.php\b/i.test(path)) return 'flv'
    if (/^live\.(ottiptv|metshop|iill)\.cc$/.test(host) || /^(www\.)?goodiptv\.club$/.test(host)) {
      if (/\/(huya|douyu|douyin|yy)\//.test(path)) return 'flv'
    }
    if (/\.(ottiptv|metshop|iill)\.cc$/.test(host) && /\/(huya|douyu|douyin|yy)\//.test(path)) return 'flv'
    if (/8505255\.xyz$/.test(host)) return 'm3u8'
    if (host === 'live.264788.xyz') return 'm3u8'
    if (/\.iill\.top$/.test(host)) return 'm3u8'
    if (host === 'rihou.cc' && /\/tv\//.test(path)) {
      if (decodeURIComponent(path).includes('[mg]')) return 'm3u8'
    }
    if (/(188766|52tb|migu)\.xyz$/i.test(host)) return 'm3u8'
    if (/goodiptv\.club$/.test(host) && /\.php\b/i.test(path)) return 'm3u8'
    if (/cntv\.sbs$/.test(host)) return 'm3u8'
    if (/\blitenews\.cn$/.test(host)) return 'm3u8'
    if (/\/pltv\//i.test(path)) return 'm3u8'
    if (/^\/\d{6,}\//.test(path)) return 'm3u8'
    if (/\.php\b/i.test(path)) return 'm3u8'
  } catch (_) {}
  return null
}

export interface ProbeStreamFn {
  (url: string, headers: Record<string, string>): Promise<{ format: string; finalUrl: string } | null>
}

export async function probeFinalFormat(
  url: string,
  headers: Record<string, string>,
  probeStream?: ProbeStreamFn,
): Promise<ProbeResult> {
  if (probeStream) {
    try {
      const result = await probeStream(url, { ...headers })
      if (result && result.format && result.format !== 'unknown') {
        return { format: result.format, finalUrl: result.finalUrl || url }
      }
    } catch (_e) {
      // probeStream failed, continue with HEAD probe
    }
  }

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const safeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase()
      if (lower !== 'referer' && lower !== 'origin') {
        safeHeaders[k] = v
      }
    }
    const resp = await fetch(url, { method: 'HEAD', headers: safeHeaders, redirect: 'follow', signal: ctrl.signal })
    clearTimeout(timer)
    try { await resp.body?.cancel() } catch (_) {}
    const lower = resp.url.split('?')[0].split('#')[0].toLowerCase()
    if (isNativeExt(lower)) return { format: 'mp4', finalUrl: resp.url }
    if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return { format: 'm3u8', finalUrl: resp.url }
    if (lower.endsWith('.flv')) return { format: 'flv', finalUrl: resp.url }
    if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return { format: 'ts', finalUrl: resp.url }
    return { format: 'unknown', finalUrl: resp.url }
  } catch (_) {}

  const hint = guessFormatFromGatewayPath(url)
  return { format: hint || 'unknown', finalUrl: url }
}