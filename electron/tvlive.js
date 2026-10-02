const http = require('http')
const os = require('os')
const { execSync, exec } = require('child_process')

const TVLIVE_DEFAULT_PORT = 9978
const SCAN_TIMEOUT = 5000
const SCAN_CONCURRENCY = 15
const ADB_TIMEOUT = 8000

let cachedDevices = []

// ---- 日志系统 ----
let _logCallback = null

function setLogCallback(cb) {
  _logCallback = cb
}

function log(level, msg, data) {
  const ts = new Date().toISOString().slice(11, 23)
  const line = `[${ts}] [${level}] ${msg}`
  if (level === 'ERRO') console.error(`[tlv] ${line}`)
  else if (level === 'WARN') console.warn(`[tlv] ${line}`)
  else console.log(`[tlv] ${line}`)
  if (_logCallback) {
    try { _logCallback({ level, msg, data, time: ts }) } catch {}
  }
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces()
  const results = []
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && iface.address !== '127.0.0.1') {
        results.push(iface.address)
      }
    }
  }
  log('DEBG', `本机IP: ${JSON.stringify(results)}`)
  return results
}

const GATEWAY_PROBE_TIMEOUT = 500
const GATEWAY_PROBE_PORT = 80

function getSubnetPrefixes() {
  const ips = getLocalIpAddresses()
  const prefixes = new Set()
  for (const ip of ips) {
    const idx = ip.lastIndexOf('.')
    if (idx > 0) {
      prefixes.add(ip.substring(0, idx + 1))
    }
  }
  const arr = Array.from(prefixes)
  log('DEBG', `本机所在子网: ${JSON.stringify(arr)}`)
  return arr
}

function generateAllSubnetPrefixes() {
  const localPrefixes = getSubnetPrefixes()
  const localSet = new Set(localPrefixes)
  const all = new Set()
  for (const prefix of localPrefixes) {
    const parts = prefix.split('.')
    if (parts.length >= 3) {
      const base = parts[0] + '.' + parts[1] + '.'
      for (let i = 0; i <= 255; i++) {
        all.add(base + i + '.')
      }
    }
  }
  const arr = Array.from(all)
  log('DEBG', `候选子网总数: ${arr.length}个 (本机: ${localPrefixes.length}个)`)
  return { allPrefixes: arr, localPrefixes: localPrefixes }
}

async function probeGatewayPrefixes(allPrefixes) {
  const active = new Set()
  const total = allPrefixes.length
  log('INFO', `===== 网关快速探测 (${total}个子网, 并发${SCAN_CONCURRENCY}, 超时${GATEWAY_PROBE_TIMEOUT}ms) =====`)
  const t0 = Date.now()

  for (let i = 0; i < allPrefixes.length; i += SCAN_CONCURRENCY) {
    const batch = allPrefixes.slice(i, i + SCAN_CONCURRENCY)
    const probes = batch.map((prefix) => {
      const gatewayIp = prefix + '1'
      return new Promise((resolve) => {
        const req = http.get(`http://${gatewayIp}:${GATEWAY_PROBE_PORT}/`, { timeout: GATEWAY_PROBE_TIMEOUT }, (res) => {
          res.resume()
          log('DEBG', `网关响应: ${gatewayIp} code=${res.statusCode}`)
          resolve({ prefix, ip: gatewayIp })
        })
        req.on('error', () => resolve(null))
        req.on('timeout', () => { req.destroy(); resolve(null) })
      })
    })
    const results = await Promise.all(probes)
    for (const r of results) {
      if (r) {
        active.add(r.prefix)
        log('DEBG', `发现活跃子网: ${r.prefix} (网关 ${r.ip})`)
      }
    }
  }

  const arr = Array.from(active)
  const elapsed = Date.now() - t0
  log('INFO', `===== 网关探测完成: 发现${arr.length}个活跃子网 (耗时${elapsed}ms) =====`)
  return arr
}

let _adbPath = null
let _adbOverridePath = null

function setAdbPath(adbPath) {
  if (adbPath && adbPath.trim()) {
    _adbOverridePath = adbPath.trim()
  } else {
    _adbOverridePath = null
  }
}

