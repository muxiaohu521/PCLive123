/**
 * video-player — 统一自动回退链（硬解 → 软解 → MPV → VLC → FFmpeg）
 *
 * 硬解 HLS fatal / art error / 安全兜底等多条回调可能并发触发回退链，
 * 因此以 _autoFallbackRunning 去重，避免同时创建多个 FFmpeg 会话。
 */

import { state, sessionManager, AUTO_SAFETY_TIMEOUT_MS } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import { clearSourceTimeout } from './watchdog'
import { disposeActiveEngine, disposeAudioPlayer } from './engine'
import { playLocalFfmpeg } from './local-playback'
import { startMpv, startVlc, playLocalMpv, playLocalVlc } from './external-players'

function clearAutoSafetyTimer(): void {
  if (state._autoSafetyTimer !== null) {
    clearTimeout(state._autoSafetyTimer)
    state._autoSafetyTimer = null
  }
}

// 硬解 HLS fatal / art error / 安全兜底等多条回调可能并发触发回退链，
// 若不加去重会同时创建多个 FFmpeg 会话，对同一 CDN 造成多余连接（触发 403 限流）。
async function triggerAutoFallback(): Promise<boolean> {
  if (state._autoFallbackRunning) return state._autoFallbackRunning
  state._autoFallbackRunning = doTriggerAutoFallback()
  try {
    return await state._autoFallbackRunning
  } finally {
    state._autoFallbackRunning = null
  }
}

async function doTriggerAutoFallback(): Promise<boolean> {
  const url = state._autoFallbackUrl
  const headers = state._autoFallbackHeaders
  const genId = state._autoFallbackGenId
  if (!url || !headers) return false
  // 本地文件与在线流各自维护独立的加载代次计数器，须按当前播放来源校验。
  const isLocal = ctx.store.activePlayMode === 'local'
  const currentGen = isLocal ? state._playLocalFileGen : state.loadGenerationId
  if (genId !== currentGen) return false

  clearAutoSafetyTimer()
  clearSourceTimeout()

  const video = state.art?.video as HTMLVideoElement | undefined
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
    disposeActiveEngine(video)
  }
  disposeAudioPlayer()

  // Step 2: 软解（CPU 通用解码）—— 硬解失败后优先回退软解
  logger.info('[VideoPlayer] auto: 硬解失败 → 软解 (FFmpeg CPU libx264)')
  const softOk = await playViaFfmpegSoftware(url, headers, genId, currentGen, state.currentFormat)
  if (softOk) return true
  if (genId !== currentGen) return false

  // Step 3: 外部解码器（MPV → VLC → FFmpeg 转封装）
  if (isLocal) {
    // 本地文件外部解码链：复用本地专用入口（URL 保留原始 file://，各播放器自行处理）
    logger.info('[VideoPlayer] auto: 本地软解失败 → 回退链 MPV→VLC→FFmpeg')
    if (ctx.store.mpvPath) {
      await playLocalMpv(url, genId)
      if (genId !== currentGen) return false
      if (state.hasEverPlayed) return true
    }
    if (ctx.store.vlcPath) {
      await playLocalVlc(url, genId)
      if (genId !== currentGen) return false
      if (state.hasEverPlayed) return true
    }
    if (ctx.store.ffmpegPath) {
      await playLocalFfmpeg(url, genId)
    }
    return state.hasEverPlayed
  }

  logger.info('[VideoPlayer] auto: 软解失败 → 回退链 MPV→VLC→FFmpeg')

  if (ctx.store.mpvPath) {
    const ok = await startMpv(url, headers, ctx.store.mpvPath, genId, state.loadGenerationId, true)
    if (ok) return true
    if (genId !== state.loadGenerationId) return false
  }

  if (ctx.store.vlcPath) {
    const ok = await startVlc(url, headers, ctx.store.vlcPath, genId, state.loadGenerationId, true)
    if (ok) return true
    if (genId !== state.loadGenerationId) return false
  }

  if (ctx.store.ffmpegPath) {
    logger.info('[VideoPlayer] auto: → FFmpeg 回退')
    try {
      const result = await sessionManager.createFfmpegSession(url, headers, ctx.store.ffmpegPath)
      if (genId !== state.loadGenerationId) return false
      if (result && result.success && result.proxyUrl && state.art) {
        state.currentFormat = 'mp4'
        const vid = state.art.video as HTMLVideoElement
        vid.src = result.proxyUrl
        vid.play().catch(() => {})
        state.hasEverPlayed = true
        return true
      }
    } catch (e) {
      logger.warn('[VideoPlayer] auto: FFmpeg 回退失败:', e)
    }
  }
  return false
}

/**
 * 软解模式专用：全格式统一走 FFmpeg CPU 软解码（libx264）。
 * 软解的本质是「CPU 通用处理器解码」，与容器格式（mp4/m3u8/flv/ts）无关，
 * 因此不再按格式分支，统一交给 FFmpeg 软解码后重编码为 H.264 供 video 元素播放。
 */
async function playViaFfmpegSoftware(
  url: string,
  headers: Record<string, string>,
  genId: number,
  loadGenId: number,
  format?: string
): Promise<boolean> {
  if (!state.art) return false
  if (!ctx.store.builtinFfmpegPath) {
    logger.warn('[VideoPlayer] software: 内置 FFmpeg 不可用，无法 CPU 软解')
    return false
  }

  const video = state.art.video as HTMLVideoElement
  video.pause()
  video.removeAttribute('src')
  video.load()
  disposeActiveEngine(video)
  // 不在此处 closeCurrentSession：软解 FFmpeg 需读取本地代理会话（proxyUrl）作为输入，
  // 关闭代理会话会导致 FFmpeg 拉流 404。上一播放源的会话已在 loadUrl 入口统一清理。

  logger.info('[VideoPlayer] software: 内置 FFmpeg CPU 软解开始, url=' + url.substring(0, 120))

  try {
    // 必须把真实容器格式传给主进程：本地代理地址（/session/xxx/stream）没有扩展名，
    // 主进程只能靠这个格式判定是否为 HLS，从而避免对 m3u8 播放列表误加 -reconnect_streamed。
    const result = await sessionManager.createFfmpegSession(url, headers, ctx.store.builtinFfmpegPath, undefined, format, 'software')
    if (genId !== loadGenId) return false
    if (result && result.success && result.proxyUrl && state.art) {
      state.currentFormat = 'mp4'
      const vid = state.art.video as HTMLVideoElement
      vid.src = result.proxyUrl
      vid.play().catch(() => {})
      state.hasEverPlayed = true
      return true
    }
    logger.warn('[VideoPlayer] software: FFmpeg CPU 软解失败:', result?.error)
  } catch (e) {
    logger.warn('[VideoPlayer] software: FFmpeg CPU 软解异常:', e)
  }
  return false
}

function startAutoSafetyTimer(): void {
  clearAutoSafetyTimer()
  state._autoSafetyTimer = setTimeout(async () => {
    state._autoSafetyTimer = null
    if (state.hasEverPlayed) return
    logger.warn('[VideoPlayer] auto: 安全超时 (' + AUTO_SAFETY_TIMEOUT_MS + 'ms), 触发回退链')
    await triggerAutoFallback()
  }, AUTO_SAFETY_TIMEOUT_MS)
}

export { clearAutoSafetyTimer, triggerAutoFallback, doTriggerAutoFallback, playViaFfmpegSoftware, startAutoSafetyTimer }