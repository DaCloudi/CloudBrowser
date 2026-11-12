// CloudBrowser - main process
//
// Each browser window is a BaseWindow holding one WebContentsView per tab, with the browser
// UI (src/ui) as a transparent WebContentsView on top. The UI view is normally only as tall
// as the toolbar; it stretches over the page while the address-bar suggestions are open.
// Incognito windows use an in-memory session, so nothing they do is saved.
// Built-in pages (home, settings, history, bookmarks, downloads) are served from src/pages
// on the cloud:// scheme.
'use strict';

const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, shell, dialog, session,
  protocol, nativeTheme, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { Store, flushAll } = require('./store');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('Updater unavailable:', e.message); }

// ---------- constants ----------

const SMOKE = process.env.CLOUD_SMOKE === '1';
const NORMAL_PARTITION = 'persist:cloudbrowser';
const PRIVATE_PARTITION = 'cloudbrowser-private'; // no "persist:" = memory only
const PAGES_DIR = path.join(__dirname, 'pages');
const INTERNAL_PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads'];
const NEWTAB_URL = 'cloud://newtab/';
const PROG_ID = 'CloudBrowserHTML';

const ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', home: 'https://duckduckgo.com/' },
  ddglite: { name: 'DuckDuckGo Lite', url: 'https://lite.duckduckgo.com/lite/?q=%s', home: 'https://lite.duckduckgo.com/lite/' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s', home: 'https://search.brave.com/' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s', home: 'https://www.startpage.com/' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s', home: 'https://www.google.com/' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s', home: 'https://www.bing.com/' },
};

const DEFAULT_SETTINGS = {
  searchEngine: 'duckduckgo',
  homePage: NEWTAB_URL,
  restoreTabs: true,
  theme: 'system',            // system | light | dark
  showBookmarksBar: true,
  adblock: true,
  askDownloadLocation: false,
  defaultPromptDismissed: false,
  blockedTotal: 0,
  hiddenSites: [],
  homeVersion: 0,
  window: null,               // { width, height, maximized }
};
const INTERNAL_SETTINGS = new Set(['blockedTotal', 'window', 'hiddenSites', 'homeVersion']);

// Shown on the home page until there's enough history to replace them.
const DEFAULT_SITES = [
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://www.wikipedia.org/', title: 'Wikipedia' },
  { url: 'https://www.bbc.co.uk/news', title: 'BBC News' },
  { url: 'https://www.reddit.com/', title: 'Reddit' },
  { url: 'https://github.com/', title: 'GitHub' },
  { url: 'https://maps.google.com/', title: 'Maps' },
  { url: 'https://www.amazon.co.uk/', title: 'Amazon' },
  { url: 'https://www.twitch.tv/', title: 'Twitch' },
];

// Permissions a site must ask for. Anything not listed here or in AUTO_ALLOW is refused.
const PROMPT_PERMISSIONS = {
  media: 'use your camera and/or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'see text and images you copy',
  midi: 'use your MIDI devices',
  midiSysex: 'fully control your MIDI devices',
  fileSystem: 'edit files on your computer',
  'window-management': 'manage windows on all your displays',
  'idle-detection': 'know when you are using your computer',
  'storage-access': 'use cookies it saved on other sites',
  'top-level-storage-access': 'use cookies it saved on other sites',
  openExternal: 'open an app on your computer',
};
const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
// Refused without asking (Chrome mostly does the same; asking would just be noise).
const SILENT_DENY = new Set(['storage-access', 'top-level-storage-access', 'idle-detection']);

protocol.registerSchemesAsPrivileged([
  { scheme: 'cloud', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------- state ----------

let settings, bookmarks, history, permissions, downloadStore, sessionStore;
const windows = new Set();   // browser windows (see createWindow)
let lastFocused = null;
let nextWinId = 1;
let nextTabId = 1;
let quitting = false;
let sessionFrozen = false;   // the last normal window closed; keep its tabs for next start
let updateState = { status: 'idle' };
let blocker = null;
let privateBlocker = null;
let popupsBlocked = 0;
const blockingOn = new Set();
const privatePermissions = new Map(); // origin -> { permission: 'allow'|'block' } (incognito, this run only)
let downloads = [];      // newest first
const liveDownloads = new Map();
let nextDownloadId = 1;
let downloadsThisRun = 0;
let isDefaultBrowser = null; // null = unknown / not applicable

// ---------- small helpers ----------

const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  if (process.env.CLOUD_SMOKE_LOG) { try { fs.appendFileSync(process.env.CLOUD_SMOKE_LOG, line + '\n'); } catch {} }
};

function engine() { return ENGINES[settings.data.searchEngine] || ENGINES.duckduckgo; }
function searchUrl(q) { return engine().url.replace('%s', encodeURIComponent(q)); }
function homeUrl() { return settings.data.homePage || NEWTAB_URL; }

function toUrl(text) {
  text = (text || '').trim();
  if (!text) return homeUrl();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|mailto|view-source):/i.test(text)) return text;
  if (/^[a-z]:[\\/]/i.test(text) || text.startsWith('\\\\')) return pathToFileURL(text).href;
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z][a-z0-9-]{1,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  return searchUrl(text);
}

function load(wc, url) { wc.loadURL(url).catch(() => {}); }
function allTabs() { return [...windows].flatMap(w => w.tabs); }
function getTab(id) { return allTabs().find(t => t.id === id); }
function activeTab(w) { return w && w.tabs.find(t => t.id === w.activeId); }
function tabByContents(wc) { return allTabs().find(t => t.view.webContents === wc); }
function uiSend(w, channel, data) { if (w && w.ui && !w.ui.webContents.isDestroyed()) w.ui.webContents.send(channel, data); }
function uiSendAll(channel, data) { for (const w of windows) uiSend(w, channel, data); }

function currentWindow() {
  if (lastFocused && windows.has(lastFocused)) return lastFocused;
  return [...windows][0] || null;
}
function normalWindow(create = true) {
  const cur = currentWindow();
  if (cur && !cur.incognito) return cur;
  const any = [...windows].reverse().find(w => !w.incognito);
  if (any) return any;
  return create ? createWindow({ urls: [] }) : null;
}
function incognitoWindow(create = true) {
  const cur = currentWindow();
  if (cur && cur.incognito) return cur;
  const any = [...windows].reverse().find(w => w.incognito);
  if (any) return any;
  return create ? createWindow({ incognito: true, urls: [] }) : null;
}

function tabUrl(t) {
  const u = t.view.webContents.getURL();
  if (t.failedUrl && (!u || u.startsWith('data:'))) return t.failedUrl;
  return u || t.initialUrl || '';
}