function isAdbOverridden() {
  return !!_adbOverridePath
}

function getAdbPath() {
  return _adbOverridePath || findAdbPath() || ''
}

function findAdbPath() {
  if (_adbOverridePath) return _adbOverridePath
  if (_adbPath) return _adbPath

  const candidates = []

  // 1. PATH 中的 adb
  candidates.push('adb')

  // 2. SDK 环境变量
  const envDirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  for (const dir of envDirs) {
    if (dir) candidates.push(dir.replace(/\\/g, '/') + '/platform-tools/adb.exe')
  }

  // 3. 正在运行的 adb.exe 进程路径 (优先用 ps，回退到 wmic)
  try {
    let psOut = ''
    try {
      // PowerShell Get-Process（兼容新版 Windows 无 wmic）
      psOut = execSync(
        'powershell -NoProfile -Command "Get-Process adb -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"',
        { timeout: 5000, stdio: 'pipe', windowsHide: true }
      ).toString()
    } catch {}
    if (!psOut.trim()) {
      // 回退 wmic
      try {
        psOut = execSync(
          'wmic process where "name=\'adb.exe\'" get ExecutablePath /format:csv',
          { timeout: 3000, stdio: 'pipe', windowsHide: true }
        ).toString()
      } catch {}
    }
    const psLines = psOut.split(/\r?\n/)
    for (const line of psLines) {
      const m = line.match(/[A-Za-z]:\\.*adb\.exe/i)
      if (m && m[0]) candidates.push(m[0].trim())
    }
  } catch {}

  // 4. 常见第三方工具附带的 adb 路径（GlideX、TotalControl 等）
  const thirdPartyAdbDirs = [
    'C:/Program Files/ASUS/GlideX',
    'C:/Program Files (x86)/ASUS/GlideX',
    'D:/Program Files/ASUS/GlideX',
  ]
  for (const dir of thirdPartyAdbDirs) {
    candidates.push(dir + '/adb.exe')
  }

  // 5. 模拟器常见安装目录（硬编码兜底）
  const emuCommonDirs = [
    'C:/Program Files/Microvirt/MEmu',
    'C:/Program Files (x86)/Microvirt/MEmu',
    'D:/Program Files/Microvirt/MEmu',
    'E:/Program Files/Microvirt/MEmu',
    'C:/Microvirt/MEmu',
    'D:/Microvirt/MEmu',
    'E:/Microvirt/MEmu',
    'C:/Program Files/Nox/bin',
    'C:/Program Files (x86)/Nox/bin',
    'D:/Program Files/Nox/bin',
    'C:/LDPlayer/LDPlayer9',
    'C:/LDPlayer/LDPlayer',
    'D:/LDPlayer/LDPlayer9',
    'D:/LDPlayer/LDPlayer',
  ]
  for (const dir of emuCommonDirs) {
    candidates.push(dir + '/adb.exe', dir + '/nox_adb.exe')
  }

  // 6. 模拟器进程同目录找 adb.exe（优先 ps，回退 wmic）
  const emuNames = ['MEmu.exe', 'MEmuHeadless.exe', 'Nox.exe', 'Ld9BoxHeadless.exe', 'LdPlayer.exe']
  for (const emuName of emuNames) {
    try {
      let emuPath = ''
      try {
        emuPath = execSync(
          `powershell -NoProfile -Command "Get-Process '${emuName.replace('.exe','')}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"`,
          { timeout: 5000, stdio: 'pipe', windowsHide: true }
        ).toString().trim()
      } catch {}
      if (!emuPath) {
        try {
          const wmicOut2 = execSync(
            `wmic process where "name='${emuName}'" get ExecutablePath /format:csv`,
            { timeout: 3000, stdio: 'pipe', windowsHide: true }
          ).toString()
          const m = wmicOut2.match(/[A-Za-z]:\\.*/)
          if (m && m[0]) emuPath = m[0].trim()
        } catch {}
      }
      if (emuPath) {
        const path = require('path')
        const emuDir = path.dirname(emuPath)
        candidates.push(
          path.join(emuDir, 'adb.exe'),
          path.join(emuDir, 'nox_adb.exe'),
        )
      }
    } catch {}
  }

  // 去重
  const seen = new Set()
  const unique = []
  for (const c of candidates) {
    const key = c.replace(/\\/g, '/').toLowerCase()
    if (c && !seen.has(key)) { seen.add(key); unique.push(c) }
  }

  for (const candidate of unique) {
    try {
      execSync(`"${candidate}" version`, { timeout: 3000, stdio: 'pipe', windowsHide: true })
      _adbPath = candidate
      log('INFO', `ADB: 找到 ${candidate}`)
      return candidate
    } catch { continue }
  }
  log('WARN', 'ADB: 未找到')
  return null
}

