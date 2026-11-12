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
const { Vpn } = require('./vpn');

let extLib = null;
let webStoreLib = null;
try { extLib = require('electron-chrome-extensions'); } catch (e) { console.error('Extension support unavailable:', e.message); }
try { webStoreLib = require('electron-chrome-web-store'); } catch (e) { console.error('Web Store support unavailable:', e.message); }

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('Updater unavailable:', e.message); }

// ---------- constants ----------

const SMOKE = process.env.CLOUD_SMOKE === '1';
const NORMAL_PARTITION = 'persist:cloudbrowser';
const PRIVATE_PARTITION = 'cloudbrowser-private'; // no "persist:" = memory only
const PAGES_DIR = path.join(__dirname, 'pages');
const INTERNAL_PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'extensions', 'reader'];
const TITLEBAR_HEIGHT = 40;

// Shown on the extensions page for one-click install.
const RECOMMENDED_EXTENSIONS = [
  { id: 'nngceckbapebfimnlniiiahkandclblb', name: 'Bitwarden Password Manager', about: 'Saves and fills your passwords.' },
  { id: 'hbkpclpemjeibhioopcebchdmohaieln', name: 'BTRoblox', about: 'Makes the Roblox website better.' },
  { id: 'adbacgifemdbhdkfppmeilbgppmhaobf', name: 'RoPro', about: 'Dozens of extra Roblox features and trading tools.' },
];
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
  verticalTabs: false,
  sidebarCollapsed: false,
  shortcutsMode: 'mostVisited', // mostVisited | custom
  showShortcuts: true,
  vpnEnabled: false,
  vpnMode: 'tor',               // tor | wireguard
  vpnCountry: 'auto',
  vpnWgConfigName: '',
  adblockAllowlist: [],         // hosts where the ad blocker is switched off
  pinnedExtensions: [],         // extension ids shown directly in the toolbar
  sleepAfter: 30,               // minutes before an unused tab sleeps (0 = never)
  stripTracking: true,          // remove tracking codes (utm_…, fbclid, …) from links
  sendGpc: true,                // tell sites "do not sell or share my data" (Sec-GPC, DNT)
  incognitoVpn: false,          // incognito windows always go through the VPN
  incognitoScreenProtection: true, // hide incognito windows from screenshots/recordings
  passwordManager: 'bitwarden', // bitwarden | none
  bitwardenSetupDone: false,    // installed + pinned once (don't redo it if the user removes it)
  alwaysTranslate: [],          // language codes translated automatically
  neverTranslate: [],           // language codes never offered
  clearOnExit: false,
  shortcuts: [],                // [{ title, url }] when shortcutsMode is 'custom'
  window: null,               // { width, height, maximized }
};
const INTERNAL_SETTINGS = new Set(['blockedTotal', 'window', 'hiddenSites', 'homeVersion', 'shortcuts',
  'vpnEnabled', 'vpnMode', 'vpnCountry', 'vpnWgConfigName', 'adblockAllowlist', 'pinnedExtensions', 'incognitoVpn',
  'bitwardenSetupDone', 'alwaysTranslate', 'neverTranslate']);

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

let settings, bookmarks, history, permissions, downloadStore, sessionStore, extGrants;
const windows = new Set();   // browser windows (see createWindow)
let lastFocused = null;
let nextWinId = 1;
let nextTabId = 1;
let quitting = false;
let sessionFrozen = false;   // the last normal window closed; keep its tabs for next start
let updateState = { status: 'idle' };
let blocker = null;
let popupsBlocked = 0;
const blockingOn = new Set();
const privatePermissions = new Map(); // origin -> { permission: 'allow'|'block' } (incognito, this run only)
let downloads = [];      // newest first
const liveDownloads = new Map();
let nextDownloadId = 1;
let downloadsThisRun = 0;
let isDefaultBrowser = null; // null = unknown / not applicable
let extensions = null;        // ElectronChromeExtensions instance (normal windows only)
let addingTab = false;
let vpn = null;
const readerCache = new Map(); // id -> article extracted for reader mode
let nextReaderId = 1;
let clearedOnExit = false;
let readabilitySource = null;
try {
  readabilitySource = [
    fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8'),
    fs.readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8'),
  ].join('\n;\n');
} catch (e) { console.error('Reader mode unavailable:', e.message); }

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
    title: isNewtab ? (t.private ? 'New incognito tab' : 'New tab') : ((t.sleeping && t.sleepTitle) || wc.getTitle() || (url.startsWith('cloud://') ? '' : url) || 'New tab'),
    sleeping: !!t.sleeping,
    url,
    favicon: t.favicon || null,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    private: t.private,
    wcId: wc.id,
    blocked: t.blocked,
    audible: wc.isCurrentlyAudible(),
    muted: wc.isAudioMuted(),
    bookmarked: isBookmarked(url),
    pinned: !!t.pinned,
    readerable: !!t.readerable,
    zoom: Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100),
    adblockOff: isAllowlisted(hostOf(url)),
    translatable: canTranslate(t),
    translated: isTranslated(url),
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
    verticalTabs: settings.data.verticalTabs,
    sidebarCollapsed: settings.data.sidebarCollapsed,
    extensions: !w.incognito && !!extensions,
    pinnedExtensions: settings.data.pinnedExtensions || [],
    activeWcId: t ? t.view.webContents.id : null,
    storeExtension: storeExtensionFor(t),
    vpn: vpn ? vpn.info() : null,
    maximized: w.win.isMaximized(),
  });
  const title = t ? (tabInfo(t).title) : 'New tab';
  w.win.setTitle(`${title} — CloudBrowser${w.incognito ? ' (Incognito)' : ''}`);
}

// ---------- layout ----------

// The UI view fills the whole window, underneath the tabs. Pages sit in the space the
// UI leaves for them (right of the vertical tab bar, below the toolbar). While the
// address-bar suggestions are open, the UI view is lifted above the page.
function layout(w) {
  if (!w || !w.win || w.win.isDestroyed()) return;
  const { width, height } = w.win.getContentBounds();
  const x = w.htmlFullscreen ? 0 : w.pageX;
  const y = w.htmlFullscreen ? 0 : w.pageY;
  for (const t of w.tabs) t.view.setBounds({ x, y, width: Math.max(0, width - x), height: Math.max(0, height - y) });
  w.ui.setBounds({ x: 0, y: 0, width, height });
}

function setOverlay(w, open) {
  w.overlayOpen = open;
  if (open) w.win.contentView.addChildView(w.ui); // lift the UI above the page
  else for (const t of w.tabs) w.win.contentView.addChildView(t.view); // pages back on top
  layout(w);
}

