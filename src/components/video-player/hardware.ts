/**
 * video-player — 硬解能力检测与校验
 *
 * 容器解封装 + 本机 GPU 硬件解码管线。Chromium 内核无法直接解封装
 * HLS / FLV / MPEG-TS，容器解封装必须交给 hls.js / mpegts.js 完成；
 * 真正的解码由 Chromium GPU 进程调用本机硬件解码器（NVIDIA NVDEC /
 * AMD UVD-VCN / Intel QuickSync / CPU 核显 DXVA）完成。
 * 硬解模式严禁任何软解 / FFmpeg / MPV / VLC 回退，失败只报错。
 */

import { state } from './state'
import { logger } from '@/utils/logger'

export async function ensureHardwareDecodeReady(): Promise<void> {
  if (!window.electronAPI?.getHardwareDecodeStatus) return
  try {
    if (!state._hwStatusPromise) {
      state._hwStatusPromise = window.electronAPI.getHardwareDecodeStatus().catch(() => null)
    }
    const s = await state._hwStatusPromise
    if (!s) return
    state._hwEngineName = s.actualEngine || s.preferredEngine || '未知引擎'
    if (state._hwStatusLogged) return
    state._hwStatusLogged = true
    const tierLabel = s.preferredTier === 'cpu' ? 'CPU 引擎优先' : s.preferredTier === 'gpu' ? 'GPU 引擎' : '未知层级'
    if (s.hardwareAccelerated) {
      logger.info(`[VideoPlayer] 硬解就绪: 首选引擎=${s.preferredEngine || '?'}(${tierLabel}) 实际引擎=${s.actualEngine || '?'} 接口=${s.decodeApi || 'D3D11VA/DXVA'} 适配器=${s.actualAdapter || s.gpuVendor || '?'} 驱动=${s.driverVersion || '?'} video_decode=${s.videoDecode}`)
      if (!s.engineMatched && s.actualEngine) {
        // 未命中 CPU 引擎时 Chromium 自动落到 GPU 引擎（NVDEC / VCN），依旧是硬件解码，
        // 绝不会退化为软件解码，因此这里只提示不阻断。
        logger.warn(`[VideoPlayer] 硬解引擎未命中 CPU 引擎，当前由 ${s.actualEngine} 承担硬件解码`)
      }
    } else {
      logger.warn(`[VideoPlayer] 硬解不可用: video_decode=${s.videoDecode} 首选引擎=${s.preferredEngine || '?'}；硬解模式不做软解降级`)
    }
  } catch (_) { /* 探测失败不影响播放 */ }
}

// 用 MediaCapabilities 校验当前流的编码是否由 GPU 硬件解码器承担。
// powerEfficient=true 表示 Chromium 会调用本机显卡/核显的硬件解码器。
export async function verifyHardwareCodec(mimeType: string, width?: number, height?: number): Promise<void> {
  try {
    if (!navigator.mediaCapabilities || !navigator.mediaCapabilities.decodingInfo) return
    const contentType = mimeType.includes('codecs')
      ? mimeType
      : `${mimeType.split(';')[0]}; codecs="avc1.64001f"`
    const info = await navigator.mediaCapabilities.decodingInfo({
      type: 'media-source',
      video: {
        contentType,
        width: width || 1920,
        height: height || 1080,
        bitrate: 8000000,
        framerate: 30,
      },
    })
    if (info.powerEfficient) {
      logger.info(`[VideoPlayer] 硬解确认: ${contentType} 由硬件解码引擎 ${state._hwEngineName || '本机硬件解码器'} 承担 (powerEfficient=true)`)
    } else {
      logger.warn(`[VideoPlayer] 硬解确认: ${contentType} 未获得硬件解码 (powerEfficient=false)，硬解模式不做软解降级`)
    }
  } catch (_) { /* 能力查询失败不影响播放 */ }
}