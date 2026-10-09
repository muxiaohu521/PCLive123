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

// URL quality scoring constants
const STREAM_EXTENSIONS = ['.m3u8', '.ts', '.flv', '.rtmp', '.rtsp', '.smil', '.mpd', '.m3u']
const AUDIO_EXTENSIONS = ['.mp3', '.aac', '.wav', '.flac', '.ogg', '.wma', '.m4a', '.opus']
const JUNK_EXTENSIONS = ['.ttf', '.woff', '.woff2', '.eot', '.svg', '.css', '.js', '.map', '.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.dmg', '.apk', '.ipa']
const BLOCKED_URL_KEYWORDS = ['baidu.com', 'pan.baidu.com', 't.cn', 'qr.alipay.com', 'weixin.qq.com', 'xingxingzaixian', 'aliyundrive']

export function hasIpv6Hint(
  url: string,
  srcName: string,
  channelName: string,
  groupName: string,
  subLineName: string,
): boolean {
  if (isIpv6Url(url, srcName)) return true
  const channelName6 = channelName || ''
  if (/(^|[^a-z])ipv6|ipv6([^a-z]|$)/i.test(channelName6)) return true
  if (/(^|[^a-z])v6([^a-z]|$)/i.test(channelName6)) return true
  const groupName6 = groupName || ''
  if (/(^|[^a-z])ipv6|ipv6([^a-z]|$)/i.test(groupName6)) return true
  if (/(^|[^a-z])v6([^a-z]|$)/i.test(groupName6)) return true
  const subLine6 = subLineName || ''
  if (/(^|[^a-z])ipv6|ipv6([^a-z]|$)/i.test(subLine6)) return true
  if (/(^|[^a-z])v6([^a-z]|$)/i.test(subLine6)) return true
  return false
}

export function scoreChannelUrl(url: string): number {
  if (!url) return -1
  const lower = url.toLowerCase()
  for (const kw of BLOCKED_URL_KEYWORDS) {
    if (lower.includes(kw)) return -1
  }
  for (const ext of JUNK_EXTENSIONS) {
    if (lower.endsWith(ext) || lower.includes(ext + '?')) return -1
  }
  for (const ext of STREAM_EXTENSIONS) {
    if (lower.includes(ext)) return 0
  }
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.includes(ext)) return 1
  }
  return 2
}

export function createChannel(raw: any): LiveChannelItem {
  const urls: string[] = []
  const srcNames: string[] = []
  const rawUrls = raw.urls || []
  let idx = 1
  for (const url of rawUrls) {
    const parts = url.split('$', 2)
    urls.push(parts[0])
    srcNames.push(parts.length > 1 ? parts[1] : '源' + (idx++))
  }
  const scored = urls.map((u, i) => ({ url: u, name: srcNames[i], score: scoreChannelUrl(u) }))
    .filter(item => item.score >= 0)
  scored.sort((a, b) => a.score - b.score)
  const filteredUrls = scored.map(item => item.url)
  const filteredNames = scored.map(item => item.name)
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
    channelUrls: filteredUrls,
    channelSourceNames: filteredNames,
    sourceIndex: 0,
    sourceNum: filteredUrls.length,
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

export interface CacheStorageEntry {
  data: LiveChannelGroup[]
  livesGroups: LiveSourceGroup[]
  time: number
  completedCount: number
}