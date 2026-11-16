/**
 * useMirrorStream — 悬浮窗「实时镜像」管理 composable
 *
 * 悬浮窗通过 WebRTC 接收主窗口 <video> 元素 captureStream() 派生的实时音视频流，
 * 从而 1:1 复制主窗口正在播放的画面、声音与播放状态（播放 / 暂停 / 跳转均实时同步），
 * 不再由悬浮窗独立重新拉流（那样必然从头开始、无法同步进度）。
 *
 * 协商流程（主窗口为 offer 方，悬浮窗为 answer 方）：
 *   1. 悬浮窗 onMounted 后发 float-ready 信令
 *   2. 主窗口收到 float-ready 后创建 offer（携带当前 captureStream 轨道）
 *   3. 悬浮窗回答 answer，双端交换 ICE candidate，连接建立后 ontrack 播放
 *   4. 切频道 / 切线路导致 <video> 重建时，主窗口经 onMediaStreamChange 重新协商，
 *      替换发送轨道，悬浮窗无缝续播
 *
 * 反向控制仍通过 mirror:signal 的 control 指令（播放/暂停、关闭）。
 */

import { logger } from '@/utils/logger'
import { playbackStreamHub } from '@/services/PlaybackStreamHub'

/**
 * 取「最新的活跃轨道」。
 *
 * captureStream 派生的流在切源（切频道 / 切线路）后会出现多条同类轨道：
 * getTracks() 形如 [audio:旧, video:旧, audio:新, video:新]，全部 readyState='live'，
 * 但旧轨道已停止产出数据（实测音频 RMS 恒为 0）。getTracks() 按加入顺序返回，
 * 因此必须取末尾那条，绝不能取第一条，否则会推送僵尸轨道 → 悬浮窗无声。
 */
function pickNewestLive(tracks: MediaStreamTrack[] | undefined): MediaStreamTrack | null {
  if (!tracks || !tracks.length) return null
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (tracks[i].readyState === 'live') return tracks[i]
  }
  return null
}

export interface MirrorControlHandler {
  togglePlay: () => void
  closeFloat: () => void
}

// 模块级共享状态：主窗口只有一个悬浮窗，VideoPlayer 与官网直播源播放条
// 共享同一份「悬浮窗已打开」状态与控制处理器，避免重复注册信令监听。
let isMirroring = false
// 用户是否已手动关闭悬浮窗：手动关闭表示用户主动停用「悬浮窗」功能，
// 此后切频道 / 切线路不再触发「关闭旧窗口 + 原位置重建」的自动逻辑；
// 直到用户再次通过「工具」菜单打开悬浮窗才复位。
let floatUserClosed = false
// 悬浮窗是否已发来 float-ready：只有悬浮窗的信令监听注册完成后，主窗口发出的
// offer 才不会被丢弃。此前由 onMediaStreamChange 触发的协商一律跳过，等 float-ready
// 到达后再发起，从根本上消除「offer 早于悬浮窗就绪而被丢弃」的竞态。
let floatReady = false
let controlHandler: MirrorControlHandler | null = null
let mirrorCleanupSignal: (() => void) | null = null

// WebRTC 推流端（主窗口 → 悬浮窗）
let peer: RTCPeerConnection | null = null
let unsubscribeStream: (() => void) | null = null
let renegotiating = false
let pendingRenegotiate = false
// 已推送轨道的 ID 快照：用于判断源流轨道是否已变化从而决定是否重新协商。
// 切换频道 / 线路时，<video> 元素的 captureStream 会结束旧轨道并补充新轨道；
// 通过比对 ID 能可靠发现「音轨已被换新但尚未推送」的情况。
let sentVideoTrackId: string | null = null
let sentAudioTrackId: string | null = null
// 周期对账：悬浮窗开启期间持续比对「源流活跃轨道」与「已推送轨道」，
// 一旦发现音轨 / 视频轨尚未同步就重新协商。相比只依赖 addtrack 事件 + 有限次重试，
// 周期对账能兜底所有「音频只在第一次正常、切换频道/重新打开后无声」的时序问题。
let reconcileTimer: ReturnType<typeof setTimeout> | null = null
const RECONCILE_INTERVAL = 500

