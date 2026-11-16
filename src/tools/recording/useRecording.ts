import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '@/store'
import { useRecorder } from '@/composables/useRecorder'
import { showBar } from '../shared/useToolShell'

// 模块级单例：录屏参数在主窗口全局共享（录屏工具 UI 与「工具」菜单快捷启动共用）
const recordingQuality = ref('high')
const recordingOutputPath = ref('')

let recorder: ReturnType<typeof useRecorder> | null = null

function getRecorder() {
  if (!recorder) recorder = useRecorder()
  return recorder
}

async function selectOutputPath() {
  if (!window.electronAPI?.recordingSelectOutput) return
  const result = await window.electronAPI.recordingSelectOutput()
  if (result.success && result.path) {
    recordingOutputPath.value = result.path
  }
}

async function openRecordingFolder() {
  if (!window.electronAPI?.recordingOpenFolder) return
  const result = await window.electronAPI.recordingOpenFolder(recordingOutputPath.value)
  if (!result.success) {
    alert('打开目录失败: ' + (result.error || '未知错误'))
  }
}

async function startRecording() {
  const store = useAppStore()
  // 检查是否有可录制的播放源
  if (store.floatSource.type === 'none') {
    ElMessage.warning('当前没有正在播放的内容，请先开始播放')
    return
  }

  const ok = await getRecorder().startRecording({
    outputPath: recordingOutputPath.value || '',
    quality: recordingQuality.value,
  })
  if (!ok) {
    ElMessage.warning('录屏启动失败：当前播放模式无法获取视频流（外部播放器 / 网页版不支持直录）')
    return
  }
  showBar.value = true
  ElMessage.success('录屏已启动')
}

async function stopRecording() {
  await getRecorder().stopRecording()
}

async function toggleRecordPause() {
  const r = getRecorder()
  if (r.state.value === 'recording') {
    await r.pauseRecording()
  } else if (r.state.value === 'paused') {
    await r.resumeRecording()
  }
}

export function useRecording() {
  const r = getRecorder()
  return {
    recordingQuality,
    recordingOutputPath,
    recordState: r.state,
    recordElapsed: r.elapsed,
    recordStatusText: r.statusText,
    recordStartedAt: r.startedAt,
    selectOutputPath,
    openRecordingFolder,
    startRecording,
    stopRecording,
    toggleRecordPause,
  }
}