// TorrentDrop desktop app (Electron) — CommonJS so it runs on any Electron version.
// Reuses the exact same engine: launches server.js as a local-only background
// process and loads the UI in a native window. Full BitTorrent swarm access,
// files saved to your real Downloads folder. No server, no hosting, all local.

const electron = require('electron');

// Robustness: if ELECTRON_RUN_AS_NODE leaked into the environment (it does inside
// some Electron-based terminals like VS Code), require('electron') returns a path
// string instead of the API. Relaunch cleanly with the variable cleared.
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [__filename], { stdio: 'inherit', env });
  process.exit(r.status == null ? 0 : r.status);
}

const { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage } = electron;
const { fork } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

// Native folder picker for the "download location" setting (exposed via preload).
ipcMain.handle('td-pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return (r.canceled || !r.filePaths || !r.filePaths[0]) ? null : r.filePaths[0];
});
// Reveal a finished download in Finder / Explorer.
ipcMain.handle('td-show-item', (_e, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.handle('td-open-path', (_e, p) => { if (p) shell.openPath(p); });

const ROOT = path.join(__dirname, '..');
const PORT = 8088;          // localhost only
const APP_URL = 'http://127.0.0.1:' + PORT + '/';

let engine = null;
let win = null;
let tray = null;
let isQuitting = false;

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Tray icon: lives in the macOS menu bar / Windows system tray. Lets the app
// keep running (and downloading) in the background after the window is closed.
function createTray() {
  const iconPath = process.platform === 'darwin'
    ? path.join(__dirname, 'assets', 'trayTemplate.png')
    : path.join(__dirname, 'assets', 'tray.png');
  const img = nativeImage.createFromPath(iconPath);
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('TorrentDrop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open TorrentDrop', click: showWindow },
    { type: 'separator' },
    { label: 'Quit TorrentDrop', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

// Reflect live download activity in the tray (tooltip everywhere; menu-bar text on macOS).
function startTrayStatus() {
  setInterval(() => {
    const req = http.get(APP_URL + 'api/torrents', (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => {
        if (!tray) return;
        try {
          const ts = JSON.parse(d).torrents || [];
          const dl = ts.filter((t) => t.status === 'downloading' || t.status === 'fetching');
          let speed = 0; ts.forEach((t) => speed += t.downloadSpeed || 0);
          if (dl.length) {
            const mb = (speed / 1048576).toFixed(1);
            tray.setToolTip('TorrentDrop — ' + dl.length + ' downloading · ' + mb + ' MB/s');
            if (process.platform === 'darwin') tray.setTitle(' ↓' + mb);
          } else {
            tray.setToolTip('TorrentDrop');
            if (process.platform === 'darwin') tray.setTitle('');
          }
        } catch (e) {}
      });
    });
    req.on('error', () => {});
  }, 3000);
}

function startEngine() {
  const downloadDir = path.join(app.getPath('downloads'), 'TorrentDrop');
  engine = fork(path.join(ROOT, 'server.js'), [], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',     // run the forked Electron as plain Node
      PORT: String(PORT),
      TD_HOST: '127.0.0.1',          // never expose on the network
      TD_PASSWORD: '',               // local app: no login needed
      TD_DOWNLOAD_DIR: downloadDir,  // default download folder (first run / until changed in settings)
      TD_CONFIG_DIR: app.getPath('userData'), // persist settings + session next to the app's data
      UV_THREADPOOL_SIZE: '128',  // large disk-I/O thread pool to avoid write stalls at high speed
      MAX_CONNS: '1000'           // up to 1000 peers per torrent
    }
  });
  engine.on('exit', (code) => { if (code) console.error('engine exited:', code); });
}

function waitForServer(cb, tries = 0) {
  const req = http.get(APP_URL, (res) => { res.destroy(); cb(); });
  req.on('error', () => {
    if (tries > 80) return cb();   // give up waiting, load anyway
    setTimeout(() => waitForServer(cb, tries + 1), 250);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 420,
    backgroundColor: '#0d100f',
    title: 'TorrentDrop',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs') }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // Closing the window hides it to the tray and keeps downloading in the
  // background. The app only really quits from the tray's "Quit" item.
  win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });

  waitForServer(() => win.loadURL(APP_URL));
}

app.whenReady().then(() => {
  startEngine();
  createWindow();
  createTray();
  startTrayStatus();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
});

// Keep running in the tray when all windows are closed (download in background).
app.on('window-all-closed', () => {});
app.on('before-quit', () => { isQuitting = true; });
app.on('quit', () => { if (engine) { try { engine.kill(); } catch (e) {} } });