function originOf(url) { try { return new URL(url).origin; } catch { return url; } }
function hostOf(url) { try { return new URL(url).host || url; } catch { return url; } }
function isSearchResult(url) {
  return Object.values(ENGINES).some(e => url.startsWith(e.url.split('%s')[0]));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- built-in pages (cloud://) ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function handleCloudRequest(req) {
  const u = new URL(req.url);
  const rel = (u.pathname === '/' || u.pathname === '') ? `${u.hostname}.html` : decodeURIComponent(u.pathname.slice(1));
  const file = path.normalize(path.join(PAGES_DIR, rel));
  if (!file.startsWith(PAGES_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const body = fs.readFileSync(file);
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
  } catch {
    return new Response(`<!doctype html><title>Not found</title><p style="font-family:system-ui">No such page: ${escapeHtml(req.url)}</p>`,
      { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

// Settings & co. always open in a normal window, like Chrome.
function openInternal(fromWin, name, hash = '') {
  const w = (fromWin && !fromWin.incognito) ? fromWin : normalWindow();
  const base = `cloud://${name}/`;
  const existing = w.tabs.find(t => tabUrl(t).startsWith(base));
  if (existing) {
    switchTab(w, existing.id);
    if (hash) load(existing.view.webContents, base + hash);
  } else {
    createTab(w, base + hash);
  }
  w.win.focus();
}

function pagesSend(channel, data) {
  for (const t of allTabs()) {
    const wc = t.view.webContents;
    if (!wc.isDestroyed() && wc.getURL().startsWith('cloud://')) wc.send(channel, data);
  }
}

// ---------- state to the UI ----------

function sendState(w) {
  if (!w || w.stateQueued) return;
  w.stateQueued = true;
  setTimeout(() => { w.stateQueued = false; pushState(w); }, 16);
}
function sendStateAll() { for (const w of windows) sendState(w); }

function isBookmarked(url) { return !!url && bookmarks.data.items.some(b => b.url === url); }

function tabInfo(t) {
  const wc = t.view.webContents;
  const url = tabUrl(t);
  const isNewtab = url.startsWith(NEWTAB_URL);
  return {
    id: t.id,
    title: isNewtab ? (t.private ? 'New incognito tab' : 'New tab') : (wc.getTitle() || (url.startsWith('cloud://') ? '' : url) || 'New tab'),
    url,
    favicon: t.favicon || null,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    private: t.private,
    blocked: t.blocked,
    audible: wc.isCurrentlyAudible(),
    muted: wc.isAudioMuted(),
    bookmarked: isBookmarked(url),
  };
}

function downloadSummary() {
  const active = downloads.filter(d => d.state === 'progressing' || d.state === 'paused');
  const total = active.reduce((s, d) => s + (d.total || 0), 0);
  const received = active.reduce((s, d) => s + (d.received || 0), 0);
  return { show: downloadsThisRun > 0, active: active.length, progress: total ? received / total : null };
}

function pushState(w) {
  if (!windows.has(w) || !w.ui || w.ui.webContents.isDestroyed()) return;
  const t = activeTab(w);
  uiSend(w, 'state', {
    tabs: w.tabs.map(tabInfo),
    activeId: w.activeId,
    incognito: w.incognito,
    update: updateState,
    version: app.getVersion(),
    bookmarks: bookmarks.data.items.map(b => ({ id: b.id, url: b.url, title: b.title, favicon: b.favicon })),
    showBookmarksBar: settings.data.showBookmarksBar && !w.incognito,
    adblock: settings.data.adblock && !!blocker,
    downloads: downloadSummary(),
    engineName: engine().name,
    defaultBanner: !w.incognito && isDefaultBrowser === false && !settings.data.defaultPromptDismissed,
  });
  const title = t ? (tabInfo(t).title) : 'New tab';
  w.win.setTitle(`${title} — CloudBrowser${w.incognito ? ' (Incognito)' : ''}`);
}

// ---------- layout ----------

function layout(w) {
  if (!w || !w.win || w.win.isDestroyed()) return;
  const { width, height } = w.win.getContentBounds();
  const top = w.htmlFullscreen ? 0 : w.uiHeight;
  for (const t of w.tabs) t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  w.ui.setBounds({ x: 0, y: 0, width, height: w.htmlFullscreen ? 0 : (w.overlayOpen ? height : w.uiHeight) });
}

// ---------- windows ----------

function createWindow({ incognito = false, urls, active = 0 } = {}) {
  const saved = settings.data.window || {};
  const cur = currentWindow();
  const opts = {
    width: saved.width || 1280,
    height: saved.height || 820,
    minWidth: 520,
    minHeight: 320,
    title: incognito ? 'CloudBrowser (Incognito)' : 'CloudBrowser',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    backgroundColor: incognito ? '#1d1828' : (nativeTheme.shouldUseDarkColors ? '#1c2029' : '#e6edf7'),
    autoHideMenuBar: true,
  };
  if (cur && !cur.win.isDestroyed()) {
    const b = cur.win.getBounds();
    Object.assign(opts, { x: b.x + 30, y: b.y + 30, width: b.width, height: b.height });
  }
  const w = {
    id: nextWinId++, incognito, tabs: [], activeId: null, closedTabs: [],
    uiHeight: 84, overlayOpen: false, htmlFullscreen: false, userFullscreen: false, stateQueued: false,
  };
  w.win = new BaseWindow(opts);
  if (!cur && saved.maximized && !incognito) w.win.maximize();
  windows.add(w);
  lastFocused = w;
  if (!incognito) sessionFrozen = false;

  w.ui = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  w.ui.setBackgroundColor('#00000000');
  w.win.contentView.addChildView(w.ui);
  w.ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { incognito: incognito ? '1' : '0' } });
  w.ui.webContents.on('before-input-event', (event, input) => { if (handleShortcut(w, input)) event.preventDefault(); });
  if (SMOKE) {
    w.ui.webContents.on('console-message', (ev) => log('[ui console]', ev.message));
    w.ui.webContents.on('preload-error', (_e, p, err) => log('[ui preload-error]', p, String(err)));
  }
  w.ui.webContents.once('did-finish-load', () => {
    const list = urls && urls.length ? urls : [homeUrl()];
    list.forEach((u, i) => createTab(w, u, { activate: i === Math.min(active, list.length - 1) }));
    layout(w);
    pushState(w);
    if (tabUrl(activeTab(w)).startsWith(NEWTAB_URL)) focusAddress(w);
  });

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) w.win.on(ev, () => layout(w));
  w.win.on('focus', () => { lastFocused = w; checkDefaultBrowser(); });
  w.win.on('close', () => {
    if (!w.incognito) {
      const b = w.win.getNormalBounds();
      settings.data.window = { width: b.width, height: b.height, maximized: w.win.isMaximized() };
      settings.save();
      const othersNormal = [...windows].some(x => x !== w && !x.incognito);
      if (!quitting && !othersNormal) { saveSession(true); sessionFrozen = true; }
    }
  });
  w.win.on('closed', () => {
    for (const t of w.tabs) { try { t.view.webContents.close(); } catch {} }
    try { w.ui.webContents.close(); } catch {}
    w.tabs = [];
    windows.delete(w);
    if (lastFocused === w) lastFocused = null;
    if (!quitting && !sessionFrozen) saveSession();
    if (incognito && ![...windows].some(x => x.incognito)) {
      // Last incognito window closed: forget everything from that session.
      const s = session.fromPartition(PRIVATE_PARTITION);
      s.clearStorageData().catch(() => {});
      s.clearCache().catch(() => {});
      privatePermissions.clear();
    }
    if (windows.size === 0) { flushAll(); app.quit(); }
  });
  return w;
}

// ---------- tabs ----------

function createTab(w, url, { activate = true, openerId = null } = {}) {
  url = url || homeUrl();
  const view = new WebContentsView({
    webPreferences: {
      partition: w.incognito ? PRIVATE_PARTITION : NORMAL_PARTITION,
      preload: path.join(__dirname, 'preload-page.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });
  view.setBackgroundColor(w.incognito ? '#1d1828' : '#ffffff');
  const tab = { id: nextTabId++, w, view, private: w.incognito, favicon: null, blocked: 0, failedUrl: null, initialUrl: url, histEntry: null, lastInput: 0 };

  const openerIdx = openerId ? w.tabs.findIndex(t => t.id === openerId) : -1;
  if (openerIdx >= 0) {
    let i = openerIdx + 1;
    while (i < w.tabs.length && w.tabs[i].openerId === openerId) i++;
    tab.openerId = openerId;
    w.tabs.splice(i, 0, tab);
  } else {
    w.tabs.push(tab);
  }
  w.win.contentView.addChildView(view, 0); // below the UI view
  wireTab(tab);
  layout(w);

  load(view.webContents, url);
  if (activate || !w.activeId) switchTab(w, tab.id);
  else view.setVisible(false);
  sendState(w);
  saveSession();
  return tab;
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  const update = () => sendState(tab.w);

  wc.on('did-start-loading', update);
  wc.on('did-stop-loading', () => { update(); saveSession(); });
  wc.on('audio-state-changed', update);
  wc.on('page-title-updated', (_e, title) => {
    if (tab.histEntry && tab.histEntry.url === wc.getURL()) { tab.histEntry.title = title; history.save(); }
    update();
  });
  wc.on('did-navigate', (_e, url) => {
    if (!url.startsWith('data:')) tab.failedUrl = null;
    tab.blocked = 0;
    tab.favicon = null;
    recordHistory(tab, url);
    update();
    saveSession();
  });
  wc.on('did-navigate-in-page', (_e, _url, isMain) => { if (isMain) { update(); saveSession(); } });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0] || null;
    const b = bookmarks.data.items.find(x => x.url === wc.getURL());
    if (b && tab.favicon && b.favicon !== tab.favicon && !tab.private) { b.favicon = tab.favicon; bookmarks.save(); }
    update();
  });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted, normal when navigating away
    tab.failedUrl = failedUrl;
    load(wc, 'data:text/html;charset=utf-8,' + encodeURIComponent(errorPage("Can't reach this page", desc, failedUrl)));
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    const url = tabUrl(tab);
    tab.failedUrl = url;
    load(wc, 'data:text/html;charset=utf-8,' + encodeURIComponent(errorPage('This tab crashed', details.reason, url)));
  });
  wc.on('input-event', (_e, input) => {
    if (['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'touchStart', 'gestureTap'].includes(input.type)) tab.lastInput = Date.now();
  });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    // Pop-up blocker: sites may only open windows/tabs straight after you click or press a key.
    if (Date.now() - (tab.lastInput || 0) > 2000) {
      popupsBlocked++;
      tab.blocked++;
      log('Blocked pop-up', url);
      update();
      return { action: 'deny' };
    }
    if (disposition === 'new-window') {
      // A real popup (e.g. "Sign in with…"), which may need window.opener.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 700, autoHideMenuBar: true, icon: path.join(__dirname, 'ui', 'icon.png'),
          webPreferences: { partition: tab.private ? PRIVATE_PARTITION : NORMAL_PARTITION, sandbox: true, contextIsolation: true },
        },
      };
    }
    createTab(tab.w, url, { activate: disposition !== 'background-tab', openerId: tab.id });
    return { action: 'deny' };
  });
  wc.on('before-input-event', (event, input) => { if (handleShortcut(tab.w, input)) event.preventDefault(); });
  wc.on('context-menu', (_e, params) => showContextMenu(tab, params));
  wc.on('found-in-page', (_e, r) => { if (tab.id === tab.w.activeId) uiSend(tab.w, 'find-result', { active: r.activeMatchOrdinal, matches: r.matches }); });
  wc.on('zoom-changed', (_e, dir) => zoom(wc, dir === 'in' ? 0.5 : -0.5));
  wc.on('enter-html-full-screen', () => { tab.w.htmlFullscreen = true; tab.w.win.setFullScreen(true); layout(tab.w); });
  wc.on('leave-html-full-screen', () => { tab.w.htmlFullscreen = false; if (!tab.w.userFullscreen) tab.w.win.setFullScreen(false); layout(tab.w); });
  if (SMOKE) {
    wc.on('console-message', (ev) => { if (wc.getURL().startsWith('cloud://')) log('[page console]', ev.message); });
    wc.on('preload-error', (_e, p, err) => log('[preload-error]', p, String(err)));
  }
}