function sendSignal(data: unknown): void {
  window.electronAPI?.mirrorSignal(data)
}

/** 仅关闭本地 PeerConnection（协商失败重建用），不取消流变化订阅 */
function closePeer(): void {
  if (peer) {
    try { peer.close() } catch (_) {}
    peer = null
  }
}

/** 确保存在一个可用的推流端 PeerConnection */
function ensurePeer(): RTCPeerConnection {
  if (!peer) {
    peer = new RTCPeerConnection()
    peer.onicecandidate = (ev) => {
      if (ev.candidate) {
        const c = ev.candidate
        // 显式序列化为纯对象，避免 RTCIceCandidate 跨 IPC 丢失字段
        sendSignal({ type: 'candidate', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } })
      }
    }
  }
  return peer
}

/** 周期对账：持续比对源流活跃轨道与已推送轨道，不一致则重新协商 */
function startReconcileLoop(): void {
  if (reconcileTimer) return
  const tick = () => {
    reconcileTimer = null
    if (!isMirroring) return
    if (floatReady) {
      const s = playbackStreamHub.getMirrorMediaStream()
      const liveVideo = pickNewestLive(s?.getVideoTracks())
      const liveAudio = pickNewestLive(s?.getAudioTracks())
      const videoId = liveVideo?.id ?? null
      const audioId = liveAudio?.id ?? null
      if (videoId !== sentVideoTrackId || audioId !== sentAudioTrackId) {
        logger.warn(`[Mirror][reconcile] 检测到轨道变化 video=${sentVideoTrackId}->${videoId} audio=${sentAudioTrackId}->${audioId}，触发协商`)
        void renegotiate()
      }
    }
    reconcileTimer = setTimeout(tick, RECONCILE_INTERVAL)
  }
  reconcileTimer = setTimeout(tick, RECONCILE_INTERVAL)
}

function stopReconcileLoop(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer)
    reconcileTimer = null
  }
}

/** 完全销毁镜像会话：关闭 PeerConnection、取消流变化订阅、复位就绪标记 */
function teardownMirror(): void {
  closePeer()
  if (unsubscribeStream) {
    unsubscribeStream()
    unsubscribeStream = null
  }
  stopReconcileLoop()
  sentVideoTrackId = null
  sentAudioTrackId = null
  renegotiating = false
  pendingRenegotiate = false
  floatReady = false
}

