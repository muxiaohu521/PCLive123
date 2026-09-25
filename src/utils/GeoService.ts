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

function extractHost(url: string): string {
  try {
    const u = new URL(url)
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
  const result = new Map<string, GeoInfo>()
  const uniqueHosts = [...new Set(urls.map(extractHost).filter(Boolean))]

  const promises = uniqueHosts.map(async (host) => {
    const info = await getGeoInfo('http://' + host)
    if (info) result.set(host, info)
  })

  await Promise.allSettled(promises)
  return result
}