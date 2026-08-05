// ============================================================
// TallyBridge v1.5.0 — conecta OBS, vMix, ATEM, RGBlink mini, Osee GoStream, Roland Smart Tally, NewTek/Vizrt TriCaster y AVMatrix a TallyComm
// ============================================================
'use strict'
const express   = require('express')
const WebSocket = require('ws')
const net       = require('net')
const dgram     = require('dgram')
const crypto    = require('crypto')
const http      = require('http')
const path      = require('path')
const fs        = require('fs')
const { execSync } = require('child_process')
const { Atem }  = require('atem-connection')

const app  = express()
const PORT = 4000
app.use(express.json())

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bridge-ui.html')))

// Brand logos used in the switcher selector. Cache aggressively (1 day) — these
// rarely change. Express.static rejects path traversal automatically.
app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  maxAge: '1d',
  fallthrough: false
}))

// ── Persistencia ──────────────────────────────────────────────
const SAVE_FILE = path.join(
  process.env.APPDATA || process.env.HOME || __dirname,
  process.versions.electron ? '.tallybridge' : '',
  'tallybridge-config.json'
)
function loadSaved() {
  try {
    const dir = path.dirname(SAVE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(SAVE_FILE)) {
      const d = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'))
      if (d.config)  Object.assign(state.config, d.config)
      if (d.mapping) Object.assign(state.mapping, d.mapping)
      console.log('[INFO] Config cargada desde disco')
    }
  } catch (e) { console.log('[WARN] No se pudo cargar config:', e.message) }
}
function saveToDisk() {
  try {
    const dir = path.dirname(SAVE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(SAVE_FILE, JSON.stringify({
      config: { ...state.config, obsPassword: '' },
      mapping: state.mapping
    }, null, 2))
  } catch (e) { console.log('[WARN] No se pudo guardar config:', e.message) }
}

// ── Estado global ──────────────────────────────────────────────
const state = {
  connected: false,
  connecting: false,
  error: null,
  obsVersion: null,
  scenes: [],
  pgmScene: null,
  pvwScene: null,
  config: {
    switcher:      'obs',
    obsHost:       '127.0.0.1',
    obsPort:       4455,
    obsPassword:   '',
    rgblinkHost:   '192.168.0.99',
    rgblinkPort:   1000,
    atemHost:      '192.168.10.240',
    vmixHost:      '127.0.0.1',
    vmixPort:      8099,
    oseeHost:      '192.168.1.100',
    rolandHost:    '192.168.0.1',
    rolandPort:    80,
    rolandInputs:  8,
    tricasterHost: '192.168.1.10',
    tricasterPort: 80,
    tricasterInputs: 8,
    avmatrixHost:  '192.168.1.110',
    avmatrixInputs: 4,
    tallyUrl:      'https://tallycomm.com',
    tallyRoom:     '',
    tallyApiKey:   ''
  },
  mapping: {}
}

// ── OBS WebSocket ──────────────────────────────────────────────
let obsSocket        = null
let reqCounter       = 0
const reqCbs         = {}
const sseClients     = []
let reconnectTimer   = null
let manualDisconnect = false

// ── RGBlink UDP ────────────────────────────────────────────────
// Protocolo basado en companion-module-rgblink-mini (Bitfocus)
// Comandos: ASCII "<T" + ADDR + SN + CMD + DAT1-4 + CHECKSUM + ">"
// Respuestas estándar: ASCII "<F...>" de 19 chars
// Tally: paquetes binarios de 22 bytes (byte[0]=PST 0-indexed, byte[2]=PGM 0-indexed)

let rgbSocket       = null
let rgbPollingTimer = null
let rgbNextSn       = 0

const RGBLINK_PORT   = 1000   // Puerto oficial RGBlink mini
const RGBLINK_INPUTS = 4

function rgblinkCalcChecksum(ADDR, SN, CMD, DAT1, DAT2, DAT3, DAT4) {
  const sum = [ADDR, SN, CMD, DAT1, DAT2, DAT3, DAT4]
    .reduce((acc, b) => acc + parseInt(b, 16), 0)
  return (sum % 256).toString(16).toUpperCase().padStart(2, '0')
}

function rgblinkCommand(CMD, DAT1, DAT2, DAT3, DAT4) {
  const ADDR = '00'
  const SN   = rgbNextSn.toString(16).toUpperCase().padStart(2, '0')
  rgbNextSn  = (rgbNextSn + 1) % 256
  const CS   = rgblinkCalcChecksum(ADDR, SN, CMD, DAT1, DAT2, DAT3, DAT4)
  return `<T${ADDR}${SN}${CMD}${DAT1}${DAT2}${DAT3}${DAT4}${CS}>`
}

function rgblinkSend(host, port, cmd) {
  if (!rgbSocket) return
  const buf = Buffer.from(cmd, 'utf8')
  rgbSocket.send(buf, 0, buf.length, port, host, (err) => {
    if (err) log(`RGBlink send error: ${err.message}`, 'warn')
    else if (state.config.logCommands) log(`RGBlink → ${cmd}`)
  })
}

function rgblinkConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const port = parseInt(cfg.rgblinkPort) || RGBLINK_PORT
    const host = cfg.rgblinkHost || '192.168.0.99'
    rgbNextSn  = 0

    log(`Conectando a RGBlink mini en ${host}:${port}…`)

    const sock = dgram.createSocket('udp4')
    rgbSocket  = sock

    let resolved = false
    const failWith = (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(connTimeout)
      try { sock.close() } catch {}
      rgbSocket = null
      state.connected = false
      state.connecting = false
      state.error = err.message
      sse('status', statusPayload())
      reject(err)
    }

    // Si el dispositivo no responde en 4s, asumimos conexión (UDP sin confirmación)
    const connTimeout = setTimeout(() => {
      if (resolved) return
      resolved = true
      state.connected = true
      state.connecting = false
      log('RGBlink mini: sin respuesta al handshake — esperando paquetes de tally…', 'warn')
      sse('status', statusPayload())
      _initRgblinkScenes(host, port)
      resolve()
    }, 4000)

    sock.on('error', (err) => { clearTimeout(connTimeout); failWith(err) })

    sock.on('message', (msg, rinfo) => {
      if (!resolved) {
        resolved = true
        clearTimeout(connTimeout)
        state.connected = true
        state.connecting = false
        log(`RGBlink mini respondió desde ${rinfo.address}:${rinfo.port} ✓`, 'success')
        sse('status', statusPayload())
        _initRgblinkScenes(host, port)
        resolve()
      }
      handleRGBlinkMessage(msg)
    })

    sock.bind(0, '0.0.0.0', (err) => {
      if (err) { failWith(err); return }
      log(`UDP socket abierto`)

      // Handshake: comando de conexión 68/66/01
      const connectCmd = rgblinkCommand('68', '66', '01', '00', '00')
      rgblinkSend(host, port, connectCmd)
      log(`Handshake → ${connectCmd}`)
    })
  })
}

function _initRgblinkScenes(host, port) {
  state.scenes = Array.from({ length: RGBLINK_INPUTS }, (_, i) => ({
    sceneName:   `input_${i + 1}`,
    displayName: `Input ${i + 1}`
  }))
  // Auto-map input N → cam N si no hay mapping previo
  let autoMapped = 0
  state.scenes.forEach((s, i) => {
    if (!state.mapping[s.sceneName]) {
      state.mapping[s.sceneName] = i + 1
      autoMapped++
    }
  })
  if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
  sse('scenes', { scenes: state.scenes, mapping: state.mapping })

  // Polling: solicitar estado de tally cada segundo
  // Comando F1/40/01 = pide el status especial de 22 bytes
  rgbPollingTimer = setInterval(() => {
    if (!rgbSocket || !state.connected) return
    const pollCmd = rgblinkCommand('F1', '40', '01', '00', '00')
    rgblinkSend(host, port, pollCmd)
  }, 1000)
}

