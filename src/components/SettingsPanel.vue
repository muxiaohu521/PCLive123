<template>
  <div class="settings-panel">
    <div class="panel-header">
      <h3 class="panel-title">⚙ 设置</h3>
      <button class="close-btn" @click="$emit('close')">✕</button>
    </div>

    <div class="panel-body">
      <div class="section">
        <h4 class="section-title">播放设置</h4>
        <div class="setting-row">
          <label>默认音量</label>
          <input type="range" min="0" max="100" v-model.number="localVolume" class="slider" />
          <span class="setting-value">{{ localVolume }}%</span>
        </div>
        <div class="setting-row">
          <label>缓冲区大小</label>
          <select v-model.number="localBufferSize" class="select">
            <option :value="30">30 秒</option>
            <option :value="60">60 秒</option>
            <option :value="120">120 秒</option>
            <option :value="300">300 秒</option>
          </select>
        </div>
        <div class="setting-row">
          <label>解码模式</label>
          <select v-model="localDecodeMode" class="select">
            <option
              v-for="(label, mode) in DECODE_MODE_LABELS"
              :key="mode"
              :value="mode"
            >{{ label }}</option>
          </select>
        </div>
        <div class="setting-row vertical">
          <label>FFmpeg 路径</label>
          <div class="path-row">
            <input
              v-model="localFfmpegPath"
              placeholder="例如 D:\\ffmpeg\\bin\\ffmpeg.exe"
              class="input path-input"
              :class="{ 'path-ok': ffmpegStatus === 'ok', 'path-fail': ffmpegStatus === 'fail' }"
            />
            <button class="mini-btn" @click="browseFfmpeg" title="浏览选择 ffmpeg 可执行文件">浏览</button>
            <button class="mini-btn" @click="testFfmpeg" title="测试 ffmpeg 是否可用" :disabled="!localFfmpegPath || testRunning">
              {{ testRunning ? '测试中...' : '测试' }}
            </button>
          </div>
          <span v-if="ffmpegStatus === 'ok'" class="path-status ok">✓ 检测到 {{ ffmpegVersion }}</span>
          <span v-if="ffmpegStatus === 'fail'" class="path-status fail">✗ {{ ffmpegError }}</span>
        </div>
      </div>

      <div class="section">
        <h4 class="section-title">字幕设置</h4>
        <div class="setting-row">
          <label>字幕字号</label>
          <select v-model.number="localSubFontSize" class="select">
            <option :value="12">小 (12px)</option>
            <option :value="16">中 (16px)</option>
            <option :value="20">大 (20px)</option>
            <option :value="24">特大 (24px)</option>
          </select>
        </div>
        <div class="setting-row">
          <label>字幕颜色</label>
          <select v-model="localSubColor" class="select">
            <option value="#ffffff">白色</option>
            <option value="#ffff00">黄色</option>
            <option value="#00ff00">绿色</option>
            <option value="#00bfff">蓝色</option>
          </select>
        </div>
        <div class="setting-row">
          <label>字幕背景</label>
          <select v-model="localSubBg" class="select">
            <option value="transparent">透明</option>
            <option value="rgba(0,0,0,0.6)">半透明黑</option>
            <option value="rgba(0,0,0,0.9)">深黑</option>
          </select>
        </div>
      </div>

      <div class="section">
        <h4 class="section-title">网络设置</h4>
        <div class="setting-row">
          <label>HTTP 代理</label>
          <input v-model="localProxy" placeholder="http://127.0.0.1:7890" class="input" />
        </div>
        <div class="setting-row">
          <label>请求超时 (秒)</label>
          <input type="number" v-model.number="localTimeout" min="3" max="60" class="input-num" />
        </div>
      </div>

      <div class="section">
        <h4 class="section-title">广告过滤</h4>

        <div class="adfilter-block">
          <div class="block-title">
            <span class="block-icon">&#x1F6AB;</span> 广告域名黑名单
            <span class="block-count">{{ allAdHosts.length }} 个</span>
          </div>
          <div class="block-desc">命中以下域名的请求将被拦截，不加载广告内容</div>
          <div class="host-tags">
            <span
              v-for="host in allAdHosts"
              :key="host"
              class="host-tag"
              :class="{ 'is-custom': extraAdHosts.includes(host) }"
            >
              {{ host }}
              <button
                class="host-remove"
                @click.stop="extraAdHosts.includes(host) ? removeCustomHost(host) : removeBuiltinDomain(host)"
                :title="extraAdHosts.includes(host) ? '移除自定义' : '移除内置'"
              >✕</button>
            </span>
          </div>
          <div v-if="removedBuiltinHosts.length > 0" class="removed-section">
            <div class="removed-title">已移除的内置域名（点击恢复）：</div>
            <span
              v-for="host in removedBuiltinHosts"
              :key="'rm-'+host"
              class="host-tag is-removed"
              @click="restoreBuiltinDomain(host)"
              title="点击恢复"
            >
              {{ host }} &#x21A9;
            </span>
          </div>
          <div class="add-row">
            <input
              v-model="newAdHost"
              type="text"
              class="add-input"
              placeholder="输入广告域名，如 ad.example.com"
              @keydown.enter="addCustomHost"
            />
            <button class="mini-add-btn" @click="addCustomHost">添加</button>
            <button v-if="extraAdHosts.length > 0" class="mini-clear-btn" @click="clearAllCustomHosts">清空自定义</button>
          </div>
        </div>

        <div class="adfilter-block">
          <div class="block-title">
            <span class="block-icon">&#x1F4FA;</span> 广告频道关键词
            <span class="block-count">{{ allKeywords.length }} 个</span>
          </div>
          <div class="block-desc">频道名称命中以下关键词将被自动过滤</div>
          <div class="host-tags">
            <span
              v-for="kw in allKeywords"
              :key="kw"
              class="host-tag"
              :class="{ 'is-custom': extraAdKeywords.includes(kw) }"
            >
              {{ kw }}
              <button
                class="host-remove"
                @click.stop="extraAdKeywords.includes(kw) ? removeCustomKeyword(kw) : removeBuiltinKw(kw)"
                :title="extraAdKeywords.includes(kw) ? '移除自定义' : '移除内置'"
              >✕</button>
            </span>
          </div>
          <div v-if="removedBuiltinKeywords.length > 0" class="removed-section">
            <div class="removed-title">已移除的内置关键词（点击恢复）：</div>
            <span
              v-for="kw in removedBuiltinKeywords"
              :key="'rm-'+kw"
              class="host-tag is-removed"
              @click="restoreBuiltinKw(kw)"
              title="点击恢复"
            >
              {{ kw }} &#x21A9;
            </span>
          </div>
          <div class="add-row">
            <input
              v-model="newKeyword"
              type="text"
              class="add-input"
              placeholder="输入过滤关键词，如 购物"
              @keydown.enter="addCustomKeyword"
            />
            <button class="mini-add-btn" @click="addCustomKeyword">添加</button>
            <button v-if="extraAdKeywords.length > 0" class="mini-clear-btn" @click="clearAllCustomKeywords">清空自定义</button>
          </div>
        </div>

        <div class="adfilter-block">
          <div class="block-title">
            <span class="block-icon">&#x2139;</span> 广告过滤说明
          </div>
          <div class="block-info">
            <p><strong>域名黑名单：</strong>在加载 M3U8 播放列表时，自动识别并剔除来自广告域名的 TS 片段。</p>
            <p><strong>频道关键词：</strong>解析直播源时自动过滤包含广告关键词的频道名称。</p>
            <p><strong>M3U8 净化：</strong>播放时自动分析 TS 片段时长、帧率等特征，识别并移除广告片段。</p>
            <p>内置规则参考 TVBox 项目的 AdBlocker 和 M3u8 净化逻辑。</p>
          </div>
        </div>
      </div>

      <div class="section">
        <h4 class="section-title">数据管理</h4>
        <div class="setting-row">
          <button @click="clearCache" class="btn-danger">清除频道缓存</button>
          <span class="hint">清除本地缓存的频道列表数据</span>
        </div>
        <div class="setting-row">
          <button @click="resetSettings" class="btn-warn">重置所有设置</button>
          <span class="hint">恢复所有设置到默认值</span>
        </div>
      </div>
    </div>

    <div class="panel-footer">
      <button @click="saveSettings" class="btn-save">💾 保存设置</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'
