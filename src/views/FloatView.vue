<template>
  <div
    ref="containerEl"
    class="float-container"
    @mouseenter="showControls = true"
    @mouseleave="showControls = false"
    @mousemove="onHoverMove"
    @mousedown="onMouseDown"
  >
    <!-- 顶部控制栏（自动显示/隐藏）：静音 / 音量 / 最大化 / 关闭 -->
    <div class="record-bar" :class="{ 'record-bar--hidden': !showControls }">
      <button class="record-bar__btn record-bar__btn--mute" @click.stop="toggleMute" :title="floatMuted ? '取消静音' : '静音'">
        <svg v-if="floatMuted || vol === 0" width="14" height="14" viewBox="0 0 18 18" fill="none">
          <path d="M2 6L5 6L9 2L9 16L5 12L2 12Z" fill="currentColor"/>
          <line x1="12" y1="6" x2="16" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="16" y1="6" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        <svg v-else-if="vol > 0.5" width="14" height="14" viewBox="0 0 18 18" fill="none">
          <path d="M2 6L5 6L9 2L9 16L5 12L2 12Z" fill="currentColor"/>
          <path d="M12 5.5C13.3 6.7 14 8.3 14 10C14 11.7 13.3 13.3 12 14.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 18 18" fill="none">
          <path d="M2 6L5 6L9 2L9 16L5 12L2 12Z" fill="currentColor"/>
          <path d="M11.5 7C12.2 7.8 12.5 8.9 12.5 10C12.5 11.1 12.2 12.2 11.5 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="record-bar__vol" @click.stop>
        <input
          type="range"
          class="record-bar__vol-slider"
          min="0"
          max="100"
          :value="Math.round(vol * 100)"
          @input="onVolumeChange"
        />
      </div>
      <button class="record-bar__btn record-bar__btn--max" @click.stop="toggleMaximize" title="最大化/还原">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="3.5" width="9" height="9" rx="0.5" stroke="currentColor" stroke-width="1.4"/></svg>
      </button>
      <button class="record-bar__btn record-bar__btn--close" @click.stop="handleClose" title="关闭悬浮窗">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>

    <!-- 播放区域 -->
    <div class="float-stage">
      <!-- 实时镜像视频：直接接收主窗口 <video> captureStream 派生的 WebRTC 流，画面/声音/状态 1:1 同步 -->
      <video
        ref="videoEl"
        v-show="source.type === 'stream'"
        class="float-video"
        autoplay
        playsinline
        :muted="floatMuted"
        @loadedmetadata="onVideoMetadata"
        @resize="onVideoResize"
        @playing="onPlaying"
        @waiting="onWaiting"
        @pause="onPause"
        @error="onVideoError"
      ></video>

      <div v-if="source.type === 'none'" class="float-empty">
        <p>未在播放</p>
        <p class="float-empty__sub">打开视频后将自动同步到此副本窗口</p>
      </div>

      <div v-if="connecting" class="float-loading">
        <div class="float-spinner"></div>
        <p>正在连接镜像...</p>
      </div>
      <div v-if="error" class="float-error">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { logger } from '@/utils/logger'

interface FloatSource {
  type: 'none' | 'stream'
  url?: string
  headers?: Record<string, string>
  format?: string
}

const videoEl = ref<HTMLVideoElement | null>(null)
const containerEl = ref<HTMLDivElement | null>(null)

const source = ref<FloatSource>({ type: 'none' })
const connecting = ref(false)
const error = ref('')

// 普通悬浮窗默认静音（仅画面副本），用户可手动取消静音 / 调音量，
// 取消静音后听到的声音与主窗口完全同源同步。
const floatMuted = ref(true)
const vol = ref(1.0)

// 是否处于全屏状态：全屏期间跳过尺寸贴合，避免与全屏布局冲突
const isFullscreen = ref(false)

// 顶部控制栏自动显示/隐藏：鼠标进入悬浮窗区域显示，离开立即隐藏（类似画中画）
const showControls = ref(false)

// 最近一次已应用的窗口尺寸（用于去重，避免 loadedmetadata / resize 重复触发时反复 resize）
let lastFitW = 0
let lastFitH = 0

