﻿<template>
  <FloatView v-if="isFloatMode" />
  <div v-else class="app-container" tabindex="0" ref="appRef">
    <TitleBar v-show="!isWindowFullscreen" />
    <div class="main-content">
      <div class="player-area">
        <VideoPlayer
          v-show="!store.yspWebviewUrl"
          ref="videoPlayerRef"
          :url="store.currentUrl"
          :headers="store.currentHeaders"
          :format="store.currentFormat"
          :volume="store.volume"
          :muted="store.muted"
          :info="sourceInfo"
          @playing="store.playing = true; store.videoPaused = false"
          @pause="store.playing = false; store.videoPaused = true"
          @error="onSourceError"
          @sourceTimeout="onSourceError"
          @ended="onVideoEnded"
          @prevSource="onPrevSource"
          @nextSource="onNextSource"
          @prevChannel="onPrevChannel"
          @nextChannel="onNextChannel"
          @seek="onVideoSeek"
        />
        <webview v-if="yspWebviewAttached"
          ref="yspWebviewRef"
          v-show="store.yspWebviewUrl"
          :src="yspWebviewSrc"
          class="ysp-webview"
          :webpreferences="yspWebpreferences"
          useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
          @dom-ready="onYspDomReady"
          @did-start-loading="onYspStartLoading"
          @did-stop-loading="onYspStopLoading"
          @did-finish-load="onYspWebviewReady"
          @did-fail-load="onYspFailLoad"
          @crashed="onYspCrashed"
          @console-message="onYspConsole"
        />
        <YspPlayerBar
          v-if="store.yspWebviewUrl"
          :webviewEl="yspWebviewEl"
          :playing="playerBarPlaying"
          :muted="yspMuted"
          :volume="yspVolume"
          :channelName="playerBarChName"
          :routeName="playerBarRouteName"
          :routeCount="playerBarRouteCount"
          :currentRoute="store.yspCurrentRouteIndex"
          :isStreamMode="store.yspIsStreamMode"
          :isFullscreen="isFullscreen"
          @prevChannel="onYspPrevChannel"
          @nextChannel="onYspNextChannel"
          @togglePlay="onYspTogglePlay"
          @prevRoute="onYspPrevRoute"
          @nextRoute="onYspNextRoute"
          @updateMuted="onYspUpdateMuted"
          @updateVolume="onYspUpdateVolume"
        />

        <div v-if="store.yspIsStreamMode && store.yspStreamError" class="ysp-stream-error">
          <div class="ysp-stream-error-title">视频流解析失败</div>
          <div class="ysp-stream-error-desc">{{ store.yspStreamError }}</div>
          <div class="ysp-stream-error-hint">
            当前为「视频流解析」模式，该模式不加载网页、也不抓取网页中的视频，因此不会回退网页播放。
            请切换到该频道的网页版线路，或稍后重试。
          </div>
        </div>

      </div>

      <div class="side-panels">
        <LocalVideoList
          v-if="store.showLocalVideoList"
          @close="store.showLocalVideoList = false"
          @select="onLocalVideoSelect"
        />
        <LocalChannelsList
          v-if="store.showLocalChannelsList"
          @close="store.showLocalChannelsList = false"
        />
        <ChannelList
          v-if="store.showChannelList"
          @select="onSelectChannel"
          @close="store.showChannelList = false"
        />
        <SourceManager
          v-if="store.showSourceManager"
          @close="store.showSourceManager = false"
        />
        <LivesPanel
          v-if="store.showLivesPanel"
          @close="store.showLivesPanel = false"
        />
        <ToolsDialog />
        <DlnaPanel
          v-show="store.showDlna"
          :currentUrl="currentChannelUrl || ''"
          :currentTime="videoCurrentTime"
          :seekSeq="seekSeq"
          @close="store.showDlna = false"
        />
        <SyncTVPanel
          v-if="store.showSyncTVPanel"
          @close="store.showSyncTVPanel = false"
        />
        <SettingsPanel
          @close="store.showSettings = false"
          @saved="onSettingsSaved"
        />
        <YspPanel
          v-if="store.showYspPanel"
          @close="store.showYspPanel = false"
        />
      </div>
    </div>

    <!-- 输入框右键菜单 -->
    <Teleport to="body">
      <div
        v-if="inputMenu.visible"
        class="input-context-overlay"
        @click="hideInputMenu"
        @contextmenu.prevent="hideInputMenu"
      >
        <div
          class="input-context-menu"
          :style="{ left: inputMenu.x + 'px', top: inputMenu.y + 'px' }"
          @click.stop
        >
          <div class="menu-item" @click="cutSelection">剪切</div>
          <div class="menu-item" @click="copySelection">复制</div>
          <div class="menu-item" @click="pasteText">粘贴</div>
          <div class="menu-item" @click="selectAllText">全选</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, onErrorCaptured } from 'vue'
