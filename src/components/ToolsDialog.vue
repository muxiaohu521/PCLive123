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
              placeholder="粘贴网页URL，自动提取视频流地址和直播源..."
              @keydown.enter="startSniff"
            />
          </div>
          <div class="sniffer-btn-row">
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
              找到 <strong>{{ sniffResults.length }}</strong> 个结果
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
                <span v-if="item.isLive && !item._isCrawl" class="live-badge">LIVE</span>
                <span class="sniff-result-url" :title="item.sourceUrl">{{ truncateUrl(item.sourceUrl, 60) }}</span>
              </div>
              <div class="sniff-result-actions">
                <template v-if="item._isCrawl">
                  <button class="action-btn add-btn" @click="onImportSniffedCrawl(item)" title="导入为直播源">导入源</button>
                </template>
                <template v-else>
                  <button class="action-btn play-btn" @click="sniffPlayUrl(item)" title="播放此地址">&#x25B6; 播放</button>
                  <button class="action-btn add-btn" @click="sniffAddChannel(item)" title="添加为频道">+ 频道</button>
                </template>
              </div>
            </div>
          </div>

          <div v-if="!sniffSniffing && sniffResults.length === 0 && !sniffError" class="sniff-hint">
            <p>输入网页URL，自动提取视频流地址和直播源链接</p>
            <div class="format-tags">
              <span class="format-tag">M3U8</span>
              <span class="format-tag">MP4</span>
              <span class="format-tag">FLV</span>
              <span class="format-tag">MPD</span>
              <span class="format-tag">RTMP</span>
              <span class="format-tag">RTSP</span>
              <span class="format-tag">M3U源</span>
              <span class="format-tag">TXT源</span>
            </div>
          </div>
        </div>

        <!-- ============ IP查询 ============ -->
        <div v-show="activeTab === 'geoip'" class="tab-panel">
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
        </div>

        <!-- ============ 录屏 ============ -->
        <div v-show="activeTab === 'recording'" class="tab-panel">
          <!-- 未开始录制 -->
          <div v-if="!recordingActive && !recordingFinished" class="recording-setup">
            <div class="recording-param-group">
              <div class="param-label">帧率 (FPS)</div>
              <el-select v-model="recordingFps" size="small" class="param-select">
                <el-option :value="10" label="10 FPS - 低流畅度" />
                <el-option :value="15" label="15 FPS - 标准" />
                <el-option :value="20" label="20 FPS - 较高" />
                <el-option :value="25" label="25 FPS - 高流畅度" />
                <el-option :value="30" label="30 FPS - 最高" />
              </el-select>
            </div>

            <div class="recording-param-group">
              <div class="param-label">画质</div>
              <el-select v-model="recordingQuality" size="small" class="param-select">
                <el-option value="high" label="高质量 (文件较大)" />
                <el-option value="medium" label="中等质量" />
                <el-option value="low" label="低质量 (文件较小)" />
              </el-select>
            </div>

            <div class="recording-param-group">
              <div class="param-label">保存路径</div>
              <div class="output-path-row">
                <input
                  type="text"
                  class="output-path-input"
                  :value="recordingOutputPath"
                  readonly
                  placeholder="点击选择保存路径..."
                />
                <button class="browse-btn" @click="selectOutputPath">浏览...</button>
              </div>
            </div>

            <div class="recording-info-hint">
              <p>直接从视频元素捕获原始解码画面+音频，不受弹窗/UI遮挡影响。</p>
              <p>窗口最小化时录制不受影响，结果保存为 WebM (VP9+Opus) 格式。</p>
            </div>

            <el-button
              type="primary"
              class="start-record-btn"
              :disabled="!recordingOutputPath"
              @click="startRecording"
            >
              &#x23FA; 开始录屏
            </el-button>
          </div>

          <!-- 录制中 -->
          <div v-if="recordingActive" class="recording-active-panel">
            <div class="recording-indicator">
              <span class="recording-dot"></span>
              <span class="recording-text">录制中...</span>
            </div>

            <div class="recording-stats">
              <div class="stat-row">
                <span class="stat-label">已录制时长</span>
                <span class="stat-value">{{ formatDuration(recordingElapsed) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">已写入区块</span>
                <span class="stat-value">{{ recordingFrameCount }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">帧率</span>
                <span class="stat-value">{{ recordingFps }} FPS</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">画质</span>
                <span class="stat-value">{{ qualityLabel }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">文件大小</span>
                <span class="stat-value">{{ formatFileSize(recordingFileSize) }}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">保存路径</span>
                <span class="stat-value recording-path">{{ recordingOutputPath }}</span>
              </div>
            </div>

            <el-button type="danger" class="stop-record-btn" @click="stopRecording">
              &#x23F9; 停止录屏
            </el-button>
          </div>

          <!-- 录制完成 -->
          <div v-if="recordingFinished" class="recording-finished-panel">
            <div class="finished-icon">&#x2705;</div>
            <div class="finished-title">录制完成!</div>
            <div class="recording-stats">
              <div class="stat-row">
                <span class="stat-label">录制时长</span>
                <span class="stat-value">{{ recordingResultElapsed }} 秒</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">数据块</span>
                <span class="stat-value">{{ recordingResultFrames }} 个</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">保存位置</span>
                <span class="stat-value recording-path">{{ recordingResultPath }}</span>
              </div>
            </div>
            <div class="finished-actions">
              <el-button type="primary" size="small" @click="resetRecording">&#x2699; 开始新录制</el-button>
            </div>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick, onMounted } from 'vue'
import { useAppStore } from '@/store'
import { ElMessage } from 'element-plus'
import { crawlSourceUrls } from '@/utils/SourceCrawler'
import { parseImportContent } from '@/utils/SourceFileService'
import { getGeoInfo, extractHost, type GeoInfo } from '@/utils/GeoService'
import { logger } from '@/utils/logger'

const store = useAppStore()

// ============ 对话框状态 ============
const showBar = ref(false)
const isMinimizing = ref(false)

type TabKey = 'connectivity' | 'sniffer' | 'recording' | 'geoip'
const activeTab = ref<TabKey>('connectivity')

const tabs = [
  { key: 'connectivity' as TabKey, label: '🔍 连通性测试' },
  { key: 'sniffer' as TabKey, label: '🕵️ URL嗅探' },
  { key: 'geoip' as TabKey, label: '🌍 IP查询' },
  { key: 'recording' as TabKey, label: '🎬 录屏' },
]

const barText = computed(() => {
  if (recordingActive.value) return `录屏中 ${formatDuration(recordingElapsed.value)}`
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
    if (recordingStatusTimer) {
      clearInterval(recordingStatusTimer)
      recordingStatusTimer = null
    }
  }
  isMinimizing.value = false
}

watch(() => store.showToolsDialog, (v) => {
  if (v) {
    showBar.value = true
    isMinimizing.value = false
  }
})

// ======= DIAGNOSTIC LOG =======
watch(() => store.showToolsDialog, (v) => {
  if (!v) return
  nextTick(() => {
    setTimeout(() => {
      const root = document.querySelector('.tools-root') as HTMLElement | null
      if (!root) { logger.warn('[TOOLS] .tools-root NOT FOUND'); return }
      const parts: string[] = ['[TOOLS] DOM state']
      parts.push('  parent: ' + (root.parentElement?.className || '(none)'))
      parts.push('  grandparent: ' + (root.parentElement?.parentElement?.className || '(none)'))
      const all = root.querySelectorAll('*')
      const dump: string[] = []
      all.forEach(el => {
        const depth = getDepth(el, root)
        const cn = typeof el.className === 'string' ? el.className : ''
        dump.push('  ' + '  '.repeat(depth) + `<${el.tagName.toLowerCase()}${cn ? '.' + cn.replace(/\s+/g, '.') : ''}>`)
      })
      parts.push('  FULL DOM TREE (inside .tools-root):\n' + dump.join('\n'))
      logger.log(parts.join('\n'))
    }, 300)
  })
})
function getDepth(el: Element, root: Element): number {
  let d = 0, cur = el.parentElement
  while (cur && cur !== root) { d++; cur = cur.parentElement }
  return d
}
// ======= END DIAGNOSTIC =======

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
        const phase = resp.phase
        if (phase === 'direct') sniffPhaseLabel.value = '直链识别'
        else if (phase === 'quick') sniffPhaseLabel.value = '快速扫描'
        else if (phase === 'quick+deep') sniffPhaseLabel.value = '快速+深度'
        else if (phase === 'deep') sniffPhaseLabel.value = '深度嗅探'
        if (resp.urls.length === 0 && resp.hint) {
          sniffError.value = resp.hint
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

  // 嗅探完成后，同时爬取页面中的 M3U/TXT 直播源链接
  try {
    const crawlRes = await crawlSourceUrls(url)
    if (crawlRes.length > 0) {
      // 去重：排除已存在于 sniffResults 中的 URL
      const existingUrls = new Set(sniffResults.value.map(r => r.sourceUrl || r.url))
      const newCrawlItems = crawlRes.filter(c => !existingUrls.has(c.url))
      for (const c of newCrawlItems) {
        sniffResults.value.push({
          url: c.url,
          sourceUrl: c.url,
          format: c.type,
          contentType: '',
          isLive: false,
          _isCrawl: true,
        } as any)
      }
      sniffTotalFound.value += newCrawlItems.length
    }
  } catch {}
}

async function onImportSniffedCrawl(item: SniffResult) {
  const url = item.sourceUrl || item.url
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const text = await resp.text()
    const fileName = url.split('/').pop() || 'crawl_result'
    const parsed = parseImportContent(text, fileName)
    if (parsed && parsed.channelCount > 0) {
      const dataUri = 'data:text/plain;base64,' + btoa(String.fromCharCode(...new Uint8Array(new TextEncoder().encode(text)).values()))
      const name = fileName.replace(/\.(m3u|m3u8|txt)$/i, '').replace(/[_-]/g, ' ').trim() || '爬取源'
      await store.addSource(name, dataUri)
      ElMessage.success(`成功导入: ${name} (${parsed.channelCount} 个频道)`)
    } else {
      ElMessage.warning('未能解析该源内容，尝试直接添加')
      await store.addSource(fileName.replace(/\.(m3u|m3u8|txt)$/i, ''), url)
      ElMessage.success('已添加为直播源')
    }
  } catch (e: any) {
    ElMessage.error('获取源内容失败: ' + (e.message || '网络错误'))
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

// ============ IP查询 ============
interface GeoResultItem {
  host: string
  label?: string
  info?: GeoInfo | null
  error?: string
}

const geoInput = ref('')
const geoQuerying = ref(false)
const geoResults = ref<GeoResultItem[]>([])

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

// ============ 录屏 ============
// 核心原理：
// - video.captureStream() 直接从 <video> 元素抓取**原始解码画面**，不包含任何 UI 遮挡层
// - MediaRecorder 自动采集视频+音频双轨道，音频来自视频播放的程序输出
// - 数据块通过 IPC 流式写入磁盘，低内存占用

const recordingFps = ref(25)
const recordingQuality = ref('high')
const recordingOutputPath = ref('')
const recordingActive = ref(false)
const recordingFinished = ref(false)
const recordingElapsed = ref(0)
const recordingFrameCount = ref(0)
const recordingFileSize = ref(0)
const recordingResultElapsed = ref('')
const recordingResultFrames = ref(0)
const recordingResultPath = ref('')
let recordingStatusTimer: ReturnType<typeof setInterval> | null = null
let mediaRecorder: MediaRecorder | null = null
let videoStream: MediaStream | null = null
let localStartTime = 0
let localFrameCount = 0

const qualityLabel = computed(() => {
  const m: Record<string, string> = { high: '高质量 8Mbps', medium: '中等 4Mbps', low: '低质量 2Mbps' }
  return m[recordingQuality.value] || '中等'
})

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

function findVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video') as HTMLVideoElement | null
}

function getSupportedMimeType(): string {
  const candidates = [
    'video/webm; codecs=vp9,opus',
    'video/webm; codecs=vp9',
    'video/webm; codecs=vp8,opus',
    'video/webm; codecs=vp8',
    'video/webm',
  ]
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return 'video/webm'
}

async function selectOutputPath() {
  if (!window.electronAPI?.recordingSelectOutput) return
  const result = await window.electronAPI.recordingSelectOutput()
  if (result.success && result.path) {
    recordingOutputPath.value = result.path
  }
}

async function startRecording() {
  if (!recordingOutputPath.value || recordingActive.value) return

  const video = findVideoElement()
  if (!video) {
    alert('未找到播放器视频元素，请先播放视频')
    return
  }
  if (video.paused || video.ended) {
    alert('请先播放视频再开始录屏')
    return
  }

  if (!window.electronAPI?.recordingStartStream) return

  // 启动主进程文件写入流
  const streamResult = await window.electronAPI.recordingStartStream({
    outputPath: recordingOutputPath.value,
  })
  if (!streamResult.success) {
    alert('录屏启动失败: ' + (streamResult.error || '未知错误'))
    return
  }

  // 从 video 元素捕获原始画面+音频流（不包含任何 UI 遮挡层）
  try {
    videoStream = video.captureStream(recordingFps.value)
  } catch (e: any) {
    await window.electronAPI.recordingFinishStream()
    alert('无法从视频元素捕获流: ' + (e.message || '未知错误'))
    return
  }

  const videoTrack = videoStream.getVideoTracks()[0]

  if (!videoTrack) {
    await window.electronAPI.recordingFinishStream()
    alert('视频流中没有视频轨道，可能受 DRM 保护或格式不支持')
    return
  }

  const mimeType = getSupportedMimeType()
  const bitrateMap: Record<string, number> = { high: 8000000, medium: 4000000, low: 2000000 }
  const videoBitsPerSecond = bitrateMap[recordingQuality.value] || 4000000

  try {
    mediaRecorder = new MediaRecorder(videoStream, {
      mimeType,
      videoBitsPerSecond,
    })
  } catch (_) {
    mediaRecorder = new MediaRecorder(videoStream, { mimeType: 'video/webm' })
  }

  localStartTime = Date.now()
  localFrameCount = 0

  mediaRecorder.ondataavailable = async (event) => {
    if (event.data && event.data.size > 0 && recordingActive.value) {
      try {
        const arrayBuffer = await event.data.arrayBuffer()
        localFrameCount++
        await window.electronAPI!.recordingWriteChunk(arrayBuffer)
      } catch (_) {}
    }
  }

  mediaRecorder.onstop = () => {
    if (recordingActive.value) {
      recordingActive.value = false
      recordingFinished.value = true
    }
  }

  mediaRecorder.onerror = (event) => {
    const err = (event as ErrorEvent).error || '未知错误'
    alert('录屏错误: ' + err)
    cleanupRecording()
  }

  mediaRecorder.start(1000)

  recordingActive.value = true
  recordingFinished.value = false
  recordingElapsed.value = 0
  recordingFrameCount.value = 0
  recordingFileSize.value = 0
  showBar.value = true

  recordingStatusTimer = setInterval(async () => {
    if (!recordingActive.value) return
    recordingElapsed.value = Math.round((Date.now() - localStartTime) / 1000)
    recordingFrameCount.value = localFrameCount
    try {
      const status = await window.electronAPI!.recordingStatus()
      if (status.recording) {
        recordingFileSize.value = status.totalBytes || 0
      } else if (recordingActive.value) {
        cleanupRecording()
        recordingActive.value = false
        recordingFinished.value = true
      }
    } catch (_) {}
  }, 500)
}

function cleanupRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop() } catch (_) {}
  }
  mediaRecorder = null
  if (videoStream) {
    try {
      videoStream.getTracks().forEach(t => t.stop())
    } catch (_) {}
    videoStream = null
  }
  if (recordingStatusTimer) {
    clearInterval(recordingStatusTimer)
    recordingStatusTimer = null
  }
}

