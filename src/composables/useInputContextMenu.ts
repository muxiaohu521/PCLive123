import { ref, type Ref } from 'vue'

export interface InputCtxMenuState {
  visible: boolean
  x: number
  y: number
  target: HTMLInputElement | HTMLTextAreaElement | null
}

export function useInputContextMenu() {
  const menu = ref<InputCtxMenuState>({
    visible: false,
    x: 0,
    y: 0,
    target: null,
  })

  function showMenu(e: MouseEvent) {
    const target = e.target as HTMLElement
    const tag = target.tagName
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return

    const el = target as HTMLInputElement | HTMLTextAreaElement
    // 跳过 readonly/disabled/type=range 等无法编辑的输入
    if (el.readOnly || (el as HTMLInputElement).disabled) return
    const type = (el as HTMLInputElement).type
    if (type === 'range' || type === 'color' || type === 'checkbox' || type === 'radio') return

    e.preventDefault()
    e.stopPropagation()

    const menuW = 180
    const menuH = 140
    let x = e.clientX
    let y = e.clientY
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 4
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 4

    menu.value = { visible: true, x, y, target: el }
  }

  function hideMenu() {
    menu.value = { visible: false, x: 0, y: 0, target: null }
  }

  async function copySelection() {
    const el = menu.value.target
    if (!el) return
    try {
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      if (start === end) {
        // 无选区时复制全部
        await navigator.clipboard.writeText(el.value)
      } else {
        await navigator.clipboard.writeText(el.value.substring(start, end))
      }
    } catch {
      // fallback
      const ta = document.createElement('textarea')
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      ta.value = start === end ? el.value : el.value.substring(start, end)
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    hideMenu()
  }

  async function cutSelection() {
    const el = menu.value.target
    if (!el) return
    await copySelection()
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    if (start === end) {
      el.value = ''
    } else {
      el.setRangeText('', start, end, 'end')
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    hideMenu()
  }

  async function pasteText() {
    const el = menu.value.target
    if (!el) return
    el.focus()
    try {
      const text = await navigator.clipboard.readText()
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      el.setRangeText(text, start, end, 'end')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } catch {
      document.execCommand('paste')
    }
    hideMenu()
  }

  function selectAll() {
    const el = menu.value.target
    if (!el) return
    el.focus()
    el.select()
    hideMenu()
  }

  // 注册全局右键事件
  function registerGlobalListener() {
    window.addEventListener('contextmenu', showMenu)
    window.addEventListener('click', hideMenu)
    window.addEventListener('scroll', hideMenu, true)
  }

  function unregisterGlobalListener() {
    window.removeEventListener('contextmenu', showMenu)
    window.removeEventListener('click', hideMenu)
    window.removeEventListener('scroll', hideMenu, true)
  }

  return {
    menu,
    showMenu,
    hideMenu,
    copySelection,
    cutSelection,
    pasteText,
    selectAll,
    registerGlobalListener,
    unregisterGlobalListener,
  }
}