/**
 * useRecorder — 主窗口内直录 composable
 *
 * 录屏不再依赖悬浮窗 / 离屏副本窗口，而是直接从统一流接口（PlaybackStreamHub）
 * 取主窗口 <video> 元素 captureStream() 派生的 MediaStream（视频 + 音频），
 * 用 MediaRecorder 编码后通过 recording:writeChunk 写入文件。
 *
 * 适用：内置解码（hls.js / mpegts.js / ffmpeg / 原生）、本地视频、嗅探流等
 *       存在主窗口 <video> 元素的播放场景。
 * 不适用：外部播放器（MPV / VLC）与网页版 webview，二者没有主窗口 <video> 可捕获。
 *
 * 录屏期间切换频道 / 线路会导致主窗口 <video> 重建：record 消费者会收到新的
 * MediaStream，此时自动用新流继续录制（写流在主进程保持追加，不重开文件）。
 * 采用 generation 计数忽略旧 recorder 的 onstop，避免替换过程中误触发收尾。
 *
 * 音量：录屏音量完全由主界面音量控制模块（store.volume / store.muted）决定。
 * captureStream 派生的原始音轨会被 PlaybackStreamHub 的 createMediaElementSource 旁路截断
 * （音频 RMS 恒为 0），因此录屏音轨直接复用 hub 内的「录屏分支」
 * （elementSrc → recordGain → recordDest），该分支的 GainNode 已由 hub.setMainVolume
 * 跟随主界面音量，录屏直接取 recordDest 输出音轨交给 MediaRecorder。
 */

import { ref } from 'vue'
import { logger } from '@/utils/logger'
import { playbackStreamHub } from '@/services/PlaybackStreamHub'
import type { PlaybackFrame } from '@/services/PlaybackStreamHub'

export type RecordingState = 'idle' | 'recording' | 'paused'

// 模块级单例状态：主窗口仅一个录屏会话，ToolsDialog 与其它调用方共享同一份状态。
const state = ref<RecordingState>('idle')
const elapsed = ref(0)
const statusText = ref('待机')
// 录屏会话启动时间戳（毫秒），用于与下载任务按打开顺序排序显示
const startedAt = ref(0)

let recorder: MediaRecorder | null = null
let recordTimer: ReturnType<typeof setInterval> | null = null
let streamLostTimer: ReturnType<typeof setTimeout> | null = null
let recorderGen = 0
let currentOptions: { outputPath?: string; quality?: string } | null = null
let listenerRegistered = false

// 录屏画质档位：统一输出分辨率（最长边等比缩放到档位、保持比例、黑边填充）
// high → 1080p(1920x1080)、medium → 720p(1280x720)、low → 480p(854x480)
const QUALITY_PRESETS: Record<string, { width: number; height: number; bitrate: number }> = {
  high: { width: 1920, height: 1080, bitrate: 8000000 },
  medium: { width: 1280, height: 720, bitrate: 4000000 },
  low: { width: 854, height: 480, bitrate: 2000000 },
}

// 离屏 Canvas 重采样：把任意输入分辨率统一绘制到固定档位画布（居中、黑边填充），
// 再从画布 captureStream 取固定分辨率视频轨交给 MediaRecorder。画布视频轨与音频图
// 输出音轨的 ID 全程恒定，切频道 / 切线路无需重建 recorder（画布持续绘制最新画面即可）。
let recCanvas: HTMLCanvasElement | null = null
let recCanvasCtx: CanvasRenderingContext2D | null = null
let recCanvasTrack: CanvasCaptureMediaStreamTrack | null = null
// 当前要绘制到画布的视频元素（切频道 / 切线路时跟随 frame.videoElement 更新）
let drawVideoEl: HTMLVideoElement | null = null
let rafId: number | null = null
let lastDrawTime = 0
const RECORD_FPS = 30

/** 取最新的活跃轨道（captureStream 切源时旧轨道仍为 live 但不再产数据，必须取末尾） */
function pickNewestLiveTrack(tracks: MediaStreamTrack[] | undefined | null): MediaStreamTrack | null {
  if (!tracks || !tracks.length) return null
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (tracks[i].readyState === 'live') return tracks[i]
  }
  return null
}

function targetSize(): { width: number; height: number } {
  const q = currentOptions?.quality || 'high'
  const preset = QUALITY_PRESETS[q] || QUALITY_PRESETS.high
  return { width: preset.width, height: preset.height }
}

function videoBitrate(): number {
  const q = currentOptions?.quality || 'high'
  const preset = QUALITY_PRESETS[q] || QUALITY_PRESETS.high
  return preset.bitrate
}