import { useAppStore } from '@/store'
import { useInputContextMenu } from '@/composables/useInputContextMenu'
import { usePlaybackStream } from '@/composables/usePlaybackStream'
import { logger } from '@/utils/logger'
import { injectWebviewHideCSS, runWebviewHideUI } from '@/utils/webviewFillScreen'
import type { LiveChannelItem } from '@/models/LiveChannelItem'
import type { LocalVideoItem } from '@/constants'
import { filePathToUrl } from '@/constants'
import TitleBar from '@/components/TitleBar.vue'
import VideoPlayer from '@/components/VideoPlayer.vue'
import ChannelList from '@/components/ChannelList.vue'
import SourceManager from '@/components/SourceManager.vue'
import LivesPanel from '@/components/LivesPanel.vue'
import ToolsDialog from '@/components/ToolsDialog.vue'
import DlnaPanel from '@/components/DlnaPanel.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import FloatView from '@/views/FloatView.vue'
import LocalVideoList from '@/components/LocalVideoList.vue'
import LocalChannelsList from '@/components/LocalChannelsList.vue'
import SyncTVPanel from '@/components/SyncTVPanel.vue'
import YspPanel from '@/components/YspPanel.vue'
import YspPlayerBar from '@/components/YspPlayerBar.vue'

const store = useAppStore()

// 统一流接口：接入 store.floatSource，五个功能模块（下载/录屏/悬浮窗/投屏/画中画）按需接收
const { castSourceUrl, dispose: disposePlaybackStream } = usePlaybackStream()

const {
  menu: inputMenu,
  hideMenu: hideInputMenu,
  copySelection,
  cutSelection,
  pasteText,
  selectAll: selectAllText,
  registerGlobalListener,
  unregisterGlobalListener,
} = useInputContextMenu()
const appRef = ref<HTMLElement | null>(null)
const videoPlayerRef = ref<InstanceType<typeof VideoPlayer>>()
const yspWebviewRef = ref<HTMLElement | null>(null)
const yspWebviewEl = computed(() => yspWebviewRef.value)
const playerBarPlaying = ref(true)
const yspMuted = ref(false)
const yspVolume = ref(100)
const isWindowFullscreen = ref(false)
const domFullscreen = ref(false)
let _fullscreenCleanup: (() => void) | null = null
let _domFullscreenCleanup: (() => void) | null = null

// 全屏状态：同时覆盖窗口全屏（F11 / Electron setFullscreen）与 DOM 元素全屏（video.requestFullscreen）
const isFullscreen = computed(() => isWindowFullscreen.value || domFullscreen.value)

const yspWebpreferences = 'allowRunningInsecureContent=yes'

// ─── YSP webview 资源管理 ───
//
// 核心思路：webview 元素（及其 guest 浏览器内核/渲染进程）一旦创建就常驻复用。
// 切换频道、切换线路时只改变 src，让同一个 guest 重新导航，从而彻底避免原来
// 用 :key + v-if 导致「每次切换都销毁旧渲染进程、再冷启动新渲染进程」带来的
// 1~3 秒级白屏与内存抖动。
//
// 网页地址为空（切到视频流解析线路 / 其他播放模式）时导航到 about:blank：
// 主动卸载旧网页、释放其 JS/视频/音频资源，但保留 guest 内核，以便下次进入
// 网页版时能立即在同一内核上加载新网页。

const yspWebviewSrc = computed(() => store.yspWebviewUrl || 'about:blank')

// 首次进入网页版时才真正把 webview 挂载进 DOM，之后一直常驻（用 v-show 控制
// 显隐），避免应用启动时白白创建一个空闲的 guest 渲染进程。
const yspWebviewAttached = ref(false)

watch(() => store.yspWebviewUrl, (url) => {
  if (url) yspWebviewAttached.value = true
})

// 跨模块切换时彻底销毁 webview 内核：
// 官网直播源内部（频道/线路切换，含网页版↔视频流解析版）只会把 activePlayMode
// 置为 null / 'sniffer'，不会命中下面的值，因此内核得以保留复用；
// 一旦切到「频道列表(直播源管理) / 本地视频 / 本地直播源」，即视为离开本模块，
// 主动卸载 webview 元素，由 Electron 销毁对应 guest 渲染进程与显存。
watch(() => store.activePlayMode, (mode) => {
  if (mode === 'channel' || mode === 'local' || mode === 'locallive') {
    yspWebviewAttached.value = false
  }
})

