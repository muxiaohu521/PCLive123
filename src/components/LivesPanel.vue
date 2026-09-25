<template>
  <div class="lives-panel">
    <div class="panel-header">
      <div class="header-left">
        <h3 class="panel-title">子线路列表</h3>
        <span class="panel-count">{{ livesCount }} 条线路</span>
      </div>
      <el-button link :icon="'Close'" @click="$emit('close')" class="close-btn" />
    </div>

    <div class="panel-body">
      <div class="lives-list" v-if="store.livesGroups.length > 0">
        <div
          v-for="(live, index) in store.livesGroups"
          :key="'live-' + index"
          class="lives-card"
          :class="{
            active: index === store.currentLivesIndex,
            unsupported: live.type !== '0'
          }"
          @click="onSelect(index)"
        >
          <div class="lives-card-left">
            <span class="lives-num">{{ index + 1 }}</span>
            <div class="lives-info">
              <span class="lives-name">{{ live.name }}</span>
              <span class="lives-url" :title="live.url">{{ live.url }}</span>
            </div>
          </div>
          <div class="lives-card-right">
            <el-tag
              v-if="index === store.currentLivesIndex"
              type="success"
              size="small"
              effect="dark"
            >
              当前
            </el-tag>
            <el-tag
              v-else-if="live.type !== '0'"
              type="info"
              size="small"
            >
              暂不支持
            </el-tag>
            <el-tag
              v-else
              type="primary"
              size="small"
              effect="plain"
            >
              直播
            </el-tag>
          </div>
        </div>
      </div>

      <div class="empty-state" v-else>
        <span class="empty-icon">📡</span>
        <span class="empty-text">当前直播源无子线路</span>
        <span class="empty-hint">仅有主线路可用</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/store'

defineEmits<{
  close: []
}>()

const store = useAppStore()

const livesCount = computed(() => store.livesGroups.length)

function onSelect(index: number) {
  if (store.livesGroups[index].type !== '0') return
  if (index === store.currentLivesIndex) return
  store.selectLives(index)
}
</script>

<style scoped>
.lives-panel {
  width: 360px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #1a1a2e;
  border-left: 1px solid #2a2a3e;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #16162a;
  border-bottom: 1px solid #2a2a3e;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.panel-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #e0e0e0;
}

.panel-count {
  font-size: 12px;
  color: #888;
}

.close-btn {
  color: #999 !important;
  font-size: 18px;
  padding: 4px;
}

.close-btn:hover {
  color: #e57373 !important;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.lives-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lives-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: #21213a;
  border-radius: 8px;
  border: 1px solid #2a2a3e;
  cursor: pointer;
  transition: all 0.2s;
}

.lives-card:hover {
  background: #282848;
  border-color: #3a3a5e;
  transform: translateX(2px);
}

.lives-card.active {
  background: #1a3a2a;
  border-color: #4caf50;
  box-shadow: 0 0 12px rgba(76, 175, 80, 0.15);
}

.lives-card.unsupported {
  opacity: 0.5;
  cursor: not-allowed;
}

.lives-card.unsupported:hover {
  background: #21213a;
  border-color: #2a2a3e;
  transform: none;
}

.lives-card-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.lives-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: #2a2a3e;
  color: #aaa;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.lives-card.active .lives-num {
  background: #4caf50;
  color: #fff;
}

.lives-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lives-name {
  font-size: 14px;
  font-weight: 500;
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lives-url {
  font-size: 11px;
  color: #777;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lives-card-right {
  flex-shrink: 0;
  margin-left: 12px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  gap: 8px;
}

.empty-icon {
  font-size: 40px;
  opacity: 0.4;
}

.empty-text {
  font-size: 14px;
  color: #888;
}

.empty-hint {
  font-size: 12px;
  color: #666;
}
</style>