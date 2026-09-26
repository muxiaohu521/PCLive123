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
  }

  interface SniffResponse {
    success: boolean
    error?: string
    urls: SniffResult[]
    totalFound?: number
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
      createStreamSession: (url: string, headers?: Record<string, string>, detectedFormat?: string) => Promise<{ sessionId: string; proxyUrl: string; proxyPort: number; detectedFormat?: string; resolvedUrl?: string }>
      closeStreamSession: (sessionId: string) => Promise<boolean>
      registerVideoHeaders: (domainKey: string, domainName: string, headers: Record<string, string>) => Promise<boolean>
      unregisterVideoHeaders: (domainKey: string) => Promise<boolean>

      setNetworkingConfig: (config: NetworkingConfig) => Promise<boolean>
      clearNetworkingConfig: () => Promise<boolean>

      openFileDialog: (options?: {
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
      onFloatVideoUpdate: (callback: (data: { url: string; headers: Record<string, string>; format: string; title: string; currentTime?: number; playing?: boolean }) => void) => () => void

      mirrorSignal: (data: any) => Promise<void>
      onMirrorSignal: (callback: (data: any) => void) => () => void
      dlnaDiscover: () => Promise<{ success: boolean; error?: string; devices: DlnaDevice[] }>
      dlnaCast: (deviceIndex: number, videoUrl: string) => Promise<{ success: boolean; error?: string }>
      dlnaStop: (deviceIndex: number) => Promise<{ success: boolean; error?: string }>
      dlnaPause: (deviceIndex: number) => Promise<{ success: boolean; error?: string }>
      dlnaSetVolume: (deviceIndex: number, volume: number) => Promise<{ success: boolean; error?: string }>

      ffmpegSelectPath: () => Promise<{ success: boolean; path: string }>
      ffmpegTest: (ffmpegPath: string) => Promise<{ success: boolean; version: string; error?: string }>
      ffmpegCreateSession: (sourceUrl: string, headers: Record<string, string>, ffmpegPath: string, seekTime?: number, inputFormat?: string) => Promise<{ success: boolean; sessionId?: string; proxyUrl?: string; port?: number; detectedFormat?: string; duration?: number; error?: string }>
      ffmpegCloseSession: (sessionId: string) => Promise<boolean>
      onFfmpegStderr: (callback: (data: { sessionId: string; line: string }) => void) => () => void
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