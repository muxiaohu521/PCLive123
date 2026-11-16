<template>
  <div class="task-status-bar">
    <div class="tsb-bar">
      <div
        v-for="kind in orderedKeys"
        :key="kind"
        class="tsb-pill"
        :class="{ 'tsb-toolbox': kind === 'toolbox' }"
        @click="onPillClick(kind)"
      >
        <!-- 工具箱（最小化入口） -->
        <template v-if="kind === 'toolbox'">
          <span class="tsb-icon">&#x1F6E0;</span>
          <span class="tsb-title">工具箱</span>
        </template>

        <!-- 录屏 -->
        <template v-else-if="kind === 'recording'">
          <span class="tsb-icon">&#x23FA;</span>
          <span class="tsb-title">录屏</span>
          <span class="tsb-status" :class="{ 'tsb-status-paused': recordState === 'paused' }">{{ recordStatusText }}</span>
          <span class="tsb-time">{{ formatDuration(recordElapsed) }}</span>
          <button class="tsb-btn tsb-pause" @click.stop="toggleRecordPause()">{{ recordState === 'paused' ? '继续' : '暂停' }}</button>
          <button class="tsb-btn tsb-stop" @click.stop="stopRecording()">停止</button>
        </template>

        <!-- 投屏 -->
        <template v-else-if="kind === 'cast'">
          <span class="tsb-icon">&#x1F4E1;</span>
          <span class="tsb-title">投屏</span>
          <span class="tsb-status">{{ castStatusText }}</span>
          <button v-if="castSession" class="tsb-btn tsb-stop" @click.stop="stopCast()">停止</button>
        </template>

        <!-- 下载（多个子任务折叠为一个入口） -->
        <template v-else>
          <span class="tsb-icon">&#x2B07;</span>
          <span class="tsb-title">下载</span>
          <span class="tsb-status">{{ downloadCount }} 个任务</span>
          <button class="tsb-btn tsb-stop" @click.stop="stopAllDownloads()">停止</button>
        </template>
      </div>

      <button class="tsb-expand" @click="toggleExpand">{{ expanded ? '&#x25B2;' : '&#x25BC;' }}</button>
    </div>

    <div v-if="expanded" class="tsb-panel">
      <div v-if="!hasTasks" class="tsb-empty">当前没有进行中的任务</div>

      <!-- 下载任务（展开后完整显示所有子任务） -->
      <div v-if="downloadCount > 0" class="tsb-section">
        <div class="tsb-section-title">下载任务（{{ downloadCount }}）</div>
        <div v-for="t in activeDownloads" :key="t.id" class="tsb-card">
          <div class="tsb-card-title">{{ t.title || '未命名频道' }}</div>
          <div class="tsb-card-row"><span class="tsb-label">地址</span><span class="tsb-value tsb-ellipsis">{{ t.url || '-' }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">状态</span><span class="tsb-value">{{ downloadStatusText(t.status) }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">已用时间</span><span class="tsb-value">{{ formatDuration(t.elapsed) }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">分片</span><span class="tsb-value">{{ t.segmentCount }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">已下载</span><span class="tsb-value">{{ formatFileSize(t.totalBytes) }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">输出目录</span><span class="tsb-value tsb-ellipsis">{{ t.outputDir || '-' }}</span></div>
          <div class="tsb-card-actions">
            <button class="tsb-btn tsb-stop" @click="stopDownload(t.id)">停止</button>
            <button class="tsb-btn tsb-open" @click="openDownloadFolder(t.id)">打开目录</button>
          </div>
        </div>
      </div>

      <!-- 录屏 -->
      <div v-if="recordState !== 'idle'" class="tsb-section">
        <div class="tsb-section-title">录屏</div>
        <div class="tsb-card">
          <div class="tsb-card-row"><span class="tsb-label">状态</span><span class="tsb-value" :class="{ 'tsb-status-paused': recordState === 'paused' }">{{ recordStatusText }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">时长</span><span class="tsb-value">{{ formatDuration(recordElapsed) }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">画质</span><span class="tsb-value">{{ recordingQualityLabel }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">输出目录</span><span class="tsb-value tsb-ellipsis">{{ recordingOutputPath || '默认：系统视频目录' }}</span></div>
          <div class="tsb-card-actions">
            <button class="tsb-btn tsb-pause" @click="toggleRecordPause()">{{ recordState === 'paused' ? '继续' : '暂停' }}</button>
            <button class="tsb-btn tsb-stop" @click="stopRecording()">停止</button>
            <button class="tsb-btn tsb-open" @click="openRecordingFolder()">打开目录</button>
          </div>
        </div>
      </div>

      <!-- 投屏 -->
      <div v-if="castSession" class="tsb-section">
        <div class="tsb-section-title">投屏</div>
        <div class="tsb-card">
          <div class="tsb-card-title">{{ castSession.deviceName }}</div>
          <div class="tsb-card-row"><span class="tsb-label">协议</span><span class="tsb-value">{{ castSession.kind === 'tvlive' ? 'TVLive 一键投屏' : '标准 DLNA 配对' }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">地址</span><span class="tsb-value tsb-ellipsis">{{ castSession.host || '-' }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">格式</span><span class="tsb-value">{{ castFormatLabel }}</span></div>
          <div class="tsb-card-row"><span class="tsb-label">画质</span><span class="tsb-value">{{ castSession.quality }}</span></div>
          <div class="tsb-card-actions">
            <button class="tsb-btn tsb-stop" @click="stopCast()">停止</button>
            <button class="tsb-btn tsb-open" @click="openCastPanel()">打开面板</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAppStore } from '@/store'
import { useDownload } from '@/tools/download/useDownload'
import { useRecording } from '@/tools/recording/useRecording'
import { useCastShell } from '@/tools/cast/useCastShell'
import { useToolShell } from '@/tools/shared/useToolShell'
import { formatDuration, formatFileSize } from '@/tools/shared/format'

const store = useAppStore()
const { activeDownloads, stopDownload, openDownloadFolder } = useDownload()
const {
  recordState,
  recordElapsed,
  recordStatusText,
  recordStartedAt,
  recordingOutputPath,
  recordingQuality,
  toggleRecordPause,
  stopRecording,
  openRecordingFolder,
} = useRecording()
const { showBar, minimizedAt } = useToolShell()
const { castSession, castMinimizedAt, stopCast } = useCastShell()

const downloadCount = computed(() => activeDownloads.value.length)
const hasTasks = computed(() => downloadCount.value > 0 || recordState.value !== 'idle' || !!castSession.value)

// 投屏入口仅在投屏面板隐藏时显示（面板打开时无需在状态栏重复展示）
const castBarVisible = computed(() => (!!castSession.value || castMinimizedAt.value > 0) && !store.showDlna)

watch([minimizedAt, downloadCount, recordState, castBarVisible], () => {
  showBar.value = minimizedAt.value > 0 || downloadCount.value > 0 || recordState.value !== 'idle' || castBarVisible.value
})

const castStatusText = computed(() => {
  if (!castSession.value) return '已最小化'
  return castSession.value.deviceName || '投屏中'
})

const castFormatLabel = computed(() => {
  if (!castSession.value) return '-'
  if (castSession.value.kind === 'dlna') return '设备直连'
  const map: Record<string, string> = { auto: '自动', hls: 'HLS', mpegts: 'MPEG-TS' }
  return map[castSession.value.format] || castSession.value.format
})

const recordingQualityLabel = computed(() => {
  const map: Record<string, string> = {
    high: '高画质 (1080p)',
    medium: '中等 (720p)',
    low: '低画质 (480p)',
  }
  return map[recordingQuality.value] || recordingQuality.value
})

function downloadStatusText(status: string): string {
  switch (status) {
    case 'queued': return '排队中'
    case 'downloading': return '下载中'
    case 'merging': return '合并中'
  }
  return ''
}

// 状态栏仅保留「工具箱 / 录屏 / 下载 / 投屏」四个入口，按各自打开顺序（时间戳升序）依次显示。
// 下载的多个子任务折叠进同一个「下载」入口，不拆分；「工具箱」入口仅在最小化时显示。
const orderedKeys = computed<Array<'toolbox' | 'recording' | 'download' | 'cast'>>(() => {
  const entries: Array<{ key: 'toolbox' | 'recording' | 'download' | 'cast'; at: number }> = []
  if (minimizedAt.value > 0) {
    entries.push({ key: 'toolbox', at: minimizedAt.value })
  }
  if (recordState.value !== 'idle') {
    entries.push({ key: 'recording', at: recordStartedAt.value || 0 })
  }
  if (downloadCount.value > 0) {
    const firstAt = activeDownloads.value.reduce((min, t) => Math.min(min, t.startedAt || 0), Infinity)
    entries.push({ key: 'download', at: firstAt === Infinity ? 0 : firstAt })
  }
  if (castBarVisible.value) {
    entries.push({ key: 'cast', at: castSession.value?.startedAt || castMinimizedAt.value })
  }
  return entries.sort((a, b) => a.at - b.at).map((e) => e.key)
})

const expanded = ref(false)

function toggleExpand() {
  expanded.value = !expanded.value
}

function onPillClick(kind: string) {
  if (kind === 'toolbox') {
    openToolbox()
  } else if (kind === 'cast' && !castSession.value) {
    openCastPanel()
  } else {
    toggleExpand()
  }
}

function openToolbox() {
  store.showToolsDialog = true
}

function openCastPanel() {
  castMinimizedAt.value = 0
  store.showDlna = true
}

function stopAllDownloads() {
  void stopDownload()
}
</script>

<style scoped>
.task-status-bar {
  position: fixed;
  top: 48px;
  left: 12px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: calc(100vw - 24px);
}

.tsb-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  background: #2a2a3e;
  border: 1px solid #4fc3f7;
  border-radius: 8px;
  padding: 6px 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.tsb-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: #ccc;
  white-space: nowrap;
  user-select: none;
}

.tsb-pill:hover { background: #35355a; }

.tsb-toolbox {
  background: #35355a;
  border-color: #4fc3f7;
  cursor: pointer;
}

.tsb-toolbox:hover { background: #4a4a7a; }

.tsb-icon { font-size: 13px; }
.tsb-title { color: #e0e0e0; font-weight: 600; }
.tsb-status { color: #888; }
.tsb-status-paused { color: #ffa726; }
.tsb-time {
  color: #ffa726;
  font-family: 'Consolas', 'Courier New', monospace;
}

.tsb-btn {
  padding: 2px 8px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.tsb-pause { background: #3a2a1a; color: #ffa726; }
.tsb-pause:hover { background: #4a3a2a; }
.tsb-stop { background: #2a1a1a; color: #f44336; }
.tsb-stop:hover { background: #4a1a1a; }
.tsb-open { background: #1a2a3e; color: #4fc3f7; }
.tsb-open:hover { background: #2a3a4e; }

.tsb-expand {
  padding: 2px 6px;
  background: transparent;
  border: none;
  color: #4fc3f7;
  font-size: 12px;
  cursor: pointer;
}

.tsb-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #2a2a3e;
  border: 1px solid #4fc3f7;
  border-radius: 8px;
  padding: 10px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  max-height: 420px;
  overflow-y: auto;
}

.tsb-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tsb-section-title {
  color: #4fc3f7;
  font-size: 12px;
  font-weight: 600;
}

.tsb-empty {
  color: #888;
  font-size: 12px;
  padding: 8px;
  text-align: center;
}

.tsb-card {
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 6px;
  padding: 10px 12px;
}

.tsb-card-title {
  color: #e0e0e0;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}

.tsb-card-row {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.8;
}

.tsb-label { color: #666; flex-shrink: 0; min-width: 56px; }
.tsb-value { color: #ccc; }
.tsb-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.tsb-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>