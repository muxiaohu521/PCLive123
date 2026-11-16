/**
 * PlaybackStreamHub — 统一的音视频流接口
 *
 * 所有播放模式（内置解码 / 嗅探 / 本地视频 / 本地直播源 / 视频流解析版）最终都
 * 通过本模块对外输出一份「统一播放源描述 + 视频元素 + MediaStream」：
 *
 *   - source        统一播放源描述（含直链、请求头、格式）
 *   - videoElement  主窗口 <video> 元素（Artplayer 播放器）
 *   - mediaStream   由 videoElement.captureStream() 派生的音视频流（含音轨）
 *
 * 官网直播源的网页版（webview）不接入本接口：它没有主窗口 <video>，也不参与
 * 录屏 / 悬浮窗 / 投屏 / 画中画。仅 Artplayer 播放器接入。
 *
 * 下游功能模块（录屏 / 悬浮窗 / 投屏）以「消费者」身份注册到本 hub，
 * 仅当对应功能开启（enableConsumer）时才接收流数据，未开启的消费者不会被推送。
 * 下载模块不注册消费者，而是直接通过 resolveStreamUrl / resolveStreamHeaders 解析统一直链。
 */

import { logger } from '@/utils/logger'

/** 可订阅流数据的功能模块 */
export type StreamConsumerKind = 'record' | 'float' | 'cast'

/** 统一的播放源描述（覆盖所有 Artplayer 播放模式） */
export interface PlaybackSource {
  type: 'none' | 'stream'
  /** stream 模式的流地址 */
  url?: string
  /** stream 模式拉流所需的请求头 */
  headers?: Record<string, string>
  /** 流格式（m3u8 / flv / ts / mp4 ...） */
  format?: string
}

/** 每次分发给消费者的帧信息 */
export interface PlaybackFrame {
  source: PlaybackSource
  videoElement: HTMLVideoElement | null
  mediaStream: MediaStream | null
}

export type ConsumerHandler = (frame: PlaybackFrame) => void

interface Consumer {
  enabled: boolean
  handler: ConsumerHandler
}

class PlaybackStreamHub {
  private source: PlaybackSource = { type: 'none' }
  private videoElement: HTMLVideoElement | null = null
  private mediaStream: MediaStream | null = null
  private mediaStreamOnAddTrack: ((ev: Event) => void) | null = null
  private consumers = new Map<StreamConsumerKind, Consumer>()
  private mediaStreamListeners = new Set<(stream: MediaStream | null) => void>()
  // 主界面 + 悬浮窗镜像 + 录屏共用的唯一音频图：
  //   elementSrc (createMediaElementSource) ─┬→ mainGain → destination（主界面扬声器）
  //                                           ├→ mirrorDest（悬浮窗镜像音轨，恒满幅）
  //                                           └→ recordGain → recordDest（录屏音轨，跟随主界面音量）
  // createMediaElementSource 对每个 <video> 只能调用一次；一旦调用，Chromium 会停止该元素
  // captureStream() 音轨的数据产出（实测轨道状态字段全部正常但 RMS 恒为 0）。因此主界面扬声器、
  // 悬浮窗镜像与录屏必须共用同一个 elementSrc，不能再各自 createMediaElementSource 或重采集 captureStream。
  private audioCtx: AudioContext | null = null
  private attachedVideoEl: HTMLVideoElement | null = null
  private elementSrc: MediaElementAudioSourceNode | null = null
  private mainGain: GainNode | null = null
  private mirrorDest: MediaStreamAudioDestinationNode | null = null
  private mirrorAudioStream: MediaStream | null = null
  // 录屏音频分支：recordGain 由 setMainVolume 跟随主界面音量，镜像音轨分支则恒满幅不受影响。
  private recordGain: GainNode | null = null
  private recordDest: MediaStreamAudioDestinationNode | null = null
  private lastMainVolume = 1
  private lastMainMuted = false

  /** 注册一个功能模块消费者（默认关闭，需显式 enable 才会接收数据） */
  registerConsumer(kind: StreamConsumerKind, handler: ConsumerHandler): void {
    this.consumers.set(kind, { enabled: false, handler })
  }

  /** 开启某个功能模块，并立即推送一次当前状态，保证开启即同步 */
  enableConsumer(kind: StreamConsumerKind): void {
    const c = this.consumers.get(kind)
    if (!c) return
    c.enabled = true
    this.dispatchTo(kind, c)
  }

