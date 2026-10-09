<template>
  <div class="source-root">
    <div class="source-manager-panel">
      <div class="panel-header">
        <div class="header-left">
          <h3 class="panel-title">直播源管理</h3>
          <span class="panel-count">{{ store.sourceList.length }} 个直播源</span>
        </div>
        <div class="header-actions">
          <el-button link :icon="Close" @click="$emit('close')" class="close-btn" />
        </div>
      </div>

      <div class="panel-toolbar">
        <el-button size="small" :icon="FolderOpened" @click="onImportClick" :disabled="!isElectron">
          导入
        </el-button>
        <el-button size="small" :icon="Download" @click="onExportClick" :disabled="importExportDisabled">
          导出
        </el-button>
        <el-button size="small" :icon="FolderOpened" @click="onExportAllClick" :disabled="!isElectron || store.sourceList.length === 0">
          导出全部
        </el-button>
        <div class="toolbar-spacer" />
        <el-button type="primary" size="small" :icon="Plus" @click="onAddClick">
          添加
        </el-button>
      </div>

      <div class="panel-body">
        <div class="section">
          <div class="section-header">
            <span class="section-title">直播源列表</span>
          </div>
          <div class="source-list">
            <div
              v-for="source in store.sortedSourceList"
              :key="source.url"
              class="source-item"
              :class="{ active: source.url === store.currentSource }"
              @click="onSelectSource(source)"
            >
              <div class="source-left">
                <span class="source-indicator" v-if="source.url === store.currentSource">●</span>
                <span class="source-health" :class="'health-' + getHealth(source.url)"></span>
                <div class="source-info">
                  <span class="source-name">{{ source.name }}<span class="source-count" v-if="getSourceCount(source.url) > 0"> {{ getSourceCount(source.url) }}台</span></span>
                  <span class="source-url" :title="source.url">{{ source.url }}</span>
                  <span class="source-geo" v-if="store.sourceGeo?.get(source.url)" :title="store.sourceGeo?.get(source.url)?.isp">
                    {{ store.sourceGeo?.get(source.url)?.country }}
                    <span v-if="store.sourceGeo?.get(source.url)?.city">· {{ store.sourceGeo?.get(source.url)?.city }}</span>
                  </span>
                </div>
              </div>
              <div class="source-actions">
                <el-button link :icon="Edit" size="small" @click.stop="onEdit(source)" title="编辑" />
                <el-button link :icon="Delete" size="small" @click.stop="onDelete(source)" title="删除" />
              </div>
            </div>
          </div>
        </div>

        <div class="section" v-if="store.sourceList.length === 0">
          <div class="empty-state">暂无直播源，点击上方按钮添加或导入</div>
        </div>

        <div class="section" v-if="store.sourceError && store.channelGroups.length === 0">
          <div class="error-state">{{ store.sourceError }}</div>
        </div>
      </div>

      <div class="panel-footer">
        <div class="footer-row">
          <span class="shortcut">↑↓ 切换源</span>
          <span class="shortcut">Tab 关闭</span>
        </div>
      </div>
    </div>

    <!-- Add/Edit Dialog -->
    <el-dialog
      :model-value="showAddDialog"
      :title="editingIndex >= 0 ? '编辑直播源' : '添加直播源'"
      width="420px"
      :modal="false"
      :append-to-body="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      destroy-on-close
      draggable
      class="source-dialog"
      @update:model-value="(v: boolean) => showAddDialog = v"
    >
      <el-form :model="formData" label-position="top" size="default">
        <el-form-item label="名称">
          <el-input v-model="formData.name" placeholder="请输入直播源名称" clearable />
        </el-form-item>
        <el-form-item label="地址">
          <el-input v-model="formData.url" placeholder="请输入直播源地址 (http://...)" clearable />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" @click="onSave" :disabled="!formData.name || !formData.url">
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- Import Result Dialog -->
    <el-dialog
      :model-value="showImportResult"
      title="导入结果"
      width="420px"
      :modal="false"
      :append-to-body="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      destroy-on-close
      draggable
      class="source-dialog"
      @update:model-value="(v: boolean) => showImportResult = v"
    >
      <div class="import-result">
        <div class="result-row" v-if="importResult">
          <el-icon v-if="importResult.channelCount > 0" color="#4caf50" :size="20">&#x274F;</el-icon>
          <el-icon v-else color="#e57373" :size="20">&#x2716;</el-icon>
          <span class="result-text">
            文件: <strong>{{ importFileName }}</strong>
          </span>
        </div>
        <div class="result-row" v-if="importResult && importResult.channelCount > 0">
          <span>格式: <el-tag size="small">{{ importResult.format.toUpperCase() }}</el-tag></span>
          <span>频道数: <strong>{{ importResult.channelCount }}</strong></span>
        </div>
        <div class="result-error" v-if="importError">
          {{ importError }}
        </div>
      </div>
      <template #footer>
        <el-button @click="showImportResult = false">关闭</el-button>
        <el-button
          v-if="importResult && importResult.channelCount > 0 && importContentData"
          type="primary"
          @click="onConfirmImport"
        >
          确认导入 ({{ importResult.channelCount }} 频道)
        </el-button>
      </template>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { Edit, Delete, FolderOpened, Download, Plus, Close } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'
