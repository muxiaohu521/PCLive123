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

import { logger } from '@/utils/logger'
import type Artplayer from 'artplayer'

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
          isMirroring = true
          if (currentArt) {
            startMirrorStream(currentArt)
          }
        } else if (data.type === 'answer' && mirrorPC) {
          await mirrorPC.setRemoteDescription(new RTCSessionDescription(data.sdp))
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
    if (canvasRafId !== null) {
      cancelAnimationFrame(canvasRafId)
      canvasRafId = null
    }
    if (mirrorStream) {
      mirrorStream.getTracks().forEach(t => t.stop())
      mirrorStream = null
    }
    if (mirrorPC) {
      mirrorPC.close()
      mirrorPC = null
    }
    isMirroring = false
    useCanvasFallback = false
    canvasEl = null
  }

  /** 检查当前 mirrorStream 的 tracks 是否仍然活跃 */
  function areStreamTracksActive(): boolean {
    if (!mirrorStream) return false
    const tracks = mirrorStream.getTracks()
    if (tracks.length === 0) return false
    return tracks.every(t => t.readyState === 'live')
  }

  /**
   * 重启镜像流（在切换媒体源时调用）
   *
   * 智能策略：
   * - 如果当前 PeerConnection 存在且 stream tracks 仍活跃 → 用 replaceTrack 无缝切换
   * - 如果 canvas fallback 模式 → canvas drawImage 自动跟踪新 video 内容，无需重建
   * - 否则 → 完整重建 PeerConnection
   */
  function restartMirrorStream(art: Artplayer | null): void {
    if (!isMirroring || !art) return
    currentArt = art

    const video = (art as any).video as HTMLVideoElement | undefined
    if (!video) return

    if (useCanvasFallback && canvasEl && mirrorPC && mirrorStream) {
      canvasEl.width = video.videoWidth || 640
      canvasEl.height = video.videoHeight || 360
      return
    }

    if (mirrorPC && mirrorStream && areStreamTracksActive()) {
      try {
        const newStream = video.captureStream(30)
        const oldTracks = mirrorStream.getTracks()
        const newTracks = newStream.getTracks()
        const senders = mirrorPC.getSenders()

        for (const sender of senders) {
          if (sender.track) {
            const oldIdx = oldTracks.indexOf(sender.track)
            if (oldIdx >= 0 && oldIdx < newTracks.length) {
              sender.replaceTrack(newTracks[oldIdx]).catch(() => {})
            }
          }
        }

        oldTracks.forEach(t => t.stop())
        mirrorStream = newStream
        return
      } catch (_e) {
        // captureStream failed, fall through to full rebuild
      }
    }

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
    if (!window.electronAPI) return
    currentArt = art
    setupSignalListener()

    const video = (art as any).video as HTMLVideoElement | undefined
    if (!video) return

    useCanvasFallback = false
    canvasEl = null

    try {
      mirrorStream = video.captureStream(30)
    } catch (_e) {
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

    if (!mirrorStream) return

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    mirrorPC = pc

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
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        const reconnectGenId = mirrorGenId
        stopMirrorStream()
        setTimeout(async () => {
          if (reconnectGenId !== mirrorGenId) return
          const exists = await window.electronAPI?.floatWindowExists()
          if (exists && currentArt) {
            startMirrorStreamInternal(currentArt)
          }
        }, 2000)
      }
    }

    const offer = await pc.createOffer()
    if (genId !== undefined && genId !== mirrorGenId) return
    await pc.setLocalDescription(offer)
    if (genId !== undefined && genId !== mirrorGenId) return
    window.electronAPI.mirrorSignal({
      type: 'offer',
      sdp: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp },
    })

    isMirroring = true
  }

  /** 处理来自悬浮窗的控制指令 */
  function handleMirrorControl(action: string, _payload?: any): void {
    if (!controlHandler) return
    switch (action) {
      case 'togglePlay':
        controlHandler.togglePlay()
        break
      case 'close':
        controlHandler.closeFloat()
        break
    }
  }

  /** 打开悬浮窗 */
  async function openFloatWindow(art?: Artplayer | null): Promise<void> {
    if (!window.electronAPI) return
    if (art) currentArt = art
    setupSignalListener()
    await window.electronAPI.createFloatWindow()
  }

  /** 关闭悬浮窗 */
  async function closeFloatWindow(): Promise<void> {
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