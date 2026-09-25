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

  probeStream: (url, headers) => ipcRenderer.invoke('probe-stream', url, headers || {}),
  createStreamSession: (url, headers, detectedFormat) => ipcRenderer.invoke('create-stream-session', url, headers || {}, detectedFormat || null),
  closeStreamSession: (sessionId) => ipcRenderer.invoke('close-stream-session', sessionId),
  registerVideoHeaders: (domainKey, domainName, headers) => ipcRenderer.invoke('register-video-headers', domainKey, domainName, headers || {}),
  unregisterVideoHeaders: (domainKey) => ipcRenderer.invoke('unregister-video-headers', domainKey),

  setNetworkingConfig: (config) => ipcRenderer.invoke('set-networking-config', config || {}),
  clearNetworkingConfig: () => ipcRenderer.invoke('clear-networking-config'),

  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options || {}),
  saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options || {}),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('file:write', filePath, content),
  fileExists: (filePath) => ipcRenderer.invoke('file:exists', filePath),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  scanVideoDirectory: () => ipcRenderer.invoke('dialog:scanVideoDirectory'),
  sniffUrl: (pageUrl) => ipcRenderer.invoke('sniff-url', pageUrl),
  resolvePlayUrl: (siteMeta) => ipcRenderer.invoke('resolve-external-play-url', siteMeta),

  createFloatWindow: (videoInfo) => ipcRenderer.invoke('create-float-window', videoInfo),
  floatWindowUpdate: (videoInfo) => ipcRenderer.invoke('float-window-update', videoInfo),
  closeFloatWindow: () => ipcRenderer.invoke('close-float-window'),
  floatWindowExists: () => ipcRenderer.invoke('float-window-exists'),
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

  ffmpegSelectPath: () => ipcRenderer.invoke('ffmpeg:selectPath'),
  ffmpegTest: (ffmpegPath) => ipcRenderer.invoke('ffmpeg:test', ffmpegPath),
  ffmpegCreateSession: (sourceUrl, headers, ffmpegPath, seekTime, inputFormat) => ipcRenderer.invoke('ffmpeg:createSession', sourceUrl, headers || {}, ffmpegPath, seekTime, inputFormat),
  ffmpegCloseSession: (sessionId) => ipcRenderer.invoke('ffmpeg:closeSession', sessionId),
  onFfmpegStderr: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('ffmpeg:stderr', handler)
    return () => ipcRenderer.removeListener('ffmpeg:stderr', handler)
  },
  onMainDebugLog: (callback) => {
    const handler = (_event, line) => callback(line)
    ipcRenderer.on('main:debugLog', handler)
    return () => ipcRenderer.removeListener('main:debugLog', handler)
  },

  serveLocalFile: (filePath) => ipcRenderer.invoke('local-file:serve', filePath),
  closeLocalFileServer: (token) => ipcRenderer.invoke('local-file:close', token),
})