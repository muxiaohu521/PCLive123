/**
 * video-player — 本地文件播放
 *
 * 本地文件（file://）的格式识别与解码路由：原生硬解 / MSE 容器解封装 /
 * FFmpeg CPU 软解 / 外部解码器（MPV/VLC），以及本地播放的结束检测。
 */

import { state, sessionManager } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import type { MediaFormat } from '@/player-plugins'
import {
  NATIVE_PLAYABLE_EXTS,
  MPEGTS_FLV_EXTS,
  MPEGTS_STREAM_EXTS,
  HLS_EXTS,
  AUDIO_EXTS,
  getLocalExt,
} from '@/services/FormatDetector'
import { disposeActiveEngine, playViaPlugin } from './engine'
import { closeCurrentSession, cleanupFfmpegPatches } from './session'
import { patchVideoDuration, patchVideoCurrentTime, setupFfmpegSeekHandler } from './ffmpeg'
import { ensureHardwareDecodeReady } from './hardware'
import { playLocalMpv, playLocalVlc } from './external-players'

async function toLocalHttpUrl(fileUrl: string): Promise<string | null> {
  if (!fileUrl.startsWith('file://')) return null
  try {
    let filePath = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''))
    if (filePath.startsWith('/') && filePath.length > 2 && filePath.charAt(2) === ':') {
      filePath = filePath.substring(1)
    }
    const result = await sessionManager.serveLocalFile(filePath)
    if (result && result.success && result.proxyUrl) {
      return result.proxyUrl
    }
    logger.warn('[VideoPlayer] serveLocalFile failed:', result?.error)
  } catch (e) {
    logger.warn('[VideoPlayer] serveLocalFile error:', e)
  }
  return null
}

async function playLocalNative(url: string): Promise<void> {
  if (!state.art) return
  const video = state.art.video as HTMLVideoElement
  disposeActiveEngine(video)
  await closeCurrentSession()
  state.currentFormat = 'mp4'

  // 本地文件统一走 HTTP 代理：dev 模式下页面由 http://localhost:5173 加载，
  // webSecurity=true 会拒绝 http 页面直接加载 file:// 资源（报
  // "Not allowed to load local resource"），因此把 file:// 转成 127.0.0.1 的
  // 本地 HTTP 代理 URL。解码仍由 Chromium GPU 硬解完成，完全不影响硬解。
  let playUrl = url
  if (url.startsWith('file://')) {
    const httpUrl = await toLocalHttpUrl(url)
    if (httpUrl) playUrl = httpUrl
  }

  // 不 removeAttribute('src')：直接由 switchUrl 覆盖 src，让 captureStream 走「追加新轨道」路径，
  // 旧轨道由 PlaybackStreamHub.pruneStaleTracks 摘除，避免 load() 破坏音轨导致悬浮窗无声。
  state.art.type = 'mp4'
  state.art.switchUrl(playUrl)
}

async function playLocalSoftware(url: string, genId: number): Promise<void> {
  if (!state.art) return
  const video = state.art.video as HTMLVideoElement
  disposeActiveEngine(video)
  await closeCurrentSession()

  const ext = getLocalExt(url)

  let format: MediaFormat
  if (MPEGTS_FLV_EXTS.has(ext)) {
    logger.info(`[VideoPlayer] local: .${ext} → mpegts-flv`)
    format = 'flv'
  } else if (MPEGTS_STREAM_EXTS.has(ext)) {
    logger.info(`[VideoPlayer] local: .${ext} → mpegts-ts`)
    format = 'ts'
  } else if (HLS_EXTS.has(ext)) {
    logger.info(`[VideoPlayer] local: .${ext} → hls.js`)
    format = 'm3u8'
  } else {
    logger.warn(`[VideoPlayer] local: .${ext} unexpected in playLocalSoftware, no handler`)
    return
  }

  const httpUrl = await toLocalHttpUrl(url)
  if (genId !== state._playLocalFileGen) return
  playViaPlugin(video, httpUrl || url, format, false)
}

