/**
 * NetworkInterceptor — 网络请求头注入管理服务
 *
 * 职责：
 * - 管理 webRequest.onBeforeSendHeaders 的 header 注入 key
 * - 注册/注销 CDN 域名 header 覆盖规则
 *
 * 播放器不应直接调用 electronAPI 的 registerVideoHeaders/unregisterVideoHeaders
 */

import { logger } from '@/utils/logger'

export class NetworkInterceptor {
  private headerKey: string | null = null

  get currentKey(): string | null {
    return this.headerKey
  }

  /**
   * 为直连播放（external/sniffer/direct）注册 header 注入
   * 让 Chromium 发出的请求带上正确的 Referer/Origin，
   * 使 CDN（如百度 bdstatic.com）认为是合法浏览器流量。
   */
  async registerForDirectPlay(
    finalUrl: string,
    headers: Record<string, string>,
    isExternalPlay: boolean,
  ): Promise<void> {
    const hasCustomHeaders = !!(
      headers['Referer'] || headers['referer'] ||
      headers['Origin'] || headers['origin']
    )
    if (!hasCustomHeaders || !window.electronAPI) return

    try {
      // 先清理旧 key
      await this.unregister()

      let cdnDomain = ''
      try { cdnDomain = new URL(finalUrl).hostname } catch (_) {}

      const headerKey = (isExternalPlay ? 'ext-' : 'direct-') + Date.now()
      await window.electronAPI.registerVideoHeaders(headerKey, cdnDomain, {
        Referer: headers['Referer'] || headers['referer'] || '',
        Origin: headers['Origin'] || headers['origin'] || '',
      })

      this.headerKey = headerKey
      logger.info(`[NetworkInterceptor] Registered for ${cdnDomain} (${headerKey})`)
    } catch (e) {
      logger.warn('[NetworkInterceptor] Registration failed:', e)
    }
  }

  /** 注销当前 header 注入 */
  async unregister(): Promise<void> {
    const key = this.headerKey
    this.headerKey = null
    if (key && window.electronAPI) {
      try { await window.electronAPI.unregisterVideoHeaders(key) } catch (_) {}
    }
  }

  /** 销毁 */
  destroy(): void {
    this.unregister().catch(() => {})
  }
}