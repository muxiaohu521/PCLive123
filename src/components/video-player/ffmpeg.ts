/**
 * video-player — FFmpeg 补丁
 *
 * FFmpeg 转码流没有可靠的 duration / currentTime 语义，这里通过属性补丁、
 * seek 重启调度与流回退，让软解 / FFmpeg 模式的时间轴行为与原生播放一致。
 */

import { state, sessionManager } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import { isRedirectGateway } from '@/services/FormatDetector'
import { computePreferIpv6 } from './context'
import { cleanupFfmpegSeek } from './session'
import { clearSourceTimeout } from './watchdog'
import { seekLocalFfmpeg } from './local-playback'

function patchVideoDuration(video: HTMLVideoElement, realDuration: number): void {
  if (state._ffmpegDurationCleanup) {
    state._ffmpegDurationCleanup()
    state._ffmpegDurationCleanup = null
  }

  let proto: any = video
  let origDurationDesc: PropertyDescriptor | undefined
  while (proto && !origDurationDesc) {
    origDurationDesc = Object.getOwnPropertyDescriptor(proto, 'duration')
    proto = Object.getPrototypeOf(proto)
  }
  let active = true
  const apply = () => {
    if (!active || !video || realDuration <= 0) return
    try {
      Object.defineProperty(video, 'duration', {
        get() { return realDuration },
        configurable: true,
      })
    } catch (_) {
      logger.warn('[VideoPlayer] Object.defineProperty on video.duration failed')
    }
  }

  apply()

  const onDurationChange = () => {
    if (!active) return
    if (Math.abs(video.duration - realDuration) > 0.5 && realDuration > 0) {
      apply()
    }
  }
  const onLoadedMeta = () => {
    if (!active) return
    setTimeout(apply, 50)
  }

  video.addEventListener('durationchange', onDurationChange)
  video.addEventListener('loadedmetadata', onLoadedMeta)

  state._ffmpegDurationCleanup = () => {
    active = false
    video.removeEventListener('durationchange', onDurationChange)
    video.removeEventListener('loadedmetadata', onLoadedMeta)
    if (origDurationDesc && origDurationDesc.configurable) {
      try {
        Object.defineProperty(video, 'duration', {
          get: origDurationDesc.get,
          set: origDurationDesc.set,
          configurable: true,
          enumerable: origDurationDesc.enumerable,
        })
        return
      } catch (_) {}
    }
    try { delete (video as any).duration } catch (_) {}
  }
}

function patchVideoCurrentTime(video: HTMLVideoElement, offset: number): (() => void) | null {
  let proto: any = video
  let origDesc: PropertyDescriptor | undefined
  while (proto && !origDesc) {
    origDesc = Object.getOwnPropertyDescriptor(proto, 'currentTime')
    proto = Object.getPrototypeOf(proto)
  }
  if (!origDesc || !origDesc.get || !origDesc.set) {
    logger.warn('[VideoPlayer] Cannot patch video.currentTime (no accessor in prototype chain)')
    return null
  }
  const origGet = origDesc.get.bind(video)
  const origSet = origDesc.set.bind(video)
  let active = true

  Object.defineProperty(video, 'currentTime', {
    get() {
      if (!active) return origGet()
      if (state._ffmpegOptimisticTarget > 0) return state._ffmpegOptimisticTarget
      return origGet() + offset
    },
    set(v: number) {
      if (!active) { origSet(v); return }
      const raw = Math.max(0, v - offset)
      // 只有落在已缓存区间内的跳转才能交给浏览器原生完成（瞬时、无重启、无抖动）。
      // 超出缓存的跳转浏览器取不到数据（服务端不支持 Range），
      // 硬设 currentTime 会让播放管线卡死在 seeking 状态，等到重启才恢复，
      // 这就是「点击后画面冻一下再跳」的根源。
      let bufferedHit = false
      try {
        const b = video.buffered
        for (let i = 0; i < b.length; i++) {
          if (raw >= b.start(i) && raw < b.end(i) - 0.5) { bufferedHit = true; break }
        }
      } catch (_) {}
      if (bufferedHit) {
        state._ffmpegOptimisticTarget = 0
        origSet(raw)
        state._ffmpegUserSeekTarget = 0
        return
      }
      if (state._ffmpegRestartScheduler) {
        state._ffmpegUserSeekTarget = v
        state._ffmpegRestartScheduler(v)
        return
      }
      state._ffmpegUserSeekTarget = v
      origSet(raw)
    },
    configurable: true,
  })

  return () => {
    active = false
    if (origDesc.configurable) {
      try {
        Object.defineProperty(video, 'currentTime', {
          get: origDesc.get!,
          set: origDesc.set!,
          configurable: true,
          enumerable: origDesc.enumerable,
        })
        return
      } catch (_) {}
    }
    try { delete (video as any).currentTime } catch (_) {}
  }
}

