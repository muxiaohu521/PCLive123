const dgram = require('dgram')
const http = require('http')

const SSDP_MULTICAST = '239.255.255.250'
const SSDP_PORT = 1900
const DISCOVERY_TIMEOUT = 8000

const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
  'urn:schemas-upnp-org:device:MediaRenderer:2',
]

let discoverySocket = null
let discoveredDevices = []
let discoveryTimer = null

function discoverDevices(timeout = DISCOVERY_TIMEOUT) {
  return new Promise((resolve) => {
    discoveredDevices = []
    const seen = new Set()

    if (discoverySocket) {
      try { discoverySocket.close() } catch (_) {}
    }

    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    discoverySocket.on('error', (err) => {
      console.error('[DLNA] Socket error:', err.message)
      try { discoverySocket.close() } catch (_) {}
      resolve(discoveredDevices)
    })

    discoverySocket.on('message', (msg, rinfo) => {
      const response = msg.toString()
      if (!response.includes('LOCATION:')) return

      const locationMatch = response.match(/LOCATION:\s*(.+)\r?\n/i)
      if (!locationMatch) return

      const location = locationMatch[1].trim()
      if (seen.has(location)) return
      seen.add(location)

      const stMatch = response.match(/ST:\s*(.+)\r?\n/i)
      const serverMatch = response.match(/SERVER:\s*(.+)\r?\n/i)
      const usnMatch = response.match(/USN:\s*(.+)\r?\n/i)

      discoveredDevices.push({
        location,
        st: stMatch ? stMatch[1].trim() : '',
        server: serverMatch ? serverMatch[1].trim() : '',
        usn: usnMatch ? usnMatch[1].trim() : '',
        host: rinfo.address,
        port: rinfo.port,
      })

      fetchDeviceInfo(location).then((info) => {
        const idx = discoveredDevices.findIndex(d => d.location === location)
        if (idx >= 0) {
          discoveredDevices[idx] = { ...discoveredDevices[idx], ...info }
        }
      }).catch(() => {})
    })

    discoverySocket.bind(() => {
      discoverySocket.addMembership(SSDP_MULTICAST)
      discoverySocket.setMulticastTTL(4)

      const searchMsg = SEARCH_TARGETS.map(st =>
        `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_MULTICAST}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 3\r\nST: ${st}\r\n\r\n`
      ).join('')

      discoverySocket.send(searchMsg, 0, searchMsg.length, SSDP_PORT, SSDP_MULTICAST, (err) => {
        if (err) console.error('[DLNA] M-SEARCH send error:', err.message)
      })

      if (discoveryTimer) clearTimeout(discoveryTimer)
      discoveryTimer = setTimeout(() => {
        try { discoverySocket.close() } catch (_) {}
        discoverySocket = null
        resolve(discoveredDevices)
      }, timeout)
    })
  })
}

function fetchDeviceInfo(location) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = new URL(location)
    } catch {
      return reject(new Error('Invalid location URL'))
    }

    const req = http.get(location, { timeout: 5000 }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const info = parseDeviceDescription(data, parsedUrl.origin)
          resolve(info)
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

function parseDeviceDescription(xml, baseUrl) {
  const info = { friendlyName: '', manufacturer: '', modelName: '', avTransportUrl: '', renderingControlUrl: '', connectionManagerUrl: '' }

  const friendlyMatch = xml.match(/<friendlyName>(.+?)<\/friendlyName>/)
  if (friendlyMatch) info.friendlyName = friendlyMatch[1]

  const manuMatch = xml.match(/<manufacturer>(.+?)<\/manufacturer>/)
  if (manuMatch) info.manufacturer = manuMatch[1]

  const modelMatch = xml.match(/<modelName>(.+?)<\/modelName>/)
  if (modelMatch) info.modelName = modelMatch[1]

  const serviceRegex = /<service>[\s\S]*?<serviceType>(urn:schemas-upnp-org:service:(\w+):\d+)<\/serviceType>[\s\S]*?<controlURL>(.+?)<\/controlURL>[\s\S]*?<\/service>/g
  let match
  while ((match = serviceRegex.exec(xml)) !== null) {
    const serviceType = match[2]
    const controlUrl = match[3]
    const fullUrl = controlUrl.startsWith('/') ? baseUrl + controlUrl : controlUrl

    switch (serviceType) {
      case 'AVTransport': info.avTransportUrl = fullUrl; break
      case 'RenderingControl': info.renderingControlUrl = fullUrl; break
      case 'ConnectionManager': info.connectionManagerUrl = fullUrl; break
    }
  }

  return info
}

function sendSoapAction(controlUrl, serviceType, action, params = {}) {
  let parsedUrl
  try {
    parsedUrl = new URL(controlUrl)
  } catch {
    return Promise.reject(new Error('Invalid control URL'))
  }

  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${Object.entries(params).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}
    </u:${action}>
  </s:Body>
</s:Envelope>`

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      timeout: 10000,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${serviceType}#${action}"`,
        'Content-Length': Buffer.byteLength(soapBody, 'utf-8'),
      },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data)
        } else {
          reject(new Error(`SOAP error ${res.statusCode}: ${data.substring(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('SOAP timeout')) })
    req.write(soapBody)
    req.end()
  })
}

async function setAvTransportUri(device, url, metadata = '') {
  if (!device.avTransportUrl) throw new Error('No AVTransport service URL')

  const instanceId = '0'
  const currentUriMeta = metadata || `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>Video</dc:title><upnp:class>object.item.videoItem</upnp:class></item></DIDL-Lite>`

  const params = {
    InstanceID: instanceId,
    CurrentURI: url,
    CurrentURIMetaData: currentUriMeta,
  }

  return sendSoapAction(device.avTransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetAVTransportURI', params)
}

async function playDevice(device, speed = '1') {
  if (!device.avTransportUrl) throw new Error('No AVTransport service URL')
  return sendSoapAction(device.avTransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Play', {
    InstanceID: '0',
    Speed: speed,
  })
}

async function stopDevice(device) {
  if (!device.avTransportUrl) throw new Error('No AVTransport service URL')
  return sendSoapAction(device.avTransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Stop', {
    InstanceID: '0',
  })
}

async function pauseDevice(device) {
  if (!device.avTransportUrl) throw new Error('No AVTransport service URL')
  return sendSoapAction(device.avTransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Pause', {
    InstanceID: '0',
  })
}

async function getTransportInfo(device) {
  if (!device.avTransportUrl) throw new Error('No AVTransport service URL')
  return sendSoapAction(device.avTransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'GetTransportInfo', {
    InstanceID: '0',
  })
}

async function getVolume(device) {
  if (!device.renderingControlUrl) return null
  return sendSoapAction(device.renderingControlUrl, 'urn:schemas-upnp-org:service:RenderingControl:1', 'GetVolume', {
    InstanceID: '0',
    Channel: 'Master',
  })
}

async function setVolume(device, volume) {
  if (!device.renderingControlUrl) throw new Error('No RenderingControl service URL')
  return sendSoapAction(device.renderingControlUrl, 'urn:schemas-upnp-org:service:RenderingControl:1', 'SetVolume', {
    InstanceID: '0',
    Channel: 'Master',
    DesiredVolume: String(Math.max(0, Math.min(100, volume))),
  })
}

module.exports = {
  discoverDevices,
  setAvTransportUri,
  playDevice,
  stopDevice,
  pauseDevice,
  getTransportInfo,
  getVolume,
  setVolume,
  sendSoapAction,
}