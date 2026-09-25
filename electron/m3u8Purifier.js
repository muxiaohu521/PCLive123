/**
 * M3U8 播放列表广告净化模块（Electron 主进程用）
 * 参考 TVBox AdBlocker.java / M3u8.java 实现
 * 广告规则常量来自共享文件: electron/shared/ad-filter-rules.json
 */

const shared = require('./shared/ad-filter-rules.json')

// ---- 内置广告域名黑名单（来自共享规则文件） ----
const DEFAULT_AD_HOSTS = shared.DEFAULT_AD_HOSTS

// ---- 广告片段 URL 特征正则（来自共享规则文件） ----
const AD_SEGMENT_URI_REGEX = new RegExp(
  shared.AD_SEGMENT_URI_REGEX_SOURCE,
  shared.AD_SEGMENT_URI_REGEX_FLAGS
)

// ---- M3U8 标签常量（来自共享规则文件） ----
const T = shared.M3U8_TAGS
const TAG_MEDIA_DURATION = T.TAG_MEDIA_DURATION
const TAG_DISCONTINUITY = T.TAG_DISCONTINUITY
const TAG_ENDLIST = T.TAG_ENDLIST
const TAG_KEY = T.TAG_KEY
const TAG_MAP = T.TAG_MAP
const TAG_CUE_OUT = T.TAG_CUE_OUT
const TAG_CUE_IN = T.TAG_CUE_IN
const TAG_DATERANGE = T.TAG_DATERANGE

// ---- 工具函数 ----

function isAdHost(url) {
  const lower = url.toLowerCase()
  for (const host of DEFAULT_AD_HOSTS) {
    if (lower.includes(host)) return true
  }
  return false
}

function toAbsoluteUrl(baseUrl, segment) {
  if (/^https?:\/\//i.test(segment)) return segment
  try {
    return new URL(segment, baseUrl).href
  } catch {
    return segment
  }
}

function isSegmentTag(line) {
  const t = line.trim()
  return t.startsWith(TAG_MEDIA_DURATION) || t.startsWith(TAG_KEY) ||
    t.startsWith(TAG_MAP) || t.startsWith(TAG_DISCONTINUITY)
}

/**
 * 规范化播放列表（去除多余空行）
 */
function normalizePlaylist(content) {
  return content.replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 检查是否为有效的媒体播放列表
 */
function isPlayablePlaylist(content) {
  if (!content || !content.startsWith('#EXTM3U')) return false
  let segCount = 0
  for (const line of content.split('\n')) {
    if (line.trim() && line.trim().charAt(0) !== '#') segCount++
  }
  return segCount >= 2
}

/**
 * 第一步：移除含黑名单域名的 TS 片段
 */
function removeAdHostSegments(playlist, baseUrl) {
  const linesplit = playlist.includes('\r\n') ? '\r\n' : '\n'
  const lines = playlist.split(linesplit)
  const result = []
  let pendingTags = []
  let removedCount = 0
  let totalSegs = 0

  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].trim()
    if (item.length === 0) {
      if (pendingTags.length === 0) result.push(lines[i])
      else pendingTags.push(lines[i])
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

    totalSegs++
    const absoluteUrl = toAbsoluteUrl(baseUrl, lines[i])
    if (isAdHost(absoluteUrl)) {
      pendingTags = []
      removedCount++
    } else {
      for (const t of pendingTags) result.push(t)
      pendingTags = []
      result.push(lines[i])
    }
  }

  // 移除过多片段则放弃
  if (totalSegs > 0 && removedCount > totalSegs * 0.5) return null
  return result.join(linesplit)
}

/**
 * 第二步：移除广告特征 URI 的 TS 片段
 */
function removeAdSegmentUris(playlist, baseUrl) {
  const linesplit = playlist.includes('\r\n') ? '\r\n' : '\n'
  const lines = playlist.split(linesplit)
  const result = []
  let pendingTags = []

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

    const absoluteUrl = toAbsoluteUrl(baseUrl, item)
    if (AD_SEGMENT_URI_REGEX.test(absoluteUrl)) {
      pendingTags = []
      continue
    }

    for (const t of pendingTags) result.push(t)
    pendingTags = []
    result.push(lines[i])
  }

  return normalizePlaylist(result.join(linesplit))
}

/**
 * 第三步：移除常见广告标记标签（CUE-OUT, CUE-IN, DATERANGE）
 */
function cleanAdMarkers(content) {
  const lines = content.split('\n')
  const result = []
  const adPrefixes = [TAG_CUE_OUT, TAG_CUE_IN, TAG_DATERANGE]

  for (const line of lines) {
    const trimmed = line.trim()
    let isAd = false
    for (const prefix of adPrefixes) {
      if (trimmed.startsWith(prefix)) { isAd = true; break }
    }
    if (!isAd) result.push(line)
  }
  return result.join('\n')
}

/**
 * 主入口：净化 M3U8 播放列表
 * @param {string} baseUrl - 播放列表的基础 URL
 * @param {string} playlistContent - M3U8 播放列表文本
 * @returns {string|null} 净化后的播放列表，无需处理返回 null
 */
function purifyM3u8Playlist(baseUrl, playlistContent) {
  if (!playlistContent || playlistContent.length === 0) return null
  if (playlistContent.startsWith('\ufeff')) playlistContent = playlistContent.substring(1)
  if (!playlistContent.startsWith('#EXTM3U')) return null

  const totalSegments = (playlistContent.match(/^(?!#)(?=\S)/gm) || []).length

  // Step 1: 移除黑名单域名的 TS 片段
  let result = removeAdHostSegments(playlistContent, baseUrl)

  // Step 2: 移除广告特征 URI 的片段
  if (result) {
    result = removeAdSegmentUris(result, baseUrl)
  }

  // Step 3: 移除广告标记标签
  if (result) {
    result = cleanAdMarkers(result)
  } else {
    result = cleanAdMarkers(playlistContent)
  }

  // Step 4: 规范化
  if (result) {
    result = normalizePlaylist(result)
  }

  // 安全检查：移除过多片段则回退
  if (result) {
    const resultSegments = (result.match(/^(?!#)(?=\S)/gm) || []).length
    if (totalSegments > 0 && (totalSegments - resultSegments) > totalSegments * 0.5) {
      return null
    }
    if (!isPlayablePlaylist(result)) {
      return null
    }
  }

  // 保留 ENDLIST（点播）
  if (result && playlistContent.includes(TAG_ENDLIST) && !result.includes(TAG_ENDLIST)) {
    result = result.trimEnd()
    if (!result.endsWith('\n')) result += '\n'
    result += TAG_ENDLIST + '\n'
  }

  return result
}

module.exports = { purifyM3u8Playlist, isAdHost }