/** 创建 / 重协商 offer：把当前 captureStream 的活跃轨道同步到悬浮窗 */
async function renegotiate(): Promise<void> {
  // 悬浮窗就绪前不发 offer，避免 offer 早于其信令监听而丢失
  if (!isMirroring || !floatReady) return
  // 已有协商在进行中：置位待协商标记，当前协商结束后再补跑一次，避免本次请求被吞掉
  if (renegotiating) {
    pendingRenegotiate = true
    return
  }
  renegotiating = true
  try {
    const stream = playbackStreamHub.getMirrorMediaStream()
    // 只取「最新的活」轨道：切源瞬间 captureStream 里会同时存在旧轨道（readyState 仍为
    // 'live'，但已不再产出任何数据）与新轨道，旧轨道排在数组前面。取第一条 = 推送僵尸轨道，
    // 这正是「首次打开有声、切频道 / 重新打开后彻底无声」的根因，故取末尾最新的 live 轨道。
    // 注意：音轨来自 PlaybackStreamHub 的「镜像音频图」重采集结果（永不 muted；切源 / 重开
    // 时换新 ID，强制重新 addTrack 新建发送器），因此主窗口静音 / 调音量都不会中断悬浮窗音频，
    // 详见 getMirrorMediaStream / rebuildMirrorDestination 注释。
    const videoTrack = pickNewestLive(stream?.getVideoTracks())
    const audioTrack = pickNewestLive(stream?.getAudioTracks())
    const videoId = videoTrack?.id ?? null
    const audioId = audioTrack?.id ?? null

    logger.log(
      `[Mirror][renegotiate] 镜像流视频轨=[${stream?.getVideoTracks().map((t) => `${t.kind}:${t.id}:${t.readyState}:mu${t.muted}`).join(',') || '无'}] ` +
      `音轨=[${stream?.getAudioTracks().map((t) => `${t.kind}:${t.id}:${t.readyState}:mu${t.muted}`).join(',') || '无'}] ` +
      `选中 video=${videoId} audio=${audioId}；已推送 video=${sentVideoTrackId} audio=${sentAudioTrackId}`,
    )

    // 无可用轨道时不能发送「空 offer」：悬浮窗收到空 offer 后永远不会触发 ontrack，
    // 会永久卡在「正在连接镜像」。此时直接返回，交给周期对账循环等待轨道就绪后重试。
    // 说明：历史上「跨域导致 captureStream 抛 SecurityError」的真正根因，已在 VideoPlayer
    // 侧通过 <video> 元素 crossorigin="anonymous" 修复（见 moreVideoAttr）；此守卫现在
    // 仅兜底「播放器尚未 ready、暂无轨道」这一时序场景。
    if (!videoTrack && !audioTrack) {
      logger.log('[Mirror] 暂无可推送的音视频轨道，等待媒体流就绪后再协商')
      return
    }

    // 轨道未变化则跳过，避免无谓的重协商反复打断正在播放的悬浮窗
    if (videoId === sentVideoTrackId && audioId === sentAudioTrackId) {
      logger.log('[Mirror][renegotiate] 轨道无变化，跳过协商')
      return
    }

    // 每次协商都重建推流端 PeerConnection，与悬浮窗接收端（每次收到 offer 也重建）保持一致。
    // 切线路 / 切频道时旧媒体流已销毁、新媒体流是全新 captureStream，两端若一方复用旧
    // peer、另一方新建 peer，会导致 ICE 凭据错位：旧 peer 不再重新采集 candidate，新 peer
    // 又拿不到对方 candidate，最终协商永远无法完成、悬浮窗卡死在「正在连接镜像」。
    // 两端同步重建后，完整握手流程与首次连接完全一致，任何场景下都能稳定完成。
    closePeer()
    const p = ensurePeer()
    // 用一份专用发送流承载两条轨道，避免把 captureStream 里的原始音轨（可能 muted）
    // 一并带进发送流的轨道集合，保证悬浮窗收到的流里只有「视频轨 + 镜像音轨」。
    const sendTracks: MediaStreamTrack[] = []
    if (videoTrack) sendTracks.push(videoTrack)
    if (audioTrack) sendTracks.push(audioTrack)
    const sendStream = new MediaStream(sendTracks)
    if (videoTrack) p.addTrack(videoTrack, sendStream)
    if (audioTrack) p.addTrack(audioTrack, sendStream)
    logger.log(`[Mirror][renegotiate] 已 addTrack：video=${!!videoTrack}(${videoTrack?.readyState}) audio=${!!audioTrack}(${audioTrack?.readyState}:mu${audioTrack?.muted})`)

    const offer = await p.createOffer()
    await p.setLocalDescription(offer)
    // 显式序列化为纯对象，避免 RTCSessionDescription 跨 IPC 丢失 type/sdp 字段
    sendSignal({
      type: 'offer',
      sdp: p.localDescription ? { type: p.localDescription.type, sdp: p.localDescription.sdp } : null,
    })
    sentVideoTrackId = videoId
    sentAudioTrackId = audioId
    logger.log(`[Mirror] 已发送 offer（video=${!!videoTrack} audio=${!!audioTrack}）`)
  } catch (e) {
    logger.warn('[Mirror] 协商失败，重建 PeerConnection 后重试:', e)
    // 兜底：任何异常都关闭当前 peer 并复位已推送快照，交给周期对账循环重新协商。
    closePeer()
    sentVideoTrackId = null
    sentAudioTrackId = null
  } finally {
    renegotiating = false
    if (pendingRenegotiate) {
      pendingRenegotiate = false
      setTimeout(() => { void renegotiate() }, 0)
    }
  }
}

