<template>
  <div class="dlna-panel">
    <div class="dlna-header">
      <h3 class="dlna-title">📡 DLNA 投屏</h3>
      <button class="dlna-close" @click="$emit('close')">✕</button>
    </div>

    <div class="dlna-toolbar">
      <button class="dlna-scan-btn" :disabled="scanning" @click="discoverDevices">
        {{ scanning ? '扫描中...' : '🔍 扫描设备' }}
      </button>
    </div>

    <div v-if="error" class="dlna-error">{{ error }}</div>

    <div v-if="devices.length > 0" class="dlna-device-list">
      <div
        v-for="(device, idx) in devices"
        :key="idx"
        class="dlna-device-item"
        :class="{ 'dlna-device-active': activeDeviceIndex === idx }"
      >
        <div class="dlna-device-icon">📺</div>
        <div class="dlna-device-info">
          <div class="dlna-device-name">{{ device.friendlyName || '未知设备' }}</div>
          <div class="dlna-device-detail">
            {{ device.manufacturer || '未知厂商' }}
            <span v-if="device.modelName">· {{ device.modelName }}</span>
          </div>
        </div>
        <div class="dlna-device-actions">
          <button
            class="dlna-cast-btn"
            :disabled="!props.currentUrl"
            @click="castToDevice(idx)"
            :title="activeDeviceIndex === idx ? '正在投屏' : '投屏到此设备'"
          >
            {{ activeDeviceIndex === idx && casting ? '⏳' : activeDeviceIndex === idx ? '⏹' : '▶' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="!scanning && devices.length === 0 && !error" class="dlna-empty">
      <p>未发现 DLNA 设备</p>
      <p class="dlna-hint">确保设备和电脑在同一网络下，点击"扫描设备"</p>
    </div>

    <div v-if="activeDeviceIndex !== null && !casting" class="dlna-controls">
      <div class="dlna-ctrl-label">投屏控制</div>
      <div class="dlna-ctrl-buttons">
        <button class="dlna-ctrl-btn" @click="dlnaStop" title="停止">⏹</button>
        <button class="dlna-ctrl-btn" @click="dlnaPauseToggle" title="暂停/播放">⏯</button>
        <div class="dlna-volume">
          <span class="dlna-vol-label">🔊</span>
          <input type="range" min="0" max="100" :value="dlnaVolume" @input="onVolumeChange" class="dlna-vol-slider" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  currentUrl: string
}>()

const emit = defineEmits<{
  close: []
}>()

const scanning = ref(false)
const devices = ref<DlnaDevice[]>([])
const error = ref('')
const activeDeviceIndex = ref<number | null>(null)
const casting = ref(false)
const dlnaVolume = ref(50)
const paused = ref(false)

async function discoverDevices() {
  if (!window.electronAPI) return
  scanning.value = true
  error.value = ''
  devices.value = []
  try {
    const result = await window.electronAPI.dlnaDiscover()
    if (result.success) {
      devices.value = result.devices || []
      if (devices.value.length === 0) {
        error.value = '未发现任何 DLNA 设备，请确保设备和电脑在同一局域网'
      }
    } else {
      error.value = result.error || '扫描失败'
    }
  } catch (e: any) {
    error.value = e.message || '扫描出错'
  } finally {
    scanning.value = false
  }
}

async function castToDevice(idx: number) {
  if (!window.electronAPI || !props.currentUrl) return

  if (activeDeviceIndex.value === idx) {
    await dlnaStop()
    return
  }

  casting.value = true
  error.value = ''
  try {
    const result = await window.electronAPI.dlnaCast(idx, props.currentUrl)
    if (result.success) {
      activeDeviceIndex.value = idx
      paused.value = false
    } else {
      error.value = result.error || '投屏失败'
    }
  } catch (e: any) {
    error.value = e.message || '投屏出错'
  } finally {
    casting.value = false
  }
}

async function dlnaStop() {
  if (activeDeviceIndex.value === null || !window.electronAPI) return
  try {
    await window.electronAPI.dlnaStop(activeDeviceIndex.value)
    activeDeviceIndex.value = null
    paused.value = false
  } catch (e: any) {
    error.value = e.message || '停止失败'
  }
}

async function dlnaPauseToggle() {
  if (activeDeviceIndex.value === null || !window.electronAPI) return
  try {
    if (paused.value) {
      const result = await window.electronAPI.dlnaCast(activeDeviceIndex.value, props.currentUrl)
      if (result.success) paused.value = false
    } else {
      await window.electronAPI.dlnaPause(activeDeviceIndex.value)
      paused.value = true
    }
  } catch (e: any) {
    error.value = e.message || '操作失败'
  }
}

async function onVolumeChange(e: Event) {
  const vol = parseInt((e.target as HTMLInputElement).value)
  dlnaVolume.value = vol
  if (activeDeviceIndex.value === null || !window.electronAPI) return
  try {
    await window.electronAPI.dlnaSetVolume(activeDeviceIndex.value, vol)
  } catch {}
}
</script>

<style scoped>
.dlna-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 400px;
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

.dlna-connected-badge {
  font-size: 11px; color: #4ade80; background: rgba(74,222,128,0.15); padding: 3px 8px; border-radius: 10px;
}

.dlna-error {
  padding: 10px 18px; color: #f87171; font-size: 12px; background: rgba(248,113,113,0.1); margin: 10px 18px; border-radius: 6px;
}

.dlna-device-list { flex: 1; overflow-y: auto; padding: 8px 18px; }

.dlna-device-item {
  display: flex; align-items: center; gap: 12px; padding: 12px; margin-bottom: 6px;
  background: #12122a; border: 1px solid #2a2a4a; border-radius: 8px; transition: all 0.2s;
}
.dlna-device-item:hover { border-color: #4a4a7a; }
.dlna-device-active { border-color: #2563eb; background: #1a2a4a; }

.dlna-device-icon { font-size: 28px; flex-shrink: 0; }

.dlna-device-info { flex: 1; min-width: 0; }

.dlna-device-name { font-size: 14px; color: #e0e0e0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dlna-device-detail { font-size: 11px; color: #777; margin-top: 2px; }

.dlna-cast-btn {
  background: #2563eb; border: none; color: #fff; font-size: 16px; width: 36px; height: 36px; border-radius: 50%; cursor: pointer;
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
</style>