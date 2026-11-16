/**
 * video-player — 组件上下文
 *
 * 存放只能在组件 setup 作用域内获得的依赖（props / emit / store / playerEl /
 * 字幕 / 悬浮窗等），由 useVideoPlayer 在初始化时填充，拆分后的各功能模块
 * 通过 ctx 统一访问，避免在模块间层层透传参数。
 */

import type { ComputedRef, Ref } from 'vue'
import { useAppStore } from '@/store'
import { hasIpv6Hint } from '@/models/LiveChannelItem'
import type { VideoPlayerProps, VideoPlayerEmits } from './types'

export interface MirrorControlHandler {
  togglePlay: () => void
  closeFloat: () => void
}

export interface PlayerContext {
  props: VideoPlayerProps
  emit: VideoPlayerEmits
  store: ReturnType<typeof useAppStore>
  playerEl: Ref<HTMLElement | null>
  isExternalPlay: ComputedRef<boolean>
  subtitleEnabled: Ref<boolean>
  subtitleVttUrl: Ref<string | null>
  toggleSubtitle: () => void
  destroySubtitle: () => void
  openFloatWindow: (art?: unknown) => Promise<void>
  closeFloatWindow: () => Promise<void>
  setControlHandler: (handler: MirrorControlHandler) => void
  destroyMirror: () => void
}

export const ctx: PlayerContext = {} as PlayerContext

/** 判断当前频道是否应优先使用 IPv6（仅官网直播源模式，且本机具备 IPv6） */
export async function computePreferIpv6(url: string): Promise<boolean> {
  const store = ctx.store
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