import { DECODE_MODES, DECODE_MODE_LABELS } from '@/constants'
import type { DecodeMode } from '@/constants'
import {
  getAllAdHosts, addAdHosts, removeAdHost, getExtraAdHosts, clearExtraAdHosts,
  getAdChannelKeywords, getExtraAdKeywords, addAdKeywords, removeAdKeyword, clearExtraAdKeywords,
  removeBuiltinHost, restoreBuiltinHost, getRemovedBuiltinHosts,
  removeBuiltinKeyword, restoreBuiltinKeyword, getRemovedBuiltinKeywords,
} from '@/utils/AdFilter'

const store = useAppStore()

const emit = defineEmits<{
  close: []
  saved: [settings: Record<string, any>]
}>()

const STORAGE_KEY = 'pclive_settings'

const defaults = {
  volume: 80,
  bufferSize: 30,
  subFontSize: 16,
  subColor: '#ffffff',
  subBg: 'rgba(0,0,0,0.6)',
  proxy: '',
  timeout: 10,
  decodeMode: 'auto',
  ffmpegPath: '',
}

const localVolume = ref(defaults.volume)
const localBufferSize = ref(defaults.bufferSize)
const localSubFontSize = ref(defaults.subFontSize)
const localSubColor = ref(defaults.subColor)
const localSubBg = ref(defaults.subBg)
const localProxy = ref(defaults.proxy)
const localTimeout = ref(defaults.timeout)
const localDecodeMode = ref<DecodeMode>(defaults.decodeMode as DecodeMode)
const localFfmpegPath = ref(defaults.ffmpegPath)