const videoCurrentTime = ref(0)
// 跳转播放同步信号：主窗口 Artplayer 原生 seeking 事件触发时自增，投屏面板据此立即同步进度
const seekSeq = ref(0)
let currentTimeTimer: ReturnType<typeof setInterval> | null = null
const isFloatMode = ref(window.location.hash === '#/float')
let _mpvEndedCleanup: (() => void) | null = null
let _vlcEndedCleanup: (() => void) | null = null

const sourceInfo = computed(() => {
  if (store.activePlayMode === 'channel') {
    return {
      sourceIndex: store.currentChannel?.sourceIndex ?? 0,
      sourceNum: store.currentChannel?.sourceNum ?? 0
    }
  }
  if (store.activePlayMode === 'locallive') {
    const info = store.localChannelCurrentInfo
    return {
      sourceIndex: store.localLiveChannelSourceIndex ?? 0,
      sourceNum: info?.urls?.length ?? 0
    }
  }
  if (store.activePlayMode === 'local') {
    const total = store.localVideoList.length
    const idx = store.currentLocalVideo
      ? store.localVideoList.findIndex(v => v.filePath === store.currentLocalVideo!.filePath)
      : -1
    return { sourceIndex: idx, sourceNum: total }
  }
  if (store.activePlayMode === 'sniffer') {
    return {
      sourceIndex: store.yspCurrentRouteIndex,
      sourceNum: store.yspCurrentChannel?.routes?.length ?? 0
    }
  }
  return { sourceIndex: 0, sourceNum: 0 }
})

// 投屏直链统一走流接口（castSourceUrl 由投屏消费者维护，仅 Artplayer 直链源接入）
const currentChannelUrl = computed(() => castSourceUrl.value || store.currentUrl || '')

const playerBarChName = computed(() => store.yspCurrentChannel?.name || '')
const playerBarRouteName = computed(() => store.yspCurrentRoute?.name || '')
const playerBarRouteCount = computed(() => store.yspCurrentChannel?.routes?.length || 0)

function onPrevSource() {
  // 网页版（webview）线路切换：共用 store.prevYspRoute，与视频流解析版保持一致
  if (store.yspWebviewUrl) {
    store.prevYspRoute()
    return
  }
  if (store.activePlayMode === 'locallive') {
    store.switchLocalLivePrevSource()
    return
  }
  if (store.activePlayMode === 'sniffer') {
    store.prevYspRoute()
    return
  }
  if (store.activePlayMode !== 'channel') return
  store.switchPrevSource()
}

function onNextSource() {
  // 网页版（webview）线路切换：共用 store.nextYspRoute，与视频流解析版保持一致
  if (store.yspWebviewUrl) {
    store.nextYspRoute()
    return
  }
  if (store.activePlayMode === 'locallive') {
    store.switchLocalLiveNextSource()
    return
  }
  if (store.activePlayMode === 'sniffer') {
    store.nextYspRoute()
    return
  }
  if (store.activePlayMode !== 'channel') return
  store.switchNextSource()
}

function onLocalVideoSelect(video: LocalVideoItem) {
  const prevUrl = store.currentLocalVideo ? filePathToUrl(store.currentLocalVideo.filePath) : null
  store.selectLocalVideo(video)
  const newUrl = filePathToUrl(video.filePath)
  if (newUrl === prevUrl) {
    videoPlayerRef.value?.playLocalFile(newUrl)
  }
}

function onPrevChannel() {
  // 网页版（webview）模式：activePlayMode 为 null，但频道切换仍需生效
  if (store.yspWebviewUrl) {
    store.prevYspChannel()
    return
  }
  if (store.activePlayMode === 'sniffer') {
    store.prevYspChannel()
    return
  }
  if (store.activePlayMode === 'channel') {
    navigateChannel(-1)
    return
  }
  if (store.activeLocalLiveChannelIndex >= 0) {
    store.playPrevLocalLiveChannel()
    return
  }
  if (store.activePlayMode !== 'local') return

  const prevUrl = store.currentLocalVideo ? filePathToUrl(store.currentLocalVideo.filePath) : null
  store.playPreviousLocalVideo()
  const current = store.currentLocalVideo
  if (current) {
    const newUrl = filePathToUrl(current.filePath)
    if (newUrl === prevUrl) {
      videoPlayerRef.value?.playLocalFile(newUrl)
    }
  }
}