function execAdb(args, timeout = ADB_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const adb = findAdbPath()
    if (!adb) {
      reject(new Error('adb not found. Please install Android SDK platform-tools.'))
      return
    }
    exec(`"${adb}" ${args}`, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message))
        return
      }
      resolve((stdout || '').trim())
    })
  })
}

async function testAdbPath(adbPath) {
  if (!adbPath) return { success: false, error: '路径为空' }
  try {
    const out = execSync(`"${adbPath}" version`, { timeout: 5000, stdio: 'pipe', windowsHide: true }).toString()
    const verMatch = out.match(/Android Debug Bridge version\s+(\S+)/i)
    return { success: true, version: verMatch ? verMatch[1] : '未识别', output: out.substring(0, 200) }
  } catch (e) {
    return { success: false, error: e.message || String(e) }
  }
}

async function getEmulatorDevices() {
  let output
  try {
    output = await execAdb('devices', 3000)
  } catch {
    return []
  }

  const lines = output.split(/\r?\n/).slice(1)
  const emulators = []
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === 'device') {
      const serial = parts[0]
      const isEmulator = serial.startsWith('emulator-') ||
                         serial.startsWith('127.0.0.1:') ||
                         serial.startsWith('localhost:')
      emulators.push({
        serial,
        isEmulator,
        isNAT: isEmulator,
      })
    }
  }

  // 无设备时尝试自动重连已知模拟器ADB端口
  if (emulators.length === 0) {
    const AUTO_CONNECT_PORTS = [
      11509,  // GlideX / MEmu
      21503, 21513, 21523,  // MEmu 标准端口
      62001, 62025,  // Nox
      5555,  // LDPlayer / AVD
      7555,  // Mumu
    ]
    for (const p of AUTO_CONNECT_PORTS) {
      try {
        const connectOut = await execAdb(`connect 127.0.0.1:${p}`, 3000)
        if (connectOut.includes('connected') || connectOut.includes('already connected')) {
          log('INFO', `ADB自动重连: 127.0.0.1:${p}`)
          // 重新扫描设备
          output = await execAdb('devices', 3000)
          const newLines = output.split(/\r?\n/).slice(1)
          for (const line of newLines) {
            const parts = line.trim().split(/\s+/)
            if (parts.length >= 2 && parts[1] === 'device') {
              const serial = parts[0]
              const isEmulator = serial.startsWith('emulator-') ||
                                 serial.startsWith('127.0.0.1:') ||
                                 serial.startsWith('localhost:')
              emulators.push({
                serial,
                isEmulator,
                isNAT: isEmulator,
              })
            }
          }
          break
        }
      } catch { /* 端口不可用，继续尝试下一个 */ }
    }
  }

  return emulators
}

async function getForwardList() {
  try {
    const output = await execAdb('forward --list', 3000)
    const lines = output.split(/\r?\n/)
    const forwards = []
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3) {
        forwards.push({ serial: parts[0], local: parts[1], remote: parts[2] })
      }
    }
    return forwards
  } catch {
    return []
  }
}

