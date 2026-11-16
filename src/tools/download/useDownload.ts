import { ref, computed, type ComputedRef } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'
import { playbackStreamHub } from '@/services/PlaybackStreamHub'
import { logger } from '@/utils/logger'
import { showBar } from '../shared/useToolShell'
import type { DownloadTaskUi } from '../types'

// ============ 流下载（多任务并发，模块级单例） ============
// 下载任务状态由主进程持久维护，事件监听与任务列表在多个入口（下载工具 / 工具菜单快捷启动）间共享。

const downloadUrl = ref('')
const downloadOutputDir = ref('')
const downloadCleanupMode = ref<'manual' | 'auto'>('manual')
const downloadMaxConcurrent = ref(3)
const downloadTasks = ref<DownloadTaskUi[]>([])
// 记录每个任务首次出现的时间戳，用于按打开顺序排序显示
const taskStartedAt = new Map<number, number>()

let downloadTitle: ComputedRef<string>
let currentDownloadUrl: ComputedRef<string>

let initialized = false

function ensureStartedAt(id: number, elapsed: number): number {
  let st = taskStartedAt.get(id)
  if (st == null) {
    st = Date.now() - (elapsed || 0) * 1000
    taskStartedAt.set(id, st)
  }
  return st
}

function upsertDownloadTask(task: DownloadTaskUi) {
  const startedAt = ensureStartedAt(task.id, task.elapsed)
  const merged = { ...task, startedAt }
  const i = downloadTasks.value.findIndex(t => t.id === task.id)
  if (i >= 0) downloadTasks.value[i] = merged
  else downloadTasks.value.unshift(merged)
}

/** 进行中的下载任务（按启动时间升序，即打开顺序） */
const activeDownloads = computed(() => {
  return downloadTasks.value
    .filter(t => t.status === 'queued' || t.status === 'downloading' || t.status === 'merging')
    .slice()
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
})

function taskBadgeText(t: DownloadTaskUi) {
  switch (t.status) {
    case 'queued': return '排队中'
    case 'downloading': return '下载中'
    case 'merging': return '合并中'
    case 'done': return t.success ? '已完成' : (t.reason === 'stopped' ? '已停止' : '失败')
  }
  return ''
}

function taskBadgeClass(t: DownloadTaskUi) {
  switch (t.status) {
    case 'queued': return 'is-queued'
    case 'downloading': return 'is-downloading'
    case 'merging': return 'is-merging'
    case 'done': return t.success ? 'is-done' : 'is-failed'
  }
  return ''
}

function useCurrentChannel() {
  // 仅支持真实网络流地址；本地视频 / 网页线路已被 currentDownloadUrl 拦截
  const url = currentDownloadUrl.value
  if (url) {
    downloadUrl.value = url
  }
}

async function selectDownloadFolder() {
  if (!window.electronAPI?.downloadSelectFolder) return
  const result = await window.electronAPI.downloadSelectFolder()
  if (result.success && result.directoryPath) {
    downloadOutputDir.value = result.directoryPath
  }
}

async function setMaxConcurrent() {
  if (!window.electronAPI?.downloadSetMaxConcurrent) return
  const result = await window.electronAPI.downloadSetMaxConcurrent(downloadMaxConcurrent.value)
  if (result.success && result.maxConcurrent) {
    downloadMaxConcurrent.value = result.maxConcurrent
  }
}

async function refreshDownloadTasks() {
  if (!window.electronAPI?.downloadList) return
  const resp = await window.electronAPI.downloadList()
  if (!resp || !resp.success) return
  downloadTasks.value = resp.tasks.map(t => ({
    id: t.id,
    status: t.status,
    startedAt: ensureStartedAt(t.id, t.elapsed || 0),
    success: t.success,
    error: t.error || '',
    reason: t.reason || '',
    elapsed: t.elapsed || 0,
    segmentCount: t.segmentCount || 0,
    totalBytes: t.totalBytes || 0,
    outputFile: t.outputFile || '',
    outputDir: t.outputDir || '',
    segmentsDir: t.segmentsDir || '',
    cleanupMode: t.cleanupMode === 'auto' ? 'auto' : 'manual',
    title: t.title || '',
    url: t.url || '',
  }))
  if (resp.maxConcurrent) downloadMaxConcurrent.value = resp.maxConcurrent
}

