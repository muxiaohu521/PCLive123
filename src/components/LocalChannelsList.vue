<template>
  <div class="local-channels-panel">
    <div class="panel-header">
      <div class="header-left">
        <h3 class="panel-title">本地直播源</h3>
        <span class="panel-count">{{ totalCount }} 个频道</span>
      </div>
      <div class="header-actions">
        <el-button link @click="$emit('close')" class="close-btn">
          <el-icon><Close /></el-icon>
        </el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-button :icon="Plus" size="small" type="primary" @click="onAddChannel">添加频道</el-button>
    </div>

    <div class="panel-body">
      <div
        v-for="(ch, idx) in store.localChannelsData.lives"
        :key="idx"
        class="channel-item"
        :class="{ active: idx === store.activeLocalLiveChannelIndex }"
        @click="onSelectChannel(idx)"
      >
        <span class="ch-name">{{ ch.name }}</span>
        <span class="ch-url">{{ ch.urls?.[0] || '' }}</span>
        <div class="ch-btns">
          <el-button link :icon="Edit" size="small" title="编辑" @click.stop="onEditChannel(idx)" />
          <el-button link :icon="Delete" size="small" title="删除" @click.stop="onDeleteChannel(idx)" />
        </div>
      </div>
      <div v-if="store.localChannelsData.lives.length === 0" class="empty-hint">暂无频道，点击上方按钮添加</div>
    </div>

    <div class="panel-footer">
      <span class="hint-text">K 切换 | ↑↓ 切换频道</span>
    </div>

    <!-- 添加/编辑频道弹窗 -->
    <el-dialog
      v-model="showChannelDialog"
      :title="editingChannelIdx >= 0 ? '编辑频道' : '添加频道'"
      width="420px"
      :close-on-click-modal="false"
      :modal="false"
      :append-to-body="false"
      draggable
      class="channel-edit-dialog"
    >
      <el-form label-width="60px" @submit.prevent="onSaveChannel">
        <el-form-item label="名称">
          <el-input v-model="channelForm.name" placeholder="频道名称" />
        </el-form-item>
        <el-form-item label="线路">
          <div class="url-lines">
            <div
              v-for="(line, li) in channelForm.urlLines"
              :key="li"
              class="url-line-row"
            >
              <span class="url-line-index">{{ li + 1 }}</span>
              <el-input
                v-model="channelForm.urlLines[li]"
                placeholder="输入URL地址"
                size="small"
                class="url-line-input"
              />
              <el-button
                link
                :icon="Delete"
                size="small"
                class="url-line-del"
                title="删除此线路"
                @click="onRemoveUrlLine(li)"
              />
            </div>
          </div>
          <el-button size="small" :icon="Plus" class="url-line-add" @click="onAddUrlLine">
            添加线路
          </el-button>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showChannelDialog = false">取消</el-button>
        <el-button type="primary" @click="onSaveChannel">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { Edit, Delete, Plus, Close } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'

defineEmits<{
  close: []
}>()

const store = useAppStore()
const showChannelDialog = ref(false)
const editingChannelIdx = ref(-1)
const channelForm = reactive({ name: '', urlLines: [''] as string[] })

const totalCount = computed(() => store.localChannelsData.lives.length)

function onSelectChannel(idx: number) {
  store.selectLocalLiveChannel(idx)
}

function onAddChannel() {
  editingChannelIdx.value = -1
  channelForm.name = ''
  channelForm.urlLines = ['']
  showChannelDialog.value = true
}

function onEditChannel(idx: number) {
  const ch = store.localChannelsData.lives[idx]
  if (!ch) return
  editingChannelIdx.value = idx
  channelForm.name = ch.name
  channelForm.urlLines = ch.urls.length > 0 ? [...ch.urls] : ['']
  showChannelDialog.value = true
}

function onAddUrlLine() {
  channelForm.urlLines.push('')
}

function onRemoveUrlLine(li: number) {
  if (channelForm.urlLines.length <= 1) {
    channelForm.urlLines[0] = ''
    return
  }
  channelForm.urlLines.splice(li, 1)
}

async function onSaveChannel() {
  if (!channelForm.name) return

  const urls = channelForm.urlLines
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0)

  if (urls.length === 0) return

  if (editingChannelIdx.value >= 0) {
    const ch = store.localChannelsData.lives[editingChannelIdx.value]
    if (ch) {
      ch.name = channelForm.name
      ch.urls = urls
    }
  } else {
    store.localChannelsData.lives.push({ name: channelForm.name, urls })
  }

  await store.saveLocalChannels()
  ElMessage.success(editingChannelIdx.value >= 0 ? '频道已更新' : '频道已添加')
}

