/**
 * DashJsPlugin — MPEG-DASH（mpd）解封装引擎
 *
 * 封装 dash.js：负责 DASH 容器解封装并通过 MSE 供给 <video>。按需动态加载，
 * 未安装时由回退链自动跳过。
 */

import { logger } from '@/utils/logger'
import { BasePluginInstance } from '../base'
import type { MediaFormat, PlayContext, PlayerPlugin } from '../types'

class DashJsPluginInstance extends BasePluginInstance {
  readonly pluginId = 'dashjs'
  readonly kind = 'mse' as const
  private player: any = null

  async attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): Promise<void> {
    if (!(target instanceof HTMLVideoElement)) {
      this.emit('error', new Error('[DashJsPlugin] target must be an HTMLVideoElement'))
      return
    }
    try {
      // dash.js 5.x 为 ESM 命名导出：MediaPlayer 既是工厂函数，又携带 events/errors 常量
      const { MediaPlayer } = await import('dashjs')
      const player = MediaPlayer().create()
      this.player = player

      player.on(MediaPlayer.events.ERROR, (e: any) => {
        logger.warn('[DashJsPlugin] error:', e?.error)
        this.emit('error', new Error(e?.error?.message ?? 'DASH error'))
      })
      player.on(MediaPlayer.events.MANIFEST_LOADED, () => this.emit('ready'))
      player.on(MediaPlayer.events.STREAM_INITIALIZED, () => this.emit('canplay'))

      player.initialize(target, context.url, false)
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
    }
  }

  destroy(): void {
    const player = this.player
    this.player = null
    if (player) {
      try { player.reset() } catch (_) {}
    }
  }
}

export const dashJsPlugin: PlayerPlugin = {
  id: 'dashjs',
  name: 'dash.js',
  kind: 'mse',
  formats: ['dash'],
  priority: 80,
  supportsLive: true,
  usesMse: true,
  packageName: 'dashjs',
  description: 'MPEG-DASH（mpd）解封装 + MSE',
  isAvailable: () => true,
  canPlay: (format: MediaFormat) => format === 'dash',
  create: () => new DashJsPluginInstance(),
}