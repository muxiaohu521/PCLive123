/**
 * BasePluginInstance — 插件实例的事件基类
 *
 * 提供统一的 on / off / emit 事件能力，避免各引擎适配器重复实现事件分发逻辑。
 */

import type { EngineKind, PlayContext, PluginEventName, PluginEventHandler, PluginInstance } from './types'

export abstract class BasePluginInstance implements PluginInstance {
  abstract readonly pluginId: string
  abstract readonly kind: EngineKind
  abstract attach(target: HTMLVideoElement | HTMLElement, context: PlayContext): void | Promise<void>
  abstract destroy(): void

  private handlers = new Map<PluginEventName, Set<PluginEventHandler>>()

  on(event: PluginEventName, handler: PluginEventHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
  }

  off(event: PluginEventName, handler: PluginEventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  protected emit(event: PluginEventName, ...args: any[]): void {
    this.handlers.get(event)?.forEach((fn) => {
      try {
        fn(...args)
      } catch (_) {
        /* 静默吞掉回调异常，避免引擎事件回调影响主流程 */
      }
    })
  }
}