function errorPage(title, detail, url) {
  return `<!doctype html><html><head><title>${escapeHtml(title)}</title><meta name="color-scheme" content="light dark"></head>
  <body style="font-family:'Segoe UI',system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0">
  <div style="max-width:560px;text-align:center;padding:24px"><div style="font-size:64px">☁️</div>
  <h1 style="font-weight:600;margin:.2em 0">${escapeHtml(title)}</h1>
  <p style="opacity:.75;word-break:break-all">${escapeHtml(url)}</p><p style="opacity:.55">${escapeHtml(detail)}</p>
  <p><a href="${escapeHtml(url)}" style="display:inline-block;padding:9px 18px;border-radius:18px;background:#2f7de1;color:#fff;text-decoration:none">Try again</a></p>
  </div></body></html>`;
}

function switchTab(w, id) {
  const t = w.tabs.find(x => x.id === id);
  if (!t) return;
  if (w.activeId && w.activeId !== id) {
    const prev = activeTab(w);
    if (prev) prev.view.webContents.stopFindInPage('clearSelection');
    uiSend(w, 'find-close');
  }
  w.activeId = id;
  for (const x of w.tabs) x.view.setVisible(x.id === id);
  if (!w.overlayOpen) t.view.webContents.focus();
  sendState(w);
  saveSession();
}

function closeTab(id) {
  const t = getTab(id);
  if (!t) return;
  const w = t.w;
  const idx = w.tabs.indexOf(t);
  w.tabs.splice(idx, 1);
  const url = tabUrl(t);
  if (url && !url.startsWith('data:')) {
    w.closedTabs.push(url);
    if (w.closedTabs.length > 25) w.closedTabs.shift();
  }
  w.win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (w.tabs.length === 0) { w.win.close(); return; }
  if (w.activeId === id) {
    const opener = t.openerId && w.tabs.find(x => x.id === t.openerId);
    switchTab(w, opener ? opener.id : w.tabs[Math.min(idx, w.tabs.length - 1)].id);
  } else {
    sendState(w);
  }
  saveSession();
}

function reopenClosedTab(w) {
  const url = w.closedTabs.pop();
  if (url) createTab(w, url);
}

function cycleTab(w, dir) {
  if (!w.tabs.length) return;
  const idx = w.tabs.findIndex(t => t.id === w.activeId);
  switchTab(w, w.tabs[(idx + dir + w.tabs.length) % w.tabs.length].id);
}

function zoom(wc, delta) {
  if (!wc) return;
  const level = delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
}

function setFullscreen(w, on) {
  w.userFullscreen = on;
  w.win.setFullScreen(on);
}

function openInIncognito(url) {
  const w = incognitoWindow(false);
  if (w) { createTab(w, url); w.win.focus(); }
  else createWindow({ incognito: true, urls: [url] });
}

function newWindow(incognito) {
  return createWindow({ incognito, urls: [homeUrl()] });
}

// ---------- history, bookmarks, session ----------

function recordHistory(tab, url) {
  tab.histEntry = null;
  if (tab.private || !/^https?:/i.test(url)) return;
  const items = history.data.items;
  const entry = { url, title: tab.view.webContents.getTitle() || url, time: Date.now() };
  items.unshift(entry);
  if (items.length > 5000) items.length = 5000;
  tab.histEntry = entry;
  history.save();
}

function stripScheme(url) { return url.replace(/^https?:\/\/(www\.)?/i, ''); }

function suggest(q, incognito) {
  q = (q || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const seen = new Set();
  const hit = s => !!s && s.toLowerCase().includes(q);

  for (const b of bookmarks.data.items) {
    if ((hit(b.title) || hit(stripScheme(b.url))) && !seen.has(b.url)) {
      seen.add(b.url);
      out.push({ type: 'bookmark', url: b.url, title: b.title });
      if (out.length >= 3) break;
    }
  }
  if (incognito) return out;
  const scores = new Map();
  for (const h of history.data.items) {
    if (seen.has(h.url) || isSearchResult(h.url)) continue;
    const bare = stripScheme(h.url);
    if (!(hit(h.title) || hit(bare))) continue;
    const s = scores.get(h.url);
    if (s) s.count++;
    else scores.set(h.url, { url: h.url, title: h.title, count: 1, time: h.time, prefix: bare.toLowerCase().startsWith(q) ? 1 : 0 });
  }
  const ranked = [...scores.values()].sort((a, b) => (b.prefix - a.prefix) || (b.count - a.count) || (b.time - a.time));
  for (const s of ranked) {
    out.push({ type: 'history', url: s.url, title: s.title });
    if (out.length >= 8) break;
  }
  return out;
}

function topSites() {
  const hidden = new Set(settings.data.hiddenSites || []);
  const byHost = new Map();
  const since = Date.now() - 60 * 86400000;
  for (const h of history.data.items) {
    if (h.time < since || isSearchResult(h.url)) continue;
    let u;
    try { u = new URL(h.url); } catch { continue; }
    const host = u.host.replace(/^www\./, '');
    if (hidden.has(host)) continue;
    const e = byHost.get(host);
    if (e) e.count++;
    else byHost.set(host, { host, url: `${u.protocol}//${u.host}/`, title: (h.title || host), count: 1 });
  }
  const list = [...byHost.values()].filter(e => e.count >= 2).sort((a, b) => b.count - a.count).slice(0, 8)
    .map(e => ({ url: e.url, title: shortTitle(e.title, e.host), host: e.host }));
  for (const d of DEFAULT_SITES) {
    if (list.length >= 8) break;
    const host = hostOf(d.url).replace(/^www\./, '');
    if (hidden.has(host) || list.some(x => x.host === host)) continue;
    list.push({ url: d.url, title: d.title, host });
  }
  return list;
}

function shortTitle(title, host) {
  // "Some Page - YouTube" -> "YouTube"; fall back to the site name.
  const parts = String(title).split(/\s+[-–—|·]\s+/);
  const last = parts[parts.length - 1].trim();
  if (parts.length > 1 && last.length <= 24) return last;
  if (title.length <= 24) return title;
  const name = host.split('.').slice(-2, -1)[0] || host;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function toggleBookmark(tab) {
  if (!tab) return;
  const url = tabUrl(tab);
  if (!/^(https?|cloud|file):/i.test(url) || url.startsWith(NEWTAB_URL)) return;
  const items = bookmarks.data.items;
  const i = items.findIndex(b => b.url === url);
  if (i >= 0) items.splice(i, 1);
  else items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url, title: tab.view.webContents.getTitle() || hostOf(url), favicon: tab.private ? null : tab.favicon, added: Date.now() });
  bookmarks.save();
  sendStateAll();
  pagesSend('page:bookmarks', bookmarks.data.items);
}