function onNextChannel() {
  // 网页版（webview）模式：activePlayMode 为 null，但频道切换仍需生效
  if (store.yspWebviewUrl) {
    store.nextYspChannel()
    return
  }
  if (store.activePlayMode === 'sniffer') {
    store.nextYspChannel()
    return
  }
  if (store.activePlayMode === 'channel') {
    navigateChannel(1)
    return
  }
  if (store.activeLocalLiveChannelIndex >= 0) {
    store.playNextLocalLiveChannel()
    return
  }
  if (store.activePlayMode !== 'local') return

  const prevUrl = store.currentLocalVideo ? filePathToUrl(store.currentLocalVideo.filePath) : null
  store.playNextLocalVideo()
  const current = store.currentLocalVideo
  if (current) {
    const newUrl = filePathToUrl(current.filePath)
    if (newUrl === prevUrl) {
      videoPlayerRef.value?.playLocalFile(newUrl)
    }
  }
}

function getFlatList(): LiveChannelItem[] {
  const flat: LiveChannelItem[] = []
  for (const g of store.channelGroups) {
    for (const ch of g.liveChannels) {
      flat.push(ch)
    }
  }
  return flat
}

function findFlatIndex(): number {
  if (!store.currentChannel) return -1
  return getFlatList().findIndex(ch => ch === store.currentChannel)
}

onMounted(async () => {
  logger.info('[App] onMounted starting')
  try {
    await store.initBuiltinFfmpeg()
    await store.initSources()
    await store.loadLocalChannels()
    await store.loadYspChannels()
    await store.loadChannels()
    registerGlobalListener()
    // 注册 MPV 播放结束监听
    if (window.electronAPI?.onMpvPlaybackEnded) {
      _mpvEndedCleanup = window.electronAPI.onMpvPlaybackEnded(onMpvPlaybackEnded)
    }
    if (window.electronAPI?.onVlcPlaybackEnded) {
      _vlcEndedCleanup = window.electronAPI.onVlcPlaybackEnded(onVlcPlaybackEnded)
    }
    logger.info('[App] init done, setting up listeners')
  } catch (e: any) {
    logger.error('[App] onMounted init failed:', e?.message || e)
  }

  appRef.value?.focus()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', onBeforeUnload)

  // 同步窗口全屏状态（标题栏隐藏、播放区铺满依赖该状态）
  const fsApi = window.electronAPI
  if (fsApi && typeof fsApi.onFullscreenChange === 'function') {
    _fullscreenCleanup = fsApi.onFullscreenChange((flag: boolean) => {
      isWindowFullscreen.value = !!flag
    })
  }
  if (fsApi && typeof fsApi.isFullscreen === 'function') {
    fsApi.isFullscreen()
      .then((flag: boolean) => { isWindowFullscreen.value = !!flag })
      .catch(() => {})
  }

  // 同步 DOM 全屏状态（video.requestFullscreen / ArtPlayer 内置全屏按钮）
  const onDomFullscreenChange = () => {
    domFullscreen.value = !!document.fullscreenElement
  }
  document.addEventListener('fullscreenchange', onDomFullscreenChange)
  _domFullscreenCleanup = () => document.removeEventListener('fullscreenchange', onDomFullscreenChange)

  window.addEventListener('error', (e) => {
    logger.error('[App] window.onerror:', e.message, 'at', e.filename, ':', e.lineno, ':', e.colno, 'error:', e.error)
  })
  window.addEventListener('unhandledrejection', (e) => {
    logger.error('[App] unhandledrejection:', e.reason)
  })

  logger.info('[App] onMounted complete')

  currentTimeTimer = setInterval(() => {
    videoCurrentTime.value = videoPlayerRef.value?.getCurrentTime() || 0
  }, 1000)
})

onUnmounted(() => {
  // webview 元素随整个组件一起卸载，Electron 会自动销毁对应 guest 内核，无需主动 close()
  if (_fullscreenCleanup) { _fullscreenCleanup(); _fullscreenCleanup = null }
  if (_domFullscreenCleanup) { _domFullscreenCleanup(); _domFullscreenCleanup = null }
  if (currentTimeTimer) { clearInterval(currentTimeTimer); currentTimeTimer = null }
  if (_mpvEndedCleanup) { _mpvEndedCleanup(); _mpvEndedCleanup = null }
  if (_vlcEndedCleanup) { _vlcEndedCleanup(); _vlcEndedCleanup = null }
  disposePlaybackStream()
  unregisterGlobalListener()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('beforeunload', onBeforeUnload)
})