function rgblinkDisconnect() {
  if (rgbPollingTimer) { clearInterval(rgbPollingTimer); rgbPollingTimer = null }
  if (rgbSocket) {
    try { rgbSocket.close() } catch {}
    rgbSocket = null
  }
}

function handleRGBlinkMessage(buf) {
  // Paquete estándar de 19 chars: "<F...>" ASCII
  if (buf.length === 19) {
    const str = buf.toString('utf8').toUpperCase()
    if (str[0] === '<' && str[1] === 'F' && str[18] === '>') {
      const CMD = str.substr(6, 2)
      const DAT1 = str.substr(8, 2)
      const DAT2 = str.substr(10, 2)
      // Respuesta al handshake (68 66 01)
      if (CMD === '68' && DAT1 === '66' && DAT2 === '01') {
        log('RGBlink: dispositivo conectado ✓', 'success')
      }
    }
    return
  }

  // Paquete de tally de 22 bytes (binario)
  if (buf.length === 22) {
    // byte[0] = PST/Preview input (0-indexed: 0=Input1, 1=Input2…)
    // byte[2] = PGM/Live input (0-indexed)
    const pvwRaw = buf[0]
    const pgmRaw = buf[2]

    // 0-indexed → 1-indexed, verificar rango válido (0-3 para mini con 4 inputs)
    const pgmInput = (pgmRaw >= 0 && pgmRaw <= 3) ? pgmRaw + 1 : 0
    const pvwInput = (pvwRaw >= 0 && pvwRaw <= 3) ? pvwRaw + 1 : 0

    const pgmKey = pgmInput > 0 ? `input_${pgmInput}` : null
    const pvwKey = pvwInput > 0 ? `input_${pvwInput}` : null

    updateTallyState(pgmKey, pvwKey)
    return
  }

  log(`RGBlink: paquete de longitud inesperada (${buf.length} bytes) — ignorado`, 'warn')
}

// ── ATEM (UDP port 9910 via atem-connection) ───────────────────
let atemConnection = null

function atemConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const host = cfg.atemHost || '192.168.10.240'
    log(`Conectando a ATEM en ${host}:9910…`)

    const atem = new Atem()
    atemConnection = atem

    let resolved = false
    const connTimeout = setTimeout(() => {
      if (resolved) return
      resolved = true
      atem.destroy().catch(() => {})
      atemConnection = null
      state.connecting = false
      state.connected = false
      state.error = 'Timeout al conectar a ATEM (10s)'
      sse('status', statusPayload())
      reject(new Error(state.error))
    }, 10000)

    atem.on('error', (e) => {
      log(`ATEM error: ${e}`, 'error')
      if (!resolved) {
        resolved = true
        clearTimeout(connTimeout)
        state.connecting = false
        state.connected = false
        state.error = String(e)
        atemConnection = null
        sse('status', statusPayload())
        reject(new Error(String(e)))
      }
    })

    atem.on('connected', () => {
      if (resolved) return
      resolved = true
      clearTimeout(connTimeout)

      state.connected = true
      state.connecting = false
      const model = atem.state.info.productIdentifier || 'ATEM'
      log(`Conectado a ${model} ✓`, 'success')

      // Build scene list from external inputs
      const inputs = atem.state.inputs || {}
      state.scenes = []
      for (const [id, input] of Object.entries(inputs)) {
        if (input && input.internalPortType === 0) {
          state.scenes.push({
            sceneName: `input_${id}`,
            displayName: input.longName || `Input ${id}`,
            inputId: parseInt(id)
          })
        }
      }
      state.scenes.sort((a, b) => a.inputId - b.inputId)

      // Auto-map input N → cam N
      let autoMapped = 0
      state.scenes.forEach(s => {
        if (!state.mapping[s.sceneName]) {
          state.mapping[s.sceneName] = s.inputId
          autoMapped++
        }
      })
      if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')

      // Read initial tally
      const me0 = atem.state.video.mixEffects[0]
      if (me0) {
        state.pgmScene = `input_${me0.programInput}`
        state.pvwScene = `input_${me0.previewInput}`
        const pgmCam = state.mapping[state.pgmScene] || 0
        const pvwCam = state.mapping[state.pvwScene] || 0
        if (pgmCam) sendTallyDirect(pgmCam, 'program')
        if (pvwCam && pvwCam !== pgmCam) sendTallyDirect(pvwCam, 'preview')
      }

      sse('scenes', { scenes: state.scenes, mapping: state.mapping })
      sse('status', statusPayload())
      resolve()
    })

    atem.on('disconnected', () => {
      if (state.connected) {
        state.connected = false
        log('ATEM desconectado', 'warn')
        sse('status', statusPayload())
        if (!manualDisconnect) scheduleReconnect()
      }
    })

    atem.on('stateChanged', (newState, paths) => {
      const hasPgm = paths.includes('video.mixEffects.0.programInput')
      const hasPvw = paths.includes('video.mixEffects.0.previewInput')
      if (!hasPgm && !hasPvw) return
      const me = newState.video.mixEffects[0]
      if (!me) return
      const pgmKey = `input_${me.programInput}`
      const pvwKey = `input_${me.previewInput}`
      updateTallyState(pgmKey, pvwKey)
    })

    atem.connect(host).catch((e) => {
      if (!resolved) {
        resolved = true
        clearTimeout(connTimeout)
        state.connecting = false
        state.error = e.message
        sse('status', statusPayload())
        reject(e)
      }
    })
  })
}

function atemDisconnect() {
  if (atemConnection) {
    atemConnection.disconnect().catch(() => {})
    atemConnection.destroy().catch(() => {})
    atemConnection = null
  }
}

// ── vMix (TCP port 8099, text protocol) ────────────────────────
let vmixSocket = null
let vmixBuffer = ''

function vmixConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const host = cfg.vmixHost || '127.0.0.1'
    const port = parseInt(cfg.vmixPort) || 8099
    log(`Conectando a vMix en ${host}:${port}…`)

    const sock = new net.Socket()
    vmixSocket = sock
    vmixBuffer = ''
    let resolved = false

    const failWith = (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(connTimeout)
      try { sock.destroy() } catch {}
      vmixSocket = null
      state.connected = false
      state.connecting = false
      state.error = err.message
      sse('status', statusPayload())
      reject(err)
    }

    const connTimeout = setTimeout(() => {
      sock.destroy()
      failWith(new Error('Timeout al conectar a vMix (5s)'))
    }, 5000)

    sock.connect(port, host, () => {
      clearTimeout(connTimeout)
      resolved = true
      state.connected = true
      state.connecting = false
      log('Conectado a vMix ✓', 'success')

      // Build generic input list (vMix can have many inputs)
      state.scenes = Array.from({ length: 8 }, (_, i) => ({
        sceneName:   `input_${i + 1}`,
        displayName: `Input ${i + 1}`
      }))
      let autoMapped = 0
      state.scenes.forEach((s, i) => {
        if (!state.mapping[s.sceneName]) {
          state.mapping[s.sceneName] = i + 1
          autoMapped++
        }
      })
      if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
      sse('scenes', { scenes: state.scenes, mapping: state.mapping })
      sse('status', statusPayload())

      // Subscribe to tally — vMix pushes updates automatically
      sock.write('SUBSCRIBE TALLY\r\n')
      resolve()
    })

    sock.on('data', (data) => {
      vmixBuffer += data.toString('utf8')
      // Guard against malformed data flooding the buffer (#8)
      if (vmixBuffer.length > 10240) vmixBuffer = vmixBuffer.slice(-2048)
      _processVmixBuffer()
    })

    sock.on('error', (err) => {
      if (!resolved) failWith(err)
      else {
        log('vMix error: ' + err.message, 'warn')
        state.connected = false
        sse('status', statusPayload())
      }
    })

    sock.on('close', () => {
      if (!resolved) failWith(new Error('Conexión cerrada'))
      else if (state.connected) {
        state.connected = false
        log('vMix desconectado', 'warn')
        sse('status', statusPayload())
        if (!manualDisconnect) scheduleReconnect()
      }
    })
  })
}