function titleBarColors(incognito) {
  if (incognito) return { color: '#15111e', symbolColor: '#ece6fb', height: TITLEBAR_HEIGHT };
  return { color: '#07101b', symbolColor: '#ffffff', height: TITLEBAR_HEIGHT }; // Discord Lite navy
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
    backgroundColor: incognito ? '#1d1828' : '#07101b',
    autoHideMenuBar: true,
    show: false, // shown once the toolbar has drawn (no blank flash)
    // Tabs live in the title bar; Windows draws the minimise/maximise/close buttons on top.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(incognito),
  };
  if (cur && !cur.win.isDestroyed()) {
    const b = cur.win.getBounds();
    Object.assign(opts, { x: b.x + 30, y: b.y + 30, width: b.width, height: b.height });
  }
  const w = {
    id: nextWinId++, incognito, tabs: [], activeId: null, closedTabs: [],
    pageX: 0, pageY: 84, overlayOpen: false, htmlFullscreen: false, userFullscreen: false, stateQueued: false,
  };
  w.win = new BaseWindow(opts);
  windows.add(w);
  if (incognito && settings.data.incognitoScreenProtection) w.win.setContentProtection(true);
  lastFocused = w;
  if (!incognito) sessionFrozen = false;

  w.ui = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      sandbox: false, // our own local page; needs Node to load the extension buttons
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
  w.ui.webContents.once('did-finish-load', async () => {
    // Incognito through the VPN: set up the kill switch before the first page loads.
    if (incognito && vpn) await vpn.setIncognitoOpen(true);
    if (!windows.has(w)) return;
    const list = urls && urls.length ? urls : [homeUrl()];
    const activeIdx = Math.min(active, list.length - 1);
    list.forEach((u, i) => {
      const item = typeof u === 'string' ? { url: u } : u;
      // Only the visible tab loads now; the others load when first clicked (fast startup).
      createTab(w, item.url, { activate: i === activeIdx, pinned: !!item.pinned, lazy: i !== activeIdx && list.length > 1, title: item.title, favicon: item.favicon });
    });
    layout(w);
    pushState(w);
    w.win.show();
    if (!cur && saved.maximized && !incognito) w.win.maximize();
    if (tabUrl(activeTab(w)).startsWith(NEWTAB_URL)) focusAddress(w);
  });

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) w.win.on(ev, () => { layout(w); sendState(w); });
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
      if (vpn) vpn.setIncognitoOpen(false);
    }
    if (windows.size === 0) { flushAll(); app.quit(); }
  });
  return w;
}

// ---------- tabs ----------