function saveSession(final = false) {
  if (!sessionStore || (quitting && !final) || (sessionFrozen && !final)) return;
  const wins = [...windows].filter(w => !w.incognito && w.tabs.length).map(w => ({
    tabs: w.tabs.map(tabUrl).filter(u => u && !u.startsWith('data:')),
    active: Math.max(0, w.tabs.findIndex(t => t.id === w.activeId)),
  })).filter(x => x.tabs.length);
  if (!wins.length && sessionFrozen) return;
  sessionStore.data = { windows: wins };
  if (final) sessionStore.flush(); else sessionStore.save();
}

function startWindows(startUrl) {
  let wins = sessionStore.data.windows;
  if (!wins && Array.isArray(sessionStore.data.tabs)) wins = [{ tabs: sessionStore.data.tabs, active: sessionStore.data.active || 0 }]; // 1.1 format
  if (settings.data.restoreTabs && Array.isArray(wins) && wins.length) {
    wins.forEach((x, i) => {
      const urls = [...x.tabs];
      let active = x.active;
      if (startUrl && i === wins.length - 1) { urls.push(startUrl); active = urls.length - 1; }
      createWindow({ urls, active });
    });
  } else {
    createWindow({ urls: [startUrl || homeUrl()] });
  }
}

// ---------- downloads ----------

function uniquePath(p) {
  const taken = new Set([...liveDownloads.values()].map(i => i.getSavePath()));
  if (!fs.existsSync(p) && !taken.has(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 1; i < 10000; i++) {
    const c = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(c) && !taken.has(c)) return c;
  }
  return p;
}

function persistDownloads() {
  downloadStore.data.items = downloads.filter(d => !d.private).slice(0, 300);
  downloadStore.save();
}

function notifyDownloads() {
  sendStateAll();
  pagesSend('page:downloads', downloads);
}

function setupDownloads(sess, isPrivate) {
  sess.on('will-download', (_e, item) => {
    const id = nextDownloadId++;
    if (!settings.data.askDownloadLocation) {
      item.setSavePath(uniquePath(path.join(app.getPath('downloads'), item.getFilename())));
    }
    const d = {
      id, filename: item.getFilename(), url: item.getURL(), path: item.getSavePath() || '',
      state: 'progressing', received: 0, total: item.getTotalBytes(), time: Date.now(), private: isPrivate,
    };
    downloads.unshift(d);
    liveDownloads.set(id, item);
    downloadsThisRun++;

    item.on('updated', (_ev, state) => {
      d.state = state === 'interrupted' ? 'interrupted' : (item.isPaused() ? 'paused' : 'progressing');
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.path = item.getSavePath() || d.path;
      if (d.path) d.filename = path.basename(d.path);
      notifyDownloads();
    });
    item.once('done', (_ev, state) => {
      d.state = state; // completed | cancelled | interrupted
      d.received = item.getReceivedBytes();
      d.path = item.getSavePath() || d.path;
      if (d.path) d.filename = path.basename(d.path);
      liveDownloads.delete(id);
      persistDownloads();
      notifyDownloads();
      if (state === 'completed') uiSendAll('download-done', { filename: d.filename });
    });
    persistDownloads();
    notifyDownloads();
  });
}

function downloadAction(id, action) {
  const d = downloads.find(x => x.id === id);
  if (!d) return;
  const item = liveDownloads.get(id);
  switch (action) {
    case 'open': if (d.path) shell.openPath(d.path); break;
    case 'show': if (d.path) shell.showItemInFolder(d.path); break;
    case 'pause': item && item.pause(); break;
    case 'resume': item && item.canResume() && item.resume(); break;
    case 'cancel': item && item.cancel(); break;
    case 'retry': session.fromPartition(d.private ? PRIVATE_PARTITION : NORMAL_PARTITION).downloadURL(d.url); break;
    case 'remove':
      if (item) item.cancel();
      downloads = downloads.filter(x => x.id !== id);
      persistDownloads(); notifyDownloads();
      break;
  }
}

// ---------- permissions ----------

function setupPermissions(sess, isPrivate) {
  const saved = (origin) => (isPrivate ? privatePermissions.get(origin) : permissions.data.sites[origin]) || {};

  sess.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    try {
      if (AUTO_ALLOW.has(permission)) return callback(true);
      if (!PROMPT_PERMISSIONS[permission] || SILENT_DENY.has(permission)) return callback(false);
      const origin = originOf(details.requestingUrl || wc.getURL());
      // Like Chrome, don't let ads and other embedded frames from another site ask.
      if (details.isMainFrame === false && origin !== originOf(wc.getURL())) return callback(false);
      const prior = saved(origin)[permission];
      if (prior) return callback(prior === 'allow');

      let what = PROMPT_PERMISSIONS[permission];
      if (permission === 'media' && Array.isArray(details.mediaTypes)) {
        const v = details.mediaTypes.includes('video'), a = details.mediaTypes.includes('audio');
        what = v && a ? 'use your camera and microphone' : v ? 'use your camera' : a ? 'use your microphone' : what;
      }
      if (permission === 'openExternal' && details.externalURL) {
        what = `open “${details.externalURL.split(':')[0]}” links in another app`;
      }
      const t = tabByContents(wc);
      if (t && t.id !== t.w.activeId) switchTab(t.w, t.id);
      const parent = (t && t.w.win) || (currentWindow() && currentWindow().win);
      const res = await dialog.showMessageBox(parent, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'CloudBrowser',
        message: `${hostOf(origin)} wants to ${what}`,
        checkboxLabel: 'Remember my choice for this site',
        checkboxChecked: true,
      });
      const allow = res.response === 0;
      if (res.checkboxChecked) {
        if (isPrivate) {
          privatePermissions.set(origin, { ...saved(origin), [permission]: allow ? 'allow' : 'block' });
        } else {
          permissions.data.sites[origin] = { ...saved(origin), [permission]: allow ? 'allow' : 'block' };
          permissions.save();
        }
      }
      callback(allow);
    } catch (e) {
      log('permission handler error', e.message);
      callback(false);
    }
  });

  sess.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (AUTO_ALLOW.has(permission)) return true;
    if (PROMPT_PERMISSIONS[permission]) return saved(originOf(requestingOrigin))[permission] === 'allow';
    return true; // other internal checks keep Electron's default
  });
}

// ---------- ad & tracker blocking ----------

async function setupAdblock() {
  let mod;
  try { mod = require('@ghostery/adblocker-electron'); } catch (e) { log('Ad blocker unavailable:', e.message); return; }
  try {
    const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
    blocker = await mod.ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache, read: fs.promises.readFile, write: fs.promises.writeFile,
    });
    // The blocker's page-cleanup part registers app-wide handlers that can only exist once,
    // so incognito gets a copy that does network blocking only.
    privateBlocker = mod.ElectronBlocker.deserialize(blocker.serialize());
    privateBlocker.config.loadCosmeticFilters = false;
    for (const b of [blocker, privateBlocker]) {
      b.on('request-blocked', (request) => {
        const t = allTabs().find(x => !x.view.webContents.isDestroyed() && x.view.webContents.id === request.tabId);
        if (t) { t.blocked++; sendState(t.w); }
        settings.data.blockedTotal = (settings.data.blockedTotal || 0) + 1;
        settings.save();
      });
    }
    applyAdblock();
    log('Ad blocker ready');
  } catch (e) {
    blocker = null;
    log('Ad blocker failed to start:', e && e.stack || e);
  }
  sendStateAll();
}

function applyAdblock() {
  if (!blocker) return;
  for (const [p, b] of [[NORMAL_PARTITION, blocker], [PRIVATE_PARTITION, privateBlocker]]) {
    if (!b) continue;
    const s = session.fromPartition(p);
    try {
      if (settings.data.adblock && !blockingOn.has(p)) { b.enableBlockingInSession(s); blockingOn.add(p); }
      else if (!settings.data.adblock && blockingOn.has(p)) { b.disableBlockingInSession(s); blockingOn.delete(p); }
    } catch (e) {
      log('Ad blocker session error', p, e.message);
    }
  }
}

