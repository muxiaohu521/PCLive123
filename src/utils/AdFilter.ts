// ============ 广告过滤模块 ============
// 参考 TVBox M3u8.java / AdBlocker.java / VideoParseRuler.java 实现
import sharedRules from '@shared/ad-filter-rules.json'

// ---- 内置广告域名黑名单（来自共享规则文件 ad-filter-rules.json） ----
const DEFAULT_AD_HOSTS: string[] = sharedRules.DEFAULT_AD_HOSTS

// ---- 频道名称广告关键词（解析时按名称过滤） ----
const AD_CHANNEL_KEYWORDS = [
  '广告', '购物', '导购', '促销', '推广',
  '电视购物', '家庭购物', '环球购物', '优购物', '快乐购',
  '好易购', '家家购物', '风尚购物', '时尚购',
  '测试', '测试频道', 'test',
  '轮播广告', '贴片广告', '开机广告',
  '轮播', '导视',
]

// ---- 额外用户可配置的广告域名 ----
let extraAdHosts: string[] = []

// ---- 用户移除的内置域名（从默认列表排除） ----
let removedBuiltinHosts: string[] = []

// ---- 额外用户可配置的频道名关键词 ----
let extraAdKeywords: string[] = []

// ---- 用户移除的内置关键词（从默认列表排除） ----
let removedBuiltinKeywords: string[] = []

// ---- M3U8 标签常量（来自共享规则文件 ad-filter-rules.json） ----
const T = sharedRules.M3U8_TAGS
const TAG_DISCONTINUITY = T.TAG_DISCONTINUITY
const TAG_MEDIA_DURATION = T.TAG_MEDIA_DURATION
const TAG_ENDLIST = T.TAG_ENDLIST
const TAG_KEY = T.TAG_KEY
const TAG_MAP = T.TAG_MAP
const TAG_CUE_OUT = T.TAG_CUE_OUT
const TAG_CUE_IN = T.TAG_CUE_IN
const TAG_DATERANGE = T.TAG_DATERANGE

// ---- 广告片段 URL 特征正则（来自共享规则文件 ad-filter-rules.json） ----
const AD_SEGMENT_URI_REGEX = new RegExp(
  sharedRules.AD_SEGMENT_URI_REGEX_SOURCE,
  sharedRules.AD_SEGMENT_URI_REGEX_FLAGS
)

const MAX_FRAME_RATE_AD_BLOCK_SIZE = 12

// ============ 域名黑名单检测 ============

export function getAllAdHosts(): string[] {
  return [...DEFAULT_AD_HOSTS.filter(h => !removedBuiltinHosts.includes(h)), ...extraAdHosts]
}

export function isAdHost(url: string): boolean {
  const lower = url.toLowerCase()
  for (const host of getAllAdHosts()) {
    if (lower.includes(host)) return true
  }
  return false
}

export function addAdHosts(hosts: string[]): void {
  for (const h of hosts) {
    if (!h) continue
    if (removedBuiltinHosts.includes(h)) {
      restoreBuiltinHost(h)
      continue
    }
    if (!extraAdHosts.includes(h) && !DEFAULT_AD_HOSTS.includes(h)) {
      extraAdHosts.push(h)
    }
  }
}

export function removeAdHost(host: string): void {
  const idx = extraAdHosts.indexOf(host)
  if (idx !== -1) extraAdHosts.splice(idx, 1)
}

export function getExtraAdHosts(): string[] {
  return [...extraAdHosts]
}

export function clearExtraAdHosts(): void {
  extraAdHosts = []
}

export function removeBuiltinHost(host: string): void {
  if (DEFAULT_AD_HOSTS.includes(host) && !removedBuiltinHosts.includes(host)) {
    removedBuiltinHosts.push(host)
  }
}

export function restoreBuiltinHost(host: string): void {
  const idx = removedBuiltinHosts.indexOf(host)
  if (idx !== -1) removedBuiltinHosts.splice(idx, 1)
}

export function getRemovedBuiltinHosts(): string[] {
  return [...removedBuiltinHosts]
}

// ============ 频道名称过滤 ============

