<template>
  <div
    class="float-container"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
    @dblclick="onDblClick"
  >
    <div class="float-drag-bar"></div>

    <video
      ref="videoEl"
      class="float-video"
      autoplay
      playsinline
      muted
      @playing="onPlaying"
      @waiting="onWaiting"
      @pause="onPause"
      @error="onVideoError"
    ></video>

    <div v-if="connecting" class="float-loading">
      <div class="float-spinner"></div>
      <p>正在连接主窗口...</p>
    </div>

    <div v-if="error" class="float-error">{{ error }}</div>

    <div class="float-overlay" :class="{ 'float-overlay--visible': overlayVisible }"></div>

    <div class="float-bottom-bar" :class="{ 'float-bottom-bar--visible': overlayVisible }">
      <button class="float-icon-btn" @click.stop="toggleMute" :title="muted ? '取消静音' : '静音'">
        <svg v-if="muted || vol === 0" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M2 6L5 6L9 2L9 16L5 12L2 12Z" fill="currentColor"/>
          <line x1="12" y1="6" x2="16" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="16" y1="6" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        <svg v-else-if="vol > 0.5" width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M2 6L5 6L9 2L9 16L5 12L2 12Z" fill="currentColor"/>
          <path d="M12 5.5C13.3 6.7 14 8.3 14 10C14 11.7 13.3 13.3 12 14.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        <svg v-else width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M2 6L5 6L9 2L9 16L5 12L2 12Z" fill="currentColor"/>
          <path d="M11.5 7C12.2 7.8 12.5 8.9 12.5 10C12.5 11.1 12.2 12.2 11.5 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </button>
      <div class="float-volume-slider-wrap" @click.stop @mouseenter="onSliderEnter" @mouseleave="onSliderLeave">
        <input
          type="range"
          class="float-volume-slider"
          min="0"
          max="100"
          :value="Math.round(vol * 100)"
          @input="onVolumeChange"
        />
      </div>
      <button class="float-icon-btn float-close-btn-bottom" @click.stop="handleClose" title="关闭">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  </div>
</template><script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { logger } from '@/utils/logger'

const videoEl = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const connecting = ref(true)
const error = ref('')
const muted = ref(true)
const vol = ref(1.0)
const overlayVisible = ref(true)

let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null
const OVERLAY_HIDE_DELAY = 2000

function showOverlay() {
  overlayVisible.value = true
  if (hideOverlayTimer) clearTimeout(hideOverlayTimer)
}

function scheduleHide() {
  if (hideOverlayTimer) clearTimeout(hideOverlayTimer)
  if (playing.value) {
    hideOverlayTimer = setTimeout(() => { overlayVisible.value = false }, OVERLAY_HIDE_DELAY)
  }
}

function onMouseMove() { showOverlay(); scheduleHide() }
function onMouseLeave() { if (hideOverlayTimer) clearTimeout(hideOverlayTimer); overlayVisible.value = false }

async function onDblClick() {
  await window.electronAPI?.toggleFloatFullscreen()
}

async function handleClose() {
  await window.electronAPI?.mirrorSignal({ type: 'control', action: 'close' })
  await window.electronAPI?.closeFloatWindow()
}

function toggleMute() {
  muted.value = !muted.value
  if (videoEl.value) videoEl.value.muted = muted.value
}

function onVolumeChange(e: Event) {
  const v = (e.target as HTMLInputElement).valueAsNumber / 100
  vol.value = v
  if (videoEl.value) videoEl.value.volume = v
  if (v > 0 && muted.value) { muted.value = false; videoEl.value!.muted = false }
}

function onSliderEnter() { if (hideOverlayTimer) clearTimeout(hideOverlayTimer) }
function onSliderLeave() { scheduleHide() }

// --- WebRTC ---
let mirrorPC: RTCPeerConnection | null = null
let cleanupSignal: (() => void) | null = null
let iceCandidatesBuffer: RTCIceCandidateInit[] = []

function onPlaying() { logger.log('[FloatView] onPlaying'); connecting.value = false; playing.value = true; error.value = ''; scheduleHide() }
function onWaiting() { logger.log('[FloatView] onWaiting'); connecting.value = true; playing.value = false; showOverlay() }
function onPause() { logger.log('[FloatView] onPause'); playing.value = false; showOverlay() }
function onVideoError() { logger.warn('[FloatView] onVideoError'); connecting.value = false; error.value = '视频流中断' }

