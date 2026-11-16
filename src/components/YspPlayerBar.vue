<template>
  <div
    class="ysp-player-bar"
    :class="{ 'bar-hidden': !barVisible, 'mode-webview': !isStreamMode, 'mode-stream': isStreamMode }"
    @mouseenter="onBarEnter"
    @mouseleave="onBarLeave"
  >
    <div class="bar-left">
      <!-- 频道切换 -->
      <button class="ctrl-btn" title="上一个频道 (←)" @click="$emit('prevChannel')">
        <span class="btn-icon">◁◁</span>
      </button>
      <button class="ctrl-btn" title="播放/暂停" @click="$emit('togglePlay')">
        <span class="btn-icon">{{ playing ? '⏸' : '▶' }}</span>
      </button>
      <button class="ctrl-btn" title="下一个频道 (→)" @click="$emit('nextChannel')">
        <span class="btn-icon">▷▷</span>
      </button>

      <div class="divider"></div>

      <!-- 线路切换 -->
      <button class="ctrl-btn" title="上一个线路" @click="$emit('prevRoute')" :disabled="routeCount <= 1">
        <span class="btn-icon">◀</span>
      </button>
      <span class="route-indicator">{{ currentRoute + 1 }}/{{ routeCount }}</span>
      <button class="ctrl-btn" title="下一个线路" @click="$emit('nextRoute')" :disabled="routeCount <= 1">
        <span class="btn-icon">▶</span>
      </button>

      <div class="divider"></div>

      <!-- 静音 -->
      <button class="ctrl-btn" title="静音" @click="onToggleMute">
        <span class="btn-icon">{{ muted ? '🔇' : '🔊' }}</span>
      </button>

      <!-- 音量滑块 -->
      <div class="volume-slider-wrap">
        <input
          type="range"
          class="volume-slider"
          min="0"
          max="100"
          :value="muted ? 0 : volume"
          @input="onVolumeInput"
          @change="onVolumeChange"
          title="音量"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'

const props = defineProps<{
  webviewEl: HTMLElement | null
  playing: boolean
  muted: boolean
  volume: number
  channelName: string
  routeName: string
  routeCount: number
  currentRoute: number
  isStreamMode: boolean
  isFullscreen: boolean
}>()

const emit = defineEmits<{
  prevChannel: []
  nextChannel: []
  togglePlay: []
  prevRoute: []
  nextRoute: []
  updateMuted: [muted: boolean]
  updateVolume: [volume: number]
}>()

const barVisible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null
const HIDE_DELAY_MS = 3000

function showBar() {
  barVisible.value = true
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => { barVisible.value = false }, HIDE_DELAY_MS)
}

function onBarEnter() {
  showBar()
}

function onBarLeave() {
  scheduleHide()
}

function exec<T = any>(code: string): Promise<T | undefined> {
  const wv = props.webviewEl
  if (!wv) return Promise.resolve(undefined)
  try {
    const api = wv as HTMLElement & { executeJavaScript?: (code: string) => Promise<T> }
    const p = api.executeJavaScript?.(code)
    // webview 尚未完成 dom-ready 时 executeJavaScript 返回的 Promise 会 reject，
    // 需要吞掉 reject，否则会触发 unhandledrejection。
    if (p && typeof (p as Promise<T>).catch === 'function') {
      return (p as Promise<T>).catch(() => undefined)
    }
    return Promise.resolve(undefined)
  } catch (_) {
    return Promise.resolve(undefined)
  }
}

// 安全地设置 webview 整体静音开关。
// 新 webview 在 dom-ready 之前调用 setAudioMuted 会抛出
// "The WebView must be attached to the DOM and the dom-ready event emitted..."，
// 因此这里吞掉异常，实际静音状态由后续 ensureAudio / audioPollTimer
// 通过 executeJavaScript 在页面内兜底应用。
function safeSetAudioMuted(muted: boolean) {
  const wv = props.webviewEl as any
  if (!wv || typeof wv.setAudioMuted !== 'function') return
  try {
    wv.setAudioMuted(muted)
  } catch (_) {
    /* ignore: webview not dom-ready yet */
  }
}

// ========== 静音 / 音量控制 ==========
// 关键：网页播放器的 video 常位于跨域 iframe 内（如 quklive），
// 且为满足浏览器自动播放策略会被强制 muted=true。取消静音时必须同时：
//   1) 调用 webview 的 setAudioMuted(false) 解除整个网页的声音开关；
//   2) 递归遍历顶层 document 与嵌套 iframe，把每个 video 的 muted/defaultMuted
//      置回目标值并移除 muted 属性。只调 setAudioMuted 或只查顶层 video 都无法恢复声音。

function buildAudioScript(muted: boolean, volume: number, applyVolume: boolean): string {
  const targetVolume = (volume / 100).toFixed(4)
  const volumeExpr = applyVolume ? 'v.volume = targetVolume;' : ''
  return `(function(){
    var targetMuted = ${muted};
    var targetVolume = ${targetVolume};
    var count = 0;
    function walk(doc, depth) {
      if (!doc || depth > 4) return;
      try {
        var videos = doc.querySelectorAll('video');
        for (var i = 0; i < videos.length; i++) {
          var v = videos[i];
          v.muted = targetMuted;
          v.defaultMuted = targetMuted;
          if (targetMuted) { v.setAttribute('muted', ''); }
          else { v.removeAttribute('muted'); }
          ${volumeExpr}
          count++;
        }
      } catch (e) {}
      try {
        var frames = doc.querySelectorAll('iframe, object, embed');
        for (var j = 0; j < frames.length; j++) {
          try {
            var nd = frames[j].contentDocument || frames[j].contentWindow.document;
            if (nd) walk(nd, depth + 1);
          } catch (e2) {}
        }
      } catch (e3) {}
    }
    walk(document, 0);
    return count;
  })()`
}