function _processVmixBuffer() {
  let idx
  while ((idx = vmixBuffer.indexOf('\r\n')) !== -1) {
    const line = vmixBuffer.substring(0, idx)
    vmixBuffer = vmixBuffer.substring(idx + 2)

    if (line.startsWith('TALLY OK ')) {
      _handleVmixTally(line.substring(9))
    } else if (line.startsWith('SUBSCRIBE OK')) {
      log('vMix: suscripción a tally activa ✓', 'success')
    }
  }
}

function _handleVmixTally(tallyStr) {
  // Each char = 1 input: 0=off, 1=PGM, 2=PVW
  // Take FIRST match (not last) — vMix can have multiple PGM with overlays (#10)
  let newPgm = null, newPvw = null
  for (let i = 0; i < tallyStr.length; i++) {
    if (tallyStr[i] === '1' && !newPgm) newPgm = i + 1
    if (tallyStr[i] === '2' && !newPvw) newPvw = i + 1
  }

  const pgmKey = newPgm ? `input_${newPgm}` : null
  const pvwKey = newPvw ? `input_${newPvw}` : null

  // Expand scene list if vMix has more inputs than expected
  const maxInput = tallyStr.length
  if (maxInput > state.scenes.length) {
    state.scenes = Array.from({ length: maxInput }, (_, i) => ({
      sceneName:   `input_${i + 1}`,
      displayName: `Input ${i + 1}`
    }))
    sse('scenes', { scenes: state.scenes, mapping: state.mapping })
  }

  updateTallyState(pgmKey, pvwKey)
}

function vmixDisconnect() {
  if (vmixSocket) {
    try { vmixSocket.write('UNSUBSCRIBE TALLY\r\n') } catch {}
    try { vmixSocket.destroy() } catch {}
    vmixSocket = null
  }
}

// ── Osee GoStream (TCP port 19010) ─────────────────────────────
// Protocol "GSP" — single TCP socket, push-based, no auth.
// Reference: bitfocus/companion-module-osee-gostream-series (MIT).
//
// Frame format (little-endian):
//   [0xEB][0xA6][0x00 ProType][len:UInt16LE][JSON UTF-8][CRC16-Modbus:UInt16LE]
//   len = json.length + 2 (size of JSON + size of CRC trailer)
//   CRC computed over header(3) + len(2) + JSON.
//
// Source IDs: 0=Black, 1..8=IN1..IN8, others=non-camera (PGM/MP/ColorBar). Map IN N → CAM N.

let oseeSocket = null
let oseeBuffer = Buffer.alloc(0)
const OSEE_PORT    = 19010
const OSEE_INPUTS  = 8   // GoStream Duet 8 ISO ceiling; smaller models just leave 5..8 unused
const OSEE_HEAD    = Buffer.from([0xEB, 0xA6, 0x00])

function crc16modbus(buf) {
  let crc = 0xFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) crc = (crc >>> 1) ^ 0xA001
      else crc = crc >>> 1
    }
  }
  return crc & 0xFFFF
}

function oseePack(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8')
  const len  = json.length + 2          // JSON + CRC trailer
  const body = Buffer.alloc(3 + 2 + json.length)
  OSEE_HEAD.copy(body, 0)
  body.writeUInt16LE(len, 3)
  json.copy(body, 5)
  const crc = Buffer.alloc(2)
  crc.writeUInt16LE(crc16modbus(body), 0)
  return Buffer.concat([body, crc])
}

function oseeSend(obj) {
  if (!oseeSocket || oseeSocket.destroyed) return
  try { oseeSocket.write(oseePack(obj)) } catch (e) { log('Osee send error: ' + e.message, 'warn') }
}

function oseeConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const host = cfg.oseeHost || '192.168.1.100'
    log(`Conectando a Osee GoStream en ${host}:${OSEE_PORT}…`)

    const sock = new net.Socket()
    oseeSocket = sock
    oseeBuffer = Buffer.alloc(0)
    let resolved = false

    const failWith = (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(connTimeout)
      try { sock.destroy() } catch {}
      oseeSocket = null
      state.connected = false
      state.connecting = false
      state.error = err.message
      sse('status', statusPayload())
      reject(err)
    }

    const connTimeout = setTimeout(() => {
      sock.destroy()
      failWith(new Error('Timeout al conectar a Osee GoStream (5s)'))
    }, 5000)

    sock.connect(OSEE_PORT, host, () => {
      clearTimeout(connTimeout)
      resolved = true
      state.connected = true
      state.connecting = false
      log('Conectado a Osee GoStream ✓', 'success')

      // Build generic input list (1..8). Non-physical IDs map nowhere — handler clears them.
      state.scenes = Array.from({ length: OSEE_INPUTS }, (_, i) => ({
        sceneName:   `input_${i + 1}`,
        displayName: `Input ${i + 1}`
      }))
      let autoMapped = 0
      state.scenes.forEach((s, i) => {
        if (!state.mapping[s.sceneName]) {
          state.mapping[s.sceneName] = i + 1
          autoMapped++
        }
      })
      if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
      sse('scenes', { scenes: state.scenes, mapping: state.mapping })
      sse('status', statusPayload())

      // Initial state queries — switcher will reply with current PGM/PVW and then
      // push spontaneously on every bus change.
      oseeSend({ id: 'pgmIndex', type: 'get' })
      oseeSend({ id: 'pvwIndex', type: 'get' })
      resolve()
    })

    sock.on('data', (chunk) => {
      oseeBuffer = oseeBuffer.length ? Buffer.concat([oseeBuffer, chunk]) : chunk
      // Guard against runaway buffer (#8 vMix-style)
      if (oseeBuffer.length > 65536) oseeBuffer = oseeBuffer.slice(-8192)
      _processOseeBuffer()
    })

    sock.on('error', (err) => {
      if (!resolved) failWith(err)
      else {
        log('Osee error: ' + err.message, 'warn')
        state.connected = false
        sse('status', statusPayload())
      }
    })

    sock.on('close', () => {
      if (!resolved) failWith(new Error('Conexión cerrada'))
      else if (state.connected) {
        state.connected = false
        log('Osee GoStream desconectado', 'warn')
        sse('status', statusPayload())
        if (!manualDisconnect) scheduleReconnect()
      }
    })
  })
}

function _processOseeBuffer() {
  while (oseeBuffer.length >= 7) {
    // Resync to magic bytes 0xEB 0xA6
    if (oseeBuffer[0] !== 0xEB || oseeBuffer[1] !== 0xA6) {
      const idx = oseeBuffer.indexOf(0xEB, 1)
      if (idx === -1) { oseeBuffer = Buffer.alloc(0); return }
      oseeBuffer = oseeBuffer.slice(idx)
      continue
    }
    const len = oseeBuffer.readUInt16LE(3)         // JSON + CRC trailer length
    const total = 5 + len                          // header(3) + len(2) + JSON + CRC
    if (oseeBuffer.length < total) return          // wait for more
    const json = oseeBuffer.slice(5, 5 + len - 2)
    // CRC bytes are at [5 + len - 2 .. 5 + len - 1] — we trust the link, skip verify
    oseeBuffer = oseeBuffer.slice(total)
    let payload
    try { payload = JSON.parse(json.toString('utf8')) }
    catch { continue }
    _handleOseeMessage(payload)
  }
}

