<template>
  <div class="dlna-panel">
    <div class="dlna-header">
      <h3 class="dlna-title">📡 投屏</h3>
      <button class="dlna-close" @click="$emit('close')">✕</button>
    </div>

    <div class="dlna-toolbar">
      <button class="dlna-scan-btn" :disabled="scanningTvlive || scanningDlna" @click="scanAll">
        {{ scanningTvlive || scanningDlna ? '扫描中...' : '🔍 扫描设备' }}
      </button>
      <el-checkbox
        v-model="scanExpanded"
        size="small"
        :disabled="scanningTvlive || scanningDlna"
        title="先探测光猫/路由器，再扫描其所在子网的全部设备"
      >
        全子网扫描
      </el-checkbox>
      <span v-if="tvliveDevices.length > 0" class="dlna-badge tvlive-badge">{{ tvliveDevices.length }}个TVLive</span>
      <span v-if="dlnaDevices.length > 0" class="dlna-badge dlna-std-badge">{{ dlnaDevices.length }}个DLNA</span>
    </div>

    <div v-if="emulatorStatus.available && (emulatorStatus.natEmulators?.length ?? 0) > 0" class="dlna-emulator-bar">
      <span class="dlna-emulator-icon">🖥️</span>
      <span>模拟器{{ emulatorStatus.natEmulators?.length ?? 0 }}个</span>
      <span v-if="emulatorStatus.portForwarded" class="dlna-emulator-ok">✅ 端口已转发</span>
      <span v-else class="dlna-emulator-warn">⚠️ 需转发端口</span>
      <button v-if="!emulatorStatus.portForwarded" class="dlna-emulator-fix-btn" @click="setupEmulatorForward">自动修复</button>
    </div>

    <div class="dlna-manual-section">
      <div class="dlna-manual-row">
        <span class="dlna-manual-label">本机IP：</span>
        <span class="dlna-manual-ips">{{ localIps.join(' / ') || '获取中...' }}</span>
      </div>
      <div class="dlna-manual-row">
        <span class="dlna-manual-label">手动连接：</span>
        <input
          v-model="manualIp"
          class="dlna-manual-input"
          placeholder="例: 192.168.1.100"
          :disabled="connectingManual"
          @keyup.enter="connectManual"
          title="输入设备IP地址；模拟器NAT地址会自动通过ADB转发连接"
        />
        <button
          class="dlna-manual-btn"
          :disabled="!manualIp.trim() || connectingManual"
          @click="connectManual"
        >
          {{ connectingManual ? '...' : '连接' }}
        </button>
      </div>
      <div class="dlna-manual-row">
        <span class="dlna-manual-label">ADB路径：</span>
        <span class="dlna-adb-path" :class="{ 'dlna-adb-override': adbIsOverride }" :title="adbPath || '未设置ADB路径'">
          {{ adbPathDisplay }}
        </span>
        <button class="dlna-adb-btn" @click="selectAdb" title="手动指定ADB路径">选择</button>
        <button v-if="adbIsOverride" class="dlna-adb-clear-btn" @click="clearAdb" title="清除手动指定路径">✕</button>
      </div>
      <div class="dlna-manual-row">
        <span class="dlna-manual-label">视频格式：</span>
        <select v-model="castFormat" class="dlna-manual-select">
          <option value="auto">自动 (推荐)</option>
          <option value="hls">HLS (兼容性好)</option>
          <option value="mpegts">MPEG-TS (低延迟)</option>
        </select>
        <span class="dlna-manual-label" style="margin-left:12px">清晰度：</span>
        <select v-model="castQuality" class="dlna-manual-select">
          <option value="original">原画</option>
          <option value="1080p">1080p</option>
          <option value="720p">720p</option>
          <option value="480p">480p</option>
          <option value="360p">360p</option>
        </select>
      </div>
    </div>

    <div v-if="error" class="dlna-error">{{ error }}</div>

    <div class="dlna-device-scroll">
      <!-- TVLive 1.1 设备区域 —— 自动连接 -->
      <div v-if="tvliveDevices.length > 0" class="dlna-section">
        <div class="dlna-section-header">
          <span class="dlna-section-icon">⚡</span>
          <span class="dlna-section-label">TVLive 设备（自动连接）</span>
        </div>
        <div
          v-for="(device, idx) in tvliveDevices"
          :key="'tlv-' + idx"
          class="dlna-device-item tvlive-item"
          :class="{ 'dlna-device-active': activeTlvIndex === idx }"
        >
          <div class="dlna-device-icon">📺</div>
          <div class="dlna-device-info">
            <div class="dlna-device-name">{{ device.deviceName }}</div>
            <div class="dlna-device-detail">
              TVLive {{ device.version || '1.1' }}
              <span v-if="device.deviceModel">· {{ device.deviceModel }}</span>
              <span class="tlv-ip">{{ device.displayHost || device.host }}</span>
            </div>
          </div>
          <div class="dlna-device-actions">
            <button
              class="dlna-cast-btn tvlive-cast-btn"
              :disabled="!props.currentUrl"
              @click="castToTVLive(idx)"
              :title="activeTlvIndex === idx ? '点击停止' : '一键投屏'"
            >
              {{ activeTlvIndex === idx && castingTvlive ? '⏳' : activeTlvIndex === idx ? '⏹' : '▶' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 标准 DLNA 设备区域 —— 配对连接 -->
      <div v-if="dlnaDevices.length > 0" class="dlna-section">
        <div class="dlna-section-header">
          <span class="dlna-section-icon">🔗</span>
          <span class="dlna-section-label">其它 DLNA 设备（标准配对）</span>
        </div>
        <div
          v-for="(device, idx) in dlnaDevices"
          :key="'dlna-' + idx"
          class="dlna-device-item"
          :class="{ 'dlna-device-active': activeDlnaIndex === idx }"
        >
          <div class="dlna-device-icon">📺</div>
          <div class="dlna-device-info">
            <div class="dlna-device-name">{{ device.friendlyName || '未知设备' }}</div>
            <div class="dlna-device-detail">
              {{ device.manufacturer || '未知厂商' }}
              <span v-if="device.modelName">· {{ device.modelName }}</span>
              <span class="tlv-ip">{{ device.host }}</span>
            </div>
          </div>
          <div class="dlna-device-actions">
            <button
              class="dlna-cast-btn"
              :disabled="!props.currentUrl"
              @click="castToDLNA(idx)"
              :title="activeDlnaIndex === idx ? '点击停止' : '标准投屏'"
            >
              {{ activeDlnaIndex === idx && castingDlna ? '⏳' : activeDlnaIndex === idx ? '⏹' : '▶' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="!scanningTvlive && !scanningDlna && tvliveDevices.length === 0 && dlnaDevices.length === 0 && !error" class="dlna-empty">
        <p>未发现投屏设备</p>
        <p class="dlna-hint">确保设备在同一局域网下，点击"扫描设备"</p>
      </div>
    </div>

    <!-- 控制栏：仅在 TVLive 设备投屏中显示 -->
    <div v-if="activeTlvIndex !== null && !castingTvlive" class="dlna-controls">
      <div class="dlna-ctrl-label">
        控制 · {{ tvliveDevices[activeTlvIndex]?.deviceName || 'TVLive' }}
      </div>
      <div class="dlna-ctrl-buttons">
        <button class="dlna-ctrl-btn" @click="tlvStop" title="停止投屏">⏹</button>
      </div>
    </div>

    <!-- 控制栏：仅在 DLNA 设备投屏中显示 -->
    <div v-if="activeDlnaIndex !== null && !castingDlna" class="dlna-controls">
      <div class="dlna-ctrl-label">
        控制 · {{ dlnaDevices[activeDlnaIndex]?.friendlyName || 'DLNA设备' }}
      </div>
      <div class="dlna-ctrl-buttons">
        <button class="dlna-ctrl-btn" @click="dlnaStop" title="停止">⏹</button>
        <button class="dlna-ctrl-btn" @click="dlnaPauseToggle" title="暂停/播放">⏯</button>
        <div class="dlna-volume">
          <span class="dlna-vol-label">🔊</span>
          <input type="range" min="0" max="100" :value="dlnaVolume" @input="onVolumeChange" class="dlna-vol-slider" />
        </div>
      </div>
    </div>

    <!-- 日志面板 -->
    <div class="dlna-log-bar" @click="showLogs = !showLogs">
      <span class="dlna-log-toggle">{{ showLogs ? '🔽' : '🔼' }} 日志 ({{ logs.length }})</span>
      <span class="dlna-log-latest" v-if="!showLogs && logs.length > 0">{{ logs[logs.length - 1].msg }}</span>
    </div>
    <div v-if="showLogs" class="dlna-log-panel">
      <div
        v-for="(entry, i) in logs"
        :key="i"
        class="dlna-log-entry"
        :class="'dlna-log-' + entry.level.toLowerCase()"
      >
        <span class="dlna-log-time">{{ entry.time }}</span>
        <span class="dlna-log-level">{{ entry.level }}</span>
        <span class="dlna-log-msg">{{ entry.msg }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useAppStore } from '@/store'

const props = defineProps<{
  currentUrl: string
  currentTime: number
}>()

defineEmits<{
  close: []
}>()

const store = useAppStore()

// --- 日志 ---
const logs = ref<{ level: string; msg: string; time: string; data?: any }[]>([])
const showLogs = ref(false)
let _unsubLog = (() => {})

// --- TVLive 状态 ---
const tvliveDevices = ref<TlvDevice[]>([])
const activeTlvIndex = ref<number | null>(null)
let activeTlvSessionId: string | null = null
let seekSyncTimer: ReturnType<typeof setInterval> | null = null
let seekLastPos = 0
let seekLastTime = 0
let seekRestartPending = false
const castingTvlive = ref(false)
const scanningTvlive = ref(false)
const scanExpanded = ref(false)
const emulatorStatus = ref<{ available: boolean; portForwarded?: boolean; natEmulators?: any[] }>({ available: false, portForwarded: false, natEmulators: [] })

// --- DLNA 状态 ---
const dlnaDevices = ref<DlnaDevice[]>([])
const activeDlnaIndex = ref<number | null>(null)
const castingDlna = ref(false)
const scanningDlna = ref(false)
const dlnaVolume = ref(50)
const paused = ref(false)

// --- 通用 ---
const error = ref('')
const manualIp = ref('')
const connectingManual = ref(false)
const localIps = ref<string[]>([])
const autoAdbPath = ref('')
const manualAdbPath = ref('')
const castFormat = ref<'auto' | 'hls' | 'mpegts'>('auto')
const castQuality = ref<'original' | '1080p' | '720p' | '480p' | '360p'>('original')

const adbPathDisplay = computed(() => {
  if (manualAdbPath.value) return manualAdbPath.value
  if (autoAdbPath.value) return autoAdbPath.value
  return '未设置，点击选择'
})

const adbPath = computed(() => manualAdbPath.value || autoAdbPath.value)
const adbIsOverride = computed(() => !!manualAdbPath.value)

async function getLocalIps() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1GetLocalIps()
    if (result.success && result.ips) {
      localIps.value = result.ips
    }
  } catch { /* 获取本机IP失败不影响主要功能 */ }
}
getLocalIps()

async function selectAdb() {
  if (!window.electronAPI) return
  error.value = ''
  try {
    const result = await window.electronAPI.tlv1SelectAdb()
    if (result.success) {
      manualAdbPath.value = result.path
      autoAdbPath.value = result.path
      error.value = ''
    } else if (result.error) {
      error.value = result.error
    } else {
      // 用户取消了选择对话框，什么都不做
    }
  } catch (e: any) {
    error.value = e.message || '选择失败'
  }
}

async function clearAdb() {
  if (!window.electronAPI) return
  manualAdbPath.value = ''
  autoAdbPath.value = ''
  try {
    await window.electronAPI.tlv1SetAdbPath(null)
  } catch { /* 静默处理 */ }
}

onMounted(() => {
  if (window.electronAPI?.tlv1OnLog) {
    _unsubLog = window.electronAPI.tlv1OnLog((entry) => {
      logs.value.push(entry)
      if (logs.value.length > 200) logs.value.shift()
    })
  }
})

onBeforeUnmount(() => {
  if (_unsubLog) _unsubLog()
  if (seekSyncTimer) { clearInterval(seekSyncTimer); seekSyncTimer = null }
})

// ==================== PC → TV 镜像同步 ====================

let _lastCastUrl = ''
let _pauseSyncing = false

// 频道切换同步：PC 换了频道 → TV 跟着切
watch(() => props.currentUrl, async (newUrl, oldUrl) => {
  if (!window.electronAPI || !newUrl || newUrl === oldUrl || newUrl === _lastCastUrl) return
  if (activeTlvIndex.value === null) return

  _lastCastUrl = newUrl
  const deviceIdx = activeTlvIndex.value

  if (seekSyncTimer) { clearInterval(seekSyncTimer); seekSyncTimer = null }

  try {
    await window.electronAPI.tlv1Stop(deviceIdx, activeTlvSessionId)
  } catch (_) {}

  castingTvlive.value = true
  try {
    const result = await window.electronAPI.tlv1Cast(deviceIdx, newUrl, {
      format: castFormat.value,
      quality: castQuality.value,
      position: props.currentTime,
    })
    if (result.success) {
      activeTlvIndex.value = deviceIdx
      activeTlvSessionId = result.sessionId || null
      seekLastPos = Math.round(props.currentTime)
      seekLastTime = 0
      seekRestartPending = false
      startSeekSyncTimer()
    }
  } catch (e: any) {
    error.value = '频道切换失败: ' + (e.message || '')
  } finally {
    castingTvlive.value = false
  }
})

function startSeekSyncTimer() {
  if (seekSyncTimer) clearInterval(seekSyncTimer)
  seekSyncTimer = setInterval(() => {
    if (!window.electronAPI || activeTlvIndex.value === null || !activeTlvSessionId || seekRestartPending) return

    const now = Date.now() / 1000
    const currentPos = Math.round(props.currentTime)

    if (seekLastTime > 0) {
      const dt = now - seekLastTime
      const dp = currentPos - seekLastPos
      if (Math.abs(dp) > dt * 2 || dp < -1) {
        seekRestartPending = true
        window.electronAPI.tlv1Seek(activeTlvIndex.value!, currentPos, activeTlvSessionId).finally(() => {
          seekRestartPending = false
        })
      }
    }

    seekLastPos = currentPos
    seekLastTime = now
  }, 2000)
}

// 暂停/播放同步：PC 暂停/播放 → TV 跟着暂停/播放
watch(() => store.videoPaused, async (paused) => {
  if (!window.electronAPI || activeTlvIndex.value === null || !activeTlvSessionId) return
  if (_pauseSyncing) return

  _pauseSyncing = true
  try {
    if (paused) {
      await window.electronAPI.tlv1Pause(activeTlvIndex.value, activeTlvSessionId, props.currentTime)
      if (seekSyncTimer) { clearInterval(seekSyncTimer); seekSyncTimer = null }
    } else {
      const result = await window.electronAPI.tlv1Resume(activeTlvIndex.value, activeTlvSessionId)
      if (result.success) {
        activeTlvSessionId = result.sessionId || activeTlvSessionId
        seekLastPos = Math.round(props.currentTime)
        seekLastTime = 0
        seekRestartPending = false
        startSeekSyncTimer()
      } else {
        error.value = '恢复播放失败: ' + (result.error || '')
      }
    }
  } catch (e: any) {
    error.value = '暂停/恢复失败: ' + (e.message || '')
  } finally {
    _pauseSyncing = false
  }
})

async function scanAll() {
  error.value = ''
  await Promise.all([discoverTVLiveDevices(), discoverDLNADevices(), checkEmulatorStatus()])
}

async function connectManual() {
  const ip = manualIp.value.trim()
  if (!ip || !window.electronAPI || !props.currentUrl) return
  connectingManual.value = true
  error.value = ''
  try {
    const result = await window.electronAPI.tlv1Connect(ip)
    if (result.success && result.device) {
      const device = result.device
      device.deviceName = (device.deviceName || '设备') + ' (手动)'
      const existing = tvliveDevices.value.findIndex(d =>
        (d.host === device.host) || (d.displayHost === device.host) || (d.host === device.displayHost)
      )
      if (existing >= 0) {
        activeTlvIndex.value = existing
      } else {
        tvliveDevices.value.unshift(device)
        activeTlvIndex.value = 0
      }
      await castToTVLive(activeTlvIndex.value!)
    } else {
      error.value = result.error || '连接失败：设备无响应'
    }
  } catch (e: any) {
    error.value = e.message || '连接失败'
  } finally {
    connectingManual.value = false
  }
}

// ==================== TVLive 1.1 专用协议 ====================

async function checkEmulatorStatus() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1EmulatorStatus()
    if (result.success && result.available) {
      emulatorStatus.value = result
    }
  } catch {
  }
}

