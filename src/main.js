// CloudBrowser - main process
// Each tab is a WebContentsView laid out under the browser UI (src/ui/index.html).

const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, shell, dialog, session,
} = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const HOME_URL = 'https://duckduckgo.com/';
const SEARCH_URL = 'https://duckduckgo.com/?q=';
const UI_HEIGHT = 84; // tab strip + toolbar, must match --ui-height in styles.css
const NORMAL_PARTITION = 'persist:cloudbrowser';
const PRIVATE_PARTITION = 'cloudbrowser-private'; // no "persist:" = memory only, gone on exit

let win;
let tabs = [];          // [{ id, view, private }]
let activeId = null;
let nextId = 1;
let privateMode = false;
let updateState = { status: 'idle' }; // idle | checking | available | downloading | ready | none | error

// ---------- helpers ----------

function toUrl(text) {
  text = (text || '').trim();
  if (!text) return HOME_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|file|data):/i.test(text)) return text;
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(text)) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function getTab(id) { return tabs.find(t => t.id === id); }
function activeTab() { return getTab(activeId); }

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  for (const t of tabs) {
    t.view.setBounds({ x: 0, y: UI_HEIGHT, width: w, height: Math.max(0, h - UI_HEIGHT) });
  }
}

function tabInfo(t) {
  const wc = t.view.webContents;
  return {
    id: t.id,
    title: wc.getTitle() || 'New tab',
    url: wc.getURL(),
    favicon: t.favicon || null,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    private: t.private,
  };
}

function sendState() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', {
    tabs: tabs.map(tabInfo),
    activeId,
    privateMode,
    update: updateState,
    version: app.getVersion(),
  });
  const t = activeTab();
  win.setTitle(t ? `${t.view.webContents.getTitle() || 'New tab'} — CloudBrowser` : 'CloudBrowser');
}

// ---------- tabs ----------

function createTab(url = HOME_URL, { activate = true, isPrivate = privateMode } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      partition: isPrivate ? PRIVATE_PARTITION : NORMAL_PARTITION,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const tab = { id: nextId++, view, private: isPrivate, favicon: null };
  tabs.push(tab);
  win.contentView.addChildView(view);
  layout();

  const wc = view.webContents;
  ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']
    .forEach(ev => wc.on(ev, sendState));
  wc.on('page-favicon-updated', (_e, favicons) => { tab.favicon = favicons[0] || null; sendState(); });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted (normal when navigating away)
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errorPage(desc, failedUrl)));
  });
  // target=_blank / window.open -> new tab
  wc.setWindowOpenHandler(({ url }) => {
    createTab(url, { activate: true, isPrivate: tab.private });
    return { action: 'deny' };
  });
  // Keyboard shortcuts while a web page has focus
  wc.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });

  wc.loadURL(url);
  if (activate) switchTab(tab.id); else view.setVisible(false);
  sendState();
  return tab;
}

function switchTab(id) {
  if (!getTab(id)) return;
  activeId = id;
  for (const t of tabs) t.view.setVisible(t.id === id);
  sendState();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const [t] = tabs.splice(idx, 1);
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (tabs.length === 0) { win.close(); return; }
  if (activeId === id) switchTab(tabs[Math.min(idx, tabs.length - 1)].id);
  else sendState();
}

function cycleTab(dir) {
  const idx = tabs.findIndex(t => t.id === activeId);
  switchTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
}