// ---------- default browser (Windows) ----------

function reg(args) {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Tells Windows that CloudBrowser is a web browser, so it can be picked under
// Settings > Apps > Default apps, and so links and .html files can open in it.
async function registerAsBrowser() {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  const exe = process.execPath;
  const icon = `${exe},0`;
  const C = `HKCU\\Software\\Classes\\${PROG_ID}`;
  const S = 'HKCU\\Software\\Clients\\StartMenuInternet\\CloudBrowser';
  const entries = [
    [C, '', 'CloudBrowser HTML Document'],
    [C, 'AppUserModelId', 'com.cloudbrowser.app'],
    [`${C}\\Application`, 'ApplicationName', 'CloudBrowser'],
    [`${C}\\Application`, 'ApplicationIcon', icon],
    [`${C}\\Application`, 'AppUserModelId', 'com.cloudbrowser.app'],
    [`${C}\\DefaultIcon`, '', icon],
    [`${C}\\shell\\open\\command`, '', `"${exe}" "%1"`],
    [S, '', 'CloudBrowser'],
    [`${S}\\DefaultIcon`, '', icon],
    [`${S}\\shell\\open\\command`, '', `"${exe}"`],
    [`${S}\\Capabilities`, 'ApplicationName', 'CloudBrowser'],
    [`${S}\\Capabilities`, 'ApplicationDescription', 'A lightweight, private web browser that searches with DuckDuckGo.'],
    [`${S}\\Capabilities`, 'ApplicationIcon', icon],
    [`${S}\\Capabilities\\StartMenu`, 'StartMenuInternet', 'CloudBrowser'],
    ...['http', 'https'].map(p => [`${S}\\Capabilities\\URLAssociations`, p, PROG_ID]),
    ...['.htm', '.html', '.shtml', '.xht', '.xhtml', '.svg', '.webp', '.pdf'].map(e => [`${S}\\Capabilities\\FileAssociations`, e, PROG_ID]),
    ['HKCU\\Software\\RegisteredApplications', 'CloudBrowser', 'Software\\Clients\\StartMenuInternet\\CloudBrowser\\Capabilities'],
  ];
  let ok = true;
  for (const [key, name, value] of entries) {
    const args = ['add', key, ...(name ? ['/v', name] : ['/ve']), '/t', 'REG_SZ', '/d', value, '/f'];
    if ((await reg(args)) === null) { ok = false; log('Registry write failed', key, name); }
  }
  return ok;
}

let defaultCheckAt = 0;
async function checkDefaultBrowser(force = false) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  if (!force && Date.now() - defaultCheckAt < 3000) return;
  defaultCheckAt = Date.now();
  const out = await reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
  const now = !!out && out.includes(PROG_ID);
  if (now !== isDefaultBrowser) {
    isDefaultBrowser = now;
    sendStateAll();
    pagesSend('page:default-browser', isDefaultBrowser);
  }
}

async function makeDefaultBrowser() {
  await registerAsBrowser();
  // Windows only lets the user choose the default browser, so take them to the right page.
  shell.openExternal('ms-settings:defaultapps?registeredAppUser=CloudBrowser').catch(() => shell.openExternal('ms-settings:defaultapps'));
}

// ---------- keyboard shortcuts ----------

function handleShortcut(w, input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const shift = input.shift;
  const key = (input.key || '').toLowerCase();
  const t = activeTab(w);
  const wc = t && t.view.webContents;

  if (ctrl && !shift && key === 't') { createTab(w); focusAddress(w); return true; }
  if (ctrl && shift && key === 't') { reopenClosedTab(w); return true; }
  if (ctrl && !shift && key === 'n') { newWindow(false); return true; }
  if (ctrl && shift && key === 'n') { newWindow(true); return true; }
  if (ctrl && (key === 'w' || key === 'f4')) { if (t) closeTab(t.id); return true; }
  if (ctrl && shift && key === 'w') { w.win.close(); return true; }
  if (ctrl && key === 'l') { focusAddress(w); return true; }
  if (input.alt && key === 'd') { focusAddress(w); return true; }
  if ((ctrl && key === 'r') || key === 'f5') { if (wc) (shift ? wc.reloadIgnoringCache() : wc.reload()); return true; }
  if (ctrl && key === 'tab') { cycleTab(w, shift ? -1 : 1); return true; }
  if (ctrl && key === 'pagedown') { cycleTab(w, 1); return true; }
  if (ctrl && key === 'pageup') { cycleTab(w, -1); return true; }
  if (ctrl && /^[1-9]$/.test(key)) { const n = Number(key); const target = n === 9 ? w.tabs[w.tabs.length - 1] : w.tabs[n - 1]; if (target) switchTab(w, target.id); return true; }
  if (ctrl && !shift && key === 'p') { wc && wc.print(); return true; }
  if (ctrl && !shift && key === 'd') { toggleBookmark(t); return true; }
  if (ctrl && shift && key === 'b') { setSetting('showBookmarksBar', !settings.data.showBookmarksBar); return true; }
  if (ctrl && shift && key === 'o') { openInternal(w, 'bookmarks'); return true; }
  if (ctrl && key === 'h') { openInternal(w, 'history'); return true; }
  if (ctrl && key === 'j') { openInternal(w, 'downloads'); return true; }
  if (ctrl && shift && key === 'delete') { openInternal(w, 'settings', '#privacy'); return true; }
  if (ctrl && key === ',') { openInternal(w, 'settings'); return true; }
  if (ctrl && (key === 'f' || key === 'g')) {
    if (key === 'g') uiSend(w, 'find-next', { forward: !shift }); else uiSend(w, 'find-open');
    if (key === 'f') w.ui.webContents.focus();
    return true;
  }
  if (key === 'f3') { uiSend(w, 'find-next', { forward: !shift }); return true; }
  if (input.alt && key === 'arrowleft') { wc && wc.navigationHistory.goBack(); return true; }
  if (input.alt && key === 'arrowright') { wc && wc.navigationHistory.goForward(); return true; }
  if (input.alt && key === 'home') { wc && load(wc, homeUrl()); return true; }
  if (ctrl && (key === '=' || key === '+')) { zoom(wc, 0.5); return true; }
  if (ctrl && key === '-') { zoom(wc, -0.5); return true; }
  if (ctrl && key === '0') { zoom(wc, 0); return true; }
  if (key === 'f11') { setFullscreen(w, !w.win.isFullScreen()); return true; }
  if (key === 'f12' || (ctrl && shift && key === 'i')) { wc && wc.toggleDevTools(); return true; }
  if (ctrl && key === 'u') { const u = wc && tabUrl(t); if (u && /^https?:/.test(u)) createTab(w, 'view-source:' + u, { openerId: t.id }); return true; }
  if (key === 'escape' && wc && wc.isLoading() && !w.ui.webContents.isFocused()) { wc.stop(); return false; }
  return false;
}

function focusAddress(w) {
  if (!w || !w.ui) return;
  w.ui.webContents.focus();
  uiSend(w, 'focus-address');
}

// ---------- menus ----------

