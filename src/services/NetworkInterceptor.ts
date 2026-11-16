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

/**
 * 判断 hostname 是否为本地回环地址（127.0.0.1 / localhost / ::1）。
 * 本地代理与本地服务（FFmpeg/本地文件/流代理）的请求头由主进程在服务端注入，
 * 渲染进程侧绝不可再注入 Origin/Referer。
 */
function isLoopbackHost(hostname: string): boolean {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\./.test(h)
}

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
    // 收集所有需要注入的自定义请求头（Referer/Origin/UID 等）。
    // 央视频等专有解析会返回 UID 头，丢弃会导致 CDN 拒绝 m3u8/分片请求。
    const injectHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers || {})) {
      if (v) injectHeaders[k] = v
    }
    const hasCustomHeaders = Object.keys(injectHeaders).length > 0
    if (!hasCustomHeaders || !window.electronAPI) return

    try {
      // 先清理旧 key
      await this.unregister()

      let cdnDomain = ''
      try { cdnDomain = new URL(finalUrl).hostname } catch (_) {}

      // 本地代理/本地服务的请求头已由主进程在服务端注入，渲染进程侧再注入
      // 会把浏览器真实的 Origin 覆盖成上游 Origin，导致本地代理回显错误的
      // Access-Control-Allow-Origin，触发 hls.js 的 CORS 失败。
      if (isLoopbackHost(cdnDomain)) {
        logger.info(`[NetworkInterceptor] skip loopback host: ${cdnDomain}`)
        return
      }

      const headerKey = (isExternalPlay ? 'ext-' : 'direct-') + Date.now()
      await window.electronAPI.registerVideoHeaders(headerKey, cdnDomain, injectHeaders)

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