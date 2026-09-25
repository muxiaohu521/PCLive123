import { ref, computed, watch } from 'vue'
import { defineStore } from 'pinia'
import { ChannelService } from '@/services/ChannelService'
import { logger } from '@/utils/logger'
import { STORAGE_KEYS, PLAY_MODES, filePathToUrl } from '@/constants'
import type { SourceItem, DecodeMode, LocalVideoItem, PlayMode } from '@/constants'
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

function hasElectronAPI(): boolean {
  return typeof window !== 'undefined' && window.electronAPI !== undefined
    && typeof window.electronAPI.getSources === 'function'
    && typeof window.electronAPI.saveSources === 'function'
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

function saveVolume(volume: number): void {
  localStorage.setItem(STORAGE_KEYS.VOLUME, String(volume))
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
  if (raw === 'hardware' || raw === 'software' || raw === 'auto' || raw === 'ffmpeg') return raw
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

function loadLocalVideos(): LocalVideoItem[] {
  return safeJsonParse<LocalVideoItem[]>(
    localStorage.getItem(STORAGE_KEYS.LOCAL_VIDEOS),
    [],
  )
}

function saveLocalVideos(list: LocalVideoItem[]): void {
  localStorage.setItem(STORAGE_KEYS.LOCAL_VIDEOS, JSON.stringify(list))
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
  const externalPlayInfo = ref<{ url: string; headers: Record<string, string>; format: string; title: string } | null>(null)
  const pendingSniffUrl = ref<{ url: string; format: string; name: string } | null>(null)
  const showDlna = ref(false)
  const showSettings = ref(false)
  const decodeMode = ref<DecodeMode>(loadDecodeMode())
  const ffmpegPath = ref<string>(loadFfmpegPath())
  const localVideoList = ref<LocalVideoItem[]>((() => {
    const list = loadLocalVideos()
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    return list
  })())
  const localPlayMode = ref<PlayMode>(loadLocalPlayMode())
  const currentLocalVideo = ref<LocalVideoItem | null>(null)
  const showLocalVideoList = ref(false)
  const activePlayMode = ref<'local' | 'channel' | 'sniffer' | null>(null)

  const currentGroup = computed(() => {
    if (channelGroups.value.length === 0) return null
    const idx = Math.min(currentGroupIndex.value, channelGroups.value.length - 1)
    return channelGroups.value[idx]
  })

  const currentUrl = computed(() => {
    if (activePlayMode.value === 'local' || activePlayMode.value === 'sniffer') {
      return externalPlayInfo.value?.url || ''
    }
    if (activePlayMode.value === 'channel' && currentChannel.value) {
      const ch = currentChannel.value
      return ch.channelUrls[ch.sourceIndex] || ''
    }
    return ''
  })

  const currentHeaders = computed(() => {
    if (activePlayMode.value === 'local' || activePlayMode.value === 'sniffer') {
      return externalPlayInfo.value?.headers || {}
    }
    if (activePlayMode.value === 'channel' && currentChannel.value) {
      return getChannelHeaders(currentChannel.value)
    }
    return {}
  })

  const currentFormat = computed(() => {
    if (activePlayMode.value === 'local' || activePlayMode.value === 'sniffer') {
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
    currentChannel.value = null
    currentLocalVideo.value = null
    activePlayMode.value = 'sniffer'
  }

  function clearExternalPlay(): void {
    externalPlayInfo.value = null
    if (activePlayMode.value === 'sniffer') {
      activePlayMode.value = null
    }
  }

  function setDecodeMode(mode: DecodeMode): void {
    decodeMode.value = mode
    saveDecodeMode(mode)
  }

  function setFfmpegPath(path: string): void {
    ffmpegPath.value = path
    saveFfmpegPath(path)
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
    if (sourceList.value.length > 0 && !currentSource.value) {
      setCurrentSource(sourceList.value[0].url)
    }
  }

  async function parseSourceStat(source: SourceItem, signal?: AbortSignal): Promise<number> {
    try {
      const groups = await ChannelService.loadChannels(source.url, 0, undefined, undefined, signal, true)
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

  const MAX_RETRIES = 2

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

        let result = 0
        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          if (connSignal.aborted) break
          try {
            result = await parseSourceStat(s, connSignal)
          } catch {
            result = 0
          }
          if (result > 0) break
        }

        if (!connSignal.aborted && result === 0) {
          sourceStats.value.set(s.url, { channelCount: 0, parsedAt: Date.now() })
          persistSourceStats()
        }
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
    if (currentSource.value === url && sourceList.value.length > 0) {
      setCurrentSource(sourceList.value[0].url)
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
    ChannelService.clearSeenUrls()
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
      const result = await ChannelService.loadChannels(
        targetUrl,
        0,
        livesGroups,
        channelGroups,
        signal,
        skipCache,
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
    activePlayMode.value = 'channel'
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

  function sortLocalVideoList(): void {
    localVideoList.value.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  function addLocalVideos(videos: LocalVideoItem[]): number {
    const existingPaths = new Set(localVideoList.value.map(v => v.filePath))
    const newVideos = videos.filter(v => !existingPaths.has(v.filePath))
    if (newVideos.length > 0) {
      localVideoList.value.push(...newVideos)
      sortLocalVideoList()
      saveLocalVideos(localVideoList.value)
    }
    return newVideos.length
  }

  function removeLocalVideo(filePath: string): void {
    localVideoList.value = localVideoList.value.filter(v => v.filePath !== filePath)
    saveLocalVideos(localVideoList.value)
    if (currentLocalVideo.value?.filePath === filePath) {
      currentLocalVideo.value = null
      if (activePlayMode.value === 'local') {
        externalPlayInfo.value = null
        activePlayMode.value = null
      }
    }
  }

  function clearLocalVideos(): void {
    localVideoList.value = []
    saveLocalVideos([])
    currentLocalVideo.value = null
    if (activePlayMode.value === 'local') {
      externalPlayInfo.value = null
      activePlayMode.value = null
    }
  }

  const EMPTY_HEADERS: Record<string, string> = {}

  function selectLocalVideo(video: LocalVideoItem): void {
    currentLocalVideo.value = video
    currentChannel.value = null
    const url = filePathToUrl(video.filePath)
    externalPlayInfo.value = { url, headers: EMPTY_HEADERS, format: '', title: video.name }
    activePlayMode.value = 'local'
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
    volume,
    muted,
    playing,
    videoPaused,
    showChannelList,
    showSourceManager,
    showLivesPanel,
    externalPlayInfo,
    pendingSniffUrl,
    showDlna,
    showSettings,
    decodeMode,
    ffmpegPath,
    localVideoList,
    localPlayMode,
    currentLocalVideo,
    showLocalVideoList,
    activePlayMode,
    initSources,
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
    addLocalVideos,
    removeLocalVideo,
    clearLocalVideos,
    selectLocalVideo,
    setLocalPlayMode,
    playNextLocalVideo,
    playPreviousLocalVideo,
    autoPlayNextLocalVideo,
  }
})

function yieldTick(): Promise<void> {
  return new Promise(r => setTimeout(r, 0))
}