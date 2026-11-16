<template>
  <div class="geoip-panel">
    <p class="geoip-desc">输入 URL / 域名 / IP 地址，查询其服务器的地理位置信息（国家、城市、ISP）</p>

    <div class="geoip-input-row">
      <textarea
        v-model="geoInput"
        class="geoip-textarea"
        placeholder="每行一个，支持以下格式：&#10;· 完整URL：http://iptv.example.com/playlist.m3u&#10;· 域名：example.com&#10;· IP地址：8.8.8.8"
        rows="5"
      ></textarea>
    </div>

    <div class="geoip-btn-row">
      <el-button
        size="small"
        class="geoip-load-btn"
        @click="loadSourceUrls"
      >
        📋 加载直播源URL
      </el-button>
      <el-button
        type="primary"
        size="small"
        class="geoip-query-btn"
        :loading="geoQuerying"
        :disabled="!geoInput.trim()"
        @click="doGeoQuery"
      >
        🌍 开始查询
      </el-button>
      <el-button
        v-if="geoResults.length > 0"
        size="small"
        class="geoip-clear-btn"
        @click="clearGeoResults"
      >
        清空
      </el-button>
    </div>

    <div v-if="geoResults.length > 0" class="geoip-results">
      <div class="geoip-hint">查询结果（{{ geoResults.length }} 项）：</div>
      <div
        v-for="(item, idx) in geoResults"
        :key="idx"
        class="geoip-item"
      >
        <div class="geoip-item-left">
          <span class="geoip-host" :title="item.host">{{ item.host }}</span>
          <span v-if="item.label" class="geoip-label">{{ item.label }}</span>
        </div>
        <div class="geoip-item-right">
          <span class="geoip-info" v-if="item.info">
            {{ item.info.country }}
            <span v-if="item.info.city">· {{ item.info.city }}</span>
            <span class="geoip-isp"> | {{ item.info.isp }}</span>
          </span>
          <span class="geoip-info geoip-unknown" v-else-if="item.error">{{ item.error }}</span>
          <span class="geoip-info geoip-pending" v-else>等待查询</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '@/store'
import { getGeoInfo, extractHost, type GeoInfo } from '@/utils/GeoService'
import { registerStopHook } from '../shared/useToolShell'
import type { GeoResultItem } from '../types'

const store = useAppStore()

const geoInput = ref('')
const geoQuerying = ref(false)
const geoResults = ref<GeoResultItem[]>([])

let offStopHook: (() => void) | null = null
onMounted(() => {
  offStopHook = registerStopHook(() => {
    geoQuerying.value = false
  })
})
onBeforeUnmount(() => {
  if (offStopHook) offStopHook()
})

function loadSourceUrls() {
  const urls = store.sourceList.map(s => s.url)
  geoInput.value = urls.join('\n')
}

function parseInputLines(input: string): { host: string; label?: string }[] {
  const lines = input.split(/[\n,;]+/)
  const seen = new Set<string>()
  const items: { host: string; label?: string }[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    const host = extractHost(line)
    if (!host || seen.has(host)) continue
    seen.add(host)

    const label = line !== host ? line : undefined
    items.push({ host, label })
  }

  return items
}

async function doGeoQuery() {
  const input = geoInput.value.trim()
  if (!input || geoQuerying.value) return

  geoQuerying.value = true
  const items = parseInputLines(input)

  geoResults.value = items.map(item => ({
    host: item.host,
    label: item.label,
  }))

  const uniqueHosts = [...new Set(items.map(i => i.host))]
  const hostToInfo = new Map<string, GeoInfo | null>()

  const promises = uniqueHosts.map(async (host) => {
    const info = await getGeoInfo('http://' + host)
    hostToInfo.set(host, info)
  })

  await Promise.allSettled(promises)

  geoResults.value = items.map(item => {
    const info = hostToInfo.get(item.host)
    return {
      host: item.host,
      label: item.label,
      info: info || undefined,
      error: !info ? '查询失败' : undefined,
    }
  })

  geoQuerying.value = false
}

function clearGeoResults() {
  geoInput.value = ''
  geoResults.value = []
}
</script>

<style scoped>
.geoip-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}

.geoip-desc {
  font-size: 13px;
  color: #aaa;
  margin: 0;
}

.geoip-input-row {
  width: 100%;
}

.geoip-textarea {
  width: 100%;
  box-sizing: border-box;
  background: #1a1a2e;
  border: 1px solid #333;
  border-radius: 6px;
  color: #ccc;
  font-size: 13px;
  font-family: 'Consolas', 'Courier New', monospace;
  padding: 10px 12px;
  resize: vertical;
  line-height: 1.6;
  outline: none;
  transition: border-color 0.2s;
}

.geoip-textarea:focus {
  border-color: #4fc3f7;
}

.geoip-textarea::placeholder {
  color: #555;
}

.geoip-btn-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.geoip-load-btn {
  background: #2a2a3e !important;
  border-color: #444 !important;
  color: #aaa !important;
}

.geoip-load-btn:hover {
  background: #333 !important;
  border-color: #4fc3f7 !important;
  color: #ccc !important;
}

.geoip-clear-btn {
  background: transparent !important;
  border-color: #444 !important;
  color: #888 !important;
}

.geoip-clear-btn:hover {
  border-color: #e57373 !important;
  color: #e57373 !important;
}

.geoip-results {
  max-height: 340px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.geoip-hint { font-size: 12px; color: #888; margin-bottom: 4px; }

.geoip-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #1e1e2e;
  border-radius: 6px;
  font-size: 13px;
  gap: 12px;
}

.geoip-item-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
}

.geoip-item-right {
  flex: 1;
  text-align: right;
  min-width: 0;
}

.geoip-host {
  color: #ccc;
  font-weight: 500;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}

.geoip-label {
  color: #888;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.geoip-info { color: #4fc3f7; font-size: 12px; }

.geoip-unknown { color: #e57373; }

.geoip-pending { color: #666; }

.geoip-isp { color: #888; }
</style>