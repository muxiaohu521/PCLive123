<template>
  <div v-if="!store.connectivityTesting && !testFinished" class="mode-select">
    <div class="mode-label">选择测试模式</div>
    <el-radio-group v-model="testMode" class="mode-radio-group">
      <el-radio value="all" class="mode-radio">
        <span class="mode-title">全部测试</span>
        <span class="mode-desc">重新解析全部 {{ store.sourceList.length }} 个直播源，覆盖已有缓存</span>
      </el-radio>
      <el-radio value="unparsed" class="mode-radio">
        <span class="mode-title">仅未解析</span>
        <span class="mode-desc">仅解析未解析或解析失败的直播源，跳过已有数据的源</span>
      </el-radio>
    </el-radio-group>
    <el-button type="primary" class="start-btn" @click="startTest">
      &#x2699; 开始测试
    </el-button>
  </div>

  <template v-if="store.connectivityTesting || testFinished">
    <div class="test-summary" v-if="store.connectivityProgress.total > 0">
      <div class="summary-row">
        <span class="summary-label">模式</span>
        <span class="summary-value">{{ store.connectivityMode === 'all' ? '全部测试' : '仅未解析' }}</span>
      </div>
      <div class="summary-row">
        <span class="summary-label">进度</span>
        <span class="summary-value">{{ store.connectivityProgress.current }} / {{ store.connectivityProgress.total }}</span>
      </div>
      <div class="summary-row" v-if="store.connectivityProgress.currentName">
        <span class="summary-label">当前</span>
        <span class="summary-value current-name">{{ store.connectivityProgress.currentName }}</span>
      </div>
      <el-progress
        :percentage="Math.round((store.connectivityProgress.current / store.connectivityProgress.total) * 100)"
        :status="store.connectivityTesting ? '' : 'success'"
        :stroke-width="8"
        style="margin-top: 10px"
      />
    </div>

    <div class="source-log-list">
      <div
        v-for="(item, idx) in testLog"
        :key="idx"
        class="log-item"
        :class="'status-' + item.status"
      >
        <span class="log-status-icon">
          <template v-if="item.status === 'testing'">&#x23F3;</template>
          <template v-else-if="item.status === 'success'">&#x2705;</template>
          <template v-else-if="item.status === 'fail'">&#x274C;</template>
          <template v-else>&#x23EC;</template>
        </span>
        <span class="log-name">{{ item.name }}</span>
        <span class="log-count" v-if="item.status === 'success'">{{ item.count }} 个频道</span>
        <span class="log-count fail-text" v-else-if="item.status === 'fail'">不可达</span>
        <span class="log-count pending-text" v-else-if="item.status === 'pending'">等待中</span>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAppStore } from '@/store'
import { showBar } from '../shared/useToolShell'
import type { ConnectivityLogItem } from '../types'

const store = useAppStore()

const testFinished = ref(false)
const testMode = ref<'all' | 'unparsed'>('unparsed')

const testLog = ref<ConnectivityLogItem[]>([])

function buildLog() {
  const stats = store.sourceStats
  testLog.value = store.sourceList.map(s => {
    const stat = stats.get(s.url)
    if (!stat) return { name: s.name, count: 0, status: 'pending' as const }
    if (stat.channelCount > 0) return { name: s.name, count: stat.channelCount, status: 'success' as const }
    if (stat.parsedAt > 0) return { name: s.name, count: 0, status: 'fail' as const }
    return { name: s.name, count: 0, status: 'pending' as const }
  })
}

watch(() => store.connectivityTesting, (val) => {
  if (val) {
    testFinished.value = false
    showBar.value = true
  } else if (testLog.value.length > 0) {
    testFinished.value = true
  }
})

watch(() => store.connectivityProgress.current, () => {
  if (store.connectivityTesting) buildLog()
})

function startTest() {
  buildLog()
  store.runConnectivityTest(testMode.value)
}
</script>

<style scoped>
.mode-select {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.mode-label { font-size: 14px; color: #e0e0e0; font-weight: 600; }

.start-btn {
  margin-top: 8px;
  align-self: center;
  width: 200px;
}

.test-summary {
  margin-bottom: 16px;
  padding: 12px;
  background: #1e1e2e;
  border-radius: 8px;
}

.summary-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.summary-label { color: #888; font-size: 13px; }
.summary-value { color: #ffa726; font-weight: 600; font-size: 14px; }

.current-name {
  color: #4fc3f7;
  font-size: 12px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-log-list {
  max-height: 340px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.log-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
}

.log-item.status-testing { background: #1a2a3e; }
.log-item.status-success { background: #1a2e1a; }
.log-item.status-fail { background: #2e1a1a; }
.log-item.status-pending { background: #1a1a2e; }

.log-status-icon { font-size: 14px; width: 20px; text-align: center; }
.log-name { flex: 1; color: #ccc; }
.log-count { color: #4caf50; font-size: 12px; }
.log-count.fail-text { color: #f44336; }
.log-count.pending-text { color: #666; }
</style>