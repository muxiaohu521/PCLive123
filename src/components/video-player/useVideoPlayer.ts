/**
 * video-player — 主入口 composable
 *
 * 组装拆分后的各功能模块：初始化组件上下文（props / emit / store / playerEl /
 * 字幕 / 悬浮窗），注册 FFmpeg 日志与悬浮窗控制回调，绑定生命周期与全部 watch，
 * 最终向薄壳组件暴露播放控制接口。
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '@/store'
import { useSubtitle } from '@/composables/useSubtitle'
import { useMirrorStream } from '@/composables/useMirrorStream'
import { logger } from '@/utils/logger'
import type { VideoPlayerProps, VideoPlayerEmits } from './types'
import { ctx } from './context'
import { state } from './state'
import { createPlayer, destroyPlayer } from './player'
import { loadUrl } from './loader'
import { closeCurrentSession, cleanupFfmpegPatches } from './session'
import { disposeActiveEngine } from './engine'
import { cleanupLocalEndedDetector, playLocalFile } from './local-playback'
import { clearSourceTimeout, clearStallWatchdog } from './watchdog'
import { clearAutoSafetyTimer } from './auto-fallback'
import { updateControlLabels, updateDecodeButton, updateSourceLabel } from './controls'
import { applyMainVolume } from './audio'
import { applySubtitleStyle, updateSubtitleIndicator } from './subtitle-display'

export interface VideoPlayerInstance {
  playerEl: ReturnType<typeof ref<HTMLElement | null>>
  expose: {
    play: () => void
    pause: () => void
    toggle: () => void
    getCurrentTime: () => number
    getVideo: () => HTMLVideoElement | null
    playLocalFile: (url: string) => Promise<void>
  }
}

export function useVideoPlayer(props: VideoPlayerProps, emit: VideoPlayerEmits): VideoPlayerInstance {
  const playerEl = ref<HTMLElement | null>(null)
  const store = useAppStore()

  const {
    subtitleEnabled,
    subtitleVttUrl,
    toggleSubtitle,
    destroy: destroySubtitle,
  } = useSubtitle()

  const {
    openFloatWindow,
    closeFloatWindow,
    setControlHandler,
    destroy: destroyMirror,
  } = useMirrorStream()

  const isExternalPlay = computed(() => store.activePlayMode === 'sniffer')

  // ── 填充组件上下文（各功能模块统一通过 ctx 访问这些 setup 作用域依赖） ──
  ctx.props = props
  ctx.emit = emit
  ctx.store = store
  ctx.playerEl = playerEl
  ctx.isExternalPlay = isExternalPlay
  ctx.subtitleEnabled = subtitleEnabled
  ctx.subtitleVttUrl = subtitleVttUrl
  ctx.toggleSubtitle = toggleSubtitle
  ctx.destroySubtitle = destroySubtitle
  ctx.openFloatWindow = openFloatWindow
  ctx.closeFloatWindow = closeFloatWindow
  ctx.setControlHandler = setControlHandler
  ctx.destroyMirror = destroyMirror

  // ── FFmpeg stderr / 主进程调试日志转发 ──
  if (window.electronAPI?.onFfmpegStderr) {
    state._ffmpegStderrCleanup = window.electronAPI.onFfmpegStderr((data) => {
      logger.warn(`[FFmpeg stderr] ${data.line}`)
    })
  }
  if (window.electronAPI?.onMainDebugLog) {
    state._mainDebugLogCleanup = window.electronAPI.onMainDebugLog((line) => {
      logger.info(line)
    })
  }

  // ── 生命周期 ──
  onMounted(async () => {
    await createPlayer()
    // createPlayer 内部会先执行 destroyPlayer → destroyMirror，把 controlHandler 置空，
    // 因此必须在 createPlayer 之后再注册悬浮窗控制回调；否则用户点悬浮窗 ✕ 时，
    // handleMirrorControl 因 controlHandler 为 null 直接 return，floatUserClosed 无法置位，
    // 导致手动关闭悬浮窗后切频道仍会自动弹出悬浮窗。
    setControlHandler({
      togglePlay: () => { state.art ? (state.art.playing ? state.art.pause() : state.art.play()) : null },
      closeFloat: () => closeFloatWindow(),
    })
    if (props.url) {
      loadUrl(props.url, props.headers)
    }
  })

  onUnmounted(() => destroyPlayer())

  // ── 响应式联动 ──
  watch(
    () => [props.url, props.headers, props.format, store.activePlayMode, store.streamRefreshSeq] as const,
    ([newUrl, newHeaders, , newMode], [, , , oldMode]) => {
      if (newMode !== oldMode) {
        updateControlLabels()
        if (!newMode) closeFloatWindow()
        disposeActiveEngine(state.art?.video ?? null)
        cleanupLocalEndedDetector()
        cleanupFfmpegPatches()
        state._ffmpegSeeking = false
        state._ffmpegSuppressNextSeek = false
        clearStallWatchdog()
        clearSourceTimeout()
        if (state._errorRetryTimer) { clearTimeout(state._errorRetryTimer); state._errorRetryTimer = null }
        clearAutoSafetyTimer()
        state._autoFallbackUrl = null
        state._autoFallbackHeaders = null
        state._autoFallbackGenId = 0
        state.confirmedFormat = null
        state.currentFormat = ''
        state.hasEverPlayed = false
      }
      if (newUrl) {
        loadUrl(newUrl as string, (newHeaders as Record<string, string>) || {})
      } else if (newMode !== oldMode) {
        // 切换到网页/空源等无视频地址模式：释放主进程会话，防止旧代理/FFmpeg/MPV/VLC 会话残留
        void closeCurrentSession()
      }
    },
  )

  // 主界面逻辑音量（store）是唯一真相源。
  watch(() => [store.volume, store.muted], () => applyMainVolume())

  watch(() => props.info, () => updateSourceLabel(), { deep: true })

  watch(() => store.decodeMode, async (newMode, oldMode) => {
    if (newMode === oldMode) return
    updateDecodeButton()
    // 视频流解析模式下播放地址（央视频 CDN m3u8）是一次性 token：
    // 每次切换解码模式都必须重新解析拿全新 token，绝不能复用上一模式已消耗的旧地址。
    if (isExternalPlay.value) {
      const fresh = await store.refreshSnifferStream()
      if (fresh && fresh !== state.lastLoadUrl) {
        logger.info(`[VideoPlayer] decode mode switched to: ${newMode}, 已重新解析一次性 token: ${fresh.substring(0, 100)}`)
        return
      }
    }
    if (state.lastLoadUrl && state.art) {
      logger.info(`[VideoPlayer] decode mode switched to: ${newMode}, reloading: ${state.lastLoadUrl.substring(0, 100)}`)
      loadUrl(state.lastLoadUrl, state.lastLoadHeaders)
    }
  })

  watch(() => store.mpvPath, () => {
    updateDecodeButton()
    if (store.decodeMode === 'mpv' && !store.mpvPath) {
      store.setDecodeMode('auto')
    }
  })

  watch(() => store.vlcPath, () => {
    updateDecodeButton()
    if (store.decodeMode === 'vlc' && !store.vlcPath) {
      store.setDecodeMode('auto')
    }
  })

  watch(() => store.ffmpegPath, () => {
    updateDecodeButton()
    if (store.decodeMode === 'ffmpeg' && !store.ffmpegPath) {
      store.setDecodeMode('auto')
    }
  })

  // 字幕同步到 ArtPlayer
  watch(subtitleVttUrl, (url) => {
    if (url && state.art) {
      state.art.subtitle.switch(url, { type: 'vtt' })
        .then(() => {
          logger.info('[Subtitle] ArtPlayer subtitle loaded')
          applySubtitleStyle()
        })
        .catch((e: any) => logger.error('[Subtitle] ArtPlayer subtitle switch error:', e))
    }
  })

  watch(subtitleEnabled, (enabled) => {
    if (state.art) {
      state.art.subtitle.show = enabled
    }
    updateSubtitleIndicator()
  })

  watch(() => store.subtitleStyleVersion, () => {
    if (state.art && subtitleVttUrl.value) {
      applySubtitleStyle()
    }
  })

  return {
    playerEl,
    expose: {
      play() { state.art?.play() },
      pause() { state.art?.pause() },
      toggle() { state.art ? (state.art.playing ? state.art.pause() : state.art.play()) : null },
      getCurrentTime() { return state.art?.currentTime || 0 },
      getVideo() { return state.art?.video as HTMLVideoElement | null },
      playLocalFile,
    },
  }
}