function setupFfmpegSeekHandler(video: HTMLVideoElement, url: string, genId: number, totalDuration: number, decodeMode?: string): void {
  cleanupFfmpegSeek()

  let seekDebounce: ReturnType<typeof setTimeout> | null = null
  let pendingSeekTime = 0

  // 统一的「重启 FFmpeg」调度入口：currentTime setter（用户点击时间线）与 seeking 事件
  // 都走这里，合并短时间内的多次点击，只重启一次。
  const scheduleRestart = (targetTime: number) => {
    if (targetTime <= 0.5) return
    if (totalDuration > 0 && targetTime >= totalDuration - 1) return
    // 与当前时间轴偏移几乎一致，说明只是重新拉流时恢复显示位置，并非真实跳转
    if (Math.abs(targetTime - state._ffmpegSeekOffset) < 1.0) return

    // 先把时间轴显示挪到用户点击的位置，重启期间画面/进度条不回跳
    state._ffmpegOptimisticTarget = targetTime

    // 重启进行中又来了新的点击：记下来，等这次重启完成后再跟上，
    // 否则快速拖动时后续点击会被丢掉，表现为「点了没反应」。
    if (state._ffmpegSeeking) { state._ffmpegQueuedSeek = targetTime; return }

    pendingSeekTime = targetTime
    if (seekDebounce) clearTimeout(seekDebounce)
    seekDebounce = setTimeout(async () => {
      seekDebounce = null
      if (genId !== state._playLocalFileGen) return
      state._ffmpegSeeking = true
      state._ffmpegUserSeekTarget = 0
      const seekTarget = pendingSeekTime
      logger.info('[VideoPlayer] FFmpeg seek to:', seekTarget.toFixed(1), 's (target from user)')
      await seekLocalFfmpeg(video, url, genId, seekTarget, decodeMode)
      state._ffmpegSeeking = false

      // 重启期间堆积的最后一次点击，紧接着补上
      if (state._ffmpegQueuedSeek > 0) {
        const queued = state._ffmpegQueuedSeek
        state._ffmpegQueuedSeek = 0
        scheduleRestart(queued)
        return
      }

      state._ffmpegSuppressNextSeek = true
      if (state._ffmpegSuppressSeekTimer) clearTimeout(state._ffmpegSuppressSeekTimer)
      state._ffmpegSuppressSeekTimer = setTimeout(() => {
        state._ffmpegSuppressNextSeek = false
        state._ffmpegSuppressSeekTimer = null
      }, 500)
    }, 150)
  }

  state._ffmpegRestartScheduler = scheduleRestart

  const onSeeking = () => {
    if (state._ffmpegSeeking) return
    // 兜底路径：若 currentTime 补丁未生效，仍靠 seeking 事件识别用户跳转。
    // video.src 重新赋值、浏览器重新拉流都会触发 seeking，
    // 若把这类事件也当成跳转，就会形成「重启 → 再次重启」的循环抖动。
    if (state._ffmpegUserSeekTarget <= 0) {
      if (state._ffmpegSuppressNextSeek) {
        logger.info('[VideoPlayer] FFmpeg seeking ignored (post-rebuild init, not user-initiated)')
      }
      return
    }

    const targetTime = state._ffmpegUserSeekTarget
    state._ffmpegUserSeekTarget = 0
    // 目标点若已落在浏览器已缓存的区间内，浏览器自身就能瞬时完成跳转，
    // 完全不需要重启 FFmpeg（重启才是画面冻结/抖动的唯一来源）。
    const rawTarget = targetTime - state._ffmpegSeekOffset
    if (rawTarget >= 0) {
      for (let i = 0; i < video.buffered.length; i++) {
        if (rawTarget >= video.buffered.start(i) && rawTarget < video.buffered.end(i) - 0.5) {
          logger.info('[VideoPlayer] FFmpeg seek served by browser buffer, no restart:', rawTarget.toFixed(1), 's')
          return
        }
      }
    }

    scheduleRestart(targetTime)
  }

  video.addEventListener('seeking', onSeeking)
  state._ffmpegSeekCleanup = () => {
    video.removeEventListener('seeking', onSeeking)
    if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null }
    if (state._ffmpegRestartScheduler === scheduleRestart) state._ffmpegRestartScheduler = null
  }
}

