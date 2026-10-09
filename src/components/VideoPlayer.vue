<template>
  <div class="video-player-container">
    <div ref="playerEl" class="video-inner" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useAppStore } from '@/store'
import type { DecodeMode, PlayMode } from '@/constants'
import { PLAY_MODE_LABELS } from '@/constants'
import Artplayer from 'artplayer'
import Hls from 'hls.js'
import mpegts from 'mpegts.js'
import { logger } from '@/utils/logger'
import { SoftwareAudioPlayer } from '@/services/AudioPlayer'
import { StreamSessionManager } from '@/services/StreamSessionManager'
import { NetworkInterceptor } from '@/services/NetworkInterceptor'
import {
  NATIVE_PLAYABLE_EXTS,
  MPEGTS_FLV_EXTS,
  MPEGTS_STREAM_EXTS,
  HLS_EXTS,
  AUDIO_EXTS,
  getLocalExt,
  isNativeExt,
  isDirectFormat,
  isUnsupportedProtocol,
  isRedirectGateway,
  probeGatewayFormat,
probeFinalFormat,
} from '@/services/FormatDetector'
import { useSubtitle } from '@/composables/useSubtitle'
import { useMirrorStream } from '@/composables/useMirrorStream'
import { hasIpv6Hint } from '@/models/LiveChannelItem'

// ── Props / Emits ──

const props = defineProps<{
  url: string
  headers: Record<string, string>
  format: string
  volume: number
  muted: boolean
  info: {
    sourceIndex: number
    sourceNum: number
  }
}>()

const emit = defineEmits<{
  playing: []
  pause: []
  ended: []
  error: []
  prevSource: []
  nextSource: []
  prevChannel: []
  nextChannel: []
  sourceTimeout: []
}>()

// ── Services & Composables ──

const playerEl = ref<HTMLElement | null>(null)
const store = useAppStore()

const sessionManager = new StreamSessionManager()
const networkInterceptor = new NetworkInterceptor()

async function computePreferIpv6(url: string): Promise<boolean> {
  if (store.activePlayMode !== 'channel') return false
  const api = window.electronAPI
  if (!api?.hasIpv6) return false
  const ch = store.currentChannel
  if (!ch) return false
  const srcName = ch.channelSourceNames[ch.sourceIndex] || ''
  const group = store.currentGroup
  const hasHint = hasIpv6Hint(url, srcName, ch.channelName, group?.groupName || '', group?.subLineName || '')
  if (!hasHint) return false
  try { return await api.hasIpv6() } catch { return false }
}

const {
  subtitleEnabled,
  subtitleVttUrl,
  toggleSubtitle,
  destroy: destroySubtitle,
} = useSubtitle()

const {
  restartMirrorStream,
  openFloatWindow,
  closeFloatWindow,
  getIsMirroring,
  setControlHandler,
  destroy: destroyMirror,
} = useMirrorStream()

let _ffmpegStderrCleanup: (() => void) | null = null
if (window.electronAPI?.onFfmpegStderr) {
  _ffmpegStderrCleanup = window.electronAPI.onFfmpegStderr((data) => {
    logger.warn(`[FFmpeg stderr] ${data.line}`)
  })
}

let _mainDebugLogCleanup: (() => void) | null = null
if (window.electronAPI?.onMainDebugLog) {
  _mainDebugLogCleanup = window.electronAPI.onMainDebugLog((line) => {
    logger.info(line)
  })
}

// 注册悬浮窗控制回调
setControlHandler({
  togglePlay: () => { art ? (art.playing ? art.pause() : art.play()) : null },
  closeFloat: () => closeFloatWindow(),
})

// ── Core State ──

let art: Artplayer | null = null
let sourceInfoEl: HTMLElement | undefined

const isExternalPlay = computed(() => store.activePlayMode === 'sniffer')
let controlsAdded = false
let loadRetries = 0
let maxLoadRetries = 0
let lastLoadUrl = ''
let lastLoadHeaders: Record<string, string> = {}

const MAX_RETRIES_PER_LINE = 3
const AUTO_SAFETY_TIMEOUT_MS = 25000
const SOURCE_TIMEOUT_MS = 10000
let loadGenerationId = 0
let lastPlayMode: 'local' | 'channel' | 'sniffer' | 'locallive' | null = null
let lastDecodeMode: string | null = null
let _stallWatchdog: ReturnType<typeof setTimeout> | null = null
let _autoSafetyTimer: ReturnType<typeof setTimeout> | null = null
let _autoFallbackUrl: string | null = null
let _autoFallbackHeaders: Record<string, string> | null = null
let _autoFallbackGenId = 0
let confirmedFormat: string | null = null
let currentFormat = ''
let hasEverPlayed = false
let sourceTimeout: ReturnType<typeof setTimeout> | null = null
let audioPlayer: SoftwareAudioPlayer | null = null
let lastAudioVolume = 0.8
let lastAudioMuted = false

// FFmpeg 状态（duration/seek 补丁）

let _ffmpegDurationCleanup: (() => void) | null = null
let _ffmpegSeekOffset = 0
let _ffmpegSeekCleanup: (() => void) | null = null
let _ffmpegCurrentTimeCleanup: (() => void) | null = null
let _ffmpegSeeking = false

let _ffmpegSuppressNextSeek = false
let _ffmpegSuppressSeekTimer: ReturnType<typeof setTimeout> | null = null
let _ffmpegUserSeekTarget = 0

// 本地播放结束检测
let _localEndedDetectorCleanup: (() => void) | null = null
let _localEndedFired = false

let _videoEventListenersCleanup: (() => void) | null = null
let _errorRetryTimer: ReturnType<typeof setTimeout> | null = null

// ── Session 清理 ──

function cleanupFfmpegPatches(): void {
  if (_ffmpegDurationCleanup) {
    _ffmpegDurationCleanup()
    _ffmpegDurationCleanup = null
  }
  if (_ffmpegCurrentTimeCleanup) {
    _ffmpegCurrentTimeCleanup()
    _ffmpegCurrentTimeCleanup = null
  }
  cleanupFfmpegSeek()
}

async function closeCurrentSession(): Promise<void> {
  if (store.mpvActive) {
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
    store.closeMpv()
  }
  await sessionManager.closeAll()
  await networkInterceptor.unregister()
  cleanupFfmpegPatches()
  }

function cleanupFfmpegSeek(): void {
  if (_ffmpegSeekCleanup) {
    _ffmpegSeekCleanup()
    _ffmpegSeekCleanup = null
  }
  _ffmpegSeekOffset = 0
  _ffmpegUserSeekTarget = 0
  _ffmpegSuppressNextSeek = false
  if (_ffmpegSuppressSeekTimer) {
    clearTimeout(_ffmpegSuppressSeekTimer)
    _ffmpegSuppressSeekTimer = null
  }
}

// ── Timeout / Watchdog ──

function clearSourceTimeout(): void {
  if (sourceTimeout !== null) {
    clearTimeout(sourceTimeout)
    sourceTimeout = null
  }
}

function clearStallWatchdog(): void {
  if (_stallWatchdog !== null) {
    clearTimeout(_stallWatchdog)
    _stallWatchdog = null
  }
}

function startStallWatchdog(): void {
  clearStallWatchdog()
  _stallWatchdog = setTimeout(() => {
    _stallWatchdog = null
    if (!lastLoadUrl || !hasEverPlayed) return
    logger.warn('[VideoPlayer] Stall detected (>20s), reloading stream')
    const reloadUrl = lastLoadUrl
    const reloadHeaders = { ...lastLoadHeaders }
    const capturedGenId = loadGenerationId
    if (capturedGenId !== loadGenerationId) return
    loadUrl(reloadUrl, reloadHeaders)
  }, 20000)
}

function startSourceTimeout(): void {
  clearSourceTimeout()
  if (props.info.sourceNum <= 1) return
  if (hasEverPlayed) return
  sourceTimeout = setTimeout(() => {
    sourceTimeout = null
    if (hasEverPlayed) return
    logger.warn('[VideoPlayer] Source timeout, switching to next source')
    emit('sourceTimeout')
  }, SOURCE_TIMEOUT_MS)
}

// ── 统一自动回退 (MPV→VLC→FFmpeg) ──

function clearAutoSafetyTimer(): void {
  if (_autoSafetyTimer !== null) {
    clearTimeout(_autoSafetyTimer)
    _autoSafetyTimer = null
  }
}

async function triggerAutoFallback(): Promise<boolean> {
  const url = _autoFallbackUrl
  const headers = _autoFallbackHeaders
  const genId = _autoFallbackGenId
  if (!url || !headers || genId !== loadGenerationId) return false

  clearAutoSafetyTimer()
  clearSourceTimeout()

  const video = art?.video as HTMLVideoElement | undefined
  if (video) {
    video.pause()
    video.removeAttribute('src')
    video.load()
    disposeHlsFlvAudio(video)
  }
  disposeAudioPlayer()

  logger.info('[VideoPlayer] auto: 回退链 MPV→VLC→FFmpeg')

  if (store.mpvPath) {
    const ok = await startMpv(url, headers, store.mpvPath, genId, loadGenerationId, true)
    if (ok) return true
    if (genId !== loadGenerationId) return false
  }

  if (store.vlcPath) {
    const ok = await startVlc(url, headers, store.vlcPath, genId, loadGenerationId, true)
    if (ok) return true
    if (genId !== loadGenerationId) return false
  }

  if (store.ffmpegPath) {
    logger.info('[VideoPlayer] auto: → FFmpeg 回退')
    try {
      const result = await sessionManager.createFfmpegSession(url, headers, store.ffmpegPath)
      if (genId !== loadGenerationId) return false
      if (result && result.success && result.proxyUrl && art) {
        currentFormat = 'mp4'
        const vid = art.video as HTMLVideoElement
        vid.src = result.proxyUrl
        vid.play().catch(() => {})
        hasEverPlayed = true
        if (getIsMirroring()) restartMirrorStream(art)
        return true
      }
    } catch (e) {
      logger.warn('[VideoPlayer] auto: FFmpeg 回退失败:', e)
    }
  }
  return false
}

function startAutoSafetyTimer(): void {
  clearAutoSafetyTimer()
  _autoSafetyTimer = setTimeout(async () => {
    _autoSafetyTimer = null
    if (hasEverPlayed) return
    logger.warn('[VideoPlayer] auto: 安全超时 (' + AUTO_SAFETY_TIMEOUT_MS + 'ms), 触发回退链')
    await triggerAutoFallback()
  }, AUTO_SAFETY_TIMEOUT_MS)
}

