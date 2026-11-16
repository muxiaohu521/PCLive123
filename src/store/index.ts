import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { ChannelService } from '@/services/ChannelService'
import { logger } from '@/utils/logger'
import { STORAGE_KEYS, PLAY_MODES, filePathToUrl, hasElectronAPI, SUPPORTED_VIDEO_EXTENSIONS } from '@/constants'
import type { SourceItem, DecodeMode, LocalVideoItem, LocalVideoBranch, PlayMode, YspChannelItem, YspRoute } from '@/constants'
import type { LiveChannelGroup, LiveChannelItem, LiveSourceGroup } from '@/models/LiveChannelItem'
import {
  getChannelUrl,
  getChannelHeaders,
  nextSource,
  preSource,
} from '@/models/LiveChannelItem'

interface ChannelState {
  groupIndex: number
  livesIndex: number
  channelName: string
  channelIndex: number
  sourceUrl: string
}

interface SourceStat {
  channelCount: number
  parsedAt: number
}

interface SourceStatMap {
  [url: string]: SourceStat
}

interface LocalChannel {
  name: string
  urls: string[]
}

interface LocalChannelsData {
  lives: LocalChannel[]
}

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function saveChannelState(state: ChannelState): void {
  localStorage.setItem(STORAGE_KEYS.CHANNEL_STATE, JSON.stringify(state))
}

function loadChannelState(): ChannelState | null {
  return safeJsonParse<ChannelState | null>(
    localStorage.getItem(STORAGE_KEYS.CHANNEL_STATE),
    null,
  )
}

function loadSources(): SourceItem[] {
  return safeJsonParse<SourceItem[]>(
    localStorage.getItem(STORAGE_KEYS.SOURCES),
    [],
  )
}

function saveSourcesLocal(list: SourceItem[]): void {
  localStorage.setItem(STORAGE_KEYS.SOURCES, JSON.stringify(list))
}

async function loadSourcesFromFile(): Promise<SourceItem[]> {
  if (hasElectronAPI()) {
    try {
      const list = await window.electronAPI!.getSources()
      if (list && list.length > 0) {
        return list
      }
    } catch (e) {
      logger.error('Failed to load sources from file:', e)
    }
  }
  // Browser/dev fallback: fetch sources.json via HTTP (served by Vite dev server)
  try {
    const resp = await fetch('/sources.json')
    if (resp.ok) {
      const list = await resp.json()
      if (Array.isArray(list) && list.length > 0) {
        return list
      }
    }
  } catch (_) { /* ignore fetch errors in non-Electron env */ }
  return []
}

function saveSourcesToFile(list: SourceItem[]): void {
  if (hasElectronAPI()) {
    try {
      window.electronAPI!.saveSources(list)
    } catch (e) {
      logger.error('Failed to save sources to file:', e)
    }
  }
}

function loadCurrentSource(): string {
  return localStorage.getItem(STORAGE_KEYS.CURRENT_SOURCE) || ''
}

function saveCurrentSource(url: string): void {
  localStorage.setItem(STORAGE_KEYS.CURRENT_SOURCE, url)
}

function persistSourceList(list: SourceItem[]): void {
  saveSourcesLocal(list)
  saveSourcesToFile(list)
}

async function deleteSourceCache(url: string): Promise<void> {
  if (typeof window !== 'undefined' && window.electronAPI?.deleteChannelCacheEntry) {
    try {
      await window.electronAPI.deleteChannelCacheEntry(url)
      logger.log('deleteSourceCache: deleted cache for', url)
    } catch (e) {
      logger.warn('deleteSourceCache: failed to delete cache for', url, e)
    }
  }
}

function loadVolume(): number {
  const raw = localStorage.getItem(STORAGE_KEYS.VOLUME)
  if (raw) {
    const v = parseFloat(raw)
    if (!isNaN(v)) return v
  }
  return 0.8
}

function loadDecodeMode(): DecodeMode {
  const raw = localStorage.getItem(STORAGE_KEYS.DECODE_MODE)
  if (raw === 'hardware' || raw === 'software' || raw === 'auto' || raw === 'mpv' || raw === 'vlc' || raw === 'ffmpeg') return raw
  return 'auto'
}

function saveDecodeMode(mode: DecodeMode): void {
  localStorage.setItem(STORAGE_KEYS.DECODE_MODE, mode)
}

function loadFfmpegPath(): string {
  return localStorage.getItem(STORAGE_KEYS.FFMPEG_PATH) || ''
}

function saveFfmpegPath(path: string): void {
  if (path) {
    localStorage.setItem(STORAGE_KEYS.FFMPEG_PATH, path)
  } else {
    localStorage.removeItem(STORAGE_KEYS.FFMPEG_PATH)
  }
}

function loadMpvPath(): string {
  const val = localStorage.getItem(STORAGE_KEYS.MPV_PATH) || ''
  logger.info(`[Store] loadMpvPath: ${val ? val : '(empty)'}`)
  return val
}

function saveMpvPath(path: string): void {
  logger.info(`[Store] saveMpvPath: ${path ? path : '(cleared)'}`)
  if (path) {
    localStorage.setItem(STORAGE_KEYS.MPV_PATH, path)
  } else {
    localStorage.removeItem(STORAGE_KEYS.MPV_PATH)
  }
}

function loadVlcPath(): string {
  return localStorage.getItem(STORAGE_KEYS.VLC_PATH) || ''
}

function saveVlcPath(path: string): void {
  if (path) {
    localStorage.setItem(STORAGE_KEYS.VLC_PATH, path)
  } else {
    localStorage.removeItem(STORAGE_KEYS.VLC_PATH)
  }
}

function loadSourceStats(): Map<string, SourceStat> {
  const raw = localStorage.getItem(STORAGE_KEYS.SOURCE_STATS)
  if (!raw) return new Map()
  try {
    const obj: SourceStatMap = JSON.parse(raw)
    const map = new Map<string, SourceStat>()
    for (const [url, stat] of Object.entries(obj)) {
      map.set(url, stat)
    }
    return map
  } catch {
    return new Map()
  }
}

function saveSourceStats(stats: Map<string, SourceStat>): void {
  const obj: SourceStatMap = {}
  for (const [url, stat] of stats.entries()) {
    obj[url] = stat
  }
  localStorage.setItem(STORAGE_KEYS.SOURCE_STATS, JSON.stringify(obj))
}

// Channel source index memory: saves current source before switching channels.
// Max 50 entries, FIFO — oldest is evicted when limit exceeded.
const channelSourceMemory = new Map<string, number>()
const MAX_CHANNEL_SOURCE_MEMORY = 50

function saveChannelSourceIndex(channelName: string, sourceIndex: number): void {
  // Delete first if already exists (to refresh position as newest)
  channelSourceMemory.delete(channelName)
  channelSourceMemory.set(channelName, sourceIndex)
  // FIFO eviction: delete oldest entry when over limit
  if (channelSourceMemory.size > MAX_CHANNEL_SOURCE_MEMORY) {
    const oldest = channelSourceMemory.keys().next().value
    if (oldest) channelSourceMemory.delete(oldest)
  }
}

function restoreChannelSourceIndex(channel: LiveChannelItem): void {
  const saved = channelSourceMemory.get(channel.channelName)
  if (saved !== undefined && saved >= 0 && saved < channel.sourceNum) {
    channel.sourceIndex = saved
  }
}

function loadLocalVideoBranches(): LocalVideoBranch[] {
  const raw = safeJsonParse<LocalVideoBranch[] | null>(
    localStorage.getItem(STORAGE_KEYS.LOCAL_VIDEO_BRANCHES),
    null,
  )
  if (raw && Array.isArray(raw) && raw.length > 0) {
    return raw
  }
  // 迁移旧格式: 将旧的单个列表转换为默认分支
  const oldVideos = safeJsonParse<LocalVideoItem[]>(
    localStorage.getItem(STORAGE_KEYS.LOCAL_VIDEOS),
    [],
  )
  if (oldVideos.length > 0) {
    const defaultBranch: LocalVideoBranch = {
      id: generateBranchId(),
      name: '默认列表',
      videos: oldVideos.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    }
    // 清除旧格式数据
    localStorage.removeItem(STORAGE_KEYS.LOCAL_VIDEOS)
    return [defaultBranch]
  }
  return []
}

function generateBranchId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function saveLocalVideoBranches(branches: LocalVideoBranch[]): void {
  localStorage.setItem(STORAGE_KEYS.LOCAL_VIDEO_BRANCHES, JSON.stringify(branches))
}

function loadActiveLocalVideoBranchId(): string {
  return localStorage.getItem(STORAGE_KEYS.LOCAL_VIDEO_ACTIVE_BRANCH) || ''
}

