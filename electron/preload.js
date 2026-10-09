const { contextBridge, ipcRenderer } = require('electron')

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev')

contextBridge.exposeInMainWorld('electronAPI', {
  isDev,
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  getStoreValue: (key) => ipcRenderer.invoke('get-store-value', key),
  setStoreValue: (key, value) => ipcRenderer.invoke('set-store-value', key, value),
  deleteStoreValue: (key) => ipcRenderer.invoke('delete-store-value', key),

  getSources: () => ipcRenderer.invoke('get-sources'),
  saveSources: (list) => ipcRenderer.sendSync('save-sources', list),
  getSourcesPath: () => ipcRenderer.invoke('get-sources-path'),
  getChannelCacheEntry: (url) => ipcRenderer.invoke('get-channel-cache-entry', url),
  setChannelCacheEntry: (url, entry) => ipcRenderer.invoke('set-channel-cache-entry', url, entry),
  deleteChannelCacheEntry: (url) => ipcRenderer.invoke('delete-channel-cache-entry', url),
  clearChannelCache: () => ipcRenderer.invoke('clear-channel-cache'),

  fetchUrl: (url, headers) => ipcRenderer.invoke('fetch-url', url, headers || {}),
  fetchUrlSpider: (url, headers) => ipcRenderer.invoke('fetch-url-spider', url, headers || {}),

  probeStream: (url, headers) => ipcRenderer.invoke('probe-stream', url, headers || {}),
  probeGatewayFormat: (url, headers) => ipcRenderer.invoke('probe-gateway-format', url, headers || {}),
  createStreamSession: (url, headers, detectedFormat, preferIpv6) => ipcRenderer.invoke('create-stream-session', url, headers || {}, detectedFormat || null, preferIpv6 || false),
  closeStreamSession: (sessionId) => ipcRenderer.invoke('close-stream-session', sessionId),
  registerVideoHeaders: (domainKey, domainName, headers) => ipcRenderer.invoke('register-video-headers', domainKey, domainName, headers || {}),
  unregisterVideoHeaders: (domainKey) => ipcRenderer.invoke('unregister-video-headers', domainKey),

  setNetworkingConfig: (config) => ipcRenderer.invoke('set-networking-config', config || {}),
  clearNetworkingConfig: () => ipcRenderer.invoke('clear-networking-config'),

  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options || {}),
  openMediaFile: (options) => ipcRenderer.invoke('dialog:openMediaFile', options || {}),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options || {}),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('file:write', filePath, content),
  fileExists: (filePath) => ipcRenderer.invoke('file:exists', filePath),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  scanVideoDirectory: () => ipcRenderer.invoke('dialog:scanVideoDirectory'),
  sniffUrl: (pageUrl) => ipcRenderer.invoke('sniff-url', pageUrl),
  resolvePlayUrl: (siteMeta) => ipcRenderer.invoke('resolve-external-play-url', siteMeta),

  // 央视频 (yangshipin.cn) —— 提取官方频道链接
  yspExtractChannels: () => ipcRenderer.invoke('ysp-extract-channels'),

  createFloatWindow: (videoInfo) => ipcRenderer.invoke('create-float-window', videoInfo),
  floatWindowUpdate: (videoInfo) => ipcRenderer.invoke('float-window-update', videoInfo),
  closeFloatWindow: () => ipcRenderer.invoke('close-float-window'),
  floatWindowExists: () => ipcRenderer.invoke('float-window-exists'),
  toggleFloatFullscreen: () => ipcRenderer.invoke('toggle-float-fullscreen'),
  onFloatVideoUpdate: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('float-video-update', handler)
    return () => ipcRenderer.removeListener('float-video-update', handler)
  },

  // Mirror session - WebRTC signaling relay for float window video mirroring
  mirrorSignal: (data) => ipcRenderer.invoke('mirror:signal', data),
  onMirrorSignal: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('mirror:signal', handler)
    return () => ipcRenderer.removeListener('mirror:signal', handler)
  },

  dlnaDiscover: () => ipcRenderer.invoke('dlna-discover'),
  dlnaCast: (deviceIndex, videoUrl) => ipcRenderer.invoke('dlna-cast', deviceIndex, videoUrl),
  dlnaStop: (deviceIndex) => ipcRenderer.invoke('dlna-stop', deviceIndex),
  dlnaPause: (deviceIndex) => ipcRenderer.invoke('dlna-pause', deviceIndex),
  dlnaSetVolume: (deviceIndex, volume) => ipcRenderer.invoke('dlna-set-volume', deviceIndex, volume),

  tlv1Discover: (opts) => ipcRenderer.invoke('tlv1-discover', opts || {}),
  tlv1Cast: (deviceIndex, videoUrl, options) => ipcRenderer.invoke('tlv1-cast', deviceIndex, videoUrl, options || {}),
  tlv1Stop: (deviceIndex, sessionId) => ipcRenderer.invoke('tlv1-stop', deviceIndex, sessionId),
  tlv1Pause: (deviceIndex, sessionId, currentPosition) => ipcRenderer.invoke('tlv1-pause', deviceIndex, sessionId, currentPosition),
  tlv1Resume: (deviceIndex, sessionId) => ipcRenderer.invoke('tlv1-resume', deviceIndex, null, sessionId),
  tlv1Seek: (deviceIndex, positionSec, sessionId) => ipcRenderer.invoke('tlv1-seek', deviceIndex, positionSec, sessionId),
  tlv1SyncLocalChannels: (deviceIndex, channelsData) => ipcRenderer.invoke('tlv1-sync-local-channels', deviceIndex, channelsData),
  tlv1GetSubnets: () => ipcRenderer.invoke('tlv1-get-subnets'),
  tlv1GetLocalIps: () => ipcRenderer.invoke('tlv1-get-local-ips'),
  tlv1EmulatorStatus: () => ipcRenderer.invoke('tlv1-emulator-status'),
  tlv1EmulatorForward: () => ipcRenderer.invoke('tlv1-emulator-forward'),
  tlv1Connect: (ip) => ipcRenderer.invoke('tlv1-connect', ip),
  tlv1SelectAdb: () => ipcRenderer.invoke('tlv1-select-adb'),
  tlv1SetAdbPath: (path) => ipcRenderer.invoke('tlv1-set-adb-path', path),
  tlv1GetAdbPath: () => ipcRenderer.invoke('tlv1-get-adb-path'),
  tlv1OnLog: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('tlv1:log', handler)
    return () => ipcRenderer.removeListener('tlv1:log', handler)
  },

  ffmpegSelectPath: () => ipcRenderer.invoke('ffmpeg:selectPath'),
  ffmpegTest: (ffmpegPath) => ipcRenderer.invoke('ffmpeg:test', ffmpegPath),
  ffmpegCreateSession: (sourceUrl, headers, ffmpegPath, seekTime, inputFormat) => ipcRenderer.invoke('ffmpeg:createSession', sourceUrl, headers || {}, ffmpegPath, seekTime, inputFormat),
  ffmpegCloseSession: (sessionId) => ipcRenderer.invoke('ffmpeg:closeSession', sessionId),
  onFfmpegStderr: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('ffmpeg:stderr', handler)
    return () => ipcRenderer.removeListener('ffmpeg:stderr', handler)
  },
  mpvSelectPath: () => ipcRenderer.invoke('mpv:selectPath'),
  mpvTest: (mpvPath) => ipcRenderer.invoke('mpv:test', mpvPath),
  mpvCreateSession: (sourceUrl, headers, mpvPath, seekTime) => ipcRenderer.invoke('mpv:createSession', sourceUrl, headers || {}, mpvPath, seekTime),
  mpvCloseSession: (sessionId) => ipcRenderer.invoke('mpv:closeSession', sessionId),
  onMpvPlaybackEnded: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('mpv:playbackEnded', handler)
    return () => ipcRenderer.removeListener('mpv:playbackEnded', handler)
  },
  vlcSelectPath: () => ipcRenderer.invoke('vlc:selectPath'),
  vlcTest: (vlcPath) => ipcRenderer.invoke('vlc:test', vlcPath),
  vlcCreateSession: (sourceUrl, headers, vlcPath, seekTime) => ipcRenderer.invoke('vlc:createSession', sourceUrl, headers || {}, vlcPath, seekTime),
  vlcCloseSession: (sessionId) => ipcRenderer.invoke('vlc:closeSession', sessionId),
  onVlcPlaybackEnded: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('vlc:playbackEnded', handler)
    return () => ipcRenderer.removeListener('vlc:playbackEnded', handler)
  },
  onMainDebugLog: (callback) => {
    const handler = (_event, line) => callback(line)
    ipcRenderer.on('main:debugLog', handler)
    return () => ipcRenderer.removeListener('main:debugLog', handler)
  },

  serveLocalFile: (filePath) => ipcRenderer.invoke('local-file:serve', filePath),
  closeLocalFileServer: (token) => ipcRenderer.invoke('local-file:close', token),

  readLocalChannels: () => ipcRenderer.invoke('local-channels:read'),
  writeLocalChannels: (data) => ipcRenderer.invoke('local-channels:write', data),

  // 央视频频道列表持久化
  readYspChannels: () => ipcRenderer.invoke('ysp-channels:read'),
  writeYspChannels: (data) => ipcRenderer.invoke('ysp-channels:write', data),
  openYspChannelsFile: () => ipcRenderer.invoke('ysp-channels:openFile'),
  getYspChannelsPath: () => ipcRenderer.invoke('ysp-channels:getPath'),

  recordingSelectOutput: () => ipcRenderer.invoke('recording:selectOutput'),
  recordingStartStream: (params) => ipcRenderer.invoke('recording:startStream', params),
  recordingWriteChunk: (chunk) => ipcRenderer.invoke('recording:writeChunk', chunk),
  recordingFinishStream: () => ipcRenderer.invoke('recording:finishStream'),
  recordingStatus: () => ipcRenderer.invoke('recording:status'),

  rendererLog: (msg) => ipcRenderer.send('renderer:log', msg),
  hasIpv6: () => ipcRenderer.invoke('network:hasIpv6'),
})