<template>
  <div v-if="store.showSyncTVPanel" class="sync-tv-root">
    <el-dialog
      :model-value="store.showSyncTVPanel"
      title=""
      width="520px"
      :modal="false"
      :append-to-body="false"
      :close-on-click-modal="false"
      :close-on-press-escape="true"
      :show-close="false"
      destroy-on-close
      draggable
      class="sync-dialog-root"
      @update:model-value="(v: boolean) => store.showSyncTVPanel = v"
    >
      <template #header>
        <div class="dialog-custom-header">
          <span class="dialog-title">📡 同步到TV</span>
          <div class="dialog-header-actions">
            <el-button link size="small" @click="store.showSyncTVPanel = false" class="close-btn" title="关闭">
              &#x2715;
            </el-button>
          </div>
        </div>
      </template>

      <div class="sync-content">
        <!-- 模拟器 / ADB 状态栏 -->
        <div v-if="emulatorStatus.available && (emulatorStatus.natEmulators?.length ?? 0) > 0" class="sync-emulator-bar">
          <span>🖥️ 模拟器{{ emulatorStatus.natEmulators?.length ?? 0 }}个</span>
          <span v-if="emulatorStatus.portForwarded" class="sync-emu-ok">✅ 端口已转发</span>
          <span v-else class="sync-emu-warn">⚠️ 需转发端口</span>
          <el-button v-if="!emulatorStatus.portForwarded" size="small" text @click="setupEmulatorForward">
            自动修复
          </el-button>
        </div>

        <!-- 扫描工具栏 -->
        <div class="sync-toolbar">
          <el-button size="small" :loading="scanning" @click="scanDevices">
            扫描设备
          </el-button>
          <el-checkbox
            v-model="scanExpanded"
            size="small"
            :disabled="scanning"
            title="先探测光猫/路由器，再扫描其所在子网的全部设备"
          >
            全子网扫描
          </el-checkbox>
          <span v-if="devices.length > 0" class="sync-badge">{{ devices.length }}个TVLive</span>
        </div>

        <!-- 手动连接区 -->
        <div class="sync-manual-section">
          <div class="sync-manual-row">
            <span class="sync-manual-label">本机IP：</span>
            <span class="sync-manual-ips">{{ localIps.join(' / ') || '获取中...' }}</span>
          </div>
          <div class="sync-manual-row">
            <span class="sync-manual-label">手动连接：</span>
            <el-input
              v-model="manualIp"
              size="small"
              placeholder="192.168.1.100"
              :disabled="connectingManual"
              @keyup.enter="connectManual"
              class="sync-manual-input"
            />
            <el-button
              size="small"
              :disabled="!manualIp.trim() || connectingManual"
              :loading="connectingManual"
              @click="connectManual"
            >
              连接
            </el-button>
          </div>
          <div class="sync-manual-row">
            <span class="sync-manual-label">ADB路径：</span>
            <span class="sync-adb-path" :class="{ 'sync-adb-override': adbIsOverride }" :title="adbPath || '未设置'">
              {{ adbPathDisplay }}
            </span>
            <el-button size="small" text @click="selectAdb" class="sync-adb-btn">选择</el-button>
            <el-button v-if="adbIsOverride" size="small" text @click="clearAdb" class="sync-adb-clear-btn">✕</el-button>
          </div>
        </div>

        <div v-if="error" class="sync-error">{{ error }}</div>

        <!-- 设备列表 -->
        <div class="sync-device-scroll">
          <div v-if="devices.length > 0" class="sync-section">
            <div class="sync-section-header">
              <span class="sync-section-label">TVLive 设备列表</span>
            </div>
            <div
              v-for="(device, idx) in devices"
              :key="idx"
              class="sync-device-item"
              :class="{ 'sync-device-done': syncedIndices.has(idx) }"
            >
              <div class="sync-device-icon">📺</div>
              <div class="sync-device-info">
                <div class="sync-device-name">
                  {{ device.deviceName }}
                  <span v-if="syncedIndices.has(idx)" class="sync-ok">✅</span>
                </div>
                <div class="sync-device-detail">
                  TVLive {{ device.version || '1.x' }}
                  <span v-if="device.deviceModel">· {{ device.deviceModel }}</span>
                  <span class="sync-ip">{{ device.displayHost || device.host }}</span>
                </div>
              </div>
              <div class="sync-device-actions">
                <el-button
                  size="small"
                  type="success"
                  :loading="syncingIdx === idx"
                  @click="syncToDevice(idx)"
                >
                  {{ syncedIndices.has(idx) ? '重新同步' : '同步' }}
                </el-button>
              </div>
            </div>
          </div>
          <div v-if="!scanning && devices.length === 0 && !error" class="sync-empty">
            <p>未发现TVLive设备</p>
            <p class="sync-empty-hint">确保设备在同一局域网，点击"扫描设备"</p>
          </div>
        </div>

        <!-- 底部信息 -->
        <div class="sync-info-bar">
          <span>{{ store.localChannelsData.lives.length }} 个频道待同步</span>
          <span v-if="syncedIndices.size > 0">已同步 {{ syncedIndices.size }}/{{ devices.length }} 台</span>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/store'