export function isAdChannelName(name: string): boolean {
  const lower = name.toLowerCase().trim()
  const effectiveBuiltin = AD_CHANNEL_KEYWORDS.filter(kw => !removedBuiltinKeywords.includes(kw))
  const allKeywords = [...effectiveBuiltin, ...extraAdKeywords]
  for (const kw of allKeywords) {
    if (lower.includes(kw.toLowerCase())) return true
  }
  if (/^\s*$/.test(name)) return true
  return false
}

export function getAdChannelKeywords(): string[] {
  return [...AD_CHANNEL_KEYWORDS.filter(kw => !removedBuiltinKeywords.includes(kw))]
}

export function getExtraAdKeywords(): string[] {
  return [...extraAdKeywords]
}

export function addAdKeywords(keywords: string[]): void {
  for (const kw of keywords) {
    const lower = kw.toLowerCase().trim()
    if (!lower) continue
    if (removedBuiltinKeywords.includes(lower)) {
      restoreBuiltinKeyword(lower)
      continue
    }
    if (!extraAdKeywords.includes(lower) && !AD_CHANNEL_KEYWORDS.includes(kw)) {
      extraAdKeywords.push(lower)
    }
  }
}

export function removeAdKeyword(keyword: string): void {
  const idx = extraAdKeywords.indexOf(keyword)
  if (idx !== -1) extraAdKeywords.splice(idx, 1)
}

export function clearExtraAdKeywords(): void {
  extraAdKeywords = []
}

export function removeBuiltinKeyword(keyword: string): void {
  if (AD_CHANNEL_KEYWORDS.includes(keyword) && !removedBuiltinKeywords.includes(keyword)) {
    removedBuiltinKeywords.push(keyword)
  }
}

export function restoreBuiltinKeyword(keyword: string): void {
  const idx = removedBuiltinKeywords.indexOf(keyword)
  if (idx !== -1) removedBuiltinKeywords.splice(idx, 1)
}

export function getRemovedBuiltinKeywords(): string[] {
  return [...removedBuiltinKeywords]
}

// ============ M3U8 播放列表净化 ============

function safeParseFloat(s: string): number {
  const v = parseFloat(s)
  return isNaN(v) ? -1 : v
}

function getExtInfDuration(line: string): number {
  const m = line.match(new RegExp(TAG_MEDIA_DURATION + ':([\\d.]+)'))
  return m ? safeParseFloat(m[1]) : -1
}

function isSegmentTag(line: string): boolean {
  const t = line.trim()
  if (t.startsWith(TAG_MEDIA_DURATION)) return true
  if (t.startsWith(TAG_KEY)) return true
  if (t.startsWith(TAG_MAP)) return true
  if (t.startsWith(TAG_DISCONTINUITY)) return true
  return false
}

function hasUriAttribute(line: string): boolean {
  return /URI=/.test(line)
}

