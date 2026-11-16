/**
 * video-player — 弹出菜单
 *
 * 播放模式 / 解码模式 / 工具等控制栏弹出的浮层菜单，纯 DOM 实现，
 * 与播放器其余逻辑解耦，仅依赖共享状态中的 activePopup / activePopupAnchor。
 */

import { state } from './state'

export interface PopupItem {
  label: string
  value: string
  active: boolean
  colorClass?: string
}

export function closePopup(): void {
  if (state.activePopup) {
    const kh = (state.activePopup as any).__keyHandler
    if (kh) document.removeEventListener('keydown', kh)
    state.activePopup.remove()
    state.activePopup = null
    state.activePopupAnchor = null
  }
}

export function showPopupMenu(anchor: HTMLElement, items: PopupItem[], onSelect: (value: string) => void): void {
  if (state.activePopup && state.activePopupAnchor === anchor) {
    closePopup()
    return
  }

  closePopup()
  state.activePopupAnchor = anchor

  const anchorRect = anchor.getBoundingClientRect()

  const overlay = document.createElement('div')
  overlay.className = 'pclive-popup-overlay'
  overlay.addEventListener('click', closePopup)
  overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); closePopup() })

  const popup = document.createElement('div')
  popup.className = 'pclive-popup-menu'

  for (const item of items) {
    const el = document.createElement('div')
    el.className = 'pclive-popup-item'
    if (item.active) el.classList.add('active')
    if (item.colorClass) el.classList.add(item.colorClass)
    el.textContent = item.label
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      onSelect(item.value)
      closePopup()
    })
    popup.appendChild(el)
  }

  overlay.appendChild(popup)
  document.body.appendChild(overlay)
  state.activePopup = overlay

  popup.style.position = 'fixed'
  popup.style.zIndex = '100001'
  void popup.offsetHeight

  const pw = popup.offsetWidth
  const ph = popup.offsetHeight

  let top = anchorRect.top - ph - 4
  let left = anchorRect.left
  if (top < 8) top = anchorRect.bottom + 4
  if (left + pw > window.innerWidth - 8) {
    left = window.innerWidth - pw - 8
  }
  if (left < 8) left = 8

  popup.style.left = left + 'px'
  popup.style.top = top + 'px'

  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePopup()
  }
  document.addEventListener('keydown', keyHandler);
  (overlay as any).__keyHandler = keyHandler
}