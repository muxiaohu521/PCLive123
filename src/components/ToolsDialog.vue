<template>
  <div v-if="store.showToolsDialog || showBar" class="tools-root">
    <div v-if="showBar && !store.showToolsDialog" class="minimize-bar" @click="restore">
      <span class="minimize-icon">&#x1F6E0;</span>
      <span class="minimize-text">{{ barText }}</span>
    </div>

    <el-dialog
      :model-value="store.showToolsDialog"
      title=""
      width="560px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
      destroy-on-close
      @closed="onClosed"
      @update:model-value="(v: boolean) => store.showToolsDialog = v"
    >
      <template #header>
        <div class="dialog-custom-header">
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
          <div class="dialog-header-actions">
            <el-button
              v-if="store.connectivityTesting && activeTab === 'connectivity'"
              link
              size="small"
              type="danger"
              class="cancel-btn"
              @click="store.cancelConnectivityTest()"
            >
              取消测试
            </el-button>
            <el-button link size="small" @click="minimize" class="minimize-btn" title="最小化">
              &#x2500;
            </el-button>
            <el-button link size="small" @click="closeDialog" class="close-btn" title="关闭">
              &#x2715;
            </el-button>
          </div>
        </div>
      </template>

      <div class="tools-content">
        <!-- ============ 连通性测试 ============ -->
        <div v-show="activeTab === 'connectivity'" class="tab-panel">
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
        </div>

        <!-- ============ URL嗅探器 ============ -->
        <div v-show="activeTab === 'sniffer'" class="tab-panel">
          <div class="sniffer-input-row">
            <input
              ref="sniffInputRef"
              v-model="sniffInputUrl"
              type="text"
              class="sniffer-input"
              placeholder="粘贴网页URL，自动提取视频流地址..."
              @keydown.enter="startSniff"
            />
            <button
              class="sniffer-btn"
              :disabled="sniffSniffing || !sniffInputUrl.trim()"
              @click="startSniff"
            >
              {{ sniffSniffing ? '嗅探中...' : '开始嗅探' }}
            </button>
          </div>

          <div v-if="sniffError" :class="sniffErrorType === 'hint' ? 'sniff-warn' : 'sniff-error'">{{ sniffError }}</div>

          <div v-if="sniffSniffing" class="sniff-loading">
            <span class="spinner"></span>
            <span>{{ sniffPhase || '正在抓取并分析页面...' }}</span>
            <span v-if="sniffPhase" class="sniff-elapsed">{{ sniffElapsed }}s</span>
          </div>

          <div v-if="sniffResults.length > 0" class="sniff-results">
            <div class="sniff-results-header">
              找到 <strong>{{ sniffResults.length }}</strong> 个视频地址
              <span v-if="sniffTotalFound > sniffResults.length">（共 {{ sniffTotalFound }} 个，仅显示前 {{ sniffResults.length }}）</span>
              <span v-if="sniffPhaseLabel" class="phase-badge">📡 {{ sniffPhaseLabel }}</span>
            </div>

            <div
              v-for="(item, idx) in sniffResults"
              :key="idx"
              class="sniff-result-item"
            >
              <div class="sniff-result-info">
                <span :class="['format-badge', 'format-' + item.format]">{{ item.format.toUpperCase() }}</span>
                <span v-if="item.isLive" class="live-badge">LIVE</span>
                <span class="sniff-result-url" :title="item.sourceUrl">{{ truncateUrl(item.sourceUrl, 60) }}</span>
              </div>
              <div class="sniff-result-actions">
                <button class="action-btn play-btn" @click="sniffPlayUrl(item)" title="播放此地址">&#x25B6; 播放</button>
                <button class="action-btn add-btn" @click="sniffAddChannel(item)" title="添加为频道">+ 频道</button>
              </div>
            </div>
          </div>

          <div v-if="!sniffSniffing && sniffResults.length === 0 && !sniffError" class="sniff-hint">
            <p>支持从网页HTML中自动提取以下格式：</p>
            <div class="format-tags">
              <span class="format-tag">M3U8</span>
              <span class="format-tag">MP4</span>
              <span class="format-tag">FLV</span>
              <span class="format-tag">MPD</span>
              <span class="format-tag">RTMP</span>
              <span class="format-tag">RTSP</span>
              <span class="format-tag">Magnet</span>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue'
