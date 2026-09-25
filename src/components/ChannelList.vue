<template>
  <div class="channel-list-panel">
    <div class="panel-header">
      <div class="header-left">
        <h3 class="panel-title">频道列表</h3>
        <span class="panel-count">{{ totalCount }} 个频道</span>
      </div>
      <div class="header-actions">
        <el-button link :icon="'Close'" @click="$emit('close')" class="close-btn" />
      </div>
    </div>

    <div class="search-bar">
      <el-input
        v-model="searchText"
        placeholder="搜索频道..."
        size="small"
        clearable
        :prefix-icon="'Search'"
      />
    </div>

    <template v-if="!searchText">
      <div class="subline-tabs" ref="sublineTabsRef">
        <div
          v-for="(sl, si) in subLineGroups"
          :key="'sl-' + si"
          class="subline-tab"
          :class="{ active: activeSubLine === si, current: subLineHasCurrent(sl) }"
          @click="selectSubLine(si)"
        >
          <span class="sl-name">{{ sl.name }}</span>
          <span class="sl-count">{{ sl.totalChannels }}</span>
        </div>
      </div>

      <div class="group-tabs" ref="tabsRef">
        <div
          v-for="(cg, gi) in categoryGroups"
          :key="'cg-' + gi"
          class="group-tab"
          :class="{ active: activeCategory === gi, current: categoryHasCurrent(cg) }"
          @click="selectCategory(gi)"
        >
          <span class="tab-name">{{ cg.groupName }}</span>
          <span class="tab-count">{{ cg.liveChannels.length }}</span>
        </div>
      </div>
    </template>

    <div class="panel-body" ref="bodyRef">
      <div
        v-for="(channel, ci) in displayChannels"
        :key="'ch-' + ci"
        class="channel-item"
        :class="{ active: channel === store.currentChannel }"
        :ref="(el) => setChannelRef(el as HTMLElement, channel === store.currentChannel)"
        @click="$emit('select', channel)"
        @contextmenu.prevent="onContextMenu($event, channel)"
      >
        <span class="ch-num">{{ channel.channelNum }}</span>
        <div class="ch-info">
          <span class="ch-name" :title="channel.channelName">{{ channel.channelName }}</span>
        </div>
        <span class="ch-source-count" v-if="channel.sourceNum > 1">
          {{ channel.sourceNum }}源
        </span>
      </div>
      <div v-if="displayChannels.length === 0" class="empty-state">
        暂无频道数据
      </div>
    </div>

    <div class="panel-footer">
      <div class="footer-row">
        <span class="shortcut">↑↓ 切换频道</span>
        <span class="shortcut">Tab 关闭</span>
      </div>
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="context-menu-overlay"
        @click="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      >
        <div
        ref="contextMenuRef"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        tabindex="-1"
        @click.stop
        @keydown="onContextMenuKeydown"
        @wheel="onContextMenuWheel"
      >
          <div class="ctx-menu-header">
            <span class="ctx-menu-title">{{ contextMenu.channel?.channelName }}</span>
            <span class="ctx-menu-num" v-if="contextMenu.channel">#{{ contextMenu.channel.channelNum }}</span>
          </div>
          <div class="ctx-menu-divider"></div>
          <div
            class="ctx-menu-item"
            @click="copyChannelName"
          >
            <span>复制频道名称</span>
          </div>
          <div
            class="ctx-menu-item"
            @click="copyChannelUrl"
          >
            <span>复制频道链接</span>
          </div>
          <div
            class="ctx-menu-item ctx-menu-item-primary"
            @click="copyChannelNameAndUrl"
          >
            <span>复制名称+链接</span>
          </div>
          <template v-if="(contextMenu.channel?.sourceNum || 0) > 1">
            <div class="ctx-menu-divider"></div>
            <div class="ctx-menu-subtitle">全部线路 ({{ contextMenu.channel?.sourceNum }})</div>
            <div
              v-for="(url, ui) in contextMenu.channel?.channelUrls || []"
              :key="'url-'+ui"
              class="ctx-menu-item ctx-menu-item-small"
              @click="copyText(url)"
            >
              <span class="ctx-url-src">{{ contextMenu.channel?.channelSourceNames?.[ui] || '源'+(ui+1) }}</span>
              <span class="ctx-url-text">{{ url }}</span>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, reactive } from 'vue'
