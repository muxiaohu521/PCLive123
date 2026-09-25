<template>
  <div class="float-container">
    <div class="float-video-wrapper">
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

      <div class="float-controls" @mouseenter="showCtrl = true" @mouseleave="showCtrl = false">
        <div v-show="showCtrl || !playing" class="float-ctrl-bar">
          <button class="float-btn float-play-btn" @click.stop="sendControl('togglePlay')">
            {{ playing ? '⏸' : '▶' }}
          </button>
          <div class="float-title">镜像同步</div>
          <div class="float-volume-group" @click.stop @mouseenter="showSlider" @mouseleave="hideSlider">
            <button
              class="float-btn"
              :title="muted ? '取消静音' : '静音'"
              @click="toggleMute"
            >{{ muted ? '🔇' : vol > 0.5 ? '🔊' : vol > 0 ? '🔉' : '🔈' }}</button>
            <input
              v-show="showVolumeSlider"
              type="range"
              class="float-volume-slider"
              min="0"
              max="100"
              :value="Math.round(vol * 100)"
              @input="onVolumeChange"
            />
          </div>
          <button class="float-btn" @click.stop="sendControl('close')">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const videoEl = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const connecting = ref(true)
const error = ref('')
const showCtrl = ref(true)
const muted = ref(true)
const vol = ref(1.0)
const showVolumeSlider = ref(false)

let hideSliderTimer: ReturnType<typeof setTimeout> | null = null

function toggleMute() {
  muted.value = !muted.value
  if (videoEl.value) {
    videoEl.value.muted = muted.value
  }
}

function onVolumeChange(e: Event) {
  const v = (e.target as HTMLInputElement).valueAsNumber / 100
  vol.value = v
  if (videoEl.value) {
    videoEl.value.volume = v
  }
  if (v > 0 && muted.value) {
    muted.value = false
    videoEl.value!.muted = false
  }
}

function showSlider() {
  showVolumeSlider.value = true
  if (hideSliderTimer) clearTimeout(hideSliderTimer)
}

function hideSlider() {
  hideSliderTimer = setTimeout(() => { showVolumeSlider.value = false }, 400)
}

let mirrorPC: RTCPeerConnection | null = null
let cleanupSignal: (() => void) | null = null
let iceCandidatesBuffer: RTCIceCandidateInit[] = []

function onPlaying() { connecting.value = false; playing.value = true; error.value = '' }
function onWaiting() { connecting.value = true; playing.value = false }
function onPause() { playing.value = false }
function onVideoError() {
  connecting.value = false
  error.value = '视频流中断'
}

function sendControl(action: string, payload?: any) {
  window.electronAPI?.mirrorSignal({ type: 'control', action, payload })
}

async function startReceiving() {
  const api = window.electronAPI
  if (!api) return

  mirrorPC = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  })

  mirrorPC.ontrack = (event) => {
    const v = videoEl.value
    if (v && event.streams[0]) {
      v.srcObject = event.streams[0]
      connecting.value = false
    }
  }

  mirrorPC.onicecandidate = (event) => {
    if (event.candidate) {
      const c = event.candidate
      api.mirrorSignal({
        type: 'ice',
        candidate: {
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
        }
      })
    }
  }

  mirrorPC.onconnectionstatechange = () => {
    if (mirrorPC?.connectionState === 'failed' || mirrorPC?.connectionState === 'disconnected') {
      error.value = '连接断开'
      connecting.value = true
    }
  }

  cleanupSignal = api.onMirrorSignal(async (data: any) => {
    try {
      if (data.type === 'offer') {
        await mirrorPC!.setRemoteDescription(new RTCSessionDescription(data.sdp))
        await Promise.all(iceCandidatesBuffer.map(c => mirrorPC!.addIceCandidate(new RTCIceCandidate(c))))
        iceCandidatesBuffer = []
        const answer = await mirrorPC!.createAnswer()
        await mirrorPC!.setLocalDescription(answer)
        api.mirrorSignal({
          type: 'answer',
          sdp: { type: mirrorPC!.localDescription!.type, sdp: mirrorPC!.localDescription!.sdp }
        })
      } else if (data.type === 'ice') {
        const c = data.candidate
        if (c && (c.sdpMid !== null || c.sdpMLineIndex !== null)) {
          if (mirrorPC!.remoteDescription) {
            await mirrorPC!.addIceCandidate(new RTCIceCandidate(c))
          } else {
            iceCandidatesBuffer.push(c)
          }
        }
      }
    } catch (e: any) {
      error.value = '连接建立失败: ' + (e.message || '')
      connecting.value = false
    }
  })

  // Notify main window that we're ready
  api.mirrorSignal({ type: 'ready' })
}

function stopReceiving() {
  if (mirrorPC) {
    mirrorPC.close()
    mirrorPC = null
  }
  if (cleanupSignal) {
    cleanupSignal()
    cleanupSignal = null
  }
  const v = videoEl.value
  if (v) {
    v.srcObject = null
  }
}

onMounted(() => {
  startReceiving()
})

onUnmounted(() => {
  stopReceiving()
  if (hideSliderTimer) clearTimeout(hideSliderTimer)
})
</script>

<style scoped>
.float-container {
  position: fixed;
  inset: 0;
  background: #000;
  -webkit-app-region: drag;
}
.float-video-wrapper {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  overflow: hidden;
  -webkit-app-region: drag;
}
.float-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}
.float-loading {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #aaa; font-size: 13px; background: rgba(0,0,0,0.6);
}
.float-spinner { width: 28px; height: 28px; border: 2px solid #444; border-top-color: #60a5fa; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 10px; }
@keyframes spin { to { transform: rotate(360deg); } }
.float-error { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #f87171; font-size: 14px; background: rgba(0,0,0,0.7); }
.float-controls { position: absolute; inset: 0; pointer-events: none; }
.float-ctrl-bar {
  position: absolute; bottom: 0; left: 0; right: 0; height: 36px; display: flex; align-items: center; gap: 6px; padding: 0 8px; background: linear-gradient(transparent, rgba(0,0,0,0.85)); pointer-events: auto;
  -webkit-app-region: no-drag;
}
.float-btn {
  background: none; border: none; color: #ccc; font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 3px;
  -webkit-app-region: no-drag;
}
.float-btn:hover { color: #fff; background: rgba(255,255,255,0.15); }
.float-play-btn { font-size: 16px; }
.float-title { flex: 1; color: #ddd; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.float-volume-group { display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
.float-volume-slider { width: 60px; height: 4px; -webkit-appearance: none; appearance: none; background: #555; border-radius: 2px; outline: none; cursor: pointer; }
.float-volume-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #60a5fa; cursor: pointer; }
.float-close-btn:hover { background: rgba(255,60,60,0.3); color: #f87171; }
</style>