// ── UI 控件 ──

function updateSourceLabel(): void {
  if (!sourceInfoEl) return
  if (store.activePlayMode === 'channel') {
    sourceInfoEl.textContent = `线路 ${props.info.sourceIndex + 1}/${props.info.sourceNum}`
  } else if (store.activePlayMode === 'locallive') {
    sourceInfoEl.textContent = `线路 ${props.info.sourceIndex + 1}/${props.info.sourceNum}`
  } else if (store.activePlayMode === 'local') {
    sourceInfoEl.textContent = `视频 ${props.info.sourceIndex + 1}/${props.info.sourceNum}`
  } else {
    sourceInfoEl.textContent = ''
  }
}

function updateControlLabels(): void {
  if (!art) return
  const mode = store.activePlayMode
  const player = art

  const setDisp = (name: string, show: boolean) => {
    const el = player.controls[name] as HTMLElement | undefined
    if (el) el.style.display = show ? '' : 'none'
  }

  if (!mode) {
    setDisp('prev-channel', false)
    setDisp('next-channel', false)
    setDisp('prev-source', false)
    setDisp('source-info', false)
    setDisp('next-source', false)
    setDisp('subtitle-cc', true)
    setDisp('float-window', false)
    return
  }

  const showChannel = mode === 'local' || mode === 'channel' || mode === 'locallive'

  setDisp('prev-channel', showChannel)
  setDisp('next-channel', showChannel)
  setDisp('prev-source', mode === 'channel' || mode === 'locallive')
  setDisp('source-info', mode === 'channel' || mode === 'locallive')
  setDisp('next-source', mode === 'channel' || mode === 'locallive')
  setDisp('subtitle-cc', mode !== 'channel' && mode !== 'locallive')
  setDisp('float-window', true)

  if (mode === 'local') {
    const pc = art.controls['prev-channel'] as HTMLElement | undefined; if (pc) pc.setAttribute('title', '上一视频')
    const nc = art.controls['next-channel'] as HTMLElement | undefined; if (nc) nc.setAttribute('title', '下一视频')
  } else if (mode === 'channel' || mode === 'locallive') {
    const pc = art.controls['prev-channel'] as HTMLElement | undefined; if (pc) pc.setAttribute('title', '上一频道')
    const nc = art.controls['next-channel'] as HTMLElement | undefined; if (nc) nc.setAttribute('title', '下一频道')
  }

  if (mode === 'local') updatePlayModeButton()
  updateSourceLabel()
}

function getDecodeLabel(): string {
  const mode = store.decodeMode
  if (mode === 'hardware') return '硬解'
  if (mode === 'software') return '软解'
  if (mode === 'mpv') return 'MPV'
  if (mode === 'vlc') return 'VLC'
  if (mode === 'ffmpeg') return 'FFmpeg'
  return '自动'
}

function getPlayModeLabel(): string {
  return PLAY_MODE_LABELS[store.localPlayMode] || '顺序播放'
}

function updatePlayModeButton(): void {
  if (!art) return
  const outer = art.controls['play-mode'] as HTMLElement | undefined
  const el = outer?.querySelector('.pclive-playmode-btn') as HTMLElement | null
  if (el) el.textContent = getPlayModeLabel()
}

function updateDecodeButton(): void {
  if (!art) return
  const outer = art.controls['decode-mode'] as HTMLElement | undefined
  const span = outer?.querySelector('.pclive-decode-btn') as HTMLElement | null
  if (!span) return
  span.textContent = getDecodeLabel()
  const mode = store.decodeMode
  span.className = 'pclive-decode-btn'
  if (mode === 'hardware') span.className += ' decode-hw'
  else if (mode === 'software') span.className += ' decode-sw'
  else if (mode === 'ffmpeg') span.className += ' decode-ff'
  else if (mode === 'mpv') span.className += ' decode-mpv'
  else if (mode === 'vlc') span.className += ' decode-vlc'
  else span.className += ' decode-auto'
  if (outer) outer.title = '选择解码模式'
}

// ── 弹出菜单 ──

interface PopupItem {
  label: string
  value: string
  active: boolean
  colorClass?: string
}

let activePopup: HTMLDivElement | null = null
let activePopupAnchor: HTMLElement | null = null

function closePopup(): void {
  if (activePopup) {
    const kh = (activePopup as any).__keyHandler
    if (kh) document.removeEventListener('keydown', kh)
    activePopup.remove()
    activePopup = null
    activePopupAnchor = null
  }
}

function showPopupMenu(anchor: HTMLElement, items: PopupItem[], onSelect: (value: string) => void): void {
  if (activePopup && activePopupAnchor === anchor) {
    closePopup()
    return
  }

  closePopup()
  activePopupAnchor = anchor

  const anchorRect = anchor.getBoundingClientRect()

  const overlay = document.createElement('div')
  overlay.className = 'pclive-popup-overlay'
  overlay.addEventListener('click', closePopup)
  overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); closePopup() })

  const popup = document.createElement('div')
  popup.className = 'pclive-popup-menu'

  for (const item of items) {
    const el = document.createElement('div')
    el.className = 'pclive-popup-item'
    if (item.active) el.classList.add('active')
    if (item.colorClass) el.classList.add(item.colorClass)
    el.textContent = item.label
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      onSelect(item.value)
      closePopup()
    })
    popup.appendChild(el)
  }

  overlay.appendChild(popup)
  document.body.appendChild(overlay)
  activePopup = overlay

  popup.style.position = 'fixed'
  popup.style.zIndex = '100001'
  void popup.offsetHeight

  const pw = popup.offsetWidth
  const ph = popup.offsetHeight

  let top = anchorRect.top - ph - 4
  let left = anchorRect.left
  if (top < 8) top = anchorRect.bottom + 4
  if (left + pw > window.innerWidth - 8) {
    left = window.innerWidth - pw - 8
  }
  if (left < 8) left = 8

  popup.style.left = left + 'px'
  popup.style.top = top + 'px'

  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePopup()
  }
  document.addEventListener('keydown', keyHandler);
  (overlay as any).__keyHandler = keyHandler
}

function updateSubtitleIndicator(): void {
  const el = document.getElementById('pclive-sub-indicator')
  if (!el) return
  if (subtitleEnabled.value && subtitleVttUrl.value) {
    el.className = 'pclive-sub-indicator on'
  } else {
    el.className = 'pclive-sub-indicator off'
  }
}

const SUBTITLE_STYLE_KEY = 'pclive_settings'

function getSubtitleStyle(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBTITLE_STYLE_KEY) || '{}')
    const fontSize = saved.subFontSize || 16
    const color = saved.subColor || '#ffffff'
    const background = saved.subBg || 'rgba(0,0,0,0.6)'
    return {
      fontSize: `${fontSize}px`,
      color,
      background,
      textShadow: '1px 1px 2px #000',
    }
  } catch (_) {
    return { fontSize: '16px', color: '#ffffff', background: 'rgba(0,0,0,0.6)' }
  }
}

function applySubtitleStyle(): void {
  if (art) {
    art.subtitle.style(getSubtitleStyle())
  }
}

// ── 控件注册 ──

function addCustomControls(): void {
  if (!art || controlsAdded) return
  controlsAdded = true

  const isChannel = store.activePlayMode === 'channel'
  const isLocal = store.activePlayMode === 'local'

  art.controls.add({
    name: 'prev-channel',
    position: 'left',
    html: '◁',
    tooltip: isLocal ? '上一视频' : '上一频道',
    style: { fontSize: '18px', fontWeight: 'bold', marginRight: '2px' },
    click() { emit('prevChannel') },
  })

  art.controls.add({
    name: 'next-channel',
    position: 'left',
    html: '▷',
    tooltip: isLocal ? '下一视频' : '下一频道',
    style: { fontSize: '18px', fontWeight: 'bold', marginRight: '8px' },
    click() { emit('nextChannel') },
  })

  art.controls.add({
    name: 'prev-source',
    position: 'left',
    html: '◀',
    tooltip: '上一线路',
    style: { fontSize: '12px' },
    click() { emit('prevSource') },
  })

  art.controls.add({
    name: 'source-info',
    position: 'left',
    html: `<span class="pclive-src-label">${isChannel ? `线路 ${props.info.sourceIndex + 1}/${props.info.sourceNum}` : ''}</span>`,
    tooltip: '当前线路',
    style: {},
    mounted(this: any, el: HTMLElement) { sourceInfoEl = el },
  })

  art.controls.add({
    name: 'next-source',
    position: 'left',
    html: '▶',
    tooltip: '下一线路',
    style: { fontSize: '12px' },
    click() { emit('nextSource') },
  })

  art.controls.add({
    name: 'subtitle-cc',
    position: 'right',
    html: '<span id="pclive-sub-indicator" class="pclive-sub-indicator off">CC</span>',
    tooltip: '字幕 (显示/隐藏)',
    style: { fontSize: '12px', marginRight: '6px', cursor: 'pointer' },
    click() { toggleSubtitle() },
  })

  art.controls.add({
    name: 'decode-mode',
    position: 'right',
    html: `<span class="pclive-decode-btn">${getDecodeLabel()}</span>`,
    tooltip: '选择解码模式',
    style: { fontSize: '11px', marginRight: '6px', cursor: 'pointer', fontWeight: 'bold' },
    click(_comp: any, _event: Event) {
      const outer = art!.controls['decode-mode'] as HTMLElement | undefined
      const span = outer?.querySelector('.pclive-decode-btn') as HTMLElement | null
      if (!span) return

      const items: PopupItem[] = [
        { label: '自动', value: 'auto', active: store.decodeMode === 'auto', colorClass: 'decode-auto' },
        { label: '硬解', value: 'hardware', active: store.decodeMode === 'hardware', colorClass: 'decode-hw' },
        { label: '软解', value: 'software', active: store.decodeMode === 'software', colorClass: 'decode-sw' },
      ]
      if (store.mpvPath) items.push({ label: 'MPV', value: 'mpv', active: store.decodeMode === 'mpv', colorClass: 'decode-mpv' })
      if (store.vlcPath) items.push({ label: 'VLC', value: 'vlc', active: store.decodeMode === 'vlc', colorClass: 'decode-vlc' })
      if (store.ffmpegPath) items.push({ label: 'FFmpeg', value: 'ffmpeg', active: store.decodeMode === 'ffmpeg', colorClass: 'decode-ff' })

      showPopupMenu(span, items, (value) => {
        const mode = value as DecodeMode
        if (mode === store.decodeMode) return
        store.setDecodeMode(mode)
        updateDecodeButton()
        if (lastLoadUrl && art) {
          logger.info(`[VideoPlayer] decode mode switched to: ${mode}, reloading: ${lastLoadUrl.substring(0, 100)}`)
          loadUrl(lastLoadUrl, lastLoadHeaders)
        }
      })
    },
  })

  art.controls.add({
    name: 'play-mode',
    position: 'right',
    html: `<span class="pclive-playmode-btn">${getPlayModeLabel()}</span>`,
    tooltip: '选择播放模式',
    style: { fontSize: '11px', marginRight: '6px', cursor: 'pointer', fontWeight: 'bold' },
    click(_comp: any, _event: Event) {
      const outer = art!.controls['play-mode'] as HTMLElement | undefined
      const span = outer?.querySelector('.pclive-playmode-btn') as HTMLElement | null
      if (!span) return

      const items: PopupItem[] = [
        { label: '顺序播放', value: 'sequential', active: store.localPlayMode === 'sequential' },
        { label: '单曲循环', value: 'single_loop', active: store.localPlayMode === 'single_loop' },
        { label: '随机播放', value: 'random', active: store.localPlayMode === 'random' },
      ]

      showPopupMenu(span, items, (value) => {
        const mode = value as PlayMode
        if (mode === store.localPlayMode) return
        store.setLocalPlayMode(mode)
        updatePlayModeButton()
      })
    },
  })

  art.controls.add({
    name: 'float-window',
    position: 'right',
    html: '<span class="pclive-float-btn">🖥</span>',
    tooltip: '打开悬浮窗',
    style: { fontSize: '12px', marginRight: '4px', cursor: 'pointer' },
    click() { openFloatWindow(art) },
  })

  art.controls.add({
    name: 'dlna-cast',
    position: 'right',
    html: '<span class="pclive-float-btn">📡</span>',
    tooltip: 'DLNA 投屏',
    style: { fontSize: '12px', marginRight: '4px', cursor: 'pointer' },
    click() { store.showDlna = !store.showDlna },
  })

  updateControlLabels()

}

