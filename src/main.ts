import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import {
  Switch,
  List,
  Refresh,
  Close,
  Search,
  Edit,
  Delete,
  FolderOpened,
  Download,
  Plus,
} from '@element-plus/icons-vue'
import App from './App.vue'
import { logger } from '@/utils/logger'

window.addEventListener('error', (e) => {
  logger.error('[FATAL] window.onerror:', e.message, e.filename, e.lineno, e.colno, e.error)
})
window.addEventListener('unhandledrejection', (e) => {
  logger.error('[FATAL] unhandledrejection:', e.reason)
})

const app = createApp(App)
const pinia = createPinia()

app.config.errorHandler = (err, instance, info) => {
  logger.error('[VUE-ERROR]', err, 'component:', instance?.$options?.name, 'info:', info)
}

app.config.warnHandler = (msg, instance, trace) => {
  logger.warn('[VUE-WARN]', msg, 'component:', instance?.$options?.name, trace)
}

app.use(pinia)
app.use(ElementPlus, { locale: zhCn })

app.component('Switch', Switch)
app.component('List', List)
app.component('Refresh', Refresh)
app.component('Close', Close)
app.component('Search', Search)
app.component('Edit', Edit)
app.component('Delete', Delete)
app.component('FolderOpened', FolderOpened)
app.component('Download', Download)
app.component('Plus', Plus)

app.mount('#app')