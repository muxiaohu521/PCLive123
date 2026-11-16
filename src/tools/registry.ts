import { defineAsyncComponent, type Component } from 'vue'
import type { ToolKey } from './types'

// ============ 工具箱注册表 ============
// 统一维护工具元数据与懒加载组件。
// 主界面启动时不加载任何工具代码，仅在首次切换到对应 tab 时才按需加载。

export interface ToolMeta {
  key: ToolKey
  label: string
  loader: () => Promise<{ default: Component }>
}

const toolMetas: ToolMeta[] = [
  { key: 'connectivity', label: '🔍 连通性测试', loader: () => import('./connectivity/ConnectivityTool.vue') },
  { key: 'sniffer', label: '🕵️ URL嗅探', loader: () => import('./sniffer/SnifferTool.vue') },
  { key: 'geoip', label: '🌍 IP查询', loader: () => import('./geoip/GeoIpTool.vue') },
  { key: 'recording', label: '🎬 录屏', loader: () => import('./recording/RecordingTool.vue') },
  { key: 'download', label: '⬇️ 下载', loader: () => import('./download/DownloadTool.vue') },
  { key: 'cast', label: '📡 投屏', loader: () => import('./cast/CastTool.vue') },
]

export const toolTabs = toolMetas.map(m => ({ key: m.key, label: m.label }))

export function isToolKey(value: string): value is ToolKey {
  return toolMetas.some(m => m.key === value)
}

// 缓存懒加载组件包装器，避免每次解析都创建新的 defineAsyncComponent 实例
const componentCache = new Map<ToolKey, Component>()

export function resolveToolComponent(key: ToolKey) {
  const meta = toolMetas.find(m => m.key === key)
  if (!meta) return null
  let comp = componentCache.get(key)
  if (!comp) {
    comp = defineAsyncComponent(meta.loader)
    componentCache.set(key, comp)
  }
  return comp
}