async function setupEmulatorForward() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.tlv1EmulatorForward()
    if (result.success && result.setup) {
      emulatorStatus.value.portForwarded = true
    }
  } catch {
  }
}

async function discoverTVLiveDevices() {
  if (!window.electronAPI) return
  scanningTvlive.value = true
  try {
    const result = await window.electronAPI.tlv1Discover({ expanded: scanExpanded.value })
    if (result.success) {
      tvliveDevices.value = result.devices || []
    } else if (result.error) {
      error.value = 'TVLive扫描: ' + result.error
    }
  } catch (e: any) {
    // 静默处理 — TVLive 扫描失败不影响 DLNA
  } finally {
    scanningTvlive.value = false
  }
}

async function castToTVLive(idx: number) {
  if (!window.electronAPI || !props.currentUrl) return

  if (activeTlvIndex.value === idx) {
    await tlvStop()
    return
  }

  if (activeTlvIndex.value !== null) {
    await tlvStop()
  }

  castingTvlive.value = true
  error.value = ''
  try {
    const result = await window.electronAPI.tlv1Cast(idx, props.currentUrl, {
      format: castFormat.value,
      quality: castQuality.value,
      position: props.currentTime,
    })
    if (result.success) {
      activeTlvIndex.value = idx
      activeDlnaIndex.value = null
      activeTlvSessionId = result.sessionId || null
      _lastCastUrl = props.currentUrl

      seekLastPos = Math.round(props.currentTime)
      seekLastTime = 0
      seekRestartPending = false
      startSeekSyncTimer()
    } else {
      error.value = result.error || '投屏失败'
    }
  } catch (e: any) {
    error.value = e.message || '投屏出错'
  } finally {
    castingTvlive.value = false
  }
}

