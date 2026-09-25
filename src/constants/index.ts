export const STORAGE_KEYS = {
  SOURCES: 'pclive_sources',
  CURRENT_SOURCE: 'pclive_current_source',
  CHANNEL_STATE: 'pclive_channel_state',
  VOLUME: 'pclive_volume',
  SOURCE_STATS: 'pclive_source_stats',
  DECODE_MODE: 'pclive_decode_mode',
  FFMPEG_PATH: 'pclive_ffmpeg_path',
  LOCAL_VIDEOS: 'pclive_local_videos',
  LOCAL_PLAY_MODE: 'pclive_local_play_mode',
} as const

export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv',
  '.webm', '.m4v', '.ts', '.mts', '.m2ts', '.ogv',
  '.3gp', '.3g2', '.asf', '.vob', '.rmvb', '.divx',
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.opus',
  '.wma', '.ape', '.alac', '.aiff', '.aif', '.ogg',
] as const

export const PLAY_MODES = {
  SINGLE_LOOP: 'single_loop',
  SEQUENTIAL: 'sequential',
  RANDOM: 'random',
} as const

export type PlayMode = typeof PLAY_MODES[keyof typeof PLAY_MODES]

export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  single_loop: '单曲循环',
  sequential: '顺序播放',
  random: '随机播放',
}

export function filePathToUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const drivePrefix = /^([A-Za-z]):/i
  let pathPart = normalized.replace(drivePrefix, (_, letter) => `/${letter}:`)
  if (!pathPart.startsWith('/')) pathPart = '/' + pathPart
  const encoded = pathPart.split('/').map(encodeURIComponent).join('/')
  return 'file://' + encoded
}

export interface LocalVideoItem {
  name: string
  filePath: string
  size: number
  addedAt: number
}

export const DECODE_MODES = {
  AUTO: 'auto',
  HARDWARE: 'hardware',
  SOFTWARE: 'software',
  FFMPEG: 'ffmpeg',
} as const

export type DecodeMode = typeof DECODE_MODES[keyof typeof DECODE_MODES]

export const DECODE_MODE_LABELS: Record<DecodeMode, string> = {
  auto: '自动',
  hardware: '硬解',
  software: '软解',
  ffmpeg: 'FFmpeg',
}

export interface SourceItem {
  name: string
  url: string
}

export const APP_CONFIG = {
  MAX_REDIRECTS: 8,
  FETCH_TIMEOUT: 5000,
} as const