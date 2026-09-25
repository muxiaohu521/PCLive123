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

const app = createApp(App)
const pinia = createPinia()

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