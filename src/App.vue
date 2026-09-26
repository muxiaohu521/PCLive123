<template>
  <FloatView v-if="isFloatMode" />
  <div v-else class="app-container" @mousemove="onMouseMove" tabindex="0" ref="appRef">
    <TitleBar />
    <div class="main-content">
      <div class="player-area">
        <VideoPlayer
          v-if="!store.yspWebviewUrl"
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
        <webview v-if="store.yspWebviewUrl"
          :key="store.yspWebviewUrl"
          ref="yspWebviewRef"
          :src="store.yspWebviewUrl"
          class="ysp-webview"
          @dom-ready="onYspDomReady"
          @did-start-loading="onYspStartLoading"
          @did-stop-loading="onYspStopLoading"
          @did-finish-load="onYspWebviewReady"
          @did-fail-load="onYspFailLoad"
          @crashed="onYspCrashed"
          @console-message="onYspConsole"
        />
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
          v-if="store.showDlna"
          :currentUrl="currentChannelUrl || ''"
          @close="store.showDlna = false"
        />
        <SettingsPanel
          v-if="store.showSettings"
          @close="store.showSettings = false"
          @saved="onSettingsSaved"
        />
        <YspPanel
          v-if="store.showYspPanel"
          @close="store.showYspPanel = false"
        />
      </div>

      <div class="bottom-bar" v-if="showBottomBar && !store.yspWebviewUrl">
        <div class="channel-info">
          <span class="channel-name">
            {{ bottomBarTitle }}
          </span>
        </div>
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
import { ref, computed, onMounted, onUnmounted, onErrorCaptured } from 'vue'
import { useAppStore } from '@/store'
import { useInputContextMenu } from '@/composables/useInputContextMenu'
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
import LocalChannelsList from '@/components/LocalChannelsList.vue'
import YspPanel from '@/components/YspPanel.vue'

const store = useAppStore()
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
const yspWebviewRef = ref<any>(null)
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
  return { sourceIndex: 0, sourceNum: 0 }
})

const currentChannelName = computed(() => store.currentChannel?.channelName ?? '')
const currentChannelUrl = computed(() => store.currentUrl || '')

const bottomBarTitle = computed(() => {
  if (store.activePlayMode === 'local' && store.currentLocalVideo) {
    return store.currentLocalVideo.name
  }
  if (store.activeLocalLiveChannelIndex >= 0 && store.localChannelCurrentInfo) {
    return store.localChannelCurrentInfo.name
  }
  if (store.activePlayMode === 'sniffer' && store.currentUrl) {
    return 'URL 嗅探'
  }
  return store.currentChannel?.channelName || '未选择频道'
})

function onPrevSource() {
  if (store.activePlayMode === 'locallive') {
    store.switchLocalLivePrevSource()
    return
  }
  if (store.activePlayMode !== 'channel') return
  store.switchPrevSource()
}

function onNextSource() {
  if (store.activePlayMode === 'locallive') {
    store.switchLocalLiveNextSource()
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
  await store.initSources()
  await store.loadChannels()
  store.loadLocalChannels()
  await store.loadYspChannels()
  registerGlobalListener()

  appRef.value?.focus()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('beforeunload', onBeforeUnload)
})

onUnmounted(() => {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
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
    } else {
      store.yspWebviewUrl = ''
      store.yspWebviewTitle = ''
    }
    return
  }

  if (store.matchShortcut(e, 'prevSource')) {
    e.preventDefault()
    if (store.activePlayMode === 'channel' || store.activePlayMode === 'locallive') {
      onPrevSource()
    }
    return
  }

  if (store.matchShortcut(e, 'nextSource')) {
    e.preventDefault()
    if (store.activePlayMode === 'channel' || store.activePlayMode === 'locallive') {
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
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    appRef.value?.requestFullscreen()
  }
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
  logger.error(`[YSP:wv] did-fail-load code=${e.errorCode} desc="${e.errorDescription}" url=${e.validatedURL}`)
}

function onYspCrashed() {
  logger.error('[YSP:wv] crashed!')
}

function onYspDomReady(event: any) {
  const wv = event.target
  if (!wv) return
  logger.info('[YSP:wv] dom-ready → injecting CSS')

  wv.insertCSS(`
    html,body{margin:0!important;padding:0!important;width:100%!important;height:100%!important;overflow:hidden!important}
    ::-webkit-scrollbar{display:none!important}
    body{background:#000!important;visibility:hidden!important}
    .header,.tv-main-con-r,.tv-home-btm,.tv-zhan,.public,.footer,.max-footer{display:none!important}
  `)
}

function onYspWebviewReady(event: any) {
  const wv = event.target
  if (!wv) return
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

      var player = v.closest('.tv-main-con-l, .tv-main-con-l-vid');
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

  // 第二步：隐藏非播放器元素
  const actionJs = `
    (function hideUI(){
      console.log('[hideUI] start');
      var v = document.querySelector('video');
      if (!v) { console.log('[hideUI] no video, will retry'); setTimeout(hideUI, 500); return; }
      console.log('[hideUI] video found id=' + v.id + ' src=' + (v.src||'').substring(0,60));

      var player = v.closest('.tv-main-con-l, .tv-main-con-l-vid');
      if (!player) {
        console.log('[hideUI] closest failed, trying parent walk');
        var p = v.parentElement;
        while (p && p !== document.body) {
          if (p.offsetWidth > 400 && p.offsetHeight > 300) { player = p; console.log('[hideUI] found player via walk tag=' + p.tagName); break; }
          p = p.parentElement;
        }
      } else {
        console.log('[hideUI] player found via closest class=' + player.className);
      }
      if (!player) { console.log('[hideUI] no player found, abort'); return; }

      console.log('[hideUI] hiding body children count=' + document.body.children.length);
      for (var ci = 0; ci < document.body.children.length; ci++) {
        document.body.children[ci].style.display = 'none';
      }

      var cur = player;
      var chain = [];
      while (cur && cur !== document.body && cur !== document.documentElement) {
        chain.push(cur);
        cur = cur.parentElement;
      }
      console.log('[hideUI] chain length=' + chain.length);

      for (var j = 0; j < chain.length; j++) {
        var node = chain[j];
        node.style.display = '';
        var parent2 = node.parentElement;
        if (parent2) {
          var hiddenCount = 0;
          for (var k = 0; k < parent2.children.length; k++) {
            if (parent2.children[k] !== node) {
              parent2.children[k].style.display = 'none';
              hiddenCount++;
            }
          }
          console.log('[hideUI] chain[' + j + '] tag=' + node.tagName + ' class=' + node.className + ' siblings_hidden=' + hiddenCount);
        }
      }

      document.body.style.display = '';
      document.body.style.background = '#000';
      document.body.style.margin = '0';
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'relative';
      document.body.style.width = '100%';
      document.body.style.height = '100%';

      player.style.cssText = 'position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;overflow:hidden!important;z-index:0!important';
      v.style.cssText = 'position:absolute!important;top:0!important;left:0!important;width:100%!important;height:100%!important;object-fit:contain!important;z-index:1!important';
      document.body.style.setProperty('visibility', 'visible', 'important');
      console.log('[hideUI] done');
    })()
  `

  wv.executeJavaScript(actionJs).catch((e3: any) => {
    logger.error(`[YSP:wv] hideUI error: ${e3?.message || e3}`)
  })
}

function onCloseYspWebview() {
  logger.info('[YSP:wv] close')
  store.yspWebviewUrl = ''
  store.yspWebviewTitle = ''
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

.ysp-webview {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: none;
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