/**
 * useSubtitle — 字幕管理 composable
 *
 * 职责：
 * - 加载字幕文件（打开文件对话框 + 解析 + 转 VTT）
 * - 管理 Blob URL 生命周期
 * - 切换字幕显隐
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

export function useSubtitle() {
  const subtitleEnabled = ref(false)
  const subtitleLabel = ref('')
  const subtitleVttUrl = ref<string | null>(null)

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

      // 清理旧 Blob URL
      clearSubtitleBlob()

      const vtt = cuesToVtt(cues)
      const blob = new Blob([vtt], { type: 'text/vtt' })
      subtitleVttUrl.value = URL.createObjectURL(blob)
      subtitleLabel.value = result.fileName || '字幕'
      subtitleEnabled.value = true

      logger.info(`[Subtitle] Loaded: ${cues.length} cues from ${subtitleLabel.value}`)
    } catch (e: any) {
      logger.error('[Subtitle] Load error:', e.message)
    }
  }

  /** 清除 Blob URL */
  function clearSubtitleBlob(): void {
    if (subtitleVttUrl.value) {
      URL.revokeObjectURL(subtitleVttUrl.value)
      subtitleVttUrl.value = null
    }
  }

  /** 清空字幕状态 */
  function clearSubtitle(): void {
    clearSubtitleBlob()
    subtitleEnabled.value = false
    subtitleLabel.value = ''
  }

  /** 切换字幕显隐 */
  function toggleSubtitle(): void {
    if (!subtitleVttUrl.value) {
      loadSubtitleFile()
      return
    }
    subtitleEnabled.value = !subtitleEnabled.value
  }

  /** 处理字幕按钮点击 */
  function handleSubtitleClick(): void {
    if (!subtitleVttUrl.value) {
      loadSubtitleFile()
      return
    }
    toggleSubtitle()
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
    handleSubtitleClick,
    getState,
    destroy,
  }
}