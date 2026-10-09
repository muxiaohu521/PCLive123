/**
 * StreamSessionManager — 统一管理底层流媒体资源会话
 *
 * 职责：
 * - 代理会话 (createStreamSession / closeStreamSession)
 * - FFmpeg 转码会话 (ffmpegCreateSession / ffmpegCloseSession)
 * - MPV 会话 (mpvCreateSession / mpvCloseSession)
 * - 本地文件服务 (serveLocalFile / closeLocalFileServer)
 *
 * 播放器不应直接调用 electronAPI 管理这些资源。
 */

import { logger } from '@/utils/logger'

export interface FfmpegSessionResult {
  success: boolean
  sessionId?: string
  proxyUrl?: string
  duration?: number
  error?: string
}

export interface MpvSessionResult {
  success: boolean
  sessionId?: string
  error?: string
}

export interface VlcSessionResult {
  success: boolean
  sessionId?: string
  error?: string
}

export interface LocalFileResult {
  success: boolean
  token?: string
  proxyUrl?: string
  error?: string
}

export interface StreamSessionResult {
  success?: boolean
  sessionId?: string
  proxyUrl?: string
  error?: string
}

export class StreamSessionManager {
  private proxySessionId: string | null = null
  private ffmpegSessionId: string | null = null
  private mpvSessionId: string | null = null
  private vlcSessionId: string | null = null
  private localFileToken: string | null = null

  /** 获取当前代理会话 ID（只读） */
  get currentProxySessionId(): string | null { return this.proxySessionId }

  /** 获取当前 FFmpeg 会话 ID（只读） */
  get currentFfmpegSessionId(): string | null { return this.ffmpegSessionId }

  /** 获取当前 MPV 会话 ID（只读） */
  get currentMpvSessionId(): string | null { return this.mpvSessionId }

  setMpvSessionId(id: string): void { this.mpvSessionId = id }

  /** 获取当前 VLC 会话 ID（只读） */
  get currentVlcSessionId(): string | null { return this.vlcSessionId }

  setVlcSessionId(id: string): void { this.vlcSessionId = id }

  /** 获取当前本地文件 token（只读） */
  get currentLocalFileToken(): string | null { return this.localFileToken }

  /** 创建流媒体代理会话 */
  async createProxySession(url: string, headers: Record<string, string>, format: string, preferIpv6?: boolean): Promise<StreamSessionResult | null> {
    if (!window.electronAPI?.createStreamSession) return null
    try {
      const sess = await window.electronAPI.createStreamSession(url, headers, format, preferIpv6)
      if (sess && sess.sessionId) {
        this.proxySessionId = sess.sessionId
        return { sessionId: sess.sessionId, proxyUrl: sess.proxyUrl }
      }
      logger.warn('[SessionManager] createProxySession failed: no sessionId returned')
      return null
    } catch (e) {
      logger.warn('[SessionManager] createProxySession error:', e)
      return null
    }
  }

  /** 创建 FFmpeg 转码会话 */
  async createFfmpegSession(
    url: string,
    headers: Record<string, string>,
    ffmpegPath: string,
    seekTime?: number,
    inputFormat?: string,
  ): Promise<FfmpegSessionResult | null> {
    if (!ffmpegPath || !window.electronAPI?.ffmpegCreateSession) return null
    try {
      const result = await window.electronAPI.ffmpegCreateSession(url, headers, ffmpegPath, seekTime, inputFormat)
      if (result.success && result.sessionId && result.proxyUrl) {
        this.ffmpegSessionId = result.sessionId
        return {
          success: true,
          sessionId: result.sessionId,
          proxyUrl: result.proxyUrl,
          duration: result.duration,
        }
      }
      logger.warn('[SessionManager] ffmpegCreateSession failed:', result.error)
      return { success: false, error: result.error }
    } catch (e) {
      logger.warn('[SessionManager] ffmpegCreateSession error:', e)
      return { success: false, error: String(e) }
    }
  }

