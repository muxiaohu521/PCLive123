<template>
  <div class="local-video-panel">
    <div class="panel-header">
      <div class="header-left">
        <h3 class="panel-title">本地视频</h3>
        <span class="panel-count">{{ store.localVideoList.length }} 个视频</span>
      </div>
      <div class="header-actions">
        <el-button link :icon="Close" @click="$emit('close')" class="close-btn" />
      </div>
    </div>

    <!-- 分支选择器 -->
    <div class="branch-bar">
      <div class="branch-selector">
        <el-select
          v-model="activeBranchId"
          size="small"
          class="branch-select"
          popper-class="branch-popper"
          @change="onBranchChange"
        >
          <el-option
            v-for="branch in store.localVideoBranches"
            :key="branch.id"
            :label="branch.name + ' (' + branch.videos.length + ')'"
            :value="branch.id"
          />
        </el-select>
        <el-button
          link
          :icon="Plus"
          size="small"
          class="branch-btn"
          title="新建分支"
          @click="onAddBranch"
        />
        <el-button
          link
          :icon="Edit"
          size="small"
          class="branch-btn"
          title="重命名分支"
          @click="onRenameBranch"
        />
        <el-button
          v-if="store.localVideoBranches.length > 1"
          link
          :icon="Delete"
          size="small"
          class="branch-btn branch-btn-del"
          title="删除整个分支"
          @click="onDeleteBranch"
        />
      </div>
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

    <div class="panel-footer">
      <div class="footer-row">
        <span class="shortcut">↑↓ 切换视频</span>
        <span class="shortcut">Tab 关闭</span>
      </div>
    </div>

    <!-- 新建 / 重命名分支弹窗 -->
    <el-dialog
      v-model="showBranchDialog"
      :title="branchDialogTitle"
      width="360px"
      :close-on-click-modal="false"
      :modal="false"
      :append-to-body="false"
      draggable
      class="branch-edit-dialog"
    >
      <el-form label-width="60px" @submit.prevent="onConfirmBranchDialog">
        <el-form-item label="名称">
          <el-input v-model="branchFormName" placeholder="输入分支名称" maxlength="30" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showBranchDialog = false">取消</el-button>
        <el-button type="primary" @click="onConfirmBranchDialog">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Close, FolderAdd, Delete, VideoCamera, Plus, Edit } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '@/store'
import type { LocalVideoItem } from '@/constants'
import { isElectron as checkIsElectron } from '@/constants'
import { logger } from '@/utils/logger'

const emit = defineEmits<{
  close: []
  select: [video: LocalVideoItem]
}>()

const store = useAppStore()

const isElectron = computed(() => checkIsElectron())

// 分支选择器
const activeBranchId = ref(store.activeLocalVideoBranchId)

watch(() => store.activeLocalVideoBranchId, (val) => {
  activeBranchId.value = val
})

function onBranchChange(branchId: string) {
  store.setActiveLocalVideoBranch(branchId)
}

// 分支弹窗
const showBranchDialog = ref(false)
const branchDialogMode = ref<'add' | 'rename'>('add')
const branchFormName = ref('')
const renamingBranchId = ref('')

const branchDialogTitle = computed(() => {
  return branchDialogMode.value === 'add' ? '新建分支' : '重命名分支'
})

function onAddBranch() {
  branchDialogMode.value = 'add'
  branchFormName.value = ''
  renamingBranchId.value = ''
  showBranchDialog.value = true
}

function onRenameBranch() {
  const branch = store.localVideoBranches.find(b => b.id === store.activeLocalVideoBranchId)
  if (!branch) return
  branchDialogMode.value = 'rename'
  branchFormName.value = branch.name
  renamingBranchId.value = branch.id
  showBranchDialog.value = true
}

function onConfirmBranchDialog() {
  const isAdd = branchDialogMode.value === 'add'
  const ok = isAdd
    ? !!store.addLocalVideoBranch(branchFormName.value)
    : store.renameLocalVideoBranch(renamingBranchId.value, branchFormName.value)
  if (ok) {
    const name = branchFormName.value.trim()
    ElMessage.success(isAdd ? `已创建分支 "${name}"` : `已重命名为 "${name}"`)
    showBranchDialog.value = false
  } else {
    ElMessage.warning('分支名称已存在或无效')
  }
}

