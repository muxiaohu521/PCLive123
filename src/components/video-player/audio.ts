/**
 * video-player — 主界面音频隔离与音量应用
 *
 * 主界面音频统一接入 PlaybackStreamHub：唯一一条 createMediaElementSource 分支为
 * 「主界面扬声器增益通路 + 悬浮窗镜像音轨通路」，从源头切断主界面音量/静音对
 * 悬浮窗/投屏/录屏/画中画音频的污染（规避 Chromium 对 captureStream 音轨的截断）。
 */

import { state } from './state'
import { ctx } from './context'
import { playbackStreamHub } from '@/services/PlaybackStreamHub'

/**
 * 拦截 <video>.volume / <video>.muted 实例属性：读时返回 store 逻辑音量，写时落到 store。
 * 原生值恒为满幅（volume=1）、恒非静音（muted=false），从而 createMediaElementSource 派生的
 * 音轨永远满幅、永不 muted，从源头切断主界面音量/静音对悬浮窗/投屏/录屏/画中画音频的污染。
 * 主界面扬声器实际音量改由 PlaybackStreamHub 内的 GainNode 承担（attachVideoElement 时创建）。
 */
export function setupMainAudioIsolation(video: HTMLVideoElement): void {
  const proto = HTMLMediaElement.prototype
  const nativeVolumeSet = Object.getOwnPropertyDescriptor(proto, 'volume')?.set
  const nativeMutedSet = Object.getOwnPropertyDescriptor(proto, 'muted')?.set
  if (!nativeVolumeSet || !nativeMutedSet) return

  // 先把原生 volume / muted 重置为满幅 / 非静音（createMediaElementSource 派生音轨恒满幅、恒非静音）
  try { nativeVolumeSet.call(video, 1) } catch (_) {}
  try { nativeMutedSet.call(video, false) } catch (_) {}

  // 拦截实例属性：逻辑音量 / 静音落到 store，原生值保持满幅 / 非静音不变
  const clampVol = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))

  Object.defineProperty(video, 'volume', {
    configurable: true,
    enumerable: true,
    get: () => clampVol(ctx.store.volume),
    set: (v: number) => {
      ctx.store.volume = clampVol(v)
    },
  })
  Object.defineProperty(video, 'muted', {
    configurable: true,
    enumerable: true,
    get: () => ctx.store.muted,
    set: (m: boolean) => {
      ctx.store.muted = !!m
    },
  })
}

/** 把主界面逻辑音量（store.volume / store.muted）应用到扬声器增益图与软解音频播放器 */
export function applyMainVolume(): void {
  // 扬声器音量：由 PlaybackStreamHub 的 GainNode 控制（主界面音量/静音只作用于扬声器，绝不回写到 <video>）
  playbackStreamHub.setMainVolume(ctx.store.volume || 0, ctx.store.muted)
  // 软解音频（audio 引擎）的音量/静音跟随主界面逻辑音量
  if (state.audioPlayer) {
    state.audioPlayer.setVolume(ctx.store.muted ? 0 : ctx.store.volume)
    state.audioPlayer.setMuted(ctx.store.muted)
  }
  // 记录给后续新建插件引擎的初始音量（PlayContext.volume / muted）
  state.lastAudioVolume = Math.max(0, Math.min(1, ctx.store.volume || 0))
  state.lastAudioMuted = !!ctx.store.muted
  // <video>.volume / <video>.muted 已被拦截（恒 1 / false），原生 volumechange 不再派发；
  // 手动派发让 ArtPlayer 原生音量面板刷新音量百分比 / 静音图标。
  if (state.art) {
    try { state.art.video.dispatchEvent(new Event('volumechange')) } catch (_) {}
  }
}