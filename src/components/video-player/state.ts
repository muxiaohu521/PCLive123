/**
 * video-player — 共享播放器状态单例
 *
 * 原 VideoPlayer.vue 内所有模块级 let 变量统一收敛到本对象，供拆分后的各功能模块
 * 读写。播放器主界面全局仅存在一个实例，模块级单例可安全共享状态。
 */

import type Artplayer from 'artplayer'
import type { SoftwareAudioPlayer } from '@/services/AudioPlayer'
import type { PluginInstance } from '@/player-plugins'
import { StreamSessionManager } from '@/services/StreamSessionManager'
import { NetworkInterceptor } from '@/services/NetworkInterceptor'

// ── 共享常量 ──

export const MAX_RETRIES_PER_LINE = 3
export const AUTO_SAFETY_TIMEOUT_MS = 25000
export const SOURCE_TIMEOUT_MS = 10000
export const STALL_RELOAD_COOLDOWN_MS = 3000

// ── 会话管理服务（跨模块共用，只实例化一次） ──

export const sessionManager = new StreamSessionManager()
export const networkInterceptor = new NetworkInterceptor()

type CleanupFn = (() => void) | null
type TimerHandle = ReturnType<typeof setTimeout> | null

export interface PlayerState {
  art: Artplayer | null
  sourceInfoEl: HTMLElement | undefined
  controlsAdded: boolean
  loadRetries: number
  maxLoadRetries: number
  lastLoadUrl: string
  lastLoadHeaders: Record<string, string>
  loadGenerationId: number
  _playLocalFileGen: number
  lastPlayMode: 'local' | 'channel' | 'sniffer' | 'locallive' | null
  lastDecodeMode: string | null
  _stallWatchdog: TimerHandle
  _lastStallReloadAt: number
  _autoSafetyTimer: TimerHandle
  _autoFallbackUrl: string | null
  _autoFallbackHeaders: Record<string, string> | null
  _autoFallbackGenId: number
  _autoFallbackRunning: Promise<boolean> | null
  confirmedFormat: string | null
  currentFormat: string
  hasEverPlayed: boolean
  sourceTimeout: TimerHandle
  audioPlayer: SoftwareAudioPlayer | null
  activeEngineInstance: PluginInstance | null
  lastAudioVolume: number
  lastAudioMuted: boolean
  _ffmpegDurationCleanup: CleanupFn
  _ffmpegSeekOffset: number
  _ffmpegSeekCleanup: CleanupFn
  _ffmpegCurrentTimeCleanup: CleanupFn
  _ffmpegSeeking: boolean
  _ffmpegSuppressNextSeek: boolean
  _ffmpegSuppressSeekTimer: TimerHandle
  _ffmpegUserSeekTarget: number
  _ffmpegRestartScheduler: ((target: number) => void) | null
  _ffmpegQueuedSeek: number
  _ffmpegOptimisticTarget: number
  _localEndedDetectorCleanup: CleanupFn
  _localEndedFired: boolean
  _videoEventListenersCleanup: CleanupFn
  _controlsLeaveCleanup: CleanupFn
  _errorRetryTimer: TimerHandle
  _ffmpegStderrCleanup: CleanupFn
  _mainDebugLogCleanup: CleanupFn
  _hwStatusLogged: boolean
  _hwEngineName: string
  _hwStatusPromise: Promise<any> | null
  activePopup: HTMLDivElement | null
  activePopupAnchor: HTMLElement | null
}

export const state: PlayerState = {
  art: null,
  sourceInfoEl: undefined,
  controlsAdded: false,
  loadRetries: 0,
  maxLoadRetries: 0,
  lastLoadUrl: '',
  lastLoadHeaders: {},
  loadGenerationId: 0,
  _playLocalFileGen: 0,
  lastPlayMode: null,
  lastDecodeMode: null,
  _stallWatchdog: null,
  _lastStallReloadAt: 0,
  _autoSafetyTimer: null,
  _autoFallbackUrl: null,
  _autoFallbackHeaders: null,
  _autoFallbackGenId: 0,
  _autoFallbackRunning: null,
  confirmedFormat: null,
  currentFormat: '',
  hasEverPlayed: false,
  sourceTimeout: null,
  audioPlayer: null,
  activeEngineInstance: null,
  lastAudioVolume: 0.8,
  lastAudioMuted: false,
  _ffmpegDurationCleanup: null,
  _ffmpegSeekOffset: 0,
  _ffmpegSeekCleanup: null,
  _ffmpegCurrentTimeCleanup: null,
  _ffmpegSeeking: false,
  _ffmpegSuppressNextSeek: false,
  _ffmpegSuppressSeekTimer: null,
  _ffmpegUserSeekTarget: 0,
  _ffmpegRestartScheduler: null,
  _ffmpegQueuedSeek: 0,
  _ffmpegOptimisticTarget: 0,
  _localEndedDetectorCleanup: null,
  _localEndedFired: false,
  _videoEventListenersCleanup: null,
  _controlsLeaveCleanup: null,
  _errorRetryTimer: null,
  _ffmpegStderrCleanup: null,
  _mainDebugLogCleanup: null,
  _hwStatusLogged: false,
  _hwEngineName: '',
  _hwStatusPromise: null,
  activePopup: null,
  activePopupAnchor: null,
}