function errorPage(desc, url) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><title>Can't reach this page</title>
  <body style="font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f7fb;color:#223">
  <div style="max-width:520px;text-align:center"><div style="font-size:64px">☁️</div>
  <h1 style="font-weight:600">Can't reach this page</h1>
  <p style="color:#556">${esc(url)}</p><p style="color:#889">${esc(desc)}</p></div></body>`;
}

// ---------- shortcuts ----------

function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const t = activeTab();
  const wc = t && t.view.webContents;

  if (ctrl && !input.shift && key === 't') { createTab(); focusAddress(); return true; }
  if (ctrl && key === 'w') { if (t) closeTab(t.id); return true; }
  if (ctrl && key === 'l') { focusAddress(); return true; }
  if ((ctrl && key === 'r') || key === 'f5') { wc && wc.reload(); return true; }
  if (ctrl && key === 'tab') { cycleTab(input.shift ? -1 : 1); return true; }
  if (ctrl && input.shift && key === 'p') { togglePrivate(); return true; }
  if (ctrl && input.shift && key === 'n') { createTab(HOME_URL, { isPrivate: true }); return true; }
  if (input.alt && key === 'arrowleft') { wc && wc.navigationHistory.goBack(); return true; }
  if (input.alt && key === 'arrowright') { wc && wc.navigationHistory.goForward(); return true; }
  if (ctrl && (key === '=' || key === '+')) { wc && wc.setZoomLevel(wc.getZoomLevel() + 0.5); return true; }
  if (ctrl && key === '-') { wc && wc.setZoomLevel(wc.getZoomLevel() - 0.5); return true; }
  if (ctrl && key === '0') { wc && wc.setZoomLevel(0); return true; }
  if (key === 'f12') { wc && wc.toggleDevTools(); return true; }
  return false;
}

function focusAddress() {
  win.webContents.focus();
  win.webContents.send('focus-address');
}

function togglePrivate() {
  privateMode = !privateMode;
  sendState();
}

// ---------- auto-update ----------

function setUpdate(status, extra = {}) {
  updateState = { status, ...extra };
  sendState();
}

function setupUpdater() {
  if (!app.isPackaged) return; // only update real installs, not "npm start"
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate('checking'));
  autoUpdater.on('update-available', info => setUpdate('downloading', { version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => setUpdate('downloading', { ...updateState, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => setUpdate('ready', { version: info.version }));
  autoUpdater.on('update-not-available', () => setUpdate('none'));
  autoUpdater.on('error', err => setUpdate('error', { message: String(err && err.message || err) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);                 // shortly after launch
  setInterval(check, 4 * 60 * 60 * 1000);  // then every 4 hours
}

// ---------- IPC from the UI ----------

ipcMain.on('new-tab', () => { createTab(); focusAddress(); });
ipcMain.on('close-tab', (_e, id) => closeTab(id));
ipcMain.on('switch-tab', (_e, id) => switchTab(id));
ipcMain.on('navigate', (_e, text) => {
  const t = activeTab();
  if (!t) return;
  t.view.webContents.loadURL(toUrl(text));
  t.view.webContents.focus();
});
ipcMain.on('back', () => activeTab()?.view.webContents.navigationHistory.goBack());
ipcMain.on('forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
ipcMain.on('reload', () => activeTab()?.view.webContents.reload());
ipcMain.on('stop', () => activeTab()?.view.webContents.stop());
ipcMain.on('home', () => activeTab()?.view.webContents.loadURL(HOME_URL));
ipcMain.on('toggle-private', togglePrivate);
ipcMain.on('install-update', () => autoUpdater.quitAndInstall());
ipcMain.on('check-update', () => {
  if (!app.isPackaged) { setUpdate('error', { message: 'Updates only work in the installed app.' }); return; }
  autoUpdater.checkForUpdates().catch(() => {});
});
ipcMain.on('menu', () => {
  const t = activeTab();
  const wc = t && t.view.webContents;
  Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => { createTab(); focusAddress(); } },
    { label: 'New private tab', accelerator: 'Ctrl+Shift+N', click: () => createTab(HOME_URL, { isPrivate: true }) },
    { type: 'separator' },
    { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => wc && wc.setZoomLevel(wc.getZoomLevel() + 0.5) },
    { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => wc && wc.setZoomLevel(wc.getZoomLevel() - 0.5) },
    { label: 'Reset zoom', accelerator: 'Ctrl+0', click: () => wc && wc.setZoomLevel(0) },
    { type: 'separator' },
    { label: 'Open page in default browser', click: () => wc && shell.openExternal(wc.getURL()) },
    { label: 'Clear browsing data…', click: clearData },
    { type: 'separator' },
    { label: 'Check for updates', click: () => ipcMain.emit('check-update') },
    { label: `About CloudBrowser`, click: () => dialog.showMessageBox(win, {
        title: 'About CloudBrowser', message: `CloudBrowser ${app.getVersion()}`,
        detail: 'A lightweight browser that searches with DuckDuckGo.\nUpdates install automatically.' }) },
  ]).popup({ window: win });
});

async function clearData() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Clear', 'Cancel'], defaultId: 0, cancelId: 1,
    title: 'Clear browsing data', message: 'Clear cookies, cache and site data?',
    detail: 'You will be signed out of websites.',
  });
  if (response !== 0) return;
  const s = session.fromPartition(NORMAL_PARTITION);
  await s.clearStorageData();
  await s.clearCache();
  for (const t of tabs) if (!t.private) t.view.webContents.navigationHistory.clear();
  sendState();
}

// ---------- app ----------

function createWindow(startUrl) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 480,
    minHeight: 300,
    title: 'CloudBrowser',
    backgroundColor: '#f4f7fb',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(input)) event.preventDefault();
  });
  win.webContents.once('did-finish-load', () => createTab(startUrl || HOME_URL));
  win.on('closed', () => { win = null; tabs = []; });
}

function argUrl(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-'));
  return args.length ? toUrl(args.join(' ')) : null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    createTab(argUrl(argv) || HOME_URL);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cloudbrowser.app');
    createWindow(argUrl(process.argv));
    setupUpdater();
  });

  app.on('window-all-closed', () => app.quit());
}
