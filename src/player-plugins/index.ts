/**
 * player-plugins — 统一入口
 *
 * 导出插件体系的全部公共 API，并在首次引入时注册所有内置播放引擎插件。
 * 播放器层（VideoPlayer）只需 `import { pluginRegistry, registerBuiltinPlugins } from '@/player-plugins'`。
 */

import { pluginRegistry } from './registry'
import { nativePlugin } from './plugins/native.plugin'
import { audioPlugin } from './plugins/audio.plugin'
import { hlsPlugin } from './plugins/hls.plugin'
import { mpegtsPlugin } from './plugins/mpegts.plugin'
import { dashJsPlugin } from './plugins/dash.plugin'
import { webTorrentPlugin } from './plugins/webtorrent.plugin'

export * from './types'
export { BasePluginInstance } from './base'
export { pluginRegistry, PluginRegistry } from './registry'
export type { CapabilityEntry } from './registry'
export { dashJsPlugin } from './plugins/dash.plugin'
export { webTorrentPlugin } from './plugins/webtorrent.plugin'

/** 内置播放引擎插件清单 */
const builtinPlugins = [
  nativePlugin,
  audioPlugin,
  hlsPlugin,
  mpegtsPlugin,
  dashJsPlugin,
  webTorrentPlugin,
]

let builtinsRegistered = false

/** 注册全部内置插件（幂等，重复调用安全） */
export function registerBuiltinPlugins(): void {
  if (builtinsRegistered) return
  for (const plugin of builtinPlugins) pluginRegistry.register(plugin)
  builtinsRegistered = true
}

/** 模块首次引入即完成内置插件注册 */
registerBuiltinPlugins()