  /** 创建 MPV 会话 */
  async createMpvSession(
    url: string,
    headers: Record<string, string>,
    mpvPath: string,
    seekTime?: number,
  ): Promise<MpvSessionResult | null> {
    logger.info(`[SessionManager] createMpvSession: url=${url.substring(0, 120)}, mpvPath=${mpvPath}, seekTime=${seekTime || 0}`)
    if (!mpvPath) {
      logger.warn('[SessionManager] createMpvSession: mpvPath is empty, aborting')
      return null
    }
    if (!window.electronAPI?.mpvCreateSession) {
      logger.warn('[SessionManager] createMpvSession: electronAPI.mpvCreateSession not available (not in Electron?)')
      return null
    }
    try {
      const result = await window.electronAPI.mpvCreateSession(url, headers, mpvPath, seekTime)
      if (result.success && result.sessionId) {
        this.mpvSessionId = result.sessionId
        logger.info(`[SessionManager] createMpvSession: SUCCESS, sessionId=${result.sessionId}`)
        return {
          success: true,
          sessionId: result.sessionId,
        }
      }
      logger.warn(`[SessionManager] createMpvSession: IPC returned failure, error=${result.error || 'unknown'}`)
      return { success: false, error: result.error }
    } catch (e) {
      logger.warn(`[SessionManager] createMpvSession: IPC EXCEPTION: ${e}`)
      return { success: false, error: String(e) }
    }
  }

  /** 创建本地文件 HTTP 服务 */
  async serveLocalFile(filePath: string): Promise<LocalFileResult | null> {
    if (!window.electronAPI?.serveLocalFile) return null
    try {
      const result = await window.electronAPI.serveLocalFile(filePath)
      if (result.success && result.token && result.proxyUrl) {
        this.localFileToken = result.token
        return { success: true, token: result.token, proxyUrl: result.proxyUrl }
      }
      logger.warn('[SessionManager] serveLocalFile failed:', result.error)
      return { success: false, error: result.error }
    } catch (e) {
      logger.warn('[SessionManager] serveLocalFile error:', e)
      return { success: false, error: String(e) }
    }
  }

  /** 关闭所有会话并清理 */
  async closeAll(): Promise<void> {
    await this.closeProxySession()
    await this.closeFfmpegSession()
    await this.closeMpvSession()
    await this.closeVlcSession()
    await this.closeLocalFileServer()
  }

  /** 关闭代理会话 */
  async closeProxySession(): Promise<void> {
    const sid = this.proxySessionId
    this.proxySessionId = null
    if (sid && window.electronAPI) {
      try { await window.electronAPI.closeStreamSession(sid) } catch (_) {}
    }
  }

  /** 关闭 FFmpeg 会话 */
  async closeFfmpegSession(): Promise<void> {
    const fsid = this.ffmpegSessionId
    this.ffmpegSessionId = null
    if (fsid && window.electronAPI) {
      try { await window.electronAPI.ffmpegCloseSession(fsid) } catch (_) {}
    }
  }

  /** 关闭 MPV 会话 */
  async closeMpvSession(): Promise<void> {
    const msid = this.mpvSessionId
    this.mpvSessionId = null
    if (msid && window.electronAPI) {
      logger.info(`[SessionManager] closeMpvSession: closing sessionId=${msid}`)
      try { await window.electronAPI.mpvCloseSession(msid) } catch (e) {
        logger.warn(`[SessionManager] closeMpvSession: error closing ${msid}: ${e}`)
      }
    }
  }

  /** 关闭 VLC 会话 */
  async closeVlcSession(): Promise<void> {
    const vsid = this.vlcSessionId
    this.vlcSessionId = null
    if (vsid && window.electronAPI) {
      logger.info(`[SessionManager] closeVlcSession: closing sessionId=${vsid}`)
      try { await window.electronAPI.vlcCloseSession(vsid) } catch (e) {
        logger.warn(`[SessionManager] closeVlcSession: error closing ${vsid}: ${e}`)
      }
    }
  }

  /** 关闭本地文件服务 */
  async closeLocalFileServer(): Promise<void> {
    const token = this.localFileToken
    this.localFileToken = null
    if (token && window.electronAPI) {
      try { await window.electronAPI.closeLocalFileServer(token) } catch (_) {}
    }
  }

  /** 销毁实例，清理所有资源 */
  destroy(): void {
    this.closeAll().catch(() => {})
  }
}