async function setupEmulatorForwarding() {
  const emulators = await getEmulatorDevices()
  if (emulators.length === 0) {
    return { setup: false, reason: 'no_emulator', emulators: [] }
  }

  const existingForwards = await getForwardList()
  const targetPort = 'tcp:' + TVLIVE_DEFAULT_PORT
  const alreadyForwarded = existingForwards.find(f => f.local === targetPort && f.remote === targetPort)

  if (alreadyForwarded) {
    return { setup: true, reason: 'already_forwarded', emulators }
  }

  for (const em of emulators) {
    try {
      await execAdb(`-s ${em.serial} forward tcp:${TVLIVE_DEFAULT_PORT} tcp:${TVLIVE_DEFAULT_PORT}`, 5000)
      return { setup: true, reason: 'forwarded', serial: em.serial, emulators }
    } catch {
      continue
    }
  }

  return { setup: false, reason: 'forward_failed', emulators }
}

async function getEmulatorStatus() {
  const adb = findAdbPath()
  if (!adb) {
    return { available: false, reason: 'adb_not_found' }
  }

  const emulators = await getEmulatorDevices()
  if (emulators.length === 0) {
    return { available: false, reason: 'no_emulator', emulators: [] }
  }

  const natEmulators = emulators.filter(e => e.isNAT)
  const forwarded = await getForwardList()
  const targetPort = 'tcp:' + TVLIVE_DEFAULT_PORT

  return {
    available: true,
    adbPath: adb,
    emulators,
    natEmulators,
    portForwarded: forwarded.some(f => f.local === targetPort && f.remote === targetPort),
  }
}

async function emulatorLoopbackScan() {
  return pingDevice('127.0.0.1', TVLIVE_DEFAULT_PORT)
}

function isSameSubnet(host1, host2) {
  if (!host1 || !host2) return false
  const idx1 = host1.lastIndexOf('.')
  const idx2 = host2.lastIndexOf('.')
  if (idx1 < 0 || idx2 < 0) return false
  return host1.substring(0, idx1) === host2.substring(0, idx2)
}

function fetchDeviceToken(ip, port, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:${port}/api-token`, { timeout }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200 && data) {
          resolve(data.trim())
        } else {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function pingDevice(ip, port, timeout = SCAN_TIMEOUT) {
  return new Promise((resolve) => {
    const req = http.get(`http://${ip}:${port}/ping`, { timeout }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const info = JSON.parse(data)
          if (info && info.app === 'TVLive') {
            fetchDeviceToken(ip, port).then((token) => {
              log('INFO', `发现TVLive设备: ${info.deviceName || '未知'} @ ${ip}:${port}`, info)
              resolve({
                host: ip,
                port: port,
                app: info.app || '',
                version: info.version || '',
                deviceName: info.deviceName || 'TVLive设备',
                deviceModel: info.deviceModel || '',
                manufacturer: info.manufacturer || '',
                caps: info.caps || [],
                isTVLive: true,
                autoconnect: true,
                token: token,
              })
            })
          } else {
            log('DEBG', `设备响应非TVLive @ ${ip}:${port} resp=${data.substring(0, 80)}`)
            resolve(null)
          }
        } catch (e) {
          log('DEBG', `设备响应解析失败 @ ${ip}:${port} err=${e.message}`)
          resolve(null)
        }
      })
    })
    req.on('error', (e) => {
      const code = e.code || e.message
      let detail = code
      if (code === 'ECONNREFUSED') detail = '连接被拒绝(端口未监听或防火墙拦截)'
      else if (code === 'ENETUNREACH') detail = '网络不可达(目标IP不在路由表中)'
      else if (code === 'EHOSTUNREACH') detail = '主机不可达'
      else if (code === 'ETIMEDOUT') detail = '连接超时'
      else if (code === 'ECONNRESET') detail = '连接被重置'
      log('WARN', `ping无响应 @ ${ip}:${port} err=${detail}`)
      resolve(null)
    })
    req.on('timeout', () => {
      log('WARN', `ping超时 @ ${ip}:${port} (${timeout}ms)`)
      req.destroy()
      resolve(null)
    })
  })
}