const ffmpegStatus = ref<'idle' | 'ok' | 'fail'>('idle')
const ffmpegVersion = ref('')
const ffmpegError = ref('')
const testRunning = ref(false)

async function browseFfmpeg() {
  if (!window.electronAPI?.ffmpegSelectPath) {
    ElMessage.warning('仅 Electron 环境支持文件选择')
    return
  }
  const result = await window.electronAPI.ffmpegSelectPath()
  if (result.success && result.path) {
    localFfmpegPath.value = result.path
    ffmpegStatus.value = 'idle'
    ffmpegVersion.value = ''
    ffmpegError.value = ''
  }
}

async function testFfmpeg() {
  if (!window.electronAPI?.ffmpegTest) {
    ElMessage.warning('仅 Electron 环境支持 ffmpeg 测试')
    return
  }
  if (!localFfmpegPath.value) return
  testRunning.value = true
  ffmpegStatus.value = 'idle'
  try {
    const result = await window.electronAPI.ffmpegTest(localFfmpegPath.value)
    if (result.success) {
      ffmpegStatus.value = 'ok'
      ffmpegVersion.value = result.version
      ElMessage.success('FFmpeg 检测成功')
    } else {
      ffmpegStatus.value = 'fail'
      ffmpegError.value = result.error || '无法运行'
      ElMessage.error('FFmpeg 检测失败: ' + ffmpegError.value)
    }
  } catch (e: any) {
    ffmpegStatus.value = 'fail'
    ffmpegError.value = e.message || '未知错误'
  } finally {
    testRunning.value = false
  }
}

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (saved.volume !== undefined) localVolume.value = saved.volume
    if (saved.bufferSize !== undefined) localBufferSize.value = saved.bufferSize
    if (saved.subFontSize !== undefined) localSubFontSize.value = saved.subFontSize
    if (saved.subColor !== undefined) localSubColor.value = saved.subColor
    if (saved.subBg !== undefined) localSubBg.value = saved.subBg
    if (saved.proxy !== undefined) localProxy.value = saved.proxy
    if (saved.timeout !== undefined) localTimeout.value = saved.timeout
    if (saved.decodeMode !== undefined) localDecodeMode.value = saved.decodeMode
    if (saved.ffmpegPath !== undefined) localFfmpegPath.value = saved.ffmpegPath
  } catch {}

  if (store.decodeMode && store.decodeMode !== 'auto') {
    localDecodeMode.value = store.decodeMode
  }

  if (store.ffmpegPath) {
    localFfmpegPath.value = store.ffmpegPath
  }

  refreshAdFilterData()
})

function saveSettings() {
  const settings = {
    volume: localVolume.value,
    bufferSize: localBufferSize.value,
    subFontSize: localSubFontSize.value,
    subColor: localSubColor.value,
    subBg: localSubBg.value,
    proxy: localProxy.value,
    timeout: localTimeout.value,
    decodeMode: localDecodeMode.value,
    ffmpegPath: localFfmpegPath.value,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  store.setDecodeMode(localDecodeMode.value)
  store.setFfmpegPath(localFfmpegPath.value)
  emit('saved', settings)
  ElMessage.success('设置已保存')
}

function clearCache() {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('pclive') || k.startsWith('live_channel'))
    keys.forEach(k => localStorage.removeItem(k))
    if (window.electronAPI?.clearChannelCache) {
      window.electronAPI.clearChannelCache().catch(() => {})
    }
    ElMessage.success(`已清除 ${keys.length} 条缓存`)
  } catch (e: any) {
    ElMessage.error('清除缓存失败: ' + e.message)
  }
}

