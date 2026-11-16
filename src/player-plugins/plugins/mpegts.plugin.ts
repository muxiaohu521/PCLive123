/**
 * MpegtsPlugin — FLV / MPEG-TS 解封装引擎
 *
 * 封装 mpegts.js（flv.js 的分支）：负责 FLV 与 MPEG-TS 容器的解封装，
 * 通过 MediaSource 供 <video> 解码。直播场景默认开启低延迟追帧。
 */

import mpegts from 'mpegts.js'
import { logger } from '@/utils/logger'
import { BasePluginInstance } from '../base'
import type { MediaFormat, PlayContext, PlayerPlugin } from '../types'

class MpegtsPluginInstance extends BasePluginInstance {
  readonly pluginId = 'mpegts'
  readonly kind = 'mse' as const
  private player: any = null
  private video: HTMLVideoElement | null = null
  private hwRetried = false

  attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): void {
    if (!(target instanceof HTMLVideoElement)) {
      this.emit('error', new Error('[MpegtsPlugin] target must be an HTMLVideoElement'))
      return
    }
    if (!mpegts.isSupported || !mpegts.isSupported()) {
      this.emit('error', new Error('[MpegtsPlugin] MSE is not supported'))
      return
    }

    this.video = target
    const type = context.format === 'ts' ? 'mpegts' : 'flv'
    const player = mpegts.createPlayer(
      {
        type,
        url: context.url,
        isLive: context.isLive,
        cors: true,
        withCredentials: false,
      },
      {
        enableWorker: true,
        enableStashBuffer: true,
        stashInitialSize: 2048,
        isLive: context.isLive,
        liveBufferLatencyChasing: context.isLive,
        liveBufferLatencyChasingOnPaused: false,
        liveBufferLatencyMinRemain: 5,
        liveBufferLatencyMaxLatency: 180,
        liveSync: false,
        lazyLoad: true,
        lazyLoadMaxDuration: 180,
        lazyLoadRecoverDuration: 30,
      },
    )
    this.player = player

    const hardwareMode = context.decodeMode === 'hardware'
    player.on(mpegts.Events.ERROR, (errType: string, errDetail: string) => {
      logger.warn('[MpegtsPlugin] error:', errType, errDetail)
      // 硬解模式只做同管线重连（1 次），不降级软解或外部播放器
      if (hardwareMode && !this.hwRetried) {
        this.hwRetried = true
        logger.warn('[MpegtsPlugin] 硬解错误, 同管线重连 (1/1)')
        try {
          player.unload()
          player.load()
          return
        } catch (_) { /* 重连失败则上抛 error */ }
      }
      this.emit('error', errType, errDetail)
    })
    player.on(mpegts.Events.METADATA_ARRIVED, () => this.emit('ready'))
    player.on(mpegts.Events.MEDIA_INFO, (info?: any) => {
      this.emit('canplay', info)
    })

    player.attachMediaElement(target)
    player.load()
  }

  destroy(): void {
    const player = this.player
    this.player = null
    if (player) {
      try { player.detachMediaElement() } catch (_) {}
      try { player.unload() } catch (_) {}
      try { player.destroy() } catch (_) {}
    }
    if (this.video) {
      // 不 removeAttribute('src') + load()：detachMediaElement() 已清理 MediaSource，
      // 再次 load 只会破坏 captureStream 音轨捕获管道，导致切源后悬浮窗无声。
      this.video = null
    }
  }
}

export const mpegtsPlugin: PlayerPlugin = {
  id: 'mpegts',
  name: 'mpegts.js',
  kind: 'mse',
  formats: ['flv', 'ts'],
  priority: 90,
  supportsLive: true,
  usesMse: true,
  packageName: 'mpegts.js',
  description: 'FLV / MPEG-TS 解封装 + MSE',
  isAvailable: () => typeof mpegts !== 'undefined' && !!mpegts.isSupported && mpegts.isSupported(),
  canPlay: (format: MediaFormat) => format === 'flv' || format === 'ts',
  create: () => new MpegtsPluginInstance(),
}