// 悬浮窗默认尺寸基准：以视频最长边适配到 480。
// 横屏（宽≥高）：宽 = 480，高按原比例；竖屏（高>宽）：高 = 480，宽按原比例。
const BASE_LONGEST_EDGE = 480
// 极端宽高比下的最小窗口兜底
const MIN_FIT_W = 200
const MIN_FIT_H = 120

// 切源后延迟重贴合兜底定时器：新帧就绪前 videoWidth/videoHeight 仍是旧值，
// 等待新帧加载完成后再贴合，确保「切换频道即恢复默认 480 尺寸」。
let refitTimer: ReturnType<typeof setTimeout> | null = null

// WebRTC 接收端（悬浮窗 = answer 方）
let pc: RTCPeerConnection | null = null
let incomingStream: MediaStream | null = null
let cleanupFloatSource: (() => void) | null = null
let cleanupMirrorSignal: (() => void) | null = null
// float-ready 重发兜底：首次 / 重新打开时若 offer 因信令竞态丢失，悬浮窗侧主动重发
// float-ready，让主窗口重新发起协商，避免永久卡在「正在连接镜像」。
let floatReadyRetries = 0
let floatReadyTimer: ReturnType<typeof setTimeout> | null = null

function sendSignal(data: unknown): void {
  window.electronAPI?.mirrorSignal(data)
}

function scheduleFloatReadyRetry(): void {
  if (floatReadyRetries >= 3) return
  if (floatReadyTimer) return
  floatReadyTimer = setTimeout(() => {
    floatReadyTimer = null
    // 已收到镜像流或已切到非 stream 模式则无需重试
    if (incomingStream || source.value.type !== 'stream') return
    floatReadyRetries++
    logger.warn(`[Float] 未收到镜像流，重发 float-ready（第 ${floatReadyRetries} 次）`)
    sendSignal({ type: 'float-ready' })
    scheduleFloatReadyRetry()
  }, 2500)
}

function stopFloatReadyRetry(): void {
  if (floatReadyTimer) { clearTimeout(floatReadyTimer); floatReadyTimer = null }
}

async function toggleMaximize() {
  // 主进程返回切换后的真实全屏状态，避免渲染端手动翻转导致状态漂移
  //（例如用户用 Esc 退出全屏后本地标志未同步，再点按钮会反向判断）。
  const next = await window.electronAPI?.toggleFloatFullscreen()
  isFullscreen.value = !!next
  if (!isFullscreen.value) {
    // 退出全屏后延迟重新贴合视频尺寸：setFullScreen 的 OS 过渡是异步的，
    // 立即 resize 会被主进程因「窗口仍处于全屏」而忽略，导致窗口停留在
    // 全屏前的旧尺寸、视频显示异常。延迟等待过渡完成后再按视频宽高比恢复。
    lastFitW = 0
    lastFitH = 0
    setTimeout(() => {
      fitWindowToVideo()
    }, 200)
  }
}

/** 依据视频原生宽高比调整悬浮窗尺寸：以最长边 480 为基准（contain），消除 letterbox 黑边 */
function fitWindowToVideo() {
  if (isFullscreen.value) return
  const v = videoEl.value
  if (!v || !v.videoWidth || !v.videoHeight) return
  const vw = v.videoWidth
  const vh = v.videoHeight
  let winW: number
  let winH: number
  if (vw >= vh) {
    // 横屏（或正方形）：最长边是宽，固定为 480，高按原比例自适应
    winW = BASE_LONGEST_EDGE
    winH = Math.round(BASE_LONGEST_EDGE * vh / vw)
  } else {
    // 竖屏：最长边是高，固定为 480，宽按原比例自适应
    winH = BASE_LONGEST_EDGE
    winW = Math.round(BASE_LONGEST_EDGE * vw / vh)
  }
  winW = Math.max(MIN_FIT_W, winW)
  winH = Math.max(MIN_FIT_H, winH)
  if (winW === lastFitW && winH === lastFitH) return
  lastFitW = winW
  lastFitH = winH
  logger.log(`[Float][fit] 按视频最长边 480 调整窗口 vw=${vw} vh=${vh} → ${winW}x${winH}`)
  window.electronAPI?.resizeFloatWindow({ width: winW, height: winH })
}

