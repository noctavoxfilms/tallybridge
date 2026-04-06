// ============================================================
// TallyBridge v1.2.2 — conecta OBS y RGBlink mini a TallyComm
// Protocolo RGBlink: companion-module-rgblink-mini (Bitfocus) — puerto 1000, ASCII commands
// ============================================================
'use strict'
const express   = require('express')
const WebSocket = require('ws')
const dgram     = require('dgram')
const crypto    = require('crypto')
const path      = require('path')
const fs        = require('fs')
const { execSync } = require('child_process')

const app  = express()
const PORT = 4000
app.use(express.json())

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'bridge-ui.html')))

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
    tallyUrl:      'https://tallycomm.com',
    tallyRoom:     ''
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

    log(`RGBlink tally → PGM: ${pgmInput ? 'Input '+pgmInput : '--'}  PST: ${pvwInput ? 'Input '+pvwInput : '--'}`)

    const prevPgm = state.pgmScene
    const prevPvw = state.pvwScene

    if (prevPgm && prevPgm !== pgmKey) {
      const prevCam = state.mapping[prevPgm] || 0
      const pvwCam  = state.mapping[pvwKey]  || 0
      if (prevCam && prevCam !== pvwCam) sendTallyDirect(prevCam, 'clear')
    }
    if (prevPvw && prevPvw !== pvwKey && prevPvw !== pgmKey) {
      const prevCam = state.mapping[prevPvw] || 0
      const pgmCam  = state.mapping[pgmKey]  || 0
      if (prevCam && prevCam !== pgmCam) sendTallyDirect(prevCam, 'clear')
    }

    state.pgmScene = pgmKey
    state.pvwScene = pvwKey

    const pgmCam = pgmKey ? (state.mapping[pgmKey] || 0) : 0
    const pvwCam = pvwKey ? (state.mapping[pvwKey] || 0) : 0

    if (pgmCam) sendTallyDirect(pgmCam, 'program')
    if (pvwCam && pvwCam !== pgmCam) sendTallyDirect(pvwCam, 'preview')

    sse('status', statusPayload())
    return
  }

  log(`RGBlink: paquete de longitud inesperada (${buf.length} bytes) — ignorado`, 'warn')
}

// ── Auto-reconnect OBS ─────────────────────────────────────────
function scheduleReconnect(delay = 4000) {
  if (reconnectTimer) return
  if (!state.config.tallyRoom) return
  log(`Reconectando en ${delay / 1000}s…`, 'warn')
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    if (state.connected || manualDisconnect) return
    log('Intentando reconectar a OBS…')
    try {
      await obsConnect(state.config)
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
    const prev = state.pgmScene
    const next = eventData.sceneName
    log(`PGM → "${next}"`)
    const prevCam = state.mapping[prev] || 0
    const pvwCam  = state.mapping[state.pvwScene] || 0
    if (prevCam && prevCam !== pvwCam) sendTallyDirect(prevCam, 'clear')
    state.pgmScene = next
    const newCam = state.mapping[next] || 0
    if (newCam) sendTallyDirect(newCam, 'program')
    sse('status', statusPayload())
    setTimeout(() => {
      obsCall('GetCurrentPreviewScene').then(r => {
        const pvw = r.currentPreviewSceneName || null
        if (pvw && pvw !== state.pvwScene) {
          log(`PVW sync → "${pvw}" (Studio Mode)`)
          const oldPvwCam = state.mapping[state.pvwScene] || 0
          const pgmCam2   = state.mapping[state.pgmScene] || 0
          if (oldPvwCam && oldPvwCam !== pgmCam2) sendTallyDirect(oldPvwCam, 'clear')
          state.pvwScene = pvw
          const newPvwCam = state.mapping[pvw] || 0
          if (newPvwCam && newPvwCam !== pgmCam2) sendTallyDirect(newPvwCam, 'preview')
          sse('status', statusPayload())
        }
      }).catch(() => {})
    }, 120)
  } else if (eventType === 'CurrentPreviewSceneChanged') {
    const prev = state.pvwScene
    const next = eventData.sceneName
    log(`PVW → "${next}"`)
    const prevCam = state.mapping[prev] || 0
    const pgmCam  = state.mapping[state.pgmScene] || 0
    if (prevCam && prevCam !== pgmCam) sendTallyDirect(prevCam, 'clear')
    state.pvwScene = next
    const newCam = state.mapping[next] || 0
    if (newCam) sendTallyDirect(newCam, 'preview')
    sse('status', statusPayload())
  } else if (eventType === 'SceneListChanged') {
    obsCall('GetSceneList').then(data => {
      state.scenes = [...(data.scenes || [])].reverse()
      log(`Lista de escenas actualizada (${state.scenes.length})`)
      sse('scenes', { scenes: state.scenes, mapping: state.mapping })
    }).catch(() => {})
  }
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
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    })
    const ok = res.ok
    log(`TALLY cam${camera} ${bus.toUpperCase()} → ${ok ? '✓ OK' : `Error HTTP ${res.status}`}`, ok ? 'success' : 'error')
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
  const { obsHost, obsPort, obsPassword, rgblinkHost, rgblinkPort, tallyUrl, tallyRoom, switcher } = req.body

  state.config = {
    switcher:    switcher || 'obs',
    obsHost:     obsHost     || '127.0.0.1',
    obsPort:     parseInt(obsPort) || 4455,
    obsPassword: obsPassword || '',
    rgblinkHost: rgblinkHost || '192.168.0.99',
    rgblinkPort: parseInt(rgblinkPort) || RGBLINK_PORT,
    tallyUrl:    tallyUrl    || 'https://tallycomm.com',
    tallyRoom:   tallyRoom   || ''
  }

  manualDisconnect = false
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  // Desconectar lo que esté activo
  if (obsSocket) { try { obsSocket.terminate() } catch {}; obsSocket = null }
  rgblinkDisconnect()

  Object.assign(state, { connected: false, connecting: false, error: null, scenes: [], pgmScene: null, pvwScene: null })

  try {
    if (switcher === 'rgblink') {
      await rgblinkConnect(state.config)
    } else {
      await obsConnect(state.config)
    }
    saveToDisk()
    res.json({ ok: true })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.post('/api/disconnect', (req, res) => {
  manualDisconnect = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  if (obsSocket) { try { obsSocket.terminate() } catch {}; obsSocket = null }
  rgblinkDisconnect()
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
    tallyUrl:    state.config.tallyUrl,
    tallyRoom:   state.config.tallyRoom,
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
    console.log('║ TallyBridge v1.2.2 — TallyComm       ║')
    console.log(`║ http://localhost:${LISTEN_PORT}               ║`)
    console.log('╚════════════════════════════════════╝\n')
    const url = `http://localhost:${LISTEN_PORT}`
    const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start ${url}` : `xdg-open "${url}"`
    try { execSync(cmd) } catch {}
  }
})
