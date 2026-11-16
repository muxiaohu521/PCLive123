/**
 * player-plugins — 播放引擎插件体系（业界标准化接口定义）
 *
 * 设计目标：
 * - 统一插件接口：所有编解码 / 解封装引擎（hls.js / mpegts.js / dash.js /
 *   webtorrent / Web Audio）实现同一接口。
 * - 格式路由：按媒体格式（m3u8 / flv / ts / mp4 / dash / torrent / audio）自动选择最优引擎。
 * - 生命周期管理：attach → destroy 对称的资源创建与释放。
 * - 能力检测：运行时可探测引擎是否可用，用于 UI 展示与降级决策。
 *
 * 引擎分类：
 * - 'mse'：以 <video> 元素作为输出目标的引擎（容器解封装 / 软解管线）。
 * - 'standalone'：自带 UI / 渲染器的完整播放器，渲染到容器元素而非 <video>，
 *   用于 ArtPlayer 无法直接承载的格式。
 */

import type { DecodeMode } from '@/constants'

/** 媒体容器 / 协议格式 */
export type MediaFormat =
  | 'm3u8' // HLS
  | 'flv' // FLV
  | 'ts' // MPEG-TS
  | 'mp4' // MP4 及浏览器原生支持的视频
  | 'dash' // MPEG-DASH (.mpd)
  | 'torrent' // WebTorrent（magnet / .torrent）
  | 'audio' // 纯音频
  | 'unknown'

/** 引擎类型 */
export type EngineKind = 'mse' | 'standalone'

/** 一次播放请求的上下文 */
export interface PlayContext {
  url: string
  headers: Record<string, string>
  format: MediaFormat
  decodeMode: DecodeMode
  isLive: boolean
  /** 是否允许跨模式回退（auto 为 true，hardware / software 为 false） */
  allowFallback: boolean
  /** 初始音量（0-1），供 Web Audio 等自渲染引擎同步主界面音量 */
  volume?: number
  /** 初始静音状态 */
  muted?: boolean
}

export type PluginEventName = 'error' | 'fatal' | 'ready' | 'playing' | 'pause' | 'waiting' | 'canplay' | 'ended'

export type PluginEventHandler = (...args: any[]) => void

/** 播放会话实例（attach 之后、destroy 之前的生命周期） */
export interface PluginInstance {
  readonly pluginId: string
  readonly kind: EngineKind
  attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): void | Promise<void>
  destroy(): void
  on?(event: PluginEventName, handler: PluginEventHandler): void
  off?(event: PluginEventName, handler: PluginEventHandler): void
}

/** 播放引擎插件定义（静态元信息 + 工厂方法） */
export interface PlayerPlugin {
  readonly id: string
  readonly name: string
  readonly kind: EngineKind
  readonly formats: MediaFormat[]
  /** 数值越大越优先 */
  readonly priority: number
  readonly supportsLive: boolean
  readonly usesMse: boolean
  readonly packageName?: string
  readonly description?: string
  /** 检测该插件在当前环境是否可用 */
  isAvailable(): boolean
  /** 能否播放指定格式 */
  canPlay(format: MediaFormat, context?: Partial<PlayContext>): boolean
  /** 创建播放会话实例 */
  create(context: PlayContext): PluginInstance
}