async function scanSubnetRange(prefix, port, startIp, endIp, timeout = SCAN_TIMEOUT, deadline = 0) {
  const total = endIp - startIp + 1
  log('INFO', `开始扫描子网 ${prefix}* (${total}个IP, 并发${SCAN_CONCURRENCY}, 超时${timeout}ms)`)
  const t0 = Date.now()
  const results = []
  const localIps = getLocalIpAddresses()

  return new Promise((resolve) => {
    let nextIp = startIp
    let activeCount = 0
    let finished = false

    function doResolve() {
      if (finished) return
      finished = true
      const elapsed = Date.now() - t0
      log('INFO', `子网扫描完成 ${prefix}* → 发现${results.length}个设备 (耗时${elapsed}ms)`)
      resolve(results)
    }

    function checkDeadline() {
      if (deadline > 0 && Date.now() >= deadline) {
        doResolve()
        return true
      }
      return false
    }

    function onOneDone() {
      if (finished) return
      if (checkDeadline()) return
      if (activeCount === 0 && nextIp > endIp) {
        doResolve()
        return
      }
      launchBatch()
    }

    function launchBatch() {
      if (finished) return
      if (checkDeadline()) return
      while (activeCount < SCAN_CONCURRENCY && nextIp <= endIp) {
        if (checkDeadline()) return
        const ip = prefix + nextIp
        nextIp++
        if (localIps.includes(ip)) continue
        activeCount++
        pingDevice(ip, port, timeout).then((r) => {
          if (r) results.push(r)
          activeCount--
          onOneDone()
        })
      }
      if (activeCount === 0 && nextIp > endIp && !finished) {
        onOneDone()
      }
    }

    launchBatch()
  })
}

async function connectToIP(ip, port = TVLIVE_DEFAULT_PORT) {
  const MANUAL_TIMEOUT = 5000
  log('INFO', `手动连接: ${ip}:${port}`)

  // 诊断信息：记录本机子网
  const localSubnets = getSubnetPrefixes()
  const ipSubnet = ip.substring(0, ip.lastIndexOf('.') + 1)
  const sameSubnet = localSubnets.some(p => p === ipSubnet)
  log('INFO', `子网检测: 目标=${ipSubnet} 本机=${JSON.stringify(localSubnets)} 同子网=${sameSubnet}`)

  // 1. 先尝试直连（适用于同局域网真实设备 或 模拟器桥接模式）
  let device = await pingDevice(ip, port, MANUAL_TIMEOUT)

  // 直连可达且在同一子网 → 真实局域网设备或桥接模拟器，直接返回
  if (device && sameSubnet) {
    log('INFO', `手动连接成功(直连): ${device.deviceName} @ ${ip}:${port}`)
    return device
  }

  // 直连不可达 → 记录
  if (!device) {
    log('INFO', `直连失败，目标IP无HTTP响应`)
  } else {
    // 直连可达但不在同一子网 → 可能是模拟器NAT（虚拟网卡单向通）
    log('INFO', `直连可达但IP不在本机子网（NAT模拟器），需强制ADB转发以保证投屏时反向可达`)
  }

  // 2. ADB转发通道（直连失败 或 直连可行但子网不同）
  const adb = findAdbPath()
  if (adb) {
    log('INFO', `尝试ADB转发回退...`)
    try {
      const emulators = await getEmulatorDevices()
      log('INFO', `ADB设备列表: ${emulators.length > 0 ? emulators.map(e => e.serial).join(', ') : '(空)'}`)

      if (emulators.length > 0) {
        // 检查是否已有转发
        const forwards = await getForwardList()
        const targetPortStr = 'tcp:' + port
        const alreadyForwarded = forwards.some(f => f.local === targetPortStr && f.remote === targetPortStr)

        if (!alreadyForwarded) {
          let forwarded = false
          for (const em of emulators) {
            try {
              await execAdb(`-s ${em.serial} forward tcp:${port} tcp:${port}`, 5000)
              log('INFO', `ADB转发已建立: ${em.serial} → 127.0.0.1:${port}`)
              forwarded = true
              break
            } catch (e) {
              log('WARN', `ADB转发失败 ${em.serial}: ${e.message}`)
            }
          }
          if (!forwarded) {
            log('WARN', '所有模拟器的ADB转发均失败，可能端口被占用或ADB权限不足')
          }
        } else {
          log('INFO', 'ADB转发已存在，复用')
        }

        // 通过 localhost 连接
        const forwardedDevice = await pingDevice('127.0.0.1', port, MANUAL_TIMEOUT)
        if (forwardedDevice) {
          // 保留 localhost 用于实际HTTP通信（触发投屏处理器走ADB反向转发路径），原始IP仅用于UI显示
          forwardedDevice.displayHost = ip
          forwardedDevice.deviceName = (forwardedDevice.deviceName || 'TVLive设备') + ' (模拟器)'
          log('INFO', `手动连接成功(ADB): ${forwardedDevice.deviceName} @ 127.0.0.1:${port} (显示${ip})`)
          return forwardedDevice
        }
        log('WARN', 'ADB转发已建立但127.0.0.1仍无响应，请确认模拟器内APK投屏服务已启动')
      } else {
        log('WARN', 'ADB可用但未检测到模拟器设备，请确认 adb devices 有设备列表')
      }
    } catch (e) {
      log('ERRO', `ADB转发流程异常: ${e.message}`)
    }
  } else {
    sameSubnet && log('WARN', 'ADB未找到，无法使用转发回退，请安装Android SDK platform-tools')
    !sameSubnet && log('WARN', '目标IP不在本机子网且ADB未找到，请安装ADB或检查模拟器网络模式')
  }

  // 3. 如果直连可达但ADB转发失败（或不可用），标记为模拟器设备返回
  if (device) {
    device.isEmulator = true
    device.displayHost = ip
    log('WARN', `直连可达但子网不同且无ADB转发，投屏时反向访问可能失败`)
    return device
  }

  log('WARN', `手动连接失败: ${ip}:${port} 无响应`)
  const hints = []
  if (!sameSubnet) hints.push('该IP不在本机子网，可能是模拟器NAT地址')
  if (!adb) hints.push('未找到ADB，请安装Android SDK platform-tools或确保模拟器ADB在PATH中')
  if (adb) hints.push('请确认模拟器内TVLive APK已打开且投屏服务已启动')
  const hint = hints.length > 0 ? '（' + hints.join('；') + '）' : ''
  throw new Error(`无法连接到 ${ip}:${port}，设备无响应${hint}`)
}

