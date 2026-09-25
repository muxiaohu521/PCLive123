/**
 * M3U ↔ JSON 双向转换模块 (TypeScript)
 *
 * 数据结构关系:
 *   M3U 文本  ←→  LiveChannelGroup[]  ←→  CacheStorageEntry
 *
 * 导出函数:
 *   parseM3u(content)        → LiveChannelGroup[]
 *   generateM3u(groups, name) → M3U string
 *   m3uToCacheEntry(content, livesGroups) → CacheStorageEntry
 *   cacheEntryToM3u(entry, name) → M3U string
 *
 * 与 tools/m3u_converter.js 保持一致的转换逻辑
 */

import type { LiveChannelGroup, LiveSourceGroup } from '@/models/LiveChannelItem'
import type { CacheStorageEntry } from '@/services/ChannelService'

// 重新导出供外部使用
export type { CacheStorageEntry }

// --------------- M3U → LiveChannelGroup[] ---------------

function extAttr(line: string, name: string): string {
  const m = line.match(new RegExp(name + '="([^"]*)"'))
  return m ? m[1] : ''
}

export function parseM3u(content: string): LiveChannelGroup[] {
  const groups: LiveChannelGroup[] = []
  let currentGroup: LiveChannelGroup | null = null
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '#EXTM3U' || trimmed.startsWith('#PLAYLIST')) continue

    if (trimmed.startsWith('#EXTINF')) {
      const tvgId = extAttr(trimmed, 'tvg-id')
      const tvgName = extAttr(trimmed, 'tvg-name')
      const tvgLogo = extAttr(trimmed, 'tvg-logo')
      const groupTitle = extAttr(trimmed, 'group-title')
      const commaIdx = trimmed.lastIndexOf(',')
      const channelName = commaIdx >= 0 ? trimmed.substring(commaIdx + 1).trim() : ''

      if (!currentGroup || currentGroup.groupName !== groupTitle) {
        currentGroup = {
          groupName: groupTitle,
          groupPassword: '',
          subLineName: '',
          liveChannels: []
        }
        groups.push(currentGroup)
      }

      currentGroup.liveChannels.push({
        channelName: channelName || tvgName || tvgId,
        channelNum: 0,
        channelLogo: tvgLogo || '',
        channelUa: '',
        channelClick: '',
        channelFormat: '',
        channelOrigin: '',
        channelReferer: '',
        channelTvgId: tvgId || '',
        channelTvgName: tvgName || '',
        channelHeader: {},
        channelParse: 0,
        channelUrls: [],
        channelSourceNames: [],
        sourceIndex: 0,
        sourceNum: 0,
        includeBack: false
      })
      continue
    }

    if (currentGroup && currentGroup.liveChannels.length > 0) {
      const last = currentGroup.liveChannels[currentGroup.liveChannels.length - 1]
      if (!trimmed.startsWith('#') && (trimmed.startsWith('http') || trimmed.startsWith('rtmp'))) {
        last.channelUrls.push(trimmed)
      }
    }
  }

  return groups.filter(g => g.liveChannels.length > 0)
}

// --------------- LiveChannelGroup[] → M3U ---------------

function generateM3u(groups: LiveChannelGroup[], sourceName?: string): string {
  const lines: string[] = ['#EXTM3U']
  if (sourceName) {
    lines.push(`#PLAYLIST:${sourceName}`)
  }
  lines.push('')

  for (const group of groups) {
    if (!group.liveChannels || group.liveChannels.length === 0) continue

    for (const ch of group.liveChannels) {
      const urls = ch.channelUrls || []
      if (urls.length === 0) continue

      const attrs: string[] = []
      if (ch.channelTvgId) attrs.push(`tvg-id="${ch.channelTvgId}"`)
      if (ch.channelTvgName) attrs.push(`tvg-name="${ch.channelTvgName}"`)
      if (ch.channelLogo) attrs.push(`tvg-logo="${ch.channelLogo}"`)
      attrs.push(`group-title="${group.groupName}"`)

      lines.push(`#EXTINF:-1 ${attrs.join(' ')} ,${ch.channelName}`)
      lines.push(urls[0])
      lines.push('')
    }
  }

  return lines.join('\n')
}

// --------------- M3U → CacheStorageEntry ---------------

function m3uToCacheEntry(m3uContent: string, livesGroups?: LiveSourceGroup[]): CacheStorageEntry {
  const data = parseM3u(m3uContent)
  return {
    data,
    livesGroups: livesGroups || [],
    time: Date.now(),
    completedCount: data.reduce((sum, g) => sum + g.liveChannels.length, 0)
  }
}

// --------------- CacheStorageEntry → M3U ---------------

export function cacheEntryToM3u(entry: CacheStorageEntry, sourceName?: string): string {
  return generateM3u(entry.data || [], sourceName)
}

// --------------- 工具函数 ---------------

export function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 100) || 'live_source'
}