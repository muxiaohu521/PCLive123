/**
 * video-player — Artplayer 实例创建与销毁
 *
 * createPlayer 组装播放器实例、注册内置引擎插件、绑定统一事件与自定义控件；
 * destroyPlayer 释放实例与全部会话 / 监听器。
 */

import { state } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import Artplayer from 'artplayer'
import { pluginRegistry, registerBuiltinPlugins } from '@/player-plugins'
import { AUDIO_EXTS, getLocalExt } from '@/services/FormatDetector'
import { playbackStreamHub } from '@/services/PlaybackStreamHub'
import { disposeActiveEngine, disposeAudioPlayer, playViaPlugin } from './engine'
import { closeCurrentSession, cleanupFfmpegPatches } from './session'
import { cleanupLocalEndedDetector } from './local-playback'
import { setupMainAudioIsolation, applyMainVolume } from './audio'
import { getSubtitleStyle, updateSubtitleIndicator } from './subtitle-display'
import { addCustomControls } from './controls'
import { closePopup } from './popup'
import {
  clearSourceTimeout,
  clearStallWatchdog,
  reloadForStall,
  reloadStreamWithFreshToken,
  isStallReloadMode,
  startStallWatchdog,
} from './watchdog'
import { clearAutoSafetyTimer, triggerAutoFallback } from './auto-fallback'
import { stopCurrentPlayback, loadUrl } from './loader'

// ── 创建 Artplayer 实例 ──