import { useAppStore } from '@/store'
import type { LiveChannelItem, LiveChannelGroup } from '@/models/LiveChannelItem'
import { getChannelUrl } from '@/models/LiveChannelItem'

defineEmits<{
  select: [channel: LiveChannelItem]
  close: []
}>()

const store = useAppStore()
const bodyRef = ref<HTMLElement | null>(null)
const tabsRef = ref<HTMLElement | null>(null)
const sublineTabsRef = ref<HTMLElement | null>(null)
const searchText = ref('')
const activeSubLine = ref(0)
const activeCategory = ref(0)
const currentChannelEl = ref<HTMLElement | null>(null)
const contextMenuRef = ref<HTMLElement | null>(null)

const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  channel: null as LiveChannelItem | null
})

function onContextMenu(e: MouseEvent, channel: LiveChannelItem) {
  contextMenu.channel = channel
  // 防止菜单溢出屏幕
  const menuWidth = 280
  const menuHeight = 300
  let x = e.clientX
  let y = e.clientY
  if (x + menuWidth > window.innerWidth) {
    x = window.innerWidth - menuWidth - 8
  }
  if (y + menuHeight > window.innerHeight) {
    y = window.innerHeight - menuHeight - 8
  }
  contextMenu.x = x
  contextMenu.y = y
  contextMenu.visible = true
  nextTick(() => {
    contextMenuRef.value?.focus()
  })
}

function closeContextMenu() {
  contextMenu.visible = false
}

function onContextMenuKeydown(e: KeyboardEvent) {
  const el = contextMenuRef.value
  if (!el) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    el.scrollBy({ top: 40, behavior: 'smooth' })
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    el.scrollBy({ top: -40, behavior: 'smooth' })
  } else if (e.key === 'Escape') {
    closeContextMenu()
  }
}

function onContextMenuWheel(e: WheelEvent) {
  e.stopPropagation()
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // fallback for older environments
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  closeContextMenu()
}

function copyChannelName() {
  if (contextMenu.channel) {
    copyText(contextMenu.channel.channelName)
  }
}

function copyChannelUrl() {
  if (contextMenu.channel) {
    const url = getChannelUrl(contextMenu.channel)
    copyText(url)
  }
}

function copyChannelNameAndUrl() {
  if (contextMenu.channel) {
    const url = getChannelUrl(contextMenu.channel)
    copyText(`${contextMenu.channel.channelName},${url}`)
  }
}

interface SubLineGroup {
  name: string
  groups: LiveChannelGroup[]
  totalChannels: number
}

const subLineGroups = computed<SubLineGroup[]>(() => {
  const map = new Map<string, LiveChannelGroup[]>()
  for (const g of store.channelGroups) {
    const key = g.subLineName || '默认'
    const arr = map.get(key)
    if (arr) arr.push(g)
    else map.set(key, [g])
  }
  const result: SubLineGroup[] = []
  for (const [name, groups] of map) {
    const totalChannels = groups.reduce((s, g) => s + g.liveChannels.length, 0)
    result.push({ name, groups, totalChannels })
  }
  return result
})

const activeSubLineData = computed(() => {
  const idx = Math.min(activeSubLine.value, subLineGroups.value.length - 1)
  return subLineGroups.value[idx] || null
})

const categoryGroups = computed(() => {
  return activeSubLineData.value?.groups || []
})

const totalCount = computed(() =>
  store.channelGroups.reduce((sum, g) => sum + g.liveChannels.length, 0)
)

const currentCategory = computed(() => {
  const idx = Math.min(activeCategory.value, categoryGroups.value.length - 1)
  return categoryGroups.value[idx] || null
})

const displayChannels = computed(() => {
  if (searchText.value) {
    const keyword = searchText.value.toLowerCase()
    const all: LiveChannelItem[] = []
    for (const g of store.channelGroups) {
      for (const ch of g.liveChannels) {
        if (ch.channelName.toLowerCase().includes(keyword)) {
          all.push(ch)
        }
      }
    }
    return all
  }
  return currentCategory.value?.liveChannels ?? []
})

