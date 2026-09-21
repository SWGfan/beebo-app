const { app, BrowserWindow, Menu, session, dialog, ipcMain, shell } = require('electron')
const fs = require('fs')
const path = require('path')

// Settings live in a plain JSON file next to the app's own data. Deliberately
// dependency-free: this app gets packaged by copying a folder, so every extra
// npm package would have to be copied with it.
let settingsPath = null
function settingsFile() {
  if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'viewer-settings.json')
  return settingsPath
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}
  } catch {
    return {}
  }
}
function writeSettings(next) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  } catch {
    /* a read-only profile shouldn't stop the app from running */
  }
}

let mainWindow = null

function getServerUrl() {
  const saved = readSettings().serverUrl || ''
  // The server now holds a real certificate and redirects http -> https. Saved
  // addresses from before that still say http://, which works (the redirect
  // catches it) but costs an extra round trip and shows an insecure address in
  // the window title, so upgrade it in place the first time we see one.
  if (/^http:\/\//i.test(saved)) {
    const upgraded = saved.replace(/^http:\/\//i, 'https://')
    const next = readSettings()
    next.serverUrl = upgraded
    writeSettings(next)
    return upgraded
  }
  return saved
}
function setServerUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '')
  const s = readSettings()
  s.serverUrl = clean
  writeSettings(s)
  return clean
}

// A tiny trusted setup window (we author this HTML ourselves, nothing external),
// so nodeIntegration here is a deliberate, contained exception — it is never used
// for any page served by the Beebo Entertainment server itself.
function promptForServerUrl() {
  return new Promise((resolve) => {
    const promptWin = new BrowserWindow({
      width: 480,
      height: 360,
      resizable: false,
      title: 'Connect to Beebo Entertainment',
      backgroundColor: '#0f1115',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    })
    promptWin.setMenuBarVisibility(false)

    const existing = getServerUrl()
    const html = `<!doctype html><html><head><meta charset="utf-8">
    <style>
      body { background:#0f1115; color:#eee; font-family:-apple-system,Segoe UI,Roboto,sans-serif; padding:24px; margin:0; }
      h2 { margin:0 0 8px; font-size:18px; }
      p { color:#8a8f98; font-size:13px; margin:0 0 16px; line-height:1.45; }
      input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:6px; border:1px solid #2a2f3a; background:#171a21; color:#eee; font-size:14px; margin-bottom:14px; }
      button { width:100%; padding:10px; border-radius:6px; border:none; background:#4f9dff; color:#fff; font-weight:600; cursor:pointer; font-size:14px; }
      code { color:#b9bec7; }
    </style>
    </head><body>
    <h2>Connect to Beebo Entertainment</h2>
    <p>Enter the address you were given — it looks like<br><code>https://something.duckdns.org:47811</code></p>
    <input id="url" placeholder="https://yourdomain.duckdns.org:47811" value="${existing.replace(/"/g, '&quot;')}" autofocus />
    <button id="go">Connect</button>
    <script>
      const { ipcRenderer } = require('electron')
      const input = document.getElementById('url')
      document.getElementById('go').addEventListener('click', submit)
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
      function submit() {
        let val = input.value.trim()
        if (!val) return
        if (!/^https?:\/\//i.test(val)) val = 'https://' + val
        ipcRenderer.send('viewer:server-url', val)
      }
    </script>
    </body></html>`
    promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

    const handler = (_e, url) => {
      const clean = setServerUrl(url)
      promptWin.close()
      ipcMain.removeListener('viewer:server-url', handler)
      resolve(clean)
    }
    ipcMain.on('viewer:server-url', handler)
    promptWin.on('closed', () => ipcMain.removeListener('viewer:server-url', handler))
  })
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Beebo Entertainment',
        submenu: [
          { label: 'Home', accelerator: 'Alt+Home', click: () => goHome() },
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
          { label: 'Back', accelerator: 'Alt+Left', click: () => mainWindow?.webContents.goBack() },
          { label: 'Forward', accelerator: 'Alt+Right', click: () => mainWindow?.webContents.goForward() },
          { type: 'separator' },
          { label: 'Change Server Address…', click: () => changeServerUrl() },
          { label: 'Log Out', click: () => logOut() },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ])
  )
}

function goHome() {
  const url = getServerUrl()
  // Loading the root (not /login) means an already-signed-in viewer goes
  // straight to the library, while anyone without a valid session is bounced
  // to the login page by the server — which is also what decides whether the
  // admin-only tabs appear.
  if (url) mainWindow?.loadURL(url + '/')
}

function changeServerUrl() {
  promptForServerUrl().then((url) => mainWindow?.loadURL(url + '/'))
}

function logOut() {
  const url = getServerUrl()
  if (!url) return
  session.defaultSession
    .clearStorageData({ origin: url })
    .catch(() => {})
    .finally(() => mainWindow?.loadURL(url + '/login'))
}

function showConnectionError(detail) {
  dialog.showErrorBox(
    "Can't reach Beebo Entertainment",
    `${detail}\n\nCheck your internet connection, or use the Beebo Entertainment menu → "Change Server Address…" if the address has changed.`
  )
}

async function createMainWindow() {
  let url = getServerUrl()
  if (!url) url = await promptForServerUrl()

  const s = readSettings()
  const bounds = s.windowBounds || {}
  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    backgroundColor: '#0f1115',
    title: 'Beebo Entertainment',
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
      // No preload on purpose: this window only ever shows your own Beebo Entertainment
      // server's pages and gets no Node/Electron APIs. The login "sticks"
      // between runs because Electron persists cookies like a browser profile.
    }
  })

  buildMenu()

  // Anything that isn't our own server (an external link) opens in the real
  // browser rather than hijacking the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(getServerUrl())) {
      shell.openExternal(target).catch(() => {})
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return // ERR_ABORTED — a cancelled navigation, normal
    showConnectionError(`Couldn't load ${validatedURL || url} (${errorDescription}).`)
  })

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
    const next = readSettings()
    next.windowBounds = mainWindow.getBounds()
    writeSettings(next)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.loadURL(url + '/')
}

app.whenReady().then(() => {
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
