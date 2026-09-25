import { detectAndDecode } from '@/utils/TxtParser'

export interface CrawlResult {
  url: string
  title: string
  type: 'm3u' | 'txt' | 'page'
}

const M3U_LINK_PATTERN = /(?:href|src)=["']([^"']*(?:\.m3u8?|\.m3u|get_live_url|live_url|lives|tv|tvlist|live|iptv|channel|channels)[^"']*)["']/gi
const TEXT_LINK_PATTERN = /(?:href|src)=["']([^"']*(?:\.txt|list\.txt|tv\.txt|channel\.txt|iptv\.txt)[^"']*)["']/gi
const RAW_LINK_PATTERN = /(https?:\/\/[^\s"'<>]+(?:\.m3u8?|\.m3u|\.txt))/gi

export async function crawlSourceUrls(pageUrl: string): Promise<CrawlResult[]> {
  const results: CrawlResult[] = []
  const seen = new Set<string>()

  let html: string
  try {
    const resp = await fetch(pageUrl, { signal: AbortSignal.timeout(10000) })
    const buffer = await resp.arrayBuffer()
    html = detectAndDecode(buffer)
  } catch {
    return results
  }

  const baseUrl = (() => {
    try {
      const u = new URL(pageUrl)
      return u.origin
    } catch { return '' }
  })()

  function resolveUrl(url: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    if (url.startsWith('//')) return 'https:' + url
    if (url.startsWith('/')) return baseUrl + url
    return baseUrl + '/' + url
  }

  function addResult(url: string, type: 'm3u' | 'txt' | 'page', title?: string) {
    const resolved = resolveUrl(url)
    if (seen.has(resolved)) return
    seen.add(resolved)
    results.push({ url: resolved, title: title || resolved, type })
  }

  const m3uMatches = html.matchAll(M3U_LINK_PATTERN)
  for (const m of m3uMatches) {
    if (m[1]) addResult(m[1], 'm3u')
  }

  const txtMatches = html.matchAll(TEXT_LINK_PATTERN)
  for (const m of txtMatches) {
    if (m[1]) addResult(m[1], 'txt')
  }

  const rawMatches = html.matchAll(RAW_LINK_PATTERN)
  for (const m of rawMatches) {
    if (m[1]) addResult(m[1], m[1].includes('.m3u') ? 'm3u' : 'txt')
  }

  return results
}