async function discoverTVLiveDevices(timeout = 40000, opts = {}) {
  const expanded = opts.expanded === true
  log('INFO', `===== 开始设备发现 (全局超时${timeout}ms, 扩展扫描=${expanded}) =====`)
  const t0 = Date.now()
  const prefixes = getSubnetPrefixes()

  let emulatorResult = { setup: false, reason: 'not_attempted', emulators: [] }
  try {
    emulatorResult = await setupEmulatorForwarding()
    log('DEBG', `模拟器转发: ${JSON.stringify(emulatorResult)}`)
  } catch (e) {
    log('WARN', `模拟器检测异常: ${e.message}`)
  }

  if (prefixes.length === 0) {
    log('WARN', '无可用网络接口，仅扫描回环')
    const device = await emulatorLoopbackScan()
    if (device) log('INFO', `回环扫描找到模拟器: ${device.deviceName}`)
    const devices = device ? [device] : []
    cachedDevices = devices
    log('INFO', `设备发现结束 (耗时${Date.now() - t0}ms) 共${devices.length}个设备`)
    return devices
  }

  const deadline = Date.now() + timeout
  const scanTasks = []

  // Phase 1: 始终扫描本机所在子网
  for (const prefix of prefixes) {
    scanTasks.push(scanSubnetRange(prefix, TVLIVE_DEFAULT_PORT, 1, 254, SCAN_TIMEOUT, deadline))
  }

  // Phase 2: 仅在开启"全子网扫描"时 —— 先探测网关，再扫描活跃子网
  if (expanded) {
    const { allPrefixes } = generateAllSubnetPrefixes()
    const localSet = new Set(prefixes)
    const candidates = allPrefixes.filter(p => !localSet.has(p))
    if (candidates.length > 0) {
      log('INFO', `全子网扫描: 网关探测 ${candidates.length} 个候选子网`)
      const activePrefixes = await probeGatewayPrefixes(candidates)
      if (activePrefixes.length > 0) {
        log('INFO', `全子网扫描: 发现${activePrefixes.length}个活跃子网, 开始TVLive扫描`)
        for (const prefix of activePrefixes) {
          scanTasks.push(scanSubnetRange(prefix, TVLIVE_DEFAULT_PORT, 1, 254, SCAN_TIMEOUT, deadline))
        }
      } else {
        log('INFO', '全子网扫描: 未发现额外活跃子网')
      }
    }
  }

  const loopbackTask = emulatorLoopbackScan().then((device) => {
    if (device) {
      device.deviceName = (device.deviceName || 'TVLive设备') + ' (本机模拟器)'
      log('INFO', `回环扫描找到设备: ${device.deviceName}`)
    }
    return device
  })
  scanTasks.push(loopbackTask)

  const rawResults = await Promise.all(scanTasks).then(arrs => arrs.flat())
  const results = rawResults.filter(Boolean)

  // 去重（同一设备可能通过直连和ADB转发同时发现）
  const seen = new Set()
  const deduped = []
  for (const d of results) {
    const key = `${d.host}:${d.port}`
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(d)
    }
  }

  cachedDevices = deduped
  log('INFO', `===== 设备发现结束 (耗时${Date.now() - t0}ms) 共${deduped.length}个设备 =====`)
  deduped.forEach((d, i) => log('INFO', `  [${i}] ${d.deviceName} @ ${d.host}:${d.port} ${d.deviceModel || ''}`))
  return deduped
}