/** 创建固定档位分辨率的离屏画布，并取 captureStream(0) 视频轨（仅在 requestFrame 时出帧） */
function ensureCanvas(): boolean {
  if (recCanvas) return true
  try {
    const { width, height } = targetSize()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    recCanvas = canvas
    recCanvasCtx = ctx
    const videoTracks = canvas.captureStream(0).getVideoTracks()
    if (!videoTracks.length) return false
    recCanvasTrack = videoTracks[0] as CanvasCaptureMediaStreamTrack
    logger.log(`[Recorder][canvas] 已创建离屏画布 ${width}x${height}（档位=${currentOptions?.quality || 'high'}）`)
    return true
  } catch (e) {
    logger.warn('[Recorder][canvas] 创建离屏画布失败:', e)
    return false
  }
}

/**
 * 把当前视频帧绘制到离屏画布：最长边等比缩放到档位画布内（contain）、居中、黑边填充。
 * 若当前没有有效帧（切频道过渡 / 尚未加载新帧），则不重绘、保留画布上一帧内容，
 * 实现「静止画上一视频最后一帧」的效果。
 */
function paintCanvas(): void {
  const ctx = recCanvasCtx
  const canvas = recCanvas
  if (!ctx || !canvas) return
  const el = drawVideoEl
  if (!el || el.videoWidth <= 0 || el.videoHeight <= 0) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const vw = el.videoWidth
  const vh = el.videoHeight
  const scale = Math.min(canvas.width / vw, canvas.height / vh)
  const dw = Math.round(vw * scale)
  const dh = Math.round(vh * scale)
  const dx = Math.round((canvas.width - dw) / 2)
  const dy = Math.round((canvas.height - dh) / 2)
  try {
    ctx.drawImage(el, dx, dy, dw, dh)
  } catch (_) {}
}

function stopDrawLoop(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function startDrawLoop(): void {
  stopDrawLoop()
  lastDrawTime = 0
  const step = (now: number) => {
    rafId = requestAnimationFrame(step)
    if (state.value === 'idle') return
    if (now - lastDrawTime < 1000 / RECORD_FPS) return
    lastDrawTime = now
    paintCanvas()
    try { recCanvasTrack?.requestFrame() } catch (_) {}
  }
  rafId = requestAnimationFrame(step)
}

function disposeCanvas(): void {
  stopDrawLoop()
  drawVideoEl = null
  if (recCanvasTrack) {
    try { recCanvasTrack.stop() } catch (_) {}
    recCanvasTrack = null
  }
  recCanvas = null
  recCanvasCtx = null
}

/** 组装固定输出流：离屏画布视频轨 + hub 录屏分支音轨（跟随主界面音量），二者 ID 全程恒定 */
function buildRecordingStream(): MediaStream | null {
  if (!ensureCanvas() || !recCanvasTrack) return null
  const tracks: MediaStreamTrack[] = [recCanvasTrack]
  const audioTrack = playbackStreamHub.getRecordAudioTrack()
  if (audioTrack) tracks.push(audioTrack)
  return new MediaStream(tracks)
}

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ]
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch (_) {}
  }
  return ''
}

function startTimer(): void {
  stopTimer()
  recordTimer = setInterval(() => { elapsed.value++ }, 1000)
}

function stopTimer(): void {
  if (recordTimer) {
    clearInterval(recordTimer)
    recordTimer = null
  }
}

function clearStreamLostTimer(): void {
  if (streamLostTimer) {
    clearTimeout(streamLostTimer)
    streamLostTimer = null
  }
}

/** 本地收尾（不调用主进程 finish，供主进程兜底停止时复用） */
function resetLocal(): void {
  stopTimer()
  clearStreamLostTimer()
  playbackStreamHub.disableConsumer('record')
  // 录屏走独立离屏画布视频轨 + hub 录屏分支音轨，不触碰主窗口 <video> 的 captureStream
  // 轨道，因此这里只停止「录屏专用」的画布轨道，绝不影响悬浮窗 / 主界面。
  disposeCanvas()
  recorder = null
  recorderGen++
  state.value = 'idle'
  statusText.value = '待机'
  elapsed.value = 0
  startedAt.value = 0
}

/** 正常结束：先本地收尾（UI 立即退出「录制中」），再通知主进程完成写流 + 转码 */
async function finish(): Promise<void> {
  // 兜底：若 recorder 仍处于非 inactive（例如 stop() 未触发 onstop 的异常情况），强制停止
  if (recorder && recorder.state !== 'inactive') {
    try { recorder.onstop = null; recorder.stop() } catch (_) {}
  }
  resetLocal()
  // 主进程落盘 / WebM→MP4 转码异步进行，即使转码耗时或异常也不阻塞本地收尾
  try { await window.electronAPI?.recordingFinishStream() } catch (_) {}
}

function beginRecorder(stream: MediaStream): void {
  const gen = ++recorderGen
  const mimeType = pickMimeType()
  const videoBits = videoBitrate()

  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: videoBits })
  } catch (_) {
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    } catch (_) {
      rec = new MediaRecorder(stream)
    }
  }

  rec.ondataavailable = async (e: BlobEvent) => {
    if (e.data && e.data.size > 0) {
      try {
        const buf = await e.data.arrayBuffer()
        await window.electronAPI?.recordingWriteChunk(buf)
      } catch (_) {}
    }
  }

  rec.onstop = async () => {
    // 已被新 recorder 取代（切频道 / 切线路）时忽略，避免误触发收尾
    if (gen !== recorderGen) return
    await finish()
  }

  rec.start(1000)
  if (state.value === 'paused') {
    try { rec.pause() } catch (_) {}
  }
  recorder = rec
}

