'use strict'

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron')
const path   = require('path')
const http   = require('http')

// ── Prevent multiple instances ───────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) { app.quit(); process.exit(0) }

// ── Config ───────────────────────────────────────────────────
const PORT     = 4000
const APP_NAME = 'TallyBridge'

let mainWindow = null
let tray       = null
let serverReady = false

// ── Start bridge server ──────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    try {
      // Load bridge.js — it calls app.listen internally
      // We override PORT via env so it doesn't conflict
      process.env.TALLYBRIDGE_PORT = PORT
      require('./bridge.js')

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

// ── Create main window ───────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           1060,
    height:          760,
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
  })

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

app.on('before-quit', () => { app.isQuiting = true })