function _handleOseeMessage(msg) {
  // msg = { id: 'pgmIndex'|'pvwIndex'|..., type: 'get'|'pus'|..., value: [N] }
  if (!msg || typeof msg !== 'object') return
  if (msg.id !== 'pgmIndex' && msg.id !== 'pvwIndex') return
  if (msg.type !== 'get' && msg.type !== 'pus') return

  const sourceId = Array.isArray(msg.value) ? Number(msg.value[0]) : Number(msg.value)
  const isPhysical = Number.isInteger(sourceId) && sourceId >= 1 && sourceId <= OSEE_INPUTS
  const key = isPhysical ? `input_${sourceId}` : null

  // Update only the bus this message refers to; preserve the other.
  const newPgm = msg.id === 'pgmIndex' ? key : state.pgmScene
  const newPvw = msg.id === 'pvwIndex' ? key : state.pvwScene
  updateTallyState(newPgm, newPvw)
}

function oseeDisconnect() {
  if (oseeSocket) {
    try { oseeSocket.destroy() } catch {}
    oseeSocket = null
  }
  oseeBuffer = Buffer.alloc(0)
}

// ── Roland Smart Tally (HTTP polling) ──────────────────────────
// Standard Smart Tally HTTP protocol — supported by V-60HD, V-1HD, V-1SDI,
// V-160HD, VR-1HD, VR-3EX, VR-4HD, VR-50HD MKII, VR-120HD, P-20HD, XS-series,
// and others. Default TCP port 80, no auth.
//   GET /tally/<input>/status  →  body: "onair" | "selected" | "unselected"
// Reference: Roland V-60HD Smart Tally PDF + wifi-tally RolandV60HDConnector.

let rolandPollingTimer = null
let rolandFailCount    = 0
const ROLAND_POLL_MS         = 250   // matches RGBlink pattern; budget for 12 inputs
const ROLAND_FAIL_THRESHOLD  = 5     // consecutive ticks with all-input errors → disconnect

function rolandConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const host = cfg.rolandHost || '192.168.0.1'
    const port = parseInt(cfg.rolandPort) || 80
    const nIn  = Math.max(1, Math.min(parseInt(cfg.rolandInputs) || 8, 20))

    log(`Conectando a Roland Smart Tally en ${host}:${port} (${nIn} entradas)…`)

    // Single GET as handshake — confirms the embedded HTTP server is reachable
    // and Smart Tally is enabled. Timeout 4s.
    rolandFetch(host, port, 1, 4000)
      .then((status) => {
        log(`Roland respondió input 1 → ${status} ✓`, 'success')
        state.connected = true
        state.connecting = false

        state.scenes = Array.from({ length: nIn }, (_, i) => ({
          sceneName:   `input_${i + 1}`,
          displayName: `Input ${i + 1}`
        }))
        let autoMapped = 0
        state.scenes.forEach((s, i) => {
          if (!state.mapping[s.sceneName]) {
            state.mapping[s.sceneName] = i + 1
            autoMapped++
          }
        })
        if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
        sse('scenes', { scenes: state.scenes, mapping: state.mapping })
        sse('status', statusPayload())

        rolandFailCount = 0
        rolandPollingTimer = setInterval(() => rolandPollAll(host, port, nIn), ROLAND_POLL_MS)
        // Kick the first tick now (don't wait the interval)
        rolandPollAll(host, port, nIn)
        resolve()
      })
      .catch((err) => {
        state.connected = false
        state.connecting = false
        state.error = `Roland: ${err.message}`
        sse('status', statusPayload())
        reject(err)
      })
  })
}

function rolandFetch(host, port, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: `/tally/${input}/status`, method: 'GET',
      timeout: timeoutMs || 1500
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => body += d)
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        resolve(body.trim().toLowerCase())
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

function rolandPollAll(host, port, nIn) {
  // Kick all input polls in parallel, then once they've all settled compute the
  // bus state in one batch + dispatch a single updateTallyState. Async batching
  // avoids the dedup-thrash that would happen if each response called
  // updateTallyState independently while siblings were still in flight.
  const polls = []
  for (let i = 1; i <= nIn; i++) {
    polls.push(rolandFetch(host, port, i, 1500).then(
      (status) => ({ input: i, status, ok: true }),
      (err)    => ({ input: i, error: err, ok: false })
    ))
  }
  Promise.all(polls).then((results) => {
    let okCount = 0
    let newPgmKey = null
    let newPvwKey = null
    results.forEach((r) => {
      if (!r.ok) return
      okCount++
      const key = `input_${r.input}`
      if (r.status === 'onair'    && !newPgmKey) newPgmKey = key
      if (r.status === 'selected' && !newPvwKey) newPvwKey = key
    })

    if (okCount === 0) {
      rolandFailCount++
      if (rolandFailCount === ROLAND_FAIL_THRESHOLD) {
        log(`Roland: ${ROLAND_FAIL_THRESHOLD} ciclos sin respuesta — desconectado`, 'warn')
        rolandDisconnect()
        if (state.connected) {
          state.connected = false
          sse('status', statusPayload())
          if (!manualDisconnect) scheduleReconnect()
        }
      }
      return
    }

    rolandFailCount = 0
    updateTallyState(newPgmKey, newPvwKey)
  })
}

function rolandDisconnect() {
  if (rolandPollingTimer) { clearInterval(rolandPollingTimer); rolandPollingTimer = null }
  rolandFailCount = 0
}

// ── TriCaster (HTTP REST + WebSocket on :80, "v1" API — Path B) ─
// NewTek/Vizrt automation API. Hybrid push/pull pattern:
//   ws://<ip>/v1/change_notifications  → server pushes the name of any key
//                                        that changed ("shortcut_states", …)
//   GET <ip>/v1/dictionary?key=KEY      → returns XML with current state
// Tally lives in shortcut_states under program_tally + preview_tally; values
// are pipe-delimited lists, first INPUTn token owns the bus.
//
// Requires LivePanel password DISABLED (TriCaster Admin Tools → LivePanel).
// Compatible with TC1, TC2 Elite, TC Mini, VMC1, 410 Plus, 8000 Vectar
// running TriCaster Advanced Edition firmware (8.x).
// Reference: NewTek Live Production Automation Guide v8-5 + Companion module
// bitfocus/companion-module-newtek-tricaster.

let tricasterWs        = null
let tricasterPollTimer = null
let tricasterFailCount = 0
const TRICASTER_FAIL_THRESHOLD   = 5
const TRICASTER_FALLBACK_POLL_MS = 1500

function tricasterConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const host = cfg.tricasterHost || '192.168.1.10'
    const port = parseInt(cfg.tricasterPort) || 80
    const nIn  = Math.max(1, Math.min(parseInt(cfg.tricasterInputs) || 8, 16))

    log(`Conectando a TriCaster en ${host}:${port} (${nIn} entradas)…`)

    // Handshake: HTTP GET /v1/version verifies server reachable + LivePanel
    // password disabled. 401/403 → password is set; user must disable it.
    tricasterFetchVersion(host, port, 4000)
      .then((version) => {
        log(`TriCaster ${version || 'v1 API'} ✓`, 'success')

        state.connected = true
        state.connecting = false

        state.scenes = Array.from({ length: nIn }, (_, i) => ({
          sceneName:   `input_${i + 1}`,
          displayName: `Input ${i + 1}`
        }))
        let autoMapped = 0
        state.scenes.forEach((s, i) => {
          if (!state.mapping[s.sceneName]) {
            state.mapping[s.sceneName] = i + 1
            autoMapped++
          }
        })
        if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
        sse('scenes', { scenes: state.scenes, mapping: state.mapping })
        sse('status', statusPayload())

        tricasterRefreshTally(host, port)
        tricasterOpenWs(host, port)
        resolve()
      })
      .catch((err) => {
        state.connected = false
        state.connecting = false
        state.error = `TriCaster: ${err.message}`
        sse('status', statusPayload())
        reject(err)
      })
  })
}

