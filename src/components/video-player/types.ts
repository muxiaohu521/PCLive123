/**
 * video-player — 组件 Props / Emits 类型定义
 *
 * 由 VideoPlayer.vue 的 defineProps / defineEmits 与 useVideoPlayer 共用，
 * 避免薄壳组件与拆分的播放器逻辑各自重复声明。
 */

export interface VideoPlayerProps {
  url: string
  headers: Record<string, string>
  format: string
  volume: number
  muted: boolean
  info: {
    sourceIndex: number
    sourceNum: number
  }
}

export interface VideoPlayerEmits {
  (e: 'playing'): void
  (e: 'pause'): void
  (e: 'ended'): void
  (e: 'error'): void
  (e: 'prevSource'): void
  (e: 'nextSource'): void
  (e: 'prevChannel'): void
  (e: 'nextChannel'): void
  (e: 'sourceTimeout'): void
  (e: 'seek', time: number): void
}