async function createPlayer(): Promise<void> {
  if (!ctx.playerEl.value) return
  await destroyPlayer()
  Artplayer.CONTROL_HIDE_TIME = 3000

  // 注册内置播放引擎插件（幂等），并输出能力报告，便于定位引擎可用性与路由决策。
  registerBuiltinPlugins()
  const capabilityReport = pluginRegistry.report()
  logger.info(
    `[VideoPlayer] 播放引擎插件体系就绪: ${capabilityReport
      .map((c) => `${c.id}=${c.available ? '可用' : '不可用'}`)
      .join(' ')}`,
  )

  const playerOptions: Record<string, unknown> = {
    container: ctx.playerEl.value as HTMLDivElement,
    autoplay: true,
    autoSize: false,
    autoMini: false,
    loop: false,
    flip: true,
    playbackRate: true,
    aspectRatio: true,
    setting: true,
    hotkey: true,
    pip: true,
    mutex: true,
    backdrop: true,
    fullscreen: true,
    fullscreenWeb: true,
    screenshot: false,
    miniProgressBar: false,
    playsInline: true,
    fastForward: true,
    autoOrientation: true,
    airplay: false,
    theme: '#4fc3f7',
    lang: 'zh-cn',
    subtitle: {
      type: 'vtt',
      style: getSubtitleStyle(),
    },
    moreVideoAttr: {
      preload: 'auto',
      // 注意：用驼峰 crossOrigin（HTMLMediaElement 的 IDL 属性名是 crossOrigin，
      // 全小写 crossorigin 只对 setAttribute 生效、对属性赋值无效）。
      crossOrigin: 'anonymous',
    },
    customType: {
      // 统一路由：所有格式的拉流 / 协议解析均由 pluginRegistry.resolve() 自动选择引擎，
      // 播放器层仅声明「目标格式」与「是否直播流」，不再硬编码任何引擎实现。
      m3u8(video: HTMLVideoElement, url: string) {
        if (!url) return
        logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: HLS → hls.js MSE 解封装`)
        playViaPlugin(video, url, 'm3u8', true)
      },
      mp4(video: HTMLVideoElement, url: string) {
        if (!url) return
        const isAudio = AUDIO_EXTS.has(getLocalExt(url))
        if (isAudio) {
          logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: 音频 → Web Audio 软解 (audio)`)
          playViaPlugin(video, url, 'audio', false)
        } else {
          logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: mp4 → 原生播放 (native)`)
          playViaPlugin(video, url, 'mp4', false)
        }
      },
      flv(video: HTMLVideoElement, url: string) {
        if (!url) return
        logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: FLV → mpegts.js MSE 解封装`)
        playViaPlugin(video, url, 'flv', true)
      },
      ts(video: HTMLVideoElement, url: string) {
        logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: TS → mpegts.js MSE 解封装`)
        playViaPlugin(video, url, 'ts', true)
      },
      dash(video: HTMLVideoElement, url: string) {
        if (!url) return
        logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: DASH → dash.js MSE 解封装`)
        playViaPlugin(video, url, 'dash', false)
      },
      torrent(video: HTMLVideoElement, url: string) {
        if (!url) return
        logger.info(`[VideoPlayer] ${ctx.store.decodeMode}: torrent → WebTorrent 流式播放`)
        playViaPlugin(video, url, 'torrent', false)
      },
    },
  }

  state.art = new Artplayer(playerOptions as any)

  // 主界面音频统一接入 PlaybackStreamHub：唯一一条 createMediaElementSource 分支为
  // 「主界面扬声器增益通路 + 悬浮窗镜像音轨通路」，从源头切断主界面音量/静音对
  // 悬浮窗/投屏/录屏/画中画音频的污染（规避 Chromium 对 captureStream 音轨的截断）。
  playbackStreamHub.attachVideoElement(state.art.video as HTMLVideoElement)
  // 拦截 <video>.volume / <video>.muted：逻辑音量落到 store，原生值恒 1 / false。
  setupMainAudioIsolation(state.art.video as HTMLVideoElement)

  // 主界面音量初始化：Artplayer 创建后立刻应用 store 的音量 / 静音。
  applyMainVolume()

  // 关键：必须在任何 src 加载前把 CORS 授权写到 <video> 上。
  ;(state.art.video as HTMLVideoElement).crossOrigin = 'anonymous'
  ;(state.art.video as HTMLVideoElement).setAttribute('crossorigin', 'anonymous')

  // ── 统一控制栏显示/隐藏逻辑 ──
  {
    const $player = state.art.template.$player as HTMLElement
    const CONTROL_HIDE_DELAY = 3000
    let inBarZone = false
    let hideTimer: ReturnType<typeof setTimeout> | null = null

    const isOverBar = (e: MouseEvent): boolean => {
      const rect = $player.getBoundingClientRect()
      if (rect.height <= 0) return false
      // 控制栏显示区域：底部约 25% 高度，且不超过 110px（覆盖控制条 + 进度条）
      const zoneHeight = Math.min(rect.height * 0.25, 110)
      return rect.bottom - e.clientY <= zoneHeight
    }

    const setBar = (show: boolean) => {
      if (state.art && state.art.controls) state.art.controls.show = show
    }

    const clearHideTimer = () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    }

    const scheduleHide = () => {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        hideTimer = null
        setBar(false)
      }, CONTROL_HIDE_DELAY)
    }

    const syncBar = () => {
      setBar(inBarZone || !!hideTimer)
    }

    const onPlayerMouseMove = (e: MouseEvent) => {
      const inZone = isOverBar(e)
      if (inZone) {
        inBarZone = true
        clearHideTimer()
      } else if (inBarZone) {
        inBarZone = false
        scheduleHide()
      }
      syncBar()
    }

    const onPlayerClick = (e: MouseEvent) => {
      if (isOverBar(e)) {
        inBarZone = true
        clearHideTimer()
      } else {
        inBarZone = false
        clearHideTimer()
      }
      syncBar()
    }

    const onPlayerMouseLeave = () => {
      if (inBarZone) {
        inBarZone = false
        scheduleHide()
      }
      syncBar()
    }

    const onDocMouseOut = (e: MouseEvent) => {
      if (!e.relatedTarget) {
        if (inBarZone) {
          inBarZone = false
          scheduleHide()
        }
        syncBar()
      }
    }

    const onWindowBlur = () => {
      if (inBarZone) {
        inBarZone = false
        scheduleHide()
      }
      syncBar()
    }

    $player.addEventListener('mousemove', onPlayerMouseMove)
    $player.addEventListener('click', onPlayerClick)
    $player.addEventListener('mouseleave', onPlayerMouseLeave)
    document.addEventListener('mouseout', onDocMouseOut)
    window.addEventListener('blur', onWindowBlur)

    state._controlsLeaveCleanup = () => {
      $player.removeEventListener('mousemove', onPlayerMouseMove)
      $player.removeEventListener('click', onPlayerClick)
      $player.removeEventListener('mouseleave', onPlayerMouseLeave)
      document.removeEventListener('mouseout', onDocMouseOut)
      window.removeEventListener('blur', onWindowBlur)
      clearHideTimer()
    }
  }

  if (!ctx.props.url) {
    state.art.loading.show = false
    state.art.on('loading', (loadingState: boolean) => {
      if (loadingState && !ctx.props.url) {
        state.art!.loading.show = false
      }
    })
  }

  addCustomControls()

  state.art.on('ready', () => { clearSourceTimeout(); state.loadRetries = 0; state.loadGenerationId++; state.confirmedFormat = state.currentFormat; updateSubtitleIndicator() })
  // 每次媒体源加载完成都重新发布 <video> 的捕获流（video:loadedmetadata 每次切源都会触发）。
  state.art.on('video:loadedmetadata', () => { playbackStreamHub.publishVideoElement(state.art?.video as HTMLVideoElement | null) })
  state.art.on('play', () => { clearSourceTimeout(); clearStallWatchdog(); clearAutoSafetyTimer(); state.hasEverPlayed = true; ctx.emit('playing') })
  state.art.on('pause', () => { if (!state.art?.playing) ctx.emit('pause') })
  state.art.on('ended', () => {
    if (state._localEndedFired) return
    if (ctx.store.activePlayMode === 'local') { state._localEndedFired = true }
    const video = state.art?.video as HTMLVideoElement | null
    if (video && !state.hasEverPlayed && video.duration < 2 && ctx.store.decodeMode === 'ffmpeg') {
      logger.warn('[VideoPlayer] global ended ignored (FFmpeg premature end, duration < 2s, not yet played)')
      return
    }
    logger.info('[VideoPlayer] art ended')
    ctx.emit('ended')
  })

  state.art.on('error', () => {
    if (state._errorRetryTimer) { clearTimeout(state._errorRetryTimer); state._errorRetryTimer = null }

    if (state.hasEverPlayed && state.lastLoadUrl) {
      const delay = 3000
      logger.warn(`[VideoPlayer] playback error, reconnecting in ${delay}ms`)
      const capturedGenId = state.loadGenerationId
      state._errorRetryTimer = setTimeout(() => {
        state._errorRetryTimer = null
        if (capturedGenId !== state.loadGenerationId) return
        // 播放中断后重连：视频流解析模式优先重新解析获取全新 token。
        void reloadStreamWithFreshToken('playback error (reconnect)')
      }, delay)
      return
    }

    if (ctx.store.decodeMode === 'auto' && !state.hasEverPlayed && state._autoFallbackUrl) {
      logger.warn('[VideoPlayer] auto: error before play, 触发回退链')
      triggerAutoFallback().catch(() => {})
      return
    }

    state.loadRetries++
    if (state.loadRetries <= state.maxLoadRetries && state.lastLoadUrl) {
      const delay = Math.min(500 * Math.pow(2, state.loadRetries - 1), 5000)
      logger.warn(`[VideoPlayer] error, retry ${state.loadRetries}/${state.maxLoadRetries} in ${delay}ms`)
      const retryUrl = state.lastLoadUrl
      const retryHeaders = { ...state.lastLoadHeaders }
      const capturedGenId = state.loadGenerationId
      state._errorRetryTimer = setTimeout(() => {
        state._errorRetryTimer = null
        if (capturedGenId !== state.loadGenerationId) return
        loadUrl(retryUrl, retryHeaders)
      }, delay)
      return
    }

    clearSourceTimeout()
    stopCurrentPlayback()
    ctx.emit('error')
  })

  if (state.art.video) {
    const video = state.art.video as HTMLVideoElement
    const onWaiting = () => {
      if (!isStallReloadMode()) return
      if (state.hasEverPlayed) startStallWatchdog()
    }
    const onPlaying = () => {
      clearStallWatchdog()
      if (!state.hasEverPlayed) {
        state.hasEverPlayed = true
        clearSourceTimeout()
        ctx.emit('playing')
      }
    }
    const onCanplay = () => {
      clearStallWatchdog()
      clearSourceTimeout()
    }
    const onStalled = () => {
      if (!isStallReloadMode()) return
      if (!state.hasEverPlayed) return
      reloadForStall('stalled (buffer exhausted)')
    }
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('canplay', onCanplay)
    video.addEventListener('stalled', onStalled)
    state._videoEventListenersCleanup = () => {
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('canplay', onCanplay)
      video.removeEventListener('stalled', onStalled)
    }
  }

  // 跳转播放同步：用于同步投屏等外部设备。
  state.art.on('video:seeking', () => {
    ctx.emit('seek', state.art?.currentTime ?? 0)
  })
}