async function onDeleteChannel(idx: number) {
  const ch = store.localChannelsData.lives[idx]
  if (!ch) return
  store.localChannelsData.lives.splice(idx, 1)
  await store.saveLocalChannels()
  ElMessage.success(`已删除频道 "${ch.name}"`)
}
</script>

<style scoped>
.local-channels-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1a1a2e;
  border-left: 1px solid #2a2a3e;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 10px;
}

.header-left {
  display: flex;
  align-items: baseline;
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
  color: #999;
}

.toolbar {
  padding: 0 14px 10px;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px;
}

.panel-body::-webkit-scrollbar {
  width: 4px;
}

.panel-body::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 2px;
}

.channel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.channel-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.channel-item.active {
  background: rgba(64, 158, 255, 0.12);
}

.ch-name {
  font-size: 11px;
  color: #aaa;
  min-width: 72px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ch-url {
  flex: 1;
  font-size: 10px;
  color: #555;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ch-btns {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.empty-hint {
  text-align: center;
  color: #555;
  font-size: 12px;
  padding: 40px 0;
}

.panel-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 14px;
  border-top: 1px solid #2a2a3e;
  background: #16162a;
}

.hint-text {
  font-size: 10px;
  color: #555;
}

.url-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  max-height: 280px;
  overflow-y: auto;
  padding-right: 4px;
}

.url-lines::-webkit-scrollbar {
  width: 4px;
}

.url-lines::-webkit-scrollbar-thumb {
  background: #444;
  border-radius: 2px;
}

.url-lines::-webkit-scrollbar-track {
  background: transparent;
}

.url-line-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.url-line-index {
  font-size: 11px;
  color: #666;
  min-width: 20px;
  text-align: right;
  flex-shrink: 0;
}

.url-line-input {
  flex: 1;
}

.url-line-del {
  color: #999;
  flex-shrink: 0;
}

.url-line-del:hover {
  color: #f56c6c;
}

.url-line-add {
  margin-top: 8px;
  width: 100%;
}
</style>

<style>
.channel-edit-dialog {
  background: #0a0a0a !important;
  border: 1px solid #2a2a2a !important;
  border-radius: 6px;
  --el-dialog-bg-color: #0a0a0a;
}

.channel-edit-dialog .el-dialog__header {
  background: #0a0a0a;
  border-bottom: 1px solid #2a2a2a;
  padding: 12px 16px;
  margin-right: 0;
}

.channel-edit-dialog .el-dialog__title {
  color: #d0d0d0;
  font-size: 14px;
}

.channel-edit-dialog .el-dialog__body {
  background: #0a0a0a;
  padding: 16px 20px;
  max-height: 420px;
  overflow-y: auto;
}

.channel-edit-dialog .el-dialog__footer {
  background: #0a0a0a;
  border-top: 1px solid #2a2a2a;
  padding: 10px 20px;
}

.channel-edit-dialog .el-dialog__headerbtn .el-dialog__close {
  color: #777;
}

.channel-edit-dialog .el-dialog__headerbtn .el-dialog__close:hover {
  color: #bbb;
}

.channel-edit-dialog .el-form-item__label {
  color: #999;
}

.channel-edit-dialog .el-input__wrapper {
  background: #1a1a1a;
  border-color: #333;
  box-shadow: none;
}

.channel-edit-dialog .el-input__wrapper:hover {
  border-color: #555;
}

.channel-edit-dialog .el-input__wrapper.is-focus,
.channel-edit-dialog .el-input__wrapper:focus-within {
  border-color: #409eff;
  box-shadow: 0 0 0 1px #409eff inset;
}

.channel-edit-dialog .el-input__inner {
  color: #c0c0c0;
}

.channel-edit-dialog .el-input__inner::placeholder {
  color: #555;
}

.channel-edit-dialog .el-button--default {
  background: #1e1e1e;
  border-color: #333;
  color: #bbb;
}

.channel-edit-dialog .el-button--default:hover {
  background: #2a2a2a;
  border-color: #555;
}

.channel-edit-dialog .el-button--primary {
  background: #409eff;
  border-color: #409eff;
}

.channel-edit-dialog .el-dialog__headerbtn {
  top: 12px;
}

.channel-edit-dialog .el-overlay-dialog {
  background: transparent !important;
}

.channel-edit-dialog .el-overlay {
  background: transparent !important;
}

.channel-edit-dialog .el-form {
  background: #0a0a0a;
}

.channel-edit-dialog .el-form-item {
  background: #0a0a0a;
}

.channel-edit-dialog .el-textarea__inner {
  background: #1a1a1a;
  border-color: #333;
  color: #c0c0c0;
}
</style>