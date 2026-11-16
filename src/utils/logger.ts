export const LOG_LEVEL = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 } as const
type LogLevel = (typeof LOG_LEVEL)[keyof typeof LOG_LEVEL]

let currentLevel: LogLevel = LOG_LEVEL.DEBUG

const isDev = typeof window !== 'undefined' && (window.electronAPI?.isDev ?? import.meta.env.DEV)

function formatMsg(args: unknown[]): string {
  return args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
}

function writeLog(level: LogLevel, method: 'log' | 'warn' | 'error' | 'info' | 'debug', args: unknown[]): void {
  const msg = formatMsg(args)
  const ts = new Date().toISOString()
  const fullMsg = `[${ts}] ${msg}`

  if (window.electronAPI?.rendererLog) {
    window.electronAPI.rendererLog(fullMsg)
  }

  if (level <= LOG_LEVEL.WARN) {
    console[method](...args)
    return
  }
  if (isDev && level <= currentLevel) {
    console[method](...args)
  }
}

export const logger = {
  setLevel(level: LogLevel): void {
    currentLevel = level
  },

  log(...args: unknown[]): void {
    writeLog(LOG_LEVEL.DEBUG, 'log', args)
  },
  warn(...args: unknown[]): void {
    writeLog(LOG_LEVEL.WARN, 'warn', args)
  },
  info(...args: unknown[]): void {
    writeLog(LOG_LEVEL.INFO, 'info', args)
  },
  error(...args: unknown[]): void {
    writeLog(LOG_LEVEL.ERROR, 'error', args)
  },
  debug(...args: unknown[]): void {
    writeLog(LOG_LEVEL.DEBUG, 'debug', args)
  },
}