function showContextMenu(tab, p) {
  const wc = tab.view.webContents;
  const w = tab.w;
  const t = [];
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };
  const newTab = (url) => createTab(w, url, { activate: false, openerId: tab.id });

  if (p.misspelledWord) {
    for (const s of (p.dictionarySuggestions || []).slice(0, 5)) t.push({ label: s, click: () => wc.replaceMisspelling(s) });
    if (!p.dictionarySuggestions || !p.dictionarySuggestions.length) t.push({ label: 'No spelling suggestions', enabled: false });
    t.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }
  if (p.linkURL) {
    const isHttp = /^https?:/i.test(p.linkURL);
    if (isHttp) {
      t.push({ label: 'Open link in new tab', click: () => newTab(p.linkURL) });
      t.push({ label: 'Open link in new window', click: () => createWindow({ incognito: w.incognito, urls: [p.linkURL] }) });
      if (!w.incognito) t.push({ label: 'Open link in incognito window', click: () => openInIncognito(p.linkURL) });
    }
    t.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) });
    if (isHttp) t.push({ label: 'Save link as…', click: () => wc.downloadURL(p.linkURL) });
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    t.push({ label: 'Open image in new tab', click: () => newTab(p.srcURL) });
    t.push({ label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) });
    t.push({ label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) });
    t.push({ label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) });
    sep();
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && /^https?:/i.test(p.srcURL)) {
    t.push({ label: `Open ${p.mediaType} in new tab`, click: () => newTab(p.srcURL) });
    t.push({ label: `Save ${p.mediaType} as…`, click: () => wc.downloadURL(p.srcURL) });
    sep();
  }
  if (p.isEditable) {
    const f = p.editFlags || {};
    t.push({ role: 'undo', enabled: !!f.canUndo }, { role: 'redo', enabled: !!f.canRedo });
    sep();
    t.push({ role: 'cut', enabled: !!f.canCut }, { role: 'copy', enabled: !!f.canCopy },
      { role: 'paste', enabled: !!f.canPaste }, { role: 'selectAll' });
    sep();
  } else if (p.selectionText && p.selectionText.trim()) {
    const s = p.selectionText.trim().replace(/\s+/g, ' ');
    const short = s.length > 32 ? s.slice(0, 32) + '…' : s;
    t.push({ role: 'copy' });
    t.push({ label: `Search ${engine().name} for “${short}”`, click: () => createTab(w, searchUrl(s), { openerId: tab.id }) });
    sep();
  }
  if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !(p.selectionText || '').trim()) {
    t.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    t.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    t.push({ label: 'Reload', click: () => wc.reload() });
    sep();
    t.push({ label: isBookmarked(tabUrl(tab)) ? 'Remove bookmark' : 'Bookmark this page', click: () => toggleBookmark(tab) });
    t.push({ label: 'Save page as…', click: () => savePage(w, wc) });
    t.push({ label: 'Print…', click: () => wc.print() });
    t.push({ label: 'View page source', enabled: /^https?:/.test(tabUrl(tab)), click: () => createTab(w, 'view-source:' + tabUrl(tab), { openerId: tab.id }) });
    sep();
  }
  t.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(t).popup({ window: w.win });
}

async function savePage(w, wc) {
  const name = (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'page';
  const { canceled, filePath } = await dialog.showSaveDialog(w.win, {
    defaultPath: path.join(app.getPath('downloads'), name + '.html'),
    filters: [{ name: 'Web page', extensions: ['html'] }],
  });
  if (!canceled && filePath) wc.savePage(filePath, 'HTMLComplete').catch(e => log('save page failed', e.message));
}

function showMainMenu(w) {
  const t = activeTab(w);
  const wc = t && t.view.webContents;
  const zoomPct = wc ? Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100) : 100;
  Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => { createTab(w); focusAddress(w); } },
    { label: 'New window', accelerator: 'Ctrl+N', click: () => newWindow(false) },
    { label: 'New incognito window', accelerator: 'Ctrl+Shift+N', click: () => newWindow(true) },
    { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: w.closedTabs.length > 0, click: () => reopenClosedTab(w) },
    { type: 'separator' },
    { label: 'History', accelerator: 'Ctrl+H', click: () => openInternal(w, 'history') },
    { label: 'Downloads', accelerator: 'Ctrl+J', click: () => openInternal(w, 'downloads') },
    { label: 'Bookmarks', accelerator: 'Ctrl+Shift+O', click: () => openInternal(w, 'bookmarks') },
    { label: 'Show bookmarks bar', type: 'checkbox', checked: settings.data.showBookmarksBar, accelerator: 'Ctrl+Shift+B',
      click: () => setSetting('showBookmarksBar', !settings.data.showBookmarksBar) },
    { type: 'separator' },
    { label: `Zoom (${zoomPct}%)`, submenu: [
      { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => zoom(wc, 0.5) },
      { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => zoom(wc, -0.5) },
      { label: 'Reset', accelerator: 'Ctrl+0', click: () => zoom(wc, 0) },
    ] },
    { label: 'Find on page…', accelerator: 'Ctrl+F', click: () => { uiSend(w, 'find-open'); w.ui.webContents.focus(); } },
    { label: 'Print…', accelerator: 'Ctrl+P', enabled: !!wc, click: () => wc.print() },
    { label: 'Save page as…', enabled: !!wc, click: () => savePage(w, wc) },
    { label: 'Full screen', accelerator: 'F11', click: () => setFullscreen(w, !w.win.isFullScreen()) },
    { type: 'separator' },
    { label: 'Settings', accelerator: 'Ctrl+,', click: () => openInternal(w, 'settings') },
    { label: 'Clear browsing data…', accelerator: 'Ctrl+Shift+Delete', click: () => openInternal(w, 'settings', '#privacy') },
    ...(isDefaultBrowser === false ? [{ label: 'Make CloudBrowser the default browser…', click: makeDefaultBrowser }] : []),
    { label: 'Check for updates', click: checkForUpdates },
    { label: 'About CloudBrowser', click: () => openInternal(w, 'settings', '#about') },
    { type: 'separator' },
    { label: w.incognito ? 'Close incognito window' : 'Close window', accelerator: 'Ctrl+Shift+W', click: () => w.win.close() },
    { label: 'Exit', click: quitApp },
  ]).popup({ window: w.win });
}

function showTabMenu(w, id) {
  const t = w.tabs.find(x => x.id === id);
  if (!t) return;
  const idx = w.tabs.indexOf(t);
  const wc = t.view.webContents;
  Menu.buildFromTemplate([
    { label: 'New tab', click: () => createTab(w) },
    { type: 'separator' },
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Duplicate', click: () => createTab(w, tabUrl(t), { openerId: t.id }) },
    { label: 'Move to new window', enabled: w.tabs.length > 1, click: () => { const u = tabUrl(t); closeTab(id); createWindow({ incognito: w.incognito, urls: [u] }); } },
    { label: wc.isAudioMuted() ? 'Unmute site' : 'Mute site', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); sendState(w); } },
    { label: isBookmarked(tabUrl(t)) ? 'Remove bookmark' : 'Bookmark tab', click: () => toggleBookmark(t) },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(id) },
    { label: 'Close other tabs', enabled: w.tabs.length > 1, click: () => w.tabs.filter(x => x.id !== id).map(x => x.id).forEach(closeTab) },
    { label: 'Close tabs to the right', enabled: idx < w.tabs.length - 1, click: () => w.tabs.slice(idx + 1).map(x => x.id).forEach(closeTab) },
    { label: 'Reopen closed tab', enabled: w.closedTabs.length > 0, click: () => reopenClosedTab(w) },
  ]).popup({ window: w.win });
}

function showBookmarkMenu(w, id) {
  const b = bookmarks.data.items.find(x => x.id === id);
  if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => { const t = activeTab(w); if (t) load(t.view.webContents, b.url); } },
    { label: 'Open in new tab', click: () => createTab(w, b.url, { activate: false }) },
    { label: 'Open in new window', click: () => createWindow({ urls: [b.url] }) },
    { label: 'Open in incognito window', click: () => openInIncognito(b.url) },
    { type: 'separator' },
    { label: 'Edit…', click: () => openInternal(w, 'bookmarks') },
    { label: 'Delete', click: () => {
      bookmarks.data.items = bookmarks.data.items.filter(x => x.id !== id);
      bookmarks.save(); sendStateAll(); pagesSend('page:bookmarks', bookmarks.data.items);
    } },
  ]).popup({ window: w.win });
}

function quitApp() {
  quitting = true;
  saveSession(true);
  for (const w of [...windows]) w.win.close();
}

// ---------- settings ----------

function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS) || INTERNAL_SETTINGS.has(key)) return false;
  if (typeof value !== typeof DEFAULT_SETTINGS[key]) return false;
  if (key === 'searchEngine' && !ENGINES[value]) return false;
  if (key === 'theme' && !['system', 'light', 'dark'].includes(value)) return false;
  if (key === 'homePage') value = toUrl(value);
  settings.data[key] = value;
  settings.save();
  if (key === 'theme') nativeTheme.themeSource = value;
  if (key === 'adblock') applyAdblock();
  sendStateAll();
  pagesSend('page:settings', settings.data);
  return true;
}

async function clearData(opts = {}) {
  const s = session.fromPartition(NORMAL_PARTITION);
  if (opts.history) { history.data.items = []; history.save(); for (const t of allTabs()) t.histEntry = null; for (const w of windows) if (!w.incognito) w.closedTabs = []; }
  if (opts.cookies) await s.clearStorageData();
  if (opts.cache) { await s.clearCache(); await s.clearHostResolverCache(); }
  if (opts.downloads) { downloads = downloads.filter(d => liveDownloads.has(d.id)); persistDownloads(); notifyDownloads(); }
  if (opts.permissions) { permissions.data.sites = {}; permissions.save(); }
  sendStateAll();
  return true;
}