import { ElMessage } from 'element-plus'

const store = useAppStore()

// --- 设备状态 ---
const devices = ref<any[]>([])
const scanning = ref(false)
const error = ref('')
const syncingIdx = ref<number | null>(null)
const syncedIndices = ref(new Set<number>())

// --- 手动连接 ---
const manualIp = ref('')
const connectingManual = ref(false)
const localIps = ref<string[]>([])

// --- ADB ---
const autoAdbPath = ref('')
const manualAdbPath = ref('')
const emulatorStatus = ref<{ available: boolean; portForwarded?: boolean; natEmulators?: any[] }>({ available: false, portForwarded: false, natEmulators: [] })

const adbPathDisplay = computed(() => {
  if (manualAdbPath.value) return manualAdbPath.value
  if (autoAdbPath.value) return autoAdbPath.value
  return '未设置，点击选择'
})
const adbPath = computed(() => manualAdbPath.value || autoAdbPath.value)
const adbIsOverride = computed(() => !!manualAdbPath.value)

// --- 本机IP ---
async function getLocalIps() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1GetLocalIps()
    if (result.success && result.ips) {
      localIps.value = result.ips
    }
  } catch { /* 静默 */ }
}

async function getAdbPathFromMain() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1GetAdbPath()
    if (result.success && result.path) {
      autoAdbPath.value = result.path
      if (result.isOverride) manualAdbPath.value = result.path
    }
  } catch { /* 静默 */ }
}

// --- ADB ---
async function selectAdb() {
  if (!window.electronAPI) return
  error.value = ''
  try {
    const result = await window.electronAPI.tlv1SelectAdb()
    if (result.success) {
      manualAdbPath.value = result.path
      autoAdbPath.value = result.path
    } else if (result.error) {
      error.value = result.error
    }
  } catch (e: any) {
    error.value = e.message || '选择失败'
  }
}

async function clearAdb() {
  if (!window.electronAPI) return
  manualAdbPath.value = ''
  autoAdbPath.value = ''
  try { await window.electronAPI.tlv1SetAdbPath(null) } catch { /* 静默 */ }
}

async function checkEmulatorStatus() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1EmulatorStatus()
    if (result.success && result.available) {
      emulatorStatus.value = result
    }
  } catch { /* 静默 */ }
}

async function setupEmulatorForward() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1EmulatorForward()
    if (result.success && result.setup) {
      emulatorStatus.value.portForwarded = true
      ElMessage.success('端口转发已设置')
    }
  } catch { /* 静默 */ }
}

// --- 扫描 ---
const scanExpanded = ref(false)

async function scanDevices() {
  if (!window.electronAPI) return
  scanning.value = true
  error.value = ''
  try {
    await Promise.all([discoverDevices(), checkEmulatorStatus()])
  } finally {
    scanning.value = false
  }
}

async function discoverDevices() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1Discover({ expanded: scanExpanded.value })
    if (result.success) {
      devices.value = result.devices || []
      syncedIndices.value = new Set()
      if (devices.value.length === 0) {
        error.value = '未发现TVLive设备'
      }
    } else if (result.error) {
      error.value = '扫描失败: ' + result.error
    }
  } catch (e: any) {
    error.value = '扫描出错: ' + (e.message || '')
  }
}

// --- 手动连接 ---
async function connectManual() {
  const ip = manualIp.value.trim()
  if (!ip || !window.electronAPI) return
  connectingManual.value = true
  error.value = ''
  try {
    const result = await window.electronAPI.tlv1Connect(ip)
    if (result.success && result.device) {
      const device = result.device
      device.deviceName = (device.deviceName || '设备') + ' (手动)'
      const idx = devices.value.findIndex(d => d.host === device.host || d.displayHost === device.host)
      if (idx >= 0) { devices.value[idx] = device } else { devices.value.unshift(device) }
      syncedIndices.value = new Set()
      manualIp.value = ''
      ElMessage.success('已连接: ' + device.deviceName)
    } else {
      error.value = result.error || '连接失败'
    }
  } catch (e: any) {
    error.value = '连接失败: ' + (e.message || '')
  } finally {
    connectingManual.value = false
  }
}