function tricasterFetchVersion(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host, port, path: '/v1/version', method: 'GET',
      timeout: timeoutMs || 1500
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => body += d)
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error('LivePanel password está habilitado. Deshabilítalo en Admin Tools.'))
        }
        // Older firmware may lack /v1/version — accept 404 as a soft pass; the
        // real handshake is the next call to /v1/dictionary?key=shortcut_states
        if (res.statusCode === 404) return resolve('v1 API')
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
        const m = body.match(/<version[^>]*>([^<]+)<\/version>/i)
        resolve((m ? m[1] : body).trim().slice(0, 80))
      })
    })
    req.on('error', (err) => reject(err))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function tricasterRefreshTally(host, port) {
  http.request({
    host, port, path: '/v1/dictionary?key=shortcut_states', method: 'GET',
    timeout: 2000
  }, (res) => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', (d) => body += d)
    res.on('end', () => {
      if (res.statusCode !== 200) {
        if (++tricasterFailCount >= TRICASTER_FAIL_THRESHOLD) tricasterMarkDown('HTTP ' + res.statusCode)
        return
      }
      tricasterFailCount = 0
      const r = parseTricasterTally(body)
      const pgmKey = r.pgmInput ? `input_${r.pgmInput}` : null
      const pvwKey = r.pvwInput ? `input_${r.pvwInput}` : null
      updateTallyState(pgmKey, pvwKey)
    })
  }).on('error', (err) => {
    if (++tricasterFailCount >= TRICASTER_FAIL_THRESHOLD) tricasterMarkDown(err.message)
  }).end()
}

function parseTricasterTally(xml) {
  // First INPUTn token owns the bus; skip BFR / DDR / VIRTUAL / M-E etc.
  // (TriCaster's M/E sub-source tally is not exposed via 5951/v1; that's a
  // documented Vizrt limitation, fine for cam-level tally use.)
  function firstInputFrom(value) {
    if (!value) return 0
    const tokens = String(value).split('|')
    for (let i = 0; i < tokens.length; i++) {
      const m = tokens[i].match(/^INPUT(\d+)$/i)
      if (m) return parseInt(m[1], 10)
    }
    return 0
  }
  const pgmMatch = xml.match(/name="program_tally"\s+value="([^"]*)"/i)
  const pvwMatch = xml.match(/name="preview_tally"\s+value="([^"]*)"/i)
  return {
    pgmInput: pgmMatch ? firstInputFrom(pgmMatch[1]) : 0,
    pvwInput: pvwMatch ? firstInputFrom(pvwMatch[1]) : 0
  }
}

function tricasterMarkDown(reason) {
  log(`TriCaster: ${reason} — desconectando`, 'warn')
  tricasterDisconnect()
  if (state.connected) {
    state.connected = false
    sse('status', statusPayload())
    if (!manualDisconnect) scheduleReconnect()
  }
}

function tricasterOpenWs(host, port) {
  if (tricasterWs) { try { tricasterWs.terminate() } catch {}; tricasterWs = null }
  if (tricasterPollTimer) { clearInterval(tricasterPollTimer); tricasterPollTimer = null }

  const wsUrl = `ws://${host}:${port}/v1/change_notifications`
  const ws = new WebSocket(wsUrl)
  tricasterWs = ws

  ws.on('open',    () => log('TriCaster change_notifications WS conectado ✓', 'success'))
  ws.on('message', (raw) => {
    if (String(raw).toLowerCase().includes('shortcut_states')) {
      tricasterRefreshTally(host, port)
    }
  })
  ws.on('error',   (err) => log('TriCaster WS error: ' + err.message, 'warn'))
  ws.on('close',   () => {
    if (tricasterWs !== ws) return
    tricasterWs = null
    if (state.connected && !manualDisconnect) {
      // Fallback to slow HTTP polling while the WS is down — keeps tally alive
      log('TriCaster WS cerrado — fallback a polling', 'warn')
      tricasterPollTimer = setInterval(() => {
        if (state.connected) tricasterRefreshTally(host, port)
      }, TRICASTER_FALLBACK_POLL_MS)
    }
  })
}

function tricasterDisconnect() {
  if (tricasterWs) { try { tricasterWs.terminate() } catch {}; tricasterWs = null }
  if (tricasterPollTimer) { clearInterval(tricasterPollTimer); tricasterPollTimer = null }
  tricasterFailCount = 0
}

// ── AVMatrix (UDP push protocol on :19523/:19522) ──────────────
// Push-based UDP shared across the AVMatrix HVS/PVS line:
//   Bridge → switcher: UDP :19523
//   Switcher → bridge: UDP :19522 (we bind here)
// Frame format (TX and RX identical):
//   [0]    0x5A               start byte
//   [1-2]  totalLen (UInt16LE) full frame length including footer
//   [3]    0x00 (devType)
//   [4]    0x00 (devId)
//   [5]    0x00 (reserve)
//   [6]    dataLen             = 1 + payload bytes (cmd + payload)
//   [7]    cmd byte
//   [8...] payload
//   [N-2]  checksum             sum of all preceding bytes & 0xff
//   [N-1]  0xDD                 end byte
//
// Tally RX commands: cmd=0x12 → PGM=payload[0], cmd=0x13 → PVW=payload[0],
// cmd=0x11 payload[0]=0x03 → FTB on/off (kill tally if payload[1] != 0).
// Confirmed: HVS0402U, HVS0403U, PVS0403U.
// Likely (same firmware family): VS0601/U, MVS0401, PVS0613U/0615, VS0605U,
// PVS0605U, HVS0203U.
// Reference: lygilygi/companion-module-avmatrix (MIT, reverse-engineered from
// the official AVMatrix PC Control software protocol spec).

let avmSocket    = null
let avmKeepalive = null
let avmRxAt      = 0
const AVMATRIX_TX_PORT       = 19523
const AVMATRIX_RX_PORT       = 19522
const AVMATRIX_KEEPALIVE_MS  = 1000
const AVMATRIX_RX_TIMEOUT_MS = 12000  // 12 ticks of silence → assume disconnect

function avmatrixPack(cmd, payload) {
  payload = payload || []
  // header(7) + cmd(1) + payload(N) + checksum(1) + footer(1)
  const totalLen = 7 + 1 + payload.length + 1 + 1
  const buf = Buffer.alloc(totalLen)
  buf[0] = 0x5A
  buf.writeUInt16LE(totalLen, 1)
  buf[3] = 0x00       // devType
  buf[4] = 0x00       // devId
  buf[5] = 0x00       // reserve
  buf[6] = 1 + payload.length    // dataLen
  buf[7] = cmd
  for (let i = 0; i < payload.length; i++) buf[8 + i] = payload[i]
  let sum = 0
  for (let i = 0; i < totalLen - 2; i++) sum = (sum + buf[i]) & 0xff
  buf[totalLen - 2] = sum
  buf[totalLen - 1] = 0xDD
  return buf
}

function avmatrixSend(host, port, buf) {
  if (!avmSocket) return
  avmSocket.send(buf, 0, buf.length, port, host, (err) => {
    if (err) log('AVMatrix send error: ' + err.message, 'warn')
  })
}

function avmatrixConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const host = cfg.avmatrixHost || '192.168.1.110'
    const port = AVMATRIX_TX_PORT
    const nIn  = Math.max(1, Math.min(parseInt(cfg.avmatrixInputs) || 4, 16))
    avmRxAt = 0

    log(`Conectando a AVMatrix en ${host}:${port} (${nIn} entradas)…`)

    const sock = dgram.createSocket('udp4')
    avmSocket = sock

    let resolved = false
    const failWith = (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(connTimeout)
      try { sock.close() } catch {}
      avmSocket = null
      state.connected = false
      state.connecting = false
      state.error = err.message
      sse('status', statusPayload())
      reject(err)
    }

    // UDP gives no error on unreachable host — must time out explicitly. The
    // switcher dumps state on sync, so we expect RX within ~500ms in practice.
    const connTimeout = setTimeout(() => {
      if (resolved) return
      resolved = true
      try { sock.close() } catch {}
      avmSocket = null
      state.connected = false
      state.connecting = false
      state.error = 'Timeout — el switcher no respondió en :19522. Verifica IP y conectividad LAN.'
      sse('status', statusPayload())
      reject(new Error(state.error))
    }, 5000)

    sock.on('error', (err) => failWith(err))

    sock.on('message', (msg) => {
      avmRxAt = Date.now()
      if (!resolved) {
        resolved = true
        clearTimeout(connTimeout)
        state.connected = true
        state.connecting = false
        log(`AVMatrix respondió ✓`, 'success')

        state.scenes = Array.from({ length: nIn }, (_, i) => ({
          sceneName:   `input_${i + 1}`,
          displayName: `Input ${i + 1}`
        }))
        let autoMapped = 0
        state.scenes.forEach((s, i) => {
          if (!state.mapping[s.sceneName]) {
            state.mapping[s.sceneName] = i + 1
            autoMapped++
          }
        })
        if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
        sse('scenes', { scenes: state.scenes, mapping: state.mapping })
        sse('status', statusPayload())

        // Watchdog: keepalive (sync + ping) every 1s, RX silence → disconnect
        avmKeepalive = setInterval(() => {
          if (!avmSocket) return
          avmatrixSend(host, port, avmatrixPack(0xFE, [0x01])) // sync request
          avmatrixSend(host, port, avmatrixPack(0xFF, [0x01])) // ping
          if (Date.now() - avmRxAt > AVMATRIX_RX_TIMEOUT_MS) {
            log('AVMatrix: sin RX por 12s — desconectando', 'warn')
            avmatrixDisconnect()
            if (state.connected) {
              state.connected = false
              sse('status', statusPayload())
              if (!manualDisconnect) scheduleReconnect()
            }
          }
        }, AVMATRIX_KEEPALIVE_MS)

        resolve()
      }
      handleAvmatrixMessage(msg)
    })

    sock.bind(AVMATRIX_RX_PORT, '0.0.0.0', (err) => {
      if (err) { failWith(err); return }
      log(`AVMatrix UDP socket bound to :${AVMATRIX_RX_PORT}`)
      // Sync request — switcher dumps full state including current PGM/PVW
      avmatrixSend(host, port, avmatrixPack(0xFE, [0x01]))
    })
  })
}

function handleAvmatrixMessage(buf) {
  // Validate framing: 0x5A start, 0xDD end, length match, checksum
  if (buf.length < 10) return
  if (buf[0] !== 0x5A || buf[buf.length - 1] !== 0xDD) return
  const totalLen = buf.readUInt16LE(1)
  if (totalLen !== buf.length) return
  let sum = 0
  for (let i = 0; i < totalLen - 2; i++) sum = (sum + buf[i]) & 0xff
  if (buf[totalLen - 2] !== sum) return

  const cmd = buf[7]
  const payload = buf.slice(8, totalLen - 2)

  if (cmd === 0x12 && payload.length >= 1) {
    const n = payload[0]
    const key = (n >= 1 && n <= 16) ? `input_${n}` : null
    updateTallyState(key, state.pvwScene)
    return
  }
  if (cmd === 0x13 && payload.length >= 1) {
    const n = payload[0]
    const key = (n >= 1 && n <= 16) ? `input_${n}` : null
    updateTallyState(state.pgmScene, key)
    return
  }
  if (cmd === 0x11 && payload.length >= 2 && payload[0] === 0x03) {
    // FTB (Fade To Black): when active, kill all tally
    if (payload[1] !== 0) updateTallyState(null, null)
    return
  }
  // Other RX (0x01 sync ack, 0xFF ping ack, etc.) — ignore, only tally matters
}

function avmatrixDisconnect() {
  if (avmKeepalive) { clearInterval(avmKeepalive); avmKeepalive = null }
  if (avmSocket) {
    try { avmSocket.close() } catch {}
    avmSocket = null
  }
  avmRxAt = 0
}

// ── Auto-reconnect ─────────────────────────────────────────────
function scheduleReconnect(delay = 4000) {
  // Broadcast safety: we just lost the switcher, so we no longer know what is
  // on air. Every automatic disconnect funnels through here, and none of them
  // used to tell TallyComm anything — a camera that was on PGM stayed lit red
  // on the operator's phone for as long as the switcher was gone. A tally
  // system has to fail dark: if we can't know, nobody is shown on air.
  // Idempotent: updateTallyState dedups when the state is already null, so the
  // exponential-backoff recursion below only sends the clear once.
  updateTallyState(null, null)
  if (reconnectTimer) return
  if (!state.config.tallyRoom) return
  const sw = state.config.switcher || 'obs'
  log(`Reconectando a ${sw} en ${delay / 1000}s…`, 'warn')
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (state.connected || manualDisconnect) return
    try {
      if (sw === 'atem') await atemConnect(state.config)
      else if (sw === 'vmix') await vmixConnect(state.config)
      else if (sw === 'rgblink') await rgblinkConnect(state.config)
      else if (sw === 'osee') await oseeConnect(state.config)
      else if (sw === 'roland') await rolandConnect(state.config)
      else if (sw === 'tricaster') await tricasterConnect(state.config)
      else if (sw === 'avmatrix') await avmatrixConnect(state.config)
      else await obsConnect(state.config)
    } catch (e) {
      log('Reconexión fallida: ' + e.message, 'warn')
      scheduleReconnect(Math.min(delay * 2, 30000))
    }
  }, delay)
}

function sse(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try { sseClients[i].write(msg) } catch { sseClients.splice(i, 1) }
  }
}

function log(msg, type = 'info') {
  const entry = { msg, type, ts: Date.now() }
  console.log(`[${type.toUpperCase()}] ${msg}`)
  sse('log', entry)
}

function statusPayload() {
  return {
    connected:  state.connected,
    connecting: state.connecting,
    error:      state.error,
    obsVersion: state.obsVersion,
    pgmScene:   state.pgmScene,
    pvwScene:   state.pvwScene,
    pgmCam:     state.mapping[state.pgmScene] || 0,
    pvwCam:     state.mapping[state.pvwScene] || 0,
    config:     state.config
  }
}

