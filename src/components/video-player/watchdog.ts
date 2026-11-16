/**
 * video-player — 超时 / 看门狗
 *
 * 源切换超时、停滞（stall）检测与统一重载入口。视频流解析模式的播放地址
 * 多为一次性 token，重载前会优先重新解析获取全新地址。
 */

import { state, STALL_RELOAD_COOLDOWN_MS, SOURCE_TIMEOUT_MS } from './state'
import { ctx } from './context'
import { logger } from '@/utils/logger'
import { loadUrl } from './loader'

export function clearSourceTimeout(): void {
  if (state.sourceTimeout !== null) {
    clearTimeout(state.sourceTimeout)
    state.sourceTimeout = null
  }
}

export function clearStallWatchdog(): void {
  if (state._stallWatchdog !== null) {
    clearTimeout(state._stallWatchdog)
    state._stallWatchdog = null
  }
}

export function isHlsBufferStallError(details: string): boolean {
  return details === 'bufferStalledError' || details === 'bufferSeekOverHole' || details === 'bufferNudgeOnStall'
}

// 一次性 token 过期后 CDN 对分片请求返回 401/403/410，hls.js 上报 networkError
// （fragLoadError/levelLoadError/manifestLoadError）。这类错误不会触发 mediaError 缓冲分支，
// 必须单独识别：只有明确的鉴权/过期状态码才触发重载，避免把瞬时网络抖动误判为 token 过期。
export function isHlsTokenExpiredNetworkError(data: any): boolean {
  if (!data || data.type !== 'networkError') return false
  const code = data.response && data.response.code
  return code === 401 || code === 403 || code === 410
}

// `<video>` 元素的 waiting/stalled 事件仅当 video 元素自身直连网络源（auto/hardware
// 的 hls.js / mpegts.js / 原生播放）时才具有「停滞检测」意义。
// 软解/外置 FFmpeg 由 video 元素读取本地转码流、FFmpeg 内部自行重连；MPV/VLC 则完全
// 脱离 video 元素。这些模式下 waiting/stalled 多为启动期/分离期的假信号，若据此触发
// reloadForStall 会把 FFmpeg/MPV/VLC 会话杀掉重开，形成无限重载循环。
export function isStallReloadMode(): boolean {
  return ctx.store.decodeMode === 'auto' || ctx.store.decodeMode === 'hardware'
}

export function reloadForStall(reason: string): void {
  // 不再要求 hasEverPlayed：缓冲空洞/停滞（bufferSeekOverHole / bufferStalledError）
  // 常发生在直播边缘缺口，首帧前后都可能出现；此前的门槛会把这些情况全部漏掉。
  // 3 秒冷却仍会防止短时间内重复重载；waiting/stalled 监听层仍各自保留 hasEverPlayed 门槛。
  if (!state.lastLoadUrl) return
  if (ctx.store.activePlayMode === 'local') return
  const now = Date.now()
  if (now - state._lastStallReloadAt < STALL_RELOAD_COOLDOWN_MS) return
  state._lastStallReloadAt = now
  logger.warn(`[VideoPlayer] ${reason}, reloading stream`)
  void reloadStreamWithFreshToken(reason)
}

// 缓冲耗尽 / 卡住 / 播放中断后的统一重载入口。
// 视频流解析模式（官网直播源、央视频 CDN 等）的播放地址多为一次性 token，
// 直接重载旧地址会命中过期 token 导致重连失败、反复播放缓存。这里先重新解析拿到
// 全新地址，由 store.refreshSnifferStream 更新 externalPlayInfo + streamRefreshSeq
// 触发 props watch 完成重载；解析失败再回退到旧地址重载。
export async function reloadStreamWithFreshToken(reason: string): Promise<void> {
  const capturedGenId = state.loadGenerationId
  if (ctx.isExternalPlay.value) {
    // 一次性 token 重签失败时退避重试（央视频 JCE 接口偶发抖动），
    // 连续多次仍失败才回退重载旧地址（此时旧 token 多半已过期，仅作最后兜底）。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (capturedGenId !== state.loadGenerationId) return
      try {
        const fresh = await ctx.store.refreshSnifferStream()
        if (capturedGenId !== state.loadGenerationId) return
        if (fresh) return
        logger.warn(`[VideoPlayer] ${reason}: 重新解析未取得新地址 (attempt ${attempt + 1}/3)`)
      } catch (e) {
        logger.warn(`[VideoPlayer] ${reason}: 重新解析异常 (attempt ${attempt + 1}/3): ${e}`)
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
    }
  }
  if (capturedGenId !== state.loadGenerationId) return
  if (state.lastLoadUrl) loadUrl(state.lastLoadUrl, { ...state.lastLoadHeaders })
}

export function startStallWatchdog(): void {
  clearStallWatchdog()
  state._stallWatchdog = setTimeout(() => {
    state._stallWatchdog = null
    reloadForStall('Stall detected (>5s)')
  }, 5000)
}

export function startSourceTimeout(): void {
  clearSourceTimeout()
  if (ctx.props.info.sourceNum <= 1) return
  if (state.hasEverPlayed) return
  state.sourceTimeout = setTimeout(() => {
    state.sourceTimeout = null
    if (state.hasEverPlayed) return
    logger.warn('[VideoPlayer] Source timeout, switching to next source')
    ctx.emit('sourceTimeout')
  }, SOURCE_TIMEOUT_MS)
}