function resolveUriLine(tsUrlPre: string, line: string): string {
  return line.replace(/URI="(.+?)"/g, (_m, uri) => {
    if (/^https?:\/\//i.test(uri)) return `URI="${uri}"`
    try {
      return `URI="${new URL(uri, tsUrlPre).href}"`
    } catch {
      return `URI="${uri}"`
    }
  })
}

function toAbsoluteUrl(tsUrlPre: string, segment: string): string {
  if (/^https?:\/\//i.test(segment)) return segment
  try {
    return new URL(segment, tsUrlPre).href
  } catch {
    return segment
  }
}

/**
 * 第一步：移除少数 URL 前缀的片段（广告通常来自不同的 CDN 路径）
 * 逻辑与 TVBox M3u8.java removeMinorityUrl() 一致
 */
function removeMinorityUrls(tsUrlPre: string, m3u8content: string): { result: string | null; adCount: number } {
  const linesplit = m3u8content.includes('\r\n') ? '\r\n' : '\n'
  const lines = m3u8content.split(linesplit)

  let totalSegments = 0
  for (const line of lines) {
    if (line.length > 0 && line.charAt(0) !== '#') totalSegments++
  }

  const preUrlMap = new Map<string, number>()
  for (const line of lines) {
    if (line.length === 0 || line.charAt(0) === '#') continue
    const absoluteUrl = toAbsoluteUrl(tsUrlPre, line)
    const ilast = absoluteUrl.lastIndexOf('.')
    if (ilast <= 4) continue
    const preUrl = absoluteUrl.substring(0, ilast - 4)
    preUrlMap.set(preUrl, (preUrlMap.get(preUrl) || 0) + 1)
  }

  if (preUrlMap.size <= 1) return { result: null, adCount: 0 }

  let domainFiltering = false
  let totalCount = 0
  let maxCount = 0
  for (const cnt of preUrlMap.values()) { totalCount += cnt; if (cnt > maxCount) maxCount = cnt }

  if (maxCount / totalCount < 0.8) {
    preUrlMap.clear()
    for (const line of lines) {
      if (line.length === 0 || line.charAt(0) === '#') continue
      const absoluteUrl = toAbsoluteUrl(tsUrlPre, line)
      if (!absoluteUrl.startsWith('http://') && !absoluteUrl.startsWith('https://')) {
        return { result: null, adCount: 0 }
      }
      const ifirst = absoluteUrl.indexOf('/', 9)
      if (ifirst <= 0) continue
      const preUrl = absoluteUrl.substring(0, ifirst)
      preUrlMap.set(preUrl, (preUrlMap.get(preUrl) || 0) + 1)
    }
    if (preUrlMap.size <= 1) return { result: null, adCount: 0 }

    totalCount = 0
    maxCount = 0
    for (const cnt of preUrlMap.values()) { totalCount += cnt; if (cnt > maxCount) maxCount = cnt }

    if (maxCount / totalCount < 0.8) return { result: null, adCount: 0 }

    let allDomainsExceedThreshold = true
    for (const count of preUrlMap.values()) {
      if (count <= 15) { allDomainsExceedThreshold = false; break }
    }
    if (allDomainsExceedThreshold) return { result: null, adCount: 0 }
    domainFiltering = true
  }

  let maxTimesPreUrl = ''
  let maxTimes = 0
  for (const [url, cnt] of preUrlMap.entries()) {
    if (cnt > maxTimes) { maxTimesPreUrl = url; maxTimes = cnt }
  }
  if (maxTimes === 0) return { result: null, adCount: 0 }

  const filtered: string[] = []
  let pendingSegmentTags: string[] = []
  let adCount = 0

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].trim()
    if (item.length === 0) {
      if (pendingSegmentTags.length === 0) filtered.push(lines[i])
      else pendingSegmentTags.push(lines[i])
      continue
    }
    if (item.charAt(0) === '#') {
      const output = hasUriAttribute(item) ? resolveUriLine(tsUrlPre, lines[i]) : lines[i]
      if (isSegmentTag(item)) pendingSegmentTags.push(output)
      else {
        for (const t of pendingSegmentTags) filtered.push(t)
        pendingSegmentTags = []
        filtered.push(output)
      }
      continue
    }

    const absoluteUrl = toAbsoluteUrl(tsUrlPre, lines[i])
    let shouldKeep = false
    if (domainFiltering) {
      const idx = absoluteUrl.indexOf('/', 9)
      const host = idx > 0 ? absoluteUrl.substring(0, idx) : absoluteUrl
      shouldKeep = host === maxTimesPreUrl
    } else {
      const ilast = absoluteUrl.lastIndexOf('.')
      const preUrl = ilast > 4 ? absoluteUrl.substring(0, ilast - 4) : ''
      shouldKeep = preUrl === maxTimesPreUrl
    }

    if (shouldKeep) {
      for (const t of pendingSegmentTags) filtered.push(t)
      pendingSegmentTags = []
      filtered.push(absoluteUrl)
    } else {
      pendingSegmentTags = []
      adCount++
    }
  }

  if (totalSegments > 0 && adCount > totalSegments * 0.3) {
    // 移除比例过高，可能误判，回退
    return { result: null, adCount: 0 }
  }

  return { result: filtered.join(linesplit), adCount }
}

/**
 * 第二步：用正则表达式移除广告片段
 */
