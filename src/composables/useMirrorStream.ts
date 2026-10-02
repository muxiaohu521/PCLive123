/**
 * useMirrorStream — 悬浮窗 WebRTC 镜像流 composable
 *
 * 职责：
 * - 管理 RTCPeerConnection 生命周期
 * - 处理 WebRTC 信令（offer/answer/ICE）
 * - 从 artplayer video 元素捕获媒体流
 * - 处理悬浮窗控制指令
 *
 * 播放器只负责在加载新媒体源后调用 restart() 即可。
 * restart() 会智能判断：如果当前 stream tracks 仍活跃，则用 replaceTrack 无缝切换；
 * 否则完整重建 PeerConnection。
 */

import type Artplayer from 'artplayer'
import { logger } from '@/utils/logger'

export interface MirrorControlHandler {
  togglePlay: () => void
  closeFloat: () => void
}

export function useMirrorStream() {
  let mirrorPC: RTCPeerConnection | null = null
  let mirrorStream: MediaStream | null = null
  let mirrorCleanupSignal: (() => void) | null = null
  let iceCandidatesBuffer: RTCIceCandidateInit[] = []
  let isMirroring = false
  let mirrorGenId = 0
  let controlHandler: MirrorControlHandler | null = null
  let canvasRafId: number | null = null
  let currentArt: Artplayer | null = null
  let useCanvasFallback = false
  let canvasEl: HTMLCanvasElement | null = null

  /** 设置控制指令处理器 */
  function setControlHandler(handler: MirrorControlHandler): void {
    controlHandler = handler
  }

  /** 注册信令监听器 */
  function setupSignalListener(): void {
    if (mirrorCleanupSignal) return
    if (!window.electronAPI) return

    mirrorCleanupSignal = window.electronAPI.onMirrorSignal(async (data: any) => {
      try {
        if (data.type === 'ready') {
          logger.log('[Mirror] ← 收到 ready 信号')
          isMirroring = true
          if (currentArt) {
            logger.log('[Mirror] 收到 ready 后启动镜像流')
            startMirrorStream(currentArt)
          }
        } else if (data.type === 'answer' && mirrorPC) {
          logger.log('[Mirror] ← 收到 answer, signalingState=', mirrorPC.signalingState)
          await mirrorPC.setRemoteDescription(new RTCSessionDescription(data.sdp))
          logger.log('[Mirror] answer setRemoteDescription 完成, signalingState=', mirrorPC.signalingState)
          await Promise.all(iceCandidatesBuffer.map(c => mirrorPC!.addIceCandidate(new RTCIceCandidate(c))))
          iceCandidatesBuffer = []
        } else if (data.type === 'ice' && mirrorPC) {
          const c = data.candidate
          if (c && (c.sdpMid !== null || c.sdpMLineIndex !== null)) {
            if (mirrorPC.remoteDescription) {
              await mirrorPC.addIceCandidate(new RTCIceCandidate(c))
            } else {
              iceCandidatesBuffer.push(c)
            }
          }
        } else if (data.type === 'control') {
          handleMirrorControl(data.action, data.payload)
        } else {
          logger.warn('[Mirror] ← 收到未处理信号:', data.type, 'mirrorPC存在=', !!mirrorPC)
        }
      } catch (_) { /* ignore stale signals */ }
    })
  }

  /** 移除信令监听器 */
  function teardownSignalListener(): void {
    if (mirrorCleanupSignal) {
      mirrorCleanupSignal()
      mirrorCleanupSignal = null
    }
  }

  /** 停止镜像流 */
  function stopMirrorStream(): void {
    logger.log('[Mirror] stopMirrorStream 调用, isMirroring=', isMirroring, 'mirrorPC存在=', !!mirrorPC)
    if (canvasRafId !== null) {
      cancelAnimationFrame(canvasRafId)
      canvasRafId = null
    }
    if (mirrorStream) {
      mirrorStream.getTracks().forEach(t => t.stop())
      mirrorStream = null
    }
    if (mirrorPC) {
      logger.log('[Mirror] 关闭旧 PeerConnection, signalingState=', mirrorPC.signalingState)
      mirrorPC.close()
      mirrorPC = null
    }
    isMirroring = false
    useCanvasFallback = false
    canvasEl = null
  }

  /**
   * 重启镜像流（在切换媒体源时调用）
   *
   * 始终完整重建 PeerConnection，确保 FloatView 通过新 offer → ontrack 接收新流。
   * canvas fallback 模式仅调整画布大小（drawImage 自动跟踪新 video 内容）。
   */
  function restartMirrorStream(art: Artplayer | null): void {
    logger.log('[Mirror] restartMirrorStream 调用, isMirroring=', isMirroring, 'art存在=', !!art, 'mirrorPC存在=', !!mirrorPC, 'mirrorStream存在=', !!mirrorStream)
    if (!isMirroring || !art) {
      logger.warn('[Mirror] restartMirrorStream 跳过: isMirroring=', isMirroring, 'art=', !!art)
      return
    }
    currentArt = art

    const video = art.video as HTMLVideoElement | undefined
    if (!video) {
      logger.warn('[Mirror] restartMirrorStream 跳过: video 不存在')
      return
    }

    // canvas fallback 模式：仅调整画布大小，drawImage 会自动跟踪新 video 内容
    if (useCanvasFallback && canvasEl && mirrorPC && mirrorStream) {
      logger.log('[Mirror] restartMirrorStream: canvas fallback 路径, 仅调整画布大小')
      canvasEl.width = video.videoWidth || 640
      canvasEl.height = video.videoHeight || 360
      return
    }

    // 切换频道时始终完整重建 PeerConnection，确保 FloatView 通过新 offer → ontrack 接收新流
    // replaceTrack 不触发 ontrack，跨频道/编码切换时不可靠
    logger.log('[Mirror] restartMirrorStream: 完整重建路径, genId=', mirrorGenId + 1)
    const genId = ++mirrorGenId
    stopMirrorStream()
    startMirrorStreamInternal(art, genId)
  }

  /** 获取 video 元素并开始捕获 */
  function startMirrorStream(art?: Artplayer | null): void {
    const genId = ++mirrorGenId
    if (art) {
      startMirrorStreamInternal(art, genId)
    }
  }

  async function startMirrorStreamInternal(art: Artplayer, genId?: number): Promise<void> {
    logger.log('[Mirror] startMirrorStreamInternal 开始, genId=', genId)
    if (!window.electronAPI) {
      logger.warn('[Mirror] startMirrorStreamInternal: electronAPI 不可用')
      return
    }
    currentArt = art
    setupSignalListener()

    const video = art.video as HTMLVideoElement | undefined
    if (!video) {
      logger.warn('[Mirror] startMirrorStreamInternal: video 不存在')
      return
    }

    useCanvasFallback = false
    canvasEl = null

    try {
      mirrorStream = video.captureStream(30)
      logger.log('[Mirror] direct captureStream 成功, tracks=', mirrorStream.getTracks().length)
    } catch (_e) {
      logger.warn('[Mirror] direct captureStream 失败, 使用 canvas fallback')
      // Fallback: canvas capture
      useCanvasFallback = true
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 640
      canvas.height = video.videoHeight || 360
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvasEl = canvas
      const drawFrame = () => {
        if (!isMirroring) { canvasRafId = null; return }
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        } catch (_) {}
        canvasRafId = requestAnimationFrame(drawFrame)
      }
      canvasRafId = requestAnimationFrame(drawFrame)
      mirrorStream = canvas.captureStream(30)
    }

    if (!mirrorStream) {
      logger.warn('[Mirror] startMirrorStreamInternal: mirrorStream 创建失败')
      return
    }

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    mirrorPC = pc
    logger.log('[Mirror] 新 PeerConnection 创建, mirrorPC=', !!mirrorPC)

    mirrorStream.getTracks().forEach(track => {
      pc.addTrack(track, mirrorStream!)
    })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const c = event.candidate
        window.electronAPI!.mirrorSignal({
          type: 'ice',
          candidate: {
            candidate: c.candidate,
            sdpMid: c.sdpMid,
            sdpMLineIndex: c.sdpMLineIndex,
          },
        })
      }
    }

    pc.onconnectionstatechange = () => {
      logger.log('[Mirror] connectionState 变化:', pc.connectionState, ' 当前 mirrorPC===pc:', mirrorPC === pc)
      // 如果这个 PC 已经不是当前的 mirrorPC（已被 restartMirrorStream 替换），跳过自动重连
      if (mirrorPC !== pc) {
        logger.log('[Mirror] 旧 PC connectionState 忽略')
        return
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        logger.warn('[Mirror] PeerConnection 断开, state=', pc.connectionState)
        const reconnectGenId = mirrorGenId
        stopMirrorStream()
        setTimeout(async () => {
          if (reconnectGenId !== mirrorGenId) return
          // 再次确认 mirrorPC 为 null（未被新的流替换）
          if (mirrorPC) return
          const exists = await window.electronAPI?.floatWindowExists()
          if (exists && currentArt) {
            logger.log('[Mirror] 自动重连镜像流')
            startMirrorStreamInternal(currentArt)
          }
        }, 2000)
      }
    }

    const offer = await pc.createOffer()
    logger.log('[Mirror] createOffer 完成, genId校验: genId=', genId, 'mirrorGenId=', mirrorGenId)
    if (genId !== undefined && genId !== mirrorGenId) {
      logger.warn('[Mirror] genId 不匹配, 放弃发送 offer')
      return
    }
    await pc.setLocalDescription(offer)
    logger.log('[Mirror] setLocalDescription 完成')
    if (genId !== undefined && genId !== mirrorGenId) return
    window.electronAPI.mirrorSignal({
      type: 'offer',
      sdp: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp },
    })
    logger.log('[Mirror] → offer 已发送')

    isMirroring = true
    logger.log('[Mirror] startMirrorStreamInternal 完成, isMirroring=true')
  }

  /** 处理来自悬浮窗的控制指令 */
  function handleMirrorControl(action: string, _payload?: any): void {
    logger.log('[Mirror] ← 收到控制指令:', action)
    if (!controlHandler) {
      logger.warn('[Mirror] controlHandler 未设置，忽略控制指令:', action)
      return
    }
    switch (action) {
      case 'togglePlay':
        controlHandler.togglePlay()
        break
      case 'close':
        controlHandler.closeFloat()
        break
      default:
        logger.warn('[Mirror] 收到未知控制指令:', action)
    }
  }

  /** 打开悬浮窗 */
  async function openFloatWindow(art?: Artplayer | null): Promise<void> {
    logger.log('[Mirror] openFloatWindow 调用, art存在=', !!art)
    if (!window.electronAPI) return
    if (art) currentArt = art
    setupSignalListener()
    await window.electronAPI.createFloatWindow()
    logger.log('[Mirror] createFloatWindow 完成')
  }

  /** 关闭悬浮窗 */
  async function closeFloatWindow(): Promise<void> {
    logger.log('[Mirror] closeFloatWindow 调用')
    stopMirrorStream()
    teardownSignalListener()
    await window.electronAPI?.closeFloatWindow()
  }

  /** 检查是否正在镜像 */
  function getIsMirroring(): boolean {
    return isMirroring
  }

  /** 销毁所有资源 */
  function destroy(): void {
    mirrorGenId++
    stopMirrorStream()
    teardownSignalListener()
    controlHandler = null
    currentArt = null
  }

  return {
    setupSignalListener,
    teardownSignalListener,
    stopMirrorStream,
    restartMirrorStream,
    startMirrorStream,
    openFloatWindow,
    closeFloatWindow,
    getIsMirroring,
    setControlHandler,
    destroy,
  }
}