onErrorCaptured((err, _instance, _info) => {
  logger.error('[App] Error captured:', err)
  return false
})

function onBeforeUnload() {
  store.flushSourceStats()
}

function onKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (store.matchShortcut(e, 'escape')) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showLivesPanel = false
      store.showToolsDialog = false
      store.showDlna = false
      store.showSettings = false
      store.showLocalVideoList = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'escape')) {
    // 全屏状态下 Esc 优先退出全屏（全屏时标题栏已隐藏，需保留明确的退出入口）
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      return
    }
    if (isWindowFullscreen.value) {
      window.electronAPI?.setFullscreen?.(false)
      return
    }
    store.showChannelList = false
    store.showSourceManager = false
    store.showLivesPanel = false
    store.showToolsDialog = false
    store.showDlna = false
    store.showSettings = false
    store.showLocalVideoList = false
    store.showLocalChannelsList = false
    store.showYspPanel = false
    return
  }

  if (store.matchShortcut(e, 'fullscreen')) {
    e.preventDefault()
    toggleFullscreen()
    return
  }

  if (store.matchShortcut(e, 'refreshSource')) {
    e.preventDefault()
    if (store.activePlayMode === 'channel') store.refreshCurrentSource()
    return
  }

  if (store.matchShortcut(e, 'channelList')) {
    e.preventDefault()
    store.showChannelList = !store.showChannelList
    if (store.showChannelList) {
      store.showSourceManager = false
      store.showLivesPanel = false
      store.showLocalVideoList = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'sourceManager')) {
    e.preventDefault()
    store.showSourceManager = !store.showSourceManager
    if (store.showSourceManager) {
      store.showChannelList = false
      store.showLivesPanel = false
      store.showLocalVideoList = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
      store.showSyncTVPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'livesPanel')) {
    e.preventDefault()
    store.showLivesPanel = !store.showLivesPanel
    if (store.showLivesPanel) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showLocalVideoList = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
      store.showSyncTVPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'localVideo')) {
    e.preventDefault()
    store.showLocalVideoList = !store.showLocalVideoList
    if (store.showLocalVideoList) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showLivesPanel = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'localChannels')) {
    e.preventDefault()
    store.showLocalChannelsList = !store.showLocalChannelsList
    if (store.showLocalChannelsList) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showLivesPanel = false
      store.showLocalVideoList = false
      store.showYspPanel = false
      store.showSyncTVPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'toolsDialog')) {
    e.preventDefault()
    store.showToolsDialog = !store.showToolsDialog
    if (store.showToolsDialog) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showLivesPanel = false
      store.showLocalVideoList = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'dlna')) {
    e.preventDefault()
    store.showDlna = !store.showDlna
    if (store.showDlna) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showToolsDialog = false
      store.showLocalVideoList = false
      store.showLivesPanel = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
      store.showSyncTVPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'settings')) {
    e.preventDefault()
    store.showSettings = !store.showSettings
    if (store.showSettings) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showToolsDialog = false
      store.showLocalVideoList = false
      store.showLivesPanel = false
      store.showLocalChannelsList = false
      store.showYspPanel = false
      store.showSyncTVPanel = false
    }
    return
  }

  if (store.matchShortcut(e, 'yspPanel')) {
    e.preventDefault()
    store.showYspPanel = !store.showYspPanel
    if (store.showYspPanel) {
      store.showChannelList = false
      store.showSourceManager = false
      store.showToolsDialog = false
      store.showLocalVideoList = false
      store.showLivesPanel = false
      store.showLocalChannelsList = false
    }
    return
  }

  if (store.matchShortcut(e, 'prevSource')) {
    e.preventDefault()
    // 网页版（webview）模式 activePlayMode 为 null，也要允许线路切换
    if (store.yspWebviewUrl || store.activePlayMode === 'channel' || store.activePlayMode === 'locallive' || store.activePlayMode === 'sniffer') {
      onPrevSource()
    }
    return
  }

  if (store.matchShortcut(e, 'nextSource')) {
    e.preventDefault()
    // 网页版（webview）模式 activePlayMode 为 null，也要允许线路切换
    if (store.yspWebviewUrl || store.activePlayMode === 'channel' || store.activePlayMode === 'locallive' || store.activePlayMode === 'sniffer') {
      onNextSource()
    }
    return
  }

  if (store.matchShortcut(e, 'prevChannel')) {
    e.preventDefault()
    onPrevChannel()
    return
  }

  if (store.matchShortcut(e, 'nextChannel')) {
    e.preventDefault()
    onNextChannel()
    return
  }

  if (e.key === ' ') {
    e.preventDefault()
    togglePlay()
    return
  }

  if (e.key >= '0' && e.key <= '9') {
    e.preventDefault()
    if (store.activePlayMode !== 'channel') return
    const num = parseInt(e.key)
    const flat = getFlatList()
    if (num > 0 && num <= flat.length) {
      store.selectChannel(flat[num - 1])
    }
  }
}