async function tryFfmpegStreamFallback(video: HTMLVideoElement, url: string): Promise<void> {
  const capturedGenId = state.loadGenerationId
  const capturedHeaders = { ...state.lastLoadHeaders }

  if (ctx.store.decodeMode !== 'auto') {
    logger.warn(`[VideoPlayer] tryFfmpegStreamFallback: ${ctx.store.decodeMode} 模式禁止跨模式回退`)
    return
  }

  if (!ctx.store.ffmpegPath) {
    logger.warn('[VideoPlayer] auto: 回退 FFmpeg 失败, ffmpegPath 未设置')
    return
  }
  logger.info(`[VideoPlayer] auto: 回退 FFmpeg for ${url.substring(0, 120)}`)
  clearSourceTimeout()

  // 网关 URL 走代理 — FFmpeg 直连 CDN 会因 Referer/Cookie 被拒 403
  let ffmpegSourceUrl = url
  const isGateway = isRedirectGateway(url)
  if (isGateway) {
    const sess = await sessionManager.createProxySession(url, capturedHeaders, 'unknown', await computePreferIpv6(url))
    if (capturedGenId !== state.loadGenerationId) return
    if (sess && sess.proxyUrl) {
      ffmpegSourceUrl = sess.proxyUrl
      logger.info(`[VideoPlayer] auto FFmpeg fallback: gateway via proxy ${ffmpegSourceUrl}`)
    }
  }

  try {
    const result = await sessionManager.createFfmpegSession(ffmpegSourceUrl, capturedHeaders, ctx.store.ffmpegPath)
    if (capturedGenId !== state.loadGenerationId) return
    if (result && result.success && result.proxyUrl) {
      state.currentFormat = 'mp4'
      logger.info(`[VideoPlayer] auto: FFmpeg fallback session created, proxyUrl=${result.proxyUrl}, duration=${result.duration}`)
      video.src = result.proxyUrl

      // ── 视频事件诊断 ──
      const diagGenId2 = capturedGenId
      const onDiagProgress = () => {
        if (diagGenId2 !== state.loadGenerationId) return
        const buffered = video.buffered
        const lastEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0
        logger.info(`[VideoPlayer] auto FFmpeg: buffered up to ${lastEnd > 0 ? lastEnd.toFixed(1) : '0'}s, readyState=${video.readyState}`)
      }
      const onDiagStalled = () => {
        if (diagGenId2 !== state.loadGenerationId) return
        logger.warn(`[VideoPlayer] auto FFmpeg: STALLED, readyState=${video.readyState}, ct=${video.currentTime.toFixed(2)}`)
      }
      const onDiagSuspend = () => {
        if (diagGenId2 !== state.loadGenerationId) return
        logger.info(`[VideoPlayer] auto FFmpeg: SUSPEND, readyState=${video.readyState}`)
      }
      const onDiagEnded = () => {
        if (diagGenId2 !== state.loadGenerationId) return
        logger.warn(`[VideoPlayer] auto FFmpeg: ENDED unexpectedly, ct=${video.currentTime.toFixed(2)}, dur=${video.duration}`)
        if (!state.hasEverPlayed && video.duration < 1 && video.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
          logger.warn('[VideoPlayer] auto FFmpeg: premature ENDED, retrying play() after 300ms')
          setTimeout(() => {
            if (diagGenId2 === state.loadGenerationId && video.src === result.proxyUrl) {
              video.play().then(() => {
                logger.info('[VideoPlayer] auto FFmpeg: play() retry after premature ENDED succeeded')
                state.hasEverPlayed = true
              }).catch(() => {})
            }
          }, 300)
        }
      }
      let _ffmpegDiagLastTime2 = -999
      const onDiagTimeUpdate = () => {
        if (diagGenId2 !== state.loadGenerationId) return
        if (Math.abs(video.currentTime - _ffmpegDiagLastTime2) > 1) {
          _ffmpegDiagLastTime2 = video.currentTime
          logger.info(`[VideoPlayer] auto FFmpeg: timeupdate → ct=${video.currentTime.toFixed(2)}s`)
        }
      }
      video.addEventListener('progress', onDiagProgress)
      video.addEventListener('stalled', onDiagStalled)
      video.addEventListener('suspend', onDiagSuspend)
      video.addEventListener('ended', onDiagEnded)
      video.addEventListener('timeupdate', onDiagTimeUpdate)
      const removeDiagListeners2 = () => {
        video.removeEventListener('progress', onDiagProgress)
        video.removeEventListener('stalled', onDiagStalled)
        video.removeEventListener('suspend', onDiagSuspend)
        video.removeEventListener('ended', onDiagEnded)
        video.removeEventListener('timeupdate', onDiagTimeUpdate)
      }
      setTimeout(() => removeDiagListeners2(), 120_000)
      // ── 诊断结束 ──

      const doPlay = () => {
        video.play().then(() => {
          logger.info('[VideoPlayer] auto: FFmpeg fallback play() succeeded')
        }).catch((e: Error) => {
          logger.warn(`[VideoPlayer] auto: FFmpeg fallback play() rejected (${e.name}: ${e.message}), retrying after 500ms...`)
          setTimeout(() => {
            if (capturedGenId === state.loadGenerationId && video.src === result.proxyUrl) {
              video.play().then(() => {
                logger.info('[VideoPlayer] auto: FFmpeg fallback play() succeeded on retry')
              }).catch((e2: Error) => {
                logger.warn(`[VideoPlayer] auto: FFmpeg fallback play() still rejected on retry: ${e2.name}: ${e2.message}`)
              })
            }
          }, 500)
        })
      }
      if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        doPlay()
      } else {
        video.addEventListener('canplay', doPlay, { once: true })
        video.addEventListener('loadeddata', () => {
          if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            video.removeEventListener('canplay', doPlay)
            doPlay()
          }
        }, { once: true })
      }
    } else {
      logger.warn('[VideoPlayer] auto: FFmpeg 回退失败:', result?.error)
    }
  } catch (e) {
    if (capturedGenId !== state.loadGenerationId) return
    logger.warn('[VideoPlayer] auto: FFmpeg 回退出错:', e)
  }
}

export { patchVideoDuration, patchVideoCurrentTime, setupFfmpegSeekHandler, tryFfmpegStreamFallback }