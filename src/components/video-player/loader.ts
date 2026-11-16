/**
 * video-player — 核心加载逻辑
 *
 * stopCurrentPlayback / loadUrl / doLoad：格式检测、代理、解码模式路由。
 */

import { state, sessionManager, networkInterceptor, MAX_RETRIES_PER_LINE } from './state'
import { ctx, computePreferIpv6 } from './context'
import { logger } from '@/utils/logger'
import {
  AUDIO_EXTS,
  getLocalExt,
  isDashExt,
  isDirectFormat,
  isNativeExt,
  isRedirectGateway,
  isTorrentUrl,
  isUnsupportedProtocol,
  isYspCdnUrl,
  probeGatewayFormat,
  probeFinalFormat,
} from '@/services/FormatDetector'
import { disposeActiveEngine, disposeAudioPlayer, playViaPlugin, playViaSwitchUrl } from './engine'
import { closeCurrentSession, cleanupFfmpegPatches } from './session'
import { cleanupLocalEndedDetector, playLocalFile } from './local-playback'
import { startMpv, startVlc } from './external-players'
import { ensureHardwareDecodeReady } from './hardware'
import { clearAutoSafetyTimer, playViaFfmpegSoftware, startAutoSafetyTimer } from './auto-fallback'
import { clearSourceTimeout, clearStallWatchdog } from './watchdog'

function stopCurrentPlayback(): void {
  if (!state.art) return
  const video = state.art.video as HTMLVideoElement | null
  if (video) {
    try { video.pause() } catch (_) {}
    // 关键修复：不再 removeAttribute('src') + load()。
    // 切频道时若这里 load()，会让 captureStream 音轨进入僵尸态（见 disposeActiveEngine 注释），
    // 悬浮窗镜像切频道后因此无声。旧播放由后续 switchUrl 设新 src / 引擎 attach 直接覆盖，
    // 无需提前清空 src。
    try { video.currentTime = 0 } catch (_) {}
    try {
      const v = video as any
      if (v.srcObject) { v.srcObject = null }
    } catch (_) {}
  }
  disposeActiveEngine(video)
}

async function loadUrl(url: string, headers: Record<string, string>): Promise<void> {
  if (!state.art || !url) return
  clearSourceTimeout()
  clearStallWatchdog()
  clearAutoSafetyTimer()
  if (state._errorRetryTimer) { clearTimeout(state._errorRetryTimer); state._errorRetryTimer = null }
  const modeChanged = state.lastPlayMode !== null && state.lastPlayMode !== ctx.store.activePlayMode
  const decodeChanged = state.lastDecodeMode !== null && state.lastDecodeMode !== ctx.store.decodeMode
  const isNewUrl = url !== state.lastLoadUrl
  if (isNewUrl || modeChanged || decodeChanged) {
    state.loadRetries = 0
    state.maxLoadRetries = MAX_RETRIES_PER_LINE
    state.loadGenerationId++
    state.confirmedFormat = null
    state.hasEverPlayed = false
    state._lastStallReloadAt = 0
    cleanupLocalEndedDetector()
    cleanupFfmpegPatches()
    state._ffmpegSeeking = false
    state._ffmpegSuppressNextSeek = false
  }
  stopCurrentPlayback()
  await closeCurrentSession()
  state.lastPlayMode = ctx.store.activePlayMode
  state.lastDecodeMode = ctx.store.decodeMode
  state.lastLoadUrl = url
  state.lastLoadHeaders = { ...headers }
  doLoad(url, state.lastLoadHeaders)
}