import { useAppStore } from '@/store'

const store = useAppStore()

// ============ 对话框状态 ============
const showBar = ref(false)
const isMinimizing = ref(false)

type TabKey = 'connectivity' | 'sniffer'
const activeTab = ref<TabKey>('connectivity')

const tabs = [
  { key: 'connectivity' as TabKey, label: '🔍 连通性测试' },
  { key: 'sniffer' as TabKey, label: '🕵️ URL嗅探器' },
]

const barText = computed(() => {
  const p = store.connectivityProgress
  if (p.total > 0) return `测试中 ${p.current}/${p.total}`
  const tab = tabs.find(t => t.key === activeTab.value)
  return tab ? tab.label.replace(/^[^\s]+\s/, '') : '工具箱'
})

function minimize() {
  isMinimizing.value = true
  store.showToolsDialog = false
  showBar.value = true
}

function restore() {
  isMinimizing.value = false
  store.showToolsDialog = true
}

function closeDialog() {
  store.showToolsDialog = false
  showBar.value = false
}

function onClosed() {
  if (!isMinimizing.value) {
    showBar.value = false
  }
  isMinimizing.value = false
}

watch(() => store.showToolsDialog, (v) => {
  if (v) {
    showBar.value = true
    isMinimizing.value = false
  }
})

// ============ 连通性测试 ============
const testFinished = ref(false)
const testMode = ref<'all' | 'unparsed'>('unparsed')

interface LogItem {
  name: string
  count: number
  status: 'pending' | 'testing' | 'success' | 'fail'
}

const testLog = ref<LogItem[]>([])

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

// ============ URL嗅探器 ============
const sniffInputUrl = ref('')
const sniffSniffing = ref(false)
const sniffPhase = ref('')
const sniffElapsed = ref(0)
const sniffPhaseLabel = ref('')
let sniffTimer: ReturnType<typeof setInterval> | null = null
const sniffResults = ref<SniffResult[]>([])
const sniffTotalFound = ref(0)
const sniffError = ref('')
const sniffErrorType = ref<'error' | 'hint'>('error')
const sniffInputRef = ref<HTMLInputElement | null>(null)

watch(() => activeTab.value, async (v) => {
  if (v === 'sniffer') {
    await nextTick()
    sniffInputRef.value?.focus()
  }
})

function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url
  return url.substring(0, maxLen - 3) + '...'
}

async function startSniff() {
  const url = sniffInputUrl.value.trim()
  if (!url || sniffSniffing.value) return

  if (!/^https?:\/\//i.test(url)) {
    sniffError.value = '请输入有效的 HTTP/HTTPS 链接'
    sniffErrorType.value = 'error'
    return
  }

  sniffSniffing.value = true
  sniffPhase.value = '🔎 快速扫描页面HTML...'
  sniffElapsed.value = 0
  sniffError.value = ''
  sniffErrorType.value = 'error'
  sniffPhaseLabel.value = ''
  sniffResults.value = []

  sniffTimer = setInterval(() => {
    sniffElapsed.value++
    if (sniffElapsed.value > 3 && sniffPhase.value === '🔎 快速扫描页面HTML...') {
      sniffPhase.value = '🕸 深度嗅探中...（已拦截网络请求，可能需要10-15秒）'
    }
  }, 1000)

  try {
    if (window.electronAPI?.sniffUrl) {
      const resp: SniffResponse = await window.electronAPI.sniffUrl(url)
      if (resp.success) {
        sniffResults.value = resp.urls
        sniffTotalFound.value = resp.totalFound || resp.urls.length
        const phase = (resp as any).phase
        if (phase === 'direct') sniffPhaseLabel.value = '直链识别'
        else if (phase === 'quick') sniffPhaseLabel.value = '快速扫描'
        else if (phase === 'quick+deep') sniffPhaseLabel.value = '快速+深度'
        else if (phase === 'deep') sniffPhaseLabel.value = '深度嗅探'
        if (resp.urls.length === 0 && (resp as any).hint) {
          sniffError.value = (resp as any).hint
          sniffErrorType.value = 'hint'
        }
      } else {
        sniffError.value = resp.error || '嗅探失败，请检查URL是否可访问'
        sniffErrorType.value = 'error'
        if (resp.error === 'timeout') {
          sniffError.value = '请求超时，请检查URL是否可访问或网络是否正常'
        }
      }
    } else {
      sniffError.value = '此功能需要 Electron 环境支持'
      sniffErrorType.value = 'error'
    }
  } catch (e: any) {
    sniffError.value = e?.message || '嗅探过程发生错误'
    sniffErrorType.value = 'error'
  } finally {
    sniffSniffing.value = false
    sniffPhase.value = ''
    if (sniffTimer) { clearInterval(sniffTimer); sniffTimer = null }
  }
}