// ── 解码引擎清理 ──

function disposeHlsFlvAudio(video: HTMLVideoElement | null): void {
  disposeHls(video)
  disposeFlv(video)
  disposeAudioPlayer()
}

function playViaSwitchUrl(fmt: string, url: string): void {
  art!.type = fmt
  startSourceTimeout()
  art!.switchUrl(url)
  if (getIsMirroring()) restartMirrorStream(art)
}

function disposeHls(video: HTMLVideoElement | null): void {
  if (!video) return
  const v = video as any
  const hls = v.hls
  if (hls) {
    try { hls.stopLoad(); hls.detachMedia(); hls.destroy() } catch (_e) { /* */ }
    v.hls = null
  }
  const hlsEndedHandler = v._hlsEndedHandler
  if (hlsEndedHandler) {
    video.removeEventListener('ended', hlsEndedHandler)
    v._hlsEndedHandler = null
  }
  try {
    video.removeAttribute('src')
    video.load()
  } catch (_) {}
}

function disposeFlv(video: HTMLVideoElement | null): void {
  if (!video) return
  const v = video as any
  if (v.flv) {
    try { v.flv.detachMediaElement(); v.flv.destroy() } catch (_e) { /* */ }
    v.flv = null
  }
}

function attachHls(
  video: HTMLVideoElement,
  hls: Hls,
  onError: (data: { type: string; details: string; fatal: boolean }) => void,
  onManifestParsed?: () => void,
): void {
  hls.on(Hls.Events.ERROR, (_event, data) => { onError(data) })
  if (onManifestParsed) {
    hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed)
  }
  hls.attachMedia(video)
  ;(video as any).hls = hls
  const onHlsEnded = () => {
    hls.stopLoad()
    hls.destroy()
    ;(video as any).hls = null
    ;(video as any)._hlsEndedHandler = null
  }
  ;(video as any)._hlsEndedHandler = onHlsEnded
  video.addEventListener('ended', onHlsEnded, { once: true })
}

function disposeAudioPlayer(): void {
  if (audioPlayer) {
    audioPlayer.destroy()
    audioPlayer = null
  }
}

// ── 本地播放结束检测 ──

function cleanupLocalEndedDetector(): void {
  if (_localEndedDetectorCleanup) {
    _localEndedDetectorCleanup()
    _localEndedDetectorCleanup = null
  }
  _localEndedFired = false
}

function setupLocalEndedDetector(genId: number): void {
  cleanupLocalEndedDetector()
  const video = art?.video as HTMLVideoElement | undefined
  if (!video || store.activePlayMode !== 'local') return

  const onVideoEnded = () => {
    if (genId !== _playLocalFileGen) return
    if (_localEndedFired) return
    _localEndedFired = true
    logger.info('[VideoPlayer] local video ended (direct listener)')
    emit('ended')
  }
  video.addEventListener('ended', onVideoEnded)

  const onTimeUpdate = () => {
    if (genId !== _playLocalFileGen) return
    if (_localEndedFired) return
    const dur = video.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    if (video.paused) return
    if (video.currentTime >= dur - 0.3) {
      _localEndedFired = true
      logger.info('[VideoPlayer] local video ended (timeupdate fallback), ct=', video.currentTime.toFixed(2), 'dur=', dur.toFixed(2))
      emit('ended')
    }
  }
  video.addEventListener('timeupdate', onTimeUpdate)

  _localEndedDetectorCleanup = () => {
    video.removeEventListener('ended', onVideoEnded)
    video.removeEventListener('timeupdate', onTimeUpdate)
  }
}

// ── FFmpeg 补丁 ──

