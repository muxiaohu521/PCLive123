/**
 * video-player — 控件注册与标签更新
 *
 * 播放器控制栏自定义按钮（频道 / 线路 / 字幕 / 解码模式 / 播放模式 / 工具）
 * 与弹出菜单，及各类按钮文案、显隐状态的更新。
 */

import { state } from './state'
import { ctx } from './context'
import { PLAY_MODE_LABELS } from '@/constants'
import type { DecodeMode, PlayMode } from '@/constants'
import { showPopupMenu } from './popup'
import type { PopupItem } from './popup'

function updateSourceLabel(): void {
  if (!state.sourceInfoEl) return
  if (ctx.store.activePlayMode === 'channel') {
    state.sourceInfoEl.textContent = `线路 ${ctx.props.info.sourceIndex + 1}/${ctx.props.info.sourceNum}`
  } else if (ctx.store.activePlayMode === 'locallive') {
    state.sourceInfoEl.textContent = `线路 ${ctx.props.info.sourceIndex + 1}/${ctx.props.info.sourceNum}`
  } else if (ctx.store.activePlayMode === 'sniffer') {
    state.sourceInfoEl.textContent = `线路 ${ctx.props.info.sourceIndex + 1}/${ctx.props.info.sourceNum}`
  } else if (ctx.store.activePlayMode === 'local') {
    state.sourceInfoEl.textContent = `视频 ${ctx.props.info.sourceIndex + 1}/${ctx.props.info.sourceNum}`
  } else {
    state.sourceInfoEl.textContent = ''
  }
}

function updateControlLabels(): void {
  if (!state.art) return
  const mode = ctx.store.activePlayMode
  const player = state.art

  const setDisp = (name: string, show: boolean) => {
    const el = player.controls[name] as HTMLElement | undefined
    if (el) el.style.display = show ? '' : 'none'
  }

  if (!mode) {
    setDisp('prev-channel', false)
    setDisp('next-channel', false)
    setDisp('prev-source', false)
    setDisp('source-info', false)
    setDisp('next-source', false)
    setDisp('subtitle-cc', true)
    return
  }

  const showChannel = mode === 'local' || mode === 'channel' || mode === 'locallive' || mode === 'sniffer'
  const showSource = mode === 'channel' || mode === 'locallive' || mode === 'sniffer'

  setDisp('prev-channel', showChannel)
  setDisp('next-channel', showChannel)
  setDisp('prev-source', showSource)
  setDisp('source-info', showSource)
  setDisp('next-source', showSource)
  setDisp('subtitle-cc', mode !== 'channel' && mode !== 'locallive' && mode !== 'sniffer')

  if (mode === 'local') {
    const pc = state.art.controls['prev-channel'] as HTMLElement | undefined; if (pc) pc.setAttribute('title', '上一视频')
    const nc = state.art.controls['next-channel'] as HTMLElement | undefined; if (nc) nc.setAttribute('title', '下一视频')
  } else if (mode === 'channel' || mode === 'locallive' || mode === 'sniffer') {
    const pc = state.art.controls['prev-channel'] as HTMLElement | undefined; if (pc) pc.setAttribute('title', '上一频道')
    const nc = state.art.controls['next-channel'] as HTMLElement | undefined; if (nc) nc.setAttribute('title', '下一频道')
  }

  if (mode === 'local') updatePlayModeButton()
  updateSourceLabel()
}

function getDecodeLabel(): string {
  const mode = ctx.store.decodeMode
  if (mode === 'hardware') return '硬解'
  if (mode === 'software') return '软解'
  if (mode === 'mpv') return 'MPV'
  if (mode === 'vlc') return 'VLC'
  if (mode === 'ffmpeg') return 'FFmpeg'
  return '自动'
}

function getPlayModeLabel(): string {
  return PLAY_MODE_LABELS[ctx.store.localPlayMode] || '顺序播放'
}