function cleanByRegex(content: string, regexPatterns: string[]): string {
  let result = content
  for (const pattern of regexPatterns) {
    try {
      const re = new RegExp(pattern, 'gi')
      result = result.replace(re, '')
    } catch {
      // 忽略无效正则
    }
  }
  return result
}

/**
 * 移除常见的广告标记标签行
 * 对应 TVBox M3u8.java cleanCommonAdMarkers()
 */
function cleanCommonAdMarkers(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  const adTagPrefixes = [TAG_CUE_OUT, TAG_CUE_IN, TAG_DATERANGE]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let isAdTag = false
    for (const prefix of adTagPrefixes) {
      if (line.startsWith(prefix)) { isAdTag = true; break }
    }
    if (!isAdTag) result.push(lines[i])
  }
  return result.join('\n')
}

/**
 * 移除片段 URL 中包含广告特征的片段
 */
function removeAdSegmentUris(content: string, tsUrlPre: string): string {
  const linesplit = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(linesplit)
  const result: string[] = []
  let pendingTags: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].trim()
    if (item.length === 0) {
      result.push(lines[i])
      pendingTags = []
      continue
    }
    if (item.charAt(0) === '#') {
      if (isSegmentTag(item)) pendingTags.push(lines[i])
      else {
        for (const t of pendingTags) result.push(t)
        pendingTags = []
        result.push(lines[i])
      }
      continue
    }

    const absoluteUrl = toAbsoluteUrl(tsUrlPre, item)
    if (AD_SEGMENT_URI_REGEX.test(absoluteUrl)) {
      pendingTags = []
      continue
    }

    for (const t of pendingTags) result.push(t)
    pendingTags = []
    result.push(lines[i])
  }

  return normalizeMediaPlaylist(result.join(linesplit))
}

/**
 * 检查是否为有效的媒体播放列表
 */
function isPlayableMediaPlaylist(content: string): boolean {
  if (!content || content.length === 0) return false
  if (!content.startsWith('#EXTM3U')) return false
  const lines = content.split('\n')
  let segCount = 0
  for (const line of lines) {
    if (line.trim() && line.trim().charAt(0) !== '#') segCount++
  }
  return segCount >= 2
}

/**
 * 检查是否有结束标记（点播）
 */
function hasEndList(content: string): boolean {
  return content.includes(TAG_ENDLIST)
}

/**
 * 读取 EXTINF 小数位数
 */
function getDecimalPrecision(line: string): number {
  const start = line.indexOf(':')
  if (start < 0) return -1
  const remaining = line.substring(start + 1)
  const end = remaining.search(/[,\s]/)
  const val = end < 0 ? remaining : remaining.substring(0, end)
  const dot = val.indexOf('.')
  return dot < 0 ? 0 : val.length - dot - 1
}

/**
 * 构建 DISCONTINUITY 分组
 */
interface SegmentGroup {
  segmentCount: number
  lines: string[]
  hasDiscontinuity: boolean
}

function buildDiscontinuityGroups(lines: string[]): SegmentGroup[] {
  const groups: SegmentGroup[] = []
  let current: SegmentGroup = { segmentCount: 0, lines: [], hasDiscontinuity: false }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith(TAG_DISCONTINUITY)) {
      if (current.lines.length > 0) {
        groups.push(current)
        current = { segmentCount: 0, lines: [], hasDiscontinuity: true }
      }
      current.lines.push(line)
      continue
    }
    if (trimmed.length > 0 && trimmed.charAt(0) !== '#') {
      current.segmentCount++
    }
    current.lines.push(line)
  }
  if (current.lines.length > 0) groups.push(current)
  return groups
}

/**
 * 按小数精度差异移除广告分组
 */
