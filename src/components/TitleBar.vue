<template>
  <div class="title-bar" @dblclick="onMaximize">
    <div class="title-bar-left">
      <span class="app-logo">PCLive</span>
      <span class="app-version">v1.0.0</span>
    </div>
    <div class="title-bar-center">
      <template v-if="store.activePlayMode === 'channel'">
        <span class="source-label">{{ currentSourceName }}</span>
        <span class="separator">|</span>
        <span class="channel-label marquee-wrap" :class="{ active: isLongText(channelDisplayName) }">
          <span class="marquee-inner">{{ isLongText(channelDisplayName) ? marqueeContent(channelDisplayName) : channelDisplayName }}</span>
        </span>
        <el-tag v-if="store.channelsLoading" type="warning" size="small" class="loading-tag">
          加载中...
        </el-tag>
        <span v-else class="channel-count">
          {{ totalChannelCount }} 个频道
        </span>
      </template>
      <template v-else-if="store.activePlayMode === 'local'">
        <span class="mode-label">本地视频</span>
        <span class="separator">|</span>
        <span class="channel-label marquee-wrap" :class="{ active: isLongText(localVideoName) }">
          <span class="marquee-inner">{{ isLongText(localVideoName) ? marqueeContent(localVideoName) : localVideoName }}</span>
        </span>
        <span class="channel-count">
          {{ localVideoCountText }}
        </span>
      </template>
      <template v-else-if="store.activePlayMode === 'sniffer' && store.activeLocalLiveChannelIndex >= 0">
        <span class="mode-label">本地直播源</span>
        <span class="separator">|</span>
        <span class="channel-label marquee-wrap" :class="{ active: isLongText(snifferTitle) }">
          <span class="marquee-inner">{{ isLongText(snifferTitle) ? marqueeContent(snifferTitle) : snifferTitle }}</span>
        </span>
      </template>
      <template v-else-if="store.activePlayMode === 'sniffer'">
        <span class="mode-label">URL 嗅探</span>
        <span class="separator">|</span>
        <span class="channel-label marquee-wrap" :class="{ active: isLongText(snifferTitle) }">
          <span class="marquee-inner">{{ isLongText(snifferTitle) ? marqueeContent(snifferTitle) : snifferTitle }}</span>
        </span>
      </template>
      <template v-else>
        <span class="mode-label">本地视频模式</span>
      </template>
      <span class="separator">|</span>
      <el-button
        link
        title="工具箱 (Ctrl+Shift+X)"
        @click="store.showToolsDialog = !store.showToolsDialog"
        class="title-btn"
        :class="{ active: store.showToolsDialog }"
      >
        &#x1F6E0;
      </el-button>
      <el-button
        link
        title="设置 (Ctrl+,)"
        @click="store.showSettings = !store.showSettings"
        class="title-btn"
        :class="{ active: store.showSettings }"
      >
        &#x2699;
      </el-button>
    </div>
    <div class="title-bar-right">
      <el-button
        link
        :icon="VideoCamera"
        title="本地视频列表 (V)"
        @click="toggleLocalVideoList"
        class="title-btn"
        :class="{ active: store.showLocalVideoList }"
      />
      <el-button
        link
        :icon="Monitor"
        title="本地直播源 (K)"
        @click="toggleLocalChannelsList"
        class="title-btn"
        :class="{ active: store.showLocalChannelsList }"
      />
      <el-button
        link
        :icon="Switch"
        title="直播源管理 (Ctrl+Shift+S)"
        @click="toggleSourceManager"
        class="title-btn"
        :class="{ active: store.showSourceManager }"
      />
      <el-button
        link
        :icon="List"
        title="频道列表 (C)"
        @click="toggleChannelList"
        class="title-btn"
      />
      <el-button
        link
        :icon="Refresh"
        title="强制重新解析当前源 (F5)"
        @click="store.refreshCurrentSource()"
        class="title-btn"
      />
      <div class="window-controls">
        <span class="win-btn minimize" @click="minimize" title="最小化">-</span>
        <span class="win-btn maximize" @click="maximize" title="最大化">&#x25A1;</span>
        <span class="win-btn close" @click="closeWin" title="关闭">&#x2715;</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/store'
import { Switch, List, Refresh, VideoCamera, Monitor } from '@element-plus/icons-vue'