function patchVideoDuration(video: HTMLVideoElement, realDuration: number): void {
  if (_ffmpegDurationCleanup) {
    _ffmpegDurationCleanup()
    _ffmpegDurationCleanup = null
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

  _ffmpegDurationCleanup = () => {
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
      return origGet() + offset
    },
    set(v: number) {
      if (!active) { origSet(v); return }
      _ffmpegUserSeekTarget = v
      const raw = Math.max(0, v - offset)
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

function setupFfmpegSeekHandler(video: HTMLVideoElement, url: string, genId: number, totalDuration: number): void {
  cleanupFfmpegSeek()

  let seekDebounce: ReturnType<typeof setTimeout> | null = null
  let pendingSeekTime = 0

  const onSeeking = () => {
    if (_ffmpegSeeking) return
    if (_ffmpegSuppressNextSeek && _ffmpegUserSeekTarget <= 0) {
      logger.info('[VideoPlayer] FFmpeg seek suppressed (post-rebuild init, not user-initiated)')
      return
    }

    const targetTime = _ffmpegUserSeekTarget > 0 ? _ffmpegUserSeekTarget : video.currentTime
    _ffmpegUserSeekTarget = 0
    if (targetTime <= 0.5) return
    if (totalDuration > 0 && targetTime >= totalDuration - 1) return

    pendingSeekTime = targetTime
    if (seekDebounce) clearTimeout(seekDebounce)
    seekDebounce = setTimeout(async () => {
      seekDebounce = null
      if (genId !== _playLocalFileGen) return
      _ffmpegSeeking = true
      _ffmpegUserSeekTarget = 0
      const seekTarget = pendingSeekTime
      logger.info('[VideoPlayer] FFmpeg seek to:', seekTarget.toFixed(1), 's (target from user)')
      await playLocalFfmpeg(url, genId, seekTarget)
      _ffmpegSeeking = false

      _ffmpegSuppressNextSeek = true
      if (_ffmpegSuppressSeekTimer) clearTimeout(_ffmpegSuppressSeekTimer)
      _ffmpegSuppressSeekTimer = setTimeout(() => {
        _ffmpegSuppressNextSeek = false
        _ffmpegSuppressSeekTimer = null
      }, 500)
    }, 300)
  }

  video.addEventListener('seeking', onSeeking)
  _ffmpegSeekCleanup = () => {
    video.removeEventListener('seeking', onSeeking)
    if (seekDebounce) { clearTimeout(seekDebounce); seekDebounce = null }
  }
}

async function tryFfmpegStreamFallback(video: HTMLVideoElement, url: string): Promise<void> {
  const capturedGenId = loadGenerationId
  const capturedHeaders = { ...lastLoadHeaders }

  if (store.decodeMode !== 'auto') {
    logger.warn(`[VideoPlayer] tryFfmpegStreamFallback: ${store.decodeMode} 模式禁止跨模式回退`)
    return
  }

  if (!store.ffmpegPath) {
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
    if (capturedGenId !== loadGenerationId) return
    if (sess && sess.proxyUrl) {
      ffmpegSourceUrl = sess.proxyUrl
      logger.info(`[VideoPlayer] auto FFmpeg fallback: gateway via proxy ${ffmpegSourceUrl}`)
    }
  }

  try {
    const result = await sessionManager.createFfmpegSession(ffmpegSourceUrl, capturedHeaders, store.ffmpegPath)
    if (capturedGenId !== loadGenerationId) return
    if (result && result.success && result.proxyUrl) {
      currentFormat = 'mp4'
      logger.info(`[VideoPlayer] auto: FFmpeg fallback session created, proxyUrl=${result.proxyUrl}, duration=${result.duration}`)
      video.src = result.proxyUrl

      // ── 视频事件诊断 ──
      const diagGenId2 = capturedGenId
      const onDiagProgress = () => {
        if (diagGenId2 !== loadGenerationId) return
        const buffered = video.buffered
        const lastEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0
        logger.info(`[VideoPlayer] auto FFmpeg: buffered up to ${lastEnd > 0 ? lastEnd.toFixed(1) : '0'}s, readyState=${video.readyState}`)
      }
      const onDiagStalled = () => {
        if (diagGenId2 !== loadGenerationId) return
        logger.warn(`[VideoPlayer] auto FFmpeg: STALLED, readyState=${video.readyState}, ct=${video.currentTime.toFixed(2)}`)
      }
      const onDiagSuspend = () => {
        if (diagGenId2 !== loadGenerationId) return
        logger.info(`[VideoPlayer] auto FFmpeg: SUSPEND, readyState=${video.readyState}`)
      }
      const onDiagEnded = () => {
        if (diagGenId2 !== loadGenerationId) return
        logger.warn(`[VideoPlayer] auto FFmpeg: ENDED unexpectedly, ct=${video.currentTime.toFixed(2)}, dur=${video.duration}`)
        if (!hasEverPlayed && video.duration < 1 && video.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
          logger.warn('[VideoPlayer] auto FFmpeg: premature ENDED, retrying play() after 300ms')
          setTimeout(() => {
            if (diagGenId2 === loadGenerationId && video.src === result.proxyUrl) {
              video.play().then(() => {
                logger.info('[VideoPlayer] auto FFmpeg: play() retry after premature ENDED succeeded')
                hasEverPlayed = true
              }).catch(() => {})
            }
          }, 300)
        }
      }
      let _ffmpegDiagLastTime2 = -999
      const onDiagTimeUpdate = () => {
        if (diagGenId2 !== loadGenerationId) return
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
            if (capturedGenId === loadGenerationId && video.src === result.proxyUrl) {
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
      if (getIsMirroring()) restartMirrorStream(art)
    } else {
      logger.warn('[VideoPlayer] auto: FFmpeg 回退失败:', result?.error)
    }
  } catch (e) {
    if (capturedGenId !== loadGenerationId) return
    logger.warn('[VideoPlayer] auto: FFmpeg 回退出错:', e)
  }
}

// ── 本地文件播放 ──

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
  if (!art) return
  const video = art.video as HTMLVideoElement
  disposeHlsFlvAudio(video)
  await closeCurrentSession()
  currentFormat = 'mp4'

  video.removeAttribute('src')
  art.type = 'mp4'
  art.switchUrl(url)
  if (getIsMirroring()) restartMirrorStream(art)
}

async function playLocalSoftware(url: string, genId: number, allowFfmpegFallback: boolean = false): Promise<void> {
  if (!art) return
  const video = art.video as HTMLVideoElement
  disposeHlsFlvAudio(video)
  await closeCurrentSession()

  const ext = getLocalExt(url)

  if (MPEGTS_FLV_EXTS.has(ext)) {
    logger.info(`[VideoPlayer] software: .${ext} → mpegts-flv`)
    currentFormat = 'flv'
    const httpUrl = await toLocalHttpUrl(url)
    if (genId !== _playLocalFileGen) return
    loadMpegtsPlayer(video, httpUrl || url, 'flv', false, allowFfmpegFallback)
  } else if (MPEGTS_STREAM_EXTS.has(ext)) {
    logger.info(`[VideoPlayer] software: .${ext} → mpegts-ts`)
    currentFormat = 'ts'
    const httpUrl = await toLocalHttpUrl(url)
    if (genId !== _playLocalFileGen) return
    loadMpegtsPlayer(video, httpUrl || url, 'ts', false, allowFfmpegFallback)
  } else if (HLS_EXTS.has(ext)) {
    logger.info(`[VideoPlayer] software: .${ext} → hls.js`)
    currentFormat = 'm3u8'
    const httpUrl = await toLocalHttpUrl(url)
    if (genId !== _playLocalFileGen) return
    const playUrl = httpUrl || url
    if (Hls.isSupported()) {
      const hls = new Hls()
      attachHls(video, hls, (data) => {
        logger.warn('[VideoPlayer] software HLS local error:', data.type, data.details)
        if (data.fatal) {
          logger.warn('[VideoPlayer] software mode: local HLS fatal, destroying instance')
          hls.destroy()
          ;(video as any).hls = null
        }
      })
      hls.loadSource(playUrl)
      video.play().catch(() => {})
    } else {
      logger.warn('[VideoPlayer] software: Hls.js not available, cannot play m3u8 in software mode')
      return
    }
  } else {
    logger.warn(`[VideoPlayer] software: .${ext} unexpected in playLocalSoftware, no handler`)
    return
  }
  if (getIsMirroring()) restartMirrorStream(art)
}

async function playLocalFfmpeg(url: string, genId: number, seekTime?: number): Promise<void> {
  if (!art) return
  const video = art.video as HTMLVideoElement
  disposeHlsFlvAudio(video)

  video.pause()
  video.removeAttribute('src')
  video.load()
  await closeCurrentSession()

  if (!store.ffmpegPath) {
    logger.warn('[VideoPlayer] FFmpeg not available: ffmpegPath=' + store.ffmpegPath)
    return
  }

  logger.info('[VideoPlayer] FFmpeg creating session for:', url, 'seekTime=', seekTime)

  try {
    const result = await sessionManager.createFfmpegSession(url, {}, store.ffmpegPath, seekTime)
    if (genId !== _playLocalFileGen) return
    logger.info('[VideoPlayer] FFmpeg session result:', JSON.stringify({
      success: result?.success,
      sessionId: result?.sessionId,
      proxyUrl: result?.proxyUrl,
      error: result?.error ? String(result.error).substring(0, 300) : undefined,
    }))
    if (result && result.success && result.proxyUrl && art) {
      currentFormat = 'mp4'
      const effectiveSeek = (typeof seekTime === 'number' && seekTime > 0) ? seekTime : _ffmpegSeekOffset
      _ffmpegSeekOffset = effectiveSeek
      if (result.duration && result.duration > 0) {
        logger.info('[VideoPlayer] FFmpeg probed duration:', result.duration.toFixed(1), 's')
        patchVideoDuration(video, result.duration)
      }
      _ffmpegCurrentTimeCleanup = patchVideoCurrentTime(video, effectiveSeek)
      video.src = result.proxyUrl
      video.play().catch(() => {})
      setupFfmpegSeekHandler(video, url, genId, result.duration || 0)
      if (getIsMirroring()) restartMirrorStream(art)
      return
    }
    logger.warn('[VideoPlayer] FFmpeg local session failed:', result?.error)
  } catch (e) {
    logger.warn('[VideoPlayer] FFmpeg local error:', e)
  }
}

async function playLocalAudio(url: string, genId: number): Promise<void> {
  if (!art) return
  disposeAudioPlayer()
  await closeCurrentSession()

  const ext = getLocalExt(url)
  logger.info(`[VideoPlayer] AudioPlayer loading: .${ext} from ${url.substring(0, 80)}...`)

  const player = new SoftwareAudioPlayer()

  player.on('ready', () => {
    if (genId !== _playLocalFileGen) { player.destroy(); return }
    logger.info(`[VideoPlayer] AudioPlayer ready: .${ext}, duration=${player.duration.toFixed(1)}s`)
    currentFormat = 'mp4'
    player.setVolume(lastAudioVolume)
    player.setMuted(lastAudioMuted)
    player.play()
  })

  player.on('play', () => {
    if (genId !== _playLocalFileGen) return
    hasEverPlayed = true
    emit('playing')
  })

  player.on('pause', () => { emit('pause') })

  player.on('ended', () => {
    if (genId !== _playLocalFileGen) return
    emit('ended')
  })

  player.on('error', (err) => {
    logger.warn(`[VideoPlayer] AudioPlayer error for .${ext}:`, err.message)
    disposeAudioPlayer()
  })

  audioPlayer = player

  try {
    await player.load(url)
  } catch (err) {
    logger.warn(`[VideoPlayer] AudioPlayer load failed for .${ext}:`, err)
    disposeAudioPlayer()
  }
}

// ── MPV 弹窗播放 ──

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
    store.openMpv()
    hasEverPlayed = true
    store.playing = true
    store.videoPaused = false
    emit('playing')
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
    store.openMpv()
    hasEverPlayed = true
    store.playing = true
    store.videoPaused = false
    emit('playing')
    return true
  } catch (e) {
    logger.warn(`[VideoPlayer] startVlc: EXCEPTION: ${e}`)
    return false
  }
}

async function playLocalMpv(url: string, genId: number): Promise<void> {
  if (!art) {
    logger.warn('[VideoPlayer] playLocalMpv: art is null, aborting')
    return
  }
  logger.info(`[VideoPlayer] playLocalMpv: entering, url=${url.substring(0, 120)}, genId=${genId}`)

  const video = art.video as HTMLVideoElement
  disposeHlsFlvAudio(video)
  video.pause()
  video.removeAttribute('src')
  video.load()
  await closeCurrentSession()

  if (!store.mpvPath) {
    logger.warn('[VideoPlayer] playLocalMpv: mpvPath is EMPTY, cannot start MPV')
    return
  }

  logger.info(`[VideoPlayer] playLocalMpv: launching MPV, path=${store.mpvPath}, url=${url.substring(0, 120)}`)

  try {
    await startMpv(url, {}, store.mpvPath, genId, genId)
  } catch (e) {
    logger.warn(`[VideoPlayer] playLocalMpv: EXCEPTION: ${e}`)
  }
}

async function playLocalVlc(url: string, genId: number): Promise<void> {
  if (!art) {
    logger.warn('[VideoPlayer] playLocalVlc: art is null, aborting')
    return
  }
  logger.info(`[VideoPlayer] playLocalVlc: entering, url=${url.substring(0, 120)}, genId=${genId}`)

  const video = art.video as HTMLVideoElement
  disposeHlsFlvAudio(video)
  video.pause()
  video.removeAttribute('src')
  video.load()
  await closeCurrentSession()

  if (!store.vlcPath) {
    logger.warn('[VideoPlayer] playLocalVlc: vlcPath is EMPTY, cannot start VLC')
    return
  }

  logger.info(`[VideoPlayer] playLocalVlc: launching VLC, path=${store.vlcPath}, url=${url.substring(0, 120)}`)

  try {
    await startVlc(url, {}, store.vlcPath, genId, genId)
  } catch (e) {
    logger.warn(`[VideoPlayer] playLocalVlc: EXCEPTION: ${e}`)
  }
}

let _playLocalFileGen = 0

async function playLocalFile(url: string): Promise<void> {
  const gen = ++_playLocalFileGen
  if (!art) return

  lastLoadUrl = url
  cleanupFfmpegPatches()
  _ffmpegSeeking = false
  _ffmpegSuppressNextSeek = false

  const ext = getLocalExt(url)
  const mode = store.decodeMode

  logger.info(`[VideoPlayer] local play: ext=.${ext}, decode=${mode}`)

  const isAudio = AUDIO_EXTS.has(ext)
  const isNativeVideo = NATIVE_PLAYABLE_EXTS.has(ext) && !isAudio
  const isStream = MPEGTS_FLV_EXTS.has(ext) || MPEGTS_STREAM_EXTS.has(ext) || HLS_EXTS.has(ext)

  switch (mode) {
    case 'hardware': {
      if (isAudio) {
        logger.info(`[VideoPlayer] hardware: .${ext} → 硬解 (native audio)`)
        await playLocalNative(url)
      } else if (isNativeVideo) {
        logger.info(`[VideoPlayer] hardware: .${ext} → 硬解 (native)`)
        await playLocalNative(url)
      } else {
        logger.warn(`[VideoPlayer] hardware: .${ext} not supported by native playback, hardware mode forbids software/FFmpeg fallback`)
      }
      break
    }

    case 'software': {
      if (isStream) {
        logger.info(`[VideoPlayer] software: .${ext} → 软解 (hls.js/mpegts.js)`)
        await playLocalSoftware(url, gen, false)
        if (gen !== _playLocalFileGen) return
      } else if (isAudio) {
        logger.info(`[VideoPlayer] software: .${ext} → 软解 (AudioPlayer)`)
        const httpUrl = await toLocalHttpUrl(url)
        if (gen !== _playLocalFileGen) return
        await playLocalAudio(httpUrl || url, gen)
        if (gen !== _playLocalFileGen) return
      } else {
        logger.warn(`[VideoPlayer] software: .${ext} not supported by hls.js/mpegts.js/AudioPlayer, software mode forbids native/FFmpeg fallback`)
      }
      break
    }

    case 'ffmpeg': {
      logger.info(`[VideoPlayer] ffmpeg: .${ext} → FFmpeg`)
      await playLocalFfmpeg(url, gen)
      if (gen !== _playLocalFileGen) return
      break
    }

    case 'mpv': {
      logger.info(`[VideoPlayer] mpv: .${ext} → MPV`)
      await playLocalMpv(url, gen)
      if (gen !== _playLocalFileGen) return
      break
    }

    case 'vlc': {
      logger.info(`[VideoPlayer] vlc: .${ext} → VLC`)
      await playLocalVlc(url, gen)
      if (gen !== _playLocalFileGen) return
      break
    }

    default: {
      // auto: 内置解码 (按格式) → 报错触发回退 MPV→VLC→FFmpeg

      _autoFallbackUrl = url
      _autoFallbackHeaders = {}
      _autoFallbackGenId = gen

      if (isAudio) {
        logger.info(`[VideoPlayer] auto: .${ext} → 软解 (AudioPlayer)`)
        const httpUrl = await toLocalHttpUrl(url)
        if (gen !== _playLocalFileGen) break
        await playLocalAudio(httpUrl || url, gen)
      } else if (isNativeVideo) {
        logger.info(`[VideoPlayer] auto: .${ext} → 硬解 (native)`)
        await playLocalNative(url)
      } else if (isStream) {
        logger.info(`[VideoPlayer] auto: .${ext} → 软解 (hls.js/mpegts.js)`)
        await playLocalSoftware(url, gen, true)
      } else {
        logger.info(`[VideoPlayer] auto: .${ext} → 外部解码链 (格式无法识别)`)
        if (store.mpvPath) {
          await playLocalMpv(url, gen)
          if (gen !== _playLocalFileGen) break
          if (hasEverPlayed) break
        }
        if (store.vlcPath) {
          await playLocalVlc(url, gen)
          if (gen !== _playLocalFileGen) break
          if (hasEverPlayed) break
        }
        if (store.ffmpegPath) {
          await playLocalFfmpeg(url, gen)
        }
      }
      break
    }
  }

  setupLocalEndedDetector(gen)
}

// ── mpegts.js 播放器 ──

function loadMpegtsPlayer(video: HTMLVideoElement, url: string, format: string = 'flv', isLive: boolean = true, allowFfmpegFallback: boolean = false): void {
  const decodeMode = store.decodeMode

  if (!mpegts.isSupported || !mpegts.isSupported()) {
    if (allowFfmpegFallback) {
      logger.warn('[VideoPlayer] auto: mpegts.js不支持, 回退 FFmpeg')
      tryFfmpegStreamFallback(video, url)
    } else {
      logger.warn(`[VideoPlayer] mpegts.js not supported, ${decodeMode} mode forbids cross-mode fallback — cannot play`)
    }
    return
  }

  const mpegtsType = format === 'ts' ? 'mpegts' : 'flv'
  const v = video as any

  const player = mpegts.createPlayer({
    type: mpegtsType,
    url,
    isLive,
    cors: true,
    withCredentials: false,
  }, {
    enableWorker: true,
    enableStashBuffer: true,
    stashInitialSize: 2048,
    isLive,
    liveBufferLatencyChasing: isLive,
    liveBufferLatencyChasingOnPaused: false,
    liveBufferLatencyMinRemain: 5,
    liveBufferLatencyMaxLatency: 180,
    liveSync: false,
    lazyLoad: true,
    lazyLoadMaxDuration: 180,
    lazyLoadRecoverDuration: 30,
  })

  player.on(mpegts.Events.ERROR, (errType: string, errDetail: string) => {
    logger.warn('[VideoPlayer] mpegts error:', errType, errDetail)
    if (errType === 'networkError' && hasEverPlayed) {
      startStallWatchdog()
    }
  })

  player.on(mpegts.Events.METADATA_ARRIVED, () => { clearSourceTimeout() })
  player.on(mpegts.Events.MEDIA_INFO, () => { clearSourceTimeout() })

  player.attachMediaElement(video)
  player.load()
  v.flv = player

  video.play().catch(() => {})
}

// ── 创建 Artplayer 实例 ──

async function createPlayer(): Promise<void> {
  if (!playerEl.value) return
  await destroyPlayer()

  const playerOptions: Record<string, unknown> = {
    container: playerEl.value as HTMLDivElement,
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
    },
    customType: {
      m3u8(video: HTMLVideoElement, url: string) {
        if (!url) return
        disposeHls(video)
        const mode = store.decodeMode

        if (mode === 'ffmpeg') {
          logger.warn('[VideoPlayer] ffmpeg mode: m3u8 customType should not be called')
          return
        }

        if (mode === 'hardware') {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            logger.info('[VideoPlayer] hardware mode: native HLS supported, using video.src')
            video.src = url
          } else {
            logger.warn('[VideoPlayer] hardware mode: native HLS not available, hardware mode forbids hls.js fallback — cannot play m3u8')
          }
          return
        }

        if (mode === 'software') {
          if (Hls.isSupported()) {
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: false,
              maxBufferLength: 60,
              maxMaxBufferLength: 600,
              maxBufferSize: 120 * 1000 * 1000,
              highBufferWatchdogPeriod: 2,
              liveSyncDurationCount: 5,
              liveMaxLatencyDurationCount: 12,
              xhrSetup: (xhr: XMLHttpRequest, _reqUrl: string) => {
                if (lastLoadHeaders) {
                  for (const [k, v] of Object.entries(lastLoadHeaders)) {
                    try { xhr.setRequestHeader(k, v) } catch (_) {}
                  }
                }
              },
            })
            attachHls(video, hls, (data) => {
              logger.warn('[VideoPlayer] software HLS error:', data.type, data.details, 'fatal:', data.fatal)
              if (data.fatal) {
                logger.warn('[VideoPlayer] software mode: HLS fatal, software mode forbids FFmpeg fallback — destroying instance')
                clearSourceTimeout()
                hls.destroy()
                ;(video as any).hls = null
              } else if (data.details === 'mediaSourceRequiresReset') {
                logger.warn('[VideoPlayer] software mode: MediaSource 需要重置，尝试恢复...')
                try { hls.recoverMediaError() } catch (_) { /* 恢复失败则等待下次重试 */ }
              }
            }, () => { clearSourceTimeout() })
            hls.loadSource(url)
          } else {
            logger.warn('[VideoPlayer] software mode: hls.js not supported, software mode forbids FFmpeg fallback — cannot play m3u8')
          }
          return
        }

        if (Hls.isSupported()) {
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            maxBufferLength: 60,
            maxMaxBufferLength: 600,
            maxBufferSize: 120 * 1000 * 1000,
            highBufferWatchdogPeriod: 2,
            liveSyncDurationCount: 5,
            liveMaxLatencyDurationCount: 12,
            xhrSetup: (xhr: XMLHttpRequest, _reqUrl: string) => {
              if (lastLoadHeaders) {
                for (const [k, v] of Object.entries(lastLoadHeaders)) {
                  try { xhr.setRequestHeader(k, v) } catch (_) {}
                }
              }
            },
          })
          attachHls(video, hls, (data) => {
            logger.warn('[VideoPlayer] auto HLS error:', data.type, data.details, 'fatal:', data.fatal)
            if (data.fatal) {
              logger.warn('[VideoPlayer] auto: 软解HLS致命错误, 回退 FFmpeg')
              clearSourceTimeout()
              hls.destroy()
              ;(video as any).hls = null
              tryFfmpegStreamFallback(video, url)
            } else if (data.details === 'mediaSourceRequiresReset') {
              logger.warn('[VideoPlayer] auto: MediaSource 需要重置，尝试恢复...')
              try { hls.recoverMediaError() } catch (_) { /* 恢复失败则等待下次重试 */ }
            }
          }, () => { clearSourceTimeout() })
          hls.loadSource(url)
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url
        }
      },
      mp4(video: HTMLVideoElement, url: string) {
        if (!url) return
        const mode = store.decodeMode
        const lower = url.split('?')[0].split('#')[0].toLowerCase()
        const ext = lower.split('.').pop() || ''
        const isAudio = AUDIO_EXTS.has(ext)

        if (mode === 'software') {
          if (isAudio) {
            logger.info('[VideoPlayer] software: 音频 → 软解 (AudioPlayer)')
            disposeAudioPlayer()
            const player = new SoftwareAudioPlayer()
            audioPlayer = player
            player.on('ready', () => {
              currentFormat = 'mp4'
              loadGenerationId++
              confirmedFormat = 'mp4'
              logger.info('[VideoPlayer] AudioPlayer ready (software mode)')
            })
            player.on('ended', () => emit('ended'))
            player.on('error', () => {
              logger.warn('[VideoPlayer] software: AudioPlayer 播放失败, software 模式禁止 FFmpeg 回退')
              disposeAudioPlayer()
            })
            player.on('play', () => { hasEverPlayed = true; emit('playing') })
            player.load(url).then(() => {
              player.setVolume(art!.volume)
              player.setMuted(art!.muted)
              player.play()
            }).catch((err: Error) => {
              logger.warn('[VideoPlayer] AudioPlayer 加载失败:', err.message)
              disposeAudioPlayer()
            })
            return
          }
          logger.warn('[VideoPlayer] software: mp4 视频, software 模式禁止 native/FFmpeg 回退')
          return
        }

        if (mode === 'ffmpeg') {
          logger.warn('[VideoPlayer] ffmpeg: mp4 customType 不应被调用, FFmpeg 在 doLoad 中直接处理')
          return
        }

        if (mode === 'hardware') {
          if (isAudio) {
            logger.info('[VideoPlayer] hardware: 音频 → 硬解 (native audio)')
          } else {
            logger.info('[VideoPlayer] hardware: mp4 → 硬解 (native)')
          }
          disposeHls(video); disposeFlv(video); video.src = url
          return
        }

        // auto 模式: 音频 → 软解 (AudioPlayer), 失败回退 FFmpeg; 视频 → 硬解 (native)
        if (isAudio) {
          logger.info('[VideoPlayer] auto: 音频 → 软解 (AudioPlayer)')
          disposeAudioPlayer()
          const player = new SoftwareAudioPlayer()
          audioPlayer = player
          player.on('ready', () => {
            currentFormat = 'mp4'
            loadGenerationId++
            confirmedFormat = 'mp4'
            logger.info('[VideoPlayer] AudioPlayer ready (auto mode)')
          })
          player.on('ended', () => emit('ended'))
          player.on('error', () => {
            logger.info('[VideoPlayer] auto: AudioPlayer 播放失败, 回退 FFmpeg')
            disposeAudioPlayer()
            tryFfmpegStreamFallback(video, url)
          })
          player.on('play', () => { hasEverPlayed = true; emit('playing') })
          player.load(url).then(() => {
            player.setVolume(art!.volume)
            player.setMuted(art!.muted)
            player.play()
          }).catch((err: Error) => {
            logger.info('[VideoPlayer] auto: AudioPlayer 加载失败, 回退 FFmpeg:', err.message)
            disposeAudioPlayer()
            tryFfmpegStreamFallback(video, url)
          })
          return
        }

        logger.info('[VideoPlayer] auto: mp4 → 硬解 (native)')
        disposeHls(video); disposeFlv(video); video.src = url
      },
      flv(video: HTMLVideoElement, url: string) {
        if (!url) return
        disposeHls(video)
        disposeFlv(video)
        const mode = store.decodeMode

        if (mode === 'ffmpeg') {
          logger.warn('[VideoPlayer] ffmpeg mode: flv customType should not be called')
          return
        }

        if (mode === 'hardware') {
          logger.warn('[VideoPlayer] hardware mode: FLV not supported natively, hardware mode forbids software/FFmpeg fallback — cannot play FLV')
          return
        }

        if (mode === 'software') {
          try {
            loadMpegtsPlayer(video, url, 'flv', true, false)
          } catch (e) {
            logger.error('[VideoPlayer] software mode: mpegts(flv) init error, software mode forbids FFmpeg fallback:', e)
          }
          return
        }

        logger.info('[VideoPlayer] auto: FLV → 软解 (mpegts.js)')
        try {
          loadMpegtsPlayer(video, url, 'flv', true, true)
        } catch (e) {
          logger.error('[VideoPlayer] auto mode: mpegts(flv) init error:', e)
          tryFfmpegStreamFallback(video, url)
        }
      },
      ts(video: HTMLVideoElement, url: string) {
        disposeHls(video)
        disposeFlv(video)
        const mode = store.decodeMode

        if (mode === 'ffmpeg') {
          logger.warn('[VideoPlayer] ffmpeg mode: ts customType should not be called')
          return
        }

        if (mode === 'hardware') {
          logger.warn('[VideoPlayer] hardware mode: TS not supported natively, hardware mode forbids software/FFmpeg fallback — cannot play TS')
          return
        }

        if (mode === 'software') {
          try {
            loadMpegtsPlayer(video, url, 'ts', true, false)
          } catch (e) {
            logger.error('[VideoPlayer] software mode: mpegts(ts) init error, software mode forbids FFmpeg fallback:', e)
          }
          return
        }

        try {
          loadMpegtsPlayer(video, url, 'ts', true, true)
        } catch (e) {
          logger.error('[VideoPlayer] auto mode: mpegts(ts) init error:', e)
          tryFfmpegStreamFallback(video, url)
        }
      },
    },
  }

  art = new Artplayer(playerOptions as any)

  if (!props.url) {
    art.loading.show = false
    art.on('loading', (state: boolean) => {
      if (state && !props.url) {
        art!.loading.show = false
      }
    })
  }

  addCustomControls()

  art.on('ready', () => { clearSourceTimeout(); loadRetries = 0; loadGenerationId++; confirmedFormat = currentFormat; updateSubtitleIndicator() })
  art.on('play', () => { clearSourceTimeout(); clearStallWatchdog(); clearAutoSafetyTimer(); hasEverPlayed = true; emit('playing') })
  art.on('pause', () => { if (!art?.playing) emit('pause') })
  art.on('ended', () => {
    if (_localEndedFired) return
    if (store.activePlayMode === 'local') { _localEndedFired = true }
    const video = art?.video as HTMLVideoElement | null
    if (video && !hasEverPlayed && video.duration < 2 && store.decodeMode === 'ffmpeg') {
      logger.warn('[VideoPlayer] global ended ignored (FFmpeg premature end, duration < 2s, not yet played)')
      return
    }
    logger.info('[VideoPlayer] art ended')
    emit('ended')
  })

  art.on('error', () => {
    if (_errorRetryTimer) { clearTimeout(_errorRetryTimer); _errorRetryTimer = null }

    if (hasEverPlayed && lastLoadUrl) {
      const delay = 3000
      logger.warn(`[VideoPlayer] playback error, reconnecting in ${delay}ms`)
      const retryUrl = lastLoadUrl
      const retryHeaders = { ...lastLoadHeaders }
      const capturedGenId = loadGenerationId
      _errorRetryTimer = setTimeout(() => {
        _errorRetryTimer = null
        if (capturedGenId !== loadGenerationId) return
        loadUrl(retryUrl, retryHeaders)
      }, delay)
      return
    }

    if (store.decodeMode === 'auto' && !hasEverPlayed && _autoFallbackUrl) {
      logger.warn('[VideoPlayer] auto: error before play, 触发回退链')
      triggerAutoFallback().catch(() => {})
      return
    }

    loadRetries++
    if (loadRetries <= maxLoadRetries && lastLoadUrl) {
      const delay = Math.min(500 * Math.pow(2, loadRetries - 1), 5000)
      logger.warn(`[VideoPlayer] error, retry ${loadRetries}/${maxLoadRetries} in ${delay}ms`)
      const retryUrl = lastLoadUrl
      const retryHeaders = { ...lastLoadHeaders }
      const capturedGenId = loadGenerationId
      _errorRetryTimer = setTimeout(() => {
        _errorRetryTimer = null
        if (capturedGenId !== loadGenerationId) return
        loadUrl(retryUrl, retryHeaders)
      }, delay)
      return
    }

    clearSourceTimeout()
    stopCurrentPlayback()
    emit('error')
  })

  if (art.video) {
    const video = art.video as HTMLVideoElement
    const onWaiting = () => {
      if (hasEverPlayed) startStallWatchdog()
    }
    const onPlaying = () => {
      clearStallWatchdog()
      if (getIsMirroring()) restartMirrorStream(art)
    }
    const onCanplay = () => clearStallWatchdog()
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('canplay', onCanplay)
    _videoEventListenersCleanup = () => {
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('canplay', onCanplay)
    }
  }

  art.on('video:volumechange', () => {
    if (audioPlayer && art) {
      audioPlayer.setVolume(art.volume)
      audioPlayer.setMuted(art.muted)
    }
  })
}