function subLineHasCurrent(sl: SubLineGroup): boolean {
  if (!store.currentChannel) return false
  const ch = store.currentChannel
  return sl.groups.some(g => g.liveChannels.includes(ch))
}

function categoryHasCurrent(cg: LiveChannelGroup): boolean {
  if (!store.currentChannel) return false
  const ch = store.currentChannel
  return cg.liveChannels.includes(ch)
}

function selectSubLine(si: number) {
  activeSubLine.value = Math.max(0, Math.min(si, subLineGroups.value.length - 1))
  activeCategory.value = 0
  nextTick(() => scrollToActive())
}

function selectCategory(gi: number) {
  activeCategory.value = Math.max(0, Math.min(gi, categoryGroups.value.length - 1))
  nextTick(() => scrollToActive())
}

function scrollToActive() {
  const container = tabsRef.value
  if (!container) return
  const activeEl = container.querySelector('.group-tab.active') as HTMLElement
  if (activeEl) {
    activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }
}

function setChannelRef(el: HTMLElement | null, isActive: boolean) {
  if (isActive && el) {
    currentChannelEl.value = el
  }
}

function scrollChannelIntoView(el: HTMLElement) {
  const container = bodyRef.value
  if (!container) return
  const ctRect = container.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  const targetTop = container.scrollTop + elRect.top - ctRect.top - ctRect.height / 2 + elRect.height / 2
  container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
}

watch(() => store.currentChannel, () => {
  updateActiveSelection()
  nextTick(() => {
    if (currentChannelEl.value) scrollChannelIntoView(currentChannelEl.value)
  })
})

watch(() => store.showChannelList, (show) => {
  if (show) {
    updateActiveSelection()
    nextTick(() => {
      if (currentChannelEl.value) scrollChannelIntoView(currentChannelEl.value)
    })
  }
})

function updateActiveSelection() {
  if (!store.currentChannel) return
  for (let si = 0; si < subLineGroups.value.length; si++) {
    const sl = subLineGroups.value[si]
    for (let gi = 0; gi < sl.groups.length; gi++) {
      if (sl.groups[gi].liveChannels.includes(store.currentChannel)) {
        activeSubLine.value = si
        activeCategory.value = gi
        nextTick(() => {
          scrollToActive()
        })
        return
      }
    }
  }
}
</script>

<style scoped>
.channel-list-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #1a1a2e;
  border-left: 1px solid #2a2a3e;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
}

.header-left {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

.panel-count {
  font-size: 11px;
  color: #555;
}

.close-btn {
  color: #666 !important;
  padding: 4px !important;
  font-size: 18px !important;
}

.close-btn:hover {
  color: #fff !important;
}

.search-bar {
  padding: 0 12px 8px;
}

/* Layer 1: Sub-line tabs */
.subline-tabs {
  display: flex;
  gap: 4px;
  padding: 0 12px 6px;
  overflow-x: auto;
  flex-shrink: 0;
  border-bottom: 2px solid #2a2a3e;
  margin-bottom: 2px;
}

.subline-tabs::-webkit-scrollbar {
  height: 10px;
}

.subline-tabs::-webkit-scrollbar-track {
  background: #1a1a2e;
  border-radius: 5px;
}

.subline-tabs::-webkit-scrollbar-thumb {
  background: #4a4a6a;
  border-radius: 5px;
  border: 2px solid #1a1a2e;
}

.subline-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 6px 6px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: #999;
  background: transparent;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  flex-shrink: 0;
  position: relative;
}

.subline-tab:hover {
  color: #ddd;
  background: rgba(255, 255, 255, 0.05);
}

.subline-tab.active {
  color: #ff9800;
  background: rgba(255, 152, 0, 0.1);
}

.subline-tab.active::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: #ff9800;
  border-radius: 1px;
}

.subline-tab.current::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4fc3f7;
  flex-shrink: 0;
  order: -1;
}

.sl-count {
  font-size: 10px;
  color: #666;
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 400;
}

.subline-tab.active .sl-count {
  color: rgba(255, 152, 0, 0.7);
}