async function sniffPlayUrl(item: SniffResult) {
  let finalUrl = item.sourceUrl || item.url
  let finalFormat = item.format
  let siteMeta = item.siteMeta || null
  const pageUrl = sniffInputUrl.value || ''

  if (!siteMeta && pageUrl) {
    const bvMatch = pageUrl.match(/BV[a-zA-Z0-9]{10}/)
    if (bvMatch) siteMeta = { site: 'bilibili', bvid: bvMatch[0], pageUrl }
    if (/tv\.cctv\.com\/live\//i.test(pageUrl) || /cctv\.com\/live/i.test(pageUrl)) {
      siteMeta = siteMeta || { site: 'cctv', pageUrl }
    }
  }

  if (siteMeta && !siteMeta.pageUrl) siteMeta.pageUrl = pageUrl

  if (siteMeta && siteMeta.site && window.electronAPI?.resolvePlayUrl) {
    const savedSourceUrl = finalUrl
    try {
      const resolved = await window.electronAPI.resolvePlayUrl(siteMeta)
      if (resolved.success && resolved.urls && resolved.urls.length > 0) {
        finalUrl = resolved.urls[0].url
        finalFormat = resolved.urls[0].format || item.format
      }
    } catch (_) {
      finalUrl = savedSourceUrl
    }
  }

  const headers: Record<string, string> = {}
  if (pageUrl) {
    try {
      const pageU = new URL(pageUrl)
      headers['Referer'] = `${pageU.protocol}//${pageU.hostname}/`
      headers['Origin'] = `${pageU.protocol}//${pageU.hostname}`
    } catch (_) {}
  }
  store.playExternalUrl(finalUrl, headers, finalFormat, `嗅探-${finalFormat.toUpperCase()}`)
}

function sniffAddChannel(item: SniffResult) {
  store.pendingSniffUrl = {
    url: item.sourceUrl || item.url,
    format: item.format,
    name: `嗅探-${item.format.toUpperCase()}-${Date.now().toString(36)}`
  }
  store.showChannelList = false
  store.showLivesPanel = false
  store.showLocalVideoList = false
  store.showSourceManager = true
}
</script>

<style scoped>
/* ============ 根容器 ============ */
.tools-root {
  z-index: 1500;
}

/* ============ 最小化条 ============ */
.minimize-bar {
  position: fixed;
  bottom: 12px;
  right: 12px;
  background: #2a2a3e;
  border: 1px solid #4fc3f7;
  border-radius: 8px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  z-index: 2000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}