// ---------- auto-update ----------

function setUpdate(status, extra = {}) {
  updateState = { status, ...extra };
  sendStateAll();
  pagesSend('page:update', updateState);
}

function checkForUpdates() {
  if (!autoUpdater || !app.isPackaged) { setUpdate('error', { message: 'Updates only work in the installed app.' }); return; }
  autoUpdater.checkForUpdates().catch(e => setUpdate('error', { message: String(e && e.message || e) }));
}

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate('checking'));
  autoUpdater.on('update-available', info => setUpdate('downloading', { version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => setUpdate('downloading', { ...updateState, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => setUpdate('ready', { version: info.version }));
  autoUpdater.on('update-not-available', () => setUpdate('none', { checked: Date.now() }));
  autoUpdater.on('error', err => setUpdate('error', { message: String(err && err.message || err) }));
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ---------- IPC: browser UI ----------

function uiOn(channel, fn) {
  ipcMain.on('ui:' + channel, (e, ...args) => {
    const w = [...windows].find(x => x.ui && x.ui.webContents === e.sender);
    if (w) fn(w, ...args);
  });
}

function openUrl(w, url, newTab) {
  const t = activeTab(w);
  if (newTab || !t) { createTab(w, url); return; }
  load(t.view.webContents, url);
  t.view.webContents.focus();
}

uiOn('new-tab', w => { createTab(w); focusAddress(w); });
uiOn('new-incognito', () => newWindow(true));
uiOn('close-tab', (_w, id) => closeTab(id));
uiOn('switch-tab', (w, id) => switchTab(w, id));
uiOn('tab-menu', (w, id) => showTabMenu(w, id));
uiOn('toggle-mute', (w, id) => { const t = getTab(id); if (t) { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); sendState(w); } });
uiOn('navigate', (w, text, newTab) => openUrl(w, toUrl(text), newTab));
uiOn('search', (w, text, newTab) => openUrl(w, searchUrl(String(text || '').trim()), newTab));
uiOn('back', w => activeTab(w)?.view.webContents.navigationHistory.goBack());
uiOn('forward', w => activeTab(w)?.view.webContents.navigationHistory.goForward());
uiOn('reload', w => activeTab(w)?.view.webContents.reload());
uiOn('stop', w => activeTab(w)?.view.webContents.stop());
uiOn('home', w => { const t = activeTab(w); if (t) load(t.view.webContents, homeUrl()); });
uiOn('install-update', () => autoUpdater && autoUpdater.quitAndInstall());
uiOn('menu', w => showMainMenu(w));
uiOn('toggle-bookmark', w => toggleBookmark(activeTab(w)));
uiOn('open-bookmark', (w, url, newTab) => {
  const t = activeTab(w);
  if (newTab || !t) createTab(w, url, { activate: !newTab });
  else { load(t.view.webContents, url); t.view.webContents.focus(); }
});
uiOn('bookmark-menu', (w, id) => showBookmarkMenu(w, id));
uiOn('open-internal', (w, name, hash) => { if (INTERNAL_PAGES.includes(name)) openInternal(w, name, hash || ''); });
uiOn('find', (w, text, opts) => {
  const wc = activeTab(w)?.view.webContents;
  if (!wc) return;
  if (!text) { wc.stopFindInPage('clearSelection'); uiSend(w, 'find-result', { active: 0, matches: 0 }); return; }
  wc.findInPage(String(text), { forward: opts?.forward !== false, findNext: !!opts?.newSearch });
});
uiOn('find-stop', w => { const wc = activeTab(w)?.view.webContents; if (wc) { wc.stopFindInPage('keepSelection'); wc.focus(); } });
uiOn('height', (w, h) => { const n = Math.round(Number(h)); if (n > 0 && n < 400 && n !== w.uiHeight) { w.uiHeight = n; layout(w); } });
uiOn('overlay', (w, open) => {
  w.overlayOpen = !!open;
  layout(w);
  if (!w.overlayOpen && !w.ui.webContents.isFocused()) activeTab(w)?.view.webContents.focus();
});
uiOn('focus-page', w => activeTab(w)?.view.webContents.focus());
uiOn('make-default', () => makeDefaultBrowser());
uiOn('dismiss-default', () => { settings.data.defaultPromptDismissed = true; settings.save(); sendStateAll(); });
ipcMain.handle('ui:suggest', (e, q) => {
  const w = [...windows].find(x => x.ui && x.ui.webContents === e.sender);
  return w ? suggest(q, w.incognito) : [];
});

// ---------- IPC: built-in pages ----------

function pageHandle(channel, fn) {
  ipcMain.handle('page:' + channel, (e, ...args) => {
    const url = e.senderFrame && e.senderFrame.url;
    if (!url || !url.startsWith('cloud://')) throw new Error('Not allowed');
    return fn({ tab: tabByContents(e.sender) }, ...args);
  });
}

pageHandle('info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, home: e.home })),
  settings: settings.data,
  adblockAvailable: !!blocker,
  update: updateState,
  packaged: app.isPackaged,
  downloadsFolder: app.getPath('downloads'),
  isDefaultBrowser,
  windows: process.platform === 'win32',
}));
pageHandle('newtab', (ctx) => {
  const incognito = !!(ctx.tab && ctx.tab.private);
  return {
    incognito,
    engineName: engine().name,
    sites: incognito ? [] : topSites(),
    blockedTotal: settings.data.blockedTotal || 0,
    adblock: settings.data.adblock && !!blocker,
  };
});
pageHandle('go', (ctx, text) => {
  const t = ctx.tab;
  if (t) load(t.view.webContents, toUrl(text));
  return true;
});
pageHandle('hide-site', (_ctx, host) => {
  const list = settings.data.hiddenSites || [];
  if (!list.includes(host)) list.push(host);
  settings.data.hiddenSites = list;
  settings.save();
  return topSites();
});
pageHandle('restore-sites', () => { settings.data.hiddenSites = []; settings.save(); return topSites(); });
pageHandle('set-setting', (_ctx, key, value) => setSetting(key, value));
pageHandle('history', (_ctx, query) => {
  const q = (query || '').trim().toLowerCase();
  const items = q ? history.data.items.filter(h => (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q)) : history.data.items;
  return items.slice(0, 1000);
});
pageHandle('delete-history', (_ctx, url, time) => {
  history.data.items = history.data.items.filter(h => !(h.url === url && h.time === time));
  history.save();
  return true;
});
pageHandle('bookmarks', () => bookmarks.data.items);
pageHandle('remove-bookmark', (_ctx, id) => {
  bookmarks.data.items = bookmarks.data.items.filter(b => b.id !== id);
  bookmarks.save(); sendStateAll();
  return bookmarks.data.items;
});
pageHandle('edit-bookmark', (_ctx, id, title, url) => {
  const b = bookmarks.data.items.find(x => x.id === id);
  if (b) { b.title = String(title || '').slice(0, 300) || b.title; if (url) b.url = toUrl(url); bookmarks.save(); sendStateAll(); }
  return bookmarks.data.items;
});
pageHandle('move-bookmark', (_ctx, id, dir) => {
  const items = bookmarks.data.items;
  const i = items.findIndex(b => b.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < items.length) { [items[i], items[j]] = [items[j], items[i]]; bookmarks.save(); sendStateAll(); }
  return items;
});
pageHandle('downloads', () => downloads);
pageHandle('download-action', (_ctx, id, action) => { downloadAction(id, action); return true; });
pageHandle('clear-downloads', () => { downloads = downloads.filter(d => liveDownloads.has(d.id)); persistDownloads(); notifyDownloads(); return downloads; });
pageHandle('permissions', () => {
  const out = [];
  for (const [origin, perms] of Object.entries(permissions.data.sites)) {
    for (const [permission, value] of Object.entries(perms)) out.push({ origin, permission, value, label: PROMPT_PERMISSIONS[permission] || permission });
  }
  return out.sort((a, b) => a.origin.localeCompare(b.origin));
});
pageHandle('remove-permission', (_ctx, origin, permission) => {
  const p = permissions.data.sites[origin];
  if (p) { delete p[permission]; if (!Object.keys(p).length) delete permissions.data.sites[origin]; permissions.save(); }
  return true;
});
pageHandle('clear-data', (_ctx, opts) => clearData(opts || {}));
pageHandle('check-updates', () => { checkForUpdates(); return true; });
pageHandle('install-update', () => { autoUpdater && autoUpdater.quitAndInstall(); return true; });
pageHandle('open-downloads-folder', () => { shell.openPath(app.getPath('downloads')); return true; });
pageHandle('make-default', async () => { await makeDefaultBrowser(); return true; });
pageHandle('check-default', async () => { await checkDefaultBrowser(true); return isDefaultBrowser; });

// ---------- app ----------

// Turns command-line arguments (a link or file Windows asked us to open) into a URL.
function argUrl(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter(a => a && !a.startsWith('--') && a !== '.');
  if (!args.length) return null;
  const a = args.join(' ');
  try { if (fs.existsSync(a)) return pathToFileURL(path.resolve(a)).href; } catch {}
  return toUrl(a);
}

process.on('uncaughtException', e => log('Uncaught exception:', e && e.stack || String(e)));
process.on('unhandledRejection', e => log('Unhandled rejection:', e && e.stack || String(e)));

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Another copy was started, e.g. you clicked a link in another app.
  app.on('second-instance', (_e, argv) => {
    const url = argUrl(argv);
    let w = normalWindow(false);
    if (!w) w = createWindow({ urls: [url || homeUrl()] });
    else if (url) createTab(w, url);
    if (w.win.isMinimized()) w.win.restore();
    w.win.focus();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.cloudbrowser.app');
    Menu.setApplicationMenu(null);

    settings = new Store('settings', DEFAULT_SETTINGS);
    bookmarks = new Store('bookmarks', { items: [] });
    history = new Store('history', { items: [] });
    permissions = new Store('permissions', { sites: {} });
    downloadStore = new Store('downloads', { items: [] });
    sessionStore = new Store('session', { windows: [] });
    downloads = (downloadStore.data.items || []).map(d => (d.state === 'progressing' || d.state === 'paused') ? { ...d, state: 'interrupted' } : d);
    nextDownloadId = downloads.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;
    nativeTheme.themeSource = settings.data.theme;

    // 1.2: switch people still on the old DuckDuckGo home page to the new home page (once).
    if (settings.data.homeVersion < 1) {
      if (!settings.data.homePage || settings.data.homePage === 'https://duckduckgo.com/') settings.data.homePage = NEWTAB_URL;
      settings.data.homeVersion = 1;
      settings.save();
    }

    for (const [p, isPrivate] of [[NORMAL_PARTITION, false], [PRIVATE_PARTITION, true]]) {
      const s = session.fromPartition(p);
      s.protocol.handle('cloud', handleCloudRequest);
      setupPermissions(s, isPrivate);
      setupDownloads(s, isPrivate);
    }

    startWindows(argUrl(process.argv));
    setupUpdater();
    setupAdblock();
    registerAsBrowser().then(() => checkDefaultBrowser(true));
    if (SMOKE) setTimeout(smokeTest, 1500);
  });

  app.on('before-quit', () => { if (!quitting) { quitting = true; saveSession(true); } flushAll(); });
  app.on('window-all-closed', () => app.quit());
}