function createTab(w, url, { activate = true, openerId = null, pinned = false, lazy = false, title = null, favicon = null } = {}) {
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
  view.setBackgroundColor(w.incognito ? '#1d1828' : '#07101b');
  url = cleanUrl(url);
  const tab = { id: nextTabId++, w, view, private: w.incognito, favicon: lazy ? favicon : null, blocked: 0, failedUrl: null, initialUrl: url, histEntry: null, lastInput: 0, pinned,
    lastActive: Date.now(), sleeping: lazy, lazyUrl: lazy ? url : null, sleepTitle: lazy ? title : null };
  if (vpn) vpn.protectContents(view.webContents, w.incognito);

  const openerIdx = openerId ? w.tabs.findIndex(t => t.id === openerId) : -1;
  if (openerIdx >= 0) {
    let i = openerIdx + 1;
    while (i < w.tabs.length && w.tabs[i].openerId === openerId) i++;
    tab.openerId = openerId;
    w.tabs.splice(i, 0, tab);
  } else if (pinned) {
    w.tabs.splice(w.tabs.filter(t => t.pinned).length, 0, tab);
  } else {
    w.tabs.push(tab);
  }
  if (w.overlayOpen) w.win.contentView.addChildView(view, Math.max(0, w.win.contentView.children.indexOf(w.ui)));
  else w.win.contentView.addChildView(view); // above the UI view
  wireTab(tab);
  if (extensions && !w.incognito) {
    addingTab = true; // the extension system may "select" tabs as it learns about them; don't wake them for that
    try { extensions.addTab(view.webContents, w.win); } catch (e) { log('extensions.addTab failed', e.message); }
    finally { addingTab = false; }
  }
  layout(w);

  if (!lazy) load(view.webContents, url);
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
  wc.on('did-stop-loading', () => { update(); saveSession(); checkReaderable(tab); detectLanguage(tab); });
  wc.on('audio-state-changed', update);
  wc.on('page-title-updated', (_e, title) => {
    if (tab.histEntry && tab.histEntry.url === wc.getURL()) { tab.histEntry.title = title; history.save(); }
    update();
  });
  wc.on('did-navigate', (_e, url) => {
    tab.readerable = false;
    tab.pageLang = null;
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
    if (details.reason === 'clean-exit' || tab.sleeping) return;
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
    createTab(tab.w, cleanUrl(url), { activate: disposition !== 'background-tab', openerId: tab.id });
    return { action: 'deny' };
  });
  const stripOnNavigate = (e, url, isMain) => {
    if (isMain === false) return;
    const clean = cleanUrl(url);
    if (clean !== url) { e.preventDefault(); load(wc, clean); }
  };
  wc.on('will-navigate', (e) => stripOnNavigate(e, e.url, e.isMainFrame));
  wc.on('will-redirect', (e) => stripOnNavigate(e, e.url, e.isMainFrame));
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
  const prevTab = activeTab(w);
  if (prevTab && prevTab.id !== id) prevTab.lastActive = Date.now();
  w.activeId = id;
  t.lastActive = Date.now();
  if (t.sleeping) wakeTab(t);
  for (const x of w.tabs) x.view.setVisible(x.id === id);
  if (extensions && !w.incognito) { try { extensions.selectTab(t.view.webContents); } catch {} }
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
  if (w.tabs.length === 0) {
    // Closing the last tab doesn't close CloudBrowser: open a fresh home tab instead.
    // (The last tab of an incognito window closes that window if another window is open.)
    if (w.incognito && [...windows].some(x => x !== w)) { w.win.close(); return; }
    createTab(w, homeUrl());
    focusAddress(w);
    saveSession();
    return;
  }
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

function suggest(q, incognito, w) {
  q = (q || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const seen = new Set();
  const hit = s => !!s && s.toLowerCase().includes(q);

  // Open tabs first ("Switch to tab")
  for (const t of allTabs()) {
    if (t.private !== !!incognito || (w && t.id === w.activeId)) continue;
    const u = tabUrl(t);
    const title = (t.sleeping && t.sleepTitle) || t.view.webContents.getTitle();
    if (!/^(https?|cloud):/.test(u) || u.startsWith(NEWTAB_URL) || !(hit(title) || hit(stripScheme(u)))) continue;
    seen.add(u);
    out.push({ type: 'tab', url: u, title: title || u, tabId: t.id });
    if (out.length >= 3) break;
  }

  for (const b of bookmarks.data.items) {
    if ((hit(b.title) || hit(stripScheme(b.url))) && !seen.has(b.url)) {
      seen.add(b.url);
      out.push({ type: 'bookmark', url: b.url, title: b.title });
      if (out.length >= 6) break;
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
  // Name a tile after the site: "Roblox: Sign Up to Play!" -> "Roblox", "Watch - YouTube" -> "YouTube".
  const labels = host.toLowerCase().split('.').filter(l => l !== 'www').slice(0, -1)
    .filter((l, i, a) => !(i === a.length - 1 && a.length > 1 && ['co', 'com', 'org', 'net', 'gov', 'ac'].includes(l)));
  const squash = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = String(title).split(/\s+[-–—|·:]\s+|:\s+/).map(x => x.trim()).filter(Boolean);
  for (const label of labels) {
    const named = parts.find(x => x.length <= 24 && squash(x).includes(label));
    if (named) return named;
  }
  const label = labels[0] || host;
  return label.charAt(0).toUpperCase() + label.slice(1);
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
    tabs: w.tabs.map(t => ({ url: tabUrl(t), pinned: !!t.pinned, title: (t.sleeping && t.sleepTitle) || t.view.webContents.getTitle() || '', favicon: t.favicon || null }))
      .filter(x => x.url && !x.url.startsWith('data:')),
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

function isAllowlisted(host) {
  host = (host || '').toLowerCase().replace(/^www\./, '');
  if (!host || !settings) return false;
  return (settings.data.adblockAllowlist || []).some(h => host === h || host.endsWith('.' + h));
}

function toggleAllowlist(host) {
  host = (host || '').toLowerCase().replace(/^www\./, '');
  if (!host) return;
  const list = settings.data.adblockAllowlist || [];
  settings.data.adblockAllowlist = list.includes(host) ? list.filter(h => h !== host) : [...list, host];
  settings.save();
  sendStateAll();
  pagesSend('page:settings', settings.data);
}

async function setupAdblock() {
  let mod;
  try { mod = require('@ghostery/adblocker-electron'); } catch (e) { log('Ad blocker unavailable:', e.message); return; }
  try {
    // Full lists: ads, trackers and annoyances such as cookie banners. Refreshed every few days.
    const cache = path.join(app.getPath('userData'), 'adblock-full.bin');
    try { if (Date.now() - fs.statSync(cache).mtimeMs > 4 * 86400000) fs.unlinkSync(cache); } catch {}
    const caching = { path: cache, read: fs.promises.readFile, write: fs.promises.writeFile };
    const E = mod.ElectronBlocker;
    const viaSession = (url, opts) => session.defaultSession.fetch(url, opts); // honours the VPN
    blocker = typeof E.fromPrebuiltFull === 'function'
      ? await E.fromPrebuiltFull(viaSession, caching)
      : await E.fromPrebuiltAdsAndTracking(viaSession, caching);

    // Per-site switch: skip blocking on pages whose site is on the allowlist.
    const origMatch = blocker.match.bind(blocker);
    blocker.match = (request) => {
      const t = allTabs().find(x => !x.view.webContents.isDestroyed() && x.view.webContents.id === request.tabId);
      const host = t ? hostOf(tabUrl(t)) : request.sourceHostname;
      if (isAllowlisted(host)) return { match: false, redirect: undefined, exception: undefined, filter: undefined };
      return origMatch(request);
    };
    if (typeof blocker.getCosmeticsFilters === 'function') {
      const origCosmetic = blocker.getCosmeticsFilters.bind(blocker);
      blocker.getCosmeticsFilters = (opts) => (opts && isAllowlisted(opts.hostname))
        ? { active: false, extended: [], scripts: [], styles: '' }
        : origCosmetic(opts);
    }

    blocker.on('request-blocked', (request) => {
      const t = allTabs().find(x => !x.view.webContents.isDestroyed() && x.view.webContents.id === request.tabId);
      if (t) { t.blocked++; sendState(t.w); }
      settings.data.blockedTotal = (settings.data.blockedTotal || 0) + 1;
      settings.save();
    });
    applyAdblock();
    log('Ad blocker ready', typeof E.fromPrebuiltFull === 'function' ? '(full lists)' : '(ads + tracking)');
  } catch (e) {
    blocker = null;
    log('Ad blocker failed to start:', e && e.stack || e);
  }
  sendStateAll();
}

// The blocker's page-cleanup part registers app-wide message handlers each time it is
// switched on for a session. They work for every session, so a second registration
// (for incognito) is simply skipped instead of failing.
function withSharedHandlers(fn) {
  const origHandle = ipcMain.handle;
  const origOn = ipcMain.on;
  const seen = new Set();
  ipcMain.handle = function (channel, listener) {
    try { return origHandle.call(ipcMain, channel, listener); }
    catch (e) { if (/second handler/.test(e.message)) return; throw e; }
  };
  ipcMain.on = function (channel, listener) {
    if (String(channel).includes('adblocker') && ipcMain.listenerCount(channel) > 0 && !seen.has(channel)) { seen.add(channel); return ipcMain; }
    return origOn.call(ipcMain, channel, listener);
  };
  try { return fn(); } finally { ipcMain.handle = origHandle; ipcMain.on = origOn; }
}

function applyAdblock() {
  if (!blocker) return;
  for (const p of [NORMAL_PARTITION, PRIVATE_PARTITION]) {
    const s = session.fromPartition(p);
    try {
      if (settings.data.adblock && !blockingOn.has(p)) { withSharedHandlers(() => blocker.enableBlockingInSession(s)); blockingOn.add(p); }
      else if (!settings.data.adblock && blockingOn.has(p)) { blocker.disableBlockingInSession(s); blockingOn.delete(p); }
    } catch (e) {
      log('Ad blocker session error', p, e.message);
    }
  }
}

function showShieldMenu(w) {
  const t = activeTab(w);
  if (!t) return;
  const host = hostOf(tabUrl(t)).replace(/^www\./, '');
  const web = /^https?:/.test(tabUrl(t));
  const on = settings.data.adblock && !!blocker;
  Menu.buildFromTemplate([
    { label: on ? `${t.blocked} ads, trackers and pop-ups blocked on this page` : 'Ad blocking is off', enabled: false },
    { label: `${(settings.data.blockedTotal || 0).toLocaleString()} blocked in total`, enabled: false },
    { type: 'separator' },
    { label: `Block on ${host || 'this site'}`, type: 'checkbox', checked: !isAllowlisted(host), enabled: on && web,
      click: () => { toggleAllowlist(host); t.view.webContents.reload(); } },
    { label: 'Block ads everywhere', type: 'checkbox', checked: settings.data.adblock, click: () => setSetting('adblock', !settings.data.adblock) },
    { type: 'separator' },
    { label: 'Ad blocker settings…', click: () => openInternal(w, 'settings', '#privacy') },
  ]).popup({ window: w.win });
}

// ---------- reader mode ----------

async function checkReaderable(tab) {
  const wc = tab.view.webContents;
  if (!readabilitySource || tab.private === undefined || wc.isDestroyed() || !/^https?:/.test(wc.getURL())) return;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(1001, [{
      code: `(() => { if (!window.__cbReadability) { ${readabilitySource}; window.__cbReadability = { Readability, isProbablyReaderable }; }
        return window.__cbReadability.isProbablyReaderable(document, { minContentLength: 200, minScore: 30 }); })()`,
    }]);
    const was = tab.readerable;
    tab.readerable = !!r;
    if (was !== tab.readerable) sendState(tab.w);
  } catch {}
}

async function openReader(tab) {
  const wc = tab.view.webContents;
  if (!readabilitySource) return;
  try {
    const article = await wc.executeJavaScriptInIsolatedWorld(1001, [{
      code: `(() => { if (!window.__cbReadability) { ${readabilitySource}; window.__cbReadability = { Readability, isProbablyReaderable }; }
        const a = new window.__cbReadability.Readability(document.cloneNode(true)).parse();
        return a && { title: a.title, byline: a.byline, siteName: a.siteName, content: a.content, length: a.length, excerpt: a.excerpt }; })()`,
    }]);
    if (!article || !article.content) return;
    const id = nextReaderId++;
    readerCache.set(id, { ...article, url: tabUrl(tab) });
    if (readerCache.size > 30) readerCache.delete(readerCache.keys().next().value);
    load(wc, `cloud://reader/?id=${id}`);
  } catch (e) { log('reader failed', e.message); }
}

// ---------- screenshots & picture-in-picture ----------

async function screenshot(w) {
  const t = activeTab(w);
  if (!t) return;
  const img = await t.view.webContents.capturePage();
  clipboard.writeImage(img);
  const dir = path.join(app.getPath('pictures'), 'CloudBrowser Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const name = (t.view.webContents.getTitle() || 'Screenshot').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `${name} ${stamp}.png`);
  fs.writeFileSync(file, img.toPNG());
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    const n = new Notification({ title: 'Screenshot saved', body: 'Copied to your clipboard and saved in Pictures › CloudBrowser Screenshots.', icon: path.join(__dirname, 'ui', 'icon.png') });
    n.on('click', () => shell.showItemInFolder(file));
    n.show();
  }
  return file;
}

function pictureInPicture(wc, x, y) {
  const at = (typeof x === 'number') ? `document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})` : 'null';
  wc.executeJavaScript(`(async () => {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    const hit = ${at};
    const vids = [...document.querySelectorAll('video')];
    const v = (hit && (hit.closest && hit.closest('video'))) || vids.find(v => !v.paused) || vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
    if (v) { v.disablePictureInPicture = false; await v.requestPictureInPicture(); }
  })().catch(() => {})`, true).catch(() => {});
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

// ---------- home page shortcuts ----------

function homeShortcuts() {
  if (settings.data.shortcutsMode === 'custom') {
    return settings.data.shortcuts.map(x => ({ url: x.url, title: x.title || hostOf(x.url), host: hostOf(x.url).replace(/^www\./, '') }));
  }
  return topSites();
}

// ---------- Chrome extensions ----------

function extSession() { return session.fromPartition(NORMAL_PARTITION); }

function waitForTabs(w) {
  return new Promise(resolve => {
    if (w.tabs.length) return resolve();
    const iv = setInterval(() => { if (w.tabs.length || !windows.has(w)) { clearInterval(iv); resolve(); } }, 50);
  });
}

async function setupExtensions() {
  const s = extSession();
  if (extLib) {
    try {
      const { ElectronChromeExtensions } = extLib;
      extensions = new ElectronChromeExtensions({
        license: 'GPL-3.0',
        session: s,
        createTab: async (details) => {
          let w = [...windows].find(x => !x.incognito && x.win.id === details.windowId) || normalWindow();
          await waitForTabs(w);
          const t = createTab(w, details.url || homeUrl(), { activate: details.active !== false });
          return [t.view.webContents, w.win];
        },
        selectTab: (wc) => { if (addingTab) return; const t = tabByContents(wc); if (t && t.id !== t.w.activeId) { switchTab(t.w, t.id); t.w.win.focus(); } },
        removeTab: (wc) => { const t = tabByContents(wc); if (t) closeTab(t.id); },
        createWindow: async (details) => {
          const urls = details.url ? [].concat(details.url) : [homeUrl()];
          const w = createWindow({ urls });
          await waitForTabs(w);
          return w.win;
        },
        removeWindow: (win) => { const w = [...windows].find(x => x.win === win); if (w) w.win.close(); },
        requestPermissions: (extension, perms) => askExtensionPermission(extension, perms),
      });
      extLib.ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
      log('Extension support ready');
    } catch (e) {
      extensions = null;
      log('Extension support failed:', e && e.stack || e);
    }
  }
  if (webStoreLib) {
    try {
      await webStoreLib.installChromeWebStore({ session: s });
      log('Web Store ready; loaded', s.extensions.getAllExtensions().map(x => x.name));
    } catch (e) {
      log('Web Store failed:', e && e.stack || e);
    }
  }
  s.extensions.on('extension-loaded', () => { pagesSend('page:extensions', null); sendStateAll(); });
  s.extensions.on('extension-unloaded', () => { pagesSend('page:extensions', null); sendStateAll(); });
}

function describeOrigin(o) {
  if (o === '<all_urls>' || /^\*:\/\/\*\/\*$/.test(o) || /^https?:\/\/\*\/\*$/.test(o)) return 'all websites';
  const m = /^[^:]+:\/\/(\*\.)?([^/]+)/.exec(o);
  return m ? m[2] : o;
}

// An extension asked for extra access (chrome.permissions.request), e.g. BTRoblox asking for roblox.com.
async function askExtensionPermission(extension, perms = {}) {
  const id = extension && extension.id;
  const name = (extension && extension.name) || 'An extension';
  const origins = perms.origins || [];
  const apis = perms.permissions || [];
  log('Extension permission request', name, JSON.stringify(perms));
  const g = extGrants.data.grants[id] || { origins: [], permissions: [] };
  if (origins.every(o => g.origins.includes(o)) && apis.every(p => g.permissions.includes(p))) return true;

  let allow = SMOKE;
  if (!SMOKE) {
    const sites = [...new Set(origins.map(describeOrigin))];
    const lines = [];
    if (sites.length) lines.push(`Read and change your data on ${sites.join(', ')}`);
    if (apis.length) lines.push(`Use: ${apis.join(', ')}`);
    const w = currentWindow();
    const res = await dialog.showMessageBox(w && w.win, {
      type: 'question', buttons: ['Allow', 'Deny'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'CloudBrowser', message: `${name} wants extra access`, detail: lines.join('\n') || 'Additional permissions',
    });
    allow = res.response === 0;
  }
  if (allow && id) {
    extGrants.data.grants[id] = {
      origins: [...new Set([...g.origins, ...origins])],
      permissions: [...new Set([...g.permissions, ...apis])],
    };
    extGrants.save();
  }
  return allow;
}

// On a Chrome Web Store extension page, offer our own install button.
function storeExtensionFor(t) {
  if (!t || t.private || !extensions || !webStoreLib) return null;
  const m = /^https:\/\/chromewebstore\.google\.com\/detail\/(?:[^/?#]+\/)?([a-p]{32})/.exec(tabUrl(t));
  if (!m) return null;
  const id = m[1];
  const installed = !!extSession().extensions.getExtension(id);
  const name = (t.view.webContents.getTitle() || '').replace(/\s*-\s*Chrome Web Store\s*$/i, '') || 'this extension';
  return { id, name, installed };
}

function iconDataUrl(ext) {
  try {
    const icons = ext.manifest.icons || {};
    const size = Object.keys(icons).map(Number).sort((a, b) => b - a)[0];
    if (!size) return null;
    const file = path.join(ext.path, icons[size]);
    const type = file.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch { return null; }
}

function listExtensions() {
  const s = extSession();
  const installed = s.extensions.getAllExtensions().map(ext => ({
    id: ext.id,
    name: ext.name,
    version: ext.version,
    description: ext.manifest.description && !ext.manifest.description.startsWith('__MSG_') ? ext.manifest.description : '',
    icon: iconDataUrl(ext),
    hasOptions: !!((ext.manifest.options_ui && ext.manifest.options_ui.page) || ext.manifest.options_page),
  }));
  return {
    available: !!extensions && !!webStoreLib,
    installed,
    recommended: RECOMMENDED_EXTENSIONS.map(r => ({ ...r, installed: installed.some(i => i.id === r.id) })),
  };
}

async function installExtension(id) {
  if (!webStoreLib || !/^[a-p]{32}$/.test(id)) return { ok: false, error: 'Extensions are not available.' };
  try {
    await webStoreLib.installExtension(id, { session: extSession() });
    return { ok: true };
  } catch (e) {
    log('install extension failed', id, e && e.stack || e);
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function removeExtension(id) {
  const s = extSession();
  if (id === BITWARDEN_ID) { settings.data.passwordManager = 'none'; settings.save(); pagesSend('page:settings', settings.data); }
  try {
    if (webStoreLib && webStoreLib.uninstallExtension) await webStoreLib.uninstallExtension(id, { session: s });
    else s.extensions.removeExtension(id);
    return { ok: true };
  } catch (e) {
    try { s.extensions.removeExtension(id); } catch {}
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------- VPN helpers ----------

function setVpnCountry(c) {
  if (!vpn || !vpn.info().countries.some(([id]) => id === c)) return;
  settings.data.vpnCountry = c;
  settings.save();
  if (vpn.mode === 'tor') vpn.restart(); else vpnChanged(vpn.info());
}
function setVpnMode(m) {
  if (!vpn || !['tor', 'wireguard'].includes(m)) return;
  settings.data.vpnMode = m;
  settings.save();
  vpn.restart();
}
async function importWgConfig(w) {
  const { canceled, filePaths } = await dialog.showOpenDialog(w && w.win, {
    title: 'Choose a WireGuard config file', properties: ['openFile'],
    filters: [{ name: 'WireGuard config', extensions: ['conf'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (canceled || !filePaths[0]) return false;
  try {
    vpn.importWireGuardConfig(filePaths[0]);
    vpn.restart();
    return true;
  } catch (e) {
    dialog.showMessageBox(w && w.win, { type: 'warning', title: 'CloudBrowser', message: 'Couldn’t use that file', detail: e.message });
    return false;
  }
}
function vpnChanged(info) {
  uiSendAll('vpn', info);
  pagesSend('page:vpn', info);
  sendStateAll();
}

function togglePin(t) {
  const w = t.w;
  t.pinned = !t.pinned;
  w.tabs.splice(w.tabs.indexOf(t), 1);
  const pinnedCount = w.tabs.filter(x => x.pinned).length;
  w.tabs.splice(t.pinned ? pinnedCount : pinnedCount, 0, t);
  sendState(w);
  saveSession();
}

// ---------- privacy: tracking codes, "do not track", referrers ----------

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name', 'utm_reader', 'utm_social', 'utm_brand',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'li_fat_id', 'igshid', 'igsh',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'hsctatracking', 'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'vero_id', 'vero_conv',
  'rb_clickid', 's_cid', '__s', 'ref_src', 'ref_url', '_openstat', 'wickedid', 'spm', 'scm', 'srsltid', 'epik', 'pk_campaign', 'pk_kwd',
]);
const SHARE_PARAMS_BY_HOST = [[/(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/, ['si', 'feature', 'pp']], [/(^|\.)(twitter\.com|x\.com)$/, ['s', 't']]];

// Remove tracking codes from a link (utm_source, fbclid, gclid, …).
function cleanUrl(url) {
  if (!settings || !settings.data.stripTracking || typeof url !== 'string' || !/^https?:/i.test(url) || !url.includes('?')) return url;
  try {
    const u = new URL(url);
    if (isSearchResult(url)) return url;
    let changed = false;
    const extra = (SHARE_PARAMS_BY_HOST.find(([re]) => re.test(u.hostname)) || [null, []])[1];
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || extra.includes(key)) { u.searchParams.delete(key); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch { return url; }
}

function siteOf(host) {
  const parts = (host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  return /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
}

// "Do not sell or share my data" signals, and less revealing referrers. Incognito never tells
// another site which page you came from.
function setupPrivacyHeaders() {
  for (const [p, isPrivate] of [[NORMAL_PARTITION, false], [PRIVATE_PARTITION, true]]) {
    session.fromPartition(p).webRequest.onBeforeSendHeaders((details, callback) => {
      const h = details.requestHeaders;
      if (settings.data.sendGpc) { h['Sec-GPC'] = '1'; h['DNT'] = '1'; }
      const ref = h.Referer || h.referer;
      if (ref) {
        try {
          const from = new URL(ref), to = new URL(details.url);
          if (siteOf(from.hostname) !== siteOf(to.hostname)) {
            delete h.Referer; delete h.referer;
            if (!isPrivate) h.Referer = from.origin + '/';
          }
        } catch {}
      }
      callback({ requestHeaders: h });
    });
  }
}

// ---------- translate pages ----------
// Uses Google's "translate this page" service (the page is fetched through translate.goog).
// Only happens when you ask for it, or for languages you chose to always translate.

function userLanguage() {
  const l = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale() || 'en';
  return l.toLowerCase().split(/[-_]/)[0];
}
function languageName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch { return code; }
}
const TRANSLATE_TARGETS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'ru', 'uk', 'ar', 'hi', 'zh-CN', 'ja', 'ko'];

function isTranslated(url) { try { return new URL(url).hostname.endsWith('.translate.goog'); } catch { return false; } }

function canTranslate(t) {
  const url = tabUrl(t);
  if (!t.pageLang || isTranslated(url) || !/^https:/.test(url)) return false;
  return t.pageLang !== userLanguage() && !(settings.data.neverTranslate || []).includes(t.pageLang);
}

async function detectLanguage(tab) {
  const wc = tab.view.webContents;
  if (wc.isDestroyed() || !/^https:/.test(wc.getURL()) || isTranslated(wc.getURL())) return;
  try {
    const lang = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: `(document.documentElement.lang || (document.querySelector('meta[http-equiv="content-language" i]') || {}).content || '').trim()` }]);
    const base = String(lang || '').toLowerCase().split(/[-_,\s]/)[0];
    tab.pageLang = /^[a-z]{2,3}$/.test(base) ? base : null;
    sendState(tab.w);
    if (tab.pageLang && canTranslate(tab) && (settings.data.alwaysTranslate || []).includes(tab.pageLang)) translateTab(tab);
  } catch {}
}

function translatedUrl(url, target) {
  const u = new URL(url);
  const host = u.hostname.replace(/-/g, '--').replace(/\./g, '-');
  const q = new URLSearchParams(u.search);
  q.set('_x_tr_sl', 'auto'); q.set('_x_tr_tl', target); q.set('_x_tr_hl', target); q.set('_x_tr_pto', 'wapp');
  return `https://${host}.translate.goog${u.pathname}?${q.toString()}${u.hash}`;
}

function originalUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('.translate.goog')) return url;
    const host = u.hostname.slice(0, -'.translate.goog'.length).replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
    const q = new URLSearchParams(u.search);
    for (const k of [...q.keys()]) if (k.startsWith('_x_tr_')) q.delete(k);
    const qs = q.toString();
    return `https://${host}${u.pathname}${qs ? '?' + qs : ''}${u.hash}`;
  } catch { return url; }
}

function translateTab(tab, target = userLanguage()) {
  const url = tabUrl(tab);
  if (!/^https:/.test(url)) return;
  const base = isTranslated(url) ? originalUrl(url) : url;
  load(tab.view.webContents, translatedUrl(base, target));
}

function showTranslateMenu(w) {
  const t = activeTab(w);
  if (!t) return;
  const url = tabUrl(t);
  const mine = userLanguage();
  const lang = t.pageLang;
  const items = [];
  if (isTranslated(url)) {
    items.push({ label: 'Show original', click: () => load(t.view.webContents, originalUrl(url)) });
  } else {
    items.push({ label: `Translate to ${languageName(mine)}`, click: () => translateTab(t, mine) });
  }
  items.push({ label: 'Translate to…', submenu: TRANSLATE_TARGETS.filter(c => c !== mine).map(c => ({ label: languageName(c), click: () => translateTab(t, c) })) });
  if (lang && lang !== mine) {
    const always = (settings.data.alwaysTranslate || []).includes(lang);
    const never = (settings.data.neverTranslate || []).includes(lang);
    items.push({ type: 'separator' });
    items.push({ label: `Always translate ${languageName(lang)}`, type: 'checkbox', checked: always, click: () => {
      settings.data.alwaysTranslate = always ? settings.data.alwaysTranslate.filter(x => x !== lang) : [...(settings.data.alwaysTranslate || []), lang];
      settings.data.neverTranslate = (settings.data.neverTranslate || []).filter(x => x !== lang);
      settings.save();
      if (!always && !isTranslated(url)) translateTab(t, mine);
    } });
    items.push({ label: `Never offer for ${languageName(lang)}`, type: 'checkbox', checked: never, click: () => {
      settings.data.neverTranslate = never ? settings.data.neverTranslate.filter(x => x !== lang) : [...(settings.data.neverTranslate || []), lang];
      settings.data.alwaysTranslate = (settings.data.alwaysTranslate || []).filter(x => x !== lang);
      settings.save();
      sendStateAll();
    } });
  }
  items.push({ type: 'separator' }, { label: 'Translated by Google', enabled: false });
  Menu.buildFromTemplate(items).popup({ window: w.win });
}

// ---------- Bitwarden: the default password manager ----------

const BITWARDEN_ID = 'nngceckbapebfimnlniiiahkandclblb';

function bitwardenInstalled() {
  try { return !!extSession().extensions.getExtension(BITWARDEN_ID); } catch { return false; }
}

// Install and pin Bitwarden the first time (or when chosen in Settings).
async function ensureBitwarden(force = false) {
  if (!extensions || !webStoreLib || settings.data.passwordManager !== 'bitwarden') return;
  if (settings.data.bitwardenSetupDone && !force) return;
  if (!bitwardenInstalled()) {
    const res = await installExtension(BITWARDEN_ID);
    if (!res.ok) { log('Bitwarden install failed:', res.error); return; }
  }
  const pins = settings.data.pinnedExtensions || [];
  if (!pins.includes(BITWARDEN_ID)) settings.data.pinnedExtensions = [BITWARDEN_ID, ...pins];
  settings.data.bitwardenSetupDone = true;
  settings.save();
  sendStateAll();
  pagesSend('page:settings', settings.data);
  log('Bitwarden ready');
}

function openBitwarden(w) {
  if (!w || w.incognito) w = normalWindow();
  if (!bitwardenInstalled()) { openInternal(w, 'settings', '#passwords'); return; }
  w.win.focus();
  uiSend(w, 'open-extension', BITWARDEN_ID);
}

// ---------- sleeping tabs ----------

function wakeTab(t) {
  if (SMOKE) log('[SMOKE] wake', hostOf(tabUrl(t)), new Error().stack.split('\n').slice(2, 6).map(x => x.trim()).join(' < '));
  t.sleeping = false;
  const wc = t.view.webContents;
  if (t.lazyUrl) { const u = t.lazyUrl; t.lazyUrl = null; load(wc, u); }
  else wc.reload();
}

// Free a tab's memory. Its history stays, and it reloads when you click it.
function sleepTab(t, force = false) {
  const wc = t.view.webContents;
  if (t.sleeping || t.id === t.w.activeId || wc.isDestroyed() || wc.isCrashed()) return false;
  if (!force && (wc.isCurrentlyAudible() || wc.isLoading() || wc.isDevToolsOpened() || liveDownloads.size)) return false;
  // Pages from the same site can share one process; only stop it if every page in it can sleep.
  const pid = wc.getOSProcessId();
  const sharers = allTabs().filter(o => o !== t && !o.sleeping && !o.view.webContents.isDestroyed() && o.view.webContents.getOSProcessId() === pid);
  if (sharers.some(o => o.id === o.w.activeId || o.view.webContents.isCurrentlyAudible())) return false;
  const { webContents: all } = require('electron');
  if (all.getAllWebContents().some(o => o !== wc && !tabByContents(o) && !o.isDestroyed() && o.getOSProcessId() === pid)) return false;
  for (const x of [t, ...sharers]) {
    x.sleeping = true;
    x.sleepTitle = x.view.webContents.getTitle() || x.sleepTitle;
  }
  wc.forcefullyCrashRenderer();
  for (const x of new Set([t.w, ...sharers.map(o => o.w)])) sendState(x);
  return true;
}

function sleepIdleTabs() {
  const mins = settings.data.sleepAfter;
  if (!mins) return;
  const cutoff = Date.now() - mins * 60000;
  for (const t of allTabs()) {
    if (!t.sleeping && t.id !== t.w.activeId && t.lastActive < cutoff) sleepTab(t);
  }
}

// ---------- faster loading: connect to the site while you're still typing ----------

const preconnected = new Map();
function preconnect(w, text) {
  try {
    const url = toUrl(String(text || ''));
    if (!/^https?:/.test(url)) return;
    const origin = new URL(url).origin;
    if (Date.now() - (preconnected.get(origin) || 0) < 30000) return;
    preconnected.set(origin, Date.now());
    session.fromPartition(w.incognito ? PRIVATE_PARTITION : NORMAL_PARTITION).preconnect({ url: origin, numSockets: 1 });
  } catch {}
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
  if (key === 'f9') { if (t && t.readerable) openReader(t); return true; }
  if (ctrl && shift && key === 's') { screenshot(w); return true; }
  if (ctrl && shift && key === 'l') { openBitwarden(w); return true; }
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
  if (p.mediaType === 'video') {
    t.push({ label: 'Picture in picture', click: () => pictureInPicture(wc, p.x, p.y) });
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && /^https?:/i.test(p.srcURL)) {
    t.push({ label: `Open ${p.mediaType} in new tab`, click: () => newTab(p.srcURL) });
    t.push({ label: `Save ${p.mediaType} as…`, click: () => wc.downloadURL(p.srcURL) });
  }
  if (p.mediaType === 'video' || p.mediaType === 'audio') sep();
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
    t.push({ label: 'Take screenshot', click: () => screenshot(w) });
    if (tab.readerable) t.push({ label: 'Open in reader mode', click: () => openReader(tab) });
    if (/^https:/.test(tabUrl(tab))) t.push(isTranslated(tabUrl(tab))
      ? { label: 'Show original (untranslated)', click: () => load(wc, originalUrl(tabUrl(tab))) }
      : { label: `Translate to ${languageName(userLanguage())}`, click: () => translateTab(tab) });
    t.push({ label: 'View page source', enabled: /^https?:/.test(tabUrl(tab)), click: () => createTab(w, 'view-source:' + tabUrl(tab), { openerId: tab.id }) });
    sep();
  }
  if (extensions && !w.incognito) {
    try {
      const items = extensions.getContextMenuItems(wc, p);
      if (items.length) { sep(); t.push(...items); sep(); }
    } catch (e) { log('extension menu items failed', e.message); }
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
    { label: 'Extensions', click: () => openInternal(w, 'extensions') },
    { label: 'Passwords (Bitwarden)', accelerator: 'Ctrl+Shift+L', click: () => openBitwarden(w) },
    { label: 'Vertical tabs', type: 'checkbox', checked: settings.data.verticalTabs, click: () => setSetting('verticalTabs', !settings.data.verticalTabs) },
    { label: 'Show bookmarks bar', type: 'checkbox', checked: settings.data.showBookmarksBar, accelerator: 'Ctrl+Shift+B',
      click: () => setSetting('showBookmarksBar', !settings.data.showBookmarksBar) },
    { type: 'separator' },
    { label: `Zoom (${zoomPct}%)`, submenu: [
      { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => zoom(wc, 0.5) },
      { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => zoom(wc, -0.5) },
      { label: 'Reset', accelerator: 'Ctrl+0', click: () => zoom(wc, 0) },
    ] },
    { label: 'Find on page…', accelerator: 'Ctrl+F', click: () => { uiSend(w, 'find-open'); w.ui.webContents.focus(); } },
    { label: 'Translate page…', enabled: !!(t && /^https:/.test(tabUrl(t))), click: () => showTranslateMenu(w) },
    { label: 'Reader mode', accelerator: 'F9', enabled: !!(t && t.readerable), click: () => openReader(t) },
    { label: 'Take screenshot', accelerator: 'Ctrl+Shift+S', enabled: !!wc, click: () => screenshot(w) },
    { label: 'Picture in picture', enabled: !!wc, click: () => pictureInPicture(wc) },
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
    { label: settings.data.verticalTabs ? 'Turn off vertical tabs' : 'Turn on vertical tabs', click: () => setSetting('verticalTabs', !settings.data.verticalTabs) },
    { type: 'separator' },
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Duplicate', click: () => createTab(w, tabUrl(t), { openerId: t.id }) },
    { label: t.pinned ? 'Unpin tab' : 'Pin tab', click: () => togglePin(t) },
    { label: 'Put tab to sleep', enabled: t.id !== w.activeId && !t.sleeping, click: () => sleepTab(t, true) },
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
  if (key === 'shortcutsMode' && !['mostVisited', 'custom'].includes(value)) return false;
  if (key === 'sleepAfter' && ![0, 5, 15, 30, 60, 120].includes(value)) return false;
  if (key === 'passwordManager' && !['bitwarden', 'none'].includes(value)) return false;
  if (key === 'shortcutsMode' && value === 'custom' && !settings.data.shortcuts.length) {
    settings.data.shortcuts = topSites().map(x => ({ title: x.title, url: x.url })); // start from what's showing now
  }
  if (key === 'homePage') value = toUrl(value);
  settings.data[key] = value;
  settings.save();
  if (key === 'theme') nativeTheme.themeSource = value;
  if (key === 'adblock') applyAdblock();
  if (key === 'passwordManager' && value === 'bitwarden') ensureBitwarden(true);
  if (key === 'incognitoScreenProtection') for (const x of windows) if (x.incognito) x.win.setContentProtection(value);
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
  url = cleanUrl(url);
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
uiOn('page-rect', (w, r) => {
  const x = Math.round(Number(r && r.x)), y = Math.round(Number(r && r.y));
  if (!(x >= 0 && x < 800 && y > 0 && y < 400) || (x === w.pageX && y === w.pageY)) return;
  w.pageX = x; w.pageY = y;
  layout(w);
});
uiOn('overlay', (w, open) => {
  setOverlay(w, !!open);
  if (!open && !w.ui.webContents.isFocused()) activeTab(w)?.view.webContents.focus();
});
uiOn('store-install', async (w, id) => {
  uiSend(w, 'store-busy', true);
  const res = await installExtension(id);
  uiSend(w, 'store-busy', false);
  if (!res.ok) dialog.showMessageBox(w.win, { type: 'warning', title: 'CloudBrowser', message: 'Couldn’t add the extension', detail: res.error });
  sendStateAll();
});
uiOn('store-remove', async (w, id) => { await removeExtension(id); sendStateAll(); });
uiOn('shield-menu', w => showShieldMenu(w));
uiOn('translate-menu', w => showTranslateMenu(w));
uiOn('pin-extension', (_w, id) => {
  const list = settings.data.pinnedExtensions || [];
  settings.data.pinnedExtensions = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
  settings.save();
  sendStateAll();
});
uiOn('manage-extensions', w => openInternal(w, 'extensions'));
uiOn('open-web-store', w => createTab(normalWindow(), 'https://chromewebstore.google.com/category/extensions'));
uiOn('reader', w => { const t = activeTab(w); if (t) openReader(t); });
uiOn('reset-zoom', w => { const wc = activeTab(w)?.view.webContents; if (wc) { wc.setZoomLevel(0); sendState(w); } });
uiOn('focus-tab', (_w, id) => { const t = getTab(id); if (t) { switchTab(t.w, t.id); t.w.win.focus(); } });
uiOn('move-tab', (w, id, toIndex) => {
  const t = w.tabs.find(x => x.id === id);
  if (!t) return;
  const from = w.tabs.indexOf(t);
  w.tabs.splice(from, 1);
  const pinnedCount = w.tabs.filter(x => x.pinned).length;
  let to = Math.max(0, Math.min(w.tabs.length, Number(toIndex) || 0));
  to = t.pinned ? Math.min(to, pinnedCount) : Math.max(to, pinnedCount); // pinned tabs stay first
  w.tabs.splice(to, 0, t);
  sendState(w);
  saveSession();
});
uiOn('address-menu', (w, hasSelection) => {
  const t = activeTab(w);
  const clip = clipboard.readText().trim();
  Menu.buildFromTemplate([
    { role: 'undo' }, { type: 'separator' },
    { role: 'cut', enabled: !!hasSelection }, { role: 'copy', enabled: !!hasSelection }, { role: 'paste', enabled: !!clip },
    { label: clip && !/\s/.test(clip) && /[./:]/.test(clip) ? 'Paste and go' : 'Paste and search', enabled: !!clip,
      click: () => { uiSend(w, 'blur-address'); openUrl(w, toUrl(clip)); } },
    { role: 'selectAll' },
    { type: 'separator' },
    { label: 'Copy page link', enabled: !!t && /^(https?|file):/.test(tabUrl(t)), click: () => clipboard.writeText(tabUrl(t)) },
  ]).popup({ window: w.win });
});
uiOn('vpn-toggle', () => { if (vpn) vpn.setEnabled(!settings.data.vpnEnabled); });
uiOn('vpn-new-ip', () => { if (vpn) vpn.restart(); });
uiOn('vpn-incognito', (_w, on) => { if (vpn) vpn.setIncognitoVpn(!!on); });
uiOn('preconnect', (w, text) => preconnect(w, text));
uiOn('vpn-country', (_w, c) => setVpnCountry(c));
uiOn('vpn-mode', (_w, m) => setVpnMode(m));
uiOn('vpn-import', w => importWgConfig(w));
uiOn('vpn-check-ip', w => createTab(w, 'https://check.torproject.org/'));
uiOn('toggle-vertical', () => setSetting('verticalTabs', !settings.data.verticalTabs));
uiOn('toggle-sidebar', () => setSetting('sidebarCollapsed', !settings.data.sidebarCollapsed));
uiOn('window-control', (w, action) => {
  if (action === 'minimize') w.win.minimize();
  if (action === 'maximize') w.win.isMaximized() ? w.win.unmaximize() : w.win.maximize();
});
uiOn('focus-page', w => activeTab(w)?.view.webContents.focus());
uiOn('make-default', () => makeDefaultBrowser());
uiOn('dismiss-default', () => { settings.data.defaultPromptDismissed = true; settings.save(); sendStateAll(); });
ipcMain.handle('ui:vpn', () => (vpn ? vpn.info() : null));
ipcMain.handle('ui:extensions', () => {
  if (!extensions) return [];
  const pinned = settings.data.pinnedExtensions || [];
  return extSession().extensions.getAllExtensions()
    .filter(e => e.manifest.action || e.manifest.browser_action || true)
    .map(e => ({ id: e.id, name: e.name, icon: iconDataUrl(e), pinned: pinned.includes(e.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
});
ipcMain.handle('ui:suggest', (e, q) => {
  const w = [...windows].find(x => x.ui && x.ui.webContents === e.sender);
  return w ? suggest(q, w.incognito, w) : [];
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
    sites: incognito ? [] : homeShortcuts(),
    mode: settings.data.shortcutsMode,
    show: settings.data.showShortcuts,
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
pageHandle('save-shortcuts', (_ctx, list) => {
  if (!Array.isArray(list)) return homeShortcuts();
  settings.data.shortcuts = list.slice(0, 12).map(x => ({ title: String(x.title || '').slice(0, 60), url: toUrl(String(x.url || '')) }))
    .filter(x => /^(https?|cloud|file):/.test(x.url));
  settings.data.shortcutsMode = 'custom';
  settings.save();
  pagesSend('page:settings', settings.data);
  return homeShortcuts();
});
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
pageHandle('extensions', () => listExtensions());
pageHandle('passwords', () => ({ manager: settings.data.passwordManager, installed: bitwardenInstalled(), available: !!extensions && !!webStoreLib }));
pageHandle('open-bitwarden', (ctx) => { openBitwarden(ctx.tab && ctx.tab.w); return true; });
pageHandle('install-bitwarden', async () => { settings.data.passwordManager = 'bitwarden'; settings.save(); await ensureBitwarden(true); return bitwardenInstalled(); });
pageHandle('reader-article', (_ctx, id) => readerCache.get(Number(id)) || null);
pageHandle('vpn', () => (vpn ? vpn.info() : null));
pageHandle('vpn-toggle', async () => { if (vpn) await vpn.setEnabled(!settings.data.vpnEnabled); return vpn.info(); });
pageHandle('vpn-incognito', async (_ctx, on) => { if (vpn) await vpn.setIncognitoVpn(!!on); return vpn.info(); });
pageHandle('vpn-country', (_ctx, c) => { setVpnCountry(c); return vpn.info(); });
pageHandle('vpn-mode', (_ctx, m) => { setVpnMode(m); return vpn.info(); });
pageHandle('vpn-import', async (ctx) => { await importWgConfig(ctx.tab && ctx.tab.w); return vpn.info(); });
pageHandle('allowlist-remove', (_ctx, host) => { if (isAllowlisted(host)) toggleAllowlist(host); return settings.data.adblockAllowlist; });
pageHandle('install-extension', async (_ctx, id) => installExtension(id));
pageHandle('remove-extension', async (_ctx, id) => removeExtension(id));
pageHandle('extension-options', (ctx, id) => {
  const ext = extSession().extensions.getExtension(id);
  const page = ext && ((ext.manifest.options_ui && ext.manifest.options_ui.page) || ext.manifest.options_page);
  if (page) createTab(normalWindow(), `chrome-extension://${id}/${page}`);
  return !!page;
});
pageHandle('open-web-store', () => { createTab(normalWindow(), 'https://chromewebstore.google.com/category/extensions'); return true; });
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
    extGrants = new Store('extension-permissions', { grants: {} });
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

    // Look like plain Chrome to websites (some sites, e.g. Google sign-in, refuse "Electron").
    const ua = session.defaultSession.getUserAgent().replace(/\s(Electron|cloudbrowser|CloudBrowser)\/\S+/g, '');
    app.userAgentFallback = ua;
    for (const p of [NORMAL_PARTITION, PRIVATE_PARTITION]) session.fromPartition(p).setUserAgent(ua);

    nativeTheme.on('updated', () => {
      for (const w of windows) { try { w.win.setTitleBarOverlay(titleBarColors(w.incognito)); } catch {} }
    });

    vpn = new Vpn({ settings, normalPartition: NORMAL_PARTITION, privatePartition: PRIVATE_PARTITION, log, onChange: vpnChanged });
    await vpn.applyKillSwitch(); // nothing loads outside the VPN if it's switched on
    if (settings.data.vpnEnabled) vpn.ensure();
    setupPrivacyHeaders();
    setInterval(sleepIdleTabs, 60 * 1000);

    await setupExtensions();
    startWindows(argUrl(process.argv));
    setTimeout(() => ensureBitwarden().catch(e => log('Bitwarden setup error', e.message)), 3000);
    setupUpdater();
    setupAdblock();
    registerAsBrowser().then(() => checkDefaultBrowser(true));
    if (SMOKE) setTimeout(smokeTest, 1500);
  });

  app.on('before-quit', (e) => {
    if (!quitting) { quitting = true; saveSession(true); }
    if (settings && settings.data.clearOnExit && !clearedOnExit) {
      e.preventDefault();
      clearedOnExit = true;
      clearData({ history: true, cookies: true, cache: true })
        .catch(() => {})
        .finally(() => { flushAll(); app.quit(); });
      return;
    }
    if (vpn) vpn.shutdown();
    flushAll();
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- automated smoke test (CI only: CLOUD_SMOKE=1) ----------

function powershell(script) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 30000 }, (err, out, errOut) => resolve(err ? 'ERR ' + err.message + ' ' + errOut : String(out))));
}
const MOUSE_PS = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[M]::SetProcessDPIAware() | Out-Null
`;
function realDrag(x, y, dx, dy) {
  return powershell(MOUSE_PS + `[M]::SetCursorPos(${x},${y}); Start-Sleep -m 250; [M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 250
for ($i = 1; $i -le 12; $i++) { [M]::SetCursorPos(${x} + [int](${dx} * $i / 12), ${y} + [int](${dy} * $i / 12)); Start-Sleep -m 40 }
Start-Sleep -m 250; [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); 'ok'`);
}
function realClick(x, y) {
  return powershell(MOUSE_PS + `[M]::SetCursorPos(${x},${y}); Start-Sleep -m 250; [M]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 80; [M]::mouse_event(4,0,0,0,[UIntPtr]::Zero); 'ok'`);
}

async function smokeTest() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const S = (...a) => log('[SMOKE]', ...a);
  const screen = async (name) => {
    try {
      const { desktopCapturer } = require('electron');
      const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 800 } });
      const img = src.thumbnail;
      const b64 = (img.getSize().width > 1000 ? img.resize({ width: 1000 }) : img).toJPEG(78).toString('base64');
      log(`[SHOT-BEGIN ${name}]`);
      for (let i = 0; i < b64.length; i += 3000) log('[SHOT] ' + b64.slice(i, i + 3000));
      log(`[SHOT-END ${name}]`);
    } catch (e) { S('screen capture failed', e.message); }
  };
  const step = async (name, fn) => { try { await fn(); } catch (e) { S('STEP FAILED', name, e && e.stack || String(e)); } };
  const ui = (w, js) => w.ui.webContents.executeJavaScript(js).catch(e => 'ERR ' + e.message);

  await wait(4000);
  const w = currentWindow();
  w.win.setBounds({ x: 0, y: 0, width: 1024, height: 740 });
  w.win.focus();
  await wait(600);
  const t = activeTab(w);
  S('version', app.getVersion());

  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(1000); } return false; };

  await step('bitwarden default', async () => {
    const ok = await waitFor(() => bitwardenInstalled() && settings.data.bitwardenSetupDone, 90000);
    S('bitwarden auto-installed', ok, 'pinned', (settings.data.pinnedExtensions || []).includes(BITWARDEN_ID), 'manager', settings.data.passwordManager, 'user language', userLanguage());
    await wait(2000);
    openBitwarden(w);
    await wait(4000);
    await screen('bitwarden-shortcut');
    w.win.focus();
    await wait(800);
  });

  await step('translate', async () => {
    load(t.view.webContents, 'https://fr.wikipedia.org/wiki/Nuage');
    await waitFor(() => !t.view.webContents.isLoading(), 20000);
    await wait(2500);
    S('page language', t.pageLang, 'translatable', tabInfo(t).translatable, 'title', t.view.webContents.getTitle());
    await screen('french-page');
    translateTab(t);
    await waitFor(() => isTranslated(tabUrl(t)) && !t.view.webContents.isLoading(), 30000);
    await wait(4000);
    S('translated url', tabUrl(t).slice(0, 120), 'title', t.view.webContents.getTitle(), 'back to original ->', originalUrl(tabUrl(t)).slice(0, 80));
    await screen('translated');
    S('url round trip', originalUrl(translatedUrl('https://sub-domain.example.co.uk/a/b?x=1#h', 'en')));
  });

  await step('home + logo', async () => {
    load(t.view.webContents, NEWTAB_URL);
    await wait(2000);
    await screen('home');
  });

  S('DONE');
  flushAll();
  if (vpn) vpn.shutdown();
  setTimeout(() => app.exit(0), 500);
}