async function castToTVLiveDevice(device, videoUrl) {
  log('INFO', `投屏: ${device.deviceName} @ ${device.host}:${device.port} url=${videoUrl.substring(0, 80)}`)
  const postData = `do=push&url=${encodeURIComponent(videoUrl)}&_tk=${encodeURIComponent(device.token || '')}`

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: device.host,
      port: device.port,
      path: '/action',
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData, 'utf-8'),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('INFO', `投屏成功: ${device.deviceName} code=${res.statusCode} resp=${data.substring(0, 50)}`)
          resolve(data)
        } else {
          const err = `TVLive cast error ${res.statusCode}: ${data.substring(0, 200)}`
          log('ERRO', `投屏失败: ${device.deviceName} ${err}`)
          reject(new Error(err))
        }
      })
    })
    req.on('error', (e) => {
      log('ERRO', `投屏连接失败: ${device.deviceName} err=${e.code || e.message}`)
      reject(e)
    })
    req.on('timeout', () => {
      log('ERRO', `投屏超时: ${device.deviceName}`)
      req.destroy()
      reject(new Error('TVLive cast timeout'))
    })
    req.write(postData)
    req.end()
  })
}

async function stopTVLiveDevice(device) {
  log('INFO', `停止投屏: ${device.deviceName} @ ${device.host}:${device.port}`)
  const postData = `do=stop&_tk=${encodeURIComponent(device.token || '')}`

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: device.host,
      port: device.port,
      path: '/action',
      method: 'POST',
      timeout: 5000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData, 'utf-8'),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        log('INFO', `停止投屏完成: ${device.deviceName} code=${res.statusCode}`)
        resolve(data)
      })
    })
    req.on('error', (e) => {
      log('ERRO', `停止投屏失败: ${device.deviceName} err=${e.code || e.message}`)
      reject(e)
    })
    req.on('timeout', () => {
      log('ERRO', `停止投屏超时: ${device.deviceName}`)
      req.destroy()
      reject(new Error('TVLive stop timeout'))
    })
    req.write(postData)
    req.end()
  })
}

async function sendSeekCommand(device, positionMs) {
  const postData = `do=seek&pos=${Math.round(positionMs)}&_tk=${encodeURIComponent(device.token || '')}`

  return new Promise((resolve) => {
    const req = http.request({
      hostname: device.host,
      port: device.port,
      path: '/action',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData, 'utf-8'),
      },
    }, (res) => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.on('error', () => resolve())
    req.on('timeout', () => { req.destroy(); resolve() })
    req.write(postData)
    req.end()
  })
}