const store = useAppStore()

const MAX_DISPLAY_CHARS = 10

function isLongText(text: string): boolean {
  return text.length > MAX_DISPLAY_CHARS
}

function marqueeContent(text: string): string {
  return `${text}\u00A0\u00A0\u00A0${text}`
}

const channelDisplayName = computed(() => {
  return store.currentChannel?.channelName || '未选频道'
})

const currentSourceName = computed(() => {
  const s = store.sourceList.find(s => s.url === store.currentSource)
  return s ? s.name : '无源'
})

const totalChannelCount = computed(() =>
  store.channelGroups.reduce((sum, g) => sum + g.liveChannels.length, 0)
)

const localVideoName = computed(() => {
  return store.currentLocalVideo?.name || '未选择视频'
})

const localVideoCountText = computed(() => {
  const total = store.localVideoList.length
  if (total === 0) return '无视频'
  return `${total} 个视频`
})

const snifferTitle = computed(() => {
  return store.externalPlayInfo?.title || '嗅探中'
})

function toggleLocalVideoList() {
  store.showLocalVideoList = !store.showLocalVideoList
  if (store.showLocalVideoList) {
    store.showChannelList = false
    store.showSourceManager = false
    store.showLivesPanel = false
    store.showLocalChannelsList = false
  }
}

function toggleLocalChannelsList() {
  store.showLocalChannelsList = !store.showLocalChannelsList
  if (store.showLocalChannelsList) {
    store.showChannelList = false
    store.showSourceManager = false
    store.showLivesPanel = false
    store.showLocalVideoList = false
  }
}

function toggleSourceManager() {
  store.showSourceManager = !store.showSourceManager
  if (store.showSourceManager) {
    store.showChannelList = false
    store.showLivesPanel = false
    store.showLocalVideoList = false
    store.showLocalChannelsList = false
  }
}

function toggleChannelList() {
  store.showChannelList = !store.showChannelList
  if (store.showChannelList) {
    store.showSourceManager = false
    store.showLivesPanel = false
    store.showLocalVideoList = false
    store.showLocalChannelsList = false
  }
}

function minimize() {
  window.electronAPI?.minimize()
}

function maximize() {
  window.electronAPI?.maximize()
}

function onMaximize() {
  window.electronAPI?.maximize()
}

function closeWin() {
  window.electronAPI?.close()
}
</script>

<style scoped>
.title-bar {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1a1a2e;
  padding: 0 8px;
  -webkit-app-region: drag;
  z-index: 100;
  border-bottom: 1px solid #2a2a3e;
}

.title-bar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-logo { font-size: 13px; font-weight: 700; color: #4fc3f7; }

.app-version {
  font-size: 10px;
  color: #555;
  background: #2a2a3e;
  padding: 1px 6px;
  border-radius: 3px;
}

.title-bar-center {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.source-label { color: #ffa726; }
.mode-label { color: #4fc3f7; }
.separator { color: #333; }
.channel-label { color: #e0e0e0; }

.marquee-wrap {
  max-width: 10em;
  overflow: hidden;
  white-space: nowrap;
  display: inline-block;
  vertical-align: middle;
}

.marquee-wrap.active .marquee-inner {
  display: inline-block;
  animation: marquee-scroll 10s linear infinite;
}

@keyframes marquee-scroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(-50%); }
}

.loading-tag { transform: scale(0.85); }

.channel-count { color: #555; font-size: 11px; }

.title-bar-right {
  display: flex;
  align-items: center;
  gap: 2px;
}

.title-btn {
  color: #aaa !important;
  padding: 4px 8px !important;
  font-size: 16px !important;
  -webkit-app-region: no-drag;
}

.title-btn:hover {
  color: #fff !important;
  background: rgba(255, 255, 255, 0.08) !important;
}

.title-btn.active {
  color: #4fc3f7 !important;
  background: rgba(79, 195, 247, 0.12) !important;
}

.window-controls {
  display: flex;
  align-items: center;
  margin-left: 6px;
  -webkit-app-region: no-drag;
}

.win-btn {
  width: 34px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #aaa;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s, color 0.15s;
}

.win-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.win-btn.close:hover {
  background: #e81123;
  color: #fff;
}
</style>