function onVideoMetadata() {
  // 视频轨道就绪后即按原生宽高比调整窗口；切频道导致分辨率变化时会再次触发
  fitWindowToVideo()
}

function onVideoResize() {
  // 关键修复：WebRTC 切频道时，若轨道复用（ID 不变）主窗口不会重新协商，
  // 悬浮窗 srcObject 不变，因而不会再触发 loadedmetadata；但远端轨道分辨率
  // 变化时，<video> 的 videoWidth/videoHeight 会更新并触发原生 'resize' 事件。
  // 在这里兜底同步窗口尺寸，避免「切换频道后窗口仍是旧比例、出现大面积黑边」。
  const v = videoEl.value
  logger.log(`[Float][videoResize] 视频原生尺寸变为 vw=${v?.videoWidth} vh=${v?.videoHeight}`)
  fitWindowToVideo()
}

/** 延迟重贴合：切频道/切线路后新帧未必立即可用，稍后重试一次贴合默认 480 尺寸 */
function scheduleRefit() {
  if (refitTimer) { clearTimeout(refitTimer); refitTimer = null }
  refitTimer = setTimeout(() => {
    refitTimer = null
    fitWindowToVideo()
  }, 700)
}

// ── 全局拖动 + 自定义边缘缩放 ──
// 系统边缘缩放手柄已禁用（resizable:false），这里完全自定义：
// 1) 窗口内部（含视频画面区）按住 → 仅移动窗口位置，绝不缩放；
// 2) 鼠标移到窗口边线 N px 内 → 显示缩放光标，按住拖动 → 按视频原生比例缩放。
const RESIZE_EDGE = 6
const MIN_W = 200
const MIN_H = 120

type ResizeDir = '' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

let dragging = false
let dragStartScreenX = 0
let dragStartScreenY = 0
let dragStartWinX = 0
let dragStartWinY = 0
// 拖动开始时锁定的窗口尺寸：移动期间主进程用 setBounds 固定该尺寸，
// 避免单独 setPosition 在无边框窗口上触发 Windows 边框重算导致尺寸 +2/+1 膨胀。
let dragStartWinW = 0
let dragStartWinH = 0

let resizeDir: ResizeDir = ''
let rs = { mx: 0, my: 0, x: 0, y: 0, w: 0, h: 0, ratio: 16 / 9 }

function currentRatio(): number {
  const v = videoEl.value
  if (v && v.videoWidth && v.videoHeight) return v.videoWidth / v.videoHeight
  return window.innerWidth / window.innerHeight
}

function detectResizeDir(e: MouseEvent, target: HTMLElement | null): ResizeDir {
  // 控制栏区域只负责移动/按钮操作，不参与边缘缩放（避免顶部拖动被误判为缩放）
  if (target && target.closest('.record-bar')) return ''
  const l = e.clientX
  const r = window.innerWidth - e.clientX
  const t = e.clientY
  const b = window.innerHeight - e.clientY
  const L = l <= RESIZE_EDGE
  const R = r <= RESIZE_EDGE
  const T = t <= RESIZE_EDGE
  const B = b <= RESIZE_EDGE
  if (T && L) return 'nw'
  if (T && R) return 'ne'
  if (B && L) return 'sw'
  if (B && R) return 'se'
  if (L) return 'w'
  if (R) return 'e'
  if (T) return 'n'
  if (B) return 's'
  return ''
}

const RESIZE_CURSOR: Record<Exclude<ResizeDir, ''>, string> = {
  n: 'n-resize', s: 's-resize', e: 'e-resize', w: 'w-resize',
  ne: 'ne-resize', nw: 'nw-resize', se: 'se-resize', sw: 'sw-resize',
}

function onHoverMove(e: MouseEvent) {
  if (dragging || resizeDir) return
  const dir = detectResizeDir(e, e.target as HTMLElement | null)
  if (containerEl.value) containerEl.value.style.cursor = dir ? RESIZE_CURSOR[dir] : 'default'
}