// --- 同步 ---
async function syncToDevice(idx: number) {
  if (!window.electronAPI || syncingIdx.value !== null) return
  if (store.localChannelsData.lives.length === 0) { ElMessage.warning('无频道'); return }
  syncingIdx.value = idx
  error.value = ''
  try {
    const plainData = JSON.parse(JSON.stringify(store.localChannelsData))
    const result = await window.electronAPI.tlv1SyncLocalChannels(idx, plainData)
    if (result.success) {
      syncedIndices.value = new Set([...syncedIndices.value, idx])
      ElMessage.success(`已同步 ${result.count || store.localChannelsData.lives.length} 个频道`)
    } else {
      ElMessage.error('同步失败: ' + (result.error || ''))
    }
  } catch (e: any) {
    ElMessage.error('同步失败: ' + (e.message || ''))
  } finally {
    syncingIdx.value = null
  }
}

onMounted(() => { getLocalIps(); getAdbPathFromMain() })
onBeforeUnmount(() => {})
</script>

<style scoped>
.sync-dialog-root :deep(.el-dialog__header) { margin: 0; padding: 0; }
.sync-dialog-root :deep(.el-dialog__body) { padding: 0 20px 14px; }
.dialog-custom-header { display: flex; align-items: center; justify-content: space-between; width: 100%; }
.dialog-title { font-size: 15px; font-weight: 700; color: #fff; }
.close-btn { color: #999; font-size: 16px; }
.close-btn:hover { color: #fff; }

.sync-content { display: flex; flex-direction: column; gap: 10px; }

/* 模拟器/ADB 状态栏 */
.sync-emulator-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 4px; font-size: 12px;
  background: rgba(96,165,250,0.08); border: 1px solid rgba(96,165,250,0.15);
}
.sync-emu-ok { color: #67c23a; }
.sync-emu-warn { color: #e6a23c; }

/* 扫描工具栏 */
.sync-toolbar { display: flex; align-items: center; gap: 10px; }
.sync-badge { font-size: 12px; color: #67c23a; background: rgba(103,194,58,0.1); padding: 2px 8px; border-radius: 10px; }

/* 手动连接区 */
.sync-manual-section {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.06);
}
.sync-manual-row { display: flex; align-items: center; gap: 8px; }
.sync-manual-label { font-size: 12px; color: #909399; white-space: nowrap; }
.sync-manual-ips { font-size: 11px; color: #409eff; }
.sync-manual-input { flex: 1; }
.sync-adb-path { font-size: 11px; color: #909399; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sync-adb-override { color: #e6a23c !important; }
.sync-adb-btn { font-size: 11px !important; color: #409eff !important; }
.sync-adb-clear-btn { font-size: 11px !important; color: #f56c6c !important; }

.sync-error { padding: 6px 10px; background: rgba(245,108,108,0.12); border-radius: 4px; color: #f56c6c; font-size: 12px; }

/* 设备列表 */
.sync-device-scroll { max-height: 240px; overflow-y: auto; }
.sync-section-header { padding: 4px 0 6px; }
.sync-section-label { font-size: 12px; color: #909399; font-weight: 600; }

.sync-device-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 6px; margin-bottom: 4px;
  background: rgba(255,255,255,0.03); transition: background 0.15s;
}
.sync-device-item:hover { background: rgba(255,255,255,0.06); }
.sync-device-done { border: 1px solid rgba(103,194,58,0.35); }
.sync-device-icon { font-size: 18px; flex-shrink: 0; }

.sync-device-info { flex: 1; min-width: 0; }
.sync-device-name { font-size: 13px; color: #e0e0e0; font-weight: 600; }
.sync-ok { font-size: 11px; margin-left: 4px; }
.sync-device-detail { font-size: 11px; color: #909399; margin-top: 1px; }
.sync-ip { color: #409eff; }

.sync-device-actions { flex-shrink: 0; }

.sync-empty { text-align: center; padding: 20px; }
.sync-empty p { margin: 2px 0; font-size: 13px; color: #909399; }
.sync-empty-hint { font-size: 11px !important; color: #606266 !important; }

/* 底部信息 */
.sync-info-bar {
  display: flex; align-items: center; justify-content: space-between;
  padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);
  font-size: 12px; color: #909399;
}
</style>