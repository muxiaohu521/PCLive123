/**
 * video-player — 拉流 / 协议解析引擎统一入口
 *
 * 所有「拉流/协议解析引擎」（hls.js / mpegts.js / dash.js / webtorrent / native / audio）
 * 统一通过 pluginRegistry.resolve() 按格式自动路由；插件实例以结构化事件上抛，
 * 播放器层只负责解码模式策略（硬解禁止降级 / auto 回退链 / 停滞重载 / token 重签）。
 */

import { state } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import { pluginRegistry } from '@/player-plugins'
import type { MediaFormat, PlayContext } from '@/player-plugins'
import { clearSourceTimeout, reloadForStall, isHlsBufferStallError, isHlsTokenExpiredNetworkError, startStallWatchdog, startSourceTimeout } from './watchdog'
import { verifyHardwareCodec } from './hardware'
import { tryFfmpegStreamFallback } from './ffmpeg'
import { triggerAutoFallback } from './auto-fallback'

// ── 解码引擎清理 ──

function disposeActiveEngine(video: HTMLVideoElement | null): void {
  if (state.activeEngineInstance) {
    try { state.activeEngineInstance.destroy() } catch (_) { /* */ }
    state.activeEngineInstance = null
  }
  disposeAudioPlayer()
  // 关键修复：不在此处 removeAttribute('src') + load()。
  //   若这里 load()，会让 <video> 进入「空 src + load」中间态，破坏 captureStream 的音频捕获管道，
  //   导致切频道后新音轨成为「僵尸轨道」（readyState=live 却不再产出数据），悬浮窗镜像因此永远无声。
  //   各插件 destroy() 已移除 removeAttribute+load，切源统一交由后续 switchUrl / 引擎 attach 直接覆盖 src，
  //   让 captureStream 走「追加新轨道」路径，旧轨道由 PlaybackStreamHub.pruneStaleTracks 统一摘除。
  void video
}

function disposeAudioPlayer(): void {
  if (state.audioPlayer) {
    state.audioPlayer.destroy()
    state.audioPlayer = null
  }
}

function playViaPlugin(
  video: HTMLVideoElement,
  url: string,
  format: MediaFormat,
  isLive = true,
): void {
  if (!url) return
  const mode = ctx.store.decodeMode
  if (mode === 'ffmpeg') {
    logger.warn(`[VideoPlayer] ffmpeg mode: ${format} customType 不应走插件引擎, FFmpeg 在 doLoad 中直接处理`)
    return
  }

  const allowFallback = mode === 'auto'
  state.currentFormat = format

  const context: PlayContext = {
    url,
    headers: { ...state.lastLoadHeaders },
    format,
    decodeMode: mode,
    isLive,
    allowFallback,
    volume: state.lastAudioVolume,
    muted: state.lastAudioMuted,
  }

  const plugin = pluginRegistry.resolve(format, context)
  if (!plugin) {
    logger.warn(`[VideoPlayer] 无可用插件引擎: format=${format}, mode=${mode}`)
    if (allowFallback) triggerAutoFallback().catch(() => {})
    return
  }

  // 销毁上一会话引擎（attach → destroy 对称）
  disposeActiveEngine(video)

  const instance = plugin.create(context)
  state.activeEngineInstance = instance

  // 音频引擎暴露底层 Web Audio 播放器，供主界面音量/静音正向同步
  if (plugin.id === 'audio') {
    state.audioPlayer = (instance as any).player ?? null
  }

  instance.on?.('ready', (payload?: any) => {
    clearSourceTimeout()
    if (plugin.id === 'audio') {
      state.currentFormat = 'mp4'
      state.loadGenerationId++
      state.confirmedFormat = 'mp4'
      return
    }
    if (mode === 'hardware' && payload && payload.codec) {
      verifyHardwareCodec(payload.codec, payload.width, payload.height)
    }
  })
  instance.on?.('canplay', (payload?: any) => {
    clearSourceTimeout()
    if (mode === 'hardware' && payload && payload.mimeType) {
      verifyHardwareCodec(payload.mimeType, payload.width, payload.height)
    }
  })
  instance.on?.('playing', () => { state.hasEverPlayed = true; ctx.emit('playing') })
  instance.on?.('pause', () => ctx.emit('pause'))
  instance.on?.('ended', () => ctx.emit('ended'))
  instance.on?.('error', (...args: any[]) => {
    handlePluginError(plugin.id, video, url, allowFallback, args)
  })
  instance.on?.('fatal', (...args: any[]) => {
    handlePluginFatal(plugin.id, video, allowFallback, args)
  })

  instance.attach(video, context)
}