function resetSettings() {
  localVolume.value = defaults.volume
  localBufferSize.value = defaults.bufferSize
  localSubFontSize.value = defaults.subFontSize
  localSubColor.value = defaults.subColor
  localSubBg.value = defaults.subBg
  localProxy.value = defaults.proxy
  localTimeout.value = defaults.timeout
  localDecodeMode.value = (defaults.decodeMode as DecodeMode)
  localFfmpegPath.value = defaults.ffmpegPath
  ffmpegStatus.value = 'idle'
  ffmpegVersion.value = ''
  ffmpegError.value = ''
  ElMessage.success('已恢复默认设置，请点击保存')
}

// ============ 广告过滤 ============
const allAdHosts = ref<string[]>([])
const extraAdHosts = ref<string[]>([])
const removedBuiltinHosts = ref<string[]>([])
const allKeywords = ref<string[]>([])
const extraAdKeywords = ref<string[]>([])
const removedBuiltinKeywords = ref<string[]>([])
const newAdHost = ref('')
const newKeyword = ref('')

function refreshAdFilterData() {
  allAdHosts.value = getAllAdHosts()
  extraAdHosts.value = getExtraAdHosts()
  removedBuiltinHosts.value = getRemovedBuiltinHosts()
  allKeywords.value = [...getAdChannelKeywords(), ...getExtraAdKeywords()]
  extraAdKeywords.value = getExtraAdKeywords()
  removedBuiltinKeywords.value = getRemovedBuiltinKeywords()
}

function addCustomHost() {
  const host = newAdHost.value.trim().toLowerCase()
  if (host && !allAdHosts.value.includes(host)) {
    addAdHosts([host])
    refreshAdFilterData()
  }
  newAdHost.value = ''
}

function removeCustomHost(host: string) {
  removeAdHost(host)
  refreshAdFilterData()
}

function clearAllCustomHosts() {
  clearExtraAdHosts()
  refreshAdFilterData()
}

function removeBuiltinDomain(host: string) {
  removeBuiltinHost(host)
  refreshAdFilterData()
}

function restoreBuiltinDomain(host: string) {
  restoreBuiltinHost(host)
  refreshAdFilterData()
}

function addCustomKeyword() {
  const kw = newKeyword.value.trim()
  if (kw && !allKeywords.value.includes(kw.toLowerCase())) {
    addAdKeywords([kw])
    refreshAdFilterData()
  }
  newKeyword.value = ''
}

function removeCustomKeyword(kw: string) {
  removeAdKeyword(kw)
  refreshAdFilterData()
}

function clearAllCustomKeywords() {
  clearExtraAdKeywords()
  refreshAdFilterData()
}

function removeBuiltinKw(kw: string) {
  removeBuiltinKeyword(kw)
  refreshAdFilterData()
}

function restoreBuiltinKw(kw: string) {
  restoreBuiltinKeyword(kw)
  refreshAdFilterData()
}
</script>

<style scoped>
.settings-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 440px;
  height: 100%;
  background: #1a1a2e;
  border-left: 1px solid #333;
  display: flex;
  flex-direction: column;
  z-index: 1000;
  box-shadow: -4px 0 20px rgba(0,0,0,0.5);
  color: #ccc;
}

