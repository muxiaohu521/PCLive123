import { logger } from '@/utils/logger'

export class Semaphore {
  private _count: number
  private _queue: Array<() => void> = []

  constructor(count: number) {
    this._count = Math.max(1, count)
  }

  async acquire(): Promise<void> {
    if (this._count > 0) {
      this._count--
      return
    }
    return new Promise<void>(resolve => this._queue.push(resolve))
  }

  release(): void {
    const next = this._queue.shift()
    if (next) next()
    else this._count++
  }

  get available(): number {
    return this._count
  }

  get waiting(): number {
    return this._queue.length
  }
}

export function getOptimalThreadCount(): number {
  const cpuCount = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4
  return Math.max(1, cpuCount - 4)
}

export async function runParallel<T>(
  tasks: Array<(index: number) => Promise<T | undefined>>,
  concurrency: number,
  signal?: AbortSignal,
  minIntervalMs: number = 0
): Promise<(T | undefined)[]> {
  const sem = new Semaphore(concurrency)
  const results: (T | undefined)[] = new Array(tasks.length)
  const aborted = { value: false }

  if (signal) {
    if (signal.aborted) aborted.value = true
    signal.addEventListener('abort', () => { aborted.value = true }, { once: true })
  }

  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  const workers = tasks.map(async (task, index) => {
    if (aborted.value) return
    if (minIntervalMs > 0 && index > 0) {
      await delay(minIntervalMs * index)
    }
    if (aborted.value) return
    await sem.acquire()
    try {
      if (aborted.value) return
      results[index] = await task(index)
    } catch (err: unknown) {
      logger.warn('[ThreadPool] Task', index, 'failed:', err instanceof Error ? err.message : String(err))
    } finally {
      sem.release()
    }
  })

  await Promise.all(workers)
  return results
}