// ── 核心加载逻辑 ──

function stopCurrentPlayback(): void {
  if (!art) return
  const video = art.video as HTMLVideoElement | null
  if (video) {
    try { video.pause() } catch (_) {}
    disposeHls(video)
    disposeFlv(video)
    try {
      video.removeAttribute('src')
      video.load()
    } catch (_) {}
    try { video.currentTime = 0 } catch (_) {}
    try {
      const v = video as any
      if (v.srcObject) { v.srcObject = null }
    } catch (_) {}
  }
  disposeAudioPlayer()
}

async function loadUrl(url: string, headers: Record<string, string>): Promise<void> {
  if (!art || !url) return
  clearSourceTimeout()
  clearStallWatchdog()
  clearAutoSafetyTimer()
  if (_errorRetryTimer) { clearTimeout(_errorRetryTimer); _errorRetryTimer = null }
  const modeChanged = lastPlayMode !== null && lastPlayMode !== store.activePlayMode
  const decodeChanged = lastDecodeMode !== null && lastDecodeMode !== store.decodeMode
  const isNewUrl = url !== lastLoadUrl
  if (isNewUrl || modeChanged || decodeChanged) {
    loadRetries = 0
    maxLoadRetries = MAX_RETRIES_PER_LINE
    loadGenerationId++
    confirmedFormat = null
    hasEverPlayed = false
    cleanupLocalEndedDetector()
    cleanupFfmpegPatches()
    _ffmpegSeeking = false
    _ffmpegSuppressNextSeek = false
  }
  stopCurrentPlayback()
  await closeCurrentSession()
  lastPlayMode = store.activePlayMode
  lastDecodeMode = store.decodeMode
  lastLoadUrl = url
  lastLoadHeaders = { ...headers }
  doLoad(url, lastLoadHeaders)
}

