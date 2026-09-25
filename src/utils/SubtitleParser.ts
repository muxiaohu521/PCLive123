export interface SubtitleCue {
  index: number
  startTime: number
  endTime: number
  text: string
}

export function parseSrt(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = normalized.split(/\n\n+/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 2) continue

    const index = parseInt(lines[0], 10)
    if (isNaN(index)) continue

    const timeMatch = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/)
    if (!timeMatch) continue

    const startTime = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]) + parseInt(timeMatch[4]) / 1000
    const endTime = parseInt(timeMatch[5]) * 3600 + parseInt(timeMatch[6]) * 60 + parseInt(timeMatch[7]) + parseInt(timeMatch[8]) / 1000

    const text = lines.slice(2).join('\n').replace(/<[^>]*>/g, '').trim()
    if (text) {
      cues.push({ index, startTime, endTime, text })
    }
  }

  return cues
}

export function parseVtt(content: string): SubtitleCue[] {
  const cleaned = content.replace(/^WEBVTT.*\n/i, '')
  return parseSrt(cleaned)
}

export function parseAss(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const lines = content.split(/\r?\n/)
  let idx = 0

  for (const line of lines) {
    if (line.startsWith('Dialogue:')) {
      const parts = line.split(',')
      if (parts.length < 10) continue

      const startStr = parts[1].trim()
      const endStr = parts[2].trim()

      const startTime = parseAssTime(startStr)
      const endTime = parseAssTime(endStr)

      const text = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').trim()
      if (text && startTime >= 0 && endTime >= 0) {
        cues.push({ index: ++idx, startTime, endTime, text })
      }
    }
  }

  return cues
}

function parseAssTime(time: string): number {
  const m = time.match(/^(-?\d+):(\d{2}):(\d{2})\.(\d{2,3})$/)
  if (!m) return -1
  const hours = parseInt(m[1], 10)
  const minutes = parseInt(m[2], 10)
  const seconds = parseInt(m[3], 10)
  let ms = parseInt(m[4], 10)
  if (ms < 100) ms *= 10
  return hours * 3600 + minutes * 60 + seconds + ms / 1000
}

export function detectSubtitleFormat(content: string): 'srt' | 'vtt' | 'ass' | 'unknown' {
  if (/^WEBVTT/i.test(content.trim())) return 'vtt'
  if (/^\[Script Info\]/i.test(content.trim())) return 'ass'
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(content)) return 'srt'
  return 'unknown'
}

export function parseSubtitle(content: string): SubtitleCue[] {
  const format = detectSubtitleFormat(content)
  switch (format) {
    case 'srt': return parseSrt(content)
    case 'vtt': return parseVtt(content)
    case 'ass': return parseAss(content)
    default: return []
  }
}

export function cuesToVtt(cues: SubtitleCue[]): string {
  let vtt = 'WEBVTT\n\n'
  for (const cue of cues) {
    vtt += `${formatTime(cue.startTime)} --> ${formatTime(cue.endTime)}\n`
    vtt += `${cue.text}\n\n`
  }
  return vtt
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.round((seconds % 1) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}.${padMs(ms)}`
}

function pad(n: number): string { return n < 10 ? '0' + n : '' + n }
function padMs(n: number): string { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n }