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
  protocol, nativeTheme, clipboard, nativeImage, Notification, desktopCapturer, webContents,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { Store, flushAll } = require('./store');
const { Vpn } = require('./vpn');
const { DiscordLite, isDiscordHost } = require('./discord-lite');
const { baseDomain, companyOf } = require('./trackers');

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
  sidebarAppsEnabled: true,     // the app rail on the right
  sidebarApps: [
    { id: 'discord', title: 'Discord', url: 'https://discord.com/app' },
    { id: 'ytmusic', title: 'YouTube Music', url: 'https://music.youtube.com/' },
    { id: 'vrchat', title: 'VRChat', url: 'https://vrchat.com/home' },
  ],
  sidebarWidth: 440,
  siteZoom: {},                 // zoom you chose per site, remembered
  memorySaver: true,            // low on memory: put unused tabs to sleep sooner
  ytLite: {                     // YouTube Lite (with sponsorBlock, hideShorts and autoPip above)
    enabled: true, dislikes: true, quality: 'max', rememberSpeed: true, skipAds: true, navyTheme: true,
    hideComments: false, hideRelated: false, hideHomeFeed: false, hideEndCards: true,
  },
  robloxLite: { enabled: true, serverBrowser: true, navyTheme: true },
  blockAutoplay: false,         // videos only start with sound after you click
  linkPreview: true,            // show where a link goes when you hover it
  discordLite: true,            // the Discord sidebar app runs Discord Lite (Vencord, plugins, logger, themes)
  sponsorBlock: true,
  sponsorCategories: ['sponsor', 'selfpromo', 'interaction'],
  hideShorts: true,
  autoPip: true,
  vrMode: 'auto',               // auto | off
  uiScale: 100,                 // 100 | 125 | 150
  neverTranslate: [],           // language codes never offered
  clearOnExit: false,
  shortcuts: [],                // [{ title, url }] when shortcutsMode is 'custom'
  window: null,               // { width, height, maximized }
};
const INTERNAL_SETTINGS = new Set(['ytLite', 'robloxLite', 'siteZoom', 'blockedTotal', 'window', 'hiddenSites', 'homeVersion', 'shortcuts',
  'vpnEnabled', 'vpnMode', 'vpnCountry', 'vpnWgConfigName', 'adblockAllowlist', 'pinnedExtensions', 'incognitoVpn',
  'bitwardenSetupDone', 'alwaysTranslate', 'neverTranslate', 'sidebarApps', 'sponsorCategories']);

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
// display-capture: screen sharing always goes through CloudBrowser's own "Choose what to share" window.
const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'display-capture']);
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

// Start-up timing (milliseconds since the process started), for the performance check.
const PERF_T0 = Date.now() - Math.round(process.uptime() * 1000);
const perfMarks = {};
function mark(name) { if (!(name in perfMarks)) perfMarks[name] = Date.now() - PERF_T0; }

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
  if (u.hostname === 'discord-log' && u.pathname.startsWith('/file/')) {
    const name = decodeURIComponent(u.pathname.slice(6));
    const body = discordLite && discordLite.keptFile(name);
    if (!body) return new Response('Not found', { status: 404 });
    const ext = path.extname(name).toLowerCase();
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }[ext] || 'application/octet-stream';
    return new Response(body, { headers: { 'content-type': type } });
  }
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

let statePushes = 0;
let systemLanguage = null;
let bookmarksRev = 1;
function sendState(w) {
  if (!w || w.stateQueued) return;
  w.stateQueued = true;
  setTimeout(() => { w.stateQueued = false; statePushes++; pushState(w); }, 33);
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
    autoRefresh: t.autoRefresh ? t.autoRefresh.secs : 0,
    readerable: !!t.readerable,
    zoom: Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100),
    adblockOff: isAllowlisted(hostOf(url)),
    translatable: canTranslate(t),
    lite: (() => { const a = liteAppFor(tabUrl(t)); return a ? LITE_OPTIONS[a].title : null; })(),
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
    // Bookmarks only when they've changed since this toolbar last got them.
    bookmarks: w.bookmarksRev === bookmarksRev ? undefined : (w.bookmarksRev = bookmarksRev, bookmarks.data.items.map(b => ({ id: b.id, url: b.url, title: b.title, favicon: b.favicon }))),
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
    sidebar: (!w.incognito && settings.data.sidebarAppsEnabled) ? {
      apps: settings.data.sidebarApps.map(a => ({ ...a, badge: panelBadge(w, a.id) })),
      open: w.panelApp,
    } : null,
    media: currentMedia && currentMedia.info ? { ...currentMedia.info, sourceTitle: currentMedia.label } : null,
    vrActive,
    uiScale: settings.data.uiScale,
    split: splitInfo(w),
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
  const panelOpen = !w.htmlFullscreen && w.panelApp && w.panelViews.has(w.panelApp);
  const panelW = panelOpen ? Math.min(settings.data.sidebarWidth, Math.max(0, width - x - w.railW - 320)) : 0;
  const right = w.htmlFullscreen ? 0 : w.railW + panelW;
  const areaW = Math.max(0, width - x - right), areaH = Math.max(0, height - y);
  const sp = splitShowing(w);
  w.splitGeom = null;
  for (const t of w.tabs) {
    let b;
    if (sp && (t.id === sp.a || t.id === sp.b)) {
      const leftW = Math.round((areaW - SPLIT_GAP) * sp.ratio);
      const isA = t.id === sp.a;
      b = isA ? { x, y, width: leftW, height: areaH } : { x: x + leftW + SPLIT_GAP, y, width: Math.max(0, areaW - leftW - SPLIT_GAP), height: areaH };
      if (isA) w.splitGeom = { x0: x, w: areaW, y, h: areaH, divX: x + leftW, leftW };
    } else {
      b = { x, y, width: areaW, height: areaH };
    }
    const visible = t.id === w.activeId || !!(sp && (t.id === sp.a || t.id === sp.b));
    // Each of these is a trip into Chromium, so only make it when something changed.
    // Hidden tabs keep their old size until they're shown (they're resized just before).
    const key = `${b.x},${b.y},${b.width},${b.height}`;
    if (visible && t.boundsKey !== key) { t.view.setBounds(b); t.boundsKey = key; }
    if (t.shown !== visible) {
      if (!visible && t.boundsKey !== key) { t.view.setBounds(b); t.boundsKey = key; }
      t.view.setVisible(visible);
      t.shown = visible;
    }
  }
  for (const [id, v] of w.panelViews) {
    const show = panelOpen && id === w.panelApp;
    v.setVisible(show);
    if (show) v.setBounds({ x: width - w.railW - panelW, y, width: panelW, height: Math.max(0, height - y) });
  }
  w.ui.setBounds({ x: 0, y: 0, width, height });
}

function setOverlay(w, open) {
  w.overlayOpen = open;
  if (open) w.win.contentView.addChildView(w.ui); // lift the UI above the page
  else {
    for (const t of w.tabs) w.win.contentView.addChildView(t.view); // pages back on top
    for (const v of w.panelViews.values()) w.win.contentView.addChildView(v);
    if (w.hud) w.win.contentView.addChildView(w.hud);
  }
  layout(w);
}

