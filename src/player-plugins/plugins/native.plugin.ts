/**
 * NativePlugin — 浏览器原生 <video> 播放引擎
 *
 * 适用于 MP4 / WebM / MKV 等浏览器原生支持的视频格式。无解封装、无 MSE，
 * 依赖 Chromium 内建解码器。纯音频（mp3/flac 等）由 AudioPlugin 负责，
 * 本引擎只处理视频，避免 audio 格式被 video.src 误路由。
 */

import { BasePluginInstance } from '../base'
import type { MediaFormat, PlayContext, PlayerPlugin } from '../types'

class NativePluginInstance extends BasePluginInstance {
  readonly pluginId = 'native'
  readonly kind = 'mse' as const
  private video: HTMLVideoElement | null = null

  attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): void {
    if (!(target instanceof HTMLVideoElement)) {
      this.emit('error', new Error('[NativePlugin] target must be an HTMLVideoElement'))
      return
    }
    this.video = target
    target.src = context.url
  }

  destroy(): void {
    if (this.video) {
      try { this.video.pause() } catch (_) {}
      // 不 removeAttribute('src') + load()：切频道时这会破坏 captureStream 的音频捕获管道，
      // 让新音轨成为僵尸轨道（readyState=live 却不再产出数据），悬浮窗镜像因此无声。
      // 本引擎 attach 仅是 target.src = url 直接覆盖，下次 attach 会自然替换旧 src。
      this.video = null
    }
  }
}

export const nativePlugin: PlayerPlugin = {
  id: 'native',
  name: 'Native HTML5 Video',
  kind: 'mse',
  formats: ['mp4'],
  priority: 100,
  supportsLive: false,
  usesMse: false,
  description: '浏览器原生 <video> 播放（MP4/WebM/MKV）',
  isAvailable: () => typeof HTMLVideoElement !== 'undefined',
  canPlay: (format: MediaFormat) => format === 'mp4',
  create: () => new NativePluginInstance(),
}