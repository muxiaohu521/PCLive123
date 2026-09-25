import { logger } from '@/utils/logger'
import { md5 } from '@/utils/md5'

interface SpiderReqOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
  data?: string | Record<string, unknown>
  postType?: string
  buffer?: number
  redirect?: number
  complete?: (result: SpiderReqResult) => void
}

interface SpiderReqResult {
  content: string
  headers: Record<string, string>
  statusCode: number
}

interface SpiderFetchResult {
  content: string
  headers: Record<string, string>
  statusCode: number
  finalUrl: string
}

interface SpiderInstance {
  init?(ext: string): void
  live?(url: string): string | Promise<string>
  home?(filter: boolean): string | Promise<string>
  [key: string]: any
}

const spiderCache = new Map<string, SpiderInstance>()
const spiderLock = new Map<string, Promise<SpiderInstance | null>>()

let fetchUrlFunc: ((url: string, headers: Record<string, string>) => Promise<string>) | null = null
let fetchUrlFullFunc: ((url: string, headers: Record<string, string>) => Promise<SpiderFetchResult>) | null = null

export function setFetchUrlFunc(fn: (url: string, headers: Record<string, string>) => Promise<string>): void {
  fetchUrlFunc = fn
}

export function setFetchUrlFullFunc(fn: (url: string, headers: Record<string, string>) => Promise<SpiderFetchResult>): void {
  fetchUrlFullFunc = fn
}

async function httpRequest(url: string, options: SpiderReqOptions): Promise<SpiderReqResult> {
  const method = String(options.method || 'GET').toUpperCase()
  const timeout = options.timeout || 10000
  const headers: Record<string, string> = {}
  const redirect = Number(options.redirect || 0)
  const maxRedirects = 5

  if (options.headers && typeof options.headers === 'object') {
    for (const [k, v] of Object.entries(options.headers)) {
      headers[k] = String(v)
    }
  }

  let postBody = ''
  if (options.body && typeof options.body === 'string') {
    postBody = options.body
  } else if (options.data) {
    const postType = options.postType || 'json'
    if (postType === 'json') {
      postBody = typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
    } else if (postType === 'form') {
      const params = new URLSearchParams()
      if (typeof options.data === 'object') {
        for (const [k, v] of Object.entries(options.data)) params.append(k, String(v))
      }
      postBody = params.toString()
      headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded'
    }
  }

  try {
    // Use the full-response fetch function if available (new behavior with proper redirect handling)
    if (fetchUrlFullFunc) {
      return httpRequestFull(url, method, headers, postBody, redirect, maxRedirects)
    }

    // Fallback: use the old string-only fetch function
    if (!fetchUrlFunc) {
      return { content: '', headers: {}, statusCode: 500 }
    }

    let currentUrl = url
    let redirectCount = 0

    while (redirectCount <= maxRedirects) {
      if (method === 'POST' && postBody) {
        const content = await fetchUrlFunc(currentUrl, { ...headers })
        return { content: content || '', headers: {}, statusCode: content ? 200 : 404 }
      } else {
        const content = await fetchUrlFunc(currentUrl, { ...headers })
        if (redirect > 0 && redirectCount < maxRedirects) {
          const redirectMatch = content.match(/^(https?:\/\/[^\s]+)$/i)
          if (redirectMatch && /^https?:\/\//i.test(redirectMatch[1]) && redirectMatch[1] !== currentUrl) {
            currentUrl = redirectMatch[1]
            redirectCount++
            logger.log('[SpiderService][fallback] Following redirect', redirectCount, 'to:', currentUrl.substring(0, 80))
            continue
          }
        }
        return { content: content || '', headers: {}, statusCode: content ? 200 : 404 }
      }
    }

    return { content: '', headers: {}, statusCode: 310 }
  } catch (e: any) {
    return {
      content: '',
      headers: {},
      statusCode: e?.code || 500,
    }
  }
}

async function httpRequestFull(
  url: string,
  method: string,
  headers: Record<string, string>,
  postBody: string,
  redirect: number,
  maxRedirects: number,
): Promise<SpiderReqResult> {
  let currentUrl = url
  let redirectCount = 0

  while (redirectCount <= maxRedirects) {
    const reqHeaders = { ...headers }

    // Signal the main process: if redirect > 0, we want to handle redirects manually
    if (redirect > 0) {
      reqHeaders['X-Spider-No-Redirect'] = '1'
    }

    if (method === 'POST' && postBody) {
      reqHeaders['X-Spider-Method'] = 'POST'
      reqHeaders['X-Spider-Body'] = postBody
    }

    const result = await fetchUrlFullFunc!(currentUrl, reqHeaders)

    // If spider wants manual redirect handling and we got a redirect
    if (redirect > 0 && result.statusCode >= 300 && result.statusCode < 400 && result.headers['location']) {
      const locationUrl = resolveUrl(currentUrl, result.headers['location'])
      if (locationUrl && locationUrl !== currentUrl) {
        logger.log('[SpiderService] Got redirect', result.statusCode, 'to:', locationUrl.substring(0, 80))
        currentUrl = locationUrl
        redirectCount++
        // Copied Set-Cookie from redirect response so subsequent requests have auth cookies
        continue
      }
    }

    // Return the final response (whether it was a redirect followed by main or not)
    return {
      content: result.content || '',
      headers: result.headers || {},
      statusCode: result.statusCode || 200,
    }
  }

  // Too many redirects
  return { content: '', headers: {}, statusCode: 310 }
}

