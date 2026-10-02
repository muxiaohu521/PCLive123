/**
 * useSubtitle — 字幕管理 composable（模块级单例，跨组件共享状态）
 *
 * 职责：
 * - 加载字幕文件（打开文件对话框 + 解析 + 转 VTT）—— 由设置面板调用
 * - 记忆上次加载的字幕路径，启动时自动恢复
 * - 管理 Blob URL 生命周期
 * - 切换字幕显隐 —— 由播放器 CC 按钮调用
 *
 * 播放器只接收 { vttUrl, show } 并应用到 artplayer.subtitle
 */

import { ref } from 'vue'
import { logger } from '@/utils/logger'
import { parseSubtitle, cuesToVtt } from '@/utils/SubtitleParser'

export interface SubtitleState {
  vttUrl: string | null
  enabled: boolean
  label: string
}

const SUBTITLE_PATH_KEY = 'pclive_subtitle_path'

const subtitleEnabled = ref(false)
const subtitleLabel = ref('')
const subtitleVttUrl = ref<string | null>(null)

let _restored = false

function clearSubtitleBlob(): void {
  if (subtitleVttUrl.value) {
    URL.revokeObjectURL(subtitleVttUrl.value)
    subtitleVttUrl.value = null
  }
}

function _savePath(filePath: string): void {
  try { localStorage.setItem(SUBTITLE_PATH_KEY, filePath) } catch (_) {}
}

function _clearSavedPath(): void {
  try { localStorage.removeItem(SUBTITLE_PATH_KEY) } catch (_) {}
}

/** 通过文件路径静默读取并解析字幕 */
async function _loadFromPath(filePath: string): Promise<boolean> {
  if (!window.electronAPI) return false
  try {
    const result = await window.electronAPI.readFile(filePath)
    if (!result || result.error || !result.content) return false

    const cues = parseSubtitle(result.content)
    if (cues.length === 0) {
      logger.warn('[Subtitle] No valid cues in restored file, clearing saved path')
      _clearSavedPath()
      return false
    }

    clearSubtitleBlob()

    const vtt = cuesToVtt(cues)
    const blob = new Blob([vtt], { type: 'text/vtt' })
    subtitleVttUrl.value = URL.createObjectURL(blob)
    subtitleLabel.value = result.fileName || '字幕'
    subtitleEnabled.value = false

    logger.info(`[Subtitle] Restored: ${cues.length} cues from ${subtitleLabel.value}`)
    return true
  } catch (e: any) {
    logger.warn('[Subtitle] Failed to restore from saved path:', e.message)
    _clearSavedPath()
    return false
  }
}

export function useSubtitle() {
  if (!_restored) {
    _restored = true
    const savedPath = (() => { try { return localStorage.getItem(SUBTITLE_PATH_KEY) } catch (_) { return null } })()
    if (savedPath) {
      _loadFromPath(savedPath)
    }
  }

  /** 打开文件对话框并加载字幕 */
  async function loadSubtitleFile(): Promise<void> {
    if (!window.electronAPI) return
    try {
      const result = await window.electronAPI.openFileDialog({
        title: '选择字幕文件',
        filters: [
          { name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'ssa', 'txt'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (!result || result.error || !result.content) return

      const cues = parseSubtitle(result.content)
      if (cues.length === 0) {
        logger.warn('[Subtitle] No valid subtitle cues found in file')
        return
      }

      clearSubtitleBlob()

      const vtt = cuesToVtt(cues)
      const blob = new Blob([vtt], { type: 'text/vtt' })
      subtitleVttUrl.value = URL.createObjectURL(blob)
      subtitleLabel.value = result.fileName || '字幕'
      subtitleEnabled.value = true

      if (result.filePath) {
        _savePath(result.filePath)
      }

      logger.info(`[Subtitle] Loaded: ${cues.length} cues from ${subtitleLabel.value}`)
    } catch (e: any) {
      logger.error('[Subtitle] Load error:', e.message)
    }
  }

  /** 清空字幕状态 */
  function clearSubtitle(): void {
    clearSubtitleBlob()
    subtitleEnabled.value = false
    subtitleLabel.value = ''
    _clearSavedPath()
  }

  /** 切换字幕显隐（仅切换，不触发加载） */
  function toggleSubtitle(): void {
    if (!subtitleVttUrl.value) return
    subtitleEnabled.value = !subtitleEnabled.value
  }

  /** 获取当前字幕状态快照 */
  function getState(): SubtitleState {
    return {
      vttUrl: subtitleVttUrl.value,
      enabled: subtitleEnabled.value,
      label: subtitleLabel.value,
    }
  }

  /** 销毁：释放 Blob URL */
  function destroy(): void {
    clearSubtitleBlob()
    subtitleEnabled.value = false
    subtitleLabel.value = ''
  }

  return {
    subtitleEnabled,
    subtitleLabel,
    subtitleVttUrl,
    loadSubtitleFile,
    clearSubtitleBlob,
    clearSubtitle,
    toggleSubtitle,
    getState,
    destroy,
  }
}