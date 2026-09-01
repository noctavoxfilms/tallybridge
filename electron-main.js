'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, screen } = require('electron')
const path   = require('path')
const fs     = require('fs')
const http   = require('http')
const https  = require('https')

// ── Prevent multiple instances ───────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit(); process.exit(0) }

// ── Config ───────────────────────────────────────────────────
const PORT     = 4000
const APP_NAME = 'TallyBridge'
const REPO     = 'noctavoxfilms/tallybridge'
const WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')

let mainWindow = null
let tray       = null
let serverReady = false

let bridgeModule = null   // expone shutdownTally() para apagar el tally al salir

// ── Start bridge server ──────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    try {
      // Load bridge.js — it calls app.listen internally
      // We override PORT via env so it doesn't conflict
      process.env.TALLYBRIDGE_PORT = PORT
      bridgeModule = require('./bridge.js')

      // Poll until server responds
      let attempts = 0
      const check = () => {
        http.get(`http://127.0.0.1:${PORT}/api/status`, res => {
          if (res.statusCode === 200) { serverReady = true; resolve() }
          else retry()
        }).on('error', retry)
      }
      const retry = () => {
        if (++attempts > 40) return reject(new Error('Servidor no respondió'))
        setTimeout(check, 150)
      }
      setTimeout(check, 300)
    } catch (e) { reject(e) }
  })
}

// ── Tray icon (base64 PNG 16x16 rojo) ────────────────────────
function makeTrayIcon() {
  // Círculo rojo minimalista — 16x16 PNG en base64
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAEbSURBVDiNlZOxSgNBEIa/3b27CyGksLGwMLSwsLCwMCAiKAiCiIVY+AQ+gI9gYSEiCIKFhYiIiIiIiI2IiIiIiIiIiEh6bnZnd3bOwtvc3v7zz8w/M0sAqCpEBBHBzHDOYWaY2R8zw8wws1/WWmutMTOstcYYY4wx1lprrTHGWGuttdZaay2llFJKKaWUUkoppZRSSinlnHPOOeecc84555xzzjnnnHPOOeecc84555xzzjnnAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAuAECAAD//wMAUEsDBBQAAAAIAAAAIQA='

  try {
    const img = nativeImage.createFromDataURL('data:image/png;base64,' + b64)
    return img
  } catch {
    return nativeImage.createEmpty()
  }
}

// ── Update check ─────────────────────────────────────────────
// Asks GitHub for the latest release and tells you if there is a newer one.
// Deliberately NOT an auto-updater: this holds the tally for a live show, and
// an app that restarts itself mid-broadcast to install something is a hazard.
// It informs; you choose when.
function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0) }
  return 0
}

let updateChecked = false
function checkForUpdates() {
  if (updateChecked || !app.isPackaged) return   // no nagging while developing
  updateChecked = true

  const req = https.request({
    host: 'api.github.com',
    path: `/repos/${REPO}/releases/latest`,
    headers: { 'User-Agent': APP_NAME, 'Accept': 'application/vnd.github+json' },
    timeout: 6000
  }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', d => body += d)
    res.on('end', () => {
      if (res.statusCode !== 200) return
      let rel; try { rel = JSON.parse(body) } catch (e) { return }
      const latest = rel && rel.tag_name
      if (!latest || cmpVersions(latest, app.getVersion()) <= 0) return

      // Never interrupt a live connection — the switcher is driving tally right
      // now. Hold the notice until nothing is connected.
      const notify = () => {
        if (bridgeModule && bridgeModule.isConnected && bridgeModule.isConnected()) {
          return setTimeout(notify, 60000)
        }
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          title: APP_NAME,
          message: `Hay una versión nueva: ${latest}`,
          detail: `Tenés la v${app.getVersion()}. Podés seguir usando esta y actualizar cuando te quede cómodo.`,
          buttons: ['Ver la actualización', 'Después'],
          defaultId: 0, cancelId: 1
        }).then(r => {
          if (r.response === 0) shell.openExternal(rel.html_url || `https://github.com/${REPO}/releases/latest`)
        }).catch(() => {})
      }
      notify()
    })
  })
  // A missing or unreachable GitHub is not worth telling anyone about
  req.on('error', () => {})
  req.on('timeout', () => req.destroy())
  req.end()
}

