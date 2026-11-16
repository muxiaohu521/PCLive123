<template>
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
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'
import { crawlSourceUrls } from '@/utils/SourceCrawler'
import { parseImportContent } from '@/utils/SourceFileService'
import { truncateUrl } from '../shared/format'
import { activeTab, registerStopHook } from '../shared/useToolShell'

const store = useAppStore()

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

function cancelSniff() {
  if (sniffSniffing.value) {
    sniffSniffing.value = false
    sniffPhase.value = ''
  }
  if (sniffTimer) {
    clearInterval(sniffTimer)
    sniffTimer = null
  }
}

let offStopHook: (() => void) | null = null
onMounted(() => {
  offStopHook = registerStopHook(cancelSniff)
})
onBeforeUnmount(() => {
  if (offStopHook) offStopHook()
})

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
        })
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
</script>

<style scoped>
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