import {
  parseImportContent,
  exportToM3u,
} from '@/utils/SourceFileService'
import { ChannelService, readCacheEntry } from '@/services/ChannelService'
import type { CacheStorageEntry, LiveChannelGroup } from '@/models/LiveChannelItem'
import type { SourceImportResult, ExportedChannel } from '@/utils/SourceFileService'
import { sanitizeFilename } from '@/utils/m3uConverter'
import { logger } from '@/utils/logger'
import { isElectron as checkIsElectron } from '@/constants'

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function isValidCache(entry: CacheStorageEntry | null): entry is CacheStorageEntry {
  if (!entry || entry.data.length === 0) return false
  const livesLen = entry.livesGroups?.length || 0
  if (livesLen > 0 && entry.completedCount < livesLen) return false
  return true
}

async function parseAndCache(url: string, options?: { maxRetries?: number }): Promise<LiveChannelGroup[]> {
  const groups = await ChannelService.loadChannelsRobust(url, {
    skipCache: true,
    maxRetries: options?.maxRetries ?? 1,
  })
  if (groups.length > 0) {
    const totalCh = groups.reduce((s, g) => s + g.liveChannels.length, 0)
    store.sourceStats.set(url, { channelCount: totalCh, parsedAt: Date.now() })
    store.flushSourceStats()
    logger.log('[SourceManager] Parsed and cached:', groups.length, 'groups,', totalCh, 'channels')
  }
  return groups
}

defineEmits<{
  close: []
}>()

const store = useAppStore()
const showAddDialog = ref(false)
const editingIndex = ref<number>(-1)
const formData = reactive({ name: '', url: '' })

const sourceHealth = ref<Map<string, 'green' | 'yellow' | 'red' | 'gray'>>(new Map())

const showImportResult = ref(false)
const importResult = ref<SourceImportResult | null>(null)
const importFileName = ref('')
const importError = ref('')
const importContentData = ref('')

const isElectron = computed(() => checkIsElectron())

function onAddClick() {
  editingIndex.value = -1
  formData.name = ''
  formData.url = ''
  showAddDialog.value = true
}

const importExportDisabled = computed(() => !store.channelGroups || store.channelGroups.length === 0)

function getHealth(url: string): string {
  return sourceHealth.value.get(url) || 'gray'
}

watch(() => store.pendingSniffUrl, (val) => {
  if (val) {
    formData.name = val.name
    formData.url = val.url
    editingIndex.value = -1
    showAddDialog.value = true
    store.pendingSniffUrl = null
  }
})

function getSourceCount(url: string): number {
  return store.sourceStats.get(url)?.channelCount || 0
}

