export interface LiveChannelItem {
  channelName: string
  channelNum: number
  channelLogo: string
  channelUa: string
  channelClick: string
  channelFormat: string
  channelOrigin: string
  channelReferer: string
  channelTvgId: string
  channelTvgName: string
  channelHeader: Record<string, string>
  channelParse: number
  channelUrls: string[]
  channelSourceNames: string[]
  sourceIndex: number
  sourceNum: number
  includeBack: boolean
}

export interface LiveChannelGroup {
  groupName: string
  groupPassword: string
  subLineName: string
  liveChannels: LiveChannelItem[]
}

export interface LiveSourceGroup {
  name: string
  type: string
  url: string
  ua: string
  header: Record<string, string>
  playerType: number
  spiderApi?: string
  spiderExt?: string
  spiderJar?: string
}

function isIpv6Url(url: string, srcName: string): boolean {
  if (/:\/\/\[[0-9a-f:]+(\]|%|\/)/i.test(url)) return true
  if (/(^|[^a-z])ipv6|ipv6([^a-z]|$)/i.test(url)) return true
  if (/(^|[^a-z])ipv6|ipv6([^a-z]|$)/i.test(srcName)) return true
  if (/(^|[^a-z])v6([^a-z]|$)/i.test(srcName)) return true
  return false
}

function sortUrlsIpv6First(raw: any[]): any[] {
  const pairs = raw.map((u, i) => {
    const parts = (typeof u === 'string' ? u : '').split('$', 2)
    return { url: parts[0], name: parts.length > 1 ? parts[1] : '', origIndex: i, raw: u }
  })
  pairs.sort((a, b) => {
    const a6 = isIpv6Url(a.url, a.name) ? 1 : 0
    const b6 = isIpv6Url(b.url, b.name) ? 1 : 0
    return b6 - a6
  })
  return pairs.map(p => p.raw)
}

export function createChannel(raw: any): LiveChannelItem {
  const urls: string[] = []
  const srcNames: string[] = []
  const sortedRawUrls = sortUrlsIpv6First(raw.urls || [])
  let idx = 1
  for (const url of sortedRawUrls) {
    const parts = url.split('$', 2)
    urls.push(parts[0])
    srcNames.push(parts.length > 1 ? parts[1] : '源' + (idx++))
  }
  return {
    channelName: (raw.name || '').toString().trim(),
    channelNum: 0,
    channelLogo: raw.logo || '',
    channelUa: raw.ua || '',
    channelClick: raw.click || '',
    channelFormat: raw.format || '',
    channelOrigin: raw.origin || '',
    channelReferer: raw.referer || '',
    channelTvgId: raw['tvg-id'] || '',
    channelTvgName: raw['tvg-name'] || '',
    channelHeader: (typeof raw.header === 'object' && raw.header !== null) ? raw.header : {},
    channelParse: typeof raw.parse === 'number' ? raw.parse : 0,
    channelUrls: urls,
    channelSourceNames: srcNames,
    sourceIndex: 0,
    sourceNum: urls.length,
    includeBack: false
  }
}

export function buildChannelGroup(groupName: string, channels: LiveChannelItem[], subLineName: string = ''): LiveChannelGroup {
  const parts = groupName.split('_', 2)
  return {
    groupName: parts[0],
    groupPassword: parts.length > 1 ? parts[1] : '',
    subLineName,
    liveChannels: channels
  }
}

export function getChannelUrl(item: LiveChannelItem): string {
  return item.channelUrls[item.sourceIndex] || ''
}

export function nextSource(item: LiveChannelItem) {
  item.sourceIndex++
  if (item.sourceIndex >= item.sourceNum) item.sourceIndex = 0
}

export function preSource(item: LiveChannelItem) {
  item.sourceIndex--
  if (item.sourceIndex < 0) item.sourceIndex = item.sourceNum - 1
}

export function getChannelHeaders(item: LiveChannelItem): Record<string, string> {
  const h: Record<string, string> = { ...item.channelHeader }
  if (item.channelUa) h['User-Agent'] = item.channelUa
  if (item.channelOrigin) h['Origin'] = item.channelOrigin
  if (item.channelReferer) h['Referer'] = item.channelReferer
  return h
}