/** 处理来自悬浮窗的 WebRTC 信令 */
async function handleSignal(data: any): Promise<void> {
  if (!data) return
  if (data.type === 'float-ready') {
    // 悬浮窗信令监听已就绪，此后再发的 offer 才能被其接收
    floatReady = true
    await renegotiate()
  } else if (data.type === 'answer') {
    if (peer && data.sdp) {
      try {
        await peer.setRemoteDescription(data.sdp)
        logger.log('[Mirror] 已接收 answer')
      } catch (e) {
        logger.warn('[Mirror] setRemoteDescription(answer) 失败:', e)
      }
    } else {
      logger.warn(
        `[Mirror] answer 被丢弃：peer=${!!peer} sdp=${!!data.sdp} isMirroring=${isMirroring} floatReady=${floatReady} ` +
        `sentVideo=${sentVideoTrackId} sentAudio=${sentAudioTrackId}`,
      )
    }
  } else if (data.type === 'candidate') {
    if (peer && data.candidate) {
      try { await peer.addIceCandidate(data.candidate) } catch (_) {}
    }
  }
}

/** 处理悬浮窗发来的控制指令（播放/暂停、关闭等反向控制） */
function handleMirrorControl(action: string, _payload?: any): void {
  if (!controlHandler) return
  switch (action) {
    case 'togglePlay':
      controlHandler.togglePlay()
      break
    case 'close':
      // 用户通过悬浮窗 ✕ 手动关闭：视为主动停用该功能，切频道不再自动重建
      floatUserClosed = true
      controlHandler.closeFloat()
      break
    default:
      logger.warn('[Mirror] 收到未知控制指令:', action)
  }
}

/** 注册信令监听器：处理悬浮窗发来的控制指令与 WebRTC 信令 */
function setupSignalListener(): void {
  if (mirrorCleanupSignal) return
  if (!window.electronAPI) return
  mirrorCleanupSignal = window.electronAPI.onMirrorSignal((data: any) => {
    if (data?.type === 'control') {
      handleMirrorControl(data.action, data.payload)
    } else {
      handleSignal(data)
    }
  })
}

/** 移除信令监听器 */
function teardownSignalListener(): void {
  if (mirrorCleanupSignal) {
    mirrorCleanupSignal()
    mirrorCleanupSignal = null
  }
}

/** 打开悬浮窗（实时镜像窗口）。position 用于「切频道原位置重建」时传入上次窗口坐标。 */
async function openFloatWindowInternal(position?: { x: number; y: number }): Promise<void> {
  if (!window.electronAPI) return
  // 单例互斥以「主进程实际窗口存活状态」为准，而不是仅依赖本地 isMirroring 标志：
  // 悬浮窗可能被 ✕ 按钮、系统快捷键/外部方式关闭，本地标志未及时归零时会误拦截再次打开。
  const actuallyOpen = !!(await window.electronAPI.isFloatWindowOpen?.())
  if (actuallyOpen) {
    // 悬浮窗确实还开着：忽略重复点击，仅同步本地标志防止状态漂移
    isMirroring = true
    return
  }
  // 悬浮窗实际已关闭：先复位本地标志并清理上次可能残留的会话资源，再走完整打开流程
  isMirroring = false
  teardownSignalListener()
  playbackStreamHub.disableConsumer('float')
  teardownMirror()

  setupSignalListener()
  // 复位就绪标记：悬浮窗重新打开后需重新等待 float-ready，确保发出的 offer 不丢失
  floatReady = false
  // 建立推流端 PeerConnection，等待悬浮窗发来的 float-ready 再发起协商
  ensurePeer()
  if (!unsubscribeStream) {
    unsubscribeStream = playbackStreamHub.onMediaStreamChange(() => {
      // 只有悬浮窗信令监听就绪后才协商，避免 offer 早于其监听而丢失
      if (isMirroring && floatReady) renegotiate()
    })
  }
  // 先置位 isMirroring 再创建悬浮窗：悬浮窗加载完成后会立刻发来 float-ready，
  // 若此刻 isMirroring 仍为 false，renegotiate 的守卫会提前 return，导致永远收不到 offer。
  isMirroring = true
  // 复位已推送轨道快照：重新打开悬浮窗后需重新协商全部轨道
  sentVideoTrackId = null
  sentAudioTrackId = null
  // 重新打开悬浮窗时强制刷新镜像音轨：重建输出节点得到全新 ID 的音轨，确保
  // WebRTC 每次都使用全新的发送器，规避旧音轨数据管道在上一轮 sender 销毁后
  // 无法重启的问题（否则会「首次打开有声、重新打开后无声」）。
  playbackStreamHub.refreshMirrorAudio()
  // 开启周期对账：兜底切频道/切线路后音视频轨被换新但事件丢失的时序问题
  startReconcileLoop()
  await window.electronAPI.createFloatWindow(position)
  // 开启悬浮窗消费者：统一流接口推送当前播放源（仅 Artplayer 直链源）
  playbackStreamHub.enableConsumer('float')
  logger.log('[Mirror] 悬浮窗已打开（WebRTC 实时镜像模式）')
}

