const isDev = typeof window !== 'undefined' && (window.electronAPI?.isDev ?? import.meta.env.DEV)

export const logger = {
  log(...args: unknown[]): void {
    if (isDev) console.log(...args)
  },
  warn(...args: unknown[]): void {
    console.warn(...args)
  },
  info(...args: unknown[]): void {
    if (isDev) console.info(...args)
  },
  error(...args: unknown[]): void {
    console.error(...args)
  },
  debug(...args: unknown[]): void {
    if (isDev) console.debug(...args)
  },
}