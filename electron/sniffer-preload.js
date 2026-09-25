// Sniffer stealth preload — patches navigator/DOM to evade anti-bot detection.
// This runs in the SAME world as the page (contextIsolation: false), so patches
// take effect before any page JavaScript executes.

(function() {
  'use strict'

  // 1. Kill navigator.webdriver (biggest anti-bot red flag)
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: function() { return undefined },
      configurable: true,
      enumerable: true
    })
  } catch (_) {}

  // 2. Fake plugins
  try {
    const makePlugins = () => {
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ]
      Object.setPrototypeOf(arr, PluginArray.prototype)
      return arr
    }
    Object.defineProperty(Navigator.prototype, 'plugins', {
      get: function() { return makePlugins() },
      configurable: true
    })
  } catch (_) {}

  // 3. languages
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: function() { return ['zh-CN', 'zh', 'en-US', 'en'] },
      configurable: true
    })
  } catch (_) {}

  // 4. hardwareConcurrency
  try {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
      get: function() { return 8 },
      configurable: true
    })
  } catch (_) {}

  // 5. platform
  try {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get: function() { return 'Win32' },
      configurable: true
    })
  } catch (_) {}

  // 6. vendor
  try {
    Object.defineProperty(Navigator.prototype, 'vendor', {
      get: function() { return 'Google Inc.' },
      configurable: true
    })
  } catch (_) {}

  // 7. maxTouchPoints
  try {
    Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
      get: function() { return 0 },
      configurable: true
    })
  } catch (_) {}

  // 8. screen color depth
  try {
    Object.defineProperty(Screen.prototype || screen.__proto__, 'colorDepth', {
      get: function() { return 24 },
      configurable: true
    })
  } catch (_) {}

  // 9. deviceMemory
  try {
    Object.defineProperty(Navigator.prototype, 'deviceMemory', {
      get: function() { return 8 },
      configurable: true
    })
  } catch (_) {}

  // 10. connection
  try {
    Object.defineProperty(Navigator.prototype, 'connection', {
      get: function() { return { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false } },
      configurable: true
    })
  } catch (_) {}

  // 11. Permissions (some sites check this)
  try {
    if (!('permissions' in navigator)) {
      Object.defineProperty(Navigator.prototype, 'permissions', {
        get: function() { return { query: function() { return Promise.resolve({ state: 'prompt', onchange: null }) } } },
        configurable: true
      })
    }
  } catch (_) {}

  // 12. chrome object (some sites check window.chrome existence)
  try {
    if (!window.chrome) {
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() { return { onloadT: 0, pageT: 50, tran: 5 } },
        app: {}
      }
    }
  } catch (_) {}

  // 13. navigator.userAgentData (modern Chromium feature)
  try {
    if (!navigator.userAgentData) {
      Object.defineProperty(Navigator.prototype, 'userAgentData', {
        get: function() {
          return {
            brands: [
              { brand: 'Google Chrome', version: '120' },
              { brand: 'Not=A?Brand', version: '24' },
              { brand: 'Chromium', version: '120' }
            ],
            mobile: false,
            platform: 'Windows',
            getHighEntropyValues: function() { return Promise.resolve({}) }
          }
        },
        configurable: true
      })
    }
  } catch (_) {}

  // 14. navigator.appVersion (sometimes flagged if missing)
  try {
    if (!navigator.appVersion || navigator.appVersion.length < 10) {
      Object.defineProperty(Navigator.prototype, 'appVersion', {
        get: function() { return '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        configurable: true
      })
    }
  } catch (_) {}

  // 15. Screen properties (some detection scripts check these)
  try {
    const proto = Screen.prototype || screen.__proto__
    Object.defineProperty(proto, 'width', { get: () => 1920, configurable: true })
    Object.defineProperty(proto, 'height', { get: () => 1080, configurable: true })
    Object.defineProperty(proto, 'availWidth', { get: () => 1920, configurable: true })
    Object.defineProperty(proto, 'availHeight', { get: () => 1040, configurable: true })
  } catch (_) {}
})()