/**
 * video-player — 会话清理
 *
 * 统一负责 FFmpeg 补丁清理、FFmpeg seek 状态复位、主进程会话（代理 /
 * FFmpeg / MPV / VLC）关闭与网络拦截器注销。
 */

import { state, sessionManager, networkInterceptor } from './state'
import { ctx } from './context'

export function cleanupFfmpegSeek(): void {
  if (state._ffmpegSeekCleanup) {
    state._ffmpegSeekCleanup()
    state._ffmpegSeekCleanup = null
  }
  state._ffmpegSeekOffset = 0
  state._ffmpegUserSeekTarget = 0
  state._ffmpegQueuedSeek = 0
  state._ffmpegOptimisticTarget = 0
  state._ffmpegSuppressNextSeek = false
  if (state._ffmpegSuppressSeekTimer) {
    clearTimeout(state._ffmpegSuppressSeekTimer)
    state._ffmpegSuppressSeekTimer = null
  }
}

export function cleanupFfmpegPatches(): void {
  if (state._ffmpegDurationCleanup) {
    state._ffmpegDurationCleanup()
    state._ffmpegDurationCleanup = null
  }
  if (state._ffmpegCurrentTimeCleanup) {
    state._ffmpegCurrentTimeCleanup()
    state._ffmpegCurrentTimeCleanup = null
  }
  cleanupFfmpegSeek()
}

export async function closeCurrentSession(): Promise<void> {
  if (ctx.store.mpvActive) {
    if (window.electronAPI?.mpvCloseSession) {
      try {
        const session = sessionManager.currentMpvSessionId
        if (session) await window.electronAPI.mpvCloseSession(session)
      } catch (_) {}
    }
    if (window.electronAPI?.vlcCloseSession) {
      try {
        const session = sessionManager.currentVlcSessionId
        if (session) await window.electronAPI.vlcCloseSession(session)
      } catch (_) {}
    }
    ctx.store.closeMpv()
  }
  await sessionManager.closeAll()
  await networkInterceptor.unregister()
  cleanupFfmpegPatches()
}