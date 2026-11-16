<template>
  <div class="video-player-container">
    <div ref="playerEl" class="video-inner" />
  </div>
</template>

<script setup lang="ts">
import { useVideoPlayer } from './video-player/useVideoPlayer'
import type { VideoPlayerProps, VideoPlayerEmits } from './video-player/types'

const props = defineProps<VideoPlayerProps>()
const emit = defineEmits<VideoPlayerEmits>()

const { playerEl, expose } = useVideoPlayer(props, emit)

defineExpose(expose)
</script>

<style scoped>
.video-player-container { width: 100%; height: 100%; position: relative; background: #000; }
.video-inner { width: 100%; height: 100%; background: #000; }
.video-inner :deep(.artplayer-app) { width: 100% !important; height: 100% !important; }
/* 覆盖 Artplayer 在鼠标静止后自动添加 .art-hide-cursor（cursor: none）的规则，
   让主界面视频窗口始终显示鼠标指针。 */
.video-inner :deep(.art-hide-cursor),
.video-inner :deep(.art-hide-cursor *) {
  cursor: default !important;
}
.video-inner :deep(.artplayer-controls) {
  width: 100% !important;
  left: 0 !important;
  right: 0 !important;
  pointer-events: auto !important;
  z-index: 50 !important;
}
.video-inner :deep(.artplayer-controls-right) {
  pointer-events: auto !important;
}
.video-inner :deep(.artplayer-control) {
  pointer-events: auto !important;
}
.video-inner :deep(.art-bottom) {
  overflow: visible !important;
  z-index: 9999 !important;
}
.video-inner :deep(.art-video-player:not(.art-control-show):not(.art-hover) .art-bottom) {
  opacity: 0 !important;
}
.video-inner :deep(.art-settings) {
  z-index: 99999 !important;
}
.video-inner :deep(.art-info) {
  z-index: 99999 !important;
}
.video-inner :deep(.art-contextmenus) {
  z-index: 99999 !important;
}
.video-inner :deep(.art-layers) {
  z-index: 99999 !important;
}
.video-inner :deep(.pclive-sub-indicator) {
  font-weight: 800; padding: 2px 6px; border-radius: 3px; font-size: 11px;
}
.video-inner :deep(.pclive-sub-indicator.on) { color: #4ade80; background: rgba(74,222,128,0.2); }
.video-inner :deep(.pclive-sub-indicator.off) { color: #666; }
.video-inner :deep(.pclive-float-btn) { font-size: 14px; padding: 2px 4px; cursor: pointer; }
.video-inner :deep(.pclive-float-btn:hover) { background: rgba(255,255,255,0.15); border-radius: 3px; }
.video-inner :deep(.pclive-decode-btn) {
  font-weight: 700; padding: 2px 6px; border-radius: 3px; font-size: 11px;
  cursor: pointer; color: #999; transition: all 0.2s;
}
.video-inner :deep(.pclive-decode-btn.decode-hw) { color: #4fc3f7; background: rgba(79,195,247,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-sw) { color: #ff9800; background: rgba(255,152,0,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-ff) { color: #66bb6a; background: rgba(102,187,106,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-mpv) { color: #f48fb1; background: rgba(244,143,177,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-vlc) { color: #ff8a65; background: rgba(255,138,101,0.2); }
.video-inner :deep(.pclive-decode-btn.decode-auto) { color: #b0b0b0; background: rgba(180,180,180,0.15); }
.video-inner :deep(.pclive-decode-btn:hover) { background: rgba(255,255,255,0.15); border-radius: 3px; }
.video-inner :deep(.pclive-playmode-btn) {
  color: #a78bfa; background: rgba(167,139,250,0.2); font-weight: 600;
  padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; transition: all 0.2s;
}
.video-inner :deep(.pclive-playmode-btn:hover) { background: rgba(167,139,250,0.35); color: #c4b5fd; }
</style>

<style>
.pclive-popup-overlay {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: transparent;
}
.pclive-popup-menu {
  background: #1e1e2e;
  border: 1px solid #3a3a4a;
  border-radius: 8px;
  padding: 4px 0;
  min-width: 100px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.55);
}
.pclive-popup-item {
  padding: 7px 16px;
  font-size: 12px;
  color: #aaa;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.pclive-popup-item:hover {
  background: rgba(255,255,255,0.08);
  color: #fff;
}
.pclive-popup-item.active {
  color: #fff;
  font-weight: 700;
  background: rgba(255,255,255,0.06);
}
.pclive-popup-item.decode-auto { color: #b0b0b0; }
.pclive-popup-item.decode-hw { color: #4fc3f7; }
.pclive-popup-item.decode-sw { color: #ff9800; }
.pclive-popup-item.decode-mpv { color: #f48fb1; }
.pclive-popup-item.decode-vlc { color: #ff8a65; }
.pclive-popup-item.decode-ff { color: #66bb6a; }
.pclive-popup-item:hover.decode-hw,
.pclive-popup-item:hover.decode-sw,
.pclive-popup-item:hover.decode-mpv,
.pclive-popup-item:hover.decode-vlc,
.pclive-popup-item:hover.decode-ff,
.pclive-popup-item:hover.decode-auto { color: #fff; }
</style>