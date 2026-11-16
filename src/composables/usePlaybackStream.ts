/**
 * usePlaybackStream — 统一流接口的应用层绑定
 *
 * 在 App.vue（主窗口）调用一次，把 store.floatSource（所有播放模式的统一播放源）
 * 接入 PlaybackStreamHub，并将功能模块注册为消费者：
 *
 *   - float（悬浮窗）：源描述经 floatSourceUpdate IPC 同步；画面/声音/状态经 WebRTC 实时镜像
 *   - cast（投屏）：维护统一直链地址，供 DlnaPanel 按需投屏
 *
 * 下载（download）不注册消费者：ToolsDialog 直接通过
 * playbackStreamHub.resolveStreamUrl / resolveStreamHeaders 从 store.floatSource
 * 解析统一直链，与 hub 内部 source 等价，无需维护冗余的中间 ref。
 *
 * 录屏（record）消费者由 useRecorder 独立注册与开关，录屏不再经本模块，
 * 而是直接从统一接口消费 MediaStream（见 useRecorder）。
 *
 * 仅当对应功能开启时才 enableConsumer，未开启的消费者不会被推送任何数据。
 */

import { ref, watch } from 'vue'
import { useAppStore } from '@/store'
import { playbackStreamHub } from '@/services/PlaybackStreamHub'
import type { PlaybackSource } from '@/services/PlaybackStreamHub'
import { restartFloatMirror, isFloatMirroring } from '@/composables/useMirrorStream'

/** 将统一播放源转成 floatSourceUpdate 需要的 IPC 载荷（悬浮窗使用） */
function toFloatSourcePayload(s: PlaybackSource) {
  return {
    type: s.type,
    url: s.url,
    headers: { ...(s.headers || {}) },
    format: s.format,
  }
}

export function usePlaybackStream() {
  const store = useAppStore()

  // 投屏功能的统一直链（由 cast 消费者在开启状态下维护，供 UI 层读取）
  const castSourceUrl = ref('')

  // 悬浮窗：源变化 → 同步给悬浮窗（画面/声音经 WebRTC 实时镜像，此处仅同步源描述）
  playbackStreamHub.registerConsumer('float', (frame) => {
    window.electronAPI?.floatSourceUpdate(toFloatSourcePayload(frame.source))
  })

  // 投屏：维护统一直链（DlnaPanel 按需读取）
  playbackStreamHub.registerConsumer('cast', (frame) => {
    castSourceUrl.value = playbackStreamHub.resolveStreamUrl(frame.source)
  })

  // 投屏功能开启（投屏面板显示）时才接收流数据
  watch(
    () => store.showDlna,
    (v) => {
      if (v) playbackStreamHub.enableConsumer('cast')
      else playbackStreamHub.disableConsumer('cast')
    },
    { immediate: true },
  )

  // 统一入口：任何 Artplayer 播放模式的播放源变化都从这里进入 hub
  watch(
    () => store.floatSource,
    (src) => {
      playbackStreamHub.publishSource(src)
      // 悬浮窗已打开时，切频道 / 切线路 / 切播放源 → 关闭并在「原位置附近」重建悬浮窗，
      // 触发全新的初始尺寸逻辑（最长边 480），避免被上一视频尺寸污染。
      // 软重置因 Electron resizable:false 的最小尺寸钳制而失效，只能走关闭重建。
      if (isFloatMirroring()) {
        void restartFloatMirror()
      }
    },
    { immediate: true },
  )

  return {
    playbackStreamHub,
    castSourceUrl,
    dispose() {},
  }
}