function navigateChannel(delta: number) {
  if (store.activePlayMode !== 'channel') return
  const flat = getFlatList()
  if (flat.length === 0) return
  const idx = findFlatIndex()
  let newIdx = idx < 0 ? 0 : idx + delta
  if (newIdx < 0) newIdx = flat.length - 1
  if (newIdx >= flat.length) newIdx = 0
  store.selectChannel(flat[newIdx])
}

function togglePlay() {
  if (!videoPlayerRef.value) return
  if (store.videoPaused) {
    videoPlayerRef.value.play()
  } else {
    videoPlayerRef.value.pause()
  }
}

function toggleFullscreen() {
  // 原生播放器：视频元素自身进入 DOM 全屏
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
    return
  }
  const videoEl: HTMLVideoElement | null =
    (videoPlayerRef.value as any)?.getVideo?.() ?? document.querySelector('.player-area video')
  if (videoEl && typeof videoEl.requestFullscreen === 'function') {
    videoEl.requestFullscreen().catch(() => {
      appRef.value?.requestFullscreen?.()
    })
    return
  }
  appRef.value?.requestFullscreen?.()
}

function onSourceError() {
  if (store.activePlayMode === 'locallive') {
    const info = store.localChannelCurrentInfo
    if (info && store.localLiveChannelSourceIndex < info.urls.length - 1) {
      store.switchLocalLiveNextSource()
    }
    return
  }
  if (store.currentChannel && store.currentChannel.sourceIndex < store.currentChannel.sourceNum - 1) {
    store.switchNextSource()
  }
}

function onVideoEnded() {
  logger.info('[App] ended fired, activePlayMode=', store.activePlayMode, 'localPlayMode=', store.localPlayMode)
  if (store.activePlayMode !== 'local') return

  const mode = store.localPlayMode
  const current = store.currentLocalVideo
  const list = store.localVideoList
  logger.info('[App] onVideoEnded mode=', mode, 'current=', current?.name, 'listLen=', list.length)
  if (!current || list.length === 0) return

  if (mode === 'single_loop') {
    const url = filePathToUrl(current.filePath)
    videoPlayerRef.value?.playLocalFile(url)
    return
  }

  // sequential / random
  const prevUrl = filePathToUrl(current.filePath)
  store.autoPlayNextLocalVideo()
  // 如果 selectLocalVideo 选中的是同一个视频（列表只有 1 个），URL 不变 → watch 不触发
  // 此时需要直接调用 playLocalFile 重播
  const nextVideo = store.currentLocalVideo
  if (nextVideo) {
    const nextUrl = filePathToUrl(nextVideo.filePath)
    if (nextUrl === prevUrl) {
      logger.info('[App] same URL after autoPlayNext, calling playLocalFile directly')
      videoPlayerRef.value?.playLocalFile(nextUrl)
    }
  }
}

function onSelectChannel(channel: LiveChannelItem) {
  store.selectChannel(channel)
}

function onVideoSeek(t: number) {
  // 跳转播放：立即更新投屏用到的进度基准，并通过 seekSeq 触发投屏设备同步跳转，
  // 不再依赖 1s 定时器 / 2s 轮询，避免跳转后投屏端迟迟不同步。
  videoCurrentTime.value = t || 0
  seekSeq.value++
}

function onSettingsSaved(settings: Record<string, any>) {
  if (settings.volume !== undefined) {
    // 设置面板的音量是 0~100 的整数，store.volume 是 0~1 的小数：
    // 必须归一化后再写入，否则会被 HTMLMediaElement 钳制为 1，表现为「保存设置后音量变成 100%」。
    const raw = Number(settings.volume)
    if (Number.isFinite(raw)) {
      store.volume = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw))
    }
  }
  logger.info('[App] Settings saved:', Object.keys(settings).join(', '))
}

// ─── MPV 弹窗播放 ───

function onMpvPlaybackEnded(data: { sessionId: string; exitCode: number }) {
  logger.info(`[MPV] playbackEnded sessionId=${data.sessionId} exitCode=${data.exitCode}`)
  store.closeMpv()
  store.playing = false
  store.videoPaused = true
}