// 非致命插件错误：只做引擎专属策略处理（停滞重载 / token 重签 / 网络 watchdog），
// 跨模式回退统一由 fatal 事件驱动，避免瞬时抖动误触发回退链。
function handlePluginError(
  pluginId: string,
  video: HTMLVideoElement,
  url: string,
  allowFallback: boolean,
  args: any[],
): void {
  if (pluginId === 'hls') {
    const data = args[0]
    if (data && isHlsBufferStallError(data.details)) {
      reloadForStall(`HLS ${data.details}`)
      return
    }
    if (data && isHlsTokenExpiredNetworkError(data)) {
      reloadForStall(`HLS network token expired (${data.response?.code})`)
      return
    }
    // 其余非致命错误（mediaError / mediaSourceRequiresReset）已由引擎内部 recoverMediaError 处理
    return
  }
  if (pluginId === 'mpegts') {
    if (args[0] === 'networkError' && state.hasEverPlayed) startStallWatchdog()
    return
  }
  // dash / webtorrent / native / audio
  const err = args[0]
  logger.warn(`[VideoPlayer] ${pluginId} error:`, (err as any)?.message ?? err)
  if (pluginId === 'audio') {
    disposeActiveEngine(video)
    if (allowFallback) {
      logger.info('[VideoPlayer] auto: AudioPlayer 播放失败, 回退 FFmpeg')
      tryFfmpegStreamFallback(video, url)
    } else {
      logger.warn(`[VideoPlayer] ${ctx.store.decodeMode} mode: AudioPlayer 播放失败, 禁止跨模式回退`)
    }
    return
  }
  if (allowFallback) {
    disposeActiveEngine(video)
    triggerAutoFallback().catch(() => {})
  } else {
    logger.error(`[VideoPlayer] ${ctx.store.decodeMode} mode: ${pluginId} 拉流失败, 禁止跨模式回退`)
  }
}

// 致命插件错误：auto 触发回退链（软解 → 外部）；hardware / software 禁止跨模式降级。
function handlePluginFatal(
  pluginId: string,
  video: HTMLVideoElement,
  allowFallback: boolean,
  args: any[],
): void {
  logger.warn(`[VideoPlayer] ${pluginId} fatal:`, (args[0] as any)?.details ?? args[0])
  if (pluginId === 'hls') {
    clearSourceTimeout()
    if (ctx.store.decodeMode === 'software') {
      disposeActiveEngine(video)
      logger.warn('[VideoPlayer] software mode: HLS fatal, software mode forbids FFmpeg fallback')
    } else if (allowFallback) {
      disposeActiveEngine(video)
      triggerAutoFallback().catch(() => {})
    } else {
      logger.error('[VideoPlayer] 硬解失败: GPU 硬件解码器无法解码该流, 硬解模式禁止软解降级')
    }
  }
}

function playViaSwitchUrl(fmt: string, url: string): void {
  state.art!.type = fmt
  startSourceTimeout()
  state.art!.switchUrl(url)
}

export { disposeActiveEngine, disposeAudioPlayer, playViaPlugin, handlePluginError, handlePluginFatal, playViaSwitchUrl }