function onMouseDown(e: MouseEvent) {
  // 仅左键触发
  if (e.button !== 0) return
  const t = e.target as HTMLElement | null
  // 控制栏交互元素（按钮/滑块）不触发任何拖动/缩放，保证点击/滑动正常
  if (t && t.closest('button, input')) return

  // 命中边线 → 进入自定义按比例缩放
  const dir = detectResizeDir(e, t)
  if (dir) {
    e.preventDefault()
    resizeDir = dir
    rs = {
      mx: e.screenX, my: e.screenY,
      x: window.screenX, y: window.screenY,
      w: window.innerWidth, h: window.innerHeight,
      ratio: currentRatio(),
    }
    logger.log(`[Float][resize-start] dir=${dir} win=${rs.w}x${rs.h} ratio=${rs.ratio.toFixed(4)}`)
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', onResizeEnd)
    return
  }

  // 内部（视频画面区）→ 仅移动窗口位置
  const dLeft = e.clientX
  const dRight = window.innerWidth - e.clientX
  const dTop = e.clientY
  const dBottom = window.innerHeight - e.clientY
  logger.log(
    `[Float][mousedown] client=(${e.clientX},${e.clientY}) win=${window.innerWidth}x${window.innerHeight} ` +
    `edge距 L=${dLeft} R=${dRight} T=${dTop} B=${dBottom} target=${t?.className || '?'}`,
  )
  // 阻断浏览器默认拖拽/选中行为，确保按住拖动只走下面的位置计算逻辑
  e.preventDefault()
  dragging = true
  dragStartScreenX = e.screenX
  dragStartScreenY = e.screenY
  dragStartWinX = window.screenX
  dragStartWinY = window.screenY
  dragStartWinW = window.innerWidth
  dragStartWinH = window.innerHeight
  // 拖动期间全局捕获，避免鼠标快速移出窗口时丢失事件
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

function onDragMove(e: MouseEvent) {
  if (!dragging) return
  const x = dragStartWinX + (e.screenX - dragStartScreenX)
  const y = dragStartWinY + (e.screenY - dragStartScreenY)
  window.electronAPI?.moveFloatWindow({ x, y, width: dragStartWinW, height: dragStartWinH })
}

function onDragEnd() {
  if (!dragging) return
  dragging = false
  logger.log(`[Float][mouseup] 拖动结束 win=${window.innerWidth}x${window.innerHeight}`)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
}

function onResizeMove(e: MouseEvent) {
  if (!resizeDir) return
  const dx = e.screenX - rs.mx
  const dy = e.screenY - rs.my
  const ratio = rs.ratio
  const dir = resizeDir
  const east = dir.includes('e')
  const west = dir.includes('w')
  const north = dir.includes('n')
  const south = dir.includes('s')

  let newW = rs.w
  let newH = rs.h

  if (north || south) {
    // 高度驱动：上下边/角以垂直位移为主
    if (south && !north) newH = rs.h + dy
    else if (north && !south) newH = rs.h - dy
    else if (south && north) newH = rs.h + dy
    newW = newH * ratio
  } else {
    // 宽度驱动：左右边/角以水平位移为主
    if (east && !west) newW = rs.w + dx
    else if (west && !east) newW = rs.w - dx
    newH = newW / ratio
  }

  // 最小尺寸兜底
  if (newW < MIN_W) { newW = MIN_W; newH = newW / ratio }
  if (newH < MIN_H) { newH = MIN_H; newW = newH * ratio }

  // 锚点：west 边固定右边，north 边固定下边
  let x = rs.x
  let y = rs.y
  if (west) x = rs.x + (rs.w - newW)
  if (north) y = rs.y + (rs.h - newH)

  window.electronAPI?.setFloatBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(newW), height: Math.round(newH) })
}

function onResizeEnd() {
  if (!resizeDir) return
  resizeDir = ''
  logger.log(`[Float][resize-end] win=${window.innerWidth}x${window.innerHeight}`)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
}

async function handleClose() {
  await window.electronAPI?.mirrorSignal({ type: 'control', action: 'close' })
  await window.electronAPI?.closeFloatWindow()
}

function toggleMute() {
  floatMuted.value = !floatMuted.value
  applyMute()
}