async function tlvStop() {
  if (activeTlvIndex.value === null || !window.electronAPI) return
  if (seekSyncTimer) { clearInterval(seekSyncTimer); seekSyncTimer = null }
  try {
    await window.electronAPI.tlv1Stop(activeTlvIndex.value, activeTlvSessionId)
    activeTlvIndex.value = null
    activeTlvSessionId = null
  } catch (e: any) {
    error.value = e.message || '停止失败'
  }
}

// ==================== 标准 DLNA 协议 ====================

async function discoverDLNADevices() {
  if (!window.electronAPI) return
  scanningDlna.value = true
  try {
    const result = await window.electronAPI.dlnaDiscover()
    if (result.success) {
      dlnaDevices.value = result.devices || []
    }
  } catch (e: any) {
    // 静默处理
  } finally {
    scanningDlna.value = false
  }
}

async function castToDLNA(idx: number) {
  if (!window.electronAPI || !props.currentUrl) return

  if (activeDlnaIndex.value === idx) {
    await dlnaStop()
    return
  }

  castingDlna.value = true
  error.value = ''
  try {
    const result = await window.electronAPI.dlnaCast(idx, props.currentUrl)
    if (result.success) {
      activeDlnaIndex.value = idx
      activeTlvIndex.value = null
      paused.value = false
    } else {
      error.value = result.error || '投屏失败'
    }
  } catch (e: any) {
    error.value = e.message || '投屏出错'
  } finally {
    castingDlna.value = false
  }
}