function onVlcPlaybackEnded(data: { sessionId: string; exitCode: number }) {
  logger.info(`[VLC] playbackEnded sessionId=${data.sessionId} exitCode=${data.exitCode}`)
  store.closeMpv()
  store.playing = false
  store.videoPaused = true
}

// ─── 央视频 webview 事件 ───

function onYspConsole(e: any) {
  logger.info(`[YSP:wv] [lvl=${e.level}] ${e.message}`)
}

function onYspStartLoading(e: any) {
  logger.info(`[YSP:wv] did-start-loading url=${e.url}`)
}

function onYspStopLoading() {
  logger.info('[YSP:wv] did-stop-loading')
}

function onYspFailLoad(e: any) {
  // -3 = ERR_ABORTED：切换 src / 清理旧网页（about:blank）时被中断的导航，
  // 属于正常流程而非真实加载失败，避免刷屏与误导性错误提示。
  if (e.errorCode === -3) return
  logger.error(`[YSP:wv] did-fail-load code=${e.errorCode} desc="${e.errorDescription}" url=${e.validatedURL}`)
}

function onYspCrashed() {
  logger.error('[YSP:wv] crashed!')
}

function onYspDomReady(event: any) {
  const wv = event.target
  if (!wv) return
  const url = wv.getURL() || ''
  // 清理页（about:blank）无需注入样式
  if (url === 'about:blank' || url === '') return
  logger.info('[YSP:wv] dom-ready → injecting CSS')

  injectWebviewHideCSS(wv, url)
}

function onYspWebviewReady(event: any) {
  const wv = event.target
  if (!wv) return
  const url = wv.getURL() || ''
  // 清理页（about:blank）无需执行诊断/隐藏 UI
  if (url === 'about:blank' || url === '') return
  const isMgtvLive = url.includes('mgtv.com/z/')
  const hideUIDelay = isMgtvLive ? 3000 : 0
  logger.info(`[YSP:wv] webview-ready url=${url} isMgtvLive=${isMgtvLive} hideUIDelay=${hideUIDelay}`)
  setTimeout(() => runMgtvHideUI(wv), hideUIDelay)
}

function runMgtvHideUI(wv: any) {
  logger.info('[YSP:wv] did-finish-load → running diagnostic')

  // 第一步：诊断 — 报告 DOM 状态
  const diagJs = `
    (function diag(){
      var v = document.querySelector('video');
      if (!v) return JSON.stringify({stage:'no_video', bodyChildren: document.body.children.length, readyState: 'N/A'});

      var r = {};
      r.stage = 'has_video';
      r.videoId = v.id;
      r.videoSrc = (v.src||'').substring(0,80);
      r.videoWidth = v.videoWidth;
      r.videoHeight = v.videoHeight;
      r.videoReadyState = v.readyState;
      r.videoPaused = v.paused;
      r.videoClass = v.className;
      r.videoComputedDisplay = getComputedStyle(v).display;
      r.videoComputedVisibility = getComputedStyle(v).visibility;
      r.videoComputedWidth = getComputedStyle(v).width;
      r.videoComputedHeight = getComputedStyle(v).height;
      r.videoComputedPosition = getComputedStyle(v).position;

      var player = v.closest('.tv-main-con-l, .tv-main-con-l-vid, #player, .video_flash, .video_left, .playingVideo');
      if (player) {
        r.playerTag = player.tagName;
        r.playerClass = player.className;
        r.playerComputedDisplay = getComputedStyle(player).display;
        r.playerComputedWidth = getComputedStyle(player).width;
        r.playerComputedHeight = getComputedStyle(player).height;
        r.playerOffsetWidth = player.offsetWidth;
        r.playerOffsetHeight = player.offsetHeight;
      } else {
        r.playerTag = 'N/A (not found)';
      }

      r.bodyChildren = document.body.children.length;
      r.bodyComputedDisplay = getComputedStyle(document.body).display;
      r.htmlFontSize = getComputedStyle(document.documentElement).fontSize;

      return JSON.stringify(r);
    })()
  `

  wv.executeJavaScript(diagJs).then((diagStr: string) => {
    logger.info(`[YSP:wv] DIAG → ${diagStr}`)
  }).catch((e2: any) => {
    logger.error(`[YSP:wv] DIAG error: ${e2?.message || e2}`)
  })

  // 第二步：隐藏非播放器元素并铺满播放器（复用共享脚本）
  runWebviewHideUI(wv)
}

// ─── YSP 播放器控制事件 ───

function onYspPrevChannel() {
  yspMuted.value = false
  yspVolume.value = 100
  store.prevYspChannel()
}

function onYspNextChannel() {
  yspMuted.value = false
  yspVolume.value = 100
  store.nextYspChannel()
}

function onYspTogglePlay() {
  playerBarPlaying.value = !playerBarPlaying.value

  // 在 webview 中模拟点击视频
  const wv = yspWebviewRef.value
  if (!wv) return
  try {
    const js = `(function(){
      var v = document.querySelector('video');
      // 记录应用层（本客户端播放条）的播放意图：长江云自动播放看护定时器据此
      // 判断“是用户在客户端主动暂停”，从而不再强行拉起，避免与用户操作对抗。
      window.__hbAppPaused = ${playerBarPlaying.value ? 'false' : 'true'};
      if (v) {
        if (v.paused) { v.play(); } else { v.pause(); }
      } else {
        // 尝试模拟点击播放区域
        var el = document.querySelector('.prism-player, .txp_video_container, .txp_video, #video, video');
        if (el) el.click();
      }
    })()`
    ;(wv as any).executeJavaScript?.(js)
  } catch (e) {
    logger.error(`[YSP] togglePlay error: ${(e as Error)?.message || e}`)
  }
}

function onYspPrevRoute() {
  store.prevYspRoute()
  if (store.yspIsStreamMode) {
    playerBarPlaying.value = true
  }
}

function onYspNextRoute() {
  store.nextYspRoute()
  if (store.yspIsStreamMode) {
    playerBarPlaying.value = true
  }
}

function onYspUpdateMuted(muted: boolean) {
  yspMuted.value = muted
}

function onYspUpdateVolume(vol: number) {
  yspVolume.value = vol
}

</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  background: #0a0a0a;
  color: #e0e0e0;
  overflow: hidden;
  user-select: none;
}

.app-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0a0a0a;
  outline: none;
}

.main-content {
  flex: 1;
  display: flex;
  position: relative;
}

.player-area {
  flex: 1;
  position: relative;
  background: #000;
}

.ysp-webview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
}

.ysp-stream-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 0 48px;
  text-align: center;
  background: radial-gradient(circle at 50% 40%, #16181d 0%, #0a0a0a 70%);
  pointer-events: none;
  z-index: 5;
}

.ysp-stream-error-title {
  font-size: 18px;
  font-weight: 600;
  color: #ff6b6b;
  letter-spacing: 1px;
}

.ysp-stream-error-desc {
  font-size: 14px;
  color: #d8d8d8;
  max-width: 720px;
  line-height: 1.6;
}

.ysp-stream-error-hint {
  font-size: 12px;
  color: #7d7d7d;
  max-width: 720px;
  line-height: 1.7;
}

.side-panels {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 65px;
  width: 360px;
  pointer-events: none;
}

.side-panels > * {
  pointer-events: auto;
  position: relative;
  z-index: 999;
}

/* 输入框右键菜单 */
.input-context-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: transparent;
}

.input-context-menu {
  position: fixed;
  z-index: 100000;
  background: #1e1e2e;
  border: 1px solid #3a3a4e;
  border-radius: 6px;
  padding: 4px 0;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.input-context-menu .menu-item {
  padding: 7px 16px;
  font-size: 12px;
  color: #ccc;
  cursor: pointer;
  transition: background 0.12s;
  white-space: nowrap;
}

.input-context-menu .menu-item:hover {
  background: rgba(64, 158, 255, 0.15);
  color: #fff;
}
</style>

<style>
.side-panels .el-modal-dialog,
.side-panels .el-overlay-dialog {
  pointer-events: none !important;
}
.side-panels .el-dialog {
  pointer-events: auto !important;
}
.source-dialog-overlay {
  pointer-events: none !important;
}
.source-dialog-overlay .el-overlay-dialog {
  pointer-events: none !important;
}
.source-dialog-overlay .el-dialog {
  pointer-events: auto !important;
}

.side-panels .el-dialog {
  --el-dialog-bg-color: #0a0a0a;
  background: #0a0a0a !important;
  border: 1px solid #333 !important;
  box-shadow: 0 8px 32px rgba(0,0,0,0.8) !important;
}
.side-panels .el-dialog__header {
  background: #0a0a0a !important;
  border-bottom: 1px solid #2a2a3e !important;
  padding: 12px 16px !important;
}
.side-panels .el-dialog__body {
  background: #0a0a0a !important;
  color: #ccc !important;
  padding: 16px !important;
}
.side-panels .el-dialog__footer {
  background: #0a0a0a !important;
  border-top: 1px solid #2a2a3e !important;
}

</style>