  /** 关闭某个功能模块，之后不再接收流数据 */
  disableConsumer(kind: StreamConsumerKind): void {
    const c = this.consumers.get(kind)
    if (c) c.enabled = false
  }

  /** 订阅 MediaStream 变化（切频道 / 切线路导致 <video> 重建时通知），返回取消订阅函数 */
  onMediaStreamChange(cb: (stream: MediaStream | null) => void): () => void {
    this.mediaStreamListeners.add(cb)
    return () => { this.mediaStreamListeners.delete(cb) }
  }

  /** 发布新的播放源（切频道 / 切线路 / 切播放模式时调用） */
  publishSource(source: PlaybackSource): void {
    this.source = source
    this.dispatch()
  }

  /** 发布主窗口视频元素（非网页模式），并派生其音视频 MediaStream */
  publishVideoElement(el: HTMLVideoElement | null): void {
    this.videoElement = el
    // 注意：这里绝不能 stop 旧捕获流的轨道。HTMLMediaElement.captureStream() 是幂等的，
    // 多次调用返回同一个 MediaStream；<video> 切源（切频道 / 切线路）时，captureStream
    // 的流会由浏览器自动同步轨道的 removetrack / addtrack。若在此手动 stop 旧轨道，
    // 切源后新轨道的 addtrack 尚未发生时，会留下一个 readyState='ended' 的旧轨道，
    // 重协商时把这条已死的轨道推给悬浮窗，导致画面 / 声音在「首次正常、切换后失效」。
    if (el && typeof el.captureStream === 'function') {
      try {
        const stream = el.captureStream()
        if (stream !== this.mediaStream) {
          // 换成了新的捕获流（防御 captureStream 返回新对象的情况）：迁移 addtrack 监听
          if (this.mediaStream && this.mediaStreamOnAddTrack) {
            this.mediaStream.removeEventListener('addtrack', this.mediaStreamOnAddTrack)
            this.mediaStreamOnAddTrack = null
          }
          this.mediaStream = stream
        }
        // 兜底清理：发布瞬间流中若已堆积多条同类轨道（切源时浏览器把新轨道追加到旧轨道之后，
        // 旧轨道仍为 live 但已不再产生数据），这里统一只保留最新一条，避免把僵尸轨道推给悬浮窗。
        this.pruneStaleTracks()
        logger.log(
          `[StreamHub][publishVideoElement] captureStream 轨道=[${stream.getTracks().map((t) => `${t.kind}:${t.id}:${t.readyState}:en${t.enabled}:mu${t.muted}`).join(',')}] ` +
          `video.muted=${el.muted} video.volume=${el.volume}`,
        )
        // captureStream 的音轨可能晚于视频轨就绪（HLS 音视频分离加载时，
        // loadedmetadata 时刻 audio track 尚未 append，captureStream 只拿到视频轨）。
        // 监听 addtrack：一旦音轨补全，立即通知订阅方（悬浮窗镜像）重新协商，
        // 否则悬浮窗只会推视频、永远无声。
        if (!this.mediaStreamOnAddTrack) {
          const onAddTrack = (ev: Event) => {
            const tr = (ev as MediaStreamTrackEvent).track
            // 关键修复：切源（切频道 / 切线路）时 captureStream 并不会移除旧轨道，而是
            // 把新轨道追加进同一个 MediaStream，旧轨道仍保持 readyState='live'、enabled=true、
            // muted=false，却不再产生任何数据（实测其音频 RMS 恒为 0，即「僵尸轨道」）。
            // 若不清理，下游任何「取第一条 live 轨道」的逻辑都会拿到僵尸轨道，表现为
            // 「首次打开正常，切换频道 / 重新打开后声音（或画面）彻底失效」。
            // 因此每次有新轨道加入，都立刻把同类旧轨道从流中摘掉，保证每种轨道只保留最新一条。
            this.pruneStaleTracks()
            logger.log(
              `[StreamHub][addtrack] 新增轨道 kind=${tr?.kind} id=${tr?.id} readyState=${tr?.readyState}；全部=[` +
              (this.mediaStream?.getTracks().map((t) => `${t.kind}:${t.id}:${t.readyState}`).join(',') || '无') + ']',
            )
            // 注意：镜像音轨不再依赖 captureStream 的原始音轨（那会被 createMediaElementSource
            // 旁路截断），而是直接从 elementSrc 分支，天然跟随最新播放内容，无需此处重绑定。
            this.mediaStreamListeners.forEach((cb) => cb(this.mediaStream))
          }
          this.mediaStream.addEventListener('addtrack', onAddTrack)
          this.mediaStreamOnAddTrack = onAddTrack
          this.mediaStream.addEventListener('removetrack', (ev: MediaStreamTrackEvent) => {
            const tr = ev.track
            logger.warn(
              `[StreamHub][removetrack] 轨道被移除 kind=${tr?.kind} id=${tr?.id} readyState=${tr?.readyState}；剩余=[` +
              (this.mediaStream?.getTracks().map((t) => `${t.kind}:${t.id}:${t.readyState}`).join(',') || '无') + ']',
            )
          })
        }
      } catch (e) {
        logger.warn('[PlaybackStreamHub] captureStream 失败:', e)
      }
    } else {
      if (this.mediaStream && this.mediaStreamOnAddTrack) {
        this.mediaStream.removeEventListener('addtrack', this.mediaStreamOnAddTrack)
        this.mediaStreamOnAddTrack = null
      }
      this.mediaStream = null
    }
    // 绑定 / 解绑主窗口音频图：切频道 / 切线路换新音轨时，<video> 元素不变，elementSrc 恒定，
    // 镜像音轨直接从 elementSrc 分支，天然跟随最新播放内容，无需重建。
    if (el) this.attachVideoElement(el)
    else this.detachVideoElement()
    this.dispatch()
    this.mediaStreamListeners.forEach((cb) => cb(this.mediaStream))
  }

