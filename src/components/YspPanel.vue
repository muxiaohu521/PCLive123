<template>
  <div class="ysp-panel">
    <div class="panel-header">
      <h3 class="panel-title">官网直播源</h3>
      <span class="channel-count">{{ store.yspChannels.length }} 个频道</span>
      <el-button link class="close-btn" @click="$emit('close')">
        <el-icon><Close /></el-icon>
      </el-button>
    </div>

    <div class="toolbar">
      <el-button size="small" type="primary" :icon="Plus" @click="openAddDialog">添加</el-button>
      <el-button size="small" :icon="FolderOpened" @click="openFileLocation" :disabled="!isElectron">文件</el-button>
    </div>

    <div class="channel-list">
      <div
        v-for="(ch, idx) in store.yspChannels"
        :key="idx"
        class="channel-row"
        @click="playChannel(ch)"
      >
        <div class="channel-info">
          <div class="channel-name">{{ ch.name }}</div>
          <div class="channel-url">{{ ch.url }}</div>
        </div>
        <div class="channel-actions">
          <el-button link :icon="Edit" size="small" @click.stop="openEditDialog(idx)" />
          <el-button link :icon="Delete" size="small" @click.stop="removeChannel(idx)" />
        </div>
      </div>
      <div v-if="store.yspChannels.length === 0" class="empty-state">
        暂无频道，点击「添加」新增
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="editingIndex >= 0 ? '编辑频道' : '新增频道'"
      width="480px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-form label-width="60px">
        <el-form-item label="名称">
          <el-input v-model="form.name" placeholder="频道显示名称" maxlength="50" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="form.url" placeholder="直播页面URL" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="saveChannel">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Close, FolderOpened, Edit, Delete } from '@element-plus/icons-vue'
import { useAppStore } from '@/store'
import { logger } from '@/utils/logger'

defineEmits<{ close: [] }>()

const store = useAppStore()

const dialogVisible = ref(false)
const editingIndex = ref(-1)
const form = reactive({ name: '', url: '' })

const isElectron = computed(() => !!(window as any).electronAPI)

function openAddDialog() {
  editingIndex.value = -1
  form.name = ''
  form.url = ''
  dialogVisible.value = true
  logger.debug('[YSPanel] open add dialog')
}

function openEditDialog(idx: number) {
  const ch = store.yspChannels[idx]
  if (!ch) {
    logger.warn(`[YSPanel] edit: invalid index ${idx}`)
    return
  }
  editingIndex.value = idx
  form.name = ch.name
  form.url = ch.url
  dialogVisible.value = true
  logger.debug(`[YSPanel] open edit dialog idx=${idx} name="${ch.name}"`)
}

async function saveChannel() {
  const name = form.name.trim()
  const url = form.url.trim()
  if (!name) return ElMessage.warning('请输入频道名称')
  if (!url) return ElMessage.warning('请输入频道地址')

  const isEdit = editingIndex.value >= 0
  logger.info(`[YSPanel] saving channel: ${isEdit ? 'edit' : 'add'} name="${name}" url="${url.substring(0, 80)}"`)

  if (isEdit) {
    store.yspChannels[editingIndex.value] = { name, url, pid: '' }
  } else {
    store.yspChannels.push({ name, url, pid: '' })
  }

  const success = await store.saveYspChannels()
  if (!success) {
    logger.error(`[YSPanel] save failed: could not write to ysp_channels.json`)
    ElMessage.error('写入文件失败，请检查磁盘空间或权限')
    return
  }
  dialogVisible.value = false
  ElMessage.success(isEdit ? '已更新' : '已添加')
  logger.info(`[YSPanel] save success: ${isEdit ? 'updated' : 'added'} name="${name}" total=${store.yspChannels.length}`)
}

async function removeChannel(idx: number) {
  const ch = store.yspChannels[idx]
  if (!ch) {
    logger.warn(`[YSPanel] remove: invalid index ${idx}`)
    return
  }
  try {
    await ElMessageBox.confirm(`确定删除「${ch.name}」？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    logger.debug(`[YSPanel] remove cancelled for "${ch.name}"`)
    return
  }
  store.yspChannels.splice(idx, 1)
  const success = await store.saveYspChannels()
  if (!success) {
    logger.error(`[YSPanel] remove: write failed for "${ch.name}"`)
    ElMessage.error('写入文件失败')
    return
  }
  ElMessage.success('已删除')
  logger.info(`[YSPanel] removed channel idx=${idx} name="${ch.name}" remaining=${store.yspChannels.length}`)
}

function playChannel(ch: { name: string; url: string }) {
  if (!ch.url) {
    logger.warn(`[YSPanel] playChannel: empty URL for "${ch.name}"`)
    ElMessage.warning('频道地址为空')
    return
  }
  logger.info(`[YSPanel] playChannel: opening webview name="${ch.name}" url="${ch.url.substring(0, 80)}"`)
  // 清除其他播放模式的状态，确保 TitleBar 正确显示"官网直播源"标签
  store.currentChannel = null as any
  store.currentLocalVideo = null as any
  store.externalPlayInfo = null
  store.activeLocalLiveChannelIndex = -1
  store.activePlayMode = null as any
  store.yspWebviewUrl = ch.url
  store.yspWebviewTitle = ch.name
}

async function openFileLocation() {
  const api = (window as any).electronAPI
  if (!api?.openYspChannelsFile) {
    logger.warn('[YSPanel] openFileLocation: electronAPI not available')
    ElMessage.warning('仅 Electron 环境支持')
    return
  }
  try {
    const ok = await api.openYspChannelsFile()
    logger.info(`[YSPanel] openFileLocation: result=${ok}`)
  } catch (e: any) {
    logger.error(`[YSPanel] openFileLocation error: ${e?.message || e}`)
    ElMessage.error('打开失败')
  }
}
</script>

<style scoped>
.ysp-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1a1a2e;
  border-left: 1px solid #2a2a3e;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
}

.panel-title {
  font-size: 15px;
  font-weight: 600;
  color: #e0e0e0;
  margin: 0;
}

.channel-count {
  font-size: 12px;
  color: #888;
}

.close-btn {
  margin-left: auto;
  color: #999;
}

.toolbar {
  display: flex;
  gap: 8px;
  padding: 0 14px 10px;
}

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px;
}

.channel-list::-webkit-scrollbar {
  width: 4px;
}
.channel-list::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 2px;
}

.channel-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}
.channel-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.channel-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.channel-name {
  font-size: 13px;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-url {
  font-size: 11px;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.channel-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.empty-state {
  text-align: center;
  color: #666;
  font-size: 13px;
  padding: 40px 16px;
}
</style>