// ---------- automated smoke test (CI only: CLOUD_SMOKE=1) ----------

async function smokeTest() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const S = (...a) => log('[SMOKE]', ...a);
  const shotImg = (name, img) => {
    if (!img || img.isEmpty()) { S(`shot ${name} empty`); return; }
    const small = img.getSize().width > 1000 ? img.resize({ width: 1000 }) : img;
    const b64 = small.toJPEG(72).toString('base64');
    log(`[SHOT-BEGIN ${name}]`);
    for (let i = 0; i < b64.length; i += 3000) log('[SHOT] ' + b64.slice(i, i + 3000));
    log(`[SHOT-END ${name}]`);
  };
  const screen = async (name) => {
    try {
      const { desktopCapturer } = require('electron');
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 800 } });
      shotImg(name, src.thumbnail);
    } catch (e) { S('screen capture failed', e.message); }
  };
  try {
    await wait(5000);
    let w = currentWindow();
    S('version', app.getVersion(), 'windows', windows.size, 'tabs', w.tabs.length, 'adblock', !!blocker, 'home', homeUrl());
    let t = activeTab(w);
    S('first tab', tabUrl(t), JSON.stringify(tabInfo(t).title));
    await screen('home');
    const nt = await t.view.webContents.executeJavaScript('document.body.innerText.slice(0, 400)').catch(e => 'ERR ' + e.message);
    S('home text', JSON.stringify(nt));

    load(t.view.webContents, 'https://example.com/');
    await wait(3500);
    S('example title', t.view.webContents.getTitle(), 'history', history.data.items.length);
    toggleBookmark(t);
    S('bookmarked', isBookmarked(tabUrl(t)));
    S('suggest exam', suggest('exam', false));
    S('toUrl', toUrl('cats and dogs'), toUrl('bbc.co.uk'), toUrl('C:\\Users\\x\\page.html'));
    S('argUrl file', argUrl([process.execPath, ...(app.isPackaged ? [] : ['.']), path.join(__dirname, 'pages', 'settings.html')]));

    createTab(w, 'https://www.theverge.com/');
    await wait(9000);
    S('ad-heavy page blocked', activeTab(w).blocked, 'total', settings.data.blockedTotal);

    const before = w.tabs.length;
    await w.tabs[0].view.webContents.executeJavaScript(`window.open('https://example.net/'); 1`);
    await wait(800);
    S('pop-up without click blocked?', w.tabs.length === before, 'popupsBlocked', popupsBlocked);

    for (const p of ['settings', 'history', 'bookmarks', 'downloads']) {
      openInternal(w, p);
      await wait(1800);
      const wc = activeTab(w).view.webContents;
      const text = await wc.executeJavaScript('document.body.innerText.slice(0, 200)').catch(e => 'ERR ' + e.message);
      S('page', p, wc.getURL(), 'text', JSON.stringify(text));
    }
    S('cloud api exposed on normal website?', await w.tabs[0].view.webContents.executeJavaScript('typeof window.cloud').catch(() => 'ERR'));

    // home page again with history
    createTab(w, NEWTAB_URL);
    await wait(2000);
    S('top sites', topSites().map(s => s.host));

    // incognito window
    const iw = newWindow(true);
    await wait(3000);
    S('incognito window', iw.incognito, 'tabs', iw.tabs.length, 'url', tabUrl(activeTab(iw)), 'windows', windows.size);
    const it = activeTab(iw);
    const itext = await it.view.webContents.executeJavaScript('document.body.innerText.slice(0, 300)').catch(e => 'ERR ' + e.message);
    S('incognito home text', JSON.stringify(itext));
    await screen('incognito-home');
    load(it.view.webContents, 'https://www.theverge.com/');
    await wait(8000);
    S('incognito blocked', it.blocked, 'history has verge visits', history.data.items.filter(h => h.url.includes('theverge')).length);
    S('incognito suggest has history?', suggest('verge', true).length, 'normal', suggest('verge', false).length);
    S('incognito cookies', (await session.fromPartition(PRIVATE_PARTITION).cookies.get({})).length);
    iw.win.close();
    await wait(1500);
    S('after closing incognito: windows', windows.size, 'incognito cookies', (await session.fromPartition(PRIVATE_PARTITION).cookies.get({})).length);

    // default browser registration (installed app only)
    if (app.isPackaged) {
      const q1 = await reg(['query', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve']);
      const q2 = await reg(['query', 'HKCU\\Software\\Clients\\StartMenuInternet\\CloudBrowser\\Capabilities\\URLAssociations']);
      const q3 = await reg(['query', 'HKCU\\Software\\RegisteredApplications', '/v', 'CloudBrowser']);
      S('reg command', JSON.stringify((q1 || '').trim()));
      S('reg urls', JSON.stringify((q2 || '').trim()));
      S('reg registered', JSON.stringify((q3 || '').trim()));
      S('isDefaultBrowser', isDefaultBrowser);
      await wait(500);
      await screen('default-banner');
    }

    // second normal window + session
    const w2 = newWindow(false);
    await wait(2000);
    load(activeTab(w2).view.webContents, 'https://example.org/');
    await wait(2500);
    saveSession(true);
    S('session', sessionStore.data);
    S('DONE');
  } catch (e) {
    S('ERROR', e && e.stack || String(e));
  } finally {
    flushAll();
    setTimeout(() => app.exit(0), 500);
  }
}