async function dlnaStop() {
  if (activeDlnaIndex.value === null || !window.electronAPI) return
  try {
    await window.electronAPI.dlnaStop(activeDlnaIndex.value)
    activeDlnaIndex.value = null
    paused.value = false
  } catch (e: any) {
    error.value = e.message || '停止失败'
  }
}

async function dlnaPauseToggle() {
  if (activeDlnaIndex.value === null || !window.electronAPI) return
  try {
    if (paused.value) {
      const result = await window.electronAPI.dlnaCast(activeDlnaIndex.value, props.currentUrl)
      if (result.success) paused.value = false
    } else {
      await window.electronAPI.dlnaPause(activeDlnaIndex.value)
      paused.value = true
    }
  } catch (e: any) {
    error.value = e.message || '操作失败'
  }
}

async function onVolumeChange(e: Event) {
  const vol = parseInt((e.target as HTMLInputElement).value)
  dlnaVolume.value = vol
  if (activeDlnaIndex.value === null || !window.electronAPI) return
  try {
    await window.electronAPI.dlnaSetVolume(activeDlnaIndex.value, vol)
  } catch {}
}
</script>

<style scoped>
.dlna-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 420px;
  height: 100%;
  background: #1a1a2e;
  border-left: 1px solid #333;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.5);
}