function cleanDecimalPrecisionGroups(content: string): string {
  const linesplit = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(linesplit)
  const groups = buildDiscontinuityGroups(lines)
  if (groups.length < 2) return content

  const precisionCounts = new Map<number, number>()
  let totalSegments = 0
  for (const group of groups) {
    for (const raw of group.lines) {
      if (!raw.startsWith(TAG_MEDIA_DURATION)) continue
      const precision = getDecimalPrecision(raw)
      if (precision < 0) continue
      totalSegments++
      precisionCounts.set(precision, (precisionCounts.get(precision) || 0) + 1)
    }
  }
  if (totalSegments < 8 || precisionCounts.size < 2) return content

  let majorPrecision = -1
  let majorCount = 0
  for (const [prec, cnt] of precisionCounts.entries()) {
    if (cnt > majorCount) { majorPrecision = prec; majorCount = cnt }
  }
  if (majorPrecision < 0 || majorCount / totalSegments < 0.7) return content

  const removeGroups = new Array<boolean>(groups.length).fill(false)
  let removableSegments = 0
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (i === groups.length - 1 || group.segmentCount === 0 || group.segmentCount > MAX_FRAME_RATE_AD_BLOCK_SIZE) continue

    let allMismatched = true
    let hasAny = false
    for (const raw of group.lines) {
      if (!raw.startsWith(TAG_MEDIA_DURATION)) continue
      hasAny = true
      const precision = getDecimalPrecision(raw)
      if (precision >= 0 && precision === majorPrecision) { allMismatched = false; break }
    }
    if (hasAny && allMismatched) {
      removeGroups[i] = true
      removableSegments += group.segmentCount
    }
  }

  if (removableSegments === 0 || removableSegments > totalSegments * 0.3) return content

  const result: string[] = []
  for (let i = 0; i < groups.length; i++) {
    if (!removeGroups[i]) result.push(...groups[i].lines)
  }
  return normalizeMediaPlaylist(result.join(linesplit))
}

/**
 * 根据 EXTINF 时长帧率特征移除广告分组
 * 30fps → 时长通常是 X.033/X.066/X.100/X.133... 的倍数
 * 25fps → 时长通常是 X.040/X.080/X.120... 的倍数
 * 24fps → 时长通常是 X.041/X.083/X.125... 的倍数
 */
function isFrameAligned(duration: number, fps: number): boolean {
  const frameDuration = 1.0 / fps
  const ratio = duration / frameDuration
  return Math.abs(ratio - Math.round(ratio)) < 0.01
}

function cleanFrameRateGroups(content: string): string {
  const linesplit = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(linesplit)
  const groups = buildDiscontinuityGroups(lines)
  if (groups.length < 2) return content

  let count30 = 0
  let count25 = 0
  let count24 = 0
  for (const group of groups) {
    for (const raw of group.lines) {
      const dur = getExtInfDuration(raw)
      if (dur <= 0) continue
      if (isFrameAligned(dur, 30)) count30++
      else if (isFrameAligned(dur, 25)) count25++
      else if (isFrameAligned(dur, 24)) count24++
    }
  }
  const max = Math.max(count30, count25, count24)
  if (max < 2) return content
  const numMasters = (count30 === max ? 1 : 0) + (count25 === max ? 1 : 0) + (count24 === max ? 1 : 0)
  if (numMasters !== 1) return content
  const masterFps = count30 === max ? 30 : (count25 === max ? 25 : 24)

  const removeGroups = new Array<boolean>(groups.length).fill(false)
  let removableSegments = 0
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (i === groups.length - 1 || group.segmentCount === 0 || group.segmentCount > MAX_FRAME_RATE_AD_BLOCK_SIZE) continue

    let matched = 0
    let mismatched = 0
    for (const raw of group.lines) {
      const dur = getExtInfDuration(raw)
      if (dur <= 0) continue
      if (isFrameAligned(dur, masterFps)) matched++
      else mismatched++
    }
    if (mismatched > 0 && mismatched >= matched) {
      removeGroups[i] = true
      removableSegments += group.segmentCount
    }
  }

  const totalSegments = groups.reduce((s, g) => s + g.segmentCount, 0)
  if (removableSegments === 0 || removableSegments > totalSegments * 0.3) return content

  const result: string[] = []
  for (let i = 0; i < groups.length; i++) {
    if (!removeGroups[i]) result.push(...groups[i].lines)
  }
  return normalizeMediaPlaylist(result.join(linesplit))
}

/**
 * 清理过短的 DISCONTINUITY 分组（通常广告块很短）
 */