async function stopRecording() {
  if (!recordingActive.value) return

  const mediaRecorderToStop = mediaRecorder
  if (mediaRecorderToStop && mediaRecorderToStop.state === 'recording') {
    mediaRecorderToStop.onstop = async () => {
      recordingActive.value = false
      try {
        const result = await window.electronAPI!.recordingFinishStream()
        if (result.success) {
          recordingResultElapsed.value = result.elapsed || '0'
          recordingResultFrames.value = localFrameCount
          recordingResultPath.value = result.outputPath || recordingOutputPath.value
          recordingFinished.value = true
        }
      } catch (_) {
        recordingFinished.value = true
      }
      cleanupRecording()
    }
    mediaRecorderToStop.requestData()
    mediaRecorderToStop.stop()
  } else {
    await window.electronAPI!.recordingFinishStream()
    cleanupRecording()
    recordingActive.value = false
    recordingFinished.value = true
  }
}

function resetRecording() {
  recordingFinished.value = false
  recordingActive.value = false
  recordingOutputPath.value = ''
  recordingElapsed.value = 0
  recordingFrameCount.value = 0
  recordingFileSize.value = 0
  localFrameCount = 0
  cleanupRecording()
}

onMounted(() => {
  logger.log('[TOOLS] component mounted, .tools-root exists:', !!document.querySelector('.tools-root'))
})
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
  margin-bottom: 10px;
}

