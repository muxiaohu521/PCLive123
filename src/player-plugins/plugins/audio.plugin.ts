/**
 * AudioPlugin — 纯音频软件解码引擎
 *
 * 封装 SoftwareAudioPlayer（Web Audio API 软解），适用于 MP3 / AAC / FLAC /
 * WAV / Opus / OGG 等浏览器原生支持的音频编码。不依赖 <video> 元素，直接
 * 通过 Web Audio 管线播放，需要完整文件，不适用无限流媒体（直播音频请走 FFmpeg）。
 */

import { SoftwareAudioPlayer } from '@/services/AudioPlayer'
import { BasePluginInstance } from '../base'
import type { MediaFormat, PlayContext, PlayerPlugin } from '../types'

class AudioPluginInstance extends BasePluginInstance {
  readonly pluginId = 'audio'
  readonly kind = 'mse' as const
  /** 暴露底层 Web Audio 播放器，供播放器层同步音量/静音 */
  readonly player = new SoftwareAudioPlayer()

  attach(_target: HTMLVideoElement | HTMLElement, context: PlayContext): void {
    this.player.on('ready', () => this.emit('ready'))
    this.player.on('canplay', () => this.emit('canplay'))
    this.player.on('play', () => this.emit('playing'))
    this.player.on('pause', () => this.emit('pause'))
    this.player.on('ended', () => this.emit('ended'))
    this.player.on('waiting', () => this.emit('waiting'))
    this.player.on('error', (e: Error) => this.emit('error', e))

    this.player.load(context.url).then(() => {
      if (typeof context.volume === 'number') this.player.setVolume(context.volume)
      if (typeof context.muted === 'boolean') this.player.setMuted(context.muted)
      this.player.play()
    }).catch((e: Error) => {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
    })
  }

  destroy(): void {
    this.player.destroy()
  }
}

export const audioPlugin: PlayerPlugin = {
  id: 'audio',
  name: 'Web Audio Software Decoder',
  kind: 'mse',
  formats: ['audio'],
  priority: 90,
  supportsLive: false,
  usesMse: false,
  description: 'Web Audio API 音频软解（MP3/AAC/FLAC/WAV/Opus/OGG 等）',
  isAvailable: () => typeof AudioContext !== 'undefined',
  canPlay: (format: MediaFormat) => format === 'audio',
  create: () => new AudioPluginInstance(),
}