async function doLoad(url: string, headers: Record<string, string>): Promise<void> {
  const genId = state.loadGenerationId
  const externalPlay = ctx.isExternalPlay.value
  const playMode = ctx.store.activePlayMode

  if (url.startsWith('file://')) {
    if (playMode !== 'local') {
      logger.warn(`[VideoPlayer] file:// URL received but activePlayMode=${playMode}, redirecting to local play`)
    }
    if (genId !== state.loadGenerationId) return
    await playLocalFile(url)
    return
  }

  if (playMode === 'local') {
    logger.warn(`[VideoPlayer] local playMode but non-file URL: ${url.substring(0, 80)}... — treating as streaming`)
  }

  disposeAudioPlayer()
  cleanupLocalEndedDetector()
  cleanupFfmpegPatches()
  state._ffmpegSeeking = false
  state._ffmpegSuppressNextSeek = false

  const unsupportedProto = isUnsupportedProtocol(url)
  if (unsupportedProto) {
    logger.warn('[VideoPlayer] Unsupported protocol:', unsupportedProto, url)
    ctx.emit('error')
    return
  }

  if (!headers['Referer'] && !headers['referer']) {
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname
      if (/\.bdstatic\.com$/.test(hostname)) {
        headers['Referer'] = 'https://haokan.baidu.com/'
      } else {
        headers['Referer'] = parsed.origin + '/'
      }
    } catch (_) {}
  }

  if (isRedirectGateway(url)) {
    try {
      const parsed = new URL(url)
      headers['Referer'] = parsed.origin + '/'
      headers['Origin'] = parsed.origin
    } catch (_) {}
  }

  // ── 格式检测与路由 ──
  let finalUrl = url
  const lowerPath = finalUrl.split('?')[0].split('#')[0].toLowerCase()
  let finalFormat = ''

  // BitTorrent（magnet: / .torrent）无 HTTP 语义，标记后跳过代理与 HEAD 探测，直接走插件体系
  const isTorrent = isTorrentUrl(url)

  const hasCustomHeaders = !!(headers['Referer'] || headers['referer'] || headers['Origin'] || headers['origin'])
  const directFmt = isDirectFormat(lowerPath)
  const hasFormatExt = lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u') ||
    lowerPath.endsWith('.flv') || lowerPath.endsWith('.ts') ||
    lowerPath.endsWith('.m2ts') || lowerPath.endsWith('.mts') ||
    isNativeExt(lowerPath) || isDashExt(lowerPath) || isTorrent

  if (state.confirmedFormat && (isNativeExt(lowerPath) || lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u') || lowerPath.endsWith('.flv') || lowerPath.endsWith('.ts') || lowerPath.endsWith('.m2ts'))) {
    finalFormat = state.confirmedFormat
  } else if (state.confirmedFormat) {
    finalFormat = state.confirmedFormat
    if (!externalPlay) {
      try {
        await closeCurrentSession()
        const sess = await sessionManager.createProxySession(finalUrl, headers, finalFormat, await computePreferIpv6(finalUrl))
        if (genId !== state.loadGenerationId) return
        if (sess && sess.proxyUrl) {
          finalUrl = sess.proxyUrl
        }
      } catch (e) {
        logger.warn('[VideoPlayer] Confirmed proxy failed:', e)
      }
    }
  } else if (isTorrent) {
    finalFormat = 'torrent'
  } else if (lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u')) {
    finalFormat = 'm3u8'
  } else if (lowerPath.endsWith('.flv')) {
    finalFormat = 'flv'
  } else if (lowerPath.endsWith('.ts') || lowerPath.endsWith('.m2ts')) {
    finalFormat = 'ts'
  } else if (isDashExt(lowerPath)) {
    finalFormat = 'dash'
  } else if (isNativeExt(lowerPath)) {
    finalFormat = 'mp4'
  } else {
    const isGateway = isRedirectGateway(url)
    // ── 新: 网关两步探测 ──
    // 第一步: HEAD请求 + 重定向跟随 → 仅获取格式 (不消费body, 不消耗一次性token)
    // 第二步: 从原始URL重新发起连接播放 (不重用第一步的重定向终点URL)
    if (isGateway) {
      const probeGatewayFn = window.electronAPI?.probeGatewayFormat
        ? (u: string, h: Record<string, string>) => window.electronAPI!.probeGatewayFormat(u, h)
        : undefined
      if (probeGatewayFn) {
        const probeResult = await probeGatewayFormat(finalUrl, headers, probeGatewayFn)
        if (genId !== state.loadGenerationId) return
        if (probeResult.format !== 'unknown') {
          finalFormat = probeResult.format
          logger.info(`[VideoPlayer] gateway probe: format=${finalFormat} for ${url.substring(0, 80)}`)
        }
      }
    }
    // 非网关 URL 或网关探测失败 → 回退 probeFinalFormat
    if (!finalFormat) {
      const probeStreamFn = window.electronAPI?.probeStream
        ? (u: string, h: Record<string, string>) => window.electronAPI!.probeStream(u, h)
        : undefined
      const probeResult = await probeFinalFormat(finalUrl, headers, probeStreamFn)
      if (genId !== state.loadGenerationId) return
      finalFormat = probeResult.format
      if (probeResult.finalUrl && probeResult.finalUrl !== finalUrl) {
        const probeLower = probeResult.finalUrl.split('?')[0].split('#')[0].toLowerCase()
        if (isNativeExt(probeLower)) {
          finalFormat = 'mp4'
        } else if (probeLower.endsWith('.flv')) {
          finalFormat = 'flv'
        } else if (probeLower.endsWith('.m3u8') || probeLower.endsWith('.m3u')) {
          finalFormat = 'm3u8'
        } else if (probeLower.endsWith('.ts') || probeLower.endsWith('.m2ts')) {
          finalFormat = 'ts'
        }
      }

      // 探测阶段已跟随重定向拿到重定向终点 URL（probeResult.finalUrl），
      // 但绝不把重定向终点作为播放 URL：一次性 TOKEN 网关（如 IP:port/数字ID 的中转）
      // 每次请求原始 URL 都会签发全新 TOKEN，而探测阶段已消耗掉当时的 TOKEN，
      // 若直接复用 probeResult.finalUrl 播放会命中 502。
      // 保持原始 URL，由本地代理在真正播放时重新跟随重定向、签发全新 TOKEN。
    }

    if (!sessionManager.currentProxySessionId && !externalPlay && !hasFormatExt) {
      try {
        await closeCurrentSession()
        const sess = await sessionManager.createProxySession(finalUrl, headers, finalFormat, await computePreferIpv6(finalUrl))
        if (genId !== state.loadGenerationId) return
        if (sess && sess.proxyUrl) {
          finalUrl = sess.proxyUrl
        }
      } catch (e) {
        logger.warn('[VideoPlayer] Proxy failed, fallback direct:', e)
      }
    }
  }

  // 视频流解析模式（纯 HTTP 解析，不加载任何网页）：
  // 直播流（m3u8/ts/flv）统一经本地代理转发。主进程会为每一个 playlist 与分片请求
  // 注入解析器返回的请求头（Referer/Origin/UA/UID 等），同时把分片地址改写成
  // 127.0.0.1，从根上规避渲染进程的跨域与禁止头限制。
  // 这样 hls.js / mpegts.js 的每次请求都带正确请求头，硬解/软解才能稳定出画面。
  if (externalPlay && !sessionManager.currentProxySessionId &&
      (finalFormat === 'm3u8' || finalFormat === 'ts' || finalFormat === 'flv')) {
    try {
      await closeCurrentSession()
      const sess = await sessionManager.createProxySession(finalUrl, headers, finalFormat, await computePreferIpv6(finalUrl))
      if (genId !== state.loadGenerationId) return
      if (sess && sess.proxyUrl) {
        logger.info(`[VideoPlayer] stream mode: 直播流经本地代理播放 ${finalFormat} → ${sess.proxyUrl}`)
        finalUrl = sess.proxyUrl
      }
    } catch (e) {
      logger.warn('[VideoPlayer] stream proxy failed, fallback direct:', e)
    }
  }

  // 央视频 CDN（ysp.cctv.cn）与安卓版一致：播放地址一律经本地代理转发。
  // 该 CDN 对短时间内的多次直连请求会返回 403，代理负责把 playlist 改写为
  // 本地分片地址并串行转发，FFmpeg 只访问 127.0.0.1。
  if (!externalPlay && !sessionManager.currentProxySessionId && isYspCdnUrl(finalUrl)) {
    try {
      await closeCurrentSession()
      const sess = await sessionManager.createProxySession(finalUrl, headers, finalFormat || 'm3u8', await computePreferIpv6(finalUrl))
      if (genId !== state.loadGenerationId) return
      if (sess && sess.proxyUrl) {
        finalUrl = sess.proxyUrl
      }
    } catch (e) {
      logger.warn('[VideoPlayer] ysp proxy failed:', e)
    }
  }

  if (((externalPlay) || (directFmt && !externalPlay)) && hasCustomHeaders) {
    await networkInterceptor.registerForDirectPlay(finalUrl, headers, externalPlay)
  }

  if (genId !== state.loadGenerationId) return

  // ── 外置 FFmpeg 模式: 复用上面格式检测+代理, 固定外置 FFmpeg 解码/转封装 ──
  if (ctx.store.decodeMode === 'ffmpeg') {
    if (!ctx.store.ffmpegPath) {
      logger.warn('[VideoPlayer] ffmpeg: 外置 FFmpeg 不可用 (ffmpegPath 为空), 无法播放')
      return
    }
    disposeAudioPlayer()
    try {
      logger.info(`[VideoPlayer] ffmpeg: .${finalFormat} → 外置 FFmpeg 转封装/解码, creating session for ${finalUrl.substring(0, 120)}`)
      const result = await sessionManager.createFfmpegSession(finalUrl, headers, ctx.store.ffmpegPath)
      if (genId !== state.loadGenerationId) return
      if (result && result.success && result.proxyUrl && state.art) {
        state.currentFormat = 'mp4'
        const video = state.art.video as HTMLVideoElement
        logger.info(`[VideoPlayer] ffmpeg: session created, proxyUrl=${result.proxyUrl}`)
        video.src = result.proxyUrl
        video.play().catch(() => {})
        state.hasEverPlayed = true
        return
      }
      logger.warn('[VideoPlayer] ffmpeg: session failed:', result?.error)
    } catch (e) {
      logger.warn('[VideoPlayer] ffmpeg: session create error:', e)
    }
    return
  }

  // ── MPV 模式: 通过 webview 内嵌 MPV 直接播放 ──
  if (ctx.store.decodeMode === 'mpv') {
    logger.info(`[VideoPlayer] doLoad: MPV mode, mpvPath=${ctx.store.mpvPath || '(EMPTY!)'}, url=${finalUrl.substring(0, 120)}`)
    if (!ctx.store.mpvPath) {
      logger.warn('[VideoPlayer] doLoad: MPV mode selected but mpvPath is EMPTY! Configure MPV path in Settings.')
      return
    }
    const vid = state.art!.video as HTMLVideoElement
    vid.pause()
    vid.removeAttribute('src')
    vid.load()
    disposeActiveEngine(vid)
    disposeAudioPlayer()

    try {
      await startMpv(finalUrl, headers, ctx.store.mpvPath, genId, state.loadGenerationId)
    } catch (e) {
      logger.warn(`[VideoPlayer] doLoad: MPV EXCEPTION: ${e}`)
    }
    return
  }

  // ── VLC 模式: 弹窗播放 ──
  if (ctx.store.decodeMode === 'vlc') {
    logger.info(`[VideoPlayer] doLoad: VLC mode, vlcPath=${ctx.store.vlcPath || '(EMPTY!)'}, url=${finalUrl.substring(0, 120)}`)
    if (!ctx.store.vlcPath) {
      logger.warn('[VideoPlayer] doLoad: VLC mode selected but vlcPath is EMPTY! Configure VLC path in Settings.')
      return
    }
    const vid = state.art!.video as HTMLVideoElement
    vid.pause()
    vid.removeAttribute('src')
    vid.load()
    disposeActiveEngine(vid)
    disposeAudioPlayer()

    try {
      await startVlc(finalUrl, headers, ctx.store.vlcPath, genId, state.loadGenerationId)
    } catch (e) {
      logger.warn(`[VideoPlayer] doLoad: VLC EXCEPTION: ${e}`)
    }
    return
  }

  const onlineExt = getLocalExt(finalUrl)
  const isOnlineAudio = AUDIO_EXTS.has(onlineExt)

  const isUnknownFormat = finalFormat === 'unknown' || (!isOnlineAudio && finalFormat !== 'm3u8' && finalFormat !== 'flv' && finalFormat !== 'ts' && finalFormat !== 'mp4' && finalFormat !== 'dash' && finalFormat !== 'torrent' && !isNativeExt(lowerPath))

  if (ctx.store.decodeMode === 'hardware') {
    const video = state.art!.video as HTMLVideoElement
    disposeActiveEngine(video)
    state.currentFormat = finalFormat

    // 校验本机 GPU 硬件解码能力（NVIDIA / AMD / Intel / CPU 核显），并记录显卡型号
    await ensureHardwareDecodeReady()
    if (genId !== state.loadGenerationId) return

    if (isUnknownFormat) {
      // 格式未知时按 m3u8 处理，交由 GPU 硬件解码，避免直接放弃播放。
      logger.info(`[VideoPlayer] 硬解: .${finalFormat} 格式未知, 按 M3U8 走 GPU 硬件解码`)
      finalFormat = 'm3u8'
      state.currentFormat = 'm3u8'
      playViaSwitchUrl('m3u8', finalUrl)
    } else if (finalFormat === 'm3u8' || finalFormat === 'flv' || finalFormat === 'ts' || finalFormat === 'dash' || finalFormat === 'torrent') {
      logger.info(`[VideoPlayer] 硬解: .${finalFormat} → 拉流引擎 (协议解析) → GPU 硬件解码`)
      playViaSwitchUrl(finalFormat, finalUrl)
    } else if (isOnlineAudio) {
      logger.info(`[VideoPlayer] 硬解: .${onlineExt} → Web Audio 软解 (audio)`)
      playViaPlugin(video, finalUrl, 'audio', false)
    } else {
      logger.info(`[VideoPlayer] 硬解: .${finalFormat} → 原生硬解 (video 元素)`)
      video.src = finalUrl
      video.play().catch(() => {})
    }
    return
  }

  if (ctx.store.decodeMode === 'software') {
    state.currentFormat = finalFormat
    const video = state.art!.video as HTMLVideoElement
    disposeActiveEngine(video)
    if (genId !== state.loadGenerationId) return

    if (isOnlineAudio) {
      // 音频：CPU 软解（Web Audio / AudioPlayer），与容器格式无关
      logger.info(`[VideoPlayer] software: .${onlineExt} → CPU 软解 (AudioPlayer)`)
      playViaPlugin(video, finalUrl, 'audio', false)
    } else {
      // 软解 = CPU 通用处理器解码，与容器格式无关：
      // mp4/m3u8/flv/ts/未知 全格式统一走 FFmpeg CPU 软解码（libx264 重编码）。
      logger.info(`[VideoPlayer] software: .${finalFormat} → CPU 软解 (FFmpeg libx264)`)
      await playViaFfmpegSoftware(finalUrl, headers, genId, state.loadGenerationId, finalFormat)
    }
    return
  }

  // ── auto 模式: 硬解 → 软解 → 外部解码器(MPV/VLC/FFmpeg) ──
  // 硬解/软解与容器格式正交：Step 1 全格式统一优先硬解（GPU 专用解码电路），
  // 硬解失败后由 error/safety 回调触发软解（CPU 通用解码），再回退外部解码器。

  state._autoFallbackUrl = finalUrl
  state._autoFallbackHeaders = { ...headers }
  state._autoFallbackGenId = state.loadGenerationId
  startAutoSafetyTimer()

  // Step 1: 硬解（GPU 专用解码电路），全格式统一优先硬解
  if (genId !== state.loadGenerationId) return
  if (isOnlineAudio) {
    logger.info(`[VideoPlayer] auto: .${onlineExt} → Web Audio 软解 (audio)`)
    const video = state.art!.video as HTMLVideoElement
    playViaPlugin(video, finalUrl, 'audio', false)
  } else if (finalFormat === 'mp4' || isNativeExt(lowerPath)) {
    logger.info(`[VideoPlayer] auto: .${finalFormat} → 硬解 (原生 video)`)
    state.currentFormat = finalFormat
    const video = state.art!.video as HTMLVideoElement
    disposeActiveEngine(video)
    video.src = finalUrl
    video.play().catch(() => {})
  } else {
    // m3u8/flv/ts/dash/torrent/未知 → 拉流引擎（协议解析）→ 硬解（MSE 解封装，GPU 硬件解码）
    const isStreamFmt = finalFormat === 'm3u8' || finalFormat === 'flv' || finalFormat === 'ts' || finalFormat === 'dash' || finalFormat === 'torrent'
    const hwFmt = isStreamFmt ? finalFormat : 'm3u8'
    logger.info(`[VideoPlayer] auto: .${finalFormat} → 拉流引擎 (协议解析) → 硬解 (GPU 硬件解码, MSE 解封装)`)
    state.currentFormat = hwFmt
    const video = state.art!.video as HTMLVideoElement
    disposeActiveEngine(video)
    playViaSwitchUrl(hwFmt, finalUrl)
  }
}

export { stopCurrentPlayback, loadUrl, doLoad }