  getMediaStream(): MediaStream | null {
    return this.mediaStream
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.videoElement
  }

  /**
   * 绑定主窗口 <video> 并创建唯一一条 Web Audio 音频图：
   *   elementSrc (createMediaElementSource) ─┬→ mainGain → destination（主界面扬声器）
   *                                           ├→ mirrorDest（悬浮窗镜像音轨，恒满幅）
   *                                           └→ recordGain → recordDest（录屏音轨，跟随主界面音量）
   * 关键：createMediaElementSource 对每个 <video> 只能调用一次，且一旦调用，Chromium 会
   * 停止该元素 captureStream() 音轨的数据产出（实测轨道状态字段全部正常但 RMS 恒为 0）。
   * 因此主界面扬声器、悬浮窗镜像与录屏必须共用同一个 elementSrc，绝不能各自再 createMediaElementSource，
   * 也不能再去重采集 captureStream 音轨——那正是悬浮窗/录屏无声的根因。
   */
  private ensureAudioGraph(video: HTMLVideoElement): void {
    if (this.elementSrc) return
    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext
      if (!Ctor) return
      this.audioCtx = new Ctor()
      this.elementSrc = this.audioCtx.createMediaElementSource(video)
      this.mainGain = this.audioCtx.createGain()
      this.elementSrc.connect(this.mainGain)
      this.mainGain.connect(this.audioCtx.destination)
      // 录屏音频分支：独立 GainNode 跟随主界面音量，输出到独立 destination。
      // 录屏音量完全由主界面音量控制模块（setMainVolume）决定，绝不触碰恒满幅的镜像音轨。
      this.recordGain = this.audioCtx.createGain()
      this.recordGain.gain.value = this.lastMainMuted ? 0 : this.lastMainVolume
      this.recordDest = this.audioCtx.createMediaStreamDestination()
      this.elementSrc.connect(this.recordGain)
      this.recordGain.connect(this.recordDest)
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
      this.rebuildMirrorDestination()
      logger.log('[StreamHub][audioGraph] 主界面 + 镜像 + 录屏共用音频图已创建（createMediaElementSource → 主增益 / 镜像音轨 / 录屏音轨）')
    } catch (e) {
      this.elementSrc = null
      logger.warn('[StreamHub][audioGraph] 创建失败:', e)
    }
  }

  /**
   * 主窗口播放器创建 <video> 后调用：绑定唯一音频图（含主界面扬声器 + 悬浮窗镜像音轨）。
   * 若传入的是一个新的 <video>（元素被重建），先释放旧图再绑定新元素。
   */
  attachVideoElement(video: HTMLVideoElement): void {
    if (this.elementSrc && this.attachedVideoEl !== video) {
      this.detachVideoElement()
    }
    this.attachedVideoEl = video
    this.ensureAudioGraph(video)
  }

  /**
   * 主窗口播放器销毁时调用：关闭音频图，释放 AudioContext 与各节点。
   */
  detachVideoElement(): void {
    if (this.elementSrc) { try { this.elementSrc.disconnect() } catch (_) {} }
    if (this.mainGain) { try { this.mainGain.disconnect() } catch (_) {} }
    if (this.recordGain) { try { this.recordGain.disconnect() } catch (_) {} }
    if (this.recordDest) { try { this.recordDest.disconnect() } catch (_) {} }
    if (this.audioCtx) { try { this.audioCtx.close() } catch (_) {} }
    this.elementSrc = null
    this.mainGain = null
    this.mirrorDest = null
    this.mirrorAudioStream = null
    this.recordGain = null
    this.recordDest = null
    this.audioCtx = null
    this.attachedVideoEl = null
  }

  /**
   * 把主界面逻辑音量 / 静音应用到扬声器增益（mainGain）与录屏增益（recordGain）。
   * 镜像音轨（elementSrc → mirrorDest）恒满幅，绝不触碰；也绝不触碰 <video>.volume / .muted。
   */
  setMainVolume(volume: number, muted: boolean): void {
    this.lastMainVolume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 0))
    this.lastMainMuted = !!muted
    const v = muted ? 0 : this.lastMainVolume
    if (this.mainGain) this.mainGain.gain.value = v
    if (this.recordGain) this.recordGain.gain.value = v
  }

  /**
   * 重建镜像音轨输出节点（MediaStreamAudioDestinationNode），得到一条全新 ID 的镜像音轨。
   *
   * 悬浮窗重新打开 / 需要强制新建 WebRTC 发送器时调用：换新 ID 后 renegotiate 会因 audioId
   * 变化重新 addTrack，强制新建发送器，规避旧音轨数据管道在上一轮 sender 销毁后无法重启的问题。
   */
  private rebuildMirrorDestination(): void {
    if (!this.audioCtx || !this.elementSrc) return
    // 先断开旧的镜像输出节点，避免 elementSrc 同时连接多个 destination 造成音频分支泄漏
    if (this.mirrorDest) {
      try { this.elementSrc.disconnect(this.mirrorDest) } catch (_) {}
      this.mirrorDest = null
    }
    this.mirrorDest = this.audioCtx.createMediaStreamDestination()
    this.elementSrc.connect(this.mirrorDest)
    this.mirrorAudioStream = this.mirrorDest.stream
    logger.log(
      `[StreamHub][audioGraph] 已重建镜像音轨 id=${this.mirrorAudioStream?.getAudioTracks()[0]?.id ?? '无'} ctx=${this.audioCtx.state}`,
    )
  }

  /**
   * 强制刷新镜像音轨（重新打开悬浮窗时调用）：
   * 重建输出节点得到全新 ID 的音轨，确保 WebRTC 每次都使用全新的发送器，
   * 规避旧音轨数据管道在上一轮 sender 销毁后无法重启的问题。
   */
  refreshMirrorAudio(): void {
    if (!this.elementSrc) return
    this.rebuildMirrorDestination()
  }

  /**
   * 取「悬浮窗实时镜像」专用流：
   *   - 视频轨：captureStream 中最新的活跃视频轨（画面与主窗口完全一致）
   *   - 音频轨：elementSrc 分支出来的镜像音轨（恒满幅、永不受主窗口静音 / 音量影响）
   * 仅悬浮窗镜像使用本接口；录制 / 下载 / 投屏等仍走 getMediaStream() 的原始捕获流。
   */
  getMirrorMediaStream(): MediaStream | null {
    const s = this.mediaStream
    let video: MediaStreamTrack | null = null
    if (s) {
      const videos = s.getVideoTracks()
      for (let i = videos.length - 1; i >= 0; i--) {
        if (videos[i].readyState === 'live') { video = videos[i]; break }
      }
    }
    // 音频轨直接取 elementSrc 分支出来的镜像音轨（恒满幅、永不受主界面音量/静音影响），
    // 绝不回落到 captureStream 原始音轨——那会被 createMediaElementSource 旁路截断成空数据，
    // 一旦兜底就会让「悬浮窗音量不受主界面影响」的硬性要求失效。
    if (this.audioCtx && this.audioCtx.state !== 'running') {
      this.audioCtx.resume().catch(() => {})
    }
    let audio: MediaStreamTrack | null = null
    const audios = this.mirrorAudioStream?.getAudioTracks() ?? []
    for (let i = audios.length - 1; i >= 0; i--) {
      if (audios[i].readyState === 'live') { audio = audios[i]; break }
    }
    logger.log(
      `[StreamHub][getMirrorMediaStream] video=${video ? `${video.id}:${video.readyState}:mu${video.muted}` : '无'} ` +
      `audio=${audio ? `${audio.id}:${audio.readyState}:en${audio.enabled}:mu${audio.muted}` : '无'} ` +
      `ctx=${this.audioCtx?.state ?? 'null'} 镜像流音轨=[${audios.map((t) => `${t.id}:${t.readyState}`).join(',') || '无'}] ` +
      `原始流音轨=[${(s?.getAudioTracks() ?? []).map((t) => `${t.id}:${t.readyState}:mu${t.muted}`).join(',') || '无'}]`,
    )
    const tracks: MediaStreamTrack[] = []
    if (video) tracks.push(video)
    if (audio) tracks.push(audio)
    if (!tracks.length) return null
    return new MediaStream(tracks)
  }

  /**
   * 取「录屏」专用音轨：elementSrc → recordGain → recordDest 分支的输出音轨。
   * 该音轨由 recordGain 跟随主界面音量（setMainVolume 同步），与镜像音轨（恒满幅）完全隔离，
   * 因此录屏音量完全由主界面音量控制模块决定；且不依赖被 createMediaElementSource 旁路截断的
   * captureStream 原始音轨（其音频 RMS 恒为 0），这正是录屏无声的根因所在。
   */
  getRecordAudioTrack(): MediaStreamTrack | null {
    if (this.audioCtx && this.audioCtx.state !== 'running') {
      this.audioCtx.resume().catch(() => {})
    }
    const audios = this.recordDest?.stream?.getAudioTracks() ?? []
    for (let i = audios.length - 1; i >= 0; i--) {
      if (audios[i].readyState === 'live') return audios[i]
    }
    return null
  }

  /**
   * 只保留每种轨道（audio / video）中最新的一条，摘除同类旧轨道。
   *
   * 背景（已用独立测试程序在 Electron 内实测确认）：
   * <video> 切换 src（切频道 / 切线路）时，浏览器不会 stop 旧轨道，而是把新轨道
   * 追加到 captureStream 返回的同一个 MediaStream 末尾。此时 getTracks() 形如
   * [audio:旧, video:旧, audio:新, video:新]，四条全部 readyState='live'、
   * enabled=true、muted=false，但旧轨道已彻底停止产出数据（音频 RMS 恒为 0）。
   * 下游若取「第一条 live 轨道」，必然拿到僵尸轨道，于是出现「首次正常、切源后无声」。
   * 摘除旧轨道不影响 <video> 自身播放（captureStream 只是旁路派生），
   * 但能保证任何消费者（WebRTC 镜像、录制、下载）拿到的都是唯一且最新的轨道。
   */
  private pruneStaleTracks(): void {
    const s = this.mediaStream
    if (!s) return
    ;(['audio', 'video'] as const).forEach((kind) => {
      const same = s.getTracks().filter((t) => t.kind === kind)
      if (same.length <= 1) return
      // getTracks() 按加入顺序返回，末尾即最新；旧的全部摘掉
      same.slice(0, same.length - 1).forEach((t) => {
        try {
          s.removeTrack(t)
        } catch (_) {}
        logger.warn(
          `[StreamHub][prune] 摘除同类僵尸轨道 kind=${t.kind} id=${t.id} readyState=${t.readyState} ` +
          `（保留最新 ${same[same.length - 1].id}）`,
        )
      })
    })
  }

  /** 取当前可直接下载 / 投屏的直链地址 */
  resolveStreamUrl(source?: PlaybackSource): string {
    const s = source || this.source
    return s.url || ''
  }

  /** 取当前直链所需的请求头 */
  resolveStreamHeaders(source?: PlaybackSource): Record<string, string> {
    const s = source || this.source
    return { ...(s.headers || {}) }
  }

  private snapshot(): PlaybackFrame {
    return {
      source: this.source,
      videoElement: this.videoElement,
      mediaStream: this.mediaStream,
    }
  }

  private dispatchTo(kind: StreamConsumerKind, c: Consumer): void {
    if (!c.enabled) return
    try {
      c.handler(this.snapshot())
    } catch (e) {
      logger.error(`[PlaybackStreamHub] consumer '${kind}' 处理异常:`, e)
    }
  }

  private dispatch(): void {
    this.consumers.forEach((c, kind) => this.dispatchTo(kind, c))
  }
}

/** 全局单例：主窗口内唯一流接口出口 */
export const playbackStreamHub = new PlaybackStreamHub()