.panel-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 18px; border-bottom: 1px solid #333; flex-shrink: 0;
}
.panel-title { font-size: 15px; font-weight: 600; color: #e0e0e0; margin: 0; }

.close-btn { background: none; border: none; color: #888; font-size: 17px; cursor: pointer; }
.close-btn:hover { color: #fff; }

.panel-body { flex: 1; overflow-y: auto; padding: 12px 18px; }

.section { margin-bottom: 16px; }
.section-title { font-size: 13px; color: #888; margin: 0 0 10px 0; padding-bottom: 6px; border-bottom: 1px solid #2a2a4a; }

.setting-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.setting-row.vertical { flex-direction: column; align-items: flex-start; }
.setting-row label { font-size: 12px; color: #aaa; min-width: 90px; flex-shrink: 0; }
.setting-row.vertical label { min-width: auto; margin-bottom: 4px; }

.path-row { display: flex; gap: 4px; width: 100%; }
.path-input { flex: 1; }
.path-ok { border-color: #4caf50 !important; }
.path-fail { border-color: #f44336 !important; }

.mini-btn {
  padding: 6px 10px; background: #3a3a5a; border: 1px solid #555; border-radius: 4px;
  color: #ccc; font-size: 11px; cursor: pointer; white-space: nowrap;
}
.mini-btn:hover { background: #4a4a6a; }
.mini-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.path-status { font-size: 11px; margin-top: 4px; }
.path-status.ok { color: #4caf50; }
.path-status.fail { color: #f44336; }

.setting-value { font-size: 12px; color: #60a5fa; min-width: 35px; text-align: right; }

.slider { flex: 1; height: 4px; -webkit-appearance: none; background: #333; border-radius: 2px; outline: none; }
.slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #60a5fa; cursor: pointer; }

.select, .input, .input-num, .textarea {
  flex: 1; background: #12122a; border: 1px solid #3a3a5a; color: #ccc; padding: 6px 8px;
  border-radius: 4px; font-size: 12px; outline: none;
}
.select:focus, .input:focus, .textarea:focus { border-color: #60a5fa; }
.input-num { width: 80px; flex: 0 0 80px; }
.textarea { resize: vertical; font-family: monospace; width: 100%; }

.hint { font-size: 10px; color: #666; }

.btn-save {
  width: 100%; padding: 10px; background: #2563eb; border: none; border-radius: 6px;
  color: #fff; font-size: 14px; cursor: pointer;
}
.btn-save:hover { background: #3b82f6; }

.btn-danger {
  padding: 6px 12px; background: #dc2626; border: none; border-radius: 4px; color: #fff;
  font-size: 12px; cursor: pointer;
}
.btn-danger:hover { background: #ef4444; }

.btn-warn {
  padding: 6px 12px; background: #d97706; border: none; border-radius: 4px; color: #fff;
  font-size: 12px; cursor: pointer;
}
.btn-warn:hover { background: #f59e0b; }

.panel-footer { padding: 12px 18px; border-top: 1px solid #333; flex-shrink: 0; }

/* ============ 广告过滤块样式 ============ */
.adfilter-block {
  background: #1e1e2e;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 10px;
}

.block-title {
  font-size: 12px;
  font-weight: 600;
  color: #ddd;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.block-icon { font-size: 13px; }

.block-count {
  font-size: 10px;
  color: #888;
  background: #2a2a3e;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 400;
}

.block-desc {
  font-size: 11px;
  color: #666;
  margin-bottom: 8px;
}

.block-info p {
  font-size: 11px;
  color: #777;
  margin: 4px 0;
  line-height: 1.5;
}

.block-info p strong { color: #aaa; }

.host-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  max-height: 100px;
  overflow-y: auto;
  padding: 2px 0;
  margin-bottom: 6px;
}

.host-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  background: #2a2a3e;
  border-radius: 3px;
  font-size: 11px;
  color: #aaa;
  font-family: monospace;
}

.host-tag.is-custom {
  background: #1a3a2e;
  color: #4caf50;
  border: 1px solid #2e7d32;
}

.host-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  background: rgba(244,67,54,0.15);
  border: 1px solid rgba(244,67,54,0.3);
  border-radius: 50%;
  color: #f44336;
  cursor: pointer;
  font-size: 12px;
  font-family: system-ui, -apple-system, sans-serif;
  line-height: 1;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}

.host-remove:hover {
  background: #f44336;
  color: #fff;
}

.host-tag.is-removed {
  background: #2a1a1a;
  color: #999;
  border: 1px solid #5a3a3a;
  text-decoration: line-through;
  cursor: pointer;
}

.host-tag.is-removed:hover {
  background: #3a2a2a;
  color: #ccc;
}

.removed-section {
  margin-top: 6px;
}

.removed-title {
  font-size: 10px;
  color: #888;
  margin-bottom: 3px;
}

.add-row {
  display: flex;
  gap: 4px;
}

.add-input {
  flex: 1;
  padding: 5px 8px;
  background: #121222;
  border: 1px solid #2a2a3e;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 11px;
  outline: none;
}

.add-input:focus { border-color: #4fc3f7; }
.add-input::placeholder { color: #555; }

.mini-add-btn {
  padding: 5px 10px;
  background: #4fc3f7;
  color: #121212;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.mini-add-btn:hover { background: #6dd5ff; }

.mini-clear-btn {
  padding: 5px 8px;
  background: transparent;
  color: #f44336;
  border: 1px solid #f44336;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.mini-clear-btn:hover { background: #2e1a1a; }
</style>