// ── OBS WebSocket v5 ───────────────────────────────────────────
function obsConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())
    const url = `ws://${cfg.obsHost}:${cfg.obsPort}`
    log(`Conectando a OBS en ${url}…`)
    const ws = new WebSocket(url)
    obsSocket = ws
    let resolved = false

    const failWith = (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(connTimeout)
      state.connecting = false
      state.connected = false
      state.error = err.message
      obsSocket = null
      sse('status', statusPayload())
      reject(err)
    }

    const connTimeout = setTimeout(
      () => { ws.terminate(); failWith(new Error('Timeout al conectar a OBS (5s)')) },
      5000
    )

    ws.on('error', err => failWith(err))
    ws.on('close', () => {
      if (!resolved) failWith(new Error('Conexión cerrada inesperadamente'))
      else if (state.connected) {
        state.connected = false
        log('OBS desconectado', 'warn')
        sse('status', statusPayload())
        if (!manualDisconnect) scheduleReconnect()
      }
    })

    ws.on('message', async raw => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      const { op, d } = msg

      if (op === 0) {
        clearTimeout(connTimeout)
        log(`OBS WebSocket v${d.obsWebSocketVersion || '?'} detectado`)
        const identData = { rpcVersion: 1, eventSubscriptions: 4 }
        if (d.authentication) {
          if (!cfg.obsPassword) { ws.terminate(); return failWith(new Error('OBS requiere contraseña')) }
          const secret = crypto.createHash('sha256').update(cfg.obsPassword + d.authentication.salt).digest('base64')
          identData.authentication = crypto.createHash('sha256').update(secret + d.authentication.challenge).digest('base64')
        }
        ws.send(JSON.stringify({ op: 1, d: identData }))
        return
      }

      if (op === 2) {
        if (resolved) return
        resolved = true
        state.connected = true
        state.connecting = false
        state.obsVersion = d.negotiatedRpcVersion
        log('Conectado a OBS ✓', 'success')
        sse('status', statusPayload())
        try {
          const [sceneList, pgmRes, pvwRes] = await Promise.all([
            obsCall('GetSceneList'),
            obsCall('GetCurrentProgramScene'),
            obsCall('GetCurrentPreviewScene').catch(() => ({ currentPreviewSceneName: null }))
          ])
          state.scenes = [...(sceneList.scenes || [])].reverse()
          state.pgmScene = pgmRes.currentProgramSceneName || null
          state.pvwScene = pvwRes.currentPreviewSceneName || null
          log(`${state.scenes.length} escenas detectadas`, 'success')
          sse('scenes', { scenes: state.scenes, mapping: state.mapping })
          sse('status', statusPayload())
          if (state.pgmScene) sendTally(state.pgmScene, 'program')
          if (state.pvwScene && state.pvwScene !== state.pgmScene) sendTally(state.pvwScene, 'preview')
        } catch (e) { log('Error leyendo estado inicial: ' + e.message, 'warn') }
        resolve()
        return
      }
      if (op === 5) { handleEvent(d); return }
      if (op === 7) {
        const cb = reqCbs[d.requestId]
        if (!cb) return
        delete reqCbs[d.requestId]
        if (d.requestStatus?.result) cb.resolve(d.responseData || {})
        else cb.reject(new Error(d.requestStatus?.comment || 'OBS error'))
      }
    })
  })
}

function obsCall(requestType, requestData = {}) {
  return new Promise((resolve, reject) => {
    if (!obsSocket || obsSocket.readyState !== WebSocket.OPEN) return reject(new Error('No conectado a OBS'))
    const requestId = `r${++reqCounter}`
    reqCbs[requestId] = { resolve, reject }
    obsSocket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
    setTimeout(() => {
      if (!reqCbs[requestId]) return
      delete reqCbs[requestId]
      reject(new Error(`Timeout en ${requestType}`))
    }, 5000)
  })
}

function handleEvent({ eventType, eventData }) {
  if (eventType === 'CurrentProgramSceneChanged') {
    const next = eventData.sceneName
    updateTallyState(next, state.pvwScene)
    // Sync PVW after PGM change (Studio Mode auto-advances preview)
    setTimeout(() => {
      obsCall('GetCurrentPreviewScene').then(r => {
        const pvw = r.currentPreviewSceneName || null
        if (pvw && pvw !== state.pvwScene) updateTallyState(state.pgmScene, pvw)
      }).catch(() => {})
    }, 120)
  } else if (eventType === 'CurrentPreviewSceneChanged') {
    updateTallyState(state.pgmScene, eventData.sceneName)
  } else if (eventType === 'SceneListChanged') {
    obsCall('GetSceneList').then(data => {
      state.scenes = [...(data.scenes || [])].reverse()
      log(`Lista de escenas actualizada (${state.scenes.length})`)
      sse('scenes', { scenes: state.scenes, mapping: state.mapping })
    }).catch(() => {})
  }
}

// ── Tally state machine (shared by all switchers) ───────────────
function updateTallyState(newPgmKey, newPvwKey) {
  // Skip if nothing changed (#12 dedup)
  if (newPgmKey === state.pgmScene && newPvwKey === state.pvwScene) return

  const prevPgm = state.pgmScene
  const prevPvw = state.pvwScene

  // Clear previous PGM cam if it's no longer PGM or PVW
  if (prevPgm && prevPgm !== newPgmKey) {
    const prevCam = state.mapping[prevPgm] || 0
    const pvwCam  = state.mapping[newPvwKey] || 0
    if (prevCam && prevCam !== pvwCam) sendTallyDirect(prevCam, 'clear')
  }
  // Clear previous PVW cam if it's no longer PVW or PGM
  if (prevPvw && prevPvw !== newPvwKey && prevPvw !== newPgmKey) {
    const prevCam = state.mapping[prevPvw] || 0
    const pgmCam  = state.mapping[newPgmKey] || 0
    if (prevCam && prevCam !== pgmCam) sendTallyDirect(prevCam, 'clear')
  }

  state.pgmScene = newPgmKey
  state.pvwScene = newPvwKey

  const pgmCam = newPgmKey ? (state.mapping[newPgmKey] || 0) : 0
  const pvwCam = newPvwKey ? (state.mapping[newPvwKey] || 0) : 0

  if (pgmCam) sendTallyDirect(pgmCam, 'program')
  if (pvwCam && pvwCam !== pgmCam) sendTallyDirect(pvwCam, 'preview')

  sse('status', statusPayload())
}

// ── Tally HTTP → TallyComm ──────────────────────────────────────
function sendTally(sceneName, bus) {
  const cam = state.mapping[sceneName] || 0
  if (cam) sendTallyDirect(cam, bus)
}

async function sendTallyDirect(camera, bus) {
  const room = state.config.tallyRoom?.trim()
  if (!room) { log('Sin sala configurada — tally ignorado', 'warn'); return }
  const body = { camera: parseInt(camera), bus, room }
  const url  = `${state.config.tallyUrl.replace(/\/$/, '')}/api/tally`
  const headers = { 'Content-Type': 'application/json' }
  // Add auth header if server requires TALLY_SECRET — empty string means no auth
  if (state.config.tallyApiKey) headers['x-tallycomm-key'] = state.config.tallyApiKey
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    })
    const ok = res.ok
    const statusTxt = res.status === 401 ? '401 UNAUTHORIZED — revisa API Key' : `HTTP ${res.status}`
    log(`TALLY cam${camera} ${bus.toUpperCase()} → ${ok ? '✓ OK' : `Error ${statusTxt}`}`, ok ? 'success' : 'error')
    sse('tally', { ...body, ok, status: res.status })
  } catch (e) {
    log(`TALLY cam${camera} ${bus.toUpperCase()} → ${e.message}`, 'error')
    sse('tally', { ...body, ok: false, error: e.message })
  }
}