function resolveUrl(base: string, location: string): string {
  if (!location) return ''
  if (/^https?:\/\//i.test(location)) return location
  try {
    return new URL(location, base).href
  } catch {
    return ''
  }
}

function createHtmlParserBindings(): Record<string, Function> {
  return {
    pd(html: string, rule: string, add_url: string): string {
      try {
        const regex = new RegExp(rule, 'g')
        const m = regex.exec(html)
        if (m && m[1]) {
          return add_url ? new URL(m[1], add_url).href : m[1]
        }
        return ''
      } catch { return '' }
    },
    pdfh(html: string, rule: string): string {
      try {
        const regex = new RegExp(rule, 'g')
        const m = regex.exec(html)
        return m && m[1] ? m[1] : ''
      } catch { return '' }
    },
    pdfa(html: string, rule: string): string[] {
      try {
        const regex = new RegExp(rule, 'g')
        const result: string[] = []
        let m: RegExpExecArray | null
        while ((m = regex.exec(html)) !== null) {
          if (m[1]) result.push(m[1])
        }
        return result
      } catch { return [] }
    },
    pdfla(html: string, p1: string, list_text: string, list_url: string, add_url: string): [string, string][] {
      try {
        const regex = new RegExp(p1, 'g')
        const result: [string, string][] = []
        let m: RegExpExecArray | null
        while ((m = regex.exec(html)) !== null) {
          const text = list_text.replace(/\$(\d+)/g, (_, n) => m![parseInt(n)] || '')
          const url = list_url.replace(/\$(\d+)/g, (_, n) => m![parseInt(n)] || '')
          result.push([text, add_url ? new URL(url, add_url).href : url])
        }
        return result
      } catch { return [] }
    },
  }
}

function executeSpiderModule(code: string, ext: string): SpiderInstance | null {
  const parserBindings = createHtmlParserBindings()

  const apiMethods: Record<string, Function> = {
    req: httpRequest,
    http: httpRequest,
    request: httpRequest,
    fetch: async (u: string, o?: any) => {
      const r = await httpRequest(u, o || {})
      return r.content
    },
    log: (...args: any[]) => logger.log('[Spider]', ...args),
    getProxy: () => '',
    joinUrl: (parent: string, child: string) => {
      try { return new URL(child, parent).href } catch { return parent + '/' + child }
    },
    setTimeout: (fn: Function, delay: number) => setTimeout(fn, delay),
    base64Encode: (s: string) => {
      const bytes = new TextEncoder().encode(s)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      return btoa(binary)
    },
    base64Decode: (s: string) => {
      try {
        const binary = atob(s)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
        return new TextDecoder('utf-8').decode(bytes)
      } catch { return s }
    },
    md5Encode: (s: string) => md5(s),
    ...parserBindings,
  }

  const bindingsCode = Object.entries(apiMethods)
    .map(([name]) => `var ${name} = __bindings__.${name};`)
    .join('\n')

  const wrappedCode = `
    ${bindingsCode}
    var module = { exports: {} };
    var exports = module.exports;
    try {
      ${code}
    } catch(e) {
      __bindings__.log('Spider code evaluation error:', e.message);
    }
    if (typeof __jsEvalReturn === 'function') {
      var __result = __jsEvalReturn();
      return __result;
    }
    if (typeof rule !== 'undefined' && rule && typeof rule === 'object') {
      return rule;
    }
    if (module.exports && typeof module.exports === 'object' && Object.keys(module.exports).length > 0) {
      if (typeof module.exports.__jsEvalReturn === 'function') {
        return module.exports.__jsEvalReturn();
      }
      return module.exports;
    }
    return null;
  `

  try {
    const fn = new Function('__bindings__', wrappedCode)
    const result = fn(apiMethods)

    if (!result || typeof result !== 'object') {
      logger.log('[SpiderService] Spider returned non-object:', typeof result)
      return null
    }

    const spider = result as SpiderInstance

    if (Object.keys(spider).length === 0 && !spider.live && !spider.init) {
      logger.log('[SpiderService] Spider object has no methods')
      return null
    }

    spider._raw = result

    spider.callLive = function (url: string): Promise<string | null> {
      return new Promise((resolve) => {
        try {
          const liveFn = this.live
          if (typeof liveFn !== 'function') {
            resolve(null)
            return
          }
          const rawResult = liveFn.call(this, url)
          if (rawResult instanceof Promise) {
            rawResult.then((v: string) => resolve(v || null)).catch(() => resolve(null))
          } else {
            resolve(rawResult || null)
          }
        } catch (e: any) {
          logger.error('[SpiderService] live() error:', e.message)
          resolve(null)
        }
      })
    }

    spider.callHome = function (filter: boolean): Promise<string | null> {
      return new Promise((resolve) => {
        try {
          const homeFn = this.home
          if (typeof homeFn !== 'function') {
            resolve(null)
            return
          }
          const rawResult = homeFn.call(this, filter)
          if (rawResult instanceof Promise) {
            rawResult.then((v: string) => resolve(v || null)).catch(() => resolve(null))
          } else {
            resolve(rawResult || null)
          }
        } catch (e: any) {
          logger.error('[SpiderService] home() error:', e.message)
          resolve(null)
        }
      })
    }

    spider.callInit = function (extStr: string): void {
      try {
        if (typeof this.init === 'function') {
          this.init.call(this, extStr)
        }
      } catch (e: any) {
        logger.error('[SpiderService] init() error:', e.message)
      }
    }

    return spider
  } catch (e: any) {
    logger.error('[SpiderService] Spider module execution failed:', e.message)
    return null
  }
}

async function fetchSpiderCode(apiUrl: string, headers: Record<string, string> = {}): Promise<string> {
  if (!fetchUrlFunc) {
    throw new Error('fetchUrlFunc not set')
  }
  const content = await fetchUrlFunc(apiUrl, headers)
  if (!content || content.length < 10) {
    throw new Error(`Empty spider code from ${apiUrl}`)
  }
  return content
}

export async function loadSpider(spiderKey: string, apiUrl: string, ext: string, headers: Record<string, string> = {}): Promise<SpiderInstance | null> {
  if (spiderCache.has(spiderKey)) {
    return spiderCache.get(spiderKey)!
  }

  if (spiderLock.has(spiderKey)) {
    return spiderLock.get(spiderKey)!
  }

  const loadPromise = (async () => {
    try {
      logger.log('[SpiderService] Loading spider:', spiderKey, apiUrl.substring(0, 80))

      const code = await fetchSpiderCode(apiUrl, headers)

      if (code.substring(0, 4) === '//bb') {
        logger.error('[SpiderService] Spider is QuickJS bytecode, not supported in PCLive:', apiUrl)
        return null
      }

      const spider = executeSpiderModule(code, ext)

      if (spider) {
        spider.callInit(ext)
        spiderCache.set(spiderKey, spider)
        logger.log('[SpiderService] Spider loaded successfully:', spiderKey,
          'hasLive:', typeof spider.live === 'function',
          'hasHome:', typeof spider.home === 'function',
          'hasInit:', typeof spider.init === 'function')
      }

      return spider
    } catch (e: any) {
      logger.error('[SpiderService] Failed to load spider:', apiUrl, e.message)
      return null
    } finally {
      spiderLock.delete(spiderKey)
    }
  })()

  spiderLock.set(spiderKey, loadPromise)
  return loadPromise
}

export async function invokeSpiderLive(
  spiderKey: string,
  apiUrl: string,
  ext: string,
  paramUrl: string,
  headers: Record<string, string> = {},
): Promise<string | null> {
  const spider = await loadSpider(spiderKey, apiUrl, ext, headers)
  if (!spider || !spider.callLive) {
    logger.log('[SpiderService] No spider or no live method for:', spiderKey)
    return null
  }

  logger.log('[SpiderService] Invoking spider.live():', spiderKey, paramUrl.substring(0, 80))
  const result = await spider.callLive(paramUrl)
  logger.log('[SpiderService] Spider live result length:', result?.length || 0)
  return result
}

export async function invokeSpiderHome(
  spiderKey: string,
  apiUrl: string,
  ext: string,
  filter: boolean = false,
  headers: Record<string, string> = {},
): Promise<string | null> {
  const spider = await loadSpider(spiderKey, apiUrl, ext, headers)
  if (!spider || !spider.callHome) {
    logger.log('[SpiderService] No spider or no home method for:', spiderKey)
    return null
  }

  logger.log('[SpiderService] Invoking spider.home():', spiderKey, 'filter:', filter)
  const result = await spider.callHome(filter)
  logger.log('[SpiderService] Spider home result length:', result?.length || 0)
  return result
}

export function clearSpiderCache(): void {
  spiderCache.clear()
  spiderLock.clear()
}