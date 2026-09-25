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

    <div class="search-bar">
      <el-input
        v-model="searchText"
        placeholder="搜索频道..."
        clearable
        size="small"
      />
    </div>

    <div class="panel-body">
      <div
        v-for="(ch, idx) in displayList"
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
      <div v-if="displayList.length === 0" class="empty-hint">暂无频道，点击下方按钮添加</div>
    </div>

    <div class="panel-footer">
      <span class="hint-text">K 切换 | ↑↓ 切换频道</span>
      <el-button :icon="Plus" size="small" type="primary" @click="onAddChannel">添加频道</el-button>
    </div>

    <!-- 添加/编辑频道弹窗 -->
    <el-dialog
      v-model="showChannelDialog"
      :title="editingChannelIdx >= 0 ? '编辑频道' : '添加频道'"
      width="500px"
      :close-on-click-modal="false"
    >
      <el-form label-width="60px" @submit.prevent="onSaveChannel">
        <el-form-item label="名称">
          <el-input v-model="channelForm.name" placeholder="频道名称" />
        </el-form-item>
        <el-form-item label="地址">
          <el-input
            v-model="channelForm.urls"
            type="textarea"
            :rows="3"
            placeholder="支持多个URL地址，每行一个"
          />
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
const searchText = ref('')
const showChannelDialog = ref(false)
const editingChannelIdx = ref(-1)
const channelForm = reactive({ name: '', urls: '' })

const totalCount = computed(() => store.localChannelsData.lives.length)

const displayList = computed(() => {
  const kw = searchText.value.trim().toLowerCase()
  if (!kw) return store.localChannelsData.lives
  return store.localChannelsData.lives.filter(ch => ch.name.toLowerCase().includes(kw))
})

function onSelectChannel(idx: number) {
  store.selectLocalLiveChannel(idx)
}

function onAddChannel() {
  editingChannelIdx.value = -1
  channelForm.name = ''
  channelForm.urls = ''
  showChannelDialog.value = true
}

function onEditChannel(idx: number) {
  const ch = store.localChannelsData.lives[idx]
  if (!ch) return
  editingChannelIdx.value = idx
  channelForm.name = ch.name
  channelForm.urls = ch.urls.join('\n')
  showChannelDialog.value = true
}

async function onSaveChannel() {
  if (!channelForm.name || !channelForm.urls.trim()) return

  const urls = channelForm.urls
    .split('\n')
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
  showChannelDialog.value = false
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

.search-bar {
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
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid #2a2a3e;
  background: #16162a;
}

.hint-text {
  font-size: 10px;
  color: #555;
}
</style>