function applyMute() {
  if (videoEl.value) videoEl.value.muted = floatMuted.value
  logger.log(`[Float][applyMute] floatMuted=${floatMuted.value} vol=${vol.value} video.muted=${videoEl.value?.muted} video.volume=${videoEl.value?.volume}`)
}

function onVolumeChange(e: Event) {
  const v = (e.target as HTMLInputElement).valueAsNumber / 100
  vol.value = v
  if (videoEl.value) videoEl.value.volume = v
  if (v > 0 && floatMuted.value) { floatMuted.value = false; applyMute() }
  logger.log(`[Float][onVolumeChange] vol=${vol.value} floatMuted=${floatMuted.value} video.volume=${videoEl.value?.volume} video.muted=${videoEl.value?.muted}`)
}

// ── 播放事件 ──
function onPlaying() { connecting.value = false; error.value = '' }
function onWaiting() {
  // 只有在尚未收到镜像流时才显示「连接中」；收到流之后的缓冲等待（waiting）
  // 不应误触发连接中，否则会与 ontrack/onPlaying 的复位竞争，导致永久卡在
  // 「正在连接镜像」。
  if (!incomingStream) connecting.value = true
}
function onPause() {}
function onVideoError() { connecting.value = false; error.value = '视频流中断' }

// ── WebRTC 镜像接收 ──
function teardownPc() {
  logger.log('[Float][teardownPc] 关闭旧 PC、清空 incomingStream 与 srcObject')
  if (pc) { try { pc.close() } catch (_) {} pc = null }
  incomingStream = null
  if (videoEl.value) {
    try {
      videoEl.value.pause()
      videoEl.value.srcObject = null
    } catch (_) {}
  }
}