.minimize-bar:hover { background: #35355a; }
.minimize-icon { font-size: 14px; }
.minimize-text { color: #ccc; font-size: 12px; }

/* ============ 对话框头部 ============ */
.dialog-custom-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}

.header-tabs {
  display: flex;
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

.cancel-btn { color: #ff9800 !important; font-size: 12px !important; padding: 2px 10px !important; }

.cancel-btn:hover { color: #ffb74d !important; }

/* ============ 内容区域 ============ */
.tools-content {
  min-height: 300px;
  max-height: 480px;
  overflow-y: auto;
}

.tab-panel {
  min-height: 280px;
}

/* ============ 连通性测试样式 ============ */
.mode-select {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.mode-label { font-size: 14px; color: #e0e0e0; font-weight: 600; }

.mode-radio-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mode-radio {
  margin-right: 0 !important;
  padding: 12px;
  background: #1e1e2e;
  border-radius: 8px;
  border: 1px solid #2a2a3e;
  width: 100%;
  height: auto !important;
}

.mode-radio.is-checked { border-color: #4fc3f7; }

.mode-title {
  display: block;
  font-size: 14px;
  color: #e0e0e0;
  margin-bottom: 4px;
}

.mode-desc {
  display: block;
  font-size: 12px;
  color: #777;
}

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

/* ============ URL嗅探器样式 ============ */
.sniff-input-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.sniffer-input {
  flex: 1;
  padding: 10px 14px;
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 13px;
  outline: none;
}

.sniffer-input:focus { border-color: #4fc3f7; }
.sniffer-input::placeholder { color: #555; }

.sniffer-btn {
  padding: 10px 20px;
  background: #4fc3f7;
  color: #121212;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.sniffer-btn:hover:not(:disabled) { background: #6dd5ff; }
.sniffer-btn:disabled { background: #333; color: #666; cursor: not-allowed; }

.sniff-error {
  padding: 10px;
  background: #2e1a1a;
  border: 1px solid #f44336;
  border-radius: 6px;
  color: #f44336;
  font-size: 13px;
  margin-bottom: 12px;
}

.sniff-warn {
  padding: 10px;
  background: #2e2a1a;
  border: 1px solid #ffa726;
  border-radius: 6px;
  color: #ffa726;
  font-size: 13px;
  margin-bottom: 12px;
}

.sniff-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px;
  color: #888;
  font-size: 13px;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid #333;
  border-top: 2px solid #4fc3f7;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.sniff-elapsed { color: #666; font-size: 12px; }

.sniff-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sniff-results-header {
  color: #888;
  font-size: 12px;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sniff-results-header strong { color: #4fc3f7; }

.phase-badge {
  font-size: 11px;
  color: #ffa726;
  background: #2e2a1e;
  padding: 1px 8px;
  border-radius: 4px;
}

.sniff-result-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: #1e1e2e;
  border-radius: 6px;
  gap: 10px;
}

.sniff-result-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.format-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.format-m3u8 { background: #1b5e20; color: #4caf50; }
.format-mp4 { background: #0d47a1; color: #64b5f6; }
.format-flv { background: #4a148c; color: #ce93d8; }
.format-mpd { background: #e65100; color: #ffb74d; }
.format-rtmp { background: #880e4f; color: #f48fb1; }
.format-rtsp { background: #004d40; color: #80cbc4; }
.format-magnet { background: #3e2723; color: #a1887f; }
.format-other { background: #333; color: #999; }

.live-badge {
  font-size: 10px;
  background: #b71c1c;
  color: #ff6b6b;
  padding: 2px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}

.sniff-result-url {
  color: #aaa;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sniff-result-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.action-btn {
  padding: 4px 10px;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.play-btn { background: #1b5e20; color: #4caf50; }
.play-btn:hover { background: #2e7d32; }
.add-btn { background: #0d47a1; color: #64b5f6; }
.add-btn:hover { background: #1565c0; }

.sniff-hint {
  padding: 20px;
  text-align: center;
  color: #666;
  font-size: 13px;
}

.sniff-hint p { margin: 0 0 10px 0; }

.format-tags {
  display: flex;
  gap: 6px;
  justify-content: center;
  flex-wrap: wrap;
}

.format-tag {
  padding: 3px 10px;
  background: #2a2a3e;
  border-radius: 4px;
  font-size: 11px;
  color: #aaa;
}

</style>