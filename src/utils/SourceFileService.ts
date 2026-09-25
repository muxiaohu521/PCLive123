import { stripJsonComments, isJson } from '@/utils/TxtParser'
import { parseM3u } from '@/utils/m3uConverter'

export interface SourceImportResult {
  name: string
  url: string
  channelCount: number
  format: 'json' | 'm3u' | 'txt' | 'unknown'
}

export interface ExportedChannel {
  name: string
  url: string
  group: string
  logo?: string
  tvgId?: string
  tvgName?: string
}

function parseJsonSource(content: string): SourceImportResult | null {
  try {
    const cleaned = stripJsonComments(content)
    const obj = JSON.parse(cleaned)
    if (obj.lives && Array.isArray(obj.lives)) {
      const count = obj.lives.reduce(
        (s: number, g: any) => s + ((g.channels || g.liveChannels || []).length),
        0,
      )
      return {
        name: '',
        url: '',
        channelCount: count,
        format: 'json',
      }
    }
    return null
  } catch {
    return null
  }
}

export function parseImportContent(content: string, sourceName?: string): SourceImportResult | null {
  if (!content || !content.trim()) return null

  const trimmed = content.trim()

  if (trimmed.startsWith('#EXTM3U')) {
    const groups = parseM3u(trimmed)
    const count = groups.reduce((s, g) => s + (g.liveChannels?.length || 0), 0)
    return {
      name: sourceName || 'M3U导入',
      url: '',
      channelCount: count,
      format: 'm3u',
    }
  }

  if (isJson(trimmed)) {
    const result = parseJsonSource(trimmed)
    if (result) {
      result.name = sourceName || 'JSON导入'
      return result
    }
  }

  const urlLines = trimmed.split('\n').filter((l) => /^https?:\/\//i.test(l.trim()))
  if (urlLines.length > 0) {
    return {
      name: sourceName || 'TXT导入',
      url: '',
      channelCount: urlLines.length,
      format: 'txt',
    }
  }

  return null
}

export function exportToM3u(channels: ExportedChannel[], sourceName?: string): string {
  const lines: string[] = ['#EXTM3U']
  if (sourceName) {
    lines.push(`#PLAYLIST:${sourceName}`)
  }
  lines.push('')

  for (const ch of channels) {
    const attrs: string[] = []
    if (ch.tvgId) attrs.push(`tvg-id="${ch.tvgId}"`)
    if (ch.tvgName) attrs.push(`tvg-name="${ch.tvgName}"`)
    if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`)
    attrs.push(`group-title="${ch.group}"`)

    lines.push(`#EXTINF:-1 ${attrs.join(' ')} ,${ch.name}`)
    lines.push(ch.url)
    lines.push('')
  }

  return lines.join('\n')
}