async function startDownload() {
  const url = downloadUrl.value.trim()
  logger.info(`[下载] startDownload 触发 url=${url ? url.substring(0, 160) : '(空)'}`)
  if (!url) {
    logger.warn('[下载] 下载地址为空，无法启动（当前播放模式/频道可能无可用直链）')
    return
  }
  // 下载模块不支持本地视频文件（本地文件无法通过流式下载抓取）
  if (/^file:\/\//i.test(url)) {
    logger.warn('[下载] 拒绝本地文件地址: ' + url)
    ElMessage.warning('下载模块不支持本地视频文件')
    return
  }
  if (!window.electronAPI?.downloadStart) {
    logger.error('[下载] window.electronAPI.downloadStart 不存在，无法启动下载')
    return
  }
  const store = useAppStore()
  const headers = playbackStreamHub.resolveStreamHeaders(store.floatSource)
  logger.info(`[下载] 准备调用 downloadStart: url=${url.substring(0, 160)} headersKeys=${JSON.stringify(Object.keys(headers))} format=${store.floatSource.format || ''} playMode=${store.activePlayMode} title=${downloadTitle.value || ''} outputDir=${downloadOutputDir.value || '(默认)'}`)
  const result = await window.electronAPI.downloadStart({
    url,
    headers,
    outputDir: downloadOutputDir.value,
    cleanupMode: downloadCleanupMode.value,
    title: downloadTitle.value || '',
  })
  logger.info(`[下载] downloadStart 返回: ${JSON.stringify(result)}`)
  if (!result.success) {
    logger.error('[下载] 启动失败: ' + (result.error || '未知错误'))
    alert('下载启动失败: ' + (result.error || '未知错误'))
    return
  }
  if (result.skipped) {
    logger.info('[下载] 任务被跳过: ' + (result.reason || ''))
    ElMessage.info(result.reason || '该频道已下载或正在下载')
    return
  }
  if (result.id != null) taskStartedAt.set(result.id, Date.now())
  showBar.value = true
  await refreshDownloadTasks()
}

async function stopDownload(taskId?: number) {
  if (!window.electronAPI?.downloadStop) return
  if (taskId == null) {
    const running = downloadTasks.value.filter(t => t.status !== 'done')
    for (const t of running) {
      await window.electronAPI.downloadStop(t.id).catch(() => {})
    }
    return
  }
  await window.electronAPI.downloadStop(taskId)
  await refreshDownloadTasks()
}

async function openDownloadFolder(taskId?: number, outputDir?: string) {
  if (!window.electronAPI?.downloadOpenFolder) return
  const result = await window.electronAPI.downloadOpenFolder(taskId, outputDir)
  if (!result.success) {
    alert('打开目录失败: ' + (result.error || '未知错误'))
  }
}

function handleDownloadProgress(data: DownloadProgressInfo) {
  if (!data || data.id == null) return
  upsertDownloadTask({
    id: data.id,
    status: data.status,
    success: false,
    error: '',
    reason: '',
    elapsed: data.elapsed || 0,
    segmentCount: data.segmentCount || 0,
    totalBytes: data.totalBytes || 0,
    outputFile: '',
    outputDir: data.outputDir || '',
    segmentsDir: data.segmentsDir || '',
    cleanupMode: 'manual',
    title: data.title || '',
    url: data.url || '',
  })
  showBar.value = true
}

function handleDownloadDone(data: DownloadDoneInfo) {
  if (!data || data.id == null) return
  if (data.success) {
    logger.info(`[下载] 任务 ${data.id} 完成: outputFile=${data.outputFile || ''} totalBytes=${data.totalBytes || 0} segments=${data.segmentCount || 0}`)
  } else {
    logger.error(`[下载] 任务 ${data.id} 失败: error=${data.error || '(无)'} reason=${data.reason || ''} url=${(data.url || '').substring(0, 160)}`)
  }
  upsertDownloadTask({
    id: data.id,
    status: 'done',
    success: !!data.success,
    error: data.error || '',
    reason: data.reason || '',
    elapsed: 0,
    segmentCount: data.segmentCount || 0,
    totalBytes: data.totalBytes || 0,
    outputFile: data.outputFile || '',
    outputDir: data.outputDir || '',
    segmentsDir: data.segmentsDir || '',
    cleanupMode: data.cleanupMode === 'auto' ? 'auto' : 'manual',
    title: data.title || '',
    url: data.url || '',
  })
}

function ensureInit() {
  if (initialized) return
  initialized = true

  const store = useAppStore()
  downloadTitle = computed(() => store.currentChannel?.channelName || '')
  // 当前可直接下载的统一直链。
  // 下载模块仅支持真实网络流地址；本地视频不支持下载，返回空以隐藏「使用当前频道」。
  currentDownloadUrl = computed(() => {
    const src = store.floatSource
    if (store.activePlayMode === 'local') {
      logger.debug('[下载] 当前为本地视频播放模式，不支持下载，直链置空')
      return ''
    }
    const resolved = playbackStreamHub.resolveStreamUrl(src)
    logger.debug(`[下载] 解析当前直链: playMode=${store.activePlayMode} sourceType=${src.type} url=${resolved ? resolved.substring(0, 120) : '(空)'}`)
    return resolved
  })

  if (window.electronAPI?.onDownloadProgress) {
    window.electronAPI.onDownloadProgress(handleDownloadProgress)
  }
  if (window.electronAPI?.onDownloadDone) {
    window.electronAPI.onDownloadDone(handleDownloadDone)
  }

  const initialUrl = currentDownloadUrl.value
  if (initialUrl) {
    downloadUrl.value = initialUrl
  }
  void refreshDownloadTasks()
}

export function useDownload() {
  ensureInit()
  return {
    downloadUrl,
    downloadOutputDir,
    downloadCleanupMode,
    downloadMaxConcurrent,
    downloadTasks,
    activeDownloads,
    downloadTitle,
    currentDownloadUrl,
    taskBadgeText,
    taskBadgeClass,
    useCurrentChannel,
    selectDownloadFolder,
    setMaxConcurrent,
    refreshDownloadTasks,
    startDownload,
    stopDownload,
    openDownloadFolder,
  }
}