/** 关闭悬浮窗 */
async function closeFloatWindowInternal(): Promise<void> {
  isMirroring = false
  teardownSignalListener()
  playbackStreamHub.disableConsumer('float')
  teardownMirror()
  await window.electronAPI?.closeFloatWindow()
  logger.log('[Mirror] 悬浮窗已关闭')
}

// 切频道重建互斥：重建期间源再次变化时跳过，避免重入造成窗口反复开关
let floatRebuildInFlight = false

/**
 * 关闭悬浮窗并在「原位置附近」重新打开，触发全新的初始尺寸逻辑。
 *
 * 背景：Electron 在 Windows 上对 resizable:false 的无边框窗口会把最小尺寸钳制为
 * 初始值（480x270），即使调用 setMinimumSize 也无法把窗口缩小到初始宽度以下。
 * 因此切频道后想恢复「最长边 480」的默认尺寸，软重置（清空贴合记录 + 延迟重贴合）
 * 对竖屏等窄视频永远无法生效，只能彻底关闭再重建窗口，让新窗口回到全新初始状态。
 */
export async function restartFloatMirror(): Promise<void> {
  if (floatRebuildInFlight) return
  if (!isMirroring) return
  // 用户已手动关闭悬浮窗 → 停用「切频道自动重建」逻辑，避免关闭后又凭空弹窗
  if (floatUserClosed) return
  floatRebuildInFlight = true
  try {
    // 重建前读取当前窗口坐标，作为新窗口初始位置，保证窗口不跳回屏幕中央
    const bounds = await window.electronAPI?.getFloatWindowBounds?.()
    const pos = bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? { x: bounds.x, y: bounds.y }
      : undefined
    await closeFloatWindowInternal()
    await openFloatWindowInternal(pos)
  } finally {
    floatRebuildInFlight = false
  }
}

/** 悬浮窗镜像会话是否处于开启状态（模块级，供播放源变化监听判断是否重建） */
export function isFloatMirroring(): boolean {
  return isMirroring
}

export function useMirrorStream() {
  /** 设置控制指令处理器（悬浮窗反向控制主窗口） */
  function setControlHandler(handler: MirrorControlHandler): void {
    controlHandler = handler
  }

  /** 打开悬浮窗（实时镜像窗口） */
  async function openFloatWindow(_art?: unknown): Promise<void> {
    // 用户重新通过「工具」菜单打开悬浮窗：复位手动关闭标记，恢复切频道自动重建
    floatUserClosed = false
    await openFloatWindowInternal()
  }

  /** 关闭悬浮窗 */
  async function closeFloatWindow(): Promise<void> {
    await closeFloatWindowInternal()
  }

  function getIsMirroring(): boolean {
    return isMirroring
  }

  /** 销毁所有资源 */
  function destroy(): void {
    isMirroring = false
    teardownSignalListener()
    controlHandler = null
    playbackStreamHub.disableConsumer('float')
    teardownMirror()
  }

  return {
    setupSignalListener,
    teardownSignalListener,
    openFloatWindow,
    closeFloatWindow,
    getIsMirroring,
    setControlHandler,
    destroy,
  }
}