function updatePlayModeButton(): void {
  if (!state.art) return
  const outer = state.art.controls['play-mode'] as HTMLElement | undefined
  const el = outer?.querySelector('.pclive-playmode-btn') as HTMLElement | null
  if (el) el.textContent = getPlayModeLabel()
}

function updateDecodeButton(): void {
  if (!state.art) return
  const outer = state.art.controls['decode-mode'] as HTMLElement | undefined
  const span = outer?.querySelector('.pclive-decode-btn') as HTMLElement | null
  if (!span) return
  span.textContent = getDecodeLabel()
  const mode = ctx.store.decodeMode
  span.className = 'pclive-decode-btn'
  if (mode === 'hardware') span.className += ' decode-hw'
  else if (mode === 'software') span.className += ' decode-sw'
  else if (mode === 'ffmpeg') span.className += ' decode-ff'
  else if (mode === 'mpv') span.className += ' decode-mpv'
  else if (mode === 'vlc') span.className += ' decode-vlc'
  else span.className += ' decode-auto'
  if (outer) outer.title = '选择解码模式'
}

function addCustomControls(): void {
  if (!state.art || state.controlsAdded) return
  state.controlsAdded = true

  const isChannel = ctx.store.activePlayMode === 'channel'
  const isLocal = ctx.store.activePlayMode === 'local'

  state.art.controls.add({
    name: 'prev-channel',
    position: 'left',
    html: '◁',
    tooltip: isLocal ? '上一视频' : '上一频道',
    style: { fontSize: '18px', fontWeight: 'bold', marginRight: '2px' },
    click() { ctx.emit('prevChannel') },
  })

  state.art.controls.add({
    name: 'next-channel',
    position: 'left',
    html: '▷',
    tooltip: isLocal ? '下一视频' : '下一频道',
    style: { fontSize: '18px', fontWeight: 'bold', marginRight: '8px' },
    click() { ctx.emit('nextChannel') },
  })

  state.art.controls.add({
    name: 'prev-source',
    position: 'left',
    html: '◀',
    tooltip: '上一线路',
    style: { fontSize: '12px' },
    click() { ctx.emit('prevSource') },
  })

  state.art.controls.add({
    name: 'source-info',
    position: 'left',
    html: `<span class="pclive-src-label">${isChannel ? `线路 ${ctx.props.info.sourceIndex + 1}/${ctx.props.info.sourceNum}` : ''}</span>`,
    tooltip: '当前线路',
    style: {},
    mounted(this: any, el: HTMLElement) { state.sourceInfoEl = el },
  })

  state.art.controls.add({
    name: 'next-source',
    position: 'left',
    html: '▶',
    tooltip: '下一线路',
    style: { fontSize: '12px' },
    click() { ctx.emit('nextSource') },
  })

  state.art.controls.add({
    name: 'subtitle-cc',
    position: 'right',
    html: '<span id="pclive-sub-indicator" class="pclive-sub-indicator off">CC</span>',
    tooltip: '字幕 (显示/隐藏)',
    style: { fontSize: '12px', marginRight: '6px', cursor: 'pointer' },
    click() { ctx.toggleSubtitle() },
  })

  state.art.controls.add({
    name: 'decode-mode',
    position: 'right',
    html: `<span class="pclive-decode-btn">${getDecodeLabel()}</span>`,
    tooltip: '选择解码模式',
    style: { fontSize: '11px', marginRight: '6px', cursor: 'pointer', fontWeight: 'bold' },
    click(_comp: any, _event: Event) {
      const outer = state.art!.controls['decode-mode'] as HTMLElement | undefined
      const span = outer?.querySelector('.pclive-decode-btn') as HTMLElement | null
      if (!span) return

      const items: PopupItem[] = [
        { label: '自动', value: 'auto', active: ctx.store.decodeMode === 'auto', colorClass: 'decode-auto' },
        { label: '硬解', value: 'hardware', active: ctx.store.decodeMode === 'hardware', colorClass: 'decode-hw' },
        { label: '软解', value: 'software', active: ctx.store.decodeMode === 'software', colorClass: 'decode-sw' },
      ]
      if (ctx.store.mpvPath) items.push({ label: 'MPV', value: 'mpv', active: ctx.store.decodeMode === 'mpv', colorClass: 'decode-mpv' })
      if (ctx.store.vlcPath) items.push({ label: 'VLC', value: 'vlc', active: ctx.store.decodeMode === 'vlc', colorClass: 'decode-vlc' })
      if (ctx.store.ffmpegPath) items.push({ label: 'FFmpeg', value: 'ffmpeg', active: ctx.store.decodeMode === 'ffmpeg', colorClass: 'decode-ff' })

      showPopupMenu(span, items, (value) => {
        const mode = value as DecodeMode
        if (mode === ctx.store.decodeMode) return
        ctx.store.setDecodeMode(mode)
        updateDecodeButton()
        // 实际重载由 store.decodeMode 的 watch 统一处理（含重新解析一次性 token）
      })
    },
  })

  state.art.controls.add({
    name: 'play-mode',
    position: 'right',
    html: `<span class="pclive-playmode-btn">${getPlayModeLabel()}</span>`,
    tooltip: '选择播放模式',
    style: { fontSize: '11px', marginRight: '6px', cursor: 'pointer', fontWeight: 'bold' },
    click(_comp: any, _event: Event) {
      const outer = state.art!.controls['play-mode'] as HTMLElement | undefined
      const span = outer?.querySelector('.pclive-playmode-btn') as HTMLElement | null
      if (!span) return

      const items: PopupItem[] = [
        { label: '顺序播放', value: 'sequential', active: ctx.store.localPlayMode === 'sequential' },
        { label: '单曲循环', value: 'single_loop', active: ctx.store.localPlayMode === 'single_loop' },
        { label: '随机播放', value: 'random', active: ctx.store.localPlayMode === 'random' },
      ]

      showPopupMenu(span, items, (value) => {
        const mode = value as PlayMode
        if (mode === ctx.store.localPlayMode) return
        ctx.store.setLocalPlayMode(mode)
        updatePlayModeButton()
      })
    },
  })

  state.art.controls.add({
    name: 'tools-menu',
    position: 'right',
    html: '<span class="pclive-float-btn">🧰</span>',
    tooltip: '工具',
    style: { fontSize: '12px', marginRight: '4px', cursor: 'pointer' },
    click() {
      const outer = state.art!.controls['tools-menu'] as HTMLElement | undefined
      const span = outer?.querySelector('.pclive-float-btn') as HTMLElement | null
      if (!span) return

      const items: PopupItem[] = [
        { label: '⬇️ 下载', value: 'download', active: false },
        { label: '🎬 录屏', value: 'record', active: false },
        { label: '📡 投屏', value: 'cast', active: ctx.store.showDlna },
        { label: '🖥 悬浮窗', value: 'float', active: false },
      ]

      showPopupMenu(span, items, (value) => {
        switch (value) {
          case 'download':
            ctx.store.showDlna = false
            ctx.store.toolQuickStart = { kind: 'download', ts: Date.now() }
            break
          case 'record':
            ctx.store.showDlna = false
            ctx.store.toolQuickStart = { kind: 'record', ts: Date.now() }
            break
          case 'cast':
            // 仅允许同时存在一个投屏面板：已在投屏时忽略重复点击（关闭走面板 ✕ 按钮）
            if (ctx.store.showDlna) break
            ctx.store.showDlna = true
            ctx.store.showToolsDialog = false
            break
          case 'float':
            ctx.openFloatWindow(state.art)
            break
        }
      })
    },
  })

  updateControlLabels()
}

export { updateSourceLabel, updateControlLabels, getDecodeLabel, getPlayModeLabel, updatePlayModeButton, updateDecodeButton, addCustomControls }