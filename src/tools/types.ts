import type { GeoInfo } from '@/utils/GeoService'

// ============ 工具箱公共类型 ============

export type ToolKey = 'connectivity' | 'sniffer' | 'geoip' | 'recording' | 'download' | 'cast'

// 连通性测试日志项
export interface ConnectivityLogItem {
  name: string
  count: number
  status: 'pending' | 'testing' | 'success' | 'fail'
}

// IP 查询结果项
export interface GeoResultItem {
  host: string
  label?: string
  info?: GeoInfo | null
  error?: string
}

// 流下载任务（UI 层展示用）
export interface DownloadTaskUi {
  id: number
  status: 'queued' | 'downloading' | 'merging' | 'done'
  /** 任务启动时间戳（毫秒），用于按打开顺序排序显示 */
  startedAt?: number
  success: boolean
  error: string
  reason: string
  elapsed: number
  segmentCount: number
  totalBytes: number
  outputFile: string
  outputDir: string
  segmentsDir: string
  cleanupMode: 'manual' | 'auto'
  title: string
  url: string
}