async function seekLocalFfmpeg(video: HTMLVideoElement, url: string, genId: number, seekTarget: number, decodeMode?: string): Promise<void> {
  // 不在这里 pause：一旦暂停，播放器立刻显示暂停态，用户看到的就是「点一下先停住」。
  // 旧流继续播它已缓存的内容，直到新流预热完成、src 切换的那一瞬间才换画面。
  const wasPlaying = !video.paused

  const result = await sessionManager.seekFfmpegSession(seekTarget)
  if (genId !== state._playLocalFileGen) return

  if (!result || !result.success || !result.proxyUrl) {
    logger.warn('[VideoPlayer] FFmpeg dynamic seek failed, fallback to full rebuild:', result?.error)
    await playLocalFfmpeg(url, genId, seekTarget, decodeMode)
    return
  }

  // 时间轴偏移保持为用户点击的时间：标签不回跳，内容最多落后一个 GOP，
  // 若改成回传关键帧时间，标签会突然往回跳一截，反而更抖。
  state._ffmpegSeekOffset = seekTarget
  if (state._ffmpegCurrentTimeCleanup) {
    state._ffmpegCurrentTimeCleanup()
    state._ffmpegCurrentTimeCleanup = null
  }
  state._ffmpegCurrentTimeCleanup = patchVideoCurrentTime(video, seekTarget)

  // 切换 src 前清空用户跳转目标，避免重新拉流自身触发的 seeking 被当成新的跳转
  state._ffmpegUserSeekTarget = 0
  state._ffmpegSuppressNextSeek = true
  if (state._ffmpegSuppressSeekTimer) clearTimeout(state._ffmpegSuppressSeekTimer)
  state._ffmpegSuppressSeekTimer = setTimeout(() => {
    state._ffmpegSuppressNextSeek = false
    state._ffmpegSuppressSeekTimer = null
  }, 800)

  // 主进程已完成预热，缓冲区里已有数据，重新拉流即可立即出帧
  const proxyUrl = result.proxyUrl
  const cacheBusted = proxyUrl + (proxyUrl.includes('?') ? '&' : '?') + 'seek=' + Date.now()
  video.src = cacheBusted
  // 新流从 0 开始，此刻 offset 已等于目标时间，撤销乐观显示即可无缝衔接
  state._ffmpegOptimisticTarget = 0
  if (wasPlaying) video.play().catch(() => {})
}

async function playLocalFfmpeg(url: string, genId: number, seekTime?: number, decodeMode?: string): Promise<void> {
  if (!state.art) return
  const video = state.art.video as HTMLVideoElement
  state._ffmpegOptimisticTarget = 0
  disposeActiveEngine(video)

  video.pause()
  video.removeAttribute('src')
  video.load()
  await closeCurrentSession()

  // 内置 FFmpeg 仅供软解（decodeMode='software'）；其余（转封装/auto 回退）使用用户选择的外置 FFmpeg，互斥隔离。
  const ffmpegBin = decodeMode === 'software' ? ctx.store.builtinFfmpegPath : ctx.store.ffmpegPath
  if (!ffmpegBin) {
    logger.warn(`[VideoPlayer] FFmpeg not available: decodeMode=${decodeMode || 'copy'} builtin=${!!ctx.store.builtinFfmpegPath} external=${!!ctx.store.ffmpegPath}`)
    return
  }

  logger.info('[VideoPlayer] FFmpeg creating session for:', url, 'seekTime=', seekTime, 'decodeMode=', decodeMode || 'copy')

  try {
    const result = await sessionManager.createFfmpegSession(url, {}, ffmpegBin, seekTime, undefined, decodeMode)
    if (genId !== state._playLocalFileGen) return
    logger.info('[VideoPlayer] FFmpeg session result:', JSON.stringify({
      success: result?.success,
      sessionId: result?.sessionId,
      proxyUrl: result?.proxyUrl,
      error: result?.error ? String(result.error).substring(0, 300) : undefined,
    }))
    if (result && result.success && result.proxyUrl && state.art) {
      state.currentFormat = 'mp4'
      const effectiveSeek = (typeof seekTime === 'number' && seekTime > 0) ? seekTime : state._ffmpegSeekOffset
      state._ffmpegSeekOffset = effectiveSeek
      if (result.duration && result.duration > 0) {
        logger.info('[VideoPlayer] FFmpeg probed duration:', result.duration.toFixed(1), 's')
        patchVideoDuration(video, result.duration)
      }
      state._ffmpegCurrentTimeCleanup = patchVideoCurrentTime(video, effectiveSeek)
      video.src = result.proxyUrl
      video.play().catch(() => {})
      setupFfmpegSeekHandler(video, url, genId, result.duration || 0, decodeMode)
      return
    }
    logger.warn('[VideoPlayer] FFmpeg local session failed:', result?.error)
  } catch (e) {
    logger.warn('[VideoPlayer] FFmpeg local error:', e)
  }
}