function applyPageAudio(muted: boolean, volume: number): Promise<number | undefined> {
  return exec<number>(buildAudioScript(muted, volume, true))
}

// 仅同步静音状态（不触碰音量），用于周期性看护，避免覆盖用户拖动音量时的实时预览
function applyPageMute(muted: boolean): Promise<number | undefined> {
  return exec<number>(buildAudioScript(muted, props.volume, false))
}

function onToggleMute() {
  const newMuted = !props.muted

  // 解除/恢复 Electron webview 层面的整体声音开关
  safeSetAudioMuted(newMuted)

  // 同时把页面内（含 iframe）所有 video 的 muted 状态置回目标值
  applyPageAudio(newMuted, props.volume)

  emit('updateMuted', newMuted)
}

// 外部 muted 变化时同步到 webview（例如快捷键或外部切换）
watch(() => props.muted, (val) => {
  safeSetAudioMuted(val)
  applyPageAudio(val, props.volume)
}, { immediate: false })

function onVolumeInput(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value)
  // 实时预览音量（debounce 在页面侧自己处理）
  applyPageAudio(props.muted, v)
}

function onVolumeChange(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value)
  // 如果之前是静音状态，调音量时自动取消静音。
  // 注意这里不能用 props.muted 作为最终状态：emit('updateMuted') 是异步回流，
  // 同一同步调用里 props.muted 仍是旧值，需用本地 targetMuted 避免重新静音。
  const unmute = props.muted && v > 0
  const targetMuted = unmute ? false : props.muted
  if (unmute) {
    safeSetAudioMuted(false)
    emit('updateMuted', false)
  }
  applyPageAudio(targetMuted, v)
  emit('updateVolume', v)
}

// 外部 volume 变化时同步到页面
watch(() => props.volume, (val) => {
  applyPageAudio(props.muted, val)
}, { immediate: false })

// webview 元素变化时（新频道/新线路加载），重新应用静音和音量状态
let audioPollTimer: ReturnType<typeof setInterval> | null = null

function clearAudioPoll() {
  if (audioPollTimer) {
    clearInterval(audioPollTimer)
    audioPollTimer = null
  }
}

watch(() => props.webviewEl, (wv) => {
  clearAudioPoll()
  if (!wv) return
  // 新 webview 尚未 dom-ready 时 setAudioMuted 会抛异常，这里走安全包装；
  // 若此刻不可用，静音状态由下面带重试的 ensureAudio / audioPollTimer 兜底。
  safeSetAudioMuted(props.muted)
  // 视频元素可能晚于 did-finish-load 才创建（如荔枝网动态创建 video），
  // 这里带重试地应用音量/取消静音；找到 video 后再多确认几次，
  // 防止站点播放器稍后重新把 muted 置回 true
  let tries = 0
  let confirmed = 0
  const ensureAudio = () => {
    applyPageAudio(props.muted, props.volume).then((count) => {
      if ((count ?? 0) > 0) confirmed++
      if (confirmed < 4 && ++tries < 20) {
        setTimeout(ensureAudio, 500)
      }
    })
  }
  setTimeout(ensureAudio, 800)

  // 持久看护：站点播放器可能在运行中重新创建 video 元素或重新强制 muted=true
  // （例如切换线路、播放器内部重建），仅靠上面的有限重试无法覆盖这些后续变化。
  // 周期性同步静音状态，确保取消静音不被站点逻辑还原（不触碰音量，避免干扰实时预览）。
  audioPollTimer = setInterval(() => {
    applyPageMute(props.muted)
  }, 2000)
}, { immediate: true })

onUnmounted(() => {
  clearAudioPoll()
})
</script>

<style scoped>
.ysp-player-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  z-index: 100000;
  transition: opacity 0.35s ease;
  user-select: none;
}

/* 隐藏状态：完全透明（不再残留半透明黑条遮挡视频），但仍可接收鼠标事件以在悬停时重新显示 */
.ysp-player-bar.bar-hidden {
  opacity: 0;
}
.ysp-player-bar.bar-hidden:hover {
  opacity: 1;
}

/* 网页线路模式：控制条仅覆盖左侧自有按钮区域（不横跨全宽），
   右侧自然让位给网页原生控制按钮，同时保持可交互以支撑自动隐藏/显示 */
.ysp-player-bar.mode-webview {
  right: auto;
  width: fit-content;
  background: none;
  pointer-events: auto;
}
.ysp-player-bar.mode-webview .bar-left {
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(6px);
  border-radius: 6px;
  padding: 0 8px;
  height: 32px;
}

/* 视频流解析模式：整条不透明控制条 */
.ysp-player-bar.mode-stream {
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(6px);
  pointer-events: auto;
}

.bar-left {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ctrl-btn {
  background: none;
  border: none;
  color: #ccc;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  font-size: 14px;
  transition: background 0.15s, color 0.15s;
}

.ctrl-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.ctrl-btn:active:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
}

.ctrl-btn:disabled {
  color: #555;
  cursor: default;
}

.btn-icon {
  font-size: 14px;
  line-height: 1;
}

.divider {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 6px;
}

.route-indicator {
  font-size: 11px;
  color: #aaa;
  min-width: 32px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.volume-slider-wrap {
  display: flex;
  align-items: center;
  margin-left: 2px;
}

.volume-slider {
  width: 60px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #4fc3f7;
  cursor: pointer;
}

.volume-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #4fc3f7;
  cursor: pointer;
  border: none;
}
</style>