/**
 * record 消费者：录屏期间接收流变化（切频道 / 切线路 / 换播放模式）。
 *
 * 由于录屏走「离屏画布固定分辨率 + hub 录屏分支音轨」的固定输出流，两条轨道 ID 全程恒定，
 * 无需重建 MediaRecorder。这里只需更新要绘制的视频元素：切频道后画布自动绘制新画面，
 * 过渡期间画布保留上一帧 = 静止画；音轨来自 hub 的 recordDest 分支，天然跟随最新播放内容，
 * 切源过渡期间 elementSrc 短暂无数据即静音（符合要求），无需在此重绑定。
 */
function onFrame(frame: PlaybackFrame): void {
  if (state.value === 'idle') return
  const stream = frame.mediaStream
  if (frame.videoElement) drawVideoEl = frame.videoElement
  if (stream && pickNewestLiveTrack(stream.getVideoTracks())) {
    clearStreamLostTimer()
  } else {
    // 流暂时丢失（正在切换 / 停止播放）：等待新流，超时则结束。
    // 注意：过渡期间画布不重绘、保留上一帧内容，实现「静止画上一视频最后一帧」。
    if (!streamLostTimer) {
      streamLostTimer = setTimeout(async () => {
        streamLostTimer = null
        if (state.value !== 'idle') await finish()
      }, 5000)
    }
  }
}

async function startRecording(options?: { outputPath?: string; quality?: string }): Promise<boolean> {
  const api = window.electronAPI
  if (!api || state.value !== 'idle') return false

  const stream = playbackStreamHub.getMediaStream()
  if (!stream || stream.getVideoTracks().length === 0) {
    logger.warn('[Recorder] 当前播放模式无法获取视频流（外部播放器 / 网页版不支持直录）')
    return false
  }

  currentOptions = options || {}
  const startRes = await api.recordingStartStream({ outputPath: currentOptions.outputPath || '' })
  if (!startRes.success) {
    logger.error('[Recorder] recordingStartStream failed:', startRes.error)
    currentOptions = null
    return false
  }

  playbackStreamHub.enableConsumer('record')
  drawVideoEl = playbackStreamHub.getVideoElement()
  const recStream = buildRecordingStream()
  if (!recStream) {
    playbackStreamHub.disableConsumer('record')
    try { await api.recordingFinishStream() } catch (_) {}
    logger.warn('[Recorder] 启动失败：无法创建固定分辨率录制画布')
    currentOptions = null
    return false
  }
  beginRecorder(recStream)
  startDrawLoop()
  state.value = 'recording'
  statusText.value = '录制中'
  elapsed.value = 0
  startedAt.value = Date.now()
  startTimer()
  return true
}

async function stopRecording(): Promise<void> {
  if (state.value === 'idle') return
  if (recorder && recorder.state !== 'inactive') {
    const gen = recorderGen
    try { recorder.stop() } catch (_) {} // onstop → finish
    // 兜底：若 MediaRecorder.onstop 因异常未触发，3 秒后强制收尾，确保停止按钮永远生效
    setTimeout(() => {
      if (gen === recorderGen && state.value !== 'idle') void finish()
    }, 3000)
  } else {
    await finish()
  }
}

async function pauseRecording(): Promise<void> {
  if (state.value !== 'recording') return
  if (recorder) {
    try { recorder.pause() } catch (_) {}
  }
  await window.electronAPI?.recordingPause()
  state.value = 'paused'
  statusText.value = '已暂停'
  stopTimer()
}

async function resumeRecording(): Promise<void> {
  if (state.value !== 'paused') return
  if (recorder) {
    try { recorder.resume() } catch (_) {}
  }
  await window.electronAPI?.recordingResume()
  state.value = 'recording'
  statusText.value = '录制中'
  startTimer()
}

function ensureListeners(): void {
  if (listenerRegistered) return
  listenerRegistered = true

  playbackStreamHub.registerConsumer('record', onFrame)

  // 主进程兜底停止（6 小时自动停止等）时，同步停止本地 MediaRecorder
  if (window.electronAPI?.onRecordingStopped) {
    window.electronAPI.onRecordingStopped(() => {
      if (state.value === 'idle') return
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null
        try { recorder.stop() } catch (_) {}
      }
      resetLocal()
    })
  }
}

export function useRecorder() {
  ensureListeners()
  // 录屏音量不再单独监听 store.volume / store.muted：它直接复用 hub 内的录屏分支
  // （elementSrc → recordGain → recordDest），recordGain 由 applyMainVolume → setMainVolume
  // 统一跟随主界面音量，确保录屏音量完全由主界面音量控制模块决定。
  return {
    state,
    elapsed,
    statusText,
    startedAt,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
  }
}