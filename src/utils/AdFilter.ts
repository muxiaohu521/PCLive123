// ============ 广告过滤模块 ============
// 参考 TVBox M3u8.java / AdBlocker.java / VideoParseRuler.java 实现
import sharedRules from '@shared/ad-filter-rules.json'

// ---- 内置广告域名黑名单（来自共享规则文件 ad-filter-rules.json） ----
const DEFAULT_AD_HOSTS: string[] = sharedRules.DEFAULT_AD_HOSTS

// ---- 频道名称广告关键词（解析时按名称过滤） ----
const AD_CHANNEL_KEYWORDS = [
  '广告', '购物', '导购', '促销', '推广',
  '电视购物', '家庭购物', '环球购物', '优购物', '快乐购',
  '好易购', '家家购物', '风尚购物', '时尚购',
  '测试', '测试频道', 'test',
  '轮播广告', '贴片广告', '开机广告',
  '轮播', '导视',
]

// ---- 额外用户可配置的广告域名 ----
let extraAdHosts: string[] = []

// ---- 用户移除的内置域名（从默认列表排除） ----
let removedBuiltinHosts: string[] = []

// ---- 额外用户可配置的频道名关键词 ----
let extraAdKeywords: string[] = []

// ---- 用户移除的内置关键词（从默认列表排除） ----
let removedBuiltinKeywords: string[] = []



// ============ 域名黑名单检测 ============

export function getAllAdHosts(): string[] {
  return [...DEFAULT_AD_HOSTS.filter(h => !removedBuiltinHosts.includes(h)), ...extraAdHosts]
}

export function isAdHost(url: string): boolean {
  const lower = url.toLowerCase()
  for (const host of getAllAdHosts()) {
    if (lower.includes(host)) return true
  }
  return false
}

export function addAdHosts(hosts: string[]): void {
  for (const h of hosts) {
    if (!h) continue
    if (removedBuiltinHosts.includes(h)) {
      restoreBuiltinHost(h)
      continue
    }
    if (!extraAdHosts.includes(h) && !DEFAULT_AD_HOSTS.includes(h)) {
      extraAdHosts.push(h)
    }
  }
}

export function removeAdHost(host: string): void {
  const idx = extraAdHosts.indexOf(host)
  if (idx !== -1) extraAdHosts.splice(idx, 1)
}

export function getExtraAdHosts(): string[] {
  return [...extraAdHosts]
}

export function clearExtraAdHosts(): void {
  extraAdHosts = []
}

export function removeBuiltinHost(host: string): void {
  if (DEFAULT_AD_HOSTS.includes(host) && !removedBuiltinHosts.includes(host)) {
    removedBuiltinHosts.push(host)
  }
}

export function restoreBuiltinHost(host: string): void {
  const idx = removedBuiltinHosts.indexOf(host)
  if (idx !== -1) removedBuiltinHosts.splice(idx, 1)
}

export function getRemovedBuiltinHosts(): string[] {
  return [...removedBuiltinHosts]
}

// ============ 频道名称过滤 ============

export function isAdChannelName(name: string): boolean {
  const lower = name.toLowerCase().trim()
  const effectiveBuiltin = AD_CHANNEL_KEYWORDS.filter(kw => !removedBuiltinKeywords.includes(kw))
  const allKeywords = [...effectiveBuiltin, ...extraAdKeywords]
  for (const kw of allKeywords) {
    if (lower.includes(kw.toLowerCase())) return true
  }
  if (/^\s*$/.test(name)) return true
  return false
}

export function getAdChannelKeywords(): string[] {
  return [...AD_CHANNEL_KEYWORDS.filter(kw => !removedBuiltinKeywords.includes(kw))]
}

export function getExtraAdKeywords(): string[] {
  return [...extraAdKeywords]
}

export function addAdKeywords(keywords: string[]): void {
  for (const kw of keywords) {
    const lower = kw.toLowerCase().trim()
    if (!lower) continue
    if (removedBuiltinKeywords.includes(lower)) {
      restoreBuiltinKeyword(lower)
      continue
    }
    if (!extraAdKeywords.includes(lower) && !AD_CHANNEL_KEYWORDS.includes(kw)) {
      extraAdKeywords.push(lower)
    }
  }
}

export function removeAdKeyword(keyword: string): void {
  const idx = extraAdKeywords.indexOf(keyword)
  if (idx !== -1) extraAdKeywords.splice(idx, 1)
}

export function clearExtraAdKeywords(): void {
  extraAdKeywords = []
}

export function removeBuiltinKeyword(keyword: string): void {
  if (AD_CHANNEL_KEYWORDS.includes(keyword) && !removedBuiltinKeywords.includes(keyword)) {
    removedBuiltinKeywords.push(keyword)
  }
}

export function restoreBuiltinKeyword(keyword: string): void {
  const idx = removedBuiltinKeywords.indexOf(keyword)
  if (idx !== -1) removedBuiltinKeywords.splice(idx, 1)
}

export function getRemovedBuiltinKeywords(): string[] {
  return [...removedBuiltinKeywords]
}