function getLocalSubnets() {
  const prefixes = getSubnetPrefixes()
  return prefixes.map(p => p + '0/24')
}

async function setupAdbReverse(localPort) {
  log('INFO', `ADB反向端口转发: 模拟器127.0.0.1:${localPort} → PC ${localPort}`)
  const adb = findAdbPath()
  if (!adb) {
    log('WARN', 'ADB未找到，无法建立反向转发')
    return { success: false, error: 'ADB not found' }
  }
  try {
    const emulators = await getEmulatorDevices()
    if (emulators.length === 0) {
      log('WARN', '无模拟器设备，无法建立反向转发')
      return { success: false, error: 'No emulator devices' }
    }
    // 检查是否已有反向转发
    const reverseList = await execAdb('reverse --list', 3000).catch(() => '')
    const targetStr = 'tcp:' + localPort
    const alreadyReversed = reverseList.split(/\r?\n/).some(line => line.includes(targetStr))
    if (alreadyReversed) {
      log('INFO', `ADB反向转发已存在: 127.0.0.1:${localPort}`)
      return { success: true, serial: '(existing)' }
    }
    // 在模拟器上建立反向转发
    for (const em of emulators) {
      try {
        await execAdb(`-s ${em.serial} reverse tcp:${localPort} tcp:${localPort}`, 5000)
        log('INFO', `ADB反向转发已建立: ${em.serial} → PC:${localPort}`)
        return { success: true, serial: em.serial }
      } catch (e) {
        log('DEBG', `反向转发失败 ${em.serial}: ${e.message}`)
      }
    }
    log('WARN', '所有模拟器的反向转发均失败')
    return { success: false, error: 'All emulators failed reverse forward' }
  } catch (e) {
    log('ERRO', `ADB反向转发异常: ${e.message}`)
    return { success: false, error: e.message }
  }
}

async function syncLocalChannelsToDevice(device, channelsData) {
  log('INFO', `同步本地频道到设备: ${device.deviceName} @ ${device.host}:${device.port}, 频道数=${channelsData?.lives?.length || 0}`)

  const jsonStr = JSON.stringify(channelsData)
  const postData = `do=syncLocalChannels&data=${encodeURIComponent(jsonStr)}&_tk=${encodeURIComponent(device.token || '')}`

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: device.host,
      port: device.port,
      path: '/action',
      method: 'POST',
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData, 'utf-8'),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('INFO', `本地频道同步成功: ${device.deviceName} count=${channelsData?.lives?.length || 0}`)
          resolve({ success: true, count: channelsData?.lives?.length || 0 })
        } else {
          const err = `syncLocalChannels error ${res.statusCode}: ${data.substring(0, 200)}`
          log('ERRO', `本地频道同步失败: ${device.deviceName} ${err}`)
          reject(new Error(err))
        }
      })
    })
    req.on('error', (e) => {
      log('ERRO', `本地频道同步连接失败: ${device.deviceName} err=${e.code || e.message}`)
      reject(e)
    })
    req.on('timeout', () => {
      log('ERRO', `本地频道同步超时: ${device.deviceName}`)
      req.destroy()
      reject(new Error('syncLocalChannels timeout'))
    })
    req.write(postData)
    req.end()
  })
}

module.exports = {
  discoverTVLiveDevices,
  castToTVLiveDevice,
  stopTVLiveDevice,
  sendSeekCommand,
  syncLocalChannelsToDevice,
  connectToIP,
  getLocalIpAddresses,
  getLocalSubnets,
  getSubnetPrefixes,
  setupEmulatorForwarding,
  setupAdbReverse,
  getEmulatorStatus,
  getEmulatorDevices,
  findAdbPath,
  getAdbPath,
  setAdbPath,
  isAdbOverridden,
  testAdbPath,
  setLogCallback,
  isSameSubnet,
}