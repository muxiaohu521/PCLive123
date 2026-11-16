import { ref } from 'vue'
import type { ToolKey } from '../types'

// ============ 工具外壳协作抽象（模块级单例） ============
// 最小化状态栏的可见性由多个工具与外壳共同读写，因此放在模块级共享。
// 统一停止钩子用于替代原先硬编码的 killAllTools 逻辑：
// 各工具在启动时注册「如何停止自己」，外壳关闭对话框时统一调用。

export const showBar = ref(false)
export const isMinimizing = ref(false)
// 工具箱最小化时间戳：用于状态栏中「工具箱 / 录屏 / 下载」按打开顺序排序
export const minimizedAt = ref(0)
// 当前选中的工具 tab：外壳渲染标签栏，工具据此响应激活（如嗅探输入框聚焦）
export const activeTab = ref<ToolKey>('connectivity')

const stopHooks = new Set<() => void>()

export function registerStopHook(fn: () => void): () => void {
  stopHooks.add(fn)
  return () => {
    stopHooks.delete(fn)
  }
}

export function killAllTools(): void {
  stopHooks.forEach((fn) => {
    try {
      fn()
    } catch (e) {
      // 忽略单个工具的停止异常，避免影响其它工具收尾
    }
  })
}

export function useToolShell() {
  return { showBar, isMinimizing, minimizedAt, activeTab, registerStopHook, killAllTools }
}