async function onDeleteBranch() {
  const branch = store.localVideoBranches.find(b => b.id === store.activeLocalVideoBranchId)
  if (!branch) return
  const count = branch.videos.length
  const msg = count > 0
    ? `确定要删除分支 "${branch.name}" 吗？该分支包含 ${count} 个视频，删除后不可恢复！`
    : `确定要删除分支 "${branch.name}" 吗？`
  try {
    await ElMessageBox.confirm(msg, '删除分支', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
    const ok = store.removeLocalVideoBranch(branch.id)
    if (ok) {
      ElMessage.success(`已删除分支 "${branch.name}"`)
    }
  } catch {
    // 用户取消
  }
}

async function onImportFile() {
  if (!isElectron.value) {
    ElMessage.warning('导入功能仅支持 Electron 环境')
    return
  }
  try {
    logger.log('[LocalVideo] onImportFile: 调用 openMediaFile')
    const result = await window.electronAPI!.openMediaFile({
      title: '选择视频文件',
      filters: [
        { name: '媒体文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mts', 'm2ts', 'ogv', '3gp', '3g2', 'asf', 'vob', 'rmvb', 'divx', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'wma', 'ape', 'alac', 'aiff', 'aif', 'ogg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    logger.log('[LocalVideo] onImportFile: result=', JSON.stringify(result))
    if (!result || !result.filePath) {
      logger.warn('[LocalVideo] onImportFile: 无结果或无文件路径, result=', result)
      ElMessage.warning('未选择文件')
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
      ElMessage.success(`已添加 "${fileName}" 到 "${activeBranchName.value}"`)
    } else {
      ElMessage.warning(`"${fileName}" 已在列表中`)
    }
  } catch (e: any) {
    logger.error('[LocalVideo] onImportFile: 异常', e)
    ElMessage.error('导入失败: ' + (e.message || '未知错误'))
  }
}

const activeBranchName = computed(() => {
  const branch = store.localVideoBranches.find(b => b.id === store.activeLocalVideoBranchId)
  return branch?.name || '默认列表'
})

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
        ? `已添加 ${added} 个视频到 "${activeBranchName.value}"，${skipped} 个已存在`
        : `已添加 ${added} 个视频到 "${activeBranchName.value}"`
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
  border-left: 1px solid #2a2a3e;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px 8px;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

.panel-count {
  font-size: 11px;
  color: #555;
}

.close-btn {
  color: #666 !important;
  padding: 4px !important;
  font-size: 18px !important;
}

.close-btn:hover {
  color: #fff !important;
}

/* 分支选择器 */
.branch-bar {
  padding: 0 14px 8px;
  flex-shrink: 0;
}

.branch-selector {
  display: flex;
  align-items: center;
  gap: 4px;
}

.branch-select {
  flex: 1;
  min-width: 0;
}

.branch-select :deep(.el-input__wrapper) {
  background: #2a2a3e;
  border-color: #3a3a4e;
  box-shadow: none;
}

.branch-select :deep(.el-input__inner) {
  color: #ccc;
  font-size: 12px;
}

.branch-btn {
  color: #888 !important;
  padding: 4px !important;
  font-size: 14px !important;
}

.branch-btn:hover {
  color: #409eff !important;
}

.branch-btn-del:hover {
  color: #f56c6c !important;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px 10px;
  flex-shrink: 0;
}

.toolbar-spacer {
  flex: 1;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.panel-body::-webkit-scrollbar {
  width: 8px;
}

.panel-body::-webkit-scrollbar-track {
  background: #1a1a2e;
  border-radius: 4px;
}

.panel-body::-webkit-scrollbar-thumb {
  background: #4a4a6a;
  border-radius: 4px;
  border: 2px solid #1a1a2e;
}

.panel-body::-webkit-scrollbar-thumb:hover {
  background: #6a6a8a;
}

.panel-body {
  scrollbar-width: thin;
  scrollbar-color: #4a4a6a #1a1a2e;
}

.panel-footer {
  padding: 8px 14px;
  border-top: 1px solid #2a2a3e;
  flex-shrink: 0;
}

.footer-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}

.shortcut {
  font-size: 10px;
  color: #555;
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

.branch-edit-dialog :deep(.el-dialog) {
  background: #1e1e30;
  border: 1px solid #3a3a4e;
}

.branch-edit-dialog :deep(.el-dialog__title) {
  color: #ccc;
}

.branch-edit-dialog :deep(.el-form-item__label) {
  color: #999;
}
</style>