// ── Window size and position, remembered between launches ────
// It used to reopen at a fixed 1060x760 every time, so any resizing was lost on
// the next launch. The default is bigger now but still clamped to the screen's
// work area, so it never opens larger than the desktop on a small laptop.
function loadWindowState() {
  const area = screen.getPrimaryDisplay().workAreaSize
  const def  = { width: Math.min(1280, area.width - 40), height: Math.min(860, area.height - 40) }
  let saved = null
  try { saved = JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8')) } catch (e) {}
  if (!saved || !saved.width || !saved.height) return def

  const st = {
    width:  Math.min(Math.max(saved.width, 800), area.width),
    height: Math.min(Math.max(saved.height, 600), area.height)
  }
  // Only restore the position if it still lands on a connected display —
  // otherwise unplugging a second monitor reopens the window off-screen.
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
    const visible = screen.getAllDisplays().some(d => {
      const b = d.bounds
      return saved.x < b.x + b.width && saved.x + 200 > b.x &&
             saved.y < b.y + b.height && saved.y + 100 > b.y
    })
    if (visible) { st.x = saved.x; st.y = saved.y }
  }
  return st
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
  try {
    const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    fs.mkdirSync(path.dirname(WIN_STATE_FILE), { recursive: true })
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify(b))
  } catch (e) {}
}

// ── Create main window ───────────────────────────────────────
function createWindow() {
  const st = loadWindowState()
  mainWindow = new BrowserWindow({
    ...st,
    minWidth:        800,
    minHeight:       600,
    title:           APP_NAME,
    backgroundColor: '#0d0d0d',
    titleBarStyle:   'default',
    webPreferences: {
      nodeIntegration:    false,
      contextIsolation:   true,
      sandbox:            true
    },
    show: false,  // show after ready-to-show
    icon: path.join(__dirname, 'icon.png')
  })

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`)

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    checkForUpdates()
  })

  // Debounced so dragging or resizing does not hammer the disk
  let saveTimer = null
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400) }
  mainWindow.on('resize', queueSave)
  mainWindow.on('move', queueSave)
  mainWindow.on('close', saveWindowState)

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  // On Mac: hide instead of close (keep in tray)
  mainWindow.on('close', e => {
    if (process.platform === 'darwin' && !app.isQuiting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Create tray ──────────────────────────────────────────────
function createTray() {
  const icon = makeTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)

  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir TallyBridge',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus() }
        else createWindow()
      }
    },
    { type: 'separator' },
    {
      label: 'Abrir en Browser',
      click: () => shell.openExternal(`http://127.0.0.1:${PORT}`)
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => { app.isQuiting = true; app.quit() }
    }
  ])

  tray.setContextMenu(menu)

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.focus()
      else mainWindow.show()
    } else {
      createWindow()
    }
  })
}

// ── App lifecycle ────────────────────────────────────────────
app.whenReady().then(async () => {
  // Loading window while server starts
  const loadWin = new BrowserWindow({
    width: 340, height: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#0d0d0d',
    resizable: false,
    center: true,
    show: false,
    webPreferences: { nodeIntegration: false }
  })

  loadWin.loadURL('data:text/html,' + encodeURIComponent(`
    <html><head><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      background:#0d0d0d;color:#fff;
      font-family:'Barlow Condensed','Helvetica Neue',sans-serif;
      display:flex;flex-direction:column;align-items:center;
      justify-content:center;height:100vh;gap:14px;
      border:1px solid #333;border-radius:8px;
    }
    .dot{
      width:12px;height:12px;border-radius:50%;
      background:#ff3b3b;box-shadow:0 0 12px #ff3b3b;
      animation:pulse 1s infinite;
    }
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}
    .title{font-size:22px;font-weight:900;letter-spacing:.2em;}
    .title em{color:#ff3b3b;font-style:normal;}
    .sub{font-family:monospace;font-size:10px;color:#555;letter-spacing:.1em;}
    </style></head>
    <body>
      <div class="dot"></div>
      <div class="title">TALLY<em>BRIDGE</em></div>
      <div class="sub">INICIANDO…</div>
    </body></html>
  `))
  loadWin.once('ready-to-show', () => loadWin.show())

  try {
    await startServer()
    loadWin.close()
    createTray()
    createWindow()
  } catch (e) {
    loadWin.close()
    dialog.showErrorBox('TallyBridge — Error', 'No se pudo iniciar el servidor:\n\n' + e.message)
    app.quit()
  }
})

// Mac: reopen window when clicking dock icon
app.on('activate', () => {
  if (!mainWindow) createWindow()
  else { mainWindow.show(); mainWindow.focus() }
})

// Second instance → focus existing window
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
})

app.on('window-all-closed', () => {
  // On Mac keep running in tray; on Windows/Linux quit
  if (process.platform !== 'darwin') app.quit()
})

let _tallyCleared = false
app.on('before-quit', async (e) => {
  app.isQuiting = true
  // Antes de irnos, apagar el tally: si no, la cámara que estaba en PGM se
  // queda en rojo en el teléfono del operador sin nadie switcheando detrás.
  // Se cancela la salida una sola vez para que los POST alcancen a salir.
  if (_tallyCleared || !bridgeModule || !bridgeModule.shutdownTally) return
  e.preventDefault()
  _tallyCleared = true
  try { await bridgeModule.shutdownTally('quit') } catch {}
  app.quit()
})
