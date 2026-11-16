<template>
  <div v-if="store.showToolsDialog || showBar" class="tools-root">
    <TaskStatusBar v-if="showBar && !store.showToolsDialog" />

    <el-dialog
      :model-value="store.showToolsDialog"
      title=""
      width="560px"
      :modal="false"
      :append-to-body="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
      destroy-on-close
      draggable
      class="tools-dialog-root"
      @closed="onClosed"
      @update:model-value="(v: boolean) => store.showToolsDialog = v"
    >
      <template #header>
        <div class="dialog-custom-header">
          <div class="dialog-header-actions">
            <el-button link size="small" @click="minimize" class="minimize-btn" title="最小化">
              &#x2500;
            </el-button>
            <el-button link size="small" @click="closeDialog" class="close-btn" title="关闭">
              &#x2715;
            </el-button>
          </div>
          <div class="header-tabs">
            <span
              v-for="tab in tabs"
              :key="tab.key"
              class="header-tab"
              :class="{ active: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              {{ tab.label }}
            </span>
          </div>
        </div>
      </template>

      <div class="tools-content">
        <KeepAlive>
          <component :is="currentTool" :key="activeTab" />
        </KeepAlive>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/store'
import { ElMessage } from 'element-plus'
import { toolTabs, resolveToolComponent } from '@/tools/registry'
import { useToolShell } from '@/tools/shared/useToolShell'
import { useRecording } from '@/tools/recording/useRecording'
import { useDownload } from '@/tools/download/useDownload'
import TaskStatusBar from '@/components/TaskStatusBar.vue'
import '@/tools/shared/tool-common.css'

const store = useAppStore()

// ============ 外壳状态（跨模块共享，模块级单例） ============
const { showBar, isMinimizing, minimizedAt, activeTab, registerStopHook, killAllTools } = useToolShell()

const { recordState, startRecording } = useRecording()
const {
  activeDownloads,
  currentDownloadUrl,
  downloadUrl,
  startDownload,
} = useDownload()

const tabs = toolTabs

const currentTool = computed(() => resolveToolComponent(activeTab.value))

function minimize() {
  isMinimizing.value = true
  minimizedAt.value = Date.now()
  store.showToolsDialog = false
  showBar.value = true
}

function closeDialog() {
  // 关闭工具箱不再终止下载 / 录屏线程（由各模块内停止按钮统一负责），
  // 仅收尾连通性测试、URL 嗅探等即时性工具。
  killAllTools()
  store.showToolsDialog = false
  // 关闭后工具箱退出最小化状态，状态栏仅保留仍进行中的任务入口
  minimizedAt.value = 0
  showBar.value = activeDownloads.value.length > 0 || recordState.value !== 'idle'
}

function onClosed() {
  isMinimizing.value = false
}

watch(() => store.showToolsDialog, (v) => {
  if (v) {
    showBar.value = true
    isMinimizing.value = false
    // 重新打开工具箱即退出最小化状态
    minimizedAt.value = 0
  }
})

// ============ 播放器「工具」菜单快捷启动 ============
async function quickStartDownload() {
  // 使用当前播放频道的统一直链作为下载地址；不同频道触发并列下载，相同链接由主进程去重跳过
  const url = currentDownloadUrl.value
  if (url) downloadUrl.value = url
  if (!downloadUrl.value.trim()) {
    ElMessage.warning('当前没有可下载的视频流，请先播放网络视频')
    return
  }
  await startDownload()
  showBar.value = true
  if (store.showToolsDialog) minimize()
}

async function quickStartRecord() {
  if (recordState.value !== 'idle') {
    showBar.value = true
    if (store.showToolsDialog) minimize()
    return
  }
  await startRecording()
  if (recordState.value !== 'idle') {
    showBar.value = true
    if (store.showToolsDialog) minimize()
  }
}

watch(() => store.toolQuickStart, (req) => {
  if (!req) return
  if (req.kind === 'download') {
    quickStartDownload()
  } else if (req.kind === 'record') {
    quickStartRecord()
  }
})

// ============ 统一停止钩子（外壳关闭对话框时收尾） ============
let offStopConnectivity: (() => void) | null = null
onMounted(() => {
  offStopConnectivity = registerStopHook(() => {
    if (store.connectivityTesting) store.cancelConnectivityTest()
  })
})
onBeforeUnmount(() => {
  if (offStopConnectivity) offStopConnectivity()
})
</script>

<style scoped>
/* ============ 根容器 ============ */
.tools-root {
  z-index: 1500;
}

/* ============ 对话框头部 ============ */
.dialog-custom-header {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 8px;
}

.header-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  background: #1e1e2e;
  border-radius: 8px;
  padding: 3px;
}

.header-tab {
  padding: 6px 14px;
  font-size: 13px;
  color: #888;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s;
  white-space: nowrap;
  user-select: none;
}

.header-tab:hover {
  color: #ccc;
  background: #2a2a3e;
}

.header-tab.active {
  color: #e0e0e0;
  background: #35355a;
  font-weight: 600;
}

.dialog-header-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
}

.minimize-btn {
  color: #888 !important;
  font-size: 18px !important;
  padding: 2px 8px !important;
}

.minimize-btn:hover { color: #fff !important; }

.close-btn { color: #f44336 !important; font-size: 16px !important; padding: 2px 8px !important; }

.close-btn:hover { color: #ff6b6b !important; }

/* ============ 内容区域 ============ */
.tools-content {
  min-height: 300px;
  max-height: 480px;
  overflow-y: auto;
}
</style>