async function playLocalAudio(url: string): Promise<void> {
  if (!state.art) return
  const video = state.art.video as HTMLVideoElement
  await closeCurrentSession()

  const ext = getLocalExt(url)
  logger.info(`[VideoPlayer] AudioPlayer loading: .${ext} from ${url.substring(0, 80)}...`)

  playViaPlugin(video, url, 'audio', false)
}

function cleanupLocalEndedDetector(): void {
  if (state._localEndedDetectorCleanup) {
    state._localEndedDetectorCleanup()
    state._localEndedDetectorCleanup = null
  }
  state._localEndedFired = false
}

function setupLocalEndedDetector(genId: number): void {
  cleanupLocalEndedDetector()
  const video = state.art?.video as HTMLVideoElement | undefined
  if (!video || ctx.store.activePlayMode !== 'local') return

  const onVideoEnded = () => {
    if (genId !== state._playLocalFileGen) return
    if (state._localEndedFired) return
    state._localEndedFired = true
    logger.info('[VideoPlayer] local video ended (direct listener)')
    ctx.emit('ended')
  }
  video.addEventListener('ended', onVideoEnded)

  const onTimeUpdate = () => {
    if (genId !== state._playLocalFileGen) return
    if (state._localEndedFired) return
    const dur = video.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    if (video.paused) return
    if (video.currentTime >= dur - 0.3) {
      state._localEndedFired = true
      logger.info('[VideoPlayer] local video ended (timeupdate fallback), ct=', video.currentTime.toFixed(2), 'dur=', dur.toFixed(2))
      ctx.emit('ended')
    }
  }
  video.addEventListener('timeupdate', onTimeUpdate)

  state._localEndedDetectorCleanup = () => {
    video.removeEventListener('ended', onVideoEnded)
    video.removeEventListener('timeupdate', onTimeUpdate)
  }
}