async function startReceiving() {
  const api = window.electronAPI
  if (!api) { logger.warn('[FloatView] electronAPI not available'); return }
  mirrorPC = createPeerConnection()

  function createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    pc.ontrack = (event) => {
      const v = videoEl.value
      if (v && event.streams[0]) { v.srcObject = event.streams[0]; connecting.value = false }
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const c = event.candidate
        api!.mirrorSignal({ type: 'ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } })
      }
    }
    pc.onconnectionstatechange = () => {
      if (mirrorPC?.connectionState === 'failed' || mirrorPC?.connectionState === 'disconnected') {
        error.value = '连接断开'; connecting.value = true
      }
    }
    return pc
  }

  async function handleOffer(sdp: any) {
    if (mirrorPC) mirrorPC.close()
    mirrorPC = createPeerConnection()
    iceCandidatesBuffer = []; error.value = ''; connecting.value = true
    await mirrorPC.setRemoteDescription(new RTCSessionDescription(sdp))
    await Promise.all(iceCandidatesBuffer.map(c => mirrorPC!.addIceCandidate(new RTCIceCandidate(c))))
    iceCandidatesBuffer = []
    const answer = await mirrorPC.createAnswer()
    await mirrorPC.setLocalDescription(answer)
    api!.mirrorSignal({ type: 'answer', sdp: { type: mirrorPC!.localDescription!.type, sdp: mirrorPC!.localDescription!.sdp } })
  }

  async function handleIce(candidate: any) {
    if (candidate?.sdpMid !== null || candidate?.sdpMLineIndex !== null) {
      if (mirrorPC!.remoteDescription) await mirrorPC!.addIceCandidate(new RTCIceCandidate(candidate))
      else iceCandidatesBuffer.push(candidate)
    }
  }

  cleanupSignal = api.onMirrorSignal(async (data: any) => {
    try {
      if (data.type === 'offer') await handleOffer(data.sdp)
      else if (data.type === 'ice') await handleIce(data.candidate)
    } catch (e: any) { error.value = '连接失败: ' + (e.message || ''); connecting.value = false }
  })
  api.mirrorSignal({ type: 'ready' })
}

function stopReceiving() {
  if (mirrorPC) { mirrorPC.close(); mirrorPC = null }
  if (cleanupSignal) { cleanupSignal(); cleanupSignal = null }
  if (videoEl.value) videoEl.value.srcObject = null
}

onMounted(() => startReceiving())
onUnmounted(() => {
  stopReceiving()
  if (hideOverlayTimer) clearTimeout(hideOverlayTimer)
})
</script>
<style scoped>
.float-container {
  position: fixed; inset: 0; background: #000;
  -webkit-app-region: no-drag; cursor: default; user-select: none;
}

.float-drag-bar {
  position: absolute; top: 0; left: 0; right: 0; height: 28px; z-index: 15;
  -webkit-app-region: drag;
}

.float-video {
  display: block; width: 100%; height: 100%; object-fit: contain; background: #000;
}

.float-loading, .float-error {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; z-index: 20;
}
.float-loading { color: #aaa; font-size: 13px; background: rgba(0,0,0,0.55); }
.float-spinner { width: 28px; height: 28px; border: 2px solid #444; border-top-color: #60a5fa; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 10px; }
@keyframes spin { to { transform: rotate(360deg); } }
.float-error { color: #f87171; font-size: 14px; background: rgba(0,0,0,0.7); }

.float-overlay {
  position: absolute; inset: 0; z-index: 10;
  opacity: 0; transition: opacity 0.25s ease; pointer-events: none;
}
.float-overlay--visible { opacity: 1; }



.float-bottom-bar {
  position: absolute; bottom: 0; left: 0; right: 0;
  height: 44px; padding: 0 10px 6px;
  display: flex; align-items: flex-end; gap: 6px;
  background: linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.2) 60%, transparent 100%);
  z-index: 25;
  opacity: 0; pointer-events: none;
  transition: opacity 0.25s ease;
  -webkit-app-region: no-drag;
}
.float-bottom-bar--visible {
  opacity: 1; pointer-events: auto;
}

.float-icon-btn {
  width: 32px; height: 32px; border-radius: 6px; background: transparent;
  border: none; color: rgba(255,255,255,0.85); cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
  -webkit-app-region: no-drag; transition: background 0.15s ease; flex-shrink: 0;
}
.float-icon-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
.float-icon-btn:active { background: rgba(255,255,255,0.2); }
.float-close-btn-bottom { margin-left: auto; }
.float-close-btn-bottom:hover { background: rgba(220,38,38,0.55); color: #fff; }
.float-close-btn-bottom:active { background: rgba(220,38,38,0.75); }

.float-volume-slider-wrap { display: flex; align-items: center; height: 32px; padding: 0 2px; }
.float-volume-slider {
  width: 72px; height: 3px; -webkit-appearance: none; appearance: none;
  background: rgba(255,255,255,0.25); border-radius: 2px; outline: none; cursor: pointer;
  transition: height 0.1s ease;
}
.float-volume-slider:hover { height: 4px; }
.float-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%;
  background: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  transition: transform 0.1s ease;
}
.float-volume-slider::-webkit-slider-thumb:hover { transform: scale(1.15); }
</style>