/**
 * WebTorrentPlugin — BitTorrent（magnet / .torrent）流式播放引擎
 *
 * 封装 WebTorrent：通过 WebRTC 与 WebSocket 传输 torrent，按需渲染到 <video>。
 * 适用于 magnet: 链接或 .torrent 文件（mp4 / webm 等可直接流式分发的媒体）。
 * 按需动态加载，未安装时由回退链自动跳过。
 */

import { logger } from '@/utils/logger'
import { BasePluginInstance } from '../base'
import type { MediaFormat, PlayContext, PlayerPlugin } from '../types'

class WebTorrentPluginInstance extends BasePluginInstance {
  readonly pluginId = 'webtorrent'
  readonly kind = 'mse' as const
  private client: any = null

  async attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): Promise<void> {
    if (!(target instanceof HTMLVideoElement)) {
      this.emit('error', new Error('[WebTorrentPlugin] target must be an HTMLVideoElement'))
      return
    }
    try {
      // 使用官方预构建的浏览器 ESM bundle（已内置 Web Crypto polyfill），
      // 避免从源码构建时 bittorrent-protocol 等依赖 Node 内置 crypto 的兼容问题。
      const WebTorrent = (await import('webtorrent/dist/webtorrent.min.js')).default
      const client = new WebTorrent()
      this.client = client

      client.on('error', (e: Error) => {
        logger.warn('[WebTorrentPlugin] client error:', e?.message)
        this.emit('error', e instanceof Error ? e : new Error(String(e)))
      })

      client.add(context.url, { announce: [] }, (torrent: any) => {
        const file = (torrent.files ?? []).find((f: any) => {
          return /\.(mp4|m4v|webm|mkv|mov|ogg|ogv)$/i.test(f.name)
        }) ?? torrent.files?.[0]
        if (!file) {
          this.emit('error', new Error('[WebTorrentPlugin] no playable file in torrent'))
          return
        }
        this.emit('ready')
        file.renderTo(target)
      })
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
    }
  }

  destroy(): void {
    const client = this.client
    this.client = null
    if (client) {
      try { client.destroy() } catch (_) {}
    }
  }
}

export const webTorrentPlugin: PlayerPlugin = {
  id: 'webtorrent',
  name: 'WebTorrent',
  kind: 'mse',
  formats: ['torrent'],
  priority: 50,
  supportsLive: false,
  usesMse: false,
  packageName: 'webtorrent',
  description: 'BitTorrent（magnet / .torrent）流式播放',
  isAvailable: () => true,
  canPlay: (format: MediaFormat) => format === 'torrent',
  create: () => new WebTorrentPluginInstance(),
}