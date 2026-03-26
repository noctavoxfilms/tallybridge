// ============================================================
// TallyBridge v1.2 — conecta OBS y RGBlink mini a TallyComm
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
    rgblinkHost:   '192.168.1.100',
    rgblinkPort:   4001,
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
let rgbSocket       = null
let rgbPingInterval = null

const RGBLINK_PORT      = 4001
const RGBLINK_HANDSHAKE = Buffer.from([0x68, 0x66, 0x01])
const RGBLINK_INPUTS    = 4  // RGBlink mini: 4 inputs

function rgblinkConnect(cfg) {
  return new Promise((resolve, reject) => {
    state.connecting = true
    state.error = null
    sse('status', statusPayload())

    const port = parseInt(cfg.rgblinkPort) || RGBLINK_PORT
    const host = cfg.rgblinkHost || '192.168.1.100'

    log(`Conectando a RGBlink mini en ${host}:${port}…`)

    const sock = dgram.createSocket('udp4')
    rgbSocket = sock

    let resolved = false
    const failWith = (err) => {
      if (resolved) return
      resolved = true
      try { sock.close() } catch {}
      rgbSocket = null
      state.connected = false
      state.connecting = false
      state.error = err.message
      sse('status', statusPayload())
      reject(err)
    }

    // Timeout si no hay respuesta en 5s — seguimos igual (UDP es sin conexión)
    const connTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        state.connected = true
        state.connecting = false
        log('RGBlink mini conectado (esperando paquetes de tally…)', 'success')
        sse('status', statusPayload())
        // Inicializar inputs en UI
        _initRgblinkScenes()
        resolve()
      }
    }, 2000)

    sock.on('error', (err) => {
      clearTimeout(connTimeout)
      failWith(err)
    })

    sock.on('message', (msg, rinfo) => {
      // Primera respuesta confirma conexión
      if (!resolved) {
        resolved = true
        clearTimeout(connTimeout)
        state.connected = true
        state.connecting = false
        log(`RGBlink mini respondió desde ${rinfo.address}:${rinfo.port} ✓`, 'success')
        sse('status', statusPayload())
        _initRgblinkScenes()
        resolve()
      }
      handleRGBlinkPacket(msg)
    })

    sock.bind(port, '0.0.0.0', () => {
      log(`UDP abierto en puerto ${port}`)
      // Enviar handshake
      sock.send(RGBLINK_HANDSHAKE, 0, RGBLINK_HANDSHAKE.length, port, host, (err) => {
        if (err) { clearTimeout(connTimeout); failWith(err); return }
        log(`Handshake enviado a ${host}:${port}`)
      })

      // Keepalive cada 3s — mantiene el stream de tally activo
      rgbPingInterval = setInterval(() => {
        if (rgbSocket) {
          rgbSocket.send(RGBLINK_HANDSHAKE, 0, RGBLINK_HANDSHAKE.length, port, host, () => {})
        }
      }, 3000)
    })
  })
}

function rgblinkDisconnect() {
  if (rgbPingInterval) { clearInterval(rgbPingInterval); rgbPingInterval = null }
  if (rgbSocket) { try { rgbSocket.close() } catch {}; rgbSocket = null }
}

function _initRgblinkScenes() {
  state.scenes = Array.from({ length: RGBLINK_INPUTS }, (_, i) => ({
    sceneName:   `input_${i + 1}`,
    displayName: `Input ${i + 1}`
  }))
  // Auto-map input N → cam N si no hay mapping previo
  let autoMapped = 0
  state.scenes.forEach((s, i) => {
    const cam = i + 1
    if (!state.mapping[s.sceneName]) {
      state.mapping[s.sceneName] = cam
      autoMapped++
    }
  })
  if (autoMapped) log(`Auto-mapeados ${autoMapped} inputs → cámaras`, 'success')
  sse('scenes', { scenes: state.scenes, mapping: state.mapping })
}

function handleRGBlinkPacket(buf) {
  if (buf.length < 3) return  // Paquete mínimo para leer PGM/PVW

  // Validar checksum si el paquete tiene 22 bytes
  if (buf.length === 22) {
    const expected = buf[buf.length - 1]
    let sum = 0
    for (let i = 0; i < buf.length - 1; i++) sum += buf[i]
    if ((sum % 256) !== expected) {
      log('Paquete RGBlink con checksum inválido — ignorado', 'warn')
      return
    }
  }

  // byte[0] = PVW input (1-indexed, 0 = ninguno)
  // byte[2] = PGM input (1-indexed, 0 = ninguno)
  const pvwInput = buf[0]
  const pgmInput = buf[2]

  const pgmKey = pgmInput > 0 ? `input_${pgmInput}` : null
  const pvwKey = pvwInput > 0 ? `input_${pvwInput}` : null

  log(`RGBlink tally → PGM: ${pgmInput ? 'Input '+pgmInput : '--'}  PVW: ${pvwInput ? 'Input '+pvwInput : '--'}`)

  const prevPgm = state.pgmScene
  const prevPvw = state.pvwScene

  // Clear PGM anterior si cambió y no está en PVW
  if (prevPgm && prevPgm !== pgmKey) {
    const prevCam = state.mapping[prevPgm] || 0
    const pvwCam  = state.mapping[pvwKey]  || 0
    if (prevCam && prevCam !== pvwCam) sendTallyDirect(prevCam, 'clear')
  }
  // Clear PVW anterior si cambió y no está en PGM
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
    rgblinkHost: rgblinkHost || '192.168.1.100',
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
    console.log('║ TallyBridge v1.2 — TallyComm       ║')
    console.log(`║ http://localhost:${LISTEN_PORT}               ║`)
    console.log('╚════════════════════════════════════╝\n')
    const url = `http://localhost:${LISTEN_PORT}`
    const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start ${url}` : `xdg-open "${url}"`
    try { execSync(cmd) } catch {}
  }
})
