<template>
  <div class="local-video-panel">
    <div class="panel-header">
      <div class="header-left">
        <h3 class="panel-title">本地视频</h3>
        <span class="panel-count">{{ store.localVideoList.length }} 个视频</span>
      </div>
      <el-button link :icon="Close" @click="$emit('close')" class="close-btn" />
    </div>

    <div class="panel-toolbar">
      <el-button size="small" :icon="FolderAdd" @click="onImportFolder" :disabled="!isElectron">
        导入文件夹
      </el-button>
      <el-button size="small" :icon="VideoCamera" @click="onImportFile" :disabled="!isElectron">
        导入文件
      </el-button>
      <div class="toolbar-spacer" />
    </div>

    <div class="panel-body">
      <div class="section" v-if="store.localVideoList.length > 0">
        <div class="video-list">
          <div
            v-for="video in store.localVideoList"
            :key="video.filePath"
            class="video-item"
            :class="{ active: store.currentLocalVideo?.filePath === video.filePath }"
            @click="onSelectVideo(video)"
          >
            <div class="video-left">
              <span class="video-indicator" v-if="store.currentLocalVideo?.filePath === video.filePath">▶</span>
              <span class="video-icon">🎬</span>
              <div class="video-info">
                <span class="video-name" :title="video.name">{{ video.name }}</span>
                <span class="video-path" :title="video.filePath">{{ video.filePath }}</span>
              </div>
            </div>
            <div class="video-actions">
              <el-button link :icon="Delete" size="small" @click.stop="onDeleteVideo(video)" title="移除" />
            </div>
          </div>
        </div>
      </div>

      <div class="section" v-if="store.localVideoList.length === 0">
        <div class="empty-state">
          暂无本地视频
          <div class="empty-hint">点击 "导入文件夹" 或 "导入文件" 添加本地视频</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Close, FolderAdd, Delete, VideoCamera } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'
import type { LocalVideoItem } from '@/constants'

const emit = defineEmits<{
  close: []
  select: [video: LocalVideoItem]
}>()

const store = useAppStore()

const isElectron = computed(() => typeof window !== 'undefined' && !!window.electronAPI)

async function onImportFile() {
  if (!isElectron.value) {
    ElMessage.warning('导入功能仅支持 Electron 环境')
    return
  }
  try {
    const result = await window.electronAPI!.openFileDialog({
      title: '选择视频文件',
      filters: [
        { name: '媒体文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mts', 'm2ts', 'ogv', '3gp', '3g2', 'asf', 'vob', 'rmvb', 'divx', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'wma', 'ape', 'alac', 'aiff', 'aif', 'ogg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (!result || !result.filePath) {
      return
    }

    const fileName = result.fileName || result.filePath.split(/[/\\]/).pop() || '未知文件'
    const exists = await window.electronAPI!.fileExists(result.filePath)
    if (!exists) {
      ElMessage.error('文件不存在')
      return
    }

    const video: LocalVideoItem = {
      name: fileName,
      filePath: result.filePath,
      size: 0,
      addedAt: Date.now(),
    }
    const added = store.addLocalVideos([video])
    if (added > 0) {
      ElMessage.success(`已添加 "${fileName}"`)
    } else {
      ElMessage.warning(`"${fileName}" 已在列表中`)
    }
  } catch (e: any) {
    ElMessage.error('导入失败: ' + (e.message || '未知错误'))
  }
}

async function onImportFolder() {
  if (!isElectron.value) {
    ElMessage.warning('导入功能仅支持 Electron 环境')
    return
  }
  try {
    const dirResult = await window.electronAPI!.scanVideoDirectory()
    if (!dirResult || !dirResult.directoryPath) {
      return
    }

    if (!dirResult.files || dirResult.files.length === 0) {
      ElMessage.warning('该文件夹下未找到视频文件')
      return
    }

    const videos: LocalVideoItem[] = dirResult.files.map((f: { name: string; filePath: string; size: number }) => ({
      name: f.name,
      filePath: f.filePath,
      size: f.size,
      addedAt: Date.now(),
    }))

    const added = store.addLocalVideos(videos)
    const skipped = dirResult.files.length - added
    if (added > 0) {
      const msg = skipped > 0
        ? `已添加 ${added} 个视频，${skipped} 个已存在`
        : `已添加 ${added} 个视频`
      ElMessage.success(msg)
    } else {
      ElMessage.warning('所选文件夹下的视频文件均已存在列表中')
    }
  } catch (e: any) {
    ElMessage.error('导入文件夹失败: ' + (e.message || '未知错误'))
  }
}

function onSelectVideo(video: LocalVideoItem) {
  emit('select', video)
}

function onDeleteVideo(video: LocalVideoItem) {
  store.removeLocalVideo(video.filePath)
  ElMessage.success(`已移除 "${video.name}"`)
}
</script>

<style scoped>
.local-video-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  border-left: 1px solid #2a2a4a;
  pointer-events: auto;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #2a2a4a;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #e0e0e0;
  margin: 0;
}

.panel-count {
  font-size: 12px;
  color: #888;
}

.close-btn {
  color: #888;
  font-size: 18px;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid #2a2a4a;
  flex-shrink: 0;
}

.toolbar-spacer {
  flex: 1;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.section {
  padding: 0 8px;
}

.video-list {
  display: flex;
  flex-direction: column;
}

.video-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;
}

.video-item:hover {
  background: rgba(255, 255, 255, 0.06);
}

.video-item.active {
  background: rgba(64, 158, 255, 0.15);
  border: 1px solid rgba(64, 158, 255, 0.3);
}

.video-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.video-indicator {
  color: #409eff;
  font-size: 12px;
  flex-shrink: 0;
}

.video-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.video-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.video-name {
  font-size: 13px;
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.video-path {
  font-size: 11px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.video-actions {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.video-item:hover .video-actions {
  opacity: 1;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: #888;
  font-size: 13px;
}

.empty-hint {
  margin-top: 8px;
  font-size: 12px;
  color: #666;
}
</style>