async function playLocalFile(url: string): Promise<void> {
  const gen = ++state._playLocalFileGen
  if (!state.art) return

  state.lastLoadUrl = url
  cleanupFfmpegPatches()
  state._ffmpegSeeking = false
  state._ffmpegSuppressNextSeek = false

  const ext = getLocalExt(url)
  const mode = ctx.store.decodeMode

  logger.info(`[VideoPlayer] local play: ext=.${ext}, decode=${mode}`)

  const isAudio = AUDIO_EXTS.has(ext)
  const isNativeVideo = NATIVE_PLAYABLE_EXTS.has(ext) && !isAudio
  const isStream = MPEGTS_FLV_EXTS.has(ext) || MPEGTS_STREAM_EXTS.has(ext) || HLS_EXTS.has(ext)

  switch (mode) {
    case 'hardware': {
      await ensureHardwareDecodeReady()
      if (gen !== state._playLocalFileGen) return
      if (isAudio) {
        logger.info(`[VideoPlayer] 硬解: .${ext} → 原生硬解 (音频)`)
        await playLocalNative(url)
      } else if (isNativeVideo) {
        logger.info(`[VideoPlayer] 硬解: .${ext} → 原生硬解 (video 元素)`)
        await playLocalNative(url)
      } else if (isStream) {
        // 本地 m3u8 / ts / flv 需要容器解封装，交给 MSE 管线，解码仍由 GPU 硬件解码器完成
        logger.info(`[VideoPlayer] 硬解: .${ext} → GPU 硬件解码 (本地流)`)
        await playLocalSoftware(url, gen)
        if (gen !== state._playLocalFileGen) return
      } else {
        logger.warn(`[VideoPlayer] 硬解: .${ext} 无法识别，硬解模式禁止软解/FFmpeg 降级`)
      }
      break
    }

    case 'software': {
      if (isAudio) {
        logger.info(`[VideoPlayer] software: .${ext} → CPU 软解 (AudioPlayer)`)
        const httpUrl = await toLocalHttpUrl(url)
        if (gen !== state._playLocalFileGen) return
        await playLocalAudio(httpUrl || url)
        if (gen !== state._playLocalFileGen) return
      } else {
        // 软解 = CPU 通用处理器解码，与容器格式无关：
        // 本地视频（mp4/m3u8/flv/ts 等）全格式统一走 FFmpeg CPU 软解码（libx264）。
        logger.info(`[VideoPlayer] software: .${ext} → CPU 软解 (FFmpeg libx264)`)
        await playLocalFfmpeg(url, gen, undefined, 'software')
        if (gen !== state._playLocalFileGen) return
      }
      break
    }

    case 'ffmpeg': {
      logger.info(`[VideoPlayer] ffmpeg: .${ext} → FFmpeg`)
      await playLocalFfmpeg(url, gen)
      if (gen !== state._playLocalFileGen) return
      break
    }

    case 'mpv': {
      logger.info(`[VideoPlayer] mpv: .${ext} → MPV`)
      await playLocalMpv(url, gen)
      if (gen !== state._playLocalFileGen) return
      break
    }

    case 'vlc': {
      logger.info(`[VideoPlayer] vlc: .${ext} → VLC`)
      await playLocalVlc(url, gen)
      if (gen !== state._playLocalFileGen) return
      break
    }

    default: {
      // auto: 硬解 → 软解 → 外部解码器(MPV/VLC/FFmpeg)

      state._autoFallbackUrl = url
      state._autoFallbackHeaders = {}
      state._autoFallbackGenId = gen

      if (isAudio) {
        // 音频无 GPU 专用解码电路，统一 CPU 软解
        logger.info(`[VideoPlayer] auto: .${ext} → CPU 软解 (AudioPlayer)`)
        const httpUrl = await toLocalHttpUrl(url)
        if (gen !== state._playLocalFileGen) break
        await playLocalAudio(httpUrl || url)
      } else if (isNativeVideo) {
        logger.info(`[VideoPlayer] auto: .${ext} → GPU 硬解 (原生 video)`)
        await playLocalNative(url)
      } else if (isStream) {
        // 硬解：hls.js/mpegts.js 仅负责容器解封装，真正的解码由 GPU 专用解码电路完成
        logger.info(`[VideoPlayer] auto: .${ext} → GPU 硬解 (MSE 解封装)`)
        await playLocalSoftware(url, gen)
      } else {
        logger.info(`[VideoPlayer] auto: .${ext} → 外部解码链 (格式无法识别)`)
        if (ctx.store.mpvPath) {
          await playLocalMpv(url, gen)
          if (gen !== state._playLocalFileGen) break
          if (state.hasEverPlayed) break
        }
        if (ctx.store.vlcPath) {
          await playLocalVlc(url, gen)
          if (gen !== state._playLocalFileGen) break
          if (state.hasEverPlayed) break
        }
        if (ctx.store.ffmpegPath) {
          await playLocalFfmpeg(url, gen)
        }
      }
      break
    }
  }

  setupLocalEndedDetector(gen)
}

export {
  toLocalHttpUrl,
  playLocalNative,
  playLocalSoftware,
  seekLocalFfmpeg,
  playLocalFfmpeg,
  playLocalAudio,
  playLocalFile,
  setupLocalEndedDetector,
  cleanupLocalEndedDetector,
}