async function handleOffer(sdp: any): Promise<void> {
  logger.log('[Float][handleOffer] 收到 offer，开始重新协商')
  teardownPc()
  // 已收到 offer，说明 float-ready 信令通道正常，无需再重发 float-ready；
  // 继续重发反而会触发主窗口再次重建协商、打断正在进行的握手。
  stopFloatReadyRetry()
  floatReadyRetries = 0
  // 重新协商期间进入「连接中」状态，待 ontrack 收到新轨道后再复位。
  connecting.value = true
  pc = new RTCPeerConnection()
  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      const c = ev.candidate
      // 显式序列化为纯对象，避免 RTCIceCandidate 跨 IPC 丢失字段
      sendSignal({ type: 'candidate', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } })
    }
  }
  pc.ontrack = (ev) => {
    const video = videoEl.value
    if (!video) {
      logger.warn(`[Float][ontrack] video 元素不存在，忽略 track kind=${ev.track.kind} id=${ev.track.id}`)
      return
    }
    const t = ev.track
    logger.log(
      `[Float][ontrack] 收到轨道 kind=${t.kind} id=${t.id} readyState=${t.readyState} enabled=${t.enabled} muted=${t.muted} streams=${ev.streams.length}`,
    )
    // 与旧版稳定实现（PCLive1.3）一致：直接采用 event.streams[0] 作为接收流。
    const remote = ev.streams && ev.streams[0] ? ev.streams[0] : null
    let stream: MediaStream
    if (remote) {
      stream = remote
    } else {
      if (!incomingStream) incomingStream = new MediaStream()
      if (!incomingStream.getTracks().some((x) => x.id === t.id)) incomingStream.addTrack(t)
      stream = incomingStream
    }
    incomingStream = stream
    // 关键修复：一次协商会收到两次 ontrack（video、audio），且 ev.streams[0] 是同一个
    // MediaStream 对象。若每次都执行 video.srcObject = stream，第二次赋值会触发浏览器
    // 「新的加载请求」，把第一次的 play() 打断（AbortError: play() request was interrupted
    // by a new load request），video 元素被重置：画面靠后续关键帧恢复，音频输出节点却
    // 随重置丢失，表现为「画面正常、声音没有」。因此只在流对象真正变化时才重新绑定。
    if (video.srcObject !== stream) {
      video.srcObject = stream
      logger.log('[Float][ontrack] 已绑定新的 srcObject')
    } else {
      logger.log('[Float][ontrack] srcObject 未变化，跳过重新绑定（避免打断播放）')
    }
    // 监听轨道移除：切频道/重协商时若音频轨被浏览器移除，这里会立刻暴露
    stream.onremovetrack = (e) => {
      const rt = e.track
      logger.warn(
        `[Float][removetrack] 轨道被移除 kind=${rt?.kind} id=${rt?.id} readyState=${rt?.readyState}；剩余=[` +
        (stream.getTracks().map((x) => `${x.kind}:${x.id}:${x.readyState}`).join(',') || '无') + ']',
      )
    }
    logger.log(
      `[Float][ontrack] 赋值后流轨道=[` +
      (stream.getTracks().map((x) => `${x.kind}:${x.id}:${x.readyState}`).join(',') || '无') + ']',
    )
    video.muted = floatMuted.value
    video.volume = vol.value
    logger.log(`[Float][ontrack] 应用 muted=${floatMuted.value} volume=${vol.value} → video.muted=${video.muted} video.volume=${video.volume}`)
    connecting.value = false
    error.value = ''
    stopFloatReadyRetry()
    floatReadyRetries = 0
    // 收到音轨后无需额外处理，直接进入播放流程
    const playPromise = video.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err) => {
        logger.warn('[Float][ontrack] video.play() 失败，稍后重试:', err)
        // play() 可能因绑定 srcObject 时的加载请求被中断，延迟重试一次即可恢复播放
        setTimeout(() => {
          const v = videoEl.value
          if (v && v.paused) {
            v.play().catch((e2) => logger.warn('[Float][ontrack] video.play() 重试仍失败:', e2))
          }
        }, 300)
      })
    }
  }
  try {
    await pc.setRemoteDescription(sdp)
    logger.log('[Float] 已接收 offer 并 setRemoteDescription')
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    // 显式序列化为纯对象，避免 RTCSessionDescription 跨 IPC 丢失 type/sdp 字段
    const answerSdp = pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : null
    if (!answerSdp) logger.warn('[Float] answer 的 localDescription 为空，将发送空 sdp！')
    sendSignal({
      type: 'answer',
      sdp: answerSdp,
    })
    logger.log(`[Float] 已发送 answer（sdp=${!!answerSdp}）`)
  } catch (e) {
    logger.warn('[Float] 镜像协商失败:', e)
    connecting.value = false
    error.value = '镜像连接失败'
    teardownPc()
  }
}

async function handleCandidate(candidate: any): Promise<void> {
  if (pc && candidate) {
    try { await pc.addIceCandidate(candidate) } catch (_) {}
  }
}

// ── 源变化 ──
function applySource(next: FloatSource) {
  source.value = next
  error.value = ''
  if (next.type === 'stream') {
    // 视频元素由 WebRTC ontrack 填充。仅当尚未收到镜像流时才显示「连接中」；
    // 切线路 / 切频道 / 重新打开时若已有镜像流在播，绝不可再把 connecting 置回 true，
    // 否则会与稍后 ontrack/onPlaying 的复位发生竞态，导致永久卡在「正在连接镜像」。
    connecting.value = !incomingStream
    // 切频道/切线路：重置贴合记录并延迟重贴合，恢复默认 480 尺寸（最长边适配），
    // 不被上一视频的尺寸污染；即使新视频与旧视频同宽高比也强制恢复默认尺寸。
    lastFitW = 0
    lastFitH = 0
    scheduleRefit()
  } else {
    connecting.value = false
    teardownPc()
  }
  setTimeout(() => applyMute(), 500)
  logger.log(`[Float][applySource] type=${next.type} incomingStream=${!!incomingStream}`)
}