const currentSourceName = computed(() => {
  const src = store.sourceList.find(s => s.url === store.currentSource)
  return src?.name || 'live_source'
})

function onSelectSource(source: { name: string; url: string }) {
  store.setCurrentSource(source.url)
}

function onEdit(source: { name: string; url: string }) {
  const idx = store.sourceList.findIndex(s => s.url === source.url)
  editingIndex.value = idx
  formData.name = source.name
  formData.url = source.url
  showAddDialog.value = true
}

async function onDelete(source: { name: string; url: string }) {
  await store.removeSource(source.url)
  ElMessage.success(`已删除 "${source.name}"，同步清除缓存及外部文件`)
}

async function onSave() {
  if (!formData.name || !formData.url) return
  if (editingIndex.value >= 0) {
    const oldSource = store.sourceList[editingIndex.value]
    if (oldSource) {
      await store.updateSource(oldSource.url, formData.name, formData.url)
    }
  } else {
    await store.addSource(formData.name, formData.url)
  }
  editingIndex.value = -1
  formData.name = ''
  formData.url = ''
  showAddDialog.value = false
}

async function onImportClick() {
  if (!isElectron.value) {
    ElMessage.warning('导入功能仅支持 Electron 环境')
    return
  }
  try {
    const result = await window.electronAPI!.openFileDialog({
      title: '选择直播源文件',
      filters: [
        { name: '直播源文件', extensions: ['json', 'm3u', 'm3u8', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (!result || result.error || !result.content) {
      ElMessage.error(result?.error || '未能读取文件')
      return
    }

    importContentData.value = result.content
    importFileName.value = result.fileName || '未知文件'
    importError.value = ''

    const parsed = parseImportContent(result.content, result.fileName)
    if (!parsed || parsed.channelCount === 0) {
      importResult.value = null
      importError.value = '未能识别文件格式或无有效频道数据。支持的格式: M3U/M3U8 播放列表、TVBox JSON 格式、纯链接 TXT'
    } else {
      importResult.value = parsed
    }
    showImportResult.value = true
  } catch (e: any) {
    ElMessage.error('导入失败: ' + (e.message || '未知错误'))
  }
}

async function onConfirmImport() {
  if (!importContentData.value) return

  const MAX_LOCAL_STORAGE_SIZE = 3 * 1024 * 1024
  const contentSize = new Blob([importContentData.value]).size
  if (contentSize > MAX_LOCAL_STORAGE_SIZE) {
    ElMessage.warning(
      `文件较大（${(contentSize / 1024 / 1024).toFixed(1)}MB），超出localStorage推荐上限，` +
      '建议使用在线URL方式添加，或拆分文件后导入。'
    )
    return
  }

  if (importResult.value?.format === 'm3u') {
    const dataUri = 'data:text/plain;base64,' + toBase64(importContentData.value)
    const name = importFileName.value
      .replace(/\.(m3u|m3u8|txt|json)$/i, '')
      .replace(/[_-]/g, ' ')
      .trim() || '导入源'
    const action = await store.addSource(name, dataUri)
    parseAndCache(dataUri).then(groups => {
      if (groups.length > 0) {
        logger.log('[SourceManager] M3U import cached:', groups.length, 'groups')
      }
    }).catch((e: unknown) => {
      logger.log('[SourceManager] M3U import parse failed:', e instanceof Error ? e.message : e)
    })
    if (action === 'overwritten') {
      ElMessage.success(`已覆盖 "${name}"（链接重复），共 ${importResult.value.channelCount} 个频道`)
    } else {
      ElMessage.success(`成功导入 ${importResult.value.channelCount} 个频道`)
    }
  } else if (importResult.value?.format === 'txt') {
    // TXT 格式：每行一个直播源链接，逐个追加，URL 去重
    const urlLines = importContentData.value
      .split('\n')
      .map(l => l.trim())
      .filter((l) => /^https?:\/\//i.test(l))
      .filter((l, i, arr) => arr.indexOf(l) === i) // 文件内去重

    if (urlLines.length === 0) {
      ElMessage.warning('文件中未找到有效链接')
      showImportResult.value = false
      importContentData.value = ''
      return
    }

    let appended = 0
    let overwritten = 0
    const appendedUrls: string[] = []

    for (const url of urlLines) {
      const name = extractSourceName(url)
      const action = await store.addSource(name, url)
      if (action === 'appended') {
        appended++
        appendedUrls.push(url)
      } else {
        overwritten++
      }
    }

    // 为新追加的直播源后台加载并缓存数据，同步更新台数
    if (appendedUrls.length > 0) {
      let completed = 0
      let flushed = false
      appendedUrls.forEach(url => {
        parseAndCache(url).catch(() => {}).finally(() => {
          completed++
          if (!flushed && completed >= appendedUrls.length) {
            flushed = true
            store.flushSourceStats()
          }
        })
      })
    }

    const parts: string[] = []
    if (appended > 0) parts.push(`新增 ${appended} 个`)
    if (overwritten > 0) parts.push(`覆盖 ${overwritten} 个`)
    ElMessage.success(`成功导入：${parts.join('，')}`)
  } else if (importResult.value?.format === 'json') {
    const dataUri = 'data:application/json;base64,' + toBase64(importContentData.value)
    const name = importFileName.value
      .replace(/\.(m3u|m3u8|txt|json)$/i, '')
      .replace(/[_-]/g, ' ')
      .trim() || '导入源'
    const action = await store.addSource(name, dataUri)
    parseAndCache(dataUri).then(groups => {
      if (groups.length > 0) {
        logger.log('[SourceManager] JSON import cached:', groups.length, 'groups')
      }
    }).catch((e: unknown) => {
      logger.log('[SourceManager] JSON import parse failed:', e instanceof Error ? e.message : e)
    })
    if (action === 'overwritten') {
      ElMessage.success(`已覆盖 "${name}"（链接重复）`)
    } else {
      ElMessage.success('成功导入 JSON 直播源')
    }
  }

  showImportResult.value = false
  importContentData.value = ''
}

function extractSourceName(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname
  } catch (_) {
    // 如果 URL 解析失败，尝试截取协议后的部分
    const match = url.match(/^https?:\/\/([^\/\?#]+)/i)
    return match ? match[1] : url.substring(0, 30)
  }
}

async function onExportClick() {
  if (!isElectron.value) {
    ElMessage.warning('导出功能仅支持 Electron 环境')
    return
  }

  const sourceUrl = store.currentSource
  let channels: ExportedChannel[] = []

  // Priority 1: Use valid cached data
  if (sourceUrl) {
    const cached = await readCacheEntry(sourceUrl)
    if (isValidCache(cached)) {
      channels = cached.data.flatMap(g =>
        g.liveChannels.map(ch => ({
          name: ch.channelName,
          url: ch.channelUrls[ch.sourceIndex || 0] || ch.channelUrls[0] || '',
          group: g.groupName,
          logo: ch.channelLogo || undefined,
          tvgId: ch.channelTvgId || undefined,
          tvgName: ch.channelTvgName || undefined,
        }))
      ).filter(c => c.url)
      if (channels.length > 0) {
        ElMessage.success('已从缓存读取数据')
      }
    }
  }

  // Priority 2: Cache invalid (expired/empty/incomplete), fetch from network
  if (channels.length === 0 && sourceUrl) {
    const loading = ElMessage({ message: '缓存无效，正在联网获取...', type: 'info', duration: 0 })
    try {
      const groups = await ChannelService.loadChannelsRobust(sourceUrl, {
        skipCache: true,
        maxRetries: 1,
      })
      loading.close()
      channels = groups.flatMap(g =>
        g.liveChannels.map(ch => ({
          name: ch.channelName,
          url: ch.channelUrls[ch.sourceIndex || 0] || ch.channelUrls[0] || '',
          group: g.groupName,
          logo: ch.channelLogo || undefined,
          tvgId: ch.channelTvgId || undefined,
          tvgName: ch.channelTvgName || undefined,
        }))
      ).filter(c => c.url)
      if (channels.length > 0) {
        ElMessage.success(`联网获取到 ${channels.length} 个频道`)
      }
    } catch (_) {
      loading.close()
    }
  }

  // Priority 3: Fallback to current UI channels
  if (channels.length === 0) {
    channels = extractChannelsFromCurrentGroups()
  }

  if (channels.length === 0) {
    ElMessage.warning('当前没有可导出的频道')
    return
  }

  try {
    const m3uContent = exportToM3u(channels, currentSourceName.value)
    const safeName = sanitizeFilename(currentSourceName.value)
    const result = await window.electronAPI!.saveFileDialog({
      title: '导出直播频道',
      defaultPath: `${safeName}.m3u`,
      content: m3uContent,
      filters: [
        { name: 'M3U 播放列表 (*.m3u)', extensions: ['m3u'] },
        { name: 'M3U8 播放列表 (*.m3u8)', extensions: ['m3u8'] },
      ],
    })
    if (result && result.success) {
      ElMessage.success(`成功导出 ${channels.length} 个频道到 ${result.filePath}`)
    } else if (result?.error) {
      ElMessage.error('导出失败: ' + result.error)
    }
  } catch (e: any) {
    ElMessage.error('导出失败: ' + (e.message || '未知错误'))
  }
}

async function onExportAllClick() {
  if (!isElectron.value) {
    ElMessage.warning('导出功能仅支持 Electron 环境')
    return
  }

  if (store.sourceList.length === 0) {
    ElMessage.warning('没有可导出的直播源')
    return
  }

  try {
    const dirResult = await window.electronAPI!.openDirectory()
    if (!dirResult || !dirResult.directoryPath) return

    const dirPath = dirResult.directoryPath
    let successCount = 0
    let failCount = 0
    const total = store.sourceList.length

    for (let i = 0; i < store.sourceList.length; i++) {
      const source = store.sourceList[i]
      ElMessage.info(`正在导出 [${i + 1}/${total}] ${source.name}...`)
      try {
        let groups: LiveChannelGroup[] | null = null

        // Priority 1: valid cache
        const cached = await readCacheEntry(source.url)
        if (isValidCache(cached)) {
          groups = cached.data
        }

        // Priority 2: network
        if (!groups) {
          groups = await ChannelService.loadChannelsRobust(source.url, {
            skipCache: true,
            maxRetries: 1,
          })
        }

        if (!groups || groups.length === 0) {
          failCount++
          continue
        }

        const channels: ExportedChannel[] = []
        for (const group of groups) {
          for (const ch of group.liveChannels) {
            if (ch.channelUrls && ch.channelUrls.length > 0) {
              channels.push({
                name: ch.channelName,
                url: ch.channelUrls[ch.sourceIndex || 0] || ch.channelUrls[0],
                group: group.groupName,
                logo: ch.channelLogo || undefined,
                tvgId: ch.channelTvgId || undefined,
                tvgName: ch.channelTvgName || undefined,
              })
            }
          }
        }
        if (channels.length === 0) {
          failCount++
          continue
        }

        const m3uContent = exportToM3u(channels, source.name)
        const safeName = sanitizeFilename(source.name)
        const filePath = dirPath + '\\' + safeName + '.m3u'
        const saveResult = await window.electronAPI!.writeFile(filePath, m3uContent)
        if (saveResult && saveResult.success) {
          successCount++
        } else {
          failCount++
        }
      } catch (e: any) {
        logger.warn('[SourceManager] Export failed for ' + source.name, e)
        failCount++
      }
    }

    ElMessage.success(`导出完成: ${successCount} 个成功${failCount > 0 ? `, ${failCount} 个失败` : ''}`)
  } catch (e: any) {
    ElMessage.error('批量导出失败: ' + (e.message || '未知错误'))
  }
}

function extractChannelsFromCurrentGroups(): ExportedChannel[] {
  const channels: ExportedChannel[] = []
  for (const group of store.channelGroups) {
    for (const ch of group.liveChannels) {
      if (ch.channelUrls && ch.channelUrls.length > 0) {
        channels.push({
          name: ch.channelName,
          url: ch.channelUrls[ch.sourceIndex || 0] || ch.channelUrls[0],
          group: group.groupName,
          logo: ch.channelLogo || undefined,
          tvgId: ch.channelTvgId || undefined,
          tvgName: ch.channelTvgName || undefined,
        })
      }
    }
  }
  return channels
}

</script>

<style scoped>
.source-root {
  height: 100%;
}

.source-manager-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1a1a2e;
  border-left: 1px solid #2a2a3e;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

.panel-count {
  font-size: 11px;
  color: #555;
}

.close-btn {
  color: #666 !important;
  padding: 4px !important;
  font-size: 18px !important;
}

.close-btn:hover {
  color: #fff !important;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px 10px;
}

.toolbar-spacer {
  flex: 1;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 0 12px;
  scrollbar-width: thin;
  scrollbar-color: #4a4a6a #1a1a2e;
}

.panel-body::-webkit-scrollbar {
  width: 8px;
}

.panel-body::-webkit-scrollbar-track {
  background: #1a1a2e;
  border-radius: 4px;
}

.panel-body::-webkit-scrollbar-thumb {
  background: #4a4a6a;
  border-radius: 4px;
  border: 2px solid #1a1a2e;
}

.panel-body::-webkit-scrollbar-thumb:hover {
  background: #6a6a8a;
}

.panel-footer {
  padding: 8px 14px;
  border-top: 1px solid #2a2a3e;
  flex-shrink: 0;
}

.footer-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}

.shortcut {
  font-size: 10px;
  color: #555;
}

.section {
  padding: 0 12px 12px;
}

.section + .section {
  border-top: 1px solid #222238;
  padding-top: 12px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.source-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.source-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.source-item.active {
  background: rgba(79, 195, 247, 0.08);
  border: 1px solid rgba(79, 195, 247, 0.2);
}

.source-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.source-indicator {
  color: #4fc3f7;
  font-size: 10px;
  flex-shrink: 0;
}

.source-health {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; margin-right: 4px;
}
.health-green { background: #4ade80; box-shadow: 0 0 4px rgba(74,222,128,0.6); }
.health-yellow { background: #facc15; box-shadow: 0 0 4px rgba(250,204,21,0.6); }
.health-red { background: #f87171; box-shadow: 0 0 4px rgba(248,113,113,0.6); }
.health-gray { background: #555; }

.source-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.source-name {
  font-size: 13px;
  color: #e0e0e0;
  font-weight: 500;
}

.source-count {
  font-size: 11px;
  color: #4caf50;
  font-weight: 400;
  margin-left: 2px;
}

.source-item.active .source-name {
  color: #4fc3f7;
}

.source-url {
  font-size: 11px;
  color: #555;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}

.source-geo { font-size: 10px; color: #888; margin-top: 1px; }

.source-actions {
  display: flex;
  gap: 2px;
  margin-left: 4px;
}

.source-actions .el-button {
  color: #666 !important;
  padding: 2px 4px !important;
}

.source-actions .el-button:hover {
  color: #fff !important;
}

.empty-state {
  padding: 30px 20px;
  text-align: center;
  color: #555;
  font-size: 13px;
}

.error-state {
  padding: 12px 14px;
  margin: 4px 0;
  background: rgba(229, 115, 115, 0.1);
  border: 1px solid rgba(229, 115, 115, 0.25);
  border-radius: 6px;
  color: #e57373;
  font-size: 13px;
  line-height: 1.5;
}

.import-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: #ccc;
}

.result-text {
  flex: 1;
}

.result-error {
  padding: 10px 14px;
  background: rgba(229, 115, 115, 0.1);
  border-radius: 6px;
  color: #e57373;
  font-size: 13px;
  line-height: 1.5;
}
</style>