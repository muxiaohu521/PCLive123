export interface GeoInfo {
  country: string
  countryCode: string
  region: string
  city: string
  isp: string
  lat: number
  lon: number
  query: string
}

const CACHE: Map<string, { data: GeoInfo; ts: number }> = new Map()
const CACHE_TTL = 30 * 60 * 1000

export function extractHost(input: string): string {
  if (!input || !input.trim()) return ''

  const trimmed = input.trim()

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname
    } catch {
      return ''
    }
  }

  const hostMatch = trimmed.match(/^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/)
  if (hostMatch) return trimmed

  const ipMatch = trimmed.match(/^(\d{1,3}\.){3}\d{1,3}$/)
  if (ipMatch) return trimmed

  try {
    const u = new URL('http://' + trimmed)
    return u.hostname
  } catch {
    return ''
  }
}

export async function getGeoInfo(url: string): Promise<GeoInfo | null> {
  const host = extractHost(url)
  if (!host) return null

  const cached = CACHE.get(host)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data

  try {
    const resp = await fetch(`http://ip-api.com/json/${host}?fields=country,countryCode,region,city,isp,lat,lon,query&lang=zh-CN`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) return null
    const data = await resp.json()
    if (data && data.query) {
      CACHE.set(host, { data, ts: Date.now() })
      return data
    }
    return null
  } catch {
    return null
  }
}

export async function getGeoInfoBatch(urls: string[]): Promise<Map<string, GeoInfo>> {
  const hostToGeo = new Map<string, GeoInfo>()
  const uniqueHosts = [...new Set(urls.map(extractHost).filter(Boolean))]

  const promises = uniqueHosts.map(async (host) => {
    const info = await getGeoInfo('http://' + host)
    if (info) hostToGeo.set(host, info)
  })

  await Promise.allSettled(promises)

  const result = new Map<string, GeoInfo>()
  for (const url of urls) {
    const host = extractHost(url)
    if (host && hostToGeo.has(host)) {
      result.set(url, hostToGeo.get(host)!)
    }
  }
  return result
}