function saveActiveLocalVideoBranchId(id: string): void {
  if (id) {
    localStorage.setItem(STORAGE_KEYS.LOCAL_VIDEO_ACTIVE_BRANCH, id)
  } else {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_VIDEO_ACTIVE_BRANCH)
  }
}

function loadLocalPlayMode(): PlayMode {
  const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_PLAY_MODE)
  if (raw === PLAY_MODES.SINGLE_LOOP || raw === PLAY_MODES.SEQUENTIAL || raw === PLAY_MODES.RANDOM) {
    return raw
  }
  return PLAY_MODES.SEQUENTIAL
}

function saveLocalPlayMode(mode: PlayMode): void {
  localStorage.setItem(STORAGE_KEYS.LOCAL_PLAY_MODE, mode)
}

export const useAppStore = defineStore('app', () => {
  const sourceList = ref<SourceItem[]>([])
  const currentSource = ref<string>(loadCurrentSource())
  const channelGroups = ref<LiveChannelGroup[]>([])
  const currentGroupIndex = ref(0)
  const currentChannel = ref<LiveChannelItem | null>(null)
  const channelsLoading = ref(false)
  const livesGroups = ref<LiveSourceGroup[]>([])
  const currentLivesIndex = ref(0)

  const sourceStats = ref<Map<string, SourceStat>>(loadSourceStats())
  const sourceError = ref<string>('')
  const connectivityTesting = ref(false)
  const connectivityMode = ref<'all' | 'unparsed'>('unparsed')
  const connectivityProgress = ref({ current: 0, total: 0, currentName: '' })
  const showToolsDialog = ref(false)

  let connectAbortController: AbortController | null = null

  const volume = ref(loadVolume())
  const muted = ref(false)
  const playing = ref(false)
  const videoPaused = ref(true)
  const showChannelList = ref(false)
  const showSourceManager = ref(false)
  const showLivesPanel = ref(false)
  const showYspPanel = ref(false)
  const externalPlayInfo = ref<{ url: string; headers: Record<string, string>; format: string; title: string } | null>(null)
  // 当前 externalPlayInfo 是否来自「视频流解析线路」（applyYspRoute 解析结果）。
  // 只有来自线路的地址才能按线路元数据重新解析拿全新一次性 token。
  const externalPlayFromRoute = ref(false)
  const pendingSniffUrl = ref<{ url: string; format: string; name: string } | null>(null)
  const showDlna = ref(false)
  // 投屏参数（画质/格式）：工具箱「投屏」页统一维护，DlnaPanel 投屏时读取
  const castQuality = ref<'original' | '1080p' | '720p' | '480p' | '360p'>('original')
  const castFormat = ref<'auto' | 'hls' | 'mpegts'>('auto')
  // 播放器「工具」菜单快捷启动请求：下载/录屏直接开始（ts 用于触发重复请求）
  const toolQuickStart = ref<{ kind: 'download' | 'record'; ts: number } | null>(null)
  const showSyncTVPanel = ref(false)
  const showSettings = ref(false)
  const localChannelsData = ref<LocalChannelsData>({ lives: [] })
  const yspChannels = ref<YspChannelItem[]>([])
  const yspWebviewUrl = ref<string>('')
  const yspWebviewTitle = ref<string>('')
  const yspCurrentChannelIndex = ref(-1)
  const yspCurrentRouteIndex = ref(0)
  const yspIsStreamMode = ref(false)
  // 视频流解析模式的错误提示（该模式严禁回退网页，解析失败时只提示，不加载任何网页）
  const yspStreamError = ref<string>('')
  const mpvActive = ref(false)
  const showLocalChannelsList = ref(false)
  const activeLocalLiveChannelIndex = ref(-1)
  const decodeMode = ref<DecodeMode>(loadDecodeMode())
  const ffmpegPath = ref<string>(loadFfmpegPath())
  // 内置 FFmpeg：仅供软解（decodeMode='software'）使用，与外置用户选择的 FFmpeg 互斥隔离。
  const builtinFfmpegPath = ref<string>('')
  const mpvPath = ref<string>(loadMpvPath())
  const vlcPath = ref<string>(loadVlcPath())
  const localVideoBranches = ref<LocalVideoBranch[]>(loadLocalVideoBranches())
  const activeLocalVideoBranchId = ref<string>(initActiveBranchId())

  function initActiveBranchId(): string {
    const saved = loadActiveLocalVideoBranchId()
    if (saved && localVideoBranches.value.some(b => b.id === saved)) {
      return saved
    }
    const firstId = localVideoBranches.value[0]?.id || ''
    saveActiveLocalVideoBranchId(firstId)
    return firstId
  }
  const localVideoList = computed<LocalVideoItem[]>(() => {
    const branch = localVideoBranches.value.find(b => b.id === activeLocalVideoBranchId.value)
    return branch?.videos || []
  })
  const localPlayMode = ref<PlayMode>(loadLocalPlayMode())
  const currentLocalVideo = ref<LocalVideoItem | null>(null)
  const showLocalVideoList = ref(false)
  const activePlayMode = ref<'local' | 'channel' | 'sniffer' | 'locallive' | null>(null)
  const localLiveChannelSourceIndex = ref(0)

  const currentGroup = computed(() => {
    if (channelGroups.value.length === 0) return null
    const idx = Math.min(currentGroupIndex.value, channelGroups.value.length - 1)
    return channelGroups.value[idx]
  })

  const currentUrl = computed(() => {
    if (activePlayMode.value === 'local' || activePlayMode.value === 'sniffer') {
      return externalPlayInfo.value?.url || ''
    }
    if (activePlayMode.value === 'locallive') {
      const info = localChannelCurrentInfo.value
      if (!info) return ''
      const idx = Math.min(localLiveChannelSourceIndex.value, info.urls.length - 1)
      return info.urls[idx] || ''
    }
    if (activePlayMode.value === 'channel' && currentChannel.value) {
      const ch = currentChannel.value
      return ch.channelUrls[ch.sourceIndex] || ''
    }
    return ''
  })

  const currentHeaders = computed(() => {
    if (activePlayMode.value === 'local' || activePlayMode.value === 'sniffer' || activePlayMode.value === 'locallive') {
      return externalPlayInfo.value?.headers || {}
    }
    if (activePlayMode.value === 'channel' && currentChannel.value) {
      return getChannelHeaders(currentChannel.value)
    }
    return {}
  })

  const currentFormat = computed(() => {
    if (activePlayMode.value === 'local' || activePlayMode.value === 'sniffer' || activePlayMode.value === 'locallive') {
      return externalPlayInfo.value?.format || ''
    }
    if (activePlayMode.value === 'channel' && currentChannel.value) {
      if (currentChannel.value.channelFormat) {
        return currentChannel.value.channelFormat
      }
      const url = getChannelUrl(currentChannel.value)
      const lower = url.split('?')[0].split('#')[0].toLowerCase()
      if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return 'm3u8'
      if (lower.endsWith('.flv')) return 'flv'
      if (lower.endsWith('.ts') || lower.endsWith('.m2ts')) return 'ts'
      if (/\.(mp4|mov|webm|mkv|m4v|3gp|3g2|ogv|ogg|oga|mp3|m4a|aac|wav|flac|opus|wma|ape|alac|aiff|aif|amr|awb|ac3|eac3|dts|dtshd|pcm|lpcm|spx)$/i.test(lower)) return 'mp4'
      return ''
    }
    return ''
  })

  // 悬浮窗「副本播放」同步源描述：悬浮窗据此独立播放与主窗口完全一致的副本。
  // 仅 Artplayer 播放器（本地视频 / 在线联网视频 / 直播源 / 嗅探 / 视频流解析版）接入本接口。
  // 官网直播源的网页版（webview）不接入：它没有主窗口 <video>，也不参与录屏 / 悬浮窗 / 投屏 / 画中画。
  // - stream：内置解码 / 嗅探 / 直播源 / 外部播放器的直链源 → 悬浮窗独立拉流播放
  // - none：当前无播放
  const floatSource = computed<{
    type: 'none' | 'stream'
    url?: string
    headers?: Record<string, string>
    format?: string
  }>(() => {
    const url = currentUrl.value
    if (url) {
      return {
        type: 'stream',
        url,
        headers: currentHeaders.value,
        format: currentFormat.value,
      }
    }
    return { type: 'none' }
  })

  const sortedSourceList = computed(() => {
    const stats = sourceStats.value
    const valid: SourceItem[] = []
    const invalid: SourceItem[] = []

    for (const s of sourceList.value) {
      const stat = stats.get(s.url)
      if (stat && stat.channelCount > 0) {
        valid.push(s)
      } else {
        invalid.push(s)
      }
    }

    valid.sort((a, b) => {
      const ca = stats.get(a.url)!.channelCount
      const cb = stats.get(b.url)!.channelCount
      if (ca !== cb) return cb - ca
      return a.name.localeCompare(b.name, 'zh-CN')
    })

    invalid.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return [...valid, ...invalid]
  })

  const localChannelCurrentInfo = computed<LocalChannel | null>(() => {
    const list = localChannelsData.value.lives
    if (activeLocalLiveChannelIndex.value >= 0 && activeLocalLiveChannelIndex.value < list.length) {
      return list[activeLocalLiveChannelIndex.value]
    }
    return null
  })

  let _statsSaveTimer: ReturnType<typeof setTimeout> | null = null

function _doPersistSourceStats(): void {
    saveSourceStats(sourceStats.value)
  }

  function persistSourceStats(): void {
    if (_statsSaveTimer !== null) return
    _statsSaveTimer = setTimeout(() => {
      _statsSaveTimer = null
      _doPersistSourceStats()
    }, 2000)
  }

  function flushSourceStats(): void {
    if (_statsSaveTimer !== null) {
      clearTimeout(_statsSaveTimer)
      _statsSaveTimer = null
    }
    _doPersistSourceStats()
  }

  function playExternalUrl(url: string, headers: Record<string, string>, format: string, title: string): void {
    externalPlayInfo.value = { url, headers: headers || {}, format, title }
    externalPlayFromRoute.value = false
    currentChannel.value = null
    currentLocalVideo.value = null
    activeLocalLiveChannelIndex.value = -1
    activePlayMode.value = 'sniffer'
    yspWebviewUrl.value = ''
    yspWebviewTitle.value = ''
  }

  function clearExternalPlay(): void {
    externalPlayInfo.value = null
    externalPlayFromRoute.value = false
    activeLocalLiveChannelIndex.value = -1
    localLiveChannelSourceIndex.value = 0
    if (activePlayMode.value === 'sniffer' || activePlayMode.value === 'locallive') {
      activePlayMode.value = null
    }
  }

  function openMpv(): void {
    mpvActive.value = true
    logger.info('[Store] openMpv: MPV active')
  }

  function closeMpv(): void {
    logger.info(`[Store] closeMpv: was active=${mpvActive.value}`)
    mpvActive.value = false
  }

  function setDecodeMode(mode: DecodeMode): void {
    decodeMode.value = mode
    saveDecodeMode(mode)
  }

  function setFfmpegPath(path: string): void {
    ffmpegPath.value = path
    saveFfmpegPath(path)
  }

  async function initBuiltinFfmpeg(): Promise<void> {
    if (typeof window === 'undefined' || !window.electronAPI?.ffmpegGetBuiltinPath) return
    try {
      const p = await window.electronAPI.ffmpegGetBuiltinPath()
      if (p) {
        builtinFfmpegPath.value = p
        logger.info(`[Store] builtin ffmpeg resolved: ${p}`)
      } else {
        logger.warn('[Store] builtin ffmpeg not found')
      }
    } catch (e) {
      logger.warn('[Store] resolve builtin ffmpeg failed:', e)
    }
  }

  function setMpvPath(path: string): void {
    logger.info(`[Store] setMpvPath: ${path ? path : '(cleared)'}, previous: ${mpvPath.value ? mpvPath.value : '(empty)'}`)
    mpvPath.value = path
    saveMpvPath(path)
  }

  function setVlcPath(path: string): void {
    vlcPath.value = path
    saveVlcPath(path)
  }

  const subtitleStyleVersion = ref(0)
  function bumpSubtitleStyleVersion(): void {
    subtitleStyleVersion.value++
  }

  async function initSources(): Promise<void> {
    const fileSources = await loadSourcesFromFile()
    const localSources = loadSources()
    if (localSources.length > 0) {
      const fileSet = new Set(fileSources.map(s => s.url))
      const localSet = new Set(localSources.map(s => s.url))
      const differed = fileSources.length !== localSources.length
        || localSources.some(s => !fileSet.has(s.url))
        || fileSources.some(s => !localSet.has(s.url))
      if (differed && fileSources.length > 0) {
        logger.log('initSources: localStorage differs from file, using localStorage & re-syncing to file')
      }
      sourceList.value = localSources
      if (differed || fileSources.length === 0) {
        saveSourcesToFile(localSources)
      }
    } else if (fileSources.length > 0) {
      sourceList.value = fileSources
      saveSourcesLocal(fileSources)
    } else {
      sourceList.value = []
    }
    if (sourceList.value.length > 0) {
      const exists = sourceList.value.some((s) => s.url === currentSource.value)
      if (!currentSource.value || !exists) {
        setCurrentSource(sourceList.value[0].url)
      }
    } else {
      if (currentSource.value) setCurrentSource('')
    }
  }

  async function parseSourceStat(source: SourceItem, signal?: AbortSignal): Promise<number> {
    try {
      const groups = await ChannelService.loadChannelsRobust(source.url, {
        signal,
        skipCache: true,
        maxRetries: 2,
        clearSeen: false,
      })
      if (signal?.aborted) return -1
      const totalCh = groups.reduce((sum, g) => sum + g.liveChannels.length, 0)
      sourceStats.value.set(source.url, { channelCount: totalCh, parsedAt: Date.now() })
      persistSourceStats()
      return totalCh
    } catch {
      if (signal?.aborted) return -1
      sourceStats.value.set(source.url, { channelCount: 0, parsedAt: Date.now() })
      persistSourceStats()
      return 0
    }
  }

  async function runConnectivityTest(mode: 'all' | 'unparsed'): Promise<void> {
    if (connectivityTesting.value) return
    connectivityTesting.value = true
    connectivityMode.value = mode

    connectAbortController = new AbortController()
    const connSignal = connectAbortController.signal
    const myController = connectAbortController

    try {
      const sources = [...sourceList.value]
      const stats = sourceStats.value

      const toParse: SourceItem[] = []
      for (const s of sources) {
        const stat = stats.get(s.url)
        if (mode === 'all') {
          toParse.push(s)
        } else if (!stat || stat.channelCount === 0) {
          toParse.push(s)
        }
      }

      if (toParse.length === 0) {
        return
      }

      connectivityProgress.value = { current: 0, total: toParse.length, currentName: '' }

      for (let i = 0; i < toParse.length; i++) {
        if (connSignal.aborted) break
        const s = toParse[i]
        connectivityProgress.value = {
          current: i + 1,
          total: toParse.length,
          currentName: s.name,
        }
        await yieldTick()

        const result = await parseSourceStat(s, connSignal)
        if (connSignal.aborted) break

        if (result === -1) break
      }

      flushSourceStats()
    } finally {
      if (connectAbortController === myController) {
        connectAbortController = null
      }
      connectivityTesting.value = false
      connectivityProgress.value = { current: 0, total: 0, currentName: '' }
    }
  }

  function cancelConnectivityTest(): void {
    connectAbortController?.abort()
    flushSourceStats()
    connectivityTesting.value = false
    connectivityProgress.value = { current: 0, total: 0, currentName: '' }
  }

  function setCurrentSource(url: string): void {
    currentSource.value = url
    saveCurrentSource(url)
  }

  function addSource(name: string, url: string): 'appended' | 'overwritten' {
    const existingIdx = sourceList.value.findIndex((s) => s.url === url)
    if (existingIdx >= 0) {
      sourceList.value[existingIdx] = { name, url }
      persistSourceList(sourceList.value)
      return 'overwritten'
    }
    sourceList.value.push({ name, url })
    persistSourceList(sourceList.value)
    return 'appended'
  }

  function removeSource(url: string): void {
    deleteSourceCache(url)
    sourceList.value = sourceList.value.filter((s) => s.url !== url)
    if (sourceStats.value.has(url)) {
      sourceStats.value.delete(url)
      persistSourceStats()
    }
    if (currentSource.value === url) {
      setCurrentSource(sourceList.value.length > 0 ? sourceList.value[0].url : '')
    }
    persistSourceList(sourceList.value)
  }

  function updateSource(oldUrl: string, name: string, url: string): void {
    const urlChanged = (url !== oldUrl)
    const idx = sourceList.value.findIndex((s) => s.url === oldUrl)
    if (idx >= 0) {
      sourceList.value[idx] = { name, url }
    }
    if (urlChanged) {
      deleteSourceCache(oldUrl)
    }
    if (idx >= 0) {
      persistSourceList(sourceList.value)
    }
    if (sourceStats.value.has(oldUrl)) {
      const stat = sourceStats.value.get(oldUrl)!
      sourceStats.value.delete(oldUrl)
      sourceStats.value.set(url, stat)
      persistSourceStats()
    }
    if (currentSource.value === oldUrl) {
      setCurrentSource(url)
    }
  }

  let loadAbortController: AbortController | null = null
  let loadGeneration = 0
  let loadingSourceUrl: string | null = null

  async function loadChannels(livesIndex?: number, skipCache: boolean = false): Promise<void> {
    const targetUrl = currentSource.value

    if (loadingSourceUrl === targetUrl) {
      return
    }

    loadAbortController?.abort()
    loadAbortController = new AbortController()
    loadingSourceUrl = targetUrl
    channelsLoading.value = true
    const signal = loadAbortController.signal
    const myController = loadAbortController
    const myGeneration = ++loadGeneration
    try {
      const saved = loadChannelState()
      const sameSource = saved && saved.sourceUrl === targetUrl
      const idx = livesIndex ?? (sameSource ? saved!.livesIndex : 0)
      currentLivesIndex.value = idx
      channelGroups.value = []
      sourceError.value = ''
      const result = await ChannelService.loadChannelsRobust(
        targetUrl,
        {
          sourceIndex: 0,
          livesGroupsRef: livesGroups,
          channelGroupsRef: channelGroups,
          signal,
          skipCache,
          maxRetries: 2,
          clearSeen: true,
        },
      )
      if (result.length > 0) {
        currentGroupIndex.value = 0
        if (sameSource) {
          restoreChannel(saved!)
        }
        if (livesIndex !== undefined && saved) {
          saveChannelState({ ...saved, livesIndex, sourceUrl: targetUrl })
        }
      } else {
        sourceError.value = `无法解析直播源，请检查源是否有效（查看控制台了解详情）`
      }
      if (!signal.aborted && (skipCache || result.length > 0)) {
        const totalCh = result.reduce((sum, g) => sum + g.liveChannels.length, 0)
        sourceStats.value.set(targetUrl, { channelCount: totalCh, parsedAt: Date.now() })
        persistSourceStats()
      }
    } catch (e: unknown) {
      if (!signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('timeout') || msg.includes('TIMEDOUT')) {
          sourceError.value = '直播源加载超时，请检查网络或源地址是否可用'
        } else {
          sourceError.value = `直播源加载失败: ${msg}`
        }
      }
    } finally {
      if (myGeneration === loadGeneration) {
        channelsLoading.value = false
        loadingSourceUrl = null
      }
      if (loadAbortController === myController) {
        loadAbortController = null
      }
    }
  }

  function restoreChannel(state: ChannelState): void {
    const groups = channelGroups.value
    if (state.groupIndex < groups.length) {
      const grp = groups[state.groupIndex]
      const ch = grp.liveChannels[state.channelIndex]
      if (ch && ch.channelName === state.channelName) {
        restoreChannelSourceIndex(ch)
        currentGroupIndex.value = state.groupIndex
        currentChannel.value = ch
        return
      }
    }
    for (let gi = 0; gi < groups.length; gi++) {
      const ch = groups[gi].liveChannels.find(
        (c) => c.channelName === state.channelName,
      )
      if (ch) {
        restoreChannelSourceIndex(ch)
        currentGroupIndex.value = gi
        currentChannel.value = ch
        return
      }
    }
  }

  function selectLives(index: number): void {
    if (index === currentLivesIndex.value) return
    currentLivesIndex.value = index
  }

  function selectChannel(channel: LiveChannelItem): void {
    externalPlayInfo.value = null
    currentLocalVideo.value = null
    activeLocalLiveChannelIndex.value = -1
    activePlayMode.value = 'channel'
    yspWebviewUrl.value = ''
    yspWebviewTitle.value = ''
    if (currentChannel.value && currentChannel.value !== channel) {
      saveChannelSourceIndex(currentChannel.value.channelName, currentChannel.value.sourceIndex)
    }
    restoreChannelSourceIndex(channel)
    currentChannel.value = channel
    for (let gi = 0; gi < channelGroups.value.length; gi++) {
      const ci = channelGroups.value[gi].liveChannels.indexOf(channel)
      if (ci >= 0) {
        saveChannelState({
          groupIndex: gi,
          livesIndex: currentLivesIndex.value,
          channelName: channel.channelName,
          channelIndex: ci,
          sourceUrl: currentSource.value,
        })
        return
      }
    }
  }

  function switchNextSource(): void {
    if (!currentChannel.value) return
    nextSource(currentChannel.value)
  }

  function switchPrevSource(): void {
    if (!currentChannel.value) return
    preSource(currentChannel.value)
  }

  watch(currentSource, () => {
    loadChannels()
  })

  async function refreshCurrentSource(): Promise<void> {
    await loadChannels(undefined, true)
  }

  function _activeBranch(): LocalVideoBranch | undefined {
    return localVideoBranches.value.find(b => b.id === activeLocalVideoBranchId.value)
  }

  function _saveBranches(): void {
    saveLocalVideoBranches(localVideoBranches.value)
  }

  // 确保至少有一个默认分支
  function ensureDefaultBranch(): void {
    if (localVideoBranches.value.length === 0) {
      const defaultBranch: LocalVideoBranch = {
        id: generateBranchId(),
        name: '默认列表',
        videos: [],
      }
      localVideoBranches.value = [defaultBranch]
      activeLocalVideoBranchId.value = defaultBranch.id
      saveActiveLocalVideoBranchId(defaultBranch.id)
      _saveBranches()
    }
  }

  function sortBranchVideos(branch: LocalVideoBranch): void {
    branch.videos.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  function addLocalVideos(videos: LocalVideoItem[]): number {
    ensureDefaultBranch()
    const branch = _activeBranch()
    if (!branch) return 0
    const existingPaths = new Set(branch.videos.map(v => v.filePath))
    const newVideos = videos.filter(v => {
      if (existingPaths.has(v.filePath)) return false
      const ext = v.filePath.substring(v.filePath.lastIndexOf('.')).toLowerCase()
      return (SUPPORTED_VIDEO_EXTENSIONS as readonly string[]).includes(ext)
    })
    if (newVideos.length > 0) {
      branch.videos.push(...newVideos)
      sortBranchVideos(branch)
      _saveBranches()
    }
    return newVideos.length
  }

  function removeLocalVideo(filePath: string): void {
    const branch = _activeBranch()
    if (!branch) return
    branch.videos = branch.videos.filter(v => v.filePath !== filePath)
    _saveBranches()
    if (currentLocalVideo.value?.filePath === filePath) {
      currentLocalVideo.value = null
      if (activePlayMode.value === 'local') {
        externalPlayInfo.value = null
        activePlayMode.value = null
      }
    }
  }

  function clearLocalVideos(): void {
    const branch = _activeBranch()
    if (!branch) return
    branch.videos = []
    _saveBranches()
    currentLocalVideo.value = null
    if (activePlayMode.value === 'local') {
      externalPlayInfo.value = null
      activePlayMode.value = null
    }
  }

  // ========== 分支管理 ==========
  function addLocalVideoBranch(name: string): LocalVideoBranch | null {
    const trimmed = name.trim()
    if (!trimmed) return null
    // 检查重名
    if (localVideoBranches.value.some(b => b.name === trimmed)) return null
    const branch: LocalVideoBranch = {
      id: generateBranchId(),
      name: trimmed,
      videos: [],
    }
    localVideoBranches.value.push(branch)
    activeLocalVideoBranchId.value = branch.id
    saveActiveLocalVideoBranchId(branch.id)
    _saveBranches()
    return branch
  }

  function removeLocalVideoBranch(branchId: string): boolean {
    if (localVideoBranches.value.length <= 1) return false
    const idx = localVideoBranches.value.findIndex(b => b.id === branchId)
    if (idx < 0) return false
    // 清除该分支的当前播放状态
    if (activeLocalVideoBranchId.value === branchId) {
      currentLocalVideo.value = null
      if (activePlayMode.value === 'local') {
        externalPlayInfo.value = null
        activePlayMode.value = null
      }
    }
    localVideoBranches.value.splice(idx, 1)
    // 如果删除的是当前活跃分支，切换到第一个
    if (activeLocalVideoBranchId.value === branchId) {
      const newActive = localVideoBranches.value[0]
      activeLocalVideoBranchId.value = newActive?.id || ''
      saveActiveLocalVideoBranchId(activeLocalVideoBranchId.value)
    }
    _saveBranches()
    return true
  }

  function renameLocalVideoBranch(branchId: string, newName: string): boolean {
    const branch = localVideoBranches.value.find(b => b.id === branchId)
    if (!branch) return false
    const trimmed = newName.trim()
    if (!trimmed) return false
    // 检查重名（排除自己）
    if (localVideoBranches.value.some(b => b.id !== branchId && b.name === trimmed)) return false
    branch.name = trimmed
    _saveBranches()
    return true
  }

  function setActiveLocalVideoBranch(branchId: string): void {
    if (localVideoBranches.value.some(b => b.id === branchId)) {
      activeLocalVideoBranchId.value = branchId
      saveActiveLocalVideoBranchId(branchId)
    }
  }

  const EMPTY_HEADERS: Record<string, string> = {}

  function selectLocalVideo(video: LocalVideoItem): void {
    currentLocalVideo.value = video
    currentChannel.value = null
    activeLocalLiveChannelIndex.value = -1
    const url = filePathToUrl(video.filePath)
    externalPlayInfo.value = { url, headers: EMPTY_HEADERS, format: '', title: video.name }
    activePlayMode.value = 'local'
    yspWebviewUrl.value = ''
    yspWebviewTitle.value = ''
  }

  function setLocalPlayMode(mode: PlayMode): void {
    localPlayMode.value = mode
    saveLocalPlayMode(mode)
  }

  // Prev/Next 按钮 — 始终按列表顺序导航，不受播放模式影响
  function playNextLocalVideo(): void {
    if (localVideoList.value.length === 0) return
    const current = currentLocalVideo.value
    if (!current || !localVideoList.value.find(v => v.filePath === current.filePath)) {
      selectLocalVideo(localVideoList.value[0])
      return
    }
    const currentIdx = localVideoList.value.findIndex(v => v.filePath === current.filePath)
    const nextIdx = (currentIdx + 1) % localVideoList.value.length
    selectLocalVideo(localVideoList.value[nextIdx])
  }

  function playPreviousLocalVideo(): void {
    if (localVideoList.value.length === 0) return
    const current = currentLocalVideo.value
    if (!current || !localVideoList.value.find(v => v.filePath === current.filePath)) {
      selectLocalVideo(localVideoList.value[0])
      return
    }
    const currentIdx = localVideoList.value.findIndex(v => v.filePath === current.filePath)
    const prevIdx = (currentIdx - 1 + localVideoList.value.length) % localVideoList.value.length
    selectLocalVideo(localVideoList.value[prevIdx])
  }

  // 播放结束自动推进 — 受播放模式控制（顺序/随机/单曲循环）
  function autoPlayNextLocalVideo(): void {
    if (localVideoList.value.length === 0) return

    const mode = localPlayMode.value
    const current = currentLocalVideo.value

    if (mode === PLAY_MODES.SINGLE_LOOP) {
      if (current) {
        selectLocalVideo(current)
      } else {
        selectLocalVideo(localVideoList.value[0])
      }
      return
    }

    if (!current || !localVideoList.value.find(v => v.filePath === current.filePath)) {
      selectLocalVideo(localVideoList.value[0])
      return
    }

    if (mode === PLAY_MODES.RANDOM) {
      const others = localVideoList.value.filter(v => v.filePath !== current.filePath)
      if (others.length === 0) {
        selectLocalVideo(localVideoList.value[0])
      } else {
        const randomIdx = Math.floor(Math.random() * others.length)
        selectLocalVideo(others[randomIdx])
      }
      return
    }

    // SEQUENTIAL (default)
    const currentIdx = localVideoList.value.findIndex(v => v.filePath === current.filePath)
    const nextIdx = (currentIdx + 1) % localVideoList.value.length
    selectLocalVideo(localVideoList.value[nextIdx])
  }

  // ========== 本地直播源列表 ==========
  function sortLocalChannelLives(lives: LocalChannel[]): LocalChannel[] {
    const cctv = lives.filter(c => c.name.startsWith('CCTV'))
    const weis = lives.filter(c => !c.name.startsWith('CCTV'))

    cctv.sort((a, b) => {
      const na = parseInt(a.name.replace(/^CCTV/, '').replace(/\+$/, ''))
      const nb = parseInt(b.name.replace(/^CCTV/, '').replace(/\+$/, ''))
      if (na !== nb) return na - nb
      if (a.name.endsWith('+') && !b.name.endsWith('+')) return 1
      if (!a.name.endsWith('+') && b.name.endsWith('+')) return -1
      return 0
    })

    weis.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return [...cctv, ...weis]
  }

  async function loadLocalChannels(): Promise<void> {
    logger.debug('loadLocalChannels: loading verified_channels.json')
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.readLocalChannels) {
        const data = await window.electronAPI.readLocalChannels()
        if (data && Array.isArray(data.lives)) {
          logger.log(`loadLocalChannels: loaded ${data.lives.length} channels`)
          data.lives = sortLocalChannelLives(data.lives)
          localChannelsData.value = data as LocalChannelsData
        } else {
          logger.warn('loadLocalChannels: received invalid data structure', data)
        }
      } else {
        logger.warn('loadLocalChannels: electronAPI not available')
      }
    } catch (e) {
      logger.error('loadLocalChannels failed:', e)
    }
  }

  async function saveLocalChannels(): Promise<boolean> {
    logger.debug('saveLocalChannels: writing verified_channels.json')
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.writeLocalChannels) {
        localChannelsData.value.lives = sortLocalChannelLives(localChannelsData.value.lives)
        const plainData = JSON.parse(JSON.stringify(localChannelsData.value))
        const ok = await window.electronAPI.writeLocalChannels(plainData)
        if (ok) {
          logger.log(`saveLocalChannels: saved ${localChannelsData.value.lives.length} channels`)
        } else {
          logger.warn('saveLocalChannels: write operation returned false')
        }
        return ok
      }
      logger.warn('saveLocalChannels: electronAPI not available')
      return false
    } catch (e) {
      logger.error('saveLocalChannels failed:', e)
      return false
    }
  }

  async function loadYspChannels(): Promise<void> {
    logger.debug('[YSP] loadYspChannels: starting...')
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.readYspChannels) {
        const data = await window.electronAPI.readYspChannels()
        if (data && Array.isArray(data.channels)) {
          yspChannels.value = data.channels.map((c: any) => ({
            name: String(c.name || ''),
            routes: (Array.isArray(c.routes) ? c.routes : (c.url ? [{ name: '默认', url: c.url }] : [])).map((r: any) => ({
              name: String(r.name || ''),
              url: String(r.url || ''),
              type: r.type === 'ijk' ? 'stream' : (r.type || undefined),
            })),
          }))
          logger.info(`[YSP] loaded ${yspChannels.value.length} channels from ysp_channels.json`)
        } else {
          logger.warn('[YSP] loadYspChannels: invalid data structure', data)
        }
      } else {
        logger.warn('[YSP] loadYspChannels: electronAPI not available')
      }
    } catch (e) {
      logger.error('[YSP] loadYspChannels failed:', e)
    }
  }

  async function saveYspChannels(): Promise<boolean> {
    const count = yspChannels.value.length
    logger.debug(`[YSP] saveYspChannels: writing ${count} channels to file...`)
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.writeYspChannels) {
        const plainChannels = yspChannels.value.map((c: YspChannelItem) => ({
          name: String(c.name || ''),
          routes: (c.routes || []).map((r: YspRoute) => {
            const route: any = { name: String(r.name || ''), url: String(r.url || '') }
            if (r.type) route.type = r.type
            return route
          }),
        }))
        const payload = { channels: plainChannels }
        const ok = await window.electronAPI.writeYspChannels(payload)
        if (ok) {
          logger.info(`[YSP] saveYspChannels: wrote ${count} channels successfully`)
        } else {
          logger.error(`[YSP] saveYspChannels: write returned false for ${count} channels`)
        }
        return ok
      }
      logger.warn('[YSP] saveYspChannels: electronAPI not available')
      return false
    } catch (e) {
      logger.error('[YSP] saveYspChannels failed:', e)
      return false
    }
  }

  // ========== YSP 频道/线路切换 ==========

  const yspCurrentChannel = computed<YspChannelItem | null>(() => {
    if (yspCurrentChannelIndex.value >= 0 && yspCurrentChannelIndex.value < yspChannels.value.length) {
      return yspChannels.value[yspCurrentChannelIndex.value]
    }
    return null
  })

  const yspCurrentRoute = computed<YspRoute | null>(() => {
    const ch = yspCurrentChannel.value
    if (!ch || !ch.routes || ch.routes.length === 0) return null
    const idx = Math.min(yspCurrentRouteIndex.value, ch.routes.length - 1)
    return ch.routes[idx] || null
  })

  const yspCurrentRouteType = computed(() => {
    return yspCurrentRoute.value?.type || ''
  })

  function selectYspChannel(index: number): void {
    if (index < 0 || index >= yspChannels.value.length) return
    const ch = yspChannels.value[index]
    const routes = ch.routes || []
    if (routes.length === 0) {
      logger.warn(`[YSP] selectYspChannel: no routes for "${ch.name}"`)
      return
    }
    // 官网直播流默认线路：始终优先选择「视频流解析线路」（type === 'stream'），
    // 该线路支持下载/录屏/投屏/悬浮窗/画中画等完整功能，便于切频道时无缝镜像。
    // 若该频道没有 stream 线路，则回退到第一条线路。
    let routeIndex = 0
    const streamIdx = routes.findIndex((r) => r.type === 'stream')
    if (streamIdx >= 0) routeIndex = streamIdx
    yspCurrentChannelIndex.value = index
    yspCurrentRouteIndex.value = routeIndex
    const route = routes[routeIndex]
    // 清除其他播放模式
    currentChannel.value = null
    currentLocalVideo.value = null
    externalPlayInfo.value = null
    activeLocalLiveChannelIndex.value = -1
    activePlayMode.value = null
    applyYspRoute(route, ch.name)
  }

  function detectYspSite(url: string): string {
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (host.includes('yangshipin.cn')) return 'yangshipin'
      if (host.includes('lotustv.mo')) return 'lotustv'
      if (host.includes('quklive.com')) return 'quklive'
      if (host.includes('tv.cctv.com') || host.includes('cctv.com')) return 'cctv'
      if (host.includes('iqilu.com')) return 'iqilu'
      if (host.includes('mgtv.com')) return 'mgtv'
      if (host.includes('jstv.com')) return 'jstv'
      if (host.includes('hkstv.tv')) return 'hkstv'
      if (host.includes('sxrtv.com')) return 'sxrtv'
      if (host.includes('gdtv.cn')) return 'gdtv'
      if (host.includes('jxntv.cn')) return 'jxntv'
      if (host.includes('hnntv.cn')) return 'hnntv'
      if (host.includes('gxtv.cn')) return 'gxtv'
      if (host.includes('snrtv.com')) return 'snrtv'
      if (host.includes('fjtv.net')) return 'fjtv'
      if (host.includes('qtv.com.cn')) return 'qtv'
      if (host.includes('cztv.com')) return 'cztv'
      if (host.includes('kankanews.com')) return 'kankanews'
      if (host.includes('gzstv.com')) return 'gzstv'
      if (host.includes('nmtv.cn')) return 'nmtv'
      if (host.includes('dbw.cn')) return 'dbw'
      if (host.includes('hebrts.cn')) return 'hebrtv'
      if (host.includes('news.hbtv.com.cn')) return 'hbtv'
      // 未识别站点统一返回 'generic'，交给 sniffer 的通用 HTTP 抓取兜底解析。
      // 严禁回落到 'yangshipin'，否则会用错误的 pid 走央视频解析导致必然失败，
      // 表现为“切到视频流解析线路后仍是网页版”。
      return 'generic'
    } catch (_) {
      return 'generic'
    }
  }

  // 路由/频道切换请求序号：用于丢弃“过期”的异步解析结果，
  // 避免快速切换网页版/视频流解析版时旧线程回写覆盖新状态。
  let yspRouteRequestSeq = 0

  // 播放地址刷新序号：视频流解析模式下播放地址（央视频 CDN m3u8）是一次性 token，
  // 每次切换解码模式都必须重新解析拿全新 token。该序号变化会强制播放器重新加载，
  // 即使新旧地址字符串完全一致也能触发重载。
  const streamRefreshSeq = ref(0)

  // 央视频播放地址 token 有效期约 5 分钟（主进程 YSP_PLAY_URL_CACHE_TTL 对齐）。
  // 播放过程中必须在过期前主动换新 token，否则 hls.js 续取分片会 403 黑屏。
  // 央视频 m3u8 为一次性令牌、分片过期后不会触发代理层/播放器的清单续签，故只能靠定时续签。
  const YSP_TOKEN_REFRESH_INTERVAL_MS = 4 * 60 * 1000
  let yspTokenRefreshTimer: ReturnType<typeof setInterval> | null = null

  // 由线路地址构造站点解析元数据（站点 + pid + 页面地址）
  function buildYspSiteMeta(route: YspRoute) {
    const pidMatch = route.url.match(/[?&]pid=(\d+)/)
    return {
      site: detectYspSite(route.url),
      pid: pidMatch ? pidMatch[1] : undefined,
      pageUrl: route.url,
    }
  }

  // 视频流解析模式：强制清空主进程解析缓存并重新解析，拿到全新一次性 token。
  // 返回新的播放地址（失败返回空字符串，调用方按原逻辑回退）。
  async function refreshSnifferStream(): Promise<string> {
    const route = yspCurrentRoute.value
    const current = externalPlayInfo.value
    if (!route || route.type !== 'stream' || !current || !externalPlayFromRoute.value) return ''
    const meta = buildYspSiteMeta(route)
    // 未识别站点（generic）无法按站点接口重新签发地址，保持原有重载逻辑。
    if (!meta.site || meta.site === 'generic') return ''
    if (typeof window === 'undefined' || !window.electronAPI?.resolvePlayUrl) return ''
    try {
      const result = await window.electronAPI.resolvePlayUrl({
        ...meta,
        forceRefresh: true,
      })
      if (!result || !result.success || !result.urls || result.urls.length === 0) {
        logger.warn('[YSP] refreshSnifferStream: 重新解析未取得新播放地址')
        return ''
      }
      const fresh = result.urls[0]
      if (!fresh || !fresh.url) return ''
      const isM3u8 = fresh.url.toLowerCase().includes('.m3u8')
      externalPlayInfo.value = {
        url: fresh.url,
        headers: fresh.headers || {},
        format: isM3u8 ? 'm3u8' : '',
        title: current.title,
      }
      streamRefreshSeq.value++
      logger.info(`[YSP] refreshSnifferStream: 已换用全新一次性 token url="${fresh.url.substring(0, 80)}"`)
      return fresh.url
    } catch (e: any) {
      logger.warn(`[YSP] refreshSnifferStream error: ${e?.message || e}`)
      return ''
    }
  }

  // 判断当前是否处于「央视频视频流解析模式」。
  // 只有该模式下播放地址才是央视频的一次性 token，需要定时续签。
  function isYspStreamActive(): boolean {
    if (activePlayMode.value !== 'sniffer' || !externalPlayFromRoute.value) return false
    const route = yspCurrentRoute.value
    if (!route || route.type !== 'stream') return false
    return buildYspSiteMeta(route).site === 'yangshipin'
  }

  function stopYspTokenRefresh(): void {
    if (yspTokenRefreshTimer !== null) {
      clearInterval(yspTokenRefreshTimer)
      yspTokenRefreshTimer = null
    }
  }

  // 央视频直播流后台定时续签：在 token 过期（约 5 分钟）前主动换新地址，
  // 避免播放过程中旧 token 被 CDN 回收后分片 403 黑屏。
  // 每次续签成功都会更新 externalPlayInfo + streamRefreshSeq，触发播放器重载新流。
  function startYspTokenRefresh(): void {
    stopYspTokenRefresh()
    if (!isYspStreamActive()) return
    yspTokenRefreshTimer = setInterval(() => {
      // 离开央视频流模式后自动停表，避免后台空转。
      if (!isYspStreamActive()) {
        stopYspTokenRefresh()
        return
      }
      // 暂停时跳过续签，避免续签重载把暂停的画面强行播起来。
      // 恢复播放后若 token 已过期，仍由播放器的 403 兜底逻辑续签。
      if (!playing.value) return
      logger.info('[YSP] 定时续签央视频一次性 token（防止 5 分钟过期黑屏）')
      refreshSnifferStream().catch(() => {})
    }, YSP_TOKEN_REFRESH_INTERVAL_MS)
  }

  async function applyYspRoute(route: YspRoute, channelName: string): Promise<void> {
    const requestSeq = ++yspRouteRequestSeq
    // 每次切频道/切线路都重建播放上下文，旧频道的定时续签表必须停掉，
    // 避免残留定时器拿着旧线路元数据重复续签。
    stopYspTokenRefresh()
    if (route.type === 'stream') {
      yspIsStreamMode.value = true
      yspWebviewUrl.value = ''
      yspWebviewTitle.value = ''
      yspStreamError.value = ''
      // 立即清理上一轮外部播放资源，避免旧视频线程在新地址解析期间继续占用
      externalPlayInfo.value = null
      externalPlayFromRoute.value = false
      // 保持视频流解析模式不变，避免切线路时 activePlayMode 短暂置空导致悬浮窗被关闭
      activePlayMode.value = 'sniffer'

      let videoUrl = ''
      let videoHeaders: Record<string, string> = {}
      if (typeof window !== 'undefined' && window.electronAPI?.resolvePlayUrl) {
        try {
          const siteMeta = buildYspSiteMeta(route)
          const result = await window.electronAPI.resolvePlayUrl(siteMeta)
          if (result && result.success && result.urls.length > 0) {
            videoUrl = result.urls[0].url
            videoHeaders = result.urls[0].headers || {}
            logger.info(`[YSP] applyYspRoute: stream resolved (site=${siteMeta.site}) url="${videoUrl.substring(0, 80)}"`)
          } else {
            logger.warn(`[YSP] applyYspRoute: stream resolve returned no URLs for ${route.url.substring(0, 60)}`)
          }
        } catch (e: any) {
          logger.warn(`[YSP] applyYspRoute: stream resolve error: ${e?.message || e}`)
        }
      }

      // 解析期间若发生了新的路由/频道切换，则丢弃本次结果（含异常路径），
      // 避免旧线程在失败回退时把 webview/stream 状态覆盖回旧频道。
      if (requestSeq !== yspRouteRequestSeq) {
        logger.info(`[YSP] applyYspRoute: discard stale resolve result (seq=${requestSeq})`)
        return
      }

      if (videoUrl) {
        const isM3u8 = videoUrl.toLowerCase().includes('.m3u8')
        const format = isM3u8 ? 'm3u8' : ''
        yspStreamError.value = ''
        externalPlayInfo.value = { url: videoUrl, headers: videoHeaders, format, title: `${channelName} (${route.name})` }
        externalPlayFromRoute.value = true
        activePlayMode.value = 'sniffer'
        // 央视频流模式启动后台定时续签（其他站点由 startYspTokenRefresh 内部自检后直接跳过）。
        startYspTokenRefresh()
      } else {
        // 视频流解析模式严禁回退网页：解析失败时保持流模式、清空播放地址并给出提示，
        // 绝不加载 webview，也绝不把网页地址当成流地址交给播放器/FFmpeg。
        // 关键：保持 activePlayMode = 'sniffer'，这样播放控制栏的线路切换按钮仍然显示，
        // 用户可以直接切到其他线路重试；若置为 null，按钮会被 updateControlLabels 隐藏。
        logger.warn(`[YSP] applyYspRoute: stream resolve failed, webview fallback is disabled in stream mode url="${route.url.substring(0, 60)}"`)
        yspIsStreamMode.value = true
        yspWebviewUrl.value = ''
        yspWebviewTitle.value = ''
        yspStreamError.value = `${channelName}（${route.name}）未能解析出可播放的直播流地址`
        externalPlayInfo.value = null
        externalPlayFromRoute.value = false
        activePlayMode.value = 'sniffer'
      }
    } else {
      yspIsStreamMode.value = false
      yspStreamError.value = ''
      yspWebviewUrl.value = route.url
      yspWebviewTitle.value = `${channelName} (${route.name})`
      externalPlayInfo.value = null
      externalPlayFromRoute.value = false
      activePlayMode.value = null
      logger.info(`[YSP] applyYspRoute: webview mode url="${route.url.substring(0, 60)}"`)
    }
  }

  function nextYspChannel(): void {
    if (yspChannels.value.length === 0) return
    let idx = yspCurrentChannelIndex.value + 1
    if (idx >= yspChannels.value.length) idx = 0
    selectYspChannel(idx)
  }

  function prevYspChannel(): void {
    if (yspChannels.value.length === 0) return
    let idx = yspCurrentChannelIndex.value - 1
    if (idx < 0) idx = yspChannels.value.length - 1
    selectYspChannel(idx)
  }

  function nextYspRoute(): void {
    const ch = yspCurrentChannel.value
    if (!ch || !ch.routes || ch.routes.length <= 1) return
    let idx = yspCurrentRouteIndex.value + 1
    if (idx >= ch.routes.length) idx = 0
    yspCurrentRouteIndex.value = idx
    const route = ch.routes[idx]
    // 切换线路前先清零旧播放状态，确保两种模式互斥
    externalPlayInfo.value = null
    yspWebviewUrl.value = ''
    yspWebviewTitle.value = ''
    applyYspRoute(route, ch.name)
  }

  function prevYspRoute(): void {
    const ch = yspCurrentChannel.value
    if (!ch || !ch.routes || ch.routes.length <= 1) return
    let idx = yspCurrentRouteIndex.value - 1
    if (idx < 0) idx = ch.routes.length - 1
    yspCurrentRouteIndex.value = idx
    const route = ch.routes[idx]
    // 切换线路前先清零旧播放状态，确保两种模式互斥
    externalPlayInfo.value = null
    yspWebviewUrl.value = ''
    yspWebviewTitle.value = ''
    applyYspRoute(route, ch.name)
  }

  function toggleYspPlay(): void {
    // 模拟点击 webview 中的视频元素
    if (yspIsStreamMode.value) {
      // 视频流解析模式：使用 VideoPlayer 控制播放
      if (videoPaused.value) {
        playing.value = true
        videoPaused.value = false
      } else {
        playing.value = false
        videoPaused.value = true
      }
    }
  }

  function toggleYspMute(): void {
    muted.value = !muted.value
  }

  function selectLocalLiveChannel(index: number): void {
    const list = localChannelsData.value.lives
    const item = list[index]
    if (!item) {
      logger.warn(`selectLocalLiveChannel: index ${index} out of range (total: ${list.length})`)
      return
    }
    const url = item.urls?.[0] || ''
    if (!url) {
      logger.warn(`selectLocalLiveChannel: index=${index} name="${item.name}" has no URL`)
      return
    }
    logger.log(`selectLocalLiveChannel: index=${index} name="${item.name}" urls=${item.urls.length} url=${url.substring(0, 60)}`)
    const format = url.toLowerCase().includes('.m3u8') ? 'm3u8' : ''
    externalPlayInfo.value = { url, headers: {}, format, title: item.name }
    currentChannel.value = null
    currentLocalVideo.value = null
    localLiveChannelSourceIndex.value = 0
    activeLocalLiveChannelIndex.value = index
    activePlayMode.value = 'locallive'
    yspWebviewUrl.value = ''
    yspWebviewTitle.value = ''
  }

  function playNextLocalLiveChannel(): void {
    const list = localChannelsData.value.lives
    if (list.length === 0) return
    let idx = activeLocalLiveChannelIndex.value + 1
    if (idx >= list.length) idx = 0
    logger.debug(`playNextLocalLiveChannel: ${activeLocalLiveChannelIndex.value} → ${idx} (total: ${list.length})`)
    selectLocalLiveChannel(idx)
  }

  function playPrevLocalLiveChannel(): void {
    const list = localChannelsData.value.lives
    if (list.length === 0) return
    let idx = activeLocalLiveChannelIndex.value - 1
    if (idx < 0) idx = list.length - 1
    logger.debug(`playPrevLocalLiveChannel: ${activeLocalLiveChannelIndex.value} → ${idx} (total: ${list.length})`)
    selectLocalLiveChannel(idx)
  }

  function clearLocalLiveChannel(): void {
    logger.debug(`clearLocalLiveChannel: was index=${activeLocalLiveChannelIndex.value}`)
    activeLocalLiveChannelIndex.value = -1
    localLiveChannelSourceIndex.value = 0
  }

  function switchLocalLiveNextSource(): void {
    const info = localChannelCurrentInfo.value
    if (!info || info.urls.length <= 1) return
    let idx = localLiveChannelSourceIndex.value + 1
    if (idx >= info.urls.length) idx = 0
    localLiveChannelSourceIndex.value = idx
    logger.log(`switchLocalLiveNextSource: sourceIndex ${idx}/${info.urls.length}`)
  }

  function switchLocalLivePrevSource(): void {
    const info = localChannelCurrentInfo.value
    if (!info || info.urls.length <= 1) return
    let idx = localLiveChannelSourceIndex.value - 1
    if (idx < 0) idx = info.urls.length - 1
    localLiveChannelSourceIndex.value = idx
    logger.log(`switchLocalLivePrevSource: sourceIndex ${idx}/${info.urls.length}`)
  }

  // ==================== 快捷键 ====================
  interface ShortcutDef {
    key: string
    ctrl: boolean
    shift: boolean
    alt: boolean
    meta: boolean
  }

  interface ShortcutItem {
    id: string
    name: string
    def: ShortcutDef
  }

  const DEFAULT_SHORTCUTS: Record<string, ShortcutDef> = {
    channelList:     { key: 'c',        ctrl: false, shift: false, alt: false, meta: false },
    localVideo:      { key: 'v',        ctrl: false, shift: false, alt: false, meta: false },
    localChannels:   { key: 'k',        ctrl: false, shift: false, alt: false, meta: false },
    yspPanel:        { key: 'o',        ctrl: false, shift: false, alt: false, meta: false },
    livesPanel:      { key: 'l',        ctrl: false, shift: false, alt: false, meta: false },
    sourceManager:   { key: 's',        ctrl: true,  shift: true,  alt: false, meta: false },
    toolsDialog:     { key: 'x',        ctrl: true,  shift: true,  alt: false, meta: false },
    dlna:            { key: 'd',        ctrl: true,  shift: true,  alt: false, meta: false },
    settings:        { key: ',',        ctrl: true,  shift: false, alt: false, meta: false },
    refreshSource:   { key: 'F5',       ctrl: false, shift: false, alt: false, meta: false },
    fullscreen:      { key: 'F11',      ctrl: false, shift: false, alt: false, meta: false },
    prevChannel:     { key: 'ArrowUp',   ctrl: false, shift: false, alt: false, meta: false },
    nextChannel:     { key: 'ArrowDown', ctrl: false, shift: false, alt: false, meta: false },
    prevSource:      { key: 'ArrowLeft', ctrl: false, shift: false, alt: false, meta: false },
    nextSource:      { key: 'ArrowRight',ctrl: false, shift: false, alt: false, meta: false },
    escape:          { key: 'Escape',    ctrl: false, shift: false, alt: false, meta: false },
  }

  const SHORTCUT_NAMES: Record<string, string> = {
    channelList:     '频道列表',
    localVideo:      '本地视频列表',
    localChannels:   '本地直播源',
    yspPanel:        '官网直播源',
    livesPanel:      '直播节目',
    sourceManager:   '直播源管理',
    toolsDialog:     '工具箱',
    dlna:            'DLNA投屏',
    settings:        '设置',
    refreshSource:   '刷新当前源',
    fullscreen:      '全屏',
    prevSource:      '上一线路',
    nextSource:      '下一线路',
    prevChannel:     '上一个频道',
    nextChannel:     '下一个频道',
    escape:          '关闭所有面板',
  }

  function loadShortcuts(): Record<string, ShortcutDef> {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SHORTCUTS)
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ShortcutDef>
        const result: Record<string, ShortcutDef> = {}
        for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
          if (parsed[id] && typeof parsed[id].key === 'string') {
            result[id] = parsed[id]
          } else {
            result[id] = { ...DEFAULT_SHORTCUTS[id] }
          }
        }
        return result
      }
    } catch {}
    const result: Record<string, ShortcutDef> = {}
    for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
      result[id] = { ...DEFAULT_SHORTCUTS[id] }
    }
    return result
  }

  const shortcuts = ref<Record<string, ShortcutDef>>(loadShortcuts())

  function saveShortcuts(): void {
    localStorage.setItem(STORAGE_KEYS.SHORTCUTS, JSON.stringify(shortcuts.value))
  }

  function matchShortcut(e: KeyboardEvent, id: string): boolean {
    const s = shortcuts.value[id]
    if (!s || !s.key) return false
    const eventKey = e.key
    const shortcutKey = s.key
    let keysMatch: boolean
    if (eventKey.length === 1 && shortcutKey.length === 1) {
      keysMatch = eventKey.toLowerCase() === shortcutKey.toLowerCase()
    } else {
      keysMatch = eventKey === shortcutKey
    }
    return keysMatch
      && e.ctrlKey === s.ctrl
      && e.shiftKey === s.shift
      && e.altKey === s.alt
      && e.metaKey === s.meta
  }

  function matchAnyShortcut(e: KeyboardEvent): string | null {
    for (const id of Object.keys(shortcuts.value)) {
      if (matchShortcut(e, id)) return id
    }
    return null
  }

  function setShortcut(id: string, def: ShortcutDef): void {
    shortcuts.value[id] = def
    saveShortcuts()
  }

  function clearShortcut(id: string): void {
    shortcuts.value[id] = { key: '', ctrl: false, shift: false, alt: false, meta: false }
    saveShortcuts()
  }

  function resetShortcut(id: string): void {
    if (DEFAULT_SHORTCUTS[id]) {
      shortcuts.value[id] = { ...DEFAULT_SHORTCUTS[id] }
      saveShortcuts()
    }
  }

  function shortcutEventToDef(e: KeyboardEvent): ShortcutDef {
    // 排除纯修饰键
    const modKeys = ['Control', 'Shift', 'Alt', 'Meta']
    const key = modKeys.includes(e.key) ? '' : e.key
    return { key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
  }

  function formatShortcutDisplay(def: ShortcutDef): string {
    if (!def.key) return '未设置'
    const parts: string[] = []
    if (def.ctrl) parts.push('Ctrl')
    if (def.shift) parts.push('Shift')
    if (def.alt) parts.push('Alt')
    if (def.meta) parts.push('Meta')
    let keyDisplay = def.key
    if (keyDisplay === ' ') keyDisplay = 'Space'
    else if (keyDisplay === 'ArrowUp') keyDisplay = '↑'
    else if (keyDisplay === 'ArrowDown') keyDisplay = '↓'
    else if (keyDisplay.length === 1) keyDisplay = keyDisplay.toUpperCase()
    parts.push(keyDisplay)
    return parts.join('+')
  }

  function getShortcutList(): ShortcutItem[] {
    const list: ShortcutItem[] = []
    for (const id of Object.keys(DEFAULT_SHORTCUTS)) {
      list.push({
        id,
        name: SHORTCUT_NAMES[id] || id,
        def: shortcuts.value[id] || DEFAULT_SHORTCUTS[id],
      })
    }
    return list
  }

  return {
    sourceList,
    sortedSourceList,
    sourceStats,
    sourceError,
    connectivityTesting,
    connectivityMode,
    connectivityProgress,
    showToolsDialog,
    currentSource,
    channelGroups,
    currentGroupIndex,
    currentChannel,
    channelsLoading,
    livesGroups,
    currentLivesIndex,
    currentGroup,
    currentUrl,
    currentHeaders,
    currentFormat,
    floatSource,
    volume,
    muted,
    playing,
    videoPaused,
    showChannelList,
    showSourceManager,
    showLivesPanel,
    showYspPanel,
    externalPlayInfo,
    pendingSniffUrl,
    showDlna,
    castQuality,
    castFormat,
    toolQuickStart,
    showSyncTVPanel,
    showSettings,
    decodeMode,
    ffmpegPath,
    builtinFfmpegPath,
    mpvPath,
    vlcPath,
    localVideoList,
    localVideoBranches,
    activeLocalVideoBranchId,
    localPlayMode,
    currentLocalVideo,
    showLocalVideoList,
    activePlayMode,
    initSources,
    initBuiltinFfmpeg,
    setCurrentSource,
    addSource,
    removeSource,
    updateSource,
    loadChannels,
    selectChannel,
    selectLives,
    switchNextSource,
    switchPrevSource,
    runConnectivityTest,
    cancelConnectivityTest,
    refreshCurrentSource,
    persistSourceStats,
    flushSourceStats,
    playExternalUrl,
    clearExternalPlay,
    setDecodeMode,
    setFfmpegPath,
    setMpvPath,
    setVlcPath,
    subtitleStyleVersion,
    bumpSubtitleStyleVersion,
    addLocalVideos,
    removeLocalVideo,
    clearLocalVideos,
    addLocalVideoBranch,
    removeLocalVideoBranch,
    renameLocalVideoBranch,
    setActiveLocalVideoBranch,
    selectLocalVideo,
    setLocalPlayMode,
    playNextLocalVideo,
    playPreviousLocalVideo,
    autoPlayNextLocalVideo,
    loadLocalChannels,
    saveLocalChannels,
    localChannelsData,
    localChannelCurrentInfo,
    showLocalChannelsList,
    activeLocalLiveChannelIndex,
    localLiveChannelSourceIndex,
    selectLocalLiveChannel,
    playNextLocalLiveChannel,
    playPrevLocalLiveChannel,
    clearLocalLiveChannel,
    switchLocalLiveNextSource,
    switchLocalLivePrevSource,
    yspChannels,
    loadYspChannels,
    saveYspChannels,
    yspWebviewUrl,
    yspWebviewTitle,
    yspCurrentChannelIndex,
    yspCurrentRouteIndex,
    yspIsStreamMode,
    yspStreamError,
    yspCurrentChannel,
    yspCurrentRoute,
    yspCurrentRouteType,
    selectYspChannel,
    nextYspChannel,
    prevYspChannel,
    nextYspRoute,
    prevYspRoute,
    streamRefreshSeq,
    refreshSnifferStream,
    toggleYspPlay,
    toggleYspMute,
    mpvActive,
    openMpv,
    closeMpv,
    // 快捷键
    shortcuts,
    matchShortcut,
    matchAnyShortcut,
    setShortcut,
    clearShortcut,
    resetShortcut,
    shortcutEventToDef,
    formatShortcutDisplay,
    getShortcutList,
  }
})

function yieldTick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0))
}