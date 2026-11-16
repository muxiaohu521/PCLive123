import { ref } from 'vue'

// ============ 投屏外壳协作抽象（模块级单例） ============
// 投屏面板（DlnaPanel）与左上角最小化状态栏（TaskStatusBar）共享投屏会话状态。
// DlnaPanel 负责投屏生命周期并同步会话信息；状态栏据此展示「投屏」入口与停止按钮。

export interface CastSession {
  kind: 'tvlive' | 'dlna'
  deviceName: string
  host: string
  format: string
  quality: string
  startedAt: number
}

export const castSession = ref<CastSession | null>(null)
// 投屏最小化时间戳：用于状态栏「工具箱 / 投屏 / 录屏 / 下载」按打开顺序排序
export const castMinimizedAt = ref(0)

let castStopHook: (() => void) | null = null

export function registerCastStopHook(fn: () => void): () => void {
  castStopHook = fn
  return () => {
    if (castStopHook === fn) castStopHook = null
  }
}

export function stopCast(): void {
  if (!castStopHook) return
  try {
    castStopHook()
  } catch (e) {
    // 忽略投屏停止异常，避免影响状态栏收尾
  }
}

export function useCastShell() {
  return { castSession, castMinimizedAt, registerCastStopHook, stopCast }
}