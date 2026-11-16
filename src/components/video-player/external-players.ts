/**
 * video-player — MPV / VLC 弹窗播放
 *
 * 主进程直接 spawn MPV / VLC 进程，以独立弹窗播放；返回是否启动成功。
 */

import { state, sessionManager } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import { disposeActiveEngine } from './engine'
import { closeCurrentSession } from './session'

/**
 * 启动 MPV 弹窗播放——主进程直接 spawn MPV 进程。
 * @returns true 表示播放已启动，false 表示失败
 */
async function startMpv(
  url: string,
  headers: Record<string, string>,
  mpvPath: string,
  genId: number,
  loadGenId: number,
  isAutoFallback = false
): Promise<boolean> {
  logger.info(`[VideoPlayer] startMpv: url=${url.substring(0, 120)}, mpvPath=${mpvPath}, autoFallback=${isAutoFallback}`)
  if (!window.electronAPI?.mpvCreateSession) {
    logger.warn('[VideoPlayer] startMpv: electronAPI.mpvCreateSession not available')
    return false
  }
  try {
    const result = await window.electronAPI.mpvCreateSession(url, headers, mpvPath)
    if (genId !== loadGenId) {
      logger.warn('[VideoPlayer] startMpv: genId mismatch, discarding')
      return false
    }
    if (!result?.success || !result.sessionId) {
      logger.warn(`[VideoPlayer] startMpv: FAILED, error=${result?.error || 'unknown'}`)
      return false
    }
    logger.info(`[VideoPlayer] startMpv: SUCCESS, sessionId=${result.sessionId}, MPV popup window spawned`)
    sessionManager.setMpvSessionId(result.sessionId)
    ctx.store.openMpv()
    state.hasEverPlayed = true
    ctx.store.playing = true
    ctx.store.videoPaused = false
    ctx.emit('playing')
    return true
  } catch (e) {
    logger.warn(`[VideoPlayer] startMpv: EXCEPTION: ${e}`)
    return false
  }
}

/**
 * 启动 VLC 弹窗播放（独立窗口）
 */
async function startVlc(
  url: string,
  headers: Record<string, string>,
  vlcPath: string,
  genId: number,
  loadGenId: number,
  isAutoFallback = false
): Promise<boolean> {
  logger.info(`[VideoPlayer] startVlc: url=${url.substring(0, 120)}, vlcPath=${vlcPath}, autoFallback=${isAutoFallback}`)
  if (!window.electronAPI?.vlcCreateSession) {
    logger.warn('[VideoPlayer] startVlc: electronAPI.vlcCreateSession not available')
    return false
  }
  try {
    const result = await window.electronAPI.vlcCreateSession(url, headers, vlcPath)
    if (genId !== loadGenId) {
      logger.warn('[VideoPlayer] startVlc: genId mismatch, discarding')
      return false
    }
    if (!result?.success || !result.sessionId) {
      logger.warn(`[VideoPlayer] startVlc: FAILED, error=${result?.error || 'unknown'}`)
      return false
    }
    logger.info(`[VideoPlayer] startVlc: SUCCESS, sessionId=${result.sessionId}, VLC popup window spawned`)
    sessionManager.setVlcSessionId(result.sessionId)
    ctx.store.openMpv()
    state.hasEverPlayed = true
    ctx.store.playing = true
    ctx.store.videoPaused = false
    ctx.emit('playing')
    return true
  } catch (e) {
    logger.warn(`[VideoPlayer] startVlc: EXCEPTION: ${e}`)
    return false
  }
}

async function playLocalMpv(url: string, genId: number): Promise<void> {
  if (!state.art) {
    logger.warn('[VideoPlayer] playLocalMpv: art is null, aborting')
    return
  }
  logger.info(`[VideoPlayer] playLocalMpv: entering, url=${url.substring(0, 120)}, genId=${genId}`)

  const video = state.art.video as HTMLVideoElement
  disposeActiveEngine(video)
  video.pause()
  video.removeAttribute('src')
  video.load()
  await closeCurrentSession()

  if (!ctx.store.mpvPath) {
    logger.warn('[VideoPlayer] playLocalMpv: mpvPath is EMPTY, cannot start MPV')
    return
  }

  logger.info(`[VideoPlayer] playLocalMpv: launching MPV, path=${ctx.store.mpvPath}, url=${url.substring(0, 120)}`)

  try {
    await startMpv(url, {}, ctx.store.mpvPath, genId, genId)
  } catch (e) {
    logger.warn(`[VideoPlayer] playLocalMpv: EXCEPTION: ${e}`)
  }
}

async function playLocalVlc(url: string, genId: number): Promise<void> {
  if (!state.art) {
    logger.warn('[VideoPlayer] playLocalVlc: art is null, aborting')
    return
  }
  logger.info(`[VideoPlayer] playLocalVlc: entering, url=${url.substring(0, 120)}, genId=${genId}`)

  const video = state.art.video as HTMLVideoElement
  disposeActiveEngine(video)
  video.pause()
  video.removeAttribute('src')
  video.load()
  await closeCurrentSession()

  if (!ctx.store.vlcPath) {
    logger.warn('[VideoPlayer] playLocalVlc: vlcPath is EMPTY, cannot start VLC')
    return
  }

  logger.info(`[VideoPlayer] playLocalVlc: launching VLC, path=${ctx.store.vlcPath}, url=${url.substring(0, 120)}`)

  try {
    await startVlc(url, {}, ctx.store.vlcPath, genId, genId)
  } catch (e) {
    logger.warn(`[VideoPlayer] playLocalVlc: EXCEPTION: ${e}`)
  }
}

export { startMpv, startVlc, playLocalMpv, playLocalVlc }