/* Layer 2: Category tabs */
.group-tabs {
  display: flex;
  gap: 4px;
  padding: 4px 12px 8px;
  overflow-x: auto;
  flex-shrink: 0;
}

.group-tabs::-webkit-scrollbar {
  height: 10px;
}

.group-tabs::-webkit-scrollbar-track {
  background: #1a1a2e;
  border-radius: 5px;
}

.group-tabs::-webkit-scrollbar-thumb {
  background: #4a4a6a;
  border-radius: 5px;
  border: 2px solid #1a1a2e;
}

.group-tabs::-webkit-scrollbar-thumb:hover {
  background: #6a6a8a;
}

.group-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: #888;
  background: #222238;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
  flex-shrink: 0;
}

.group-tab:hover {
  color: #ccc;
  background: #2a2a42;
}

.group-tab.active {
  color: #fff;
  background: #3a3a5a;
}

.group-tab.current::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4fc3f7;
  flex-shrink: 0;
}

.tab-count {
  font-size: 10px;
  color: #555;
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 5px;
  border-radius: 8px;
}

.group-tab.active .tab-count {
  color: #888;
}

/* Layer 3: Channel list */
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.panel-body::-webkit-scrollbar {
  width: 4px;
}

.panel-body::-webkit-scrollbar-track {
  background: transparent;
}

.panel-body::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 2px;
}

.channel-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid #1f1f35;
}

.channel-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.channel-item.active {
  background: rgba(79, 195, 247, 0.1);
  border-left: 3px solid #4fc3f7;
  padding-left: 11px;
}

.ch-num {
  font-size: 11px;
  color: #666;
  min-width: 28px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.channel-item.active .ch-num {
  color: #4fc3f7;
  font-weight: 600;
}

.ch-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ch-name {
  font-size: 13px;
  color: #ddd;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-item.active .ch-name {
  color: #fff;
  font-weight: 600;
}

.ch-prog {
  font-size: 11px;
  color: #4fc3f7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ch-source-count {
  font-size: 10px;
  color: #666;
  background: #222238;
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}

.empty-state {
  padding: 40px 20px;
  text-align: center;
  color: #555;
  font-size: 13px;
}

.panel-footer {
  padding: 8px 14px;
  border-top: 1px solid #2a2a3e;
  flex-shrink: 0;
}

.footer-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}

.shortcut {
  font-size: 10px;
  color: #555;
}

/* 右键菜单 */
.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 220px;
  max-width: 360px;
  max-height: 70vh;
  overflow-y: auto;
  background: #1e1e32;
  border: 1px solid #3a3a5a;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  padding: 6px;
  font-size: 13px;
  outline: none;
}

.context-menu::-webkit-scrollbar {
  width: 4px;
}

.context-menu::-webkit-scrollbar-track {
  background: transparent;
}

.context-menu::-webkit-scrollbar-thumb {
  background: #3a3a5a;
  border-radius: 2px;
}

.ctx-menu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 6px;
}

.ctx-menu-title {
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.ctx-menu-num {
  font-size: 11px;
  color: #888;
  background: #2a2a42;
  padding: 1px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.ctx-menu-divider {
  height: 1px;
  background: #333355;
  margin: 4px 8px;
}

.ctx-menu-subtitle {
  padding: 4px 12px 2px;
  font-size: 11px;
  color: #666;
}

.ctx-menu-item {
  display: flex;
  align-items: center;
  padding: 7px 12px;
  border-radius: 6px;
  color: #ccc;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  gap: 6px;
  font-size: 13px;
}

.ctx-menu-item:hover {
  background: #3a3a5a;
  color: #fff;
}

.ctx-menu-item-primary {
  color: #4fc3f7;
}

.ctx-menu-item-primary:hover {
  background: rgba(79, 195, 247, 0.15);
  color: #81d4fa;
}

.ctx-menu-item-small {
  padding: 4px 12px;
  font-size: 12px;
}

.ctx-url-src {
  font-size: 11px;
  color: #888;
  background: #2a2a42;
  padding: 0 5px;
  border-radius: 3px;
  flex-shrink: 0;
}

.ctx-url-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #999;
  font-family: monospace;
  font-size: 11px;
}

.ctx-menu-item-small:hover .ctx-url-text {
  color: #ccc;
}

</style>