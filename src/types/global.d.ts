import type Hls from 'hls.js'
import type { SourceItem } from '@/constants'

interface FileDialogResult {
  filePath?: string
  content?: string
  fileName?: string
  success?: boolean
  error?: string
}

interface NetworkingConfig {
  hosts?: string[]
  proxy?: { host: string; port: number; username?: string; password?: string }
}

declare global {
  interface WebviewTag extends HTMLElement {
    src: string
    insertCSS(css: string): void
    executeJavaScript(code: string, userGesture?: boolean): Promise<any>
  }

  interface SniffResult {
    url: string
    sourceUrl: string
    format: string
    contentType: string
    isLive: boolean
    siteMeta?: { site: string; bvid?: string; cid?: number; pid?: string; aid?: number; title?: string; pageUrl?: string }
    fromApi?: boolean
    _isCrawl?: boolean
  }

  interface SniffResponse {
    success: boolean
    error?: string
    urls: SniffResult[]
    totalFound?: number
    phase?: string
    hint?: string
  }

  interface DlnaDevice {
    location: string
    st: string
    server: string
    usn: string
    host: string
    port: number
    friendlyName: string
    manufacturer: string
    modelName: string
    avTransportUrl: string
    renderingControlUrl: string
    connectionManagerUrl: string
  }

  interface TlvCastOptions {
    format?: 'auto' | 'hls' | 'mpegts'
    quality?: 'original' | '1080p' | '720p' | '480p' | '360p'
    position?: number
  }

  interface TlvDevice {
    host: string
    displayHost?: string
    port: number
    app: string
    version: string
    deviceName: string
    deviceModel: string
    manufacturer: string
    caps: string[]
    isTVLive: boolean
    autoconnect: boolean
    isEmulator?: boolean
  }

  interface Window {
    Hls: typeof Hls
    electronAPI?: {
      isDev: boolean
      minimize: () => void
      maximize: () => void
      close: () => void
      getStoreValue: (key: string) => any
      setStoreValue: (key: string, value: any) => void
      deleteStoreValue: (key: string) => Promise<boolean>
      fetchUrl: (url: string, headers?: Record<string, string>) => Promise<string>
      fetchUrlSpider: (url: string, headers?: Record<string, string>) => Promise<{ content: string; statusCode: number; headers: Record<string, string>; finalUrl: string }>

      probeStream: (url: string, headers?: Record<string, string>) => Promise<{ format: string; contentType: string; finalUrl: string; isPlaylist?: boolean; isFlv?: boolean }>
      probeGatewayFormat: (url: string, headers?: Record<string, string>) => Promise<{ format: string; contentType: string; finalUrl: string; isPlaylist?: boolean; isFlv?: boolean }>
      createStreamSession: (url: string, headers?: Record<string, string>, detectedFormat?: string, preferIpv6?: boolean) => Promise<{ sessionId: string; proxyUrl: string; proxyPort: number; detectedFormat?: string; resolvedUrl?: string }>
      closeStreamSession: (sessionId: string) => Promise<boolean>
      registerVideoHeaders: (domainKey: string, domainName: string, headers: Record<string, string>) => Promise<boolean>
      unregisterVideoHeaders: (domainKey: string) => Promise<boolean>

      setNetworkingConfig: (config: NetworkingConfig) => Promise<boolean>
      clearNetworkingConfig: () => Promise<boolean>

      openFileDialog: (options?: {
        title?: string
        filters?: { name: string; extensions: string[] }[]
      }) => Promise<FileDialogResult | null>
      openMediaFile: (options?: {
        title?: string
        filters?: { name: string; extensions: string[] }[]
      }) => Promise<FileDialogResult | null>
      saveFileDialog: (options?: {
        title?: string
        defaultPath?: string
        content?: string
        filters?: { name: string; extensions: string[] }[]
      }) => Promise<FileDialogResult | null>
      readFile: (filePath: string) => Promise<FileDialogResult>
      writeFile: (filePath: string, content: string) => Promise<{ success: boolean; filePath?: string; error?: string }>
      fileExists: (filePath: string) => Promise<boolean>
      openDirectory: () => Promise<{ directoryPath: string } | null>
      scanVideoDirectory: () => Promise<{ directoryPath: string; files: { name: string; filePath: string; size: number }[] } | null>
      getSources: () => Promise<SourceItem[]>
      saveSources: (list: SourceItem[]) => Promise<boolean>
      getSourcesPath: () => Promise<string>
      getChannelCacheEntry: (url: string) => Promise<Record<string, any> | null>
      setChannelCacheEntry: (url: string, entry: Record<string, any>) => Promise<boolean>
      deleteChannelCacheEntry: (url: string) => Promise<boolean>
      clearChannelCache: () => Promise<boolean>
      sniffUrl: (pageUrl: string) => Promise<SniffResponse>
      resolvePlayUrl: (siteMeta: { site: string; bvid?: string; cid?: number; pid?: string; aid?: number; title?: string; pageUrl?: string }) => Promise<{ success: boolean; urls: { url: string; format: string; isLive: boolean }[]; error?: string }>
      createFloatWindow: (videoInfo?: { url: string; headers?: Record<string, string>; format?: string; title?: string; currentTime?: number; playing?: boolean }) => Promise<boolean>
      floatWindowUpdate: (videoInfo: { url: string; headers?: Record<string, string>; format?: string; title?: string; currentTime?: number; playing?: boolean }) => Promise<void>
      closeFloatWindow: () => Promise<void>
      floatWindowExists: () => Promise<boolean>
      toggleFloatFullscreen: () => Promise<void>
      onFloatVideoUpdate: (callback: (data: { url: string; headers: Record<string, string>; format: string; title: string; currentTime?: number; playing?: boolean }) => void) => () => void

      mirrorSignal: (data: any) => Promise<void>
      onMirrorSignal: (callback: (data: any) => void) => () => void
      dlnaDiscover: () => Promise<{ success: boolean; error?: string; devices: DlnaDevice[] }>
      dlnaCast: (deviceIndex: number, videoUrl: string) => Promise<{ success: boolean; error?: string }>
      dlnaStop: (deviceIndex: number) => Promise<{ success: boolean; error?: string }>
      dlnaPause: (deviceIndex: number) => Promise<{ success: boolean; error?: string }>
      dlnaSetVolume: (deviceIndex: number, volume: number) => Promise<{ success: boolean; error?: string }>

      tlv1Discover: (opts?: { expanded?: boolean }) => Promise<{ success: boolean; error?: string; devices: TlvDevice[] }>
      tlv1Cast: (deviceIndex: number, videoUrl: string, options?: TlvCastOptions) => Promise<{ success: boolean; error?: string; sessionId?: string; proxyUrl?: string }>
      tlv1Stop: (deviceIndex: number, sessionId?: string | null) => Promise<{ success: boolean; error?: string }>
      tlv1Seek: (deviceIndex: number, positionSec: number, sessionId: string) => Promise<{ success: boolean; error?: string }>
      tlv1Pause: (deviceIndex: number, sessionId: string, currentPosition?: number) => Promise<{ success: boolean; error?: string; message?: string }>
      tlv1Resume: (deviceIndex: number, sessionId: string) => Promise<{ success: boolean; error?: string; sessionId?: string; proxyUrl?: string; message?: string }>
      tlv1SyncLocalChannels: (deviceIndex: number, channelsData: any) => Promise<{ success: boolean; error?: string; count?: number }>
      tlv1GetSubnets: () => Promise<{ success: boolean; error?: string; subnets: string[] }>
      tlv1GetLocalIps: () => Promise<{ success: boolean; error?: string; ips: string[] }>
      tlv1EmulatorStatus: () => Promise<{ success: boolean; error?: string; available: boolean; adbPath?: string; emulators?: { serial: string; isEmulator: boolean; isNAT: boolean }[]; natEmulators?: { serial: string; isEmulator: boolean; isNAT: boolean }[]; portForwarded?: boolean }>
      tlv1EmulatorForward: () => Promise<{ success: boolean; error?: string; setup: boolean; reason?: string; serial?: string; emulators?: { serial: string; isEmulator: boolean; isNAT: boolean }[] }>
      tlv1Connect: (ip: string) => Promise<{ success: boolean; error?: string; device?: TlvDevice }>
      tlv1SelectAdb: () => Promise<{ success: boolean; path: string; version?: string; error?: string }>
      tlv1SetAdbPath: (path: string | null) => Promise<{ success: boolean; error?: string }>
      tlv1GetAdbPath: () => Promise<{ success: boolean; path: string; isOverride: boolean }>
      tlv1OnLog: (callback: (log: { level: string; msg: string; data?: any; time: string }) => void) => () => void

      ffmpegSelectPath: () => Promise<{ success: boolean; path: string }>
      ffmpegTest: (ffmpegPath: string) => Promise<{ success: boolean; version: string; error?: string }>
      ffmpegCreateSession: (sourceUrl: string, headers: Record<string, string>, ffmpegPath: string, seekTime?: number, inputFormat?: string) => Promise<{ success: boolean; sessionId?: string; proxyUrl?: string; port?: number; detectedFormat?: string; duration?: number; error?: string }>
      ffmpegCloseSession: (sessionId: string) => Promise<boolean>
      onFfmpegStderr: (callback: (data: { sessionId: string; line: string }) => void) => () => void
      mpvSelectPath: () => Promise<{ success: boolean; path: string }>
      mpvTest: (mpvPath: string) => Promise<{ success: boolean; version: string; error?: string }>
      mpvCreateSession: (sourceUrl: string, headers: Record<string, string>, mpvPath: string, seekTime?: number) => Promise<{ success: boolean; sessionId?: string; error?: string }>
      mpvCloseSession: (sessionId: string) => Promise<boolean>
      onMpvPlaybackEnded: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void

      vlcSelectPath: () => Promise<{ success: boolean; path: string }>
      vlcTest: (vlcPath: string) => Promise<{ success: boolean; version: string; error?: string }>
      vlcCreateSession: (sourceUrl: string, headers: Record<string, string>, vlcPath: string, seekTime?: number) => Promise<{ success: boolean; sessionId?: string; error?: string }>
      vlcCloseSession: (sessionId: string) => Promise<boolean>
      onVlcPlaybackEnded: (callback: (data: { sessionId: string; exitCode: number }) => void) => () => void

      onMainDebugLog: (callback: (line: string) => void) => () => void

      serveLocalFile: (filePath: string) => Promise<{ success: boolean; token?: string; proxyUrl?: string; error?: string }>
      closeLocalFileServer: (token: string) => Promise<boolean>

      readLocalChannels: () => Promise<any>
      writeLocalChannels: (data: any) => Promise<boolean>

      // 央视频频道列表持久化
      readYspChannels: () => Promise<YspChannelsData>
      writeYspChannels: (data: YspChannelsData) => Promise<boolean>
      openYspChannelsFile: () => Promise<boolean>
      getYspChannelsPath: () => Promise<string>

      // 央视频 (yangshipin.cn) —— 提取官方频道链接
      yspExtractChannels: () => Promise<YspChannelsResult>

      // 录屏（基于 video.captureStream()，直接从 video 元素抓取原始画面+音频）
      recordingSelectOutput: () => Promise<{ success: boolean; path: string }>
      recordingStartStream: (params: { outputPath: string }) => Promise<{ success: boolean; error?: string }>
      recordingWriteChunk: (chunk: ArrayBuffer) => Promise<{ success: boolean }>
      recordingFinishStream: () => Promise<{ success: boolean; error?: string; elapsed?: string; totalBytes?: number; outputPath?: string }>
      recordingStatus: () => Promise<{ recording: boolean; elapsed?: number; totalBytes?: number; outputPath?: string }>
      rendererLog: (msg: string) => void
      hasIpv6: () => Promise<boolean>
    }
  }

  interface YspChannelItem {
    name: string
    pid: string
    url: string
  }

  interface YspChannelsData {
    channels: YspChannelItem[]
  }

  interface YspChannelsResult {
    success: boolean
    channels: YspChannelItem[]
    count: number
    message: string
  }

  interface HTMLVideoElement {
    hls?: Hls
    captureStream(fps?: number): MediaStream
  }
}

export {}