.dlna-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 18px;
  border-bottom: 1px solid #333;
  flex-shrink: 0;
}

.dlna-title { font-size: 16px; font-weight: 600; color: #e0e0e0; margin: 0; }

.dlna-close {
  background: none; border: none; color: #888; font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px;
}
.dlna-close:hover { color: #fff; background: rgba(255,255,255,0.1); }

.dlna-toolbar {
  display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 1px solid #2a2a4a; flex-shrink: 0;
}

.dlna-scan-btn {
  padding: 8px 18px; background: #2563eb; border: none; border-radius: 6px; color: #fff; font-size: 13px; cursor: pointer;
}
.dlna-scan-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.dlna-badge {
  font-size: 11px; padding: 3px 8px; border-radius: 10px; flex-shrink: 0;
}
.tvlive-badge { color: #4ade80; background: rgba(74,222,128,0.15); }
.dlna-std-badge { color: #60a5fa; background: rgba(96,165,250,0.15); }

.dlna-error {
  padding: 10px 18px; color: #f87171; font-size: 12px; background: rgba(248,113,113,0.1); margin: 10px 18px; border-radius: 6px;
}

.dlna-emulator-bar {
  display: flex; align-items: center; gap: 8px; padding: 8px 18px; margin: 4px 18px 8px;
  background: #1a1a35; border-radius: 6px; font-size: 12px; color: #a0a0c0;
}
.dlna-emulator-icon { font-size: 14px; }
.dlna-emulator-ok { color: #4ade80; font-weight: 500; }
.dlna-emulator-warn { color: #fbbf24; font-weight: 500; }
.dlna-emulator-fix-btn {
  margin-left: auto; padding: 3px 10px; border: 1px solid #4ade80; border-radius: 4px;
  background: transparent; color: #4ade80; font-size: 11px; cursor: pointer; transition: all .2s;
}
.dlna-emulator-fix-btn:hover { background: rgba(74,222,128,0.15); }

.dlna-manual-section {
  margin: 4px 18px 8px; padding: 8px 12px; background: #1a1a35; border-radius: 6px; font-size: 12px;
}
.dlna-manual-row {
  display: flex; align-items: center; gap: 6px; padding: 3px 0;
}
.dlna-manual-row + .dlna-manual-row { margin-top: 4px; padding-top: 7px; border-top: 1px solid #2a2a4a; }
.dlna-manual-label { color: #8888aa; white-space: nowrap; }
.dlna-manual-ips { color: #60a5fa; }
.dlna-manual-input {
  flex: 1; padding: 4px 8px; border: 1px solid #3a3a5a; border-radius: 4px;
  background: #0e0e22; color: #e0e0f0; font-size: 12px; outline: none;
}
.dlna-manual-input:focus { border-color: #4ade80; }
.dlna-manual-btn {
  padding: 4px 12px; border: 1px solid #4ade80; border-radius: 4px;
  background: transparent; color: #4ade80; font-size: 12px; cursor: pointer;
  white-space: nowrap; transition: all .2s;
}
.dlna-manual-btn:hover { background: rgba(74,222,128,0.15); }
.dlna-manual-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.dlna-adb-path {
  flex: 1; padding: 4px 8px; border: 1px solid #3a3a5a; border-radius: 4px;
  background: #0e0e22; color: #8888aa; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dlna-adb-override { color: #fbbf24; border-color: #fbbf24; }
.dlna-adb-btn {
  padding: 4px 10px; border: 1px solid #60a5fa; border-radius: 4px;
  background: transparent; color: #60a5fa; font-size: 11px; cursor: pointer;
  white-space: nowrap; transition: all .2s;
}
.dlna-adb-btn:hover { background: rgba(96,165,250,0.15); }
.dlna-adb-clear-btn {
  padding: 4px 8px; border: 1px solid #ef4444; border-radius: 4px;
  background: transparent; color: #ef4444; font-size: 11px; cursor: pointer;
  white-space: nowrap; transition: all .2s; line-height: 1;
}
.dlna-adb-clear-btn:hover { background: rgba(239,68,68,0.15); }

.dlna-manual-select {
  padding: 4px 6px; border: 1px solid #3a3a5a; border-radius: 4px;
  background: #0e0e22; color: #e0e0f0; font-size: 11px; outline: none; cursor: pointer;
  min-width: 100px;
}
.dlna-manual-select:focus { border-color: #4ade80; }
.dlna-manual-select option { background: #1a1a2e; color: #e0e0f0; }

.dlna-device-scroll { flex: 1; overflow-y: auto; padding: 8px 18px; }

.dlna-section { margin-bottom: 12px; }

.dlna-section-header {
  display: flex; align-items: center; gap: 6px; padding: 6px 0 8px 0;
  border-bottom: 1px solid #2a2a4a; margin-bottom: 6px;
}

.dlna-section-icon { font-size: 14px; }
.dlna-section-label { font-size: 12px; color: #888; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }

.dlna-device-item {
  display: flex; align-items: center; gap: 12px; padding: 12px; margin-bottom: 6px;
  background: #12122a; border: 1px solid #2a2a4a; border-radius: 8px; transition: all 0.2s;
}
.dlna-device-item:hover { border-color: #4a4a7a; }
.dlna-device-active { border-color: #2563eb; background: #1a2a4a; }

.tvlive-item { border-color: rgba(74,222,128,0.2); }
.tvlive-item:hover { border-color: rgba(74,222,128,0.4); }

.dlna-device-icon { font-size: 28px; flex-shrink: 0; }

.dlna-device-info { flex: 1; min-width: 0; }

.dlna-device-name { font-size: 14px; color: #e0e0e0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dlna-device-detail { font-size: 11px; color: #777; margin-top: 2px; }

.tlv-ip { font-size: 10px; color: #555; margin-left: 6px; font-family: monospace; }

.tvlive-cast-btn { background: #16a34a; }
.tvlive-cast-btn:hover:not(:disabled) { background: #22c55e; }

.dlna-cast-btn {
  border: none; color: #fff; font-size: 16px; width: 36px; height: 36px; border-radius: 50%; cursor: pointer;
  background: #2563eb;
}
.dlna-cast-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dlna-cast-btn:hover:not(:disabled) { background: #3b82f6; }

.dlna-empty { padding: 40px 18px; text-align: center; color: #666; font-size: 13px; }
.dlna-hint { font-size: 11px; color: #555; margin-top: 8px; }

.dlna-controls {
  padding: 12px 18px; border-top: 1px solid #333; flex-shrink: 0; background: #12122a;
}

.dlna-ctrl-label { font-size: 12px; color: #888; margin-bottom: 8px; }

.dlna-ctrl-buttons { display: flex; align-items: center; gap: 10px; }

.dlna-ctrl-btn {
  width: 38px; height: 38px; background: #2563eb; border: none; border-radius: 8px; color: #fff; font-size: 18px; cursor: pointer;
}
.dlna-ctrl-btn:hover { background: #3b82f6; }

.dlna-volume { display: flex; align-items: center; gap: 6px; flex: 1; }

.dlna-vol-label { font-size: 14px; flex-shrink: 0; }

.dlna-vol-slider {
  flex: 1; height: 4px; -webkit-appearance: none; appearance: none; background: #333; border-radius: 2px; outline: none;
}
.dlna-vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #60a5fa; cursor: pointer;
}

.dlna-log-bar {
  display: flex; align-items: center; gap: 10px; padding: 6px 18px;
  border-top: 1px solid #2a2a4a; background: #0e0e22; cursor: pointer; flex-shrink: 0;
  font-size: 11px; color: #666; user-select: none;
}
.dlna-log-bar:hover { color: #999; }
.dlna-log-toggle { white-space: nowrap; }
.dlna-log-latest { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; color: #555; }

.dlna-log-panel {
  height: 160px; overflow-y: auto; background: #080818; border-top: 1px solid #1a1a35;
  font-family: 'Consolas', 'Courier New', monospace; font-size: 11px; flex-shrink: 0;
}

.dlna-log-entry {
  padding: 2px 18px; white-space: nowrap; border-bottom: 1px solid #0d0d20;
}

.dlna-log-time { color: #555; margin-right: 6px; }
.dlna-log-level { margin-right: 6px; width: 32px; display: inline-block; text-align: center; font-weight: 600; }

.dlna-log-info  .dlna-log-level { color: #60a5fa; }
.dlna-log-debg  .dlna-log-level { color: #666; }
.dlna-log-warn  .dlna-log-level { color: #fbbf24; }
.dlna-log-erro  .dlna-log-level { color: #f87171; }
.dlna-log-info  .dlna-log-msg   { color: #c0c0d0; }
.dlna-log-debg  .dlna-log-msg   { color: #555; }
.dlna-log-warn  .dlna-log-msg   { color: #fbbf24; }
.dlna-log-erro  .dlna-log-msg   { color: #f87171; }

</style>