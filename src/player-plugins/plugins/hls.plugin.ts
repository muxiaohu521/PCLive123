/**
 * HlsPlugin — HLS（m3u8）解封装引擎
 *
 * 封装 hls.js：负责 HLS 容器的解封装与 MediaSource 供给，真正的解码由
 * Chromium 调用本机 GPU 硬件解码器完成（硬解）或软件解码器完成（软解）。
 */

import Hls from 'hls.js'
import { logger } from '@/utils/logger'
import { BasePluginInstance } from '../base'
import type { MediaFormat, PlayContext, PlayerPlugin } from '../types'

class HlsPluginInstance extends BasePluginInstance {
  readonly pluginId = 'hls'
  readonly kind = 'mse' as const
  private hls: Hls | null = null
  private video: HTMLVideoElement | null = null
  private recoveryAttempts = 0
  private isLiveStream = false
  private onEnded: (() => void) | null = null

  attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): void {
    if (!(target instanceof HTMLVideoElement)) {
      this.emit('error', new Error('[HlsPlugin] target must be an HTMLVideoElement'))
      return
    }
    if (!Hls.isSupported()) {
      this.emit('error', new Error('[HlsPlugin] MSE is not supported'))
      return
    }

    this.video = target
    // 硬解模式用更紧凑的缓冲配置以压低时延，软解/自动模式用宽松配置提升稳定性
    const isHardware = context.decodeMode === 'hardware'
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      maxBufferLength: isHardware ? 30 : 60,
      maxMaxBufferLength: isHardware ? 300 : 600,
      maxBufferSize: (isHardware ? 80 : 120) * 1000 * 1000,
      highBufferWatchdogPeriod: 2,
      liveSyncDurationCount: isHardware ? 4 : 5,
      liveMaxLatencyDurationCount: 12,
      xhrSetup: (xhr: XMLHttpRequest) => {
        for (const [k, v] of Object.entries(context.headers)) {
          try { xhr.setRequestHeader(k, v) } catch (_) { /* 忽略禁止头 */ }
        }
      },
    })
    this.hls = hls

    hls.on(Hls.Events.ERROR, (_event, data) => {
      logger.warn('[HlsPlugin] error:', data.type, data.details, 'fatal:', data.fatal)
      if (!data.fatal) {
        // 媒体错误：引擎内部恢复 MediaSource
        if (data.type === 'mediaError' || data.details === 'mediaSourceRequiresReset') {
          try { hls.recoverMediaError() } catch (_) { /* 恢复失败则等待下次事件 */ }
        }
        // 非致命错误统一上抛（携带完整 data），交由播放器层识别 buffer 停滞 / token 过期等策略
        this.emit('error', data)
        return
      }
      // 致命错误：硬解模式允许同管线恢复（重置 MediaSource / 重新加载）最多 2 次，
      // 之后才上抛 fatal 交由播放器层做「禁止降级」的最终判定。
      if (context.decodeMode === 'hardware' && this.recoveryAttempts < 2) {
        this.recoveryAttempts++
        logger.warn(`[HlsPlugin] 硬解致命错误, 同管线恢复 (${this.recoveryAttempts}/2)`)
        try {
          if (data.type === 'mediaError') hls.recoverMediaError()
          else hls.startLoad()
          return
        } catch (_) { /* 恢复失败则上抛 fatal */ }
      }
      this.emit('fatal', data)
    })
    hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
      try {
        const details = (data && (data as any).details) as any
        if (details && typeof details.live === 'boolean') this.isLiveStream = details.live
      } catch (_) { /* 仅用于直播判定 */ }
    })
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      let codec: string | undefined
      let width: number | undefined
      let height: number | undefined
      try {
        const idx = hls.currentLevel >= 0 ? hls.currentLevel : 0
        const level = hls.levels && hls.levels[idx]
        codec = (level as any)?.codecSet || (level as any)?.videoCodec
        width = level?.width
        height = level?.height
      } catch (_) { /* 仅用于硬解 codec 校验 */ }
      this.emit('ready', { codec, width, height })
    })
    hls.on(Hls.Events.FRAG_BUFFERED, () => this.emit('canplay'))

    hls.attachMedia(target)
    hls.loadSource(context.url)

    // 直播流 ended 属于异常（缓冲耗尽/刷新失败），不应销毁实例；点播流 ended 上抛给播放器层。
    this.onEnded = () => {
      if (this.isLiveStream) {
        logger.warn('[HlsPlugin] live HLS ended, attempting to recover instead of destroy')
        try { hls.startLoad() } catch (_) { /* */ }
        try { target.play().catch(() => {}) } catch (_) { /* */ }
        target.addEventListener('ended', this.onEnded!, { once: true })
        return
      }
      try { hls.stopLoad() } catch (_) { /* */ }
      this.emit('ended')
    }
    target.addEventListener('ended', this.onEnded, { once: true })
  }

  destroy(): void {
    const hls = this.hls
    this.hls = null
    if (this.video && this.onEnded) {
      this.video.removeEventListener('ended', this.onEnded)
    }
    this.onEnded = null
    if (hls) {
      try { hls.stopLoad() } catch (_) {}
      try { hls.detachMedia() } catch (_) {}
      try { hls.destroy() } catch (_) {}
    }
    if (this.video) {
      // 不 removeAttribute('src') + load()：hls.detachMedia() 已清理 MediaSource，
      // 再次 load 只会破坏 captureStream 音轨捕获管道，导致切源后悬浮窗无声。
      this.video = null
    }
  }
}

export const hlsPlugin: PlayerPlugin = {
  id: 'hls',
  name: 'hls.js',
  kind: 'mse',
  formats: ['m3u8'],
  priority: 90,
  supportsLive: true,
  usesMse: true,
  packageName: 'hls.js',
  description: 'HLS（m3u8）解封装 + MSE',
  isAvailable: () => typeof Hls !== 'undefined' && Hls.isSupported(),
  canPlay: (format: MediaFormat) => format === 'm3u8',
  create: () => new HlsPluginInstance(),
}