function titleBarColors(incognito) {
  const height = Math.round(TITLEBAR_HEIGHT * ((settings && settings.data.uiScale) || 100) / 100);
  if (incognito) return { color: '#15111e', symbolColor: '#ece6fb', height };
  return { color: '#07101b', symbolColor: '#ffffff', height }; // Discord Lite navy
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
    pageX: 0, pageY: 84, railW: 0, panelApp: null, panelViews: new Map(), split: null, overlayOpen: false, htmlFullscreen: false, userFullscreen: false, stateQueued: false,
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
  w.ui.webContents.on('did-finish-load', () => { w.bookmarksRev = 0; applyUiScale(w); mark('toolbar shown'); });
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
  w.win.on('app-command', (_e, cmd) => {
    const wc = activeTab(w)?.view.webContents;
    if (!wc) return;
    if (cmd === 'browser-backward' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (cmd === 'browser-forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (cmd === 'browser-refresh') wc.reload();
  });
  w.win.on('closed', () => {
    // Remember it for "Reopen closed window" (Ctrl+Shift+T).
    if (!w.incognito && !quitting && w.tabs.length) {
      const tabs = w.tabs.map(t => ({ url: tabUrl(t), pinned: !!t.pinned })).filter(x => x.url && !x.url.startsWith('data:'));
      if (tabs.length) closedWindows.push({ tabs, at: Date.now() });
      if (closedWindows.length > 5) closedWindows.shift();
    }
    for (const t of w.tabs) { clearAutoRefresh(t); try { t.view.webContents.close(); } catch {} }
    for (const [id, v] of w.panelViews) {
      // Discord keeps running (moves to another window) so its notifications keep coming.
      const other = id === discordAppId() && !quitting && [...windows].find(o => o !== w && !o.incognito);
      if (other && !other.panelViews.has(id)) { other.panelViews.set(id, v); other.win.contentView.addChildView(v); layout(other); continue; }
      try { v.webContents.close(); } catch {}
    }
    if (currentMedia && currentMedia.w === w) currentMedia = null;
    try { if (w.hud) w.hud.webContents.close(); } catch {}
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
      autoplayPolicy: settings.data.blockAutoplay ? 'document-user-activation-required' : 'no-user-gesture-required',
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
  else { view.setVisible(false); tab.shown = false; }
  sendState(w);
  saveSession();
  return tab;
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  const update = () => sendState(tab.w);

  wc.on('did-start-loading', update);
  wc.on('did-stop-loading', () => {
    update();
    saveSession();
    setTimeout(() => { if (!wc.isDestroyed() && !wc.isLoading()) { checkReaderable(tab); detectLanguage(tab); } }, 400);
  });
  wc.on('audio-state-changed', update);
  wc.on('media-started-playing', () => mediaEvent({ kind: 'tab', tab }, true));
  wc.on('media-paused', () => mediaEvent({ kind: 'tab', tab }, false));
  wc.on('page-title-updated', (_e, title) => {
    if (tab.histEntry && tab.histEntry.url === wc.getURL()) { tab.histEntry.title = title; history.save(); }
    update();
  });
  wc.once('did-finish-load', () => mark('first page loaded'));
  wc.on('did-navigate', (_e, url) => {
    applySiteZoom(wc, url);
    tab.readerable = false;
    tab.pageLang = null;
    if (!url.startsWith('data:')) tab.failedUrl = null;
    tab.blocked = 0;
    tab.favicon = null;
    recordHistory(tab, url);
    update();
    saveSession();
  });
  // Sites like YouTube change page without a full load: keep the address bar, history and page tools in step.
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (!isMain) return;
    const prev = tab.histEntry ? tab.histEntry.url : '';
    if (url.split('#')[0] !== prev.split('#')[0]) {
      tab.readerable = false;
      recordHistory(tab, url);
    }
    update();
    saveSession();
  });
  // Clicking into the page ends any address-bar editing, so the bar shows where you really are.
  wc.on('focus', () => {
    if (!tab.w || tab.popped) return;
    if (tab.w.activeId !== tab.id && sameSplit(tab.w, tab.w.activeId, tab.id) && splitShowing(tab.w)) switchTab(tab.w, tab.id); // clicked the other pane
    if (tab.w.activeId === tab.id) uiSend(tab.w, 'blur-address');
  });
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
  wc.on('update-target-url', (_e, url) => { if (isOnScreen(tab) && !tab.popped) showLinkPreview(tab.w, tab, url); });
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
  if (prevTab && prevTab.id !== id) {
    prevTab.lastActive = Date.now();
    if (settings.data.autoPip && !sameSplit(w, prevTab.id, id) && isYouTube(tabUrl(prevTab)) && prevTab.view.webContents.isCurrentlyAudible()) pipEnter(prevTab.view.webContents);
  }
  if (prevTab && prevTab.id !== id && isYouTube(tabUrl(t))) pipExit(t.view.webContents);
  w.activeId = id;
  t.lastActive = Date.now();
  if (t.sleeping) wakeTab(t);
  layout(w); // shows this tab (and its split-view partner)
  if (extensions && !w.incognito) { try { extensions.selectTab(t.view.webContents); } catch {} }
  if (!w.overlayOpen) t.view.webContents.focus();
  sendState(w);
  saveSession();
}

function closeTab(id) {
  const t = getTab(id);
  if (!t) return;
  const w = t.w;
  if (w.split && (w.split.a === id || w.split.b === id)) w.split = null;
  clearAutoRefresh(t);
  const idx = w.tabs.indexOf(t);
  w.tabs.splice(idx, 1);
  const url = tabUrl(t);
  if (url && !url.startsWith('data:')) {
    w.closedTabs.push(url);
    w.lastClosedTabAt = Date.now();
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
  rememberZoom(wc, level);
}
// Zoom is remembered per site (not in incognito), like Chrome.
function rememberZoom(wc, level) {
  const host = hostOf(wc.getURL());
  if (!host || wc.session === session.fromPartition(PRIVATE_PARTITION)) return;
  if (level === 0) delete settings.data.siteZoom[host]; else settings.data.siteZoom[host] = level;
  settings.save();
}
function applySiteZoom(wc, url) {
  const host = hostOf(url);
  if (!host) return;
  const level = settings.data.siteZoom[host];
  if (level != null && wc.getZoomLevel() !== level) wc.setZoomLevel(level);
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
      if (state === 'completed') {
        uiSendAll('download-done', { filename: d.filename });
        // Not looking at CloudBrowser? Tell Windows.
        if (!BaseWindow.getFocusedWindow() && !item.getURL().startsWith('blob:') && Notification.isSupported()) {
          try {
            const n = new Notification({ title: 'Download complete', body: d.filename || 'Your download finished', icon: path.join(__dirname, 'ui', 'icon.png') });
            n.on('click', () => { if (d.path) shell.showItemInFolder(d.path); });
            n.show();
          } catch {}
        }
      }
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
      if (!PROMPT_PERMISSIONS[permission] || SILENT_DENY.has(permission)) { if (SMOKE) log('permission refused:', permission); return callback(false); }
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

    // Busy pages block hundreds of things; count them cheaply and update the toolbar a few times a second.
    const tabsByWc = () => { const m = new Map(); for (const x of allTabs()) if (!x.view.webContents.isDestroyed()) m.set(x.view.webContents.id, x); return m; };
    let pendingBlocked = 0, dirtyWins = new Set(), flushTimer = null, lookup = null;
    blocker.on('request-blocked', (request) => {
      if (!lookup) lookup = tabsByWc();
      const t = lookup.get(request.tabId);
      if (t) { t.blocked++; dirtyWins.add(t.w); }
      if (t && !t.private) recordBlocked(tabUrl(t), request.hostname || request.domain || '');
      pendingBlocked++;
      if (!flushTimer) flushTimer = setTimeout(() => {
        flushTimer = null; lookup = null;
        settings.data.blockedTotal = (settings.data.blockedTotal || 0) + pendingBlocked;
        pendingBlocked = 0;
        settings.save();
        privacyStats.save();
        for (const w of dirtyWins) sendState(w);
        dirtyWins = new Set();
      }, 300);
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
    { label: 'Privacy report', click: () => openInternal(w, 'privacy') },
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
    // Quick check first so most pages never load the (large) Readability script.
    const likely = await wc.executeJavaScriptInIsolatedWorld(1001, [{
      code: `[...document.querySelectorAll('p')].filter(p => (p.textContent || '').length > 120).length >= 4`,
    }]);
    if (!likely) { if (tab.readerable) { tab.readerable = false; sendState(tab.w); } return; }
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

// Google refuses sign-in from browsers it doesn't recognise ("This browser or app may not be
// secure"). CloudBrowser runs on Chrome's engine but its hidden "brand" hints say Chromium/
// Electron, not Google Chrome. On Google's sign-in pages it sends the same brand hints as
// Google Chrome (headers here, page-visible values in preload-page.js).
function isGoogleSignIn(url) {
  try { const h = new URL(url).hostname; return h === 'accounts.google.com' || h === 'accounts.youtube.com'; } catch { return false; }
}

// "Do not sell or share my data" signals, and less revealing referrers. Incognito never tells
// another site which page you came from.
function setupPrivacyHeaders() {
  for (const [p, isPrivate] of [[NORMAL_PARTITION, false], [PRIVATE_PARTITION, true]]) {
    // Only pages, frames and data requests: skipping images/scripts/fonts keeps the main process free.
    session.fromPartition(p).webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame', 'xhr'] }, (details, callback) => {
      const h = details.requestHeaders;
      if (settings.data.sendGpc) { h['Sec-GPC'] = '1'; h['DNT'] = '1'; }
      if (isGoogleSignIn(details.url)) {
        const major = process.versions.chrome.split('.')[0];
        for (const k of Object.keys(h)) {
          const lk = k.toLowerCase();
          if (lk === 'sec-ch-ua' && !/Google Chrome/.test(h[k])) h[k] = `${h[k]}, "Google Chrome";v="${major}"`;
          if (lk === 'sec-ch-ua-full-version-list' && !/Google Chrome/.test(h[k])) h[k] = `${h[k]}, "Google Chrome";v="${process.versions.chrome}"`;
        }
      }
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
  const l = systemLanguage || (systemLanguage = (app.getPreferredSystemLanguages && app.getPreferredSystemLanguages()[0]) || app.getLocale() || 'en');
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

let discordLite = null;
function dlNotify(title, body, onClick) {
  try {
    const n = new Notification({ title, body, icon: path.join(__dirname, 'discord-lite', '128x128.png'), silent: false });
    n.on('click', () => { (onClick || showDiscord)(); });
    n.show();
  } catch (e) { log('notification failed', e.message); }
}

// ---------- privacy report ----------
// Counts of what was blocked, per day, per site and per tracker. Kept for 30 days, never for incognito.

let privacyStats = null;
function dayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function recordBlocked(pageUrl, host) {
  if (!privacyStats) return;
  const days = privacyStats.data.days;
  const k = dayKey();
  let d = days[k];
  if (!d) {
    d = days[k] = { total: 0, sites: {}, trackers: {} };
    const cutoff = dayKey(new Date(Date.now() - 31 * 864e5));
    for (const key of Object.keys(days)) if (key < cutoff) delete days[key];
  }
  d.total++;
  const site = hostOf(pageUrl).replace(/^www\./, '');
  if (site) d.sites[site] = (d.sites[site] || 0) + 1;
  const tr = baseDomain(host);
  if (tr) d.trackers[tr] = (d.trackers[tr] || 0) + 1;
  // Keep each day small: drop the long tail once it gets big.
  for (const key of ['sites', 'trackers']) {
    const o = d[key], n = Object.keys(o).length;
    if (n > 400) for (const [name] of Object.entries(o).sort((a, b) => a[1] - b[1]).slice(0, n - 300)) delete o[name];
  }
}
function privacyReport(range) {
  const days = privacyStats ? privacyStats.data.days : {};
  const n = range === 30 ? 30 : 7;
  const list = [];
  const sites = {}, trackers = {};
  for (let i = n - 1; i >= 0; i--) {
    const k = dayKey(new Date(Date.now() - i * 864e5));
    const d = days[k];
    list.push({ date: k, total: d ? d.total : 0 });
    if (!d) continue;
    for (const [h, c] of Object.entries(d.sites)) sites[h] = (sites[h] || 0) + c;
    for (const [h, c] of Object.entries(d.trackers)) trackers[h] = (trackers[h] || 0) + c;
  }
  const companies = {};
  for (const [dom, c] of Object.entries(trackers)) {
    const name = companyOf(dom) || dom;
    const x = companies[name] || (companies[name] = { name, known: !!companyOf(dom), own: !companyOf(dom) && Object.keys(sites).some(h => h === dom || h.endsWith('.' + dom)), count: 0, domains: [] });
    x.count += c;
    x.domains.push(dom);
  }
  return {
    days: list,
    total: list.reduce((a, d) => a + d.total, 0),
    allTime: settings.data.blockedTotal || 0,
    companies: Object.values(companies).sort((a, b) => b.count - a.count).slice(0, 15).map(c => ({ ...c, domains: c.domains.slice(0, 6) })),
    sites: Object.entries(sites).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([host, count]) => ({ host, count, allowed: isAllowlisted(host) })),
    protections: {
      adblock: !!settings.data.adblock, vpn: !!settings.data.vpnEnabled, vpnMode: settings.data.vpnMode,
      gpc: !!settings.data.sendGpc, stripTracking: !!settings.data.stripTracking, incognitoVpn: !!settings.data.incognitoVpn,
      clearOnExit: !!settings.data.clearOnExit, allowlist: (settings.data.adblockAllowlist || []).length,
    },
  };
}
pageHandle('privacy-report', (_ctx, range) => privacyReport(Number(range)));
pageHandle('privacy-reset', () => { privacyStats.data.days = {}; privacyStats.save(); return privacyReport(7); });
// "Forget this site": its cookies, storage, cache and history.
pageHandle('forget-site', async (_ctx, host) => {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('Bad site');
  const ses = session.fromPartition(NORMAL_PARTITION);
  let cookies = 0;
  for (const c of await ses.cookies.get({})) {
    const d = (c.domain || '').replace(/^\./, '');
    if (d === host || d.endsWith('.' + host)) {
      const url = `http${c.secure ? 's' : ''}://${d}${c.path || '/'}`;
      await ses.cookies.remove(url, c.name).catch(() => {});
      cookies++;
    }
  }
  for (const origin of [`https://${host}`, `https://www.${host}`, `http://${host}`, `http://www.${host}`]) {
    await ses.clearStorageData({ origin }).catch(() => {});
  }
  const before = history.data.items.length;
  history.data.items = history.data.items.filter(h => { const x = hostOf(h.url).replace(/^www\./, ''); return x !== host && !x.endsWith('.' + host); });
  history.save();
  for (const k of Object.keys(permissions.data.sites)) if (hostOf(k).replace(/^www\./, '') === host) delete permissions.data.sites[k];
  permissions.save();
  return { cookies, history: before - history.data.items.length };
});

// ---------- small everyday helpers ----------

// A little layer above the pages for the link preview (bottom-left) and short messages (bottom-centre).
function hud(w) {
  if (w.hud && !w.hud.webContents.isDestroyed()) return w.hud;
  const v = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
  v.setBackgroundColor('#00000000');
  v.setVisible(false);
  const css = `html,body{margin:0;background:transparent;overflow:hidden;font:12.5px "Segoe UI",system-ui,sans-serif}
    #b{position:fixed;left:0;bottom:0;max-width:100%;box-sizing:border-box;padding:4px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      background:#0c1624;color:#e8edf3;border:1px solid #323b48;border-radius:0 7px 0 0}
    #b.toast{left:50%;transform:translateX(-50%);bottom:4px;border-radius:9px;padding:8px 16px;background:#fff;color:#07101b;font-weight:600;border:0;box-shadow:0 4px 16px rgba(0,0,0,.35)}`;
  v.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><style>${css}</style><div id="b"></div>`));
  w.hud = v;
  w.win.contentView.addChildView(v);
  return v;
}
function hudShow(w, text, mode, anchor) {
  const v = hud(w);
  const { width, height } = w.win.getContentBounds();
  const isToast = mode === 'toast';
  const est = Math.min(isToast ? 420 : Math.max(120, (anchor ? anchor.width : width) * 0.6), 24 + text.length * (isToast ? 7.6 : 6.6));
  const h = isToast ? 46 : 24;
  const x = isToast ? Math.round((anchor ? anchor.x + anchor.width / 2 : width / 2) - est / 2) : (anchor ? anchor.x : w.pageX);
  const y = (anchor ? anchor.y + anchor.height : height) - h - (isToast ? 48 : 0); // messages float a little above the bottom
  v.setBounds({ x: Math.max(0, x), y: Math.max(0, y), width: Math.round(est), height: h });
  v.webContents.executeJavaScript(`(() => { const b = document.getElementById('b'); b.className = ${JSON.stringify(isToast ? 'toast' : '')}; b.textContent = ${JSON.stringify(text)}; })()`).catch(() => {});
  w.win.contentView.addChildView(v); // on top
  v.setVisible(true);
}
function hudHide(w) { if (w.hud && !w.hud.webContents.isDestroyed()) w.hud.setVisible(false); }

let linkPreviewTimer = null;
function showLinkPreview(w, tab, url) {
  if (!settings.data.linkPreview || w.toastUntil > Date.now()) return;
  clearTimeout(linkPreviewTimer);
  if (!url) { linkPreviewTimer = setTimeout(() => hudHide(w), 120); return; }
  let text = url;
  try { text = decodeURI(url); } catch {}
  text = text.replace(/^https:\/\//, '').replace(/^(mailto|tel):/, '$1: ');
  hudShow(w, text, 'link', tab.view.getBounds());
}
function toast(w, text) {
  if (!w || !w.win || w.win.isDestroyed()) return;
  w.toastUntil = Date.now() + 2000;
  const t = activeTab(w);
  hudShow(w, text, 'toast', t ? t.view.getBounds() : null);
  clearTimeout(w.toastTimer);
  w.toastTimer = setTimeout(() => { w.toastUntil = 0; hudHide(w); }, 2000);
}

function copyCleanLink(w, url) {
  clipboard.writeText(cleanUrl(url));
  toast(w, cleanUrl(url) !== url ? 'Link copied (tracking removed)' : 'Link copied');
}
// A link that scrolls to and highlights the selected text (works in Chrome, Edge and CloudBrowser).
function highlightLink(url, text) {
  const base = url.split('#')[0];
  const words = text.trim().split(/\s+/);
  const enc = s => encodeURIComponent(s).replace(/-/g, '%2D');
  const frag = words.length > 10 ? `${enc(words.slice(0, 4).join(' '))},${enc(words.slice(-4).join(' '))}` : enc(words.join(' '));
  return `${base}#:~:text=${frag}`;
}

async function showQr(w, url) {
  try {
    const QR = require('qrcode');
    const dataUrl = await QR.toDataURL(url, { margin: 1, width: 360, errorCorrectionLevel: 'M', color: { dark: '#07101bff', light: '#ffffffff' } });
    uiSend(w, 'qr', { dataUrl, url });
    w.ui.webContents.focus();
  } catch (e) { log('QR failed', e.message); toast(w, 'Couldn’t make a QR code for this page'); }
}

// Right-click Back / Forward: the tab's history, like Chrome.
function showNavMenu(w, dir) {
  const t = activeTab(w);
  if (!t) return;
  const h = t.view.webContents.navigationHistory;
  const entries = h.getAllEntries();
  const cur = h.getActiveIndex();
  const idxs = dir === 'back' ? [...Array(cur).keys()].reverse() : [...Array(Math.max(0, entries.length - cur - 1)).keys()].map(i => cur + 1 + i);
  if (!idxs.length) return;
  Menu.buildFromTemplate([
    ...idxs.slice(0, 15).map(i => ({ label: (entries[i].title || entries[i].url).slice(0, 70), click: () => h.goToIndex(i) })),
    { type: 'separator' },
    { label: 'Show full history', accelerator: 'Ctrl+H', click: () => openInternal(w, 'history') },
  ]).popup({ window: w.win });
}

// Right-click Reload: hard reload and auto-refresh.
function showReloadMenu(w) {
  const t = activeTab(w);
  if (!t) return;
  const wc = t.view.webContents;
  Menu.buildFromTemplate([
    { label: 'Reload', accelerator: 'F5', click: () => wc.reload() },
    { label: 'Hard reload (skip the cache)', accelerator: 'Ctrl+Shift+R', click: () => wc.reloadIgnoringCache() },
    { label: 'Empty cache and hard reload', click: async () => { await wc.session.clearCache(); wc.reloadIgnoringCache(); } },
    { type: 'separator' },
    autoRefreshMenu(t),
  ]).popup({ window: w.win });
}

// Auto-refresh a tab every so often (handy for scores, drops, stock pages).
const REFRESH_CHOICES = [[0, 'Off'], [15, 'Every 15 seconds'], [30, 'Every 30 seconds'], [60, 'Every minute'], [300, 'Every 5 minutes'], [900, 'Every 15 minutes'], [1800, 'Every 30 minutes']];
function autoRefreshMenu(t) {
  const cur = t.autoRefresh ? t.autoRefresh.secs : 0;
  return { label: cur ? `Auto-refresh (${REFRESH_CHOICES.find(c => c[0] === cur)[1].toLowerCase()})` : 'Auto-refresh', submenu: REFRESH_CHOICES.map(([secs, label]) => ({
    label, type: 'radio', checked: cur === secs, click: () => setAutoRefresh(t, secs),
  })) };
}
function setAutoRefresh(t, secs) {
  clearAutoRefresh(t);
  if (secs) {
    t.autoRefresh = { secs, timer: setInterval(() => {
      const wc = t.view.webContents;
      if (wc.isDestroyed()) return clearAutoRefresh(t);
      if (t.sleeping || wc.isLoading()) return;
      wc.reload();
    }, secs * 1000) };
    toast(t.w, `This tab refreshes ${REFRESH_CHOICES.find(c => c[0] === secs)[1].toLowerCase()}`);
  }
  sendState(t.w);
}
function clearAutoRefresh(t) { if (t && t.autoRefresh) { clearInterval(t.autoRefresh.timer); t.autoRefresh = null; } }

function duplicateTabs(w) {
  const seen = new Set();
  const dup = [];
  // Keep the active one (and pinned ones) when there are copies.
  const order = [...w.tabs].sort((a, b) => (b.id === w.activeId) - (a.id === w.activeId) || (b.pinned - a.pinned));
  for (const t of order) {
    const u = tabUrl(t).split('#')[0];
    if (!u || u.startsWith(NEWTAB_URL)) continue;
    if (seen.has(u)) dup.push(t); else seen.add(u);
  }
  return dup;
}

const closedWindows = [];
function reopenClosedWindow() {
  const x = closedWindows.pop();
  if (x && x.tabs.length) createWindow({ urls: x.tabs, active: 0 });
}

// ---------- split view: two tabs side by side ----------

const SPLIT_GAP = 6;
function splitShowing(w) {
  const sp = w && w.split;
  if (!sp || w.htmlFullscreen) return null;
  if (w.activeId !== sp.a && w.activeId !== sp.b) return null;
  if (!w.tabs.some(t => t.id === sp.a) || !w.tabs.some(t => t.id === sp.b)) { w.split = null; return null; }
  return sp;
}
function sameSplit(w, a, b) { const sp = w.split; return !!sp && [sp.a, sp.b].includes(a) && [sp.a, sp.b].includes(b); }

function startSplit(w, leftId, rightId) {
  const l = w.tabs.find(t => t.id === leftId);
  if (!l) return;
  let r = rightId != null ? w.tabs.find(t => t.id === rightId) : null;
  if (!r) r = createTab(w, homeUrl(), { activate: false, openerId: l.id });
  if (r.id === l.id) return;
  // Keep the pair next to each other in the tab strip.
  w.tabs.splice(w.tabs.indexOf(r), 1);
  w.tabs.splice(w.tabs.indexOf(l) + 1, 0, r);
  w.split = { a: l.id, b: r.id, ratio: 0.5 };
  if (r.sleeping) wakeTab(r);
  if (r.lazyUrl) switchTab(w, r.id);
  switchTab(w, rightId == null ? r.id : l.id);
  if (rightId == null) focusAddress(w);
}
function endSplit(w) { if (w.split) { w.split = null; layout(w); sendState(w); } }
function swapSplit(w) { if (w.split) { const { a, b } = w.split; w.split = { ...w.split, a: b, b: a, ratio: 1 - w.split.ratio }; layout(w); sendState(w); } }
function toggleSplit(w) {
  if (w.split && splitShowing(w)) return endSplit(w);
  const t = activeTab(w);
  if (!t) return;
  // Pair with the tab you used before this one, or a new tab.
  const other = w.tabs.filter(x => x.id !== t.id).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))[0];
  startSplit(w, t.id, other ? other.id : null);
}
function splitInfo(w) {
  const sp = splitShowing(w);
  if (!sp || !w.splitGeom) return w.split ? { a: w.split.a, b: w.split.b, showing: false } : null;
  const z = (settings.data.uiScale || 100) / 100;
  const g = w.splitGeom;
  return { a: sp.a, b: sp.b, showing: true, active: w.activeId === sp.a ? 'a' : 'b',
    x0: g.x0 / z, w: g.w / z, y: g.y / z, h: g.h / z, divX: g.divX / z, gap: SPLIT_GAP / z, leftW: g.leftW / z };
}

// ---------- sidebar apps (Discord, YouTube Music, VRChat, …) ----------
// Each app is a page docked on the right. It stays alive while hidden, so music keeps playing.

const SIDEBAR_PRESETS = [
  { title: 'Discord', url: 'https://discord.com/app' },
  { title: 'YouTube Music', url: 'https://music.youtube.com/' },
  { title: 'VRChat', url: 'https://vrchat.com/home' },
  { title: 'YouTube', url: 'https://www.youtube.com/' },
  { title: 'Twitch', url: 'https://www.twitch.tv/' },
  { title: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { title: 'Roblox', url: 'https://www.roblox.com/home' },
  { title: 'Reddit', url: 'https://www.reddit.com/' },
];

function panelBadge(w, id) {
  if (discordLite && settings.data.discordLite && id === discordAppId()) {
    if (!discordLite.settings.unreadBadge) return 0;
    return dlBadge.mentions > 0 ? dlBadge.mentions : dlBadge.unread ? -1 : 0;
  }
  const v = w.panelViews.get(id);
  if (!v || v.webContents.isDestroyed()) return 0;
  const m = /^\((\d+)\)|^[•●] /.exec(v.webContents.getTitle() || '');
  return m ? (m[1] ? Number(m[1]) : -1) : 0; // -1 = "something new"
}

function isDiscordApp(app) { try { return isDiscordHost(new URL(app.url).hostname); } catch { return false; } }
function discordAppId() { const a = settings.data.sidebarApps.find(isDiscordApp); return a ? a.id : null; }

function createPanelView(w, app) {
  const v = new WebContentsView({
    webPreferences: { partition: NORMAL_PARTITION, preload: path.join(__dirname, 'preload-page.js'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  v.setBackgroundColor('#07101b');
  const wc = v.webContents;
  if (vpn) vpn.protectContents(wc, false);
  wc.setWindowOpenHandler(({ url }) => { const o = panelOwner(v) || normalWindow(); if (o) { createTab(o, cleanUrl(url)); o.win.focus(); } return { action: 'deny' }; });
  const lite = isDiscordApp(app) && discordLite && settings.data.discordLite;
  if (lite) discordLite.attach(wc); // before loading: Discord Lite injects before Discord's code runs
  // Discord Lite uses Ctrl+Shift+L for its Message Log (instead of Bitwarden) and Ctrl+, for its settings.
  wc.on('before-input-event', (event, input) => {
    const k = (input.key || '').toLowerCase();
    if (lite && input.control && ((input.shift && k === 'l') || (!input.shift && k === ','))) return;
    if (handleShortcut(panelOwner(v) || w, input)) event.preventDefault();
  });
  wc.on('page-title-updated', () => { const o = panelOwner(v); if (o) sendState(o); });
  wc.on('media-started-playing', () => mediaEvent({ kind: 'panel', w: panelOwner(v) || w, appId: app.id, wc }, true));
  wc.on('media-paused', () => mediaEvent({ kind: 'panel', w: panelOwner(v) || w, appId: app.id, wc }, false));
  wc.on('context-menu', (_e, p) => {
    Menu.buildFromTemplate([
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      ...(p.linkURL ? [{ label: 'Open link in new tab', click: () => createTab(w, p.linkURL) }, { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }] : []),
      ...(p.isEditable ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }] : p.selectionText ? [{ role: 'copy' }] : []),
      { label: 'Open in a tab', click: () => createTab(w, wc.getURL()) },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    ]).popup({ window: discordPop && discordPop.view === v ? discordPop.win : (panelOwner(v) || w).win });
  });
  if (extensions) { addingTab = true; try { extensions.addTab(wc, w.win); } catch {} finally { addingTab = false; } }
  w.win.contentView.addChildView(v);
  load(wc, app.url);
  return v;
}

// Which window a sidebar app's page is in right now (Discord can move between windows).
function panelOwner(v) { for (const w of windows) for (const x of w.panelViews.values()) if (x === v) return w; return null; }

function togglePanel(w, id) {
  if (w.incognito || !settings.data.sidebarAppsEnabled) return;
  const app = settings.data.sidebarApps.find(a => a.id === id);
  if (!app) return;
  if (isDiscordApp(app) && discordPop) { discordPop.win.show(); discordPop.win.focus(); return; }
  if (w.panelApp === id) { w.panelApp = null; layout(w); sendState(w); activeTab(w)?.view.webContents.focus(); return; }
  if (!w.panelViews.has(id) && isDiscordApp(app)) {
    // There's only one Discord: bring it over from the window it's in.
    for (const o of windows) {
      const v = o.panelViews.get(id);
      if (!v || o === w) continue;
      o.panelViews.delete(id);
      if (o.panelApp === id) o.panelApp = null;
      o.win.contentView.removeChildView(v);
      layout(o); sendState(o);
      w.panelViews.set(id, v);
      w.win.contentView.addChildView(v);
      break;
    }
  }
  if (!w.panelViews.has(id)) w.panelViews.set(id, createPanelView(w, app));
  w.panelApp = id;
  layout(w);
  w.panelViews.get(id).webContents.focus();
  sendState(w);
}

function closePanel(w) { if (w.panelApp) { w.panelApp = null; layout(w); sendState(w); } }

// Discord running hidden from start-up, so notifications and the logger work straight away.
function startDiscordInBackground() {
  const id = discordAppId();
  if (!id || !settings.data.sidebarAppsEnabled || !discordLite || !discordLite.settings.backgroundStart) return;
  if (discordPop || [...windows].some(o => o.panelViews.has(id))) return;
  const w = normalWindow(false);
  if (!w) return;
  w.panelViews.set(id, createPanelView(w, settings.data.sidebarApps.find(a => a.id === id)));
  layout(w);
}

// Discord in its own window, like the standalone Discord Lite app. Closing it puts Discord
// back in the sidebar (still running), so notifications keep coming.
let discordPop = null;
function popOutDiscord(w) {
  const id = discordAppId();
  if (!id || discordPop) return;
  let owner = [...windows].find(o => o.panelViews.has(id));
  if (!owner) { togglePanel(w, id); owner = w; togglePanel(w, id); }
  const v = owner.panelViews.get(id);
  if (!v) return;
  owner.panelViews.delete(id);
  if (owner.panelApp === id) owner.panelApp = null;
  owner.win.contentView.removeChildView(v);
  layout(owner); sendState(owner);
  const b = owner.win.getBounds();
  const win = new BaseWindow({
    width: Math.min(1280, b.width), height: Math.min(800, b.height), x: b.x + 40, y: b.y + 40, minWidth: 480, minHeight: 360,
    title: 'Discord Lite', icon: path.join(__dirname, 'discord-lite', '128x128.png'), backgroundColor: '#07101b', autoHideMenuBar: true,
  });
  discordPop = { win, view: v, id };
  v.setVisible(true);
  win.contentView.addChildView(v);
  const fit = () => { const c = win.getContentBounds(); v.setBounds({ x: 0, y: 0, width: c.width, height: c.height }); };
  fit();
  win.on('resize', fit);
  win.on('focus', () => v.webContents.focus());
  win.on('closed', () => {
    discordPop = null;
    if (quitting || v.webContents.isDestroyed()) return;
    const target = normalWindow(false);
    if (!target) { try { v.webContents.close(); } catch {} return; }
    target.panelViews.set(id, v);
    target.win.contentView.addChildView(v);
    layout(target); sendStateAll();
  });
  setDiscordBadge();
  sendStateAll();
}

function discordVisible() {
  if (discordPop) return discordPop.win.isVisible() && !discordPop.win.isMinimized();
  const id = discordAppId();
  return [...windows].some(o => o.panelApp === id && o.win.isVisible() && !o.win.isMinimized());
}
function showDiscord() {
  const id = discordAppId();
  if (!id) return;
  if (discordPop) { discordPop.win.show(); discordPop.win.focus(); return; }
  const w = normalWindow();
  if (w.panelApp !== id) togglePanel(w, id);
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
}

// Unread badge: count on the Discord button, red dot on the taskbar button for mentions.
let dlBadge = { mentions: 0, unread: false };
let overlayIcon = null;
function setDiscordBadge() {
  if (!overlayIcon) { try { overlayIcon = nativeImage.createFromPath(path.join(__dirname, 'discord-lite', 'overlay-mention.png')); } catch {} }
  const on = dlBadge.mentions > 0;
  const text = on ? `${dlBadge.mentions} Discord mention${dlBadge.mentions === 1 ? '' : 's'}` : '';
  for (const o of windows) if (!o.incognito) { try { o.win.setOverlayIcon(on ? overlayIcon : null, text); } catch {} }
  if (discordPop) { try { discordPop.win.setOverlayIcon(on ? overlayIcon : null, text); } catch {} }
}

// Screen sharing (Discord, Meet, …): a "Choose what to share" window with thumbnails.
let sharePending = null;
function setupScreenShare(sess) {
  sess.setDisplayMediaRequestHandler(async (request, callback) => {
    if (sharePending) { try { sharePending.finish(null); } catch {} }
    let done = false;
    const finish = (choice) => {
      if (done) return; done = true;
      const p = sharePending; sharePending = null;
      if (p && p.win && !p.win.isDestroyed()) p.win.close();
      const src = choice && p && p.sources.find(x => x.id === choice.id);
      try {
        if (!src) callback({});
        else callback({ video: src, ...(choice.audio && src.id.startsWith('screen:') ? { audio: 'loopback' } : {}) });
      } catch (e) { log('screen share', e.message); }
    };
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      const owner = BaseWindow.getFocusedWindow() || (discordPop && discordPop.win) || (currentWindow() && currentWindow().win);
      const ob = owner ? owner.getBounds() : { x: 100, y: 100, width: 900, height: 700 };
      const win = new BaseWindow({
        width: 720, height: 520, x: Math.round(ob.x + (ob.width - 720) / 2), y: Math.round(ob.y + (ob.height - 520) / 2),
        parent: owner || undefined, modal: false, minimizable: false, maximizable: false, resizable: true,
        title: 'Choose what to share', icon: path.join(__dirname, 'ui', 'icon.png'), backgroundColor: '#07101b', autoHideMenuBar: true,
      });
      const view = new WebContentsView({ webPreferences: { partition: NORMAL_PARTITION, preload: path.join(__dirname, 'preload-page.js'), contextIsolation: true, sandbox: true } });
      view.setBackgroundColor('#07101b');
      win.contentView.addChildView(view);
      const fit = () => { const c = win.getContentBounds(); view.setBounds({ x: 0, y: 0, width: c.width, height: c.height }); };
      fit(); win.on('resize', fit);
      win.on('closed', () => { try { view.webContents.close(); } catch {} finish(null); });
      let site = '';
      try { site = hostOf(request.securityOrigin || (request.frame && request.frame.url) || ''); } catch {}
      sharePending = { sources, finish, win, site, audio: !!request.audioRequested };
      view.webContents.loadURL('cloud://share-picker/');
      view.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); finish(null); } });
    } catch (e) {
      log('screen share picker failed', e.message);
      finish(null);
    }
  });
}
pageHandle('share-sources', () => {
  const p = sharePending;
  if (!p) return null;
  return {
    site: p.site, audio: p.audio,
    sources: p.sources.map(x => ({ id: x.id, name: x.name, kind: x.id.startsWith('screen:') ? 'screen' : 'window', thumb: x.thumbnail && !x.thumbnail.isEmpty() ? x.thumbnail.toDataURL() : '' }))
      .filter(x => x.kind === 'screen' || (x.name && !/— CloudBrowser|^Choose what to share$/.test(x.name))),
  };
});
pageHandle('share-choose', (_ctx, id, audio) => { if (sharePending) sharePending.finish(id ? { id: String(id), audio: !!audio } : null); return true; });


function destroyPanel(w, id) {
  const v = w.panelViews.get(id);
  if (!v) return;
  w.panelViews.delete(id);
  if (w.panelApp === id) w.panelApp = null;
  try { w.win.contentView.removeChildView(v); v.webContents.close(); } catch {}
  if (currentMedia && currentMedia.kind === 'panel' && currentMedia.appId === id) { currentMedia = null; sendStateAll(); }
  layout(w);
}

function addSidebarApp(title, url) {
  url = toUrl(url);
  if (!/^https?:/.test(url)) return;
  const apps = settings.data.sidebarApps;
  if (apps.some(a => a.url === url) || apps.length >= 10) return;
  apps.push({ id: 'app' + Date.now().toString(36), title: String(title || hostOf(url)).slice(0, 40), url });
  settings.data.sidebarAppsEnabled = true;
  settings.save();
  sendStateAll();
}

function showSidebarAddMenu(w) {
  const have = new Set(settings.data.sidebarApps.map(a => a.url));
  const t = activeTab(w);
  Menu.buildFromTemplate([
    ...(t && /^https?:/.test(tabUrl(t)) ? [{ label: `Add this page (${(t.view.webContents.getTitle() || hostOf(tabUrl(t))).slice(0, 30)})`, click: () => addSidebarApp(t.view.webContents.getTitle() || hostOf(tabUrl(t)), tabUrl(t)) }, { type: 'separator' }] : []),
    ...SIDEBAR_PRESETS.map(p => ({ label: p.title, enabled: !have.has(p.url), click: () => addSidebarApp(p.title, p.url) })),
    { type: 'separator' },
    { label: 'Hide the sidebar', click: () => setSetting('sidebarAppsEnabled', false) },
  ]).popup({ window: w.win });
}

function showSidebarAppMenu(w, id) {
  const app = settings.data.sidebarApps.find(a => a.id === id);
  if (!app) return;
  const v = w.panelViews.get(id);
  const width = settings.data.sidebarWidth;
  const apps = settings.data.sidebarApps;
  const i = apps.indexOf(app);
  const lite = isDiscordApp(app) && discordLite && settings.data.discordLite;
  const dv = v || (discordPop && isDiscordApp(app) ? discordPop.view : null);
  Menu.buildFromTemplate([
    { label: lite ? 'Discord Lite' : app.title, enabled: false },
    { type: 'separator' },
    ...(lite ? [
      { label: 'Discord Lite settings', accelerator: 'Ctrl+,', click: () => openInternal(normalWindow(), 'discord-settings') },
      { label: 'Message log', accelerator: 'Ctrl+Shift+L', click: () => openInternal(normalWindow(), 'discord-log') },
      { label: discordPop ? 'Back into the sidebar' : 'Open in its own window', click: () => (discordPop ? discordPop.win.close() : popOutDiscord(w)) },
      { label: 'Reload theme', click: () => discordLite.reloadTheme() },
      { label: 'Update Vencord (reloads Discord)', click: async () => {
        try { await discordLite.updateVencord(false); } catch (e) { dlNotify("Couldn't update Vencord", e.message); return; }
        if (dv) dv.webContents.reload();
      } },
      { label: 'Developer tools', enabled: !!dv, click: () => dv.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
    ] : []),
    { label: lite ? 'Reload Discord' : 'Reload', enabled: !!dv, click: () => dv.webContents.reload() },
    { label: 'Go to its home page', enabled: !!v, click: () => load(v.webContents, app.url) },
    { label: 'Open in a tab', click: () => createTab(w, v ? v.webContents.getURL() : app.url) },
    { label: 'Close it (stop running)', enabled: !!v, click: () => destroyPanel(w, id) },
    { type: 'separator' },
    { label: 'Width', submenu: [[360, 'Narrow'], [440, 'Medium'], [560, 'Wide']].map(([px, name]) => ({ label: name, type: 'radio', checked: width === px, click: () => setSetting('sidebarWidth', px) })) },
    { label: 'Move up', enabled: i > 0, click: () => { [apps[i - 1], apps[i]] = [apps[i], apps[i - 1]]; settings.save(); sendStateAll(); } },
    { label: 'Move down', enabled: i < apps.length - 1, click: () => { [apps[i + 1], apps[i]] = [apps[i], apps[i + 1]]; settings.save(); sendStateAll(); } },
    { label: 'Remove from sidebar', click: () => {
      for (const x of windows) destroyPanel(x, id);
      settings.data.sidebarApps = apps.filter(a => a.id !== id);
      settings.save(); sendStateAll();
    } },
  ]).popup({ window: w.win });
}

// ---------- media controls (whatever is playing, in any tab or sidebar app) ----------

let currentMedia = null; // { kind, tab?, w?, appId?, wc, label, info }
const MEDIA_INFO_JS = `(() => {
  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  const ms = [...document.querySelectorAll('video, audio')];
  const playing = ms.some(m => !m.paused && !m.ended);
  const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
  const q = (s) => document.querySelector(s);
  return {
    title: (md && md.title) || document.title, artist: (md && md.artist) || '', artwork: art, playing, hasMedia: ms.length > 0,
    canNext: !!q('ytmusic-player-bar .next-button, .ytp-next-button:not([aria-disabled="true"]), .skipControl__next'),
    canPrev: !!q('ytmusic-player-bar .previous-button, .ytp-prev-button:not([aria-disabled="true"]), .skipControl__previous'),
  };
})()`;

function mediaSourceWc(src) { return src.kind === 'tab' ? src.tab.view.webContents : src.wc; }

async function refreshMedia() {
  if (!currentMedia) return;
  const wc = mediaSourceWc(currentMedia);
  if (!wc || wc.isDestroyed() || (currentMedia.kind === 'tab' && !allTabs().includes(currentMedia.tab) && !currentMedia.tab.popped)) {
    currentMedia = null; sendStateAll(); return;
  }
  try {
    const info = await wc.executeJavaScript(MEDIA_INFO_JS);
    if (!info.hasMedia) { currentMedia = null; sendStateAll(); return; }
    currentMedia.info = info;
    currentMedia.label = currentMedia.kind === 'tab' ? hostOf(tabUrl(currentMedia.tab)).replace(/^www\./, '') : (settings.data.sidebarApps.find(a => a.id === currentMedia.appId) || {}).title || 'Sidebar';
    sendStateAll();
  } catch {}
}

function mediaEvent(src, started) {
  const wc = mediaSourceWc(src);
  if (src.kind === 'tab' && src.tab.private) return; // incognito media isn't shown elsewhere
  if (started || !currentMedia || mediaSourceWc(currentMedia) !== wc) {
    if (started) currentMedia = { ...src, info: null, label: '' };
  }
  setTimeout(refreshMedia, 300);
}
setInterval(() => { if (currentMedia) refreshMedia(); }, 4000);

async function mediaAction(w, action) {
  if (!currentMedia) return;
  const wc = mediaSourceWc(currentMedia);
  if (!wc || wc.isDestroyed()) return;
  if (action === 'focus') {
    if (currentMedia.kind === 'tab') {
      const t = currentMedia.tab;
      if (t.popped && t.popWin) t.popWin.focus();
      else { switchTab(t.w, t.id); t.w.win.focus(); }
    } else { if (currentMedia.w.panelApp !== currentMedia.appId) togglePanel(currentMedia.w, currentMedia.appId); currentMedia.w.win.focus(); }
    return;
  }
  const js = {
    toggle: `(() => { const ms = [...document.querySelectorAll('video, audio')]; const m = ms.find(x => !x.paused) || ms.sort((a, b) => b.currentTime - a.currentTime)[0]; if (m) { m.paused ? m.play() : m.pause(); } })()`,
    next: `(() => { const b = document.querySelector('ytmusic-player-bar .next-button, .ytp-next-button, .skipControl__next'); if (b) b.click(); })()`,
    prev: `(() => { const b = document.querySelector('ytmusic-player-bar .previous-button, .ytp-prev-button, .skipControl__previous'); if (b) b.click(); })()`,
  }[action];
  if (js) { await wc.executeJavaScript(js, true).catch(() => {}); setTimeout(refreshMedia, 500); }
}

// ---------- YouTube: picture-in-picture when you switch away ----------

function isYouTube(url) { try { return /(^|\.)youtube\.com$/.test(new URL(url).hostname) && !/^music\./.test(new URL(url).hostname); } catch { return false; } }
function pipEnter(wc) {
  wc.executeJavaScript(`(async () => { const v = [...document.querySelectorAll('video')].find(v => !v.paused); if (v && !document.pictureInPictureElement) { v.disablePictureInPicture = false; await v.requestPictureInPicture(); } })().catch(() => {})`, true).catch(() => {});
}
function pipExit(wc) {
  wc.executeJavaScript(`document.pictureInPictureElement ? document.exitPictureInPicture().catch(() => {}) : 0`, true).catch(() => {});
}

// ---------- VR ----------
// When a VR app is running (SteamVR, Quest Link, Virtual Desktop, VRChat, …), CloudBrowser
// sleeps background tabs and does as little as possible, so the headset gets the power.

const VR_PROCESSES = ['vrserver.exe', 'vrmonitor.exe', 'vrcompositor.exe', 'ovrserver_x64.exe', 'virtualdesktop.streamer.exe',
  'vrchat.exe', 'alvr_dashboard.exe', 'mixedrealityportal.exe', 'pico connect.exe', 'steamvr_room_setup.exe'];
let vrActive = false;
let vrTick = 0;
let vrCheckBusy = false;

function checkVr() {
  if (process.platform !== 'win32' || vrCheckBusy) return;
  if (settings.data.vrMode === 'off') { setVrActive(false); return; }
  vrCheckBusy = true;
  execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    vrCheckBusy = false;
    if (err) return;
    const names = new Set(String(out).split(/\r?\n/).map(l => (l.split('","')[0] || '').replace(/^"/, '').toLowerCase()));
    setVrActive(VR_PROCESSES.some(p => names.has(p)) || (SMOKE && fakeVr));
  });
}
let fakeVr = false;

function setVrActive(on) {
  if (on === vrActive) return;
  vrActive = on;
  log('VR mode', on ? 'on' : 'off');
  if (on) {
    for (const t of allTabs()) {
      if (!isOnScreen(t) && !t.pinned && !t.view.webContents.isCurrentlyAudible()) sleepTab(t);
    }
  }
  sendStateAll();
}

// ---------- pop-out floating window ----------

function popOutTab(t) {
  if (!t || t.popped) return;
  const w = t.w;
  const idx = w.tabs.indexOf(t);
  if (idx < 0) return;
  if (w.split && (w.split.a === t.id || w.split.b === t.id)) w.split = null;
  // Take the page out of the window without reloading it (video keeps playing).
  w.tabs.splice(idx, 1);
  w.win.contentView.removeChildView(t.view);
  if (!w.tabs.length) createTab(w, homeUrl());
  else if (w.activeId === t.id) switchTab(w, w.tabs[Math.min(idx, w.tabs.length - 1)].id);
  sendState(w);
  saveSession();

  const b = w.win.getBounds();
  const pop = new BaseWindow({
    width: 520, height: 320, x: b.x + b.width - 560, y: b.y + b.height - 360, minWidth: 220, minHeight: 140,
    alwaysOnTop: true, title: t.view.webContents.getTitle() || 'CloudBrowser', icon: path.join(__dirname, 'ui', 'icon.png'),
    autoHideMenuBar: true, backgroundColor: '#07101b',
  });
  pop.setAlwaysOnTop(true, 'floating');
  t.popped = true;
  t.popWin = pop;
  t.shown = undefined; t.boundsKey = null; // the window's layout must place it fresh when it comes back
  t.view.setVisible(true);
  pop.contentView.addChildView(t.view);
  const fit = () => { const c = pop.getContentBounds(); t.view.setBounds({ x: 0, y: 0, width: c.width, height: c.height }); };
  fit();
  pop.on('resize', fit);
  const onTitle = () => { if (!pop.isDestroyed()) pop.setTitle(t.view.webContents.getTitle() || 'CloudBrowser'); };
  t.view.webContents.on('page-title-updated', onTitle);
  pop.on('closed', () => {
    t.view.webContents.removeListener('page-title-updated', onTitle);
    t.popped = false; t.popWin = null;
    // Put it back as a tab in a normal window.
    if (quitting || t.view.webContents.isDestroyed()) { try { t.view.webContents.close(); } catch {} return; }
    const target = windows.has(t.w) ? t.w : (t.private ? incognitoWindow() : normalWindow());
    if (!target) return;
    t.w = target;
    t.shown = undefined; t.boundsKey = null;
    target.tabs.push(t);
    target.win.contentView.addChildView(t.view);
    layout(target);
    switchTab(target, t.id);
    target.win.focus();
  });
  return pop;
}

function returnPoppedTab(t) { if (t && t.popWin && !t.popWin.isDestroyed()) t.popWin.close(); }

// ---------- interface size (for VR desktop views or big screens) ----------

function applyUiScale(w) {
  const z = (settings.data.uiScale || 100) / 100;
  try { w.ui.webContents.setZoomFactor(z); } catch {}
  try { w.win.setTitleBarOverlay(titleBarColors(w.incognito)); } catch {}
  sendState(w);
}

// ---------- Widevine (Netflix, Disney+, Spotify, Prime Video, …) ----------
// CloudBrowser is built on castLabs' Electron, which installs Google's Widevine module the way
// Chrome does (downloaded once, then kept up to date). Until it's ready, protected videos won't play.
let widevine = { status: 'starting' };
function startWidevine() {
  const { components } = require('electron');
  if (!components) { widevine = { status: 'unavailable' }; return; }
  components.whenReady().then(() => {
    widevine = { status: 'ready', components: components.status() };
    log('Widevine ready', JSON.stringify(widevine.components));
  }).catch(err => {
    widevine = { status: 'error', error: String(err && err.message || err) };
    log('Widevine failed', widevine.error);
  });
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

function isOnScreen(t) { const sp = splitShowing(t.w); return t.id === t.w.activeId || !!(sp && (t.id === sp.a || t.id === sp.b)); }
// Memory saver: when the computer is short of memory, unused tabs sleep after 5 minutes.
function lowOnMemory() {
  const os = require('os');
  return os.freemem() / os.totalmem() < 0.12 || os.freemem() < 1.2 * 1024 ** 3;
}
function sleepIdleTabs() {
  let mins = vrActive ? 2 : settings.data.sleepAfter; // in VR, unused tabs sleep after 2 minutes
  if (settings.data.memorySaver && lowOnMemory()) mins = Math.min(mins || 5, 5);
  if (!mins) return;
  const cutoff = Date.now() - mins * 60000;
  for (const t of allTabs()) {
    if (!t.sleeping && !isOnScreen(t) && t.lastActive < cutoff) sleepTab(t);
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
  if (ctrl && shift && key === 't') {
    // Whatever you closed last: a tab in this window, or a whole window.
    const lastWin = closedWindows[closedWindows.length - 1];
    if (lastWin && (!w.closedTabs.length || lastWin.at > (w.lastClosedTabAt || 0))) reopenClosedWindow(); else reopenClosedTab(w);
    return true;
  }
  if (ctrl && shift && key === 'c' && t && /^https?:/.test(tabUrl(t))) { copyCleanLink(w, tabUrl(t)); return true; }
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
  if (ctrl && shift && key === 'e') { toggleSplit(w); return true; }
  if (ctrl && shift && key === 'd') { const id = discordAppId(); if (id && !w.incognito) togglePanel(w, id); return true; }
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
    if (/^https?:/.test(p.linkURL) && cleanUrl(p.linkURL) !== p.linkURL) t.push({ label: 'Copy clean link (no tracking)', click: () => copyCleanLink(w, p.linkURL) });
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
    if (/^https?:/.test(tabUrl(tab))) t.push({ label: 'Copy link to highlight', click: () => { clipboard.writeText(highlightLink(tabUrl(tab), s)); toast(w, 'Link to highlight copied'); } });
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
    if (/^https?:/.test(tabUrl(tab))) t.push({ label: 'Send to your phone (QR code)', click: () => showQr(w, tabUrl(tab)) });
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
  if (tab.popped) { sep(); t.push({ label: 'Put back into the browser', click: () => returnPoppedTab(tab) }); }
  t.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(t).popup({ window: tab.popped && tab.popWin ? tab.popWin : w.win });
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
    { label: 'Pop out tab (floating, always on top)', enabled: !!t, click: () => popOutTab(t) },
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
    ...(w.split && (w.split.a === t.id || w.split.b === t.id) ? [
      { label: 'Swap split sides', click: () => swapSplit(w) },
      { label: 'Close split view', click: () => endSplit(w) },
    ] : [{
      label: 'Open in split view', submenu: [
        { label: 'With a new tab', accelerator: 'Ctrl+Shift+E', click: () => startSplit(w, t.id, null) },
        ...(w.tabs.length > 1 ? [{ type: 'separator' }] : []),
        ...w.tabs.filter(x => x.id !== t.id).slice(0, 15).map(x => ({ label: (tabInfo(x).title || tabUrl(x)).slice(0, 50), click: () => startSplit(w, t.id, x.id) })),
      ],
    }]),
    { label: 'Pop out (floating, always on top)', click: () => popOutTab(t) },
    ...(settings.data.sidebarAppsEnabled && !w.incognito && /^https?:/.test(tabUrl(t)) ? [{ label: 'Add to sidebar', click: () => addSidebarApp(t.view.webContents.getTitle() || hostOf(tabUrl(t)), tabUrl(t)) }] : []),
    { label: t.pinned ? 'Unpin tab' : 'Pin tab', click: () => togglePin(t) },
    { label: 'Put tab to sleep', enabled: !isOnScreen(t) && !t.sleeping, click: () => sleepTab(t, true) },
    autoRefreshMenu(t),
    { label: 'Move to new window', enabled: w.tabs.length > 1, click: () => { const u = tabUrl(t); closeTab(id); createWindow({ incognito: w.incognito, urls: [u] }); } },
    { label: wc.isAudioMuted() ? 'Unmute site' : 'Mute site', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); sendState(w); } },
    { label: isBookmarked(tabUrl(t)) ? 'Remove bookmark' : 'Bookmark tab', click: () => toggleBookmark(t) },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(id) },
    { label: 'Close other tabs', enabled: w.tabs.length > 1, click: () => w.tabs.filter(x => x.id !== id).map(x => x.id).forEach(closeTab) },
    { label: 'Close tabs to the right', enabled: idx < w.tabs.length - 1, click: () => w.tabs.slice(idx + 1).map(x => x.id).forEach(closeTab) },
    { label: 'Close duplicate tabs', enabled: duplicateTabs(w).length > 0, click: () => { const d = duplicateTabs(w); d.forEach(x => closeTab(x.id)); toast(w, `Closed ${d.length} duplicate tab${d.length === 1 ? '' : 's'}`); } },
    { label: 'Reopen closed tab', enabled: w.closedTabs.length > 0, click: () => reopenClosedTab(w) },
    { label: 'Reopen closed window', enabled: closedWindows.length > 0, click: () => reopenClosedWindow() },
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
  if (key === 'vrMode' && !['auto', 'off'].includes(value)) return false;
  if (key === 'uiScale' && ![100, 125, 150].includes(value)) return false;
  if (key === 'sidebarWidth' && ![360, 440, 560].includes(value)) return false;
  if (key === 'shortcutsMode' && value === 'custom' && !settings.data.shortcuts.length) {
    settings.data.shortcuts = topSites().map(x => ({ title: x.title, url: x.url })); // start from what's showing now
  }
  if (key === 'homePage') value = toUrl(value);
  settings.data[key] = value;
  settings.save();
  if (key === 'theme') nativeTheme.themeSource = value;
  if (key === 'adblock') applyAdblock();
  if (key === 'passwordManager' && value === 'bitwarden') ensureBitwarden(true);
  if (key === 'uiScale') for (const x of windows) applyUiScale(x);
  if (key === 'sidebarWidth') for (const x of windows) layout(x);
  if (key === 'sidebarAppsEnabled' && !value) for (const x of windows) closePanel(x);
  if (key === 'discordLite') {
    // Reload Discord so Discord Lite is added or removed.
    const id = discordAppId();
    if (discordPop) { const v = discordPop.view; discordPop.win.removeAllListeners('closed'); discordPop.win.close(); discordPop = null; try { v.webContents.close(); } catch {} }
    for (const x of windows) { const v = id && x.panelViews.get(id); if (v) destroyPanel(x, id); }
    if (value && discordLite && !discordLite.started) discordLite.start().catch(() => {});
  }
  if (key === 'vrMode') checkVr();
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
  const z = (settings.data.uiScale || 100) / 100; // the UI reports CSS pixels; windows use device-independent ones
  const x = Math.round(Number(r && r.x) * z), y = Math.round(Number(r && r.y) * z), rail = Math.round(Number(r && r.rail || 0) * z);
  if (!(x >= 0 && x < 1200 && y > 0 && y < 600 && rail >= 0 && rail < 200)) return;
  if (x === w.pageX && y === w.pageY && rail === w.railW) return;
  w.pageX = x; w.pageY = y; w.railW = rail;
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
uiOn('sidebar-app', (w, id) => togglePanel(w, id));
uiOn('split-toggle', w => toggleSplit(w));
uiOn('nav-menu', (w, dir) => showNavMenu(w, dir));
uiOn('reload-menu', w => showReloadMenu(w));
uiOn('toast', (w, text) => toast(w, String(text).slice(0, 120)));
uiOn('split-ratio', (w, r) => { r = Number(r); if (w.split && r >= 0.15 && r <= 0.85) { w.split.ratio = r; layout(w); sendState(w); } });
uiOn('split-menu', w => {
  if (!w.split) return;
  Menu.buildFromTemplate([
    { label: 'Swap sides', click: () => swapSplit(w) },
    { label: 'Equal sizes', click: () => { w.split.ratio = 0.5; layout(w); sendState(w); } },
    { type: 'separator' },
    { label: 'Close split view', click: () => endSplit(w) },
  ]).popup({ window: w.win });
});
uiOn('sidebar-app-menu', (w, id) => showSidebarAppMenu(w, id));
uiOn('sidebar-add-menu', w => showSidebarAddMenu(w));
uiOn('media', (w, action) => mediaAction(w, action));
uiOn('pin-extension', (_w, id) => {
  const list = settings.data.pinnedExtensions || [];
  settings.data.pinnedExtensions = list.includes(id) ? list.filter(x => x !== id) : [...list, id];
  settings.save();
  sendStateAll();
});
uiOn('manage-extensions', w => openInternal(w, 'extensions'));
uiOn('open-web-store', w => createTab(normalWindow(), 'https://chromewebstore.google.com/category/extensions'));
uiOn('reader', w => { const t = activeTab(w); if (t) openReader(t); });
uiOn('reset-zoom', w => { const wc = activeTab(w)?.view.webContents; if (wc) { wc.setZoomLevel(0); rememberZoom(wc, 0); sendState(w); } });
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
uiOn('address-menu', async (w, hasSelection) => {
  const t = activeTab(w);
  // This Electron's clipboard.readText() may return a promise; handle both.
  const clip = String((await clipboard.readText()) || '').trim();
  Menu.buildFromTemplate([
    { role: 'undo' }, { type: 'separator' },
    { role: 'cut', enabled: !!hasSelection }, { role: 'copy', enabled: !!hasSelection }, { role: 'paste', enabled: !!clip },
    { label: clip && !/\s/.test(clip) && /[./:]/.test(clip) ? 'Paste and go' : 'Paste and search', enabled: !!clip,
      click: () => { uiSend(w, 'blur-address'); openUrl(w, toUrl(clip)); } },
    { role: 'selectAll' },
    { type: 'separator' },
    { label: 'Copy page link', enabled: !!t && /^(https?|file):/.test(tabUrl(t)), click: () => clipboard.writeText(tabUrl(t)) },
    { label: 'Copy clean link (no tracking)', accelerator: 'Ctrl+Shift+C', enabled: !!t && /^https?:/.test(tabUrl(t)), click: () => copyCleanLink(w, tabUrl(t)) },
    { label: 'Send to your phone (QR code)', enabled: !!t && /^https?:/.test(tabUrl(t)), click: () => showQr(w, tabUrl(t)) },
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
// Discord Lite: the scripts injected into the Discord sidebar app, and its invoke() commands.
ipcMain.on('dl-bundle', (e) => {
  try { e.returnValue = discordLite && settings.data.discordLite && discordLite.isView(e.sender) ? discordLite.bundle() : null; }
  catch (err) { log('discord-lite bundle failed', err.message); e.returnValue = null; }
});
const dlCalls = {};
ipcMain.handle('dl-invoke', (e, cmd, args) => {
  if (!discordLite || !discordLite.isView(e.sender)) throw new Error('Not allowed');
  if (SMOKE) dlCalls[cmd] = (dlCalls[cmd] || 0) + 1;
  return discordLite.invoke(cmd, args);
});
// SponsorBlock: ask with a 4-character hash prefix so the server can't tell which video it is.
const sbCache = new Map();
ipcMain.handle('yt-segments', async (e, videoId, categories) => {
  if (!settings || !settings.data.sponsorBlock || !/^[\w-]{6,16}$/.test(String(videoId))) return [];
  const cats = (Array.isArray(categories) ? categories : settings.data.sponsorCategories).filter(c => /^[a-z_]{3,20}$/.test(c));
  const key = videoId + '|' + cats.join(',');
  const hit = sbCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.segs;
  const prefix = require('crypto').createHash('sha256').update(String(videoId)).digest('hex').slice(0, 4);
  const url = `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(cats))}&actionTypes=${encodeURIComponent('["skip"]')}`;
  let segs = [];
  try {
    const r = await e.sender.session.fetch(url, { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const all = await r.json();
      const mine = Array.isArray(all) ? all.find(x => x.videoID === videoId) : null;
      segs = mine ? mine.segments.filter(x => x.actionType === 'skip' && Array.isArray(x.segment))
        .map(x => ({ start: Number(x.segment[0]), end: Number(x.segment[1]), category: x.category, uuid: x.UUID }))
        .filter(x => x.end > x.start) : [];
    }
  } catch (err) { log('sponsorblock', err.message); }
  sbCache.set(key, { at: Date.now(), segs });
  if (sbCache.size > 200) sbCache.delete(sbCache.keys().next().value);
  return segs;
});
// YouTube page scripts (preload-page.js) read their settings once per page.
ipcMain.on('yt-settings', (e) => {
  e.returnValue = settings ? {
    sponsorBlock: settings.data.sponsorBlock, categories: settings.data.sponsorCategories,
    hideShorts: settings.data.hideShorts,
    lite: liteSettings('ytLite'),
  } : null;
});
ipcMain.on('rbx-settings', (e) => { e.returnValue = settings ? liteSettings('robloxLite') : null; });

// ---------- YouTube Lite & Roblox Lite ----------

const LITE_DEFAULTS = { ytLite: DEFAULT_SETTINGS.ytLite, robloxLite: DEFAULT_SETTINGS.robloxLite };
function liteSettings(app) { return { ...LITE_DEFAULTS[app], ...(settings.data[app] || {}) }; }
const LITE_OPTIONS = {
  ytLite: {
    title: 'YouTube Lite', host: /(^|\.)youtube\.com$/,
    items: [
      ['dislikes', 'Show dislike counts'], ['skipAds', 'Skip any ads that get through'], ['rememberSpeed', 'Remember my playback speed'],
      ['navyTheme', 'Navy theme (in YouTube’s dark mode)'], null,
      ['hideComments', 'Hide comments'], ['hideRelated', 'Hide recommended videos next to the player'], ['hideHomeFeed', 'Hide the home page feed (focus mode)'], ['hideEndCards', 'Hide end-screen cards'],
    ],
  },
  robloxLite: {
    title: 'Roblox Lite', host: /(^|\.)roblox\.com$/,
    items: [['serverBrowser', 'Server browser on game pages'], ['navyTheme', 'Navy theme (in Roblox’s dark mode)']],
  },
};
function setLite(app, key, value) {
  if (!LITE_DEFAULTS[app] || !(key in LITE_DEFAULTS[app])) return false;
  if (typeof value !== typeof LITE_DEFAULTS[app][key]) return false;
  if (key === 'quality' && !['auto', '720', '1080', '1440', '2160', 'max'].includes(value)) return false;
  settings.data[app] = { ...liteSettings(app), [key]: value };
  settings.save();
  // Pages pick the change up straight away.
  const cfg = liteSettings(app);
  for (const t of allTabs()) {
    if (LITE_OPTIONS[app].host.test(hostOf(tabUrl(t)))) t.view.webContents.send('lite-settings', app, cfg);
  }
  sendStateAll();
  return true;
}
function liteAppFor(url) {
  const h = hostOf(url);
  for (const app of Object.keys(LITE_OPTIONS)) if (LITE_OPTIONS[app].host.test(h) && liteSettings(app).enabled) return app;
  return null;
}
function showLiteMenu(w) {
  const t = activeTab(w);
  const app = t && liteAppFor(tabUrl(t));
  if (!app) return;
  const o = LITE_OPTIONS[app], cfg = liteSettings(app);
  const extra = app === 'ytLite' ? [
    { label: 'Video quality', submenu: [['max', 'Always the best available'], ['2160', 'Up to 4K'], ['1440', 'Up to 1440p'], ['1080', 'Up to 1080p'], ['720', 'Up to 720p (saves data)'], ['auto', 'Let YouTube choose']]
      .map(([v, l]) => ({ label: l, type: 'radio', checked: cfg.quality === v, click: () => setLite(app, 'quality', v) })) },
    { label: 'Skip sponsors (SponsorBlock)', type: 'checkbox', checked: !!settings.data.sponsorBlock, click: () => setSetting('sponsorBlock', !settings.data.sponsorBlock) },
    { label: 'Hide Shorts', type: 'checkbox', checked: !!settings.data.hideShorts, click: () => setSetting('hideShorts', !settings.data.hideShorts) },
    { label: 'Picture-in-picture when I switch tabs', type: 'checkbox', checked: !!settings.data.autoPip, click: () => setSetting('autoPip', !settings.data.autoPip) },
  ] : [];
  Menu.buildFromTemplate([
    { label: o.title, enabled: false },
    { type: 'separator' },
    ...extra,
    ...o.items.map(it => it ? { label: it[1], type: 'checkbox', checked: !!cfg[it[0]], click: () => setLite(app, it[0], !cfg[it[0]]) } : { type: 'separator' }),
    { type: 'separator' },
    { label: 'Reload page to apply everything', click: () => t.view.webContents.reload() },
    { label: `Turn off ${o.title}`, click: () => { setLite(app, 'enabled', false); t.view.webContents.reload(); } },
    { label: 'More settings…', click: () => openInternal(w, 'settings', '#apps') },
  ]).popup({ window: w.win });
}
uiOn('lite-menu', w => showLiteMenu(w));
pageHandle('set-lite', (_ctx, app, key, value) => setLite(String(app), String(key), value));

// Return YouTube Dislike: dislike counts (estimated from votes), fetched through CloudBrowser's own connection (the VPN if it's on).
const rydCache = new Map();
ipcMain.handle('yt-dislikes', async (e, videoId) => {
  if (!liteSettings('ytLite').dislikes || !/^[\w-]{6,16}$/.test(String(videoId))) return null;
  const hit = rydCache.get(videoId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.v;
  try {
    const r = await e.sender.session.fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${encodeURIComponent(videoId)}`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const v = { likes: Number(j.likes) || 0, dislikes: Number(j.dislikes) || 0 };
    rydCache.set(videoId, { at: Date.now(), v });
    if (rydCache.size > 300) rydCache.delete(rydCache.keys().next().value);
    return v;
  } catch { return null; }
});

// Roblox Lite: join a particular server by opening the Roblox app (only when you click Join).
ipcMain.on('rbx-join', (e, placeId, jobId) => {
  const t = [...allTabs()].find(x => x.view.webContents === e.sender);
  if (!t || !/(^|\.)roblox\.com$/.test(hostOf(tabUrl(t)))) return;
  if (!/^\d{1,20}$/.test(String(placeId)) || (jobId && !/^[0-9a-f-]{36}$/i.test(String(jobId)))) return;
  const url = `roblox://experiences/start?placeId=${placeId}` + (jobId ? `&gameInstanceId=${jobId}` : '');
  log('Roblox Lite: joining', placeId, jobId || '(any server)');
  if (SMOKE) { lastRobloxJoin = url; return; }
  shell.openExternal(url).catch(err => toast(t.w, 'Couldn’t open Roblox: ' + err.message));
});
let lastRobloxJoin = null;
// Public servers of a Roblox game (up to 300), with space to join.
ipcMain.handle('rbx-servers', async (e, placeId) => {
  if (!/^\d{1,20}$/.test(String(placeId))) return [];
  const out = [];
  let cursor = '';
  for (let i = 0; i < 3; i++) {
    const url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&excludeFullGames=true&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const r = await e.sender.session.fetch(url, { headers: { Accept: 'application/json' } }).catch(() => null);
    if (!r || !r.ok) break;
    const j = await r.json().catch(() => ({}));
    for (const s of j.data || []) {
      if (!s || typeof s.id !== 'string') continue;
      out.push({ id: s.id, playing: Number(s.playing) || 0, maxPlayers: Number(s.maxPlayers) || 0, ping: Number(s.ping) || 0, fps: Number(s.fps) || 0 });
    }
    cursor = j.nextPageCursor;
    if (!cursor) break;
  }
  return out.filter(s => s.maxPlayers > 0 && s.playing < s.maxPlayers);
});
ipcMain.on('rbx-toast', (e, text) => { const t = [...allTabs()].find(x => x.view.webContents === e.sender); if (t) toast(t.w, String(text).slice(0, 100)); });
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
  widevine: widevine.status,
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
pageHandle('dl', (_ctx, cmd, args) => {
  if (!discordLite) throw new Error('Discord Lite is off');
  return discordLite.invoke(String(cmd), args);
});
pageHandle('set-sponsor-categories', (_ctx, cats) => {
  const ok = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic', 'filler'];
  settings.data.sponsorCategories = (Array.isArray(cats) ? cats : []).filter(c => ok.includes(c));
  settings.save();
  return settings.data.sponsorCategories;
});
pageHandle('vr-status', () => ({ active: vrActive, mode: settings.data.vrMode }));
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
    mark('app ready');
    startWidevine();
    app.setAppUserModelId('com.cloudbrowser.app');
    Menu.setApplicationMenu(null);

    settings = new Store('settings', DEFAULT_SETTINGS);
    bookmarks = new Store('bookmarks', { items: [] });
    { const save = bookmarks.save.bind(bookmarks); bookmarks.save = (...a) => { bookmarksRev++; return save(...a); }; }
    history = new Store('history', { items: [] });
    permissions = new Store('permissions', { sites: {} });
    downloadStore = new Store('downloads', { items: [] });
    sessionStore = new Store('session', { windows: [] });
    extGrants = new Store('extension-permissions', { grants: {} });
    privacyStats = new Store('privacy-stats', { days: {} });
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
    // Like real Chrome: only the major version is shared ("Chrome/156.0.0.0"), which also reveals less about you.
    const major = process.versions.chrome.split('.')[0];
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const langs = [];
    for (const l of (app.getPreferredSystemLanguages ? app.getPreferredSystemLanguages() : [app.getLocale()])) {
      if (l && !langs.includes(l)) langs.push(l);
      const base = l && l.split('-')[0];
      if (base && !langs.includes(base)) langs.push(base);
    }
    app.userAgentFallback = ua;
    for (const p of [NORMAL_PARTITION, PRIVATE_PARTITION]) session.fromPartition(p).setUserAgent(ua, langs.join(',') || 'en-US,en');

    nativeTheme.on('updated', () => {
      for (const w of windows) { try { w.win.setTitleBarOverlay(titleBarColors(w.incognito)); } catch {} }
    });

    vpn = new Vpn({ settings, normalPartition: NORMAL_PARTITION, privatePartition: PRIVATE_PARTITION, log, onChange: vpnChanged });
    await vpn.applyKillSwitch(); // nothing loads outside the VPN if it's switched on
    mark('vpn kill switch set');
    if (settings.data.vpnEnabled) vpn.ensure();
    setupPrivacyHeaders();
    for (const p of [NORMAL_PARTITION, PRIVATE_PARTITION]) setupScreenShare(session.fromPartition(p));
    discordLite = new DiscordLite({
      app, log, session: () => session.fromPartition(NORMAL_PARTITION),
      notify: dlNotify,
      openUrl: (url) => { const w = normalWindow(); createTab(w, cleanUrl(url)); w.win.focus(); },
      openPage: (page) => { const w = normalWindow(); openInternal(w, page); w.win.show(); w.win.focus(); },
      showDiscord,
      onBadge: (mentions, unread, isNew) => {
        dlBadge = { mentions, unread };
        setDiscordBadge();
        sendStateAll();
        if (isNew && !BaseWindow.getFocusedWindow()) { const w = normalWindow(false); if (w) w.win.flashFrame(true); }
      },
      discordVisible,
      anyWindowFocused: () => !!BaseWindow.getFocusedWindow(),
    });
    if (settings.data.discordLite) discordLite.start().catch(e => log('discord-lite start failed', e.message));
    setInterval(sleepIdleTabs, 60 * 1000);
    // Look for VR apps every 30 s (every 15 s while in VR, to notice when you leave).
    setInterval(() => { if (vrActive || (vrTick = (vrTick + 1) % 2) === 0) checkVr(); }, 15 * 1000);
    setTimeout(checkVr, 4000);

    await setupExtensions();
    mark('extensions loaded');
    startWindows(argUrl(process.argv));
    mark('windows created');
    setTimeout(() => ensureBitwarden().catch(e => log('Bitwarden setup error', e.message)), 3000);
    setupUpdater();
    setupAdblock();
    registerAsBrowser().then(() => checkDefaultBrowser(true));
    setTimeout(() => { if (settings.data.discordLite) startDiscordInBackground(); }, SMOKE ? 600000 : 6000);
    if (SMOKE) setTimeout(smokeTest, 1500);
  });

  app.on('will-quit', () => { if (discordLite) discordLite.stop(); });
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

  // Memory and CPU, by what each process is.
  const perfSnapshot = async (label, seconds = 10) => {
    const before = new Map(app.getAppMetrics().map(m => [m.pid, m.cpu.cumulativeCPUUsage || 0]));
    await wait(seconds * 1000);
    const metrics = app.getAppMetrics();
    for (const m of metrics) m.cpuPct = before.has(m.pid) ? ((m.cpu.cumulativeCPUUsage || 0) - before.get(m.pid)) / seconds * 100 : 0;
    const byPid = new Map();
    for (const wc of webContents.getAllWebContents()) {
      let kind = 'other';
      const u = wc.getURL();
      if ([...windows].some(o => o.ui.webContents === wc)) kind = 'toolbar';
      else if ([...windows].some(o => o.hud && o.hud.webContents === wc)) kind = 'link-preview';
      else if ([...windows].some(o => [...o.panelViews.values()].some(v => v.webContents === wc)) || (discordPop && discordPop.view.webContents === wc)) kind = 'sidebar app';
      else if (allTabs().some(x => x.view.webContents === wc)) kind = 'tab';
      else if (u.startsWith('chrome-extension:')) kind = 'extension';
      try { byPid.set(wc.getOSProcessId(), kind); } catch {}
    }
    const groups = {};
    let cpu = 0, mem = 0;
    for (const m of metrics) {
      const kind = m.type === 'Tab' ? (byPid.get(m.pid) || 'tab (other)') : m.type;
      const g = groups[kind] || (groups[kind] = { n: 0, mb: 0, cpu: 0 });
      const mb = (m.memory.privateBytes || m.memory.workingSetSize) / 1024; // private memory: what each process really costs
      g.n++; g.mb += mb; g.cpu += m.cpuPct;
      cpu += m.cpuPct; mem += mb;
    }
    const parts = Object.entries(groups).sort((a, b) => b[1].mb - a[1].mb).map(([k, g]) => `${k} ×${g.n}: ${Math.round(g.mb)} MB, ${g.cpu.toFixed(1)}% CPU`);
    log(`[PERF] ${label}: ${metrics.length} processes, ${Math.round(mem)} MB, ${cpu.toFixed(1)}% CPU | ${parts.join(' | ')}`);
  };

  // JavaScript CPU profile of the main process: which functions take the time.
  const profileMain = async (label, fn) => {
    const inspector = require('inspector');
    const ses = new inspector.Session();
    ses.connect();
    const post = (m, p) => new Promise((res, rej) => ses.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 500 });
    await post('Profiler.start');
    await fn();
    const { profile } = await post('Profiler.stop');
    ses.disconnect();
    const dt = (profile.endTime - profile.startTime) / 1000;
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    const counts = new Map();
    for (const id of profile.samples) counts.set(id, (counts.get(id) || 0) + 1);
    const per = profile.timeDeltas.reduce((a, b) => a + b, 0) / Math.max(1, profile.samples.length) / 1000;
    let busy = 0;
    for (const [id, c] of counts) {
      const n = byId.get(id);
      const f = n.callFrame;
      if (['(idle)', '(program)', '(garbage collector)'].includes(f.functionName) && f.functionName === '(idle)') continue;
      const key = `${f.functionName || '(anon)'} ${(f.url || '').split(/[\\/]/).slice(-2).join('/')}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + c * per);
      busy += c * per;
    }
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, ms]) => `${ms.toFixed(0)}ms ${k}`);
    log(`[PERF] profile ${label}: main-process JS busy ${busy.toFixed(0)} ms of ${dt.toFixed(0)} ms (${(busy / dt * 100).toFixed(1)}%) | ${top.join(' | ')}`);
  };

  await step('performance', async () => {
    log('[PERF] start-up (ms since launch): ' + Object.entries(perfMarks).map(([k, v]) => `${k} ${v}`).join(', '));
    await perfSnapshot('idle, 1 tab');
    await profileMain('idle 10 s', () => wait(10000));
    const sites = ['https://en.wikipedia.org/wiki/Cloud', 'https://www.youtube.com/', 'https://www.theverge.com/', 'https://github.com/', 'https://www.bbc.co.uk/news'];
    const opened = [];
    const t0 = Date.now();
    const { monitorEventLoopDelay } = require('perf_hooks');
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const pushes0 = statePushes;
    await profileMain('loading 5 sites', async () => {
      for (const u of sites) opened.push(createTab(w, u));
      await waitFor(() => opened.every(x => !x.view.webContents.isLoading()), 40000);
    });
    lag.disable();
    log(`[PERF] 5 sites loaded side by side in ${Date.now() - t0} ms | main process blocked: worst ${(lag.max / 1e6).toFixed(0)} ms, 99th pct ${(lag.percentile(99) / 1e6).toFixed(0)} ms, mean ${(lag.mean / 1e6).toFixed(1)} ms | toolbar updates ${statePushes - pushes0}`);
    await wait(4000);
    await perfSnapshot('5 sites open (idle)');
    // Tab switching: time until the page is on screen and the toolbar has updated.
    const times = [];
    for (let i = 0; i < 10; i++) {
      const x = opened[i % opened.length];
      const s0 = performance.now();
      switchTab(w, x.id);
      await ui(w, `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      times.push(performance.now() - s0);
    }
    log(`[PERF] tab switch: median ${times.sort((a, b) => a - b)[5].toFixed(1)} ms, worst ${times[9].toFixed(1)} ms`);
    // Typing in the address bar (suggestions).
    const k0 = performance.now();
    await ui(w, `(() => { const a = document.getElementById('address'); a.focus(); for (const ch of 'wikipedia clouds') { a.value += ch; a.dispatchEvent(new Event('input')); } })()`);
    await ui(w, `new Promise(r => setTimeout(r, 400))`);
    log(`[PERF] typing 16 letters into the address bar: ${(performance.now() - k0 - 400).toFixed(1)} ms`);
    await ui(w, `(() => { const a = document.getElementById('address'); a.value = ''; a.blur(); })()`);
    startDiscordInBackground();
    await wait(25000);
    await perfSnapshot('5 sites + Discord in the background');
    opened.forEach(x => closeTab(x.id));
    await wait(3000);
    await perfSnapshot('back to 1 tab (Discord still running)');
    await profileMain('idle with Discord running', () => wait(10000));
    log('[PERF] Discord Lite calls so far: ' + JSON.stringify(dlCalls));
  });

  await step('google sign-in', async () => {
    S('user agent', session.fromPartition(NORMAL_PARTITION).getUserAgent());
    const wc = t.view.webContents;
    load(wc, 'https://accounts.google.com/ServiceLogin?hl=en&continue=https://www.youtube.com/');
    await waitFor(() => !wc.isLoading(), 20000);
    await wait(3000);
    S('page sees', await wc.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(['fullVersionList']).then(v => JSON.stringify({ ua: navigator.userAgent, brands: navigator.userAgentData.brands, full: v.fullVersionList, chrome: typeof window.chrome }))`).catch(e => 'ERR ' + e.message));
    load(wc, 'https://httpbin.org/headers'); await waitFor(() => !wc.isLoading(), 10000);
    load(wc, 'https://accounts.google.com/ServiceLogin?hl=en&continue=https://www.youtube.com/');
    await waitFor(() => !wc.isLoading(), 20000);
    await wait(3000);
    try { log('[SMOKE-FP] ' + await wc.executeJavaScript(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'fingerprint.js'), 'utf8'))); } catch (e) { S('fingerprint failed', e.message); }
    await wc.executeJavaScript(`document.querySelector('#identifierId') && document.querySelector('#identifierId').focus()`);
    await wait(500);
    wc.insertText('cloudbrowser.signin.test.4821@gmail.com');
    await wait(800);
    await wc.executeJavaScript(`(document.querySelector('#identifierNext button') || document.querySelector('#identifierNext')).click()`).catch(() => {});
    await wait(7000);
    const txt = await wc.executeJavaScript('document.body.innerText').catch(e => 'ERR ' + e.message);
    S('after entering email:', tabUrl(t).slice(0, 90), '|', JSON.stringify(txt.slice(0, 300)));
    S('blocked as insecure browser?', /may not be secure|Couldn.t sign you in/i.test(txt));
    await screen('google-signin');
  });

  await step('sidebar apps', async () => {
    togglePanel(w, 'discord');
    await wait(6000);
    const pv = w.panelViews.get('discord');
    S('sidebar: rail', w.railW, 'panel', JSON.stringify(pv && pv.getBounds()), 'page', JSON.stringify(t.view.getBounds()), 'url', pv && pv.webContents.getURL().slice(0, 60));
    S('sidebar: rail buttons', await ui(w, `document.querySelectorAll('#rail-apps .rail-btn').length + ' open=' + !!document.querySelector('.rail-btn.open')`));
    await screen('sidebar-discord');
    togglePanel(w, 'ytmusic');
    await wait(6000);
    S('sidebar: switched to', w.panelApp, 'discord still alive', !w.panelViews.get('discord').webContents.isDestroyed());
    await screen('sidebar-ytmusic');
    togglePanel(w, 'ytmusic');
    await wait(500);
    S('sidebar: closed, page width', t.view.getBounds().width, 'win', w.win.getContentBounds().width);
  });

  // YouTube asks CI machines to "sign in to confirm you're not a bot", so for the YouTube features
  // CloudBrowser is shown a stand-in youtube.com page (a real video file, real SponsorBlock data).
  let video = null;
  const ses = session.fromPartition(NORMAL_PARTITION);
  const jsIn = (wc, code) => Promise.race([wc.executeJavaScript(code, true), wait(8000).then(() => 'TIMEOUT')]).catch(e => 'ERR ' + e.message);
  let videoFile = null;
  for (const u of ['https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.webm',
    'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.480p.vp9.webm',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4']) {
    try { const r = await ses.fetch(u, { method: 'HEAD' }); S('video file', r.status, u.slice(-40)); if (r.ok) { videoFile = u; break; } } catch (e) { S('video file err', e.message); }
  }
  const fakeYt = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title} - YouTube</title></head>
    <body style="background:#0f0f0f;color:#fff;font:14px system-ui;margin:0">
    <div id="movie_player" class="html5-video-player" style="padding:16px"><video src="${videoFile}" controls style="width:640px;height:360px;background:#000"></video></div>
    <h2 style="padding:0 16px">${title}</h2>
    <div id="top-level-buttons-computed" style="padding:0 16px"><button>Like</button><dislike-button-view-model><button style="color:#fff;background:#333;border:0;padding:6px 12px;border-radius:14px">Dislike</button></dislike-button-view-model></div>
    <ytd-comments id="comments" style="display:block;padding:16px">Comments go here</ytd-comments>
    <script>
      // A stand-in for YouTube's player controls.
      (() => {
        const p = document.getElementById('movie_player');
        window.__q = null; window.__rate = null;
        p.getAvailableQualityLevels = () => ['hd1080', 'hd720', 'large', 'medium', 'auto'];
        p.getVideoData = () => ({ video_id: new URLSearchParams(location.search).get('v') });
        p.setPlaybackQualityRange = (a) => { window.__q = a; };
        p.setPlaybackRate = (r) => { window.__rate = r; document.querySelector('video').playbackRate = r; };
      })();
    </script>
    <div id="feed" style="display:flex;gap:12px;padding:16px">
      <ytd-rich-item-renderer style="display:block;width:150px;height:90px;background:#c33"><a href="/shorts/abcdefghijk">A Short</a></ytd-rich-item-renderer>
      <ytd-rich-item-renderer style="display:block;width:150px;height:90px;background:#36c"><a href="/watch?v=zzzzzzzzzzz">A normal video</a></ytd-rich-item-renderer>
    </div></body></html>`;
  await ses.protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'www.youtube.com' && (u.pathname === '/watch' || u.pathname === '/' || u.pathname.startsWith('/shorts/'))) {
      return new Response(fakeYt(u.pathname === '/watch' ? 'Test video ' + u.searchParams.get('v') : 'Home'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return ses.fetch(req, { bypassCustomProtocolHandlers: true });
  });

  await step('sponsorblock', async () => {
    for (const prefix of ['a1b2', '0f3c', '7d4e', 'c0de', '5e5e']) {
      const r = await ses.fetch(`https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=["sponsor"]`);
      if (!r.ok) { S('sb api', prefix, r.status); continue; }
      const all = await r.json();
      const hit = all.map(v => ({ id: v.videoID, seg: v.segments.find(x => x.actionType === 'skip' && x.segment[0] > 20 && x.segment[0] < 300 && x.segment[1] - x.segment[0] > 8) })).find(v => v.seg && /^[\w-]{11}$/.test(v.id));
      if (hit) { video = hit; break; }
    }
    S('sponsorblock test video', video && video.id, JSON.stringify(video && video.seg.segment));
    if (!video || !videoFile) return;
    const wc = t.view.webContents;
    load(wc, 'https://www.youtube.com/watch?v=' + video.id);
    await waitFor(() => !wc.isLoading(), 20000);
    await wait(2500);
    const [a, b] = video.seg.segment;
    S('sponsorblock: page', tabUrl(t).slice(0, 60), '|', wc.getTitle().slice(0, 40), '| segments fetched',
      [...sbCache.entries()].filter(([k]) => k.startsWith(video.id)).map(([, v]) => v.segs.length).join(','));
    await jsIn(wc, `(() => { const v = document.querySelector('video'); v.volume = 0.05; v.play().catch(() => {}); return 1; })()`);
    await waitFor(async () => (await jsIn(wc, `document.querySelector('video').readyState >= 2 && !document.querySelector('video').paused`)) === true, 20000);
    await jsIn(wc, `(() => { const v = document.querySelector('video'); v.currentTime = ${a} - 1.5; return 1; })()`);
    await wait(5000);
    const r = await jsIn(wc, `JSON.stringify({ now: +document.querySelector('video').currentTime.toFixed(1), paused: document.querySelector('video').paused, toast: (document.getElementById('cloud-sb-toast') || {}).textContent || null })`);
    let skippedOk = false; try { skippedOk = JSON.parse(r).now >= b - 1; } catch {}
    S('sponsorblock: segment', a, '→', b, '| after:', r, '| skipped?', skippedOk);
    await screen('sponsorblock');
  });

  await step('media controls', async () => {
    await wait(1000);
    await refreshMedia();
    S('media state', JSON.stringify(currentMedia && currentMedia.info), 'from', currentMedia && currentMedia.label);
    await ui(w, `document.getElementById('media-btn').click()`);
    await wait(800);
    S('media panel', await ui(w, `JSON.stringify({ shown: !document.getElementById('media-panel').hidden, title: document.getElementById('mp-title').textContent, button: document.getElementById('media-btn').classList.contains('show') })`));
    await screen('media-panel');
    await mediaAction(w, 'toggle');
    await wait(1200);
    S('media after pause: playing =', currentMedia && currentMedia.info && currentMedia.info.playing);
    await ui(w, `closeMediaPanel()`);
    await mediaAction(w, 'toggle');
    await wait(1200);
    S('media after play: playing =', currentMedia && currentMedia.info && currentMedia.info.playing);
  });

  await step('auto picture-in-picture', async () => {
    if (!video || !videoFile) return;
    const vt = t;
    await wait(1500);
    S('pip: audible', vt.view.webContents.isCurrentlyAudible());
    const other = createTab(w, 'https://example.com/');
    await wait(2500);
    S('pip: after switching away, in PiP =', await jsIn(vt.view.webContents, '!!document.pictureInPictureElement'));
    await screen('auto-pip');
    switchTab(w, vt.id);
    await wait(1500);
    S('pip: after coming back, in PiP =', await jsIn(vt.view.webContents, '!!document.pictureInPictureElement'));
    closeTab(other.id);
  });

  await step('address bar follows YouTube clicks', async () => {
    const wc = t.view.webContents;
    // Click into the address bar, then back into the page (this used to leave the bar stuck).
    w.ui.webContents.focus();
    await ui(w, `document.getElementById('address').focus()`);
    await wait(400);
    wc.focus();
    await wait(400);
    // YouTube opens videos without a full page load (history.pushState).
    await jsIn(wc, `history.pushState({}, '', '/watch?v=NEXTvideo01'); 1`);
    await wait(800);
    const shown = await ui(w, `document.getElementById('address').value`);
    S('address bar after in-page navigation:', shown, '| correct?', /v=NEXTvideo01/.test(shown), '| in history?', history.data.items[0] && history.data.items[0].url.includes('NEXTvideo01'));
  });

  await step('youtube lite', async () => {
    if (!video || !videoFile) return;
    const wc = t.view.webContents;
    load(wc, 'https://www.youtube.com/watch?v=' + video.id);
    await waitFor(() => !wc.isLoading(), 15000);
    await wait(3500);
    S('yt lite: address-bar button', await ui(w, `JSON.stringify({ shown: document.getElementById('lite-btn').classList.contains('show'), name: document.getElementById('lite-name').textContent })`));
    S('yt lite: quality asked for', await jsIn(wc, `window.__q`), '| dislikes', await jsIn(wc, `(document.querySelector('.cloud-dislikes') || {}).textContent || 'none'`),
      '| style', await jsIn(wc, `!!document.getElementById('cloud-yt-lite')`));
    // Remembered speed: set 1.5×, open another video, it comes back at 1.5×.
    await jsIn(wc, `(() => { const v = document.querySelector('video'); v.play().catch(() => {}); return 1; })()`);
    await wait(1500);
    await jsIn(wc, `(() => { document.querySelector('video').playbackRate = 1.5; return 1; })()`);
    await wait(500);
    load(wc, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    await waitFor(() => !wc.isLoading(), 15000);
    await wait(2500);
    S('yt lite: speed remembered on the next video', await jsIn(wc, `window.__rate`));
    // Hide comments, live from the Lite menu's setting.
    setLite('ytLite', 'hideComments', true);
    await wait(600);
    S('yt lite: comments hidden', await jsIn(wc, `getComputedStyle(document.getElementById('comments')).display`));
    await screen('youtube-lite');
    setLite('ytLite', 'hideComments', false);
    // An ad that got through is skipped.
    await jsIn(wc, `(() => { const v = document.querySelector('video'); v.currentTime = 5; document.getElementById('movie_player').classList.add('ad-showing'); return 1; })()`);
    await wait(1600);
    S('yt lite: ad skipped to', await jsIn(wc, `(() => { const v = document.querySelector('video'); document.getElementById('movie_player').classList.remove('ad-showing'); return v.currentTime.toFixed(0) + ' of ' + v.duration.toFixed(0); })()`));
    await jsIn(wc, `(() => { const v = document.querySelector('video'); v.muted = false; v.playbackRate = 1; v.pause(); return 1; })()`);
  });

  await step('shorts', async () => {
    const wc = t.view.webContents;
    load(wc, 'https://www.youtube.com/shorts/abcdefghijk');
    await waitFor(() => !wc.isLoading(), 15000);
    await wait(2500);
    S('shorts: /shorts/ link ended up at', tabUrl(t).slice(0, 70));
    S('shorts: feed items visible', await jsIn(wc, `JSON.stringify([...document.querySelectorAll('ytd-rich-item-renderer')].map(e => e.textContent.trim() + '=' + (e.offsetParent ? 'shown' : 'hidden')))`));
    await screen('no-shorts');
    load(wc, 'https://example.com/');
    await waitFor(() => !wc.isLoading(), 10000);
  });
  try { ses.protocol.unhandle('https'); } catch (e) { S('unhandle failed', e.message); }

  await step('pop out', async () => {
    const pt = createTab(w, 'https://en.wikipedia.org/wiki/Virtual_reality');
    await wait(4000);
    const before = w.tabs.length;
    const pop = popOutTab(pt);
    await wait(1500);
    S('pop out: window', !!pop, 'on top', pop && pop.isAlwaysOnTop(), 'tabs', before, '→', w.tabs.length, 'bounds', JSON.stringify(pt.view.getBounds()));
    await screen('pop-out');
    pop.close();
    await wait(1500);
    S('pop out: back in window', w.tabs.includes(pt), 'active', w.activeId === pt.id, 'tabs', w.tabs.length);
    closeTab(pt.id);
  });

  await step('vr mode', async () => {
    const extra = [createTab(w, 'https://example.org/'), createTab(w, 'https://example.net/')];
    await wait(3000);
    switchTab(w, t.id);
    fakeVr = true;
    checkVr();
    await wait(3000);
    S('vr: active', vrActive, 'badge', await ui(w, `document.getElementById('vr-badge').classList.contains('show')`), 'background tabs asleep', extra.map(x => x.sleeping).join(','));
    setSetting('uiScale', 150);
    await wait(1500);
    S('vr: ui scale 150, page rect', w.pageX, w.pageY, 'rail', w.railW, 'zoom', w.ui.webContents.getZoomFactor());
    await screen('vr-big-ui');
    setSetting('uiScale', 100);
    fakeVr = false; checkVr();
    await wait(2000);
    S('vr: off again', !vrActive, 'page rect', w.pageX, w.pageY);
  });

  await step('quality of life', async () => {
    const q = activeTab(w);
    const wc = q.view.webContents;
    load(wc, 'https://en.wikipedia.org/wiki/Cloud');
    await waitFor(() => !wc.isLoading(), 20000);
    await wait(1500);
    // Point at a link: its address shows in the corner.
    const pt = await wc.executeJavaScript(`(() => { document.body.insertAdjacentHTML('beforeend', '<a id="cbtest" href="https://example.org/where-this-goes" style="position:fixed;left:200px;top:260px;padding:20px 40px;font-size:30px;z-index:2147483647;background:#ffd84d;color:#000">HOVER ME</a>'); const r = document.getElementById('cbtest').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: 'https://example.org/where-this-goes' }; })()`).catch(e => ({ x: 0, y: 0, href: 'ERR ' + e.message }));
    const cbx = w.win.getContentBounds(), vb = q.view.getBounds();
    // Wiggle the real mouse onto the link (Windows only sends hover updates for real movement).
    await powershell(MOUSE_PS + `for ($i = 0; $i -le 4; $i++) { [M]::SetCursorPos(${cbx.x + vb.x + pt.x} + $i, ${cbx.y + vb.y + pt.y}); Start-Sleep -m 60 }; 'ok'`);
    await wait(500);
    const hb = w.hud && w.hud.getBounds();
    S('link preview: shown', !!(w.hud && w.hud.getVisible && w.hud.getVisible()), '| text', w.hud ? await w.hud.webContents.executeJavaScript(`document.getElementById('b').textContent`) : '', '| for', pt.href, '| at', JSON.stringify(hb));
    await screen('link-preview');
    await powershell(MOUSE_PS + `[M]::SetCursorPos(${cbx.x + 400}, ${cbx.y + 20}); 'ok'`);
    await wait(400);
    S('link preview: hidden after moving off', !(w.hud && w.hud.getVisible()));
    // Mouse back button.
    load(wc, 'https://example.com/?utm_source=newsletter&utm_medium=email&id=7');
    await waitFor(() => !wc.isLoading(), 15000);
    await wait(500);
    w.win.emit('app-command', {}, 'browser-backward');
    await wait(2500);
    S('mouse back button: back on', tabUrl(q).slice(0, 45));
    w.win.emit('app-command', {}, 'browser-forward');
    await wait(2500);
    // Copy clean link (Ctrl+Shift+C).
    handleShortcut(w, { type: 'keyDown', control: true, shift: true, key: 'C' });
    await wait(300);
    S('copy clean link:', await clipboard.readText(), '| toast', await w.hud.webContents.executeJavaScript(`document.getElementById('b').textContent`));
    await screen('toast');
    S('link to highlight:', highlightLink('https://example.com/page#top', 'the quick brown fox'));
    // Per-site zoom is remembered.
    zoom(wc, 1);
    load(wc, 'https://example.org/');
    await waitFor(() => !wc.isLoading(), 15000);
    load(wc, 'https://example.com/');
    await waitFor(() => !wc.isLoading(), 15000);
    await wait(500);
    S('site zoom: back on example.com, zoom level', wc.getZoomLevel(), '| saved', JSON.stringify(settings.data.siteZoom));
    zoom(wc, 0);
    // QR code.
    await showQr(w, 'https://en.wikipedia.org/wiki/Cloud');
    await wait(900);
    S('qr: panel', await ui(w, `JSON.stringify({ shown: !document.getElementById('qr-panel').hidden, img: document.getElementById('qr-img').naturalWidth, url: document.getElementById('qr-url').textContent })`));
    await screen('qr-code');
    await ui(w, `closeQr()`);
    // Calculator in the address bar.
    w.ui.webContents.focus();
    await ui(w, `(() => { const a = document.getElementById('address'); a.focus(); a.value = '(12*7+3)/3'; a.dispatchEvent(new Event('input')); })()`);
    await wait(1200);
    S('calculator: suggestions', await ui(w, `[...document.querySelectorAll('#suggestions .sg .t')].slice(0, 3).map(x => x.textContent).join(' | ')`));
    await screen('calculator');
    await ui(w, `(() => { const r = [...document.querySelectorAll('#suggestions .sg')].find(x => x.textContent.startsWith('= ')); r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); })()`);
    await wait(600);
    S('calculator: copied', await clipboard.readText());
    // Auto-refresh.
    let loads = 0;
    const onLoad = () => loads++;
    wc.on('did-finish-load', onLoad);
    setAutoRefresh(q, 15);
    await wait(500);
    S('auto-refresh: tab icon', await ui(w, `!!document.querySelector('.tab.active .autorefresh')`));
    await wait(16500);
    setAutoRefresh(q, 0);
    wc.removeListener('did-finish-load', onLoad);
    S('auto-refresh: reloads in 17 s', loads);
    // Duplicates.
    const d1 = createTab(w, 'https://example.com/', { activate: false });
    const d2 = createTab(w, 'https://example.com/#x', { activate: false });
    await wait(1500);
    S('duplicates found', duplicateTabs(w).length);
    duplicateTabs(w).forEach(x => closeTab(x.id));
    S('duplicates left', duplicateTabs(w).length, '| tabs', w.tabs.length);
    // Reopen a closed window.
    const before = windows.size;
    newWindow(false);
    await wait(2500);
    const nw = [...windows].find(o => o !== w && !o.incognito);
    if (nw) { load(nw.tabs[0].view.webContents, 'https://example.net/'); await wait(2500); nw.win.close(); await wait(1200); }
    S('closed window remembered', closedWindows.length);
    handleShortcut(w, { type: 'keyDown', control: true, shift: true, key: 'T' });
    await wait(2500);
    const reopened = [...windows].find(o => o !== w && !o.incognito);
    S('reopen closed window: windows', before, '→', windows.size, '| tab', reopened && tabUrl(reopened.tabs[0]));
    if (reopened) reopened.win.close();
    await wait(800);
    void d1; void d2;
  });

  await step('roblox lite', async () => {
    const rt = createTab(w, 'https://www.roblox.com/games/920587237/Adopt-Me');
    const rwc = rt.view.webContents;
    await waitFor(() => !rwc.isLoading(), 30000);
    await wait(4000);
    S('roblox lite: on', tabUrl(rt).slice(0, 60), '| address-bar button', await ui(w, `document.getElementById('lite-name').textContent`),
      '| Servers button', await rwc.executeJavaScript(`!!document.getElementById('cloud-rbx-btn')`).catch(e => e.message));
    await rwc.executeJavaScript(`document.getElementById('cloud-rbx-btn').click(); 1`).catch(() => {});
    await waitFor(async () => (await rwc.executeJavaScript(`document.querySelectorAll('#cloud-rbx .srv').length`).catch(() => 0)) > 0, 20000);
    await wait(800);
    S('roblox lite: servers listed', await rwc.executeJavaScript(`document.querySelectorAll('#cloud-rbx .srv').length + ' | ' + document.querySelector('#cloud-rbx .muted').textContent + ' | first: ' + (document.querySelector('#cloud-rbx .srv') || {}).innerText`).catch(e => e.message));
    await screen('roblox-lite');
    await rwc.executeJavaScript(`[...document.querySelectorAll('#cloud-rbx button')].find(b => b.textContent === 'Join best server').click(); 1`).catch(() => {});
    await wait(800);
    S('roblox lite: join best server opens', lastRobloxJoin);
    closeTab(rt.id);
  });

  await step('privacy report', async () => {
    // Browse somewhere with trackers first.
    const t2 = createTab(w, 'https://www.theverge.com/');
    await waitFor(() => !t2.view.webContents.isLoading(), 25000);
    await wait(3000);
    privacyStats.flush();
    openInternal(w, 'privacy');
    await wait(2500);
    const pt = activeTab(w);
    S('privacy: page', tabUrl(pt), '|', JSON.stringify((await pt.view.webContents.executeJavaScript('document.querySelector("main").innerText').catch(e => e.message)).slice(0, 420)));
    await screen('privacy-report');
    S('privacy: forget site', JSON.stringify(await pt.view.webContents.executeJavaScript(`cloud.call('forget-site', 'theverge.com')`).catch(e => e.message)));
    closeTab(t2.id);
    closeTab(pt.id);
  });

  await step('split view', async () => {
    const left = activeTab(w);
    load(left.view.webContents, 'https://example.com/');
    const right = createTab(w, 'https://en.wikipedia.org/wiki/Cloud');
    await wait(3000);
    switchTab(w, left.id);
    toggleSplit(w);
    await wait(1500);
    const sp = splitInfo(w);
    S('split: pair', JSON.stringify(w.split), '| left', JSON.stringify(left.view.getBounds()), '| right', JSON.stringify(right.view.getBounds()),
      '| both visible', left.view.getVisible ? left.view.getVisible() + ',' + right.view.getVisible() : '?', '| ui divider shown', await ui(w, `!document.getElementById('split-divider').hidden`));
    await screen('split-view');
    // Click into the other pane: it becomes the active one (address bar follows).
    const other = w.activeId === left.id ? right : left;
    other.view.webContents.focus();
    await wait(800);
    S('split: clicking the other pane makes it active', w.activeId === other.id, '| address bar', await ui(w, `document.getElementById('address').value`));
    // Drag the divider with the real mouse.
    const cb = w.win.getContentBounds();
    const g = w.splitGeom;
    const before = w.split.ratio;
    await realDrag(cb.x + g.divX + 3, cb.y + g.y + Math.round(g.h / 2), -180, 0);
    await wait(800);
    S('split: dragged divider, ratio', before, '→', w.split && w.split.ratio.toFixed(2), '| overlay down again', !w.overlayOpen);
    await screen('split-resized');
    // A tab outside the pair shows on its own; going back shows the pair again.
    const third = createTab(w, 'https://example.org/');
    await wait(1500);
    S('split: third tab alone', !splitShowing(w), '| pair hidden', (left.view.getVisible ? !left.view.getVisible() && !right.view.getVisible() : '?'));
    switchTab(w, left.id);
    await wait(500);
    S('split: back to the pair', !!splitShowing(w));
    closeTab(third.id);
    toggleSplit(w);
    await wait(500);
    S('split: closed', !w.split, '| full width again', left.view.getBounds().width);
    closeTab(right.id);
  });

  await step('discord lite', async () => {
    const id = discordAppId();
    togglePanel(w, id);
    const v = w.panelViews.get(id);
    const dwc = v.webContents;
    await waitFor(() => !dwc.isLoading(), 30000);
    await wait(8000);
    const dj = (code) => Promise.race([dwc.executeJavaScript(code, true), wait(10000).then(() => 'TIMEOUT')]).catch(e => 'ERR ' + e.message);
    S('discord lite: page', dwc.getURL().slice(0, 50), '| vencord file', fs.existsSync(path.join(discordLite.vencordDir, 'browser.js')));
    S('discord lite: in page', await dj(`JSON.stringify({ vencord: typeof window.Vencord, plugins: window.Vencord && window.Vencord.Plugins ? Object.keys(window.Vencord.Plugins.plugins || {}).length : 0,
      settings: !!window.__DL_SETTINGS, theme: !!document.getElementById('discord-lite-theme'), lite: !!document.getElementById('discord-lite-lite-mode'),
      vencordCss: !!document.getElementById('vencord-css'), bridge: typeof window.__TAURI_INTERNALS__, notif: Notification.permission, ptt: typeof window.__dlPTT, toast: typeof window.__dlToast })`));
    S('discord lite: invoke round trip', await dj(`window.__TAURI_INTERNALS__.invoke('dl_get_settings').then(s => 'liteMode=' + s.liteMode + ' theme=' + s.theme)`));
    await screen('discord-lite');
    // Unread badge from the plugin's command.
    await dj(`window.__TAURI_INTERNALS__.invoke('dl_set_unread', { mentions: 3, unread: true })`);
    await wait(800);
    S('discord lite: badge', JSON.stringify(dlBadge), '| rail badge', await ui(w, `(document.querySelector('.rail-btn.app .rail-badge') || {}).textContent`));
    S('discord lite: notification', await dj(`window.__TAURI_INTERNALS__.invoke('dl_notify', { title: 'CloudBrowser test', body: 'Discord Lite notifications work' }).then(() => 'sent')`));
    // Message Logger+: write an entry like the plugin does, then look at it in the viewer.
    const now = new Date(); const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    S('discord lite: ml_log', await dj(`window.__TAURI_INTERNALS__.invoke('ml_log', { entry: { kind: 'DELETED', date: '${today}', logged_at: new Date().toISOString(), sent_at: new Date().toISOString(), where: 'Test server › #general', guild_id: '1', channel_id: '2', message_id: '3', author: { id: '4', username: 'tester', global_name: 'Tester' }, content: 'this message was deleted', attachments: [], text: '[test] DELETED in Test server by Tester' }, ids: [] }).then(() => 'ok')`));
    openInternal(w, 'discord-log');
    await wait(3000);
    const lt = activeTab(w);
    S('discord lite: log viewer', tabUrl(lt), '|', JSON.stringify((await lt.view.webContents.executeJavaScript('document.body.innerText').catch(e => e.message)).slice(0, 200)));
    await screen('discord-log');
    openInternal(w, 'discord-settings');
    await wait(2500);
    const st = activeTab(w);
    S('discord lite: settings page', JSON.stringify((await st.view.webContents.executeJavaScript('document.body.innerText').catch(e => e.message)).slice(0, 160)));
    await screen('discord-settings');
    closeTab(st.id); closeTab(lt.id);
    // Global push-to-talk: press F13 for real and see Discord hear it.
    await dj(`window.__pttLog = []; const o = window.__dlPTT; window.__dlPTT = p => { window.__pttLog.push(p); o && o(p); }; 1`);
    try { await discordLite.saveFromPage({ ...discordLite.settings, ptt: { enabled: true, key: 'F13', releaseDelayMs: 150 } }); S('ptt: hook started', !!discordLite.pttHook); }
    catch (e) { S('ptt: failed', e.message); }
    await powershell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e); }'; [K]::keybd_event(0x7C,0,0,[UIntPtr]::Zero); Start-Sleep -m 300; [K]::keybd_event(0x7C,0,2,[UIntPtr]::Zero); 'ok'`);
    await wait(800);
    S('ptt: Discord got', await dj(`JSON.stringify(window.__pttLog)`));
    await discordLite.saveFromPage({ ...discordLite.settings, ptt: { enabled: false, key: 'F13', releaseDelayMs: 150 } }).catch(() => {});
    // An ordinary discord.com tab stays plain.
    const plain = createTab(w, 'https://discord.com/login');
    await waitFor(() => !plain.view.webContents.isLoading(), 20000);
    await wait(2000);
    S('discord lite: plain tab untouched', await plain.view.webContents.executeJavaScript(`typeof window.Vencord + ' ' + typeof window.__TAURI_INTERNALS__`).catch(e => e.message));
    closeTab(plain.id);
    // Its own window and back.
    popOutDiscord(w);
    await wait(2000);
    S('discord lite: own window', !!discordPop, discordPop && discordPop.win.getTitle());
    await screen('discord-own-window');
    if (discordPop) discordPop.win.close();
    await wait(1500);
    S('discord lite: back in sidebar', [...windows].some(o => o.panelViews.has(id)), '| still the same page', !dwc.isDestroyed());
    if (w.panelApp === id) togglePanel(w, id);
  });

  await step('screen share picker', async () => {
    const wc = activeTab(w).view.webContents;
    load(wc, 'https://example.com/');
    await waitFor(() => !wc.isLoading(), 10000);
    const p = wc.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(s => 'got ' + s.getTracks().map(t => t.kind + ':' + t.label).join(', ')).catch(e => 'error ' + e.name + ' ' + e.message)`, true);
    await waitFor(() => !!sharePending, 8000);
    await wait(2000);
    S('screen share: picker open', !!sharePending, '| sources', sharePending && sharePending.sources.length);
    await screen('screen-share-picker');
    const pv = sharePending && sharePending.win.contentView.children[0];
    if (pv) await pv.webContents.executeJavaScript(`document.getElementById('share').click(); 1`).catch(e => S('click failed', e.message));
    S('screen share:', await Promise.race([p, wait(10000).then(() => 'TIMEOUT')]));
    await wc.executeJavaScript(`1`).catch(() => {});
  });

  await step('netflix / disney+ (widevine)', async () => {
    const { components } = require('electron');
    S('drm: castLabs build', !!components, '| status now', widevine.status);
    await waitFor(() => widevine.status !== 'starting', 90000);
    S('drm: widevine', widevine.status, JSON.stringify(widevine.components || widevine.error || ''));
    const wc = t.view.webContents;
    load(wc, 'https://example.com/');
    await waitFor(() => !wc.isLoading(), 10000);
    const js = (code) => Promise.race([wc.executeJavaScript(code, true), wait(15000).then(() => 'TIMEOUT')]).catch(e => 'ERR ' + e.message);
    S('drm: page can use Widevine', await js(`navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"', robustness: 'SW_SECURE_DECODE' }] }])
      .then(a => a.createMediaKeys().then(() => 'yes: ' + a.keySystem)).catch(e => 'no: ' + e.name + ' ' + e.message)`));
    // A real Widevine licence exchange against Google's public test server.
    load(wc, 'https://bitmovin.com/demos/drm');
    await waitFor(() => !wc.isLoading(), 25000);
    await wait(12000);
    S('drm: bitmovin demo', await js(`(() => { const v = document.querySelector('video'); return JSON.stringify(v ? { time: +v.currentTime.toFixed(1), paused: v.paused, ready: v.readyState, err: v.error && v.error.message } : 'no video'); })()`));
    await screen('drm-demo');
  });

  S('DONE');
  flushAll();
  if (vpn) vpn.shutdown();
  setTimeout(() => app.exit(0), 500);
}
