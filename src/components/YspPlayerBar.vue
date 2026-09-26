<template>
  <div class="ysp-player-bar" @mouseenter="onBarEnter" @mouseleave="onBarLeave" v-show="visible">
    <div class="bar-left">
      <button class="ctrl-btn" title="上一节目" @click="$emit('prevChannel')">
        <span class="btn-icon">◁</span>
      </button>
      <button class="ctrl-btn" title="播放/暂停" @click="$emit('togglePlay')">
        <span class="btn-icon">{{ playing ? '⏸' : '▶' }}</span>
      </button>
      <button class="ctrl-btn" title="下一节目" @click="$emit('nextChannel')">
        <span class="btn-icon">▷</span>
      </button>

      <div class="divider"></div>

      <div class="quality-select" ref="qualityRef">
        <button class="ctrl-btn quality-btn" title="画质" @click="toggleQualityMenu">
          <span class="btn-label">{{ qualityLabel }}</span>
          <span class="btn-arrow">▾</span>
        </button>
        <div class="quality-menu" v-show="showQualityMenu">
          <div
            v-for="q in qualityOptions"
            :key="q.value"
            class="quality-item"
            :class="{ active: currentQuality === q.value }"
            @click="selectQuality(q.value)"
          >
            {{ q.label }}
            <span v-if="currentQuality === q.value" class="check">✓</span>
          </div>
        </div>
      </div>

      <div class="divider"></div>

      <button class="ctrl-btn" title="静音" @click="clickWebview('.voice.on, .voice.off')">
        <span class="btn-icon">🔊</span>
      </button>

      <div class="volume-slider-wrap">
        <input
          type="range"
          class="volume-slider"
          min="0"
          max="100"
          :value="currentVolume"
          @input="onVolumeChange"
          title="音量"
        />
      </div>
    </div>

    <div class="bar-right">
      <button class="ctrl-btn" title="画中画" @click="clickWebview('.pip')">
        <span class="btn-icon">🖥</span>
      </button>
      <button class="ctrl-btn" title="网页全屏" @click="clickWebview('.videoFull')">
        <span class="btn-icon">⛶</span>
      </button>
      <button class="ctrl-btn" title="全屏" @click="clickWebview('.full, .full2')">
        <span class="btn-icon">⛶</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const props = defineProps<{
  webviewEl: HTMLElement | null
  playing: boolean
  manualPlayState: number
}>()

const emit = defineEmits<{
  prevChannel: []
  nextChannel: []
  togglePlay: []
}>()

const visible = ref(true)
const showQualityMenu = ref(false)
const qualityRef = ref<HTMLElement | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | null = null

const currentQuality = ref('1080P')
const currentVolume = ref(50)

const qualityOptions = [
  { label: '蓝光 1080P', value: '1080P' },
  { label: '超清 720P', value: '720P' },
  { label: '高清 540P', value: '540P' },
]

const qualityLabel = computed(() => {
  const opt = qualityOptions.find(q => q.value === currentQuality.value)
  return opt ? opt.label.replace(/ \d+P/, '') : '蓝光'
})

function onBarEnter() {
  visible.value = true
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

function onBarLeave() {
  hideTimer = setTimeout(() => { visible.value = false }, 2000)
}

function exec(code: string): void {
  const wv = props.webviewEl
  if (!wv) return
  try {
    ;(wv as any).executeJavaScript?.(code)
  } catch (_) {}
}

function clickWebview(selector: string): void {
  exec(`(function(){var e=document.querySelector('${selector}');if(e)e.click()})()`)
}

function onVolumeChange(e: Event): void {
  const v = parseInt((e.target as HTMLInputElement).value)
  currentVolume.value = v
  exec(`(function(){
    var vo=document.querySelector('.voice');
    if(vo){var me=new MouseEvent('mouseenter',{bubbles:true});vo.dispatchEvent(me)}
    setTimeout(function(){
      var bar=document.querySelector('.bar-inner');
      if(!bar)bar=document.querySelector('.progress-bar .bar-inner');
      if(bar){
        var r=bar.getBoundingClientRect();
        var cx=r.left+r.width*${v / 100};
        var cy=r.top+r.height/2;
        bar.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:cx,clientY:cy}))
      }
    },300)
  })()`)
}

function toggleQualityMenu(): void {
  showQualityMenu.value = !showQualityMenu.value
}

function selectQuality(value: string): void {
  currentQuality.value = value
  showQualityMenu.value = false
  const itemIndex = qualityOptions.findIndex(q => q.value === value)
  exec(`(function(){
    var b=document.querySelector('.bei');
    if(b){b.click()}
    setTimeout(function(){
      var items=document.querySelectorAll('.bei-list-inner .item');
      if(items&&items.length>${itemIndex})items[${itemIndex}].click()
    },150)
  })()`)
}

onMounted(() => {
  document.addEventListener('click', (e) => {
    if (qualityRef.value && !qualityRef.value.contains(e.target as Node)) {
      showQualityMenu.value = false
    }
  })
})
</script>

<style scoped>
.ysp-player-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  z-index: 100;
  transition: opacity 0.3s;
  user-select: none;
}

.bar-left,
.bar-right {
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

.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.ctrl-btn:active {
  background: rgba(255, 255, 255, 0.18);
}

.btn-icon {
  font-size: 14px;
  line-height: 1;
}

.btn-label {
  font-size: 11px;
  font-weight: 600;
  margin-right: 2px;
}

.btn-arrow {
  font-size: 8px;
  margin-left: 1px;
}

.divider {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 4px;
}

.quality-select {
  position: relative;
}

.quality-menu {
  position: absolute;
  bottom: 36px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(30, 30, 46, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 120px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  z-index: 200;
}

.quality-item {
  padding: 6px 24px 6px 12px;
  font-size: 12px;
  color: #aaa;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
  position: relative;
}

.quality-item:hover {
  background: rgba(79, 195, 247, 0.12);
  color: #fff;
}

.quality-item.active {
  color: #4fc3f7;
}

.check {
  position: absolute;
  right: 8px;
  color: #4fc3f7;
  font-size: 12px;
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