// ── 销毁 Artplayer 实例 ──

async function destroyPlayer(): Promise<void> {
  closePopup()
  clearSourceTimeout()
  clearStallWatchdog()
  if (state._errorRetryTimer) { clearTimeout(state._errorRetryTimer); state._errorRetryTimer = null }
  state.loadRetries = 0
  state.loadGenerationId++
  state.hasEverPlayed = false
  state.lastPlayMode = null
  state.controlsAdded = false
  clearAutoSafetyTimer()
  await closeCurrentSession()
  ctx.destroyMirror()
  ctx.destroySubtitle()
  disposeAudioPlayer()
  cleanupLocalEndedDetector()
  cleanupFfmpegPatches()
  if (state._ffmpegStderrCleanup) { state._ffmpegStderrCleanup(); state._ffmpegStderrCleanup = null }
  if (state._mainDebugLogCleanup) { state._mainDebugLogCleanup(); state._mainDebugLogCleanup = null }
  if (state._videoEventListenersCleanup) { state._videoEventListenersCleanup(); state._videoEventListenersCleanup = null }
  if (state._controlsLeaveCleanup) { state._controlsLeaveCleanup(); state._controlsLeaveCleanup = null }
  if (state.art) {
    disposeActiveEngine(state.art.video as HTMLVideoElement)
    state.art.destroy()
    state.art = null
  }
  playbackStreamHub.detachVideoElement()
  playbackStreamHub.publishVideoElement(null)
  state.sourceInfoEl = undefined
  state.lastLoadUrl = ''
  state.lastLoadHeaders = {}
}

export { createPlayer, destroyPlayer }