async function doLoad(url: string, headers: Record<string, string>): Promise<void> {
  const genId = loadGenerationId
  const externalPlay = isExternalPlay.value
  const playMode = store.activePlayMode

  if (url.startsWith('file://')) {
    if (playMode !== 'local') {
      logger.warn(`[VideoPlayer] file:// URL received but activePlayMode=${playMode}, redirecting to local play`)
    }
    if (genId !== loadGenerationId) return
    await playLocalFile(url)
    return
  }

  if (playMode === 'local') {
    logger.warn(`[VideoPlayer] local playMode but non-file URL: ${url.substring(0, 80)}... — treating as streaming`)
  }

  disposeAudioPlayer()
  cleanupLocalEndedDetector()
  cleanupFfmpegPatches()
  _ffmpegSeeking = false
  _ffmpegSuppressNextSeek = false

  const unsupportedProto = isUnsupportedProtocol(url)
  if (unsupportedProto) {
    logger.warn('[VideoPlayer] Unsupported protocol:', unsupportedProto, url)
    emit('error')
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

  const hasCustomHeaders = !!(headers['Referer'] || headers['referer'] || headers['Origin'] || headers['origin'])
  const directFmt = isDirectFormat(lowerPath)
  const hasFormatExt = lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u') ||
    lowerPath.endsWith('.flv') || lowerPath.endsWith('.ts') ||
    lowerPath.endsWith('.m2ts') || lowerPath.endsWith('.mts') ||
    isNativeExt(lowerPath)

  if (confirmedFormat && (isNativeExt(lowerPath) || lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u') || lowerPath.endsWith('.flv') || lowerPath.endsWith('.ts') || lowerPath.endsWith('.m2ts'))) {
    finalFormat = confirmedFormat
  } else if (confirmedFormat) {
    finalFormat = confirmedFormat
    if (!externalPlay) {
      try {
        await closeCurrentSession()
        const sess = await sessionManager.createProxySession(finalUrl, headers, finalFormat, await computePreferIpv6(finalUrl))
        if (genId !== loadGenerationId) return
        if (sess && sess.proxyUrl) {
          finalUrl = sess.proxyUrl
        }
      } catch (e) {
        logger.warn('[VideoPlayer] Confirmed proxy failed:', e)
      }
    }
  } else if (lowerPath.endsWith('.m3u8') || lowerPath.endsWith('.m3u')) {
    finalFormat = 'm3u8'
  } else if (lowerPath.endsWith('.flv')) {
    finalFormat = 'flv'
  } else if (lowerPath.endsWith('.ts') || lowerPath.endsWith('.m2ts')) {
    finalFormat = 'ts'
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
        if (genId !== loadGenerationId) return
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
      if (genId !== loadGenerationId) return
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

      if (probeResult.finalUrl && probeResult.finalUrl !== finalUrl) {
        const probeLower = probeResult.finalUrl.split('?')[0].split('#')[0].toLowerCase()
        if (!isGateway && (isNativeExt(probeLower) || probeLower.endsWith('.flv') || probeLower.endsWith('.m3u8') || probeLower.endsWith('.m3u') ||
            probeLower.endsWith('.ts') || probeLower.endsWith('.m2ts'))) {
          finalUrl = probeResult.finalUrl
        }
      }
    }

    if (!sessionManager.currentProxySessionId && !externalPlay && !hasFormatExt) {
      try {
        await closeCurrentSession()
        const sess = await sessionManager.createProxySession(finalUrl, headers, finalFormat, await computePreferIpv6(finalUrl))
        if (genId !== loadGenerationId) return
        if (sess && sess.proxyUrl) {
          finalUrl = sess.proxyUrl
        }
      } catch (e) {
        logger.warn('[VideoPlayer] Proxy failed, fallback direct:', e)
      }
    }
  }

  if (((externalPlay) || (directFmt && !externalPlay)) && hasCustomHeaders) {
    await networkInterceptor.registerForDirectPlay(finalUrl, headers, externalPlay)
  }

  if (genId !== loadGenerationId) return

  // ── FFmpeg 模式: 复用上面格式检测+代理, 固定 FFmpeg 解码 ──
  if (store.decodeMode === 'ffmpeg') {
    if (!store.ffmpegPath) {
      logger.warn('[VideoPlayer] FFmpeg mode: ffmpeg not available')
      return
    }
    disposeAudioPlayer()
    try {
      logger.info(`[VideoPlayer] FFmpeg: creating session for ${finalUrl.substring(0, 120)}`)
      const result = await sessionManager.createFfmpegSession(finalUrl, headers, store.ffmpegPath)
      if (genId !== loadGenerationId) return
      if (result && result.success && result.proxyUrl && art) {
        currentFormat = 'mp4'
        const video = art.video as HTMLVideoElement
        logger.info(`[VideoPlayer] FFmpeg: session created, proxyUrl=${result.proxyUrl}`)
        video.src = result.proxyUrl
        video.play().catch(() => {})
        hasEverPlayed = true
        if (getIsMirroring()) restartMirrorStream(art)
        return
      }
      logger.warn('[VideoPlayer] FFmpeg session failed:', result?.error)
    } catch (e) {
      logger.warn('[VideoPlayer] FFmpeg session create error:', e)
    }
    return
  }

  // ── MPV 模式: 通过 webview 内嵌 MPV 直接播放 ──
  if (store.decodeMode === 'mpv') {
    logger.info(`[VideoPlayer] doLoad: MPV mode, mpvPath=${store.mpvPath || '(EMPTY!)'}, url=${finalUrl.substring(0, 120)}`)
    if (!store.mpvPath) {
      logger.warn('[VideoPlayer] doLoad: MPV mode selected but mpvPath is EMPTY! Configure MPV path in Settings.')
      return
    }
    const vid = art!.video as HTMLVideoElement
    vid.pause()
    vid.removeAttribute('src')
    vid.load()
    disposeHlsFlvAudio(vid)
    disposeAudioPlayer()

    try {
      await startMpv(finalUrl, headers, store.mpvPath, genId, loadGenerationId)
    } catch (e) {
      logger.warn(`[VideoPlayer] doLoad: MPV EXCEPTION: ${e}`)
    }
    return
  }

  // ── VLC 模式: 弹窗播放 ──
  if (store.decodeMode === 'vlc') {
    logger.info(`[VideoPlayer] doLoad: VLC mode, vlcPath=${store.vlcPath || '(EMPTY!)'}, url=${finalUrl.substring(0, 120)}`)
    if (!store.vlcPath) {
      logger.warn('[VideoPlayer] doLoad: VLC mode selected but vlcPath is EMPTY! Configure VLC path in Settings.')
      return
    }
    const vid = art!.video as HTMLVideoElement
    vid.pause()
    vid.removeAttribute('src')
    vid.load()
    disposeHlsFlvAudio(vid)
    disposeAudioPlayer()

    try {
      await startVlc(finalUrl, headers, store.vlcPath, genId, loadGenerationId)
    } catch (e) {
      logger.warn(`[VideoPlayer] doLoad: VLC EXCEPTION: ${e}`)
    }
    return
  }

  const onlineExt = lowerPath.split('.').pop() || ''
  const isOnlineAudio = AUDIO_EXTS.has(onlineExt)

  const isUnknownFormat = finalFormat === 'unknown' || (!isOnlineAudio && finalFormat !== 'm3u8' && finalFormat !== 'flv' && finalFormat !== 'ts' && finalFormat !== 'mp4' && !isNativeExt(lowerPath))

  if (store.decodeMode === 'hardware') {
    const video = art!.video as HTMLVideoElement
    disposeHlsFlvAudio(video)
    currentFormat = finalFormat

    if (genId !== loadGenerationId) return

    if (isUnknownFormat) {
      logger.warn(`[VideoPlayer] hardware: .${finalFormat} 格式无法识别, hardware 模式禁止 software/FFmpeg 回退`)
    } else if (finalFormat === 'm3u8' || finalFormat === 'flv' || finalFormat === 'ts') {
      logger.warn(`[VideoPlayer] hardware: .${finalFormat} 不支持原生播放, hardware 模式禁止 software/FFmpeg 回退`)
    } else if (isOnlineAudio) {
      logger.info(`[VideoPlayer] hardware: .${onlineExt} → 硬解 (native audio)`)
      video.src = finalUrl
      video.play().catch(() => {})
    } else {
      logger.info(`[VideoPlayer] hardware: .${finalFormat} → 硬解 (native)`)
      video.src = finalUrl
      video.play().catch(() => {})
    }
    if (getIsMirroring()) restartMirrorStream(art)
    return
  }

  if (store.decodeMode === 'software') {
    currentFormat = finalFormat
    const video = art!.video as HTMLVideoElement
    disposeHlsFlvAudio(video)
    if (genId !== loadGenerationId) return
    if (isUnknownFormat) {
      logger.info(`[VideoPlayer] software: .${finalFormat} 格式未知, 尝试 M3U8 软解`)
      finalFormat = 'm3u8'
      currentFormat = 'm3u8'
      playViaSwitchUrl('m3u8', finalUrl)
    } else if (finalFormat === 'm3u8' || finalFormat === 'ts') {
      logger.info(`[VideoPlayer] software: .${finalFormat} → 软解 (hls.js/mpegts.js)`)
      playViaSwitchUrl(finalFormat, finalUrl)
    } else if (finalFormat === 'flv') {
      logger.info(`[VideoPlayer] software: .${finalFormat} → 软解 (mpegts.js)`)
      playViaSwitchUrl(finalFormat, finalUrl)
    } else if (isOnlineAudio) {
      logger.info(`[VideoPlayer] software: .${onlineExt} → 软解 (AudioPlayer)`)
      disposeAudioPlayer()
      const player = new SoftwareAudioPlayer()
      audioPlayer = player
      player.on('ready', () => {
        currentFormat = 'mp4'
        loadGenerationId++
        confirmedFormat = 'mp4'
        logger.info('[VideoPlayer] AudioPlayer ready (software mode)')
      })
      player.on('ended', () => emit('ended'))
      player.on('error', () => {
        logger.warn('[VideoPlayer] software: AudioPlayer 播放失败, software 模式禁止 FFmpeg 回退')
        disposeAudioPlayer()
      })
      player.on('play', () => { hasEverPlayed = true; emit('playing') })
      player.load(finalUrl).then(() => {
        player.setVolume(art!.volume)
        player.setMuted(art!.muted)
        player.play()
      }).catch((err: Error) => {
        logger.warn('[VideoPlayer] AudioPlayer 加载失败:', err.message)
        disposeAudioPlayer()
      })
    } else {
      logger.warn(`[VideoPlayer] software: .${finalFormat} video, software 模式禁止 native/FFmpeg 回退`)
    }
    if (getIsMirroring()) restartMirrorStream(art)
    return
  }

  // ── auto 模式: 硬解/软解 (按格式) → 错误触发回退 → 安全超时兜底 MPV→VLC→FFmpeg ──

  _autoFallbackUrl = finalUrl
  _autoFallbackHeaders = { ...headers }
  _autoFallbackGenId = loadGenerationId
  startAutoSafetyTimer()

  // Step 1: mp4/webm 等原生视频格式 → 硬解
  if (finalFormat === 'mp4' || isNativeExt(lowerPath)) {
    logger.info(`[VideoPlayer] auto: .${finalFormat} → 硬解 (native)`)
    currentFormat = finalFormat
    const video = art!.video as HTMLVideoElement
    disposeHlsFlvAudio(video)
    if (genId !== loadGenerationId) return
    video.src = finalUrl
    video.play().catch(() => {})
    if (getIsMirroring()) restartMirrorStream(art)
    return
  }

  // Step 2: FLV → 软解 (mpegts.js)
  if (finalFormat === 'flv') {
    logger.info('[VideoPlayer] auto: FLV → 软解 (mpegts.js)')
    currentFormat = 'flv'
    const video = art!.video as HTMLVideoElement
    disposeHlsFlvAudio(video)
    if (genId !== loadGenerationId) return
    playViaSwitchUrl('flv', finalUrl)
    return
  }

  // Step 3: 音频格式 → 软解 (AudioPlayer)
  if (isOnlineAudio) {
    logger.info(`[VideoPlayer] auto: .${onlineExt} → 软解 (AudioPlayer)`)
    currentFormat = finalFormat
    disposeAudioPlayer()
    if (genId !== loadGenerationId) return
    const player = new SoftwareAudioPlayer()
    audioPlayer = player
    player.on('ready', () => {
      currentFormat = 'mp4'
      loadGenerationId++
      confirmedFormat = 'mp4'
      clearAutoSafetyTimer()
      logger.info('[VideoPlayer] AudioPlayer ready (auto mode)')
    })
    player.on('ended', () => emit('ended'))
    player.on('error', () => {
      if (_autoFallbackGenId !== loadGenerationId) return
      logger.info('[VideoPlayer] auto: AudioPlayer 播放失败, 触发回退链')
      disposeAudioPlayer()
      triggerAutoFallback().catch(() => {})
    })
    player.on('play', () => { hasEverPlayed = true; emit('playing') })
    player.load(finalUrl).then(() => {
      player.setVolume(art!.volume)
      player.setMuted(art!.muted)
      player.play()
    }).catch((err: Error) => {
      if (_autoFallbackGenId !== loadGenerationId) return
      logger.info('[VideoPlayer] auto: AudioPlayer 加载失败, 触发回退链:', err.message)
      disposeAudioPlayer()
      triggerAutoFallback().catch(() => {})
    })
    if (getIsMirroring()) restartMirrorStream(art)
    return
  }

  // Step 4: m3u8/ts → 软解 (hls.js/mpegts.js)
  if (finalFormat === 'm3u8' || finalFormat === 'ts') {
    logger.info(`[VideoPlayer] auto: .${finalFormat} → 软解 (hls.js/mpegts.js)`)
    currentFormat = finalFormat
    const video = art!.video as HTMLVideoElement
    disposeHlsFlvAudio(video)
    if (genId !== loadGenerationId) return
    playViaSwitchUrl(finalFormat, finalUrl)
    return
  }

  // Step 5: 无法识别 → 尝试 M3U8 软解
  logger.info(`[VideoPlayer] auto: .${finalFormat} 格式未知, 尝试 M3U8 软解`)
  finalFormat = 'm3u8'
  currentFormat = 'm3u8'
  const unknownVideo = art!.video as HTMLVideoElement
  disposeHlsFlvAudio(unknownVideo)
  if (genId !== loadGenerationId) return
  playViaSwitchUrl('m3u8', finalUrl)
}

// ── 生命周期 ──

onMounted(async () => {
  await createPlayer()
  if (props.url) {
    loadUrl(props.url, props.headers)
  }
})

onUnmounted(() => destroyPlayer())

async function destroyPlayer(): Promise<void> {
  closePopup()
  clearSourceTimeout()
  clearStallWatchdog()
  if (_errorRetryTimer) { clearTimeout(_errorRetryTimer); _errorRetryTimer = null }
  loadRetries = 0
  loadGenerationId++
  hasEverPlayed = false
  lastPlayMode = null
  controlsAdded = false
  clearAutoSafetyTimer()
  await closeCurrentSession()
  destroyMirror()
  destroySubtitle()
  disposeAudioPlayer()
  cleanupLocalEndedDetector()
  if (_ffmpegStderrCleanup) { _ffmpegStderrCleanup(); _ffmpegStderrCleanup = null }
  if (_mainDebugLogCleanup) { _mainDebugLogCleanup(); _mainDebugLogCleanup = null }
  if (_videoEventListenersCleanup) { _videoEventListenersCleanup(); _videoEventListenersCleanup = null }
  if (art) {
    if (art.video) { disposeHls(art.video as HTMLVideoElement); disposeFlv(art.video as HTMLVideoElement) }
    art.destroy()
    art = null
  }
  sourceInfoEl = undefined
  lastLoadUrl = ''
  lastLoadHeaders = {}
}

watch(
  () => [props.url, props.headers, props.format, store.activePlayMode] as const,
  ([newUrl, newHeaders, , newMode], [, , , oldMode]) => {
    if (newMode !== oldMode) {
      updateControlLabels()
      if (!newMode) closeFloatWindow()
      if (art?.video) {
        disposeHls(art.video as HTMLVideoElement)
        disposeFlv(art.video as HTMLVideoElement)
      }
      disposeAudioPlayer()
      cleanupLocalEndedDetector()
      cleanupFfmpegPatches()
      _ffmpegSeeking = false
      _ffmpegSuppressNextSeek = false
      clearStallWatchdog()
      confirmedFormat = null
      currentFormat = ''
      hasEverPlayed = false
    }
    if (newUrl) loadUrl(newUrl as string, (newHeaders as Record<string, string>) || {})
  },
)

watch(() => props.volume, (v) => {
  if (art) art.volume = v
  lastAudioVolume = v
})

watch(() => props.muted, (m) => {
  if (art) art.muted = m
  lastAudioMuted = m
})

watch(() => props.info, () => updateSourceLabel(), { deep: true })

watch(() => store.decodeMode, (newMode, oldMode) => {
  if (newMode !== oldMode) {
    updateDecodeButton()
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
  if (url && art) {
    art.subtitle.switch(url, { type: 'vtt' })
      .then(() => {
        logger.info('[Subtitle] ArtPlayer subtitle loaded')
        applySubtitleStyle()
      })
      .catch((e: any) => logger.error('[Subtitle] ArtPlayer subtitle switch error:', e))
  }
})

watch(subtitleEnabled, (enabled) => {
  if (art) {
    art.subtitle.show = enabled
  }
  updateSubtitleIndicator()
})

watch(() => store.subtitleStyleVersion, () => {
  if (art && subtitleVttUrl.value) {
    applySubtitleStyle()
  }
})

defineExpose({
  play() { art?.play() },
  pause() { art?.pause() },
  toggle() { art ? (art.playing ? art.pause() : art.play()) : null },
  getCurrentTime() { return art?.currentTime || 0 },
  getVideo() { return art?.video as HTMLVideoElement | null },
  playLocalFile,
})
</script>

<style scoped>
.video-player-container { width: 100%; height: 100%; position: relative; background: #000; }
.video-inner { width: 100%; height: 100%; background: #000; }
.video-inner :deep(.artplayer-app) { width: 100% !important; height: 100% !important; }
.video-inner :deep(.artplayer-controls) {
  width: 100% !important;
  left: 0 !important;
  right: 0 !important;
  pointer-events: auto !important;
  z-index: 50 !important;
}
.video-inner :deep(.artplayer-controls-right) {
  pointer-events: auto !important;
}
.video-inner :deep(.artplayer-control) {
  pointer-events: auto !important;
}
.video-inner :deep(.art-bottom) {
  overflow: visible !important;
  z-index: 9999 !important;
}
.video-inner :deep(.art-settings) {
  z-index: 99999 !important;
}
.video-inner :deep(.art-info) {
  z-index: 99999 !important;
}
.video-inner :deep(.art-contextmenus) {
  z-index: 99999 !important;
}
.video-inner :deep(.art-layers) {
  z-index: 99999 !important;
}
.video-inner :deep(.pclive-sub-indicator) {
  font-weight: 800; padding: 2px 6px; border-radius: 3px; font-size: 11px;
}
.video-inner :deep(.pclive-sub-indicator.on) { color: #4ade80; background: rgba(74,222,128,0.2); }
.video-inner :deep(.pclive-sub-indicator.off) { color: #666; }
.video-inner :deep(.pclive-float-btn) { font-size: 14px; padding: 2px 4px; cursor: pointer; }
.video-inner :deep(.pclive-float-btn:hover) { background: rgba(255,255,255,0.15); border-radius: 3px; }
.video-inner :deep(.pclive-decode-btn) {
  font-weight: 700; padding: 2px 6px; border-radius: 3px; font-size: 11px;
  cursor: pointer; color: #999; transition: all 0.2s;
}
.video-inner :deep(.pclive-decode-btn.decode-hw) { color: #4fc3f7; background: rgba(79,195,247,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-sw) { color: #ff9800; background: rgba(255,152,0,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-ff) { color: #66bb6a; background: rgba(102,187,106,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-mpv) { color: #f48fb1; background: rgba(244,143,177,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-vlc) { color: #ff8a65; background: rgba(255,138,101,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-auto) { color: #b0b0b0; background: rgba(180,180,180,0.15); }
.video-inner :deep(.pclive-decode-btn:hover) { background: rgba(255,255,255,0.15); border-radius: 3px; }
.video-inner :deep(.pclive-playmode-btn) {
  color: #a78bfa; background: rgba(167,139,250,0.2); font-weight: 600;
  padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; transition: all 0.2s;
}
.video-inner :deep(.pclive-playmode-btn:hover) { background: rgba(167,139,250,0.35); color: #c4b5fd; }
</style>

<style>
.pclive-popup-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: transparent;
}
.pclive-popup-menu {
  background: #1e1e2e;
  border: 1px solid #3a3a4a;
  border-radius: 8px;
  padding: 4px 0;
  min-width: 100px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.55);
}
.pclive-popup-item {
  padding: 7px 16px;
  font-size: 12px;
  color: #aaa;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.pclive-popup-item:hover {
  background: rgba(255,255,255,0.08);
  color: #fff;
}
.pclive-popup-item.active {
  color: #fff;
  font-weight: 700;
  background: rgba(255,255,255,0.06);
}
.pclive-popup-item.decode-auto { color: #b0b0b0; }
.pclive-popup-item.decode-hw { color: #4fc3f7; }
.pclive-popup-item.decode-sw { color: #ff9800; }
.pclive-popup-item.decode-mpv { color: #f48fb1; }
.pclive-popup-item.decode-vlc { color: #ff8a65; }
.pclive-popup-item.decode-ff { color: #66bb6a; }
.pclive-popup-item:hover.decode-hw,
.pclive-popup-item:hover.decode-sw,
.pclive-popup-item:hover.decode-mpv,
.pclive-popup-item:hover.decode-vlc,
.pclive-popup-item:hover.decode-ff,
.pclive-popup-item:hover.decode-auto { color: #fff; }
</style>