.sniffer-input {
  width: 100%;
  padding: 10px 14px;
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 8px;
  color: #e0e0e0;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.sniffer-input:focus { border-color: #4fc3f7; }
.sniffer-input::placeholder { color: #555; }

.sniffer-btn-row {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

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
.format-m3u { background: #33691e; color: #aed581; }
.format-txt { background: #37474f; color: #b0bec5; }
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

/* ============ IP查询样式 ============ */
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

/* ============ 录屏样式 ============ */
.recording-setup {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}

.recording-param-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.param-label {
  font-size: 13px;
  color: #aaa;
  font-weight: 500;
}

.param-select {
  width: 100%;
}

.output-path-row {
  display: flex;
  gap: 8px;
}

.output-path-input {
  flex: 1;
  padding: 8px 12px;
  background: #1e1e2e;
  border: 1px solid #2a2a3e;
  border-radius: 6px;
  color: #888;
  font-size: 12px;
  outline: none;
  cursor: default;
}

.browse-btn {
  padding: 8px 14px;
  background: #35355a;
  color: #ccc;
  border: 1px solid #4fc3f7;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.browse-btn:hover { background: #4a4a7a; }

.recording-info-hint {
  padding: 12px;
  background: #1a1a2e;
  border: 1px solid #2a2a3e;
  border-radius: 6px;
}

.recording-info-hint p {
  margin: 0 0 4px 0;
  font-size: 12px;
  color: #666;
  line-height: 1.6;
}

.recording-info-hint p:last-child { margin-bottom: 0; color: #ffa726; }

.start-record-btn {
  align-self: center;
  width: 200px;
  margin-top: 8px;
}

.stop-record-btn {
  align-self: center;
  width: 200px;
  margin-top: 12px;
}

.recording-active-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}

.recording-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px;
  background: #2e1a1a;
  border: 1px solid #f44336;
  border-radius: 8px;
}

.recording-dot {
  width: 12px;
  height: 12px;
  background: #f44336;
  border-radius: 50%;
  animation: record-pulse 1s ease-in-out infinite;
}

@keyframes record-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}

.recording-text {
  color: #f44336;
  font-size: 15px;
  font-weight: 700;
}

.recording-stats {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  background: #1e1e2e;
  border-radius: 8px;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stat-label { color: #888; font-size: 13px; }
.stat-value { color: #ffa726; font-weight: 600; font-size: 14px; }

.recording-path {
  font-size: 11px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.recording-finished-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
}

.finished-icon {
  font-size: 40px;
}

.finished-title {
  font-size: 18px;
  color: #4caf50;
  font-weight: 700;
}

.finished-actions {
  margin-top: 8px;
}
</style>