// ── 生命周期 ──
onMounted(() => {
  const api = window.electronAPI
  if (!api) return
  cleanupFloatSource = api.onFloatSourceUpdate((data: any) => {
    applySource((data || { type: 'none' }) as FloatSource)
  })
  // 处理主窗口发来的 WebRTC 信令（offer / candidate）
  cleanupMirrorSignal = api.onMirrorSignal((data: any) => {
    if (!data) return
    logger.log('[Float] 收到信令:', data.type)
    if (data.type === 'offer') {
      handleOffer(data.sdp)
    } else if (data.type === 'candidate') {
      handleCandidate(data.candidate)
    }
    // control 指令（关闭等）由主窗口处理，此处忽略
  })
  // 告知主窗口「悬浮窗已就绪」，触发主窗口发起 offer
  sendSignal({ type: 'float-ready' })
  // 兜底：若 offer 因信令竞态丢失，稍后重发 float-ready 让主窗口重新协商
  scheduleFloatReadyRetry()
})

onUnmounted(() => {
  stopFloatReadyRetry()
  if (refitTimer) { clearTimeout(refitTimer); refitTimer = null }
  teardownPc()
  // 拖动/缩放过程中若窗口被关闭，清理残留的全局监听
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', onResizeEnd)
  dragging = false
  resizeDir = ''
  if (cleanupFloatSource) { cleanupFloatSource(); cleanupFloatSource = null }
  if (cleanupMirrorSignal) { cleanupMirrorSignal(); cleanupMirrorSignal = null }
})
</script>

<style scoped>
.float-container {
  position: fixed; inset: 0; background: #000;
  cursor: default; user-select: none;
  display: flex; flex-direction: column;
}

/* ── 顶部控制栏（悬浮覆盖层，自动显示/隐藏） ── */
.record-bar {
  position: absolute; top: 0; left: 0; right: 0;
  height: 40px; padding: 0 6px 0 0;
  display: flex; align-items: center; gap: 8px;
  background: linear-gradient(to bottom, rgba(0,0,0,0.85), rgba(0,0,0,0.5));
  z-index: 30;
  opacity: 1;
  transition: opacity 0.15s ease;
}
.record-bar--hidden {
  opacity: 0;
  pointer-events: none;
}
.record-bar__btn {
  position: relative; z-index: 1;
  height: 26px; padding: 0 8px; border-radius: 5px; border: none;
  background: rgba(255,255,255,0.1); color: #e5e7eb; cursor: pointer;
  display: flex; align-items: center; gap: 4px; font-size: 12px;
  transition: background 0.15s ease; white-space: nowrap;
}
.record-bar__btn:hover { background: rgba(255,255,255,0.22); color: #fff; }
.record-bar__btn--max { margin-left: auto; }
.record-bar__btn--max:hover { background: rgba(255,255,255,0.22); color: #fff; }
.record-bar__btn--close:hover { background: rgba(220,38,38,0.55); color: #fff; }

/* ── 播放区域 ── */
.float-stage {
  position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden;
  background: #000;
  /* 不设置 cursor，继承容器由 JS 动态设置的缩放/默认光标 */
}

.float-video {
  display: block; width: 100%; height: 100%; object-fit: contain; background: #000;
  pointer-events: none;
}

.float-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; z-index: 20; color: #6b7280;
}
.float-empty p { margin: 4px 0; font-size: 14px; }
.float-empty__sub { font-size: 12px; color: #4b5563; }

.float-loading, .float-error {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; z-index: 20;
}
.float-loading { color: #aaa; font-size: 13px; background: rgba(0,0,0,0.55); }
.float-spinner { width: 28px; height: 28px; border: 2px solid #444; border-top-color: #60a5fa; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 10px; }
@keyframes spin { to { transform: rotate(360deg); } }
.float-error { color: #f87171; font-size: 14px; background: rgba(0,0,0,0.7); }

/* ── 顶部音量控制（随控制栏自动显示/隐藏） ── */
.record-bar__vol {
  position: relative; z-index: 1;
  display: flex; align-items: center; height: 26px; padding: 0 2px;
}
.record-bar__vol-slider {
  width: 64px; height: 3px; -webkit-appearance: none; appearance: none;
  background: rgba(255,255,255,0.25); border-radius: 2px; outline: none; cursor: pointer;
  transition: height 0.1s ease;
}
.record-bar__vol-slider:hover { height: 4px; }
.record-bar__vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
  background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  transition: transform 0.1s ease;
}
.record-bar__vol-slider::-webkit-slider-thumb:hover { transform: scale(1.15); }
</style>