function cleanShortDiscontinuityGroups(content: string): string {
  const linesplit = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(linesplit)
  const groups = buildDiscontinuityGroups(lines)
  if (groups.length < 2) return content

  let totalSegments = 0
  for (const g of groups) totalSegments += g.segmentCount

  const removeGroups = new Array<boolean>(groups.length).fill(false)
  let removableSegments = 0
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    if (group.segmentCount > 0 && group.segmentCount <= 2 && i < groups.length - 1) {
      removeGroups[i] = true
      removableSegments += group.segmentCount
    }
  }

  if (removableSegments === 0 || removableSegments > totalSegments * 0.2) return content

  const result: string[] = []
  for (let i = 0; i < groups.length; i++) {
    if (!removeGroups[i]) result.push(...groups[i].lines)
  }
  return normalizeMediaPlaylist(result.join(linesplit))
}

/**
 * 规范化播放列表（去除多余空行和尾部空行）
 */
function normalizeMediaPlaylist(content: string): string {
  return content
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    + '\n'
}

/**
 * 保留点播的 #EXT-X-ENDLIST
 */
function keepVodEndList(original: string, content: string): string {
  if (original.includes(TAG_ENDLIST) && !content.includes(TAG_ENDLIST)) {
    let c = content.trimEnd()
    if (!c.endsWith('\n')) c += '\n'
    return c + TAG_ENDLIST + '\n'
  }
  return content
}

/**
 * 主入口：净化 M3U8 播放列表
 * @param tsUrlPre TS 分片 URL 前缀（用于拼接相对路径）
 * @param m3u8content M3U8 播放列表文本
 * @param adsHostRegex 额外广告过滤正则（可选）
 * @returns 净化后的播放列表；如果无需处理返回 null
 */
function purifyM3u8(
  tsUrlPre: string,
  m3u8content: string,
  adsHostRegex?: string[],
): string | null {
  if (!m3u8content || m3u8content.length === 0) return null
  if (m3u8content.startsWith('\ufeff')) m3u8content = m3u8content.substring(1)
  if (!m3u8content.startsWith('#EXTM3U')) return null

  const totalSegments = (m3u8content.match(/^(?!#)(?=\S)/gm) || []).length

  // Step 1: 移除少数 URL 路径的片段
  let result: string | null = null
  const removed = removeMinorityUrls(tsUrlPre, m3u8content)
  if (removed.result !== null) {
    result = removed.result
    // 进一步净化
    result = cleanCommonAdMarkers(result)
    result = cleanShortDiscontinuityGroups(result)
    result = removeAdSegmentUris(result, tsUrlPre)
  }

  // Step 2: 外部正则过滤
  if (adsHostRegex && adsHostRegex.length > 0) {
    const base = result || m3u8content
    result = cleanByRegex(base, adsHostRegex)
  }

  // Step 3: 如果已经是最终的点播列表，做帧率/精度分析
  if (result && hasEndList(result) && result.includes(TAG_DISCONTINUITY)) {
    result = cleanDecimalPrecisionGroups(result)
    result = cleanFrameRateGroups(result)
  }

  // Step 4: 清理断点分组
  if (result) {
    result = cleanShortDiscontinuityGroups(result)
  }

  // Step 5: 保留点播结束标记
  if (result) {
    result = keepVodEndList(m3u8content, result)
  }

  // 安全检查：移除过多片段则回退
  if (result) {
    const resultSegments = (result.match(/^(?!#)(?=\S)/gm) || []).length
    if (totalSegments > 0 && (totalSegments - resultSegments) > totalSegments * 0.5) {
      return null
    }
    if (!isPlayableMediaPlaylist(result)) {
      return null
    }
  }

  return result || null
}

// ============ 批量频道名过滤 ============

/**
 * 从频道列表中过滤广告频道
 * @param channels 频道名称数组
 * @returns 非广告频道的索引数组
 */
function filterAdChannels(channels: { name: string }[]): Set<number> {
  const keep = new Set<number>()
  for (let i = 0; i < channels.length; i++) {
    if (!isAdChannelName(channels[i].name)) {
      keep.add(i)
    }
  }
  return keep
}