// ── API REST ─────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()
  sseClients.push(res)
  res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`)
  res.write(`event: scenes\ndata: ${JSON.stringify({ scenes: state.scenes, mapping: state.mapping })}\n\n`)
  req.on('close', () => {
    const i = sseClients.indexOf(res)
    if (i > -1) sseClients.splice(i, 1)
  })
})

app.post('/api/connect', async (req, res) => {
  const { obsHost, obsPort, obsPassword, rgblinkHost, rgblinkPort, atemHost, vmixHost, vmixPort, oseeHost, rolandHost, rolandPort, rolandInputs, tricasterHost, tricasterPort, tricasterInputs, avmatrixHost, avmatrixInputs, tallyUrl, tallyRoom, tallyApiKey, switcher } = req.body

  state.config = {
    switcher:        switcher || 'obs',
    obsHost:         obsHost     || '127.0.0.1',
    obsPort:         parseInt(obsPort) || 4455,
    obsPassword:     obsPassword || '',
    rgblinkHost:     rgblinkHost || '192.168.0.99',
    rgblinkPort:     parseInt(rgblinkPort) || RGBLINK_PORT,
    atemHost:        atemHost    || '192.168.10.240',
    vmixHost:        vmixHost    || '127.0.0.1',
    vmixPort:        parseInt(vmixPort) || 8099,
    oseeHost:        oseeHost    || '192.168.1.100',
    rolandHost:      rolandHost  || '192.168.0.1',
    rolandPort:      parseInt(rolandPort) || 80,
    rolandInputs:    parseInt(rolandInputs) || 8,
    tricasterHost:   tricasterHost || '192.168.1.10',
    tricasterPort:   parseInt(tricasterPort) || 80,
    tricasterInputs: parseInt(tricasterInputs) || 8,
    avmatrixHost:    avmatrixHost || '192.168.1.110',
    avmatrixInputs:  parseInt(avmatrixInputs) || 4,
    tallyUrl:        tallyUrl    || 'https://tallycomm.com',
    tallyRoom:       tallyRoom   || '',
    tallyApiKey:     tallyApiKey || ''
  }

  manualDisconnect = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  // Desconectar lo que esté activo
  if (obsSocket) { try { obsSocket.terminate() } catch {}; obsSocket = null }
  rgblinkDisconnect()
  atemDisconnect()
  vmixDisconnect()
  oseeDisconnect()
  rolandDisconnect()
  tricasterDisconnect()
  avmatrixDisconnect()

  Object.assign(state, { connected: false, connecting: false, error: null, scenes: [], pgmScene: null, pvwScene: null })

  try {
    if (switcher === 'atem')           await atemConnect(state.config)
    else if (switcher === 'vmix')      await vmixConnect(state.config)
    else if (switcher === 'rgblink')   await rgblinkConnect(state.config)
    else if (switcher === 'osee')      await oseeConnect(state.config)
    else if (switcher === 'roland')    await rolandConnect(state.config)
    else if (switcher === 'tricaster') await tricasterConnect(state.config)
    else if (switcher === 'avmatrix')  await avmatrixConnect(state.config)
    else                               await obsConnect(state.config)
    saveToDisk()
    res.json({ ok: true })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.post('/api/disconnect', (req, res) => {
  manualDisconnect = true
  // Turn the lights off BEFORE tearing anything down. The Object.assign below
  // nulls pgmScene/pvwScene straight on the state object, which bypasses
  // updateTallyState() — the only function that actually sends. That left the
  // operators' phones lit red with the bridge convinced nothing was on air,
  // so not even a later reconnect corrected it.
  updateTallyState(null, null)
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (obsSocket) { try { obsSocket.terminate() } catch {}; obsSocket = null }
  rgblinkDisconnect()
  atemDisconnect()
  vmixDisconnect()
  oseeDisconnect()
  rolandDisconnect()
  tricasterDisconnect()
  avmatrixDisconnect()
  Object.assign(state, { connected: false, connecting: false, scenes: [], pgmScene: null, pvwScene: null })
  sse('status', statusPayload())
  log('Desconectado manualmente', 'warn')
  res.json({ ok: true })
})

app.post('/api/mapping', (req, res) => {
  const { sceneName, cameraNumber } = req.body
  const cam = parseInt(cameraNumber)
  if (cam === 0) delete state.mapping[sceneName]
  else state.mapping[sceneName] = cam
  saveToDisk()
  sse('scenes', { scenes: state.scenes, mapping: state.mapping })
  res.json({ ok: true, mapping: state.mapping })
})

app.post('/api/test', async (req, res) => {
  const { camera, bus } = req.body
  await sendTallyDirect(parseInt(camera), bus)
  res.json({ ok: true })
})

app.get('/api/status', (req, res) => res.json({
  ...statusPayload(),
  savedConfig: {
    obsHost:     state.config.obsHost,
    obsPort:     state.config.obsPort,
    rgblinkHost: state.config.rgblinkHost,
    rgblinkPort: state.config.rgblinkPort,
    atemHost:    state.config.atemHost,
    vmixHost:    state.config.vmixHost,
    vmixPort:    state.config.vmixPort,
    oseeHost:    state.config.oseeHost,
    rolandHost:  state.config.rolandHost,
    rolandPort:  state.config.rolandPort,
    rolandInputs: state.config.rolandInputs,
    tricasterHost: state.config.tricasterHost,
    tricasterPort: state.config.tricasterPort,
    tricasterInputs: state.config.tricasterInputs,
    avmatrixHost:   state.config.avmatrixHost,
    avmatrixInputs: state.config.avmatrixInputs,
    tallyUrl:    state.config.tallyUrl,
    tallyRoom:   state.config.tallyRoom,
    tallyApiKey: state.config.tallyApiKey,
    switcher:    state.config.switcher
  }
}))

// ── Arrancar ──────────────────────────────────────────────────────
const LISTEN_PORT = parseInt(process.env.TALLYBRIDGE_PORT) || PORT
const isElectron  = !!process.versions.electron

loadSaved()

app.listen(LISTEN_PORT, '127.0.0.1', () => {
  if (!isElectron) {
    console.log('\n╔════════════════════════════════════╗')
    console.log('║ TallyBridge v1.5.0 — TallyComm       ║')
    console.log(`║ http://localhost:${LISTEN_PORT}               ║`)
    console.log('╚════════════════════════════════════╝\n')
    const url = `http://localhost:${LISTEN_PORT}`
    const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start ${url}` : `xdg-open "${url}"`
    try { execSync(cmd) } catch {}
  }

  // Auto-connect to last used switcher if config was saved (#20)
  const sw = state.config.switcher
  const room = state.config.tallyRoom?.trim()
  if (room && sw) {
    log(`Auto-conectando a ${sw}…`)
    const connectFn = sw === 'atem' ? atemConnect
      : sw === 'vmix' ? vmixConnect
      : sw === 'rgblink' ? rgblinkConnect
      : sw === 'osee' ? oseeConnect
      : sw === 'roland' ? rolandConnect
      : sw === 'tricaster' ? tricasterConnect
      : sw === 'avmatrix' ? avmatrixConnect
      : obsConnect
    connectFn(state.config).catch(e => {
      log('Auto-conexión fallida: ' + e.message, 'warn')
    })
  }
})

// ── Apagado: no dejar ninguna cámara encendida ────────────────
// Cerrar la app sin pulsar DESCONECTAR dejaba lo que estuviera en PGM en rojo
// en el teléfono del operador para siempre: ni la app ni las señales del SO le
// decían nada a TallyComm. Es mejor esfuerzo — se lanzan los clear y se le da
// un momento a los POST antes de que el proceso desaparezca.
let _shuttingDown = false
async function shutdownTally(reason = 'exit') {
  if (_shuttingDown) return
  _shuttingDown = true
  if (!state.pgmScene && !state.pvwScene) return
  log(`Apagando tally antes de salir (${reason})`, 'warn')
  updateTallyState(null, null)
  await new Promise(r => setTimeout(r, 600))
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await shutdownTally(sig) } catch {}
    process.exit(0)
  })
}

module.exports = { shutdownTally }
