/**
 * PluginRegistry — 插件注册中心
 *
 * 职责：
 * - 注册 / 注销播放引擎插件
 * - 按格式查找可用插件（优先级降序）
 * - 选择最优引擎（resolve）
 * - 生成能力报告（供 UI 展示与日志）
 *
 * 播放器（VideoPlayer）不直接依赖具体引擎，只通过本注册中心与引擎解耦。
 */

import { logger } from '@/utils/logger'
import type { MediaFormat, PlayContext, PlayerPlugin } from './types'

export interface CapabilityEntry {
  id: string
  name: string
  kind: string
  formats: string[]
  available: boolean
  priority: number
  supportsLive: boolean
  usesMse: boolean
  packageName?: string
}

export class PluginRegistry {
  private plugins = new Map<string, PlayerPlugin>()

  register(plugin: PlayerPlugin): void {
    if (this.plugins.has(plugin.id)) {
      logger.warn(`[PluginRegistry] plugin already registered, replaced: ${plugin.id}`)
    }
    this.plugins.set(plugin.id, plugin)
    logger.info(
      `[PluginRegistry] registered: ${plugin.id} kind=${plugin.kind} formats=[${plugin.formats.join(',')}] available=${plugin.isAvailable()}`,
    )
  }

  unregister(id: string): boolean {
    return this.plugins.delete(id)
  }

  get(id: string): PlayerPlugin | undefined {
    return this.plugins.get(id)
  }

  list(): PlayerPlugin[] {
    return Array.from(this.plugins.values())
  }

  /** 查找能播放指定格式且当前环境可用的插件，按优先级降序 */
  findForFormat(format: MediaFormat, context?: Partial<PlayContext>): PlayerPlugin[] {
    return this.list()
      .filter((p) => p.isAvailable() && p.canPlay(format, context))
      .sort((a, b) => b.priority - a.priority)
  }

  /** 选择指定格式的最优引擎 */
  resolve(format: MediaFormat, context?: Partial<PlayContext>): PlayerPlugin | undefined {
    return this.findForFormat(format, context)[0]
  }

  /** 能力报告：列出所有插件及其支持的格式与可用状态 */
  report(): CapabilityEntry[] {
    return this.list().map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      formats: [...p.formats],
      available: p.isAvailable(),
      priority: p.priority,
      supportsLive: p.supportsLive,
      usesMse: p.usesMse,
      packageName: p.packageName,
    }))
  }
}

/** 全局唯一的插件注册中心 */
export const pluginRegistry = new PluginRegistry()