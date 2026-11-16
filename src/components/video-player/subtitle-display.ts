/**
 * video-player — 字幕显示样式与指示器
 *
 * 管理 CC 按钮指示器状态与字幕渲染样式，样式持久化在 localStorage。
 */

import { state } from './state'
import { ctx } from './context'

const SUBTITLE_STYLE_KEY = 'pclive_settings'

export function updateSubtitleIndicator(): void {
  const el = document.getElementById('pclive-sub-indicator')
  if (!el) return
  if (ctx.subtitleEnabled.value && ctx.subtitleVttUrl.value) {
    el.className = 'pclive-sub-indicator on'
  } else {
    el.className = 'pclive-sub-indicator off'
  }
}

export function getSubtitleStyle(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBTITLE_STYLE_KEY) || '{}')
    const fontSize = saved.subFontSize || 16
    const color = saved.subColor || '#ffffff'
    const background = saved.subBg || 'rgba(0,0,0,0.6)'
    return {
      fontSize: `${fontSize}px`,
      color,
      background,
      textShadow: '1px 1px 2px #000',
    }
  } catch (_) {
    return { fontSize: '16px', color: '#ffffff', background: 'rgba(0,0,0,0.6)' }
  }
}

export function applySubtitleStyle(): void {
  if (state.art) {
    state.art.subtitle.style(getSubtitleStyle())
  }
}