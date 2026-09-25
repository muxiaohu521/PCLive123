// AudioPlayer.ts — 通用音频解码插件（软件模式组件）
// 基于 Web Audio API，类比 hls.js/mpegts.js：浏览器 codec 解码 + JS 控制播放管线
//
// 支持格式：MP3 / AAC / FLAC / WAV / Opus / OGG / WMA 等浏览器原生支持的所有音频编码
// 不支持：需要完整文件，不适用无限流媒体（直播音频流请用 FFmpeg 模式）

export interface AudioPlayerEvents {
  ready: () => void
  play: () => void
  pause: () => void
  ended: () => void
  error: (error: Error) => void
  timeupdate: (currentTime: number, duration: number) => void
  waiting: () => void
  canplay: () => void
}

type EventName = keyof AudioPlayerEvents

export class SoftwareAudioPlayer {
  private ctx: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  private buffer: AudioBuffer | null = null

  private _playing = false
  private _paused = false
  private _loaded = false
  private _volume = 1
  private _muted = false

  private startTime = 0
  private pauseOffset = 0
  private _duration = 0
  private _currentTime = 0

  private ticker: ReturnType<typeof setInterval> | null = null
  private listeners = new Map<EventName, Set<Function>>()

  // ── public readonly state ──

  get playing(): boolean { return this._playing }
  get paused(): boolean { return this._paused }
  get loaded(): boolean { return this._loaded }
  get duration(): number { return this._duration }
  get currentTime(): number { return this._currentTime }
  get volume(): number { return this._volume }
  get muted(): boolean { return this._muted }

  // ── event system ──

  on<E extends EventName>(event: E, cb: AudioPlayerEvents[E]): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
  }

  off<E extends EventName>(event: E, cb: AudioPlayerEvents[E]): void {
    this.listeners.get(event)?.delete(cb)
  }

  private emit<E extends EventName>(event: E, ...args: Parameters<AudioPlayerEvents[E]>): void {
    this.listeners.get(event)?.forEach(cb => {
      try { (cb as Function)(...args) } catch (e) { /* 静默吞掉回调异常 */ }
    })
  }

  // ── lifecycle ──

  async load(url: string): Promise<void> {
    this.destroy()

    try {
      this.emit('waiting')
      this.ctx = new AudioContext()
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
      this.applyVolume()

      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
      const ab = await resp.arrayBuffer()
      this.buffer = await this.ctx.decodeAudioData(ab)

      this._duration = this.buffer.duration
      this._loaded = true
      this._currentTime = 0
      this.pauseOffset = 0

      this.emit('ready')
      this.emit('canplay')
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)))
      throw e
    }
  }

  play(): void {
    if (!this.ctx || !this.buffer || !this.gain) return

    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }

    this.source = this.ctx.createBufferSource()
    this.source.buffer = this.buffer
    this.source.connect(this.gain)
    this.source.start(0, this.pauseOffset)

    this.source.onended = () => {
      // onended 触发条件：播放自然结束或 stop()
      // 自然结束 → 发 ended；stop() → 不发 ended（pause/seek 场景）
      if (this.source) {
        // 检查是否是自然结束（到达末尾）
        const natural = this.pauseOffset < this._duration - 0.05
        this._playing = false
        this._paused = false
        this.stopTicker()
        if (!natural) {
          this.emit('ended')
        }
      }
    }

    this.startTime = this.ctx.currentTime - this.pauseOffset
    this._playing = true
    this._paused = false
    this.startTicker()
    this.emit('play')
  }

  pause(): void {
    if (!this.ctx || !this._playing) return

    this.pauseOffset = this.ctx.currentTime - this.startTime
    // 限制在有效范围
    if (this.pauseOffset < 0) this.pauseOffset = 0
    if (this.buffer && this.pauseOffset >= this.buffer.duration) {
      this.pauseOffset = 0
      this._playing = false
      this._paused = false
      this.stopTicker()
      this.emit('ended')
      return
    }

    this.stopSource()
    this._playing = false
    this._paused = true
    this.stopTicker()
    this.emit('pause')
  }

  seek(time: number): void {
    const wasPlaying = this._playing
    // 先停后跳
    this.stopSource()
    this._playing = false

    this.pauseOffset = Math.max(0, Math.min(time, this._duration))
    this._currentTime = this.pauseOffset

    if (wasPlaying) {
      this.play()
    }
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v))
    this.applyVolume()
  }

  setMuted(m: boolean): void {
    this._muted = m
    this.applyVolume()
  }

  // ── internal ──

  private applyVolume(): void {
    if (this.gain) {
      this.gain.gain.value = this._muted ? 0 : this._volume
    }
  }

  private stopSource(): void {
    if (this.source) {
      try { this.source.onended = null } catch (_) {}
      try { this.source.stop() } catch (_) {}
      this.source.disconnect()
      this.source = null
    }
  }

  private startTicker(): void {
    this.stopTicker()
    this.ticker = setInterval(() => {
      if (this._playing && this.ctx) {
        this._currentTime = this.ctx.currentTime - this.startTime
        // 到达末尾
        if (this.buffer && this._currentTime >= this.buffer.duration) {
          this._currentTime = this.buffer.duration
          this._playing = false
          this._paused = false
          this.stopTicker()
          this.emit('timeupdate', this._currentTime, this._duration)
          this.emit('ended')
          return
        }
        this.emit('timeupdate', this._currentTime, this._duration)
      }
    }, 250)
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  destroy(): void {
    this.stopTicker()
    this.stopSource()
    if (this.ctx) {
      this.ctx.close().catch(() => {})
      this.ctx = null
    }
    this.gain = null
    this.buffer = null
    this._playing = false
    this._paused = false
    this._loaded = false
    this._currentTime = 0
    this.pauseOffset = 0
    this.listeners.clear()
  }
}