<template>
  <FloatView v-if="isFloatMode" />
  <div v-else class="app-container" @mousemove="onMouseMove" tabindex="0" ref="appRef">
    <TitleBar />
    <div class="main-content">
      <div class="player-area">
        <VideoPlayer
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
        />
      </div>

      <div class="side-panels">
        <LocalVideoList
          v-if="store.showLocalVideoList"
          @close="store.showLocalVideoList = false"
          @select="onLocalVideoSelect"
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
          v-if="store.showDlna"
          :currentUrl="currentChannelUrl || ''"
          @close="store.showDlna = false"
        />
        <SettingsPanel
          v-if="store.showSettings"
          @close="store.showSettings = false"
          @saved="onSettingsSaved"
        />
      </div>

      <div class="bottom-bar" v-if="showBottomBar">
        <div class="channel-info">
          <span class="channel-name">
            {{ bottomBarTitle }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onErrorCaptured } from 'vue'
import { useAppStore } from '@/store'
import { logger } from '@/utils/logger'
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

const store = useAppStore()
const appRef = ref<HTMLElement | null>(null)
const videoPlayerRef = ref<InstanceType<typeof VideoPlayer>>()
const isFloatMode = ref(window.location.hash === '#/float')
const showBottomBar = ref(true)
let hideTimer: ReturnType<typeof setTimeout> | null = null
let mouseMoving = false

const sourceInfo = computed(() => {
  if (store.activePlayMode === 'channel') {
    return {
      sourceIndex: store.currentChannel?.sourceIndex ?? 0,
      sourceNum: store.currentChannel?.sourceNum ?? 0
    }
  }
  if (store.activePlayMode === 'local') {
    const total = store.localVideoList.length
    const idx = store.currentLocalVideo
      ? store.localVideoList.findIndex(v => v.filePath === store.currentLocalVideo!.filePath)
      : -1
    return { sourceIndex: idx, sourceNum: total }
  }
  return { sourceIndex: 0, sourceNum: 0 }
})

const currentChannelName = computed(() => store.currentChannel?.channelName ?? '')
const currentChannelUrl = computed(() => store.currentUrl || '')

const bottomBarTitle = computed(() => {
  if (store.activePlayMode === 'local' && store.currentLocalVideo) {
    return store.currentLocalVideo.name
  }
  if (store.activePlayMode === 'sniffer' && store.currentUrl) {
    return 'URL 嗅探'
  }
  return store.currentChannel?.channelName || '未选择频道'
})

function onPrevSource() {
  if (store.activePlayMode !== 'channel') return
  store.switchPrevSource()
}

function onNextSource() {
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
  if (store.activePlayMode === 'channel') {
    navigateChannel(-1)
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
  if (store.activePlayMode === 'channel') {
    navigateChannel(1)
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
  await store.initSources()
  await store.loadChannels()

  appRef.value?.focus()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', onBeforeUnload)
})

onUnmounted(() => {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
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

function onMouseMove() {
  mouseMoving = true
  showBottomBar.value = true
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!mouseMoving) {
      showBottomBar.value = false
    }
    mouseMoving = false
  }, 3000)
}

function onKeyDown(e: KeyboardEvent) {
  switch (e.key) {
    case 'F5':
      e.preventDefault()
      if (store.activePlayMode === 'channel') store.refreshCurrentSource()
      break
    case 'F11':
      e.preventDefault()
      toggleFullscreen()
      break
    case 'Escape':
      store.showChannelList = false
      store.showSourceManager = false
      store.showLivesPanel = false
      store.showToolsDialog = false
      store.showDlna = false
      store.showSettings = false
      store.showLocalVideoList = false
      break
    case 'Tab':
      e.preventDefault()
      store.showChannelList = !store.showChannelList
      if (store.showChannelList) {
        store.showSourceManager = false
        store.showLivesPanel = false
        store.showLocalVideoList = false
      }
      break
    case 's':
    case 'S':
      if (e.ctrlKey) {
        e.preventDefault()
        store.showSourceManager = !store.showSourceManager
        if (store.showSourceManager) {
          store.showChannelList = false
          store.showLivesPanel = false
          store.showLocalVideoList = false
        }
      }
      break
    case 'l':
    case 'L':
      e.preventDefault()
      store.showLivesPanel = !store.showLivesPanel
      if (store.showLivesPanel) {
        store.showChannelList = false
        store.showSourceManager = false
        store.showLocalVideoList = false
      }
      break
    case 'v':
    case 'V':
      e.preventDefault()
      store.showLocalVideoList = !store.showLocalVideoList
      if (store.showLocalVideoList) {
        store.showChannelList = false
        store.showSourceManager = false
        store.showLivesPanel = false
      }
      break
    case 'n':
    case 'N':
      if (e.ctrlKey) {
        e.preventDefault()
        store.showToolsDialog = !store.showToolsDialog
        if (store.showToolsDialog) {
          store.showChannelList = false
          store.showSourceManager = false
          store.showLivesPanel = false
          store.showLocalVideoList = false
        }
      }
      break
    case 'd':
    case 'D':
      if (e.ctrlKey) {
        e.preventDefault()
        store.showDlna = !store.showDlna
        if (store.showDlna) {
          store.showChannelList = false
          store.showSourceManager = false
          store.showToolsDialog = false
          store.showLocalVideoList = false
          store.showLivesPanel = false
        }
      }
      break
    case ',':
      if (e.ctrlKey) {
        e.preventDefault()
        store.showSettings = !store.showSettings
        if (store.showSettings) {
          store.showChannelList = false
          store.showSourceManager = false
          store.showToolsDialog = false
          store.showLocalVideoList = false
          store.showLivesPanel = false
        }
      }
      break
    case 'ArrowUp':
      e.preventDefault()
      onPrevChannel()
      break
    case 'ArrowDown':
      e.preventDefault()
      onNextChannel()
      break
    case ' ':
      e.preventDefault()
      togglePlay()
      break
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
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    appRef.value?.requestFullscreen()
  }
}

function onSourceError() {
  if (store.currentChannel && store.currentChannel.sourceIndex < store.currentChannel.sourceNum - 1) {
    store.switchNextSource()
  }
}

function onVideoEnded() {
  console.log('[App] ended fired, activePlayMode=', store.activePlayMode, 'localPlayMode=', store.localPlayMode)
  if (store.activePlayMode !== 'local') return

  const mode = store.localPlayMode
  const current = store.currentLocalVideo
  const list = store.localVideoList
  console.log('[App] onVideoEnded mode=', mode, 'current=', current?.name, 'listLen=', list.length)
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
      console.log('[App] same URL after autoPlayNext, calling playLocalFile directly')
      videoPlayerRef.value?.playLocalFile(nextUrl)
    }
  }
}

function onSelectChannel(channel: LiveChannelItem) {
  store.selectChannel(channel)
}

function onSettingsSaved(settings: Record<string, any>) {
  if (settings.volume !== undefined) {
    store.volume = settings.volume
  }
  logger.info('[App] Settings saved:', Object.keys(settings).join(', '))
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
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0a0a0a;
  outline: none;
}

.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.player-area {
  flex: 1;
  position: relative;
  background: #000;
}

.side-panels {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 65px;
  width: 360px;
  z-index: 999;
  pointer-events: none;
}

.side-panels > * {
  pointer-events: auto;
}

.bottom-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 360px;
  padding: 8px 16px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.85));
  display: flex;
  justify-content: space-between;
  align-items: center;
  z-index: 5;
}

.channel-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.channel-name {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.source-name {
  font-size: 11px;
  color: #aaa;
}
</style>