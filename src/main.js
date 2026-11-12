// CloudBrowser - main process
//
// Window layout: a BaseWindow holding one WebContentsView per tab, with the browser UI
// (src/ui) as a transparent WebContentsView on top. The UI view is normally only as tall
// as the toolbar; it stretches over the page while the address-bar suggestions are open.
// Built-in pages (settings, history, bookmarks, downloads) are served from src/pages
// on the cloud:// scheme.
'use strict';

const {
  app, BaseWindow, WebContentsView, ipcMain, Menu, shell, dialog, session,
  protocol, nativeTheme, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { Store, flushAll } = require('./store');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) { console.error('Updater unavailable:', e.message); }

// ---------- constants ----------

const SMOKE = process.env.CLOUD_SMOKE === '1';
const NORMAL_PARTITION = 'persist:cloudbrowser';
const PRIVATE_PARTITION = 'cloudbrowser-private'; // no "persist:" = memory only
const PAGES_DIR = path.join(__dirname, 'pages');
const INTERNAL_PAGES = ['settings', 'history', 'bookmarks', 'downloads'];

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
  homePage: 'https://duckduckgo.com/',
  restoreTabs: true,
  theme: 'system',            // system | light | dark
  showBookmarksBar: true,
  adblock: true,
  askDownloadLocation: false,
  blockedTotal: 0,
  window: null,               // { width, height, maximized }
};

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

protocol.registerSchemesAsPrivileged([
  { scheme: 'cloud', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------- state ----------

let settings, bookmarks, history, permissions, downloadStore, sessionStore;
let win = null;
let ui = null;
let uiHeight = 84;
let overlayOpen = false;
let htmlFullscreen = false;
let userFullscreen = false;
let quitting = false;
let tabs = [];            // { id, view, private, favicon, blocked, failedUrl, initialUrl, histEntry }
let activeId = null;
let nextId = 1;
let privateMode = false;
let closedTabs = [];
let updateState = { status: 'idle' };
let blocker = null;
const blockingOn = new Set();
const privatePermissions = new Map(); // origin -> { permission: 'allow'|'block' } (private tabs, this run only)
let downloads = [];      // newest first
const liveDownloads = new Map();
let nextDownloadId = 1;
let downloadsThisRun = 0;

// ---------- small helpers ----------

const log = (...a) => {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  if (process.env.CLOUD_SMOKE_LOG) { try { fs.appendFileSync(process.env.CLOUD_SMOKE_LOG, line + '\n'); } catch {} }
};

function engine() { return ENGINES[settings.data.searchEngine] || ENGINES.duckduckgo; }
function searchUrl(q) { return engine().url.replace('%s', encodeURIComponent(q)); }
function homeUrl() { return settings.data.homePage || engine().home; }

function toUrl(text) {
  text = (text || '').trim();
  if (!text) return homeUrl();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data|mailto|view-source):/i.test(text)) return text;
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return 'http://' + text;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z][a-z0-9-]{1,}(:\d+)?([/?#].*)?$/i.test(text)) return 'https://' + text;
  return searchUrl(text);
}

function load(wc, url) { wc.loadURL(url).catch(() => {}); }
function getTab(id) { return tabs.find(t => t.id === id); }
function activeTab() { return getTab(activeId); }
function tabByContents(wc) { return tabs.find(t => t.view.webContents === wc); }
function uiSend(channel, data) { if (ui && !ui.webContents.isDestroyed()) ui.webContents.send(channel, data); }

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

function openInternal(name, hash = '') {
  const base = `cloud://${name}/`;
  const existing = tabs.find(t => tabUrl(t).startsWith(base));
  if (existing) {
    switchTab(existing.id);
    if (hash) load(existing.view.webContents, base + hash);
  } else {
    createTab(base + hash, { isPrivate: false });
  }
}

function pagesSend(channel, data) {
  for (const t of tabs) {
    const wc = t.view.webContents;
    if (!wc.isDestroyed() && wc.getURL().startsWith('cloud://')) wc.send(channel, data);
  }
}

// ---------- state to the UI ----------

let stateQueued = false;
function sendState() {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => { stateQueued = false; pushState(); }, 16);
}

function isBookmarked(url) { return !!url && bookmarks.data.items.some(b => b.url === url); }

function tabInfo(t) {
  const wc = t.view.webContents;
  const url = tabUrl(t);
  return {
    id: t.id,
    title: wc.getTitle() || (url.startsWith('cloud://') ? '' : url) || 'New tab',
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

function pushState() {
  if (!win || !ui || ui.webContents.isDestroyed()) return;
  const t = activeTab();
  uiSend('state', {
    tabs: tabs.map(tabInfo),
    activeId,
    privateMode,
    update: updateState,
    version: app.getVersion(),
    bookmarks: bookmarks.data.items.map(b => ({ id: b.id, url: b.url, title: b.title, favicon: b.favicon })),
    showBookmarksBar: settings.data.showBookmarksBar,
    adblock: settings.data.adblock && !!blocker,
    downloads: downloadSummary(),
    engineName: engine().name,
  });
  win.setTitle(t ? `${t.view.webContents.getTitle() || 'New tab'} — CloudBrowser` : 'CloudBrowser');
}

// ---------- layout ----------

function layout() {
  if (!win || !ui) return;
  const { width: w, height: h } = win.getContentBounds();
  const top = htmlFullscreen ? 0 : uiHeight;
  for (const t of tabs) t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  ui.setBounds({ x: 0, y: 0, width: w, height: htmlFullscreen ? 0 : (overlayOpen ? h : uiHeight) });
}

// ---------- tabs ----------

function createTab(url, { activate = true, isPrivate = privateMode, openerId = null } = {}) {
  url = url || homeUrl();
  const view = new WebContentsView({
    webPreferences: {
      partition: isPrivate ? PRIVATE_PARTITION : NORMAL_PARTITION,
      preload: path.join(__dirname, 'preload-page.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });
  view.setBackgroundColor('#ffffff');
  const tab = { id: nextId++, view, private: isPrivate, favicon: null, blocked: 0, failedUrl: null, initialUrl: url, histEntry: null };

  const openerIdx = openerId ? tabs.findIndex(t => t.id === openerId) : -1;
  if (openerIdx >= 0) {
    // put it after the opener and any tabs already opened from it
    let i = openerIdx + 1;
    while (i < tabs.length && tabs[i].openerId === openerId) i++;
    tab.openerId = openerId;
    tabs.splice(i, 0, tab);
  } else {
    tabs.push(tab);
  }
  win.contentView.addChildView(view, 0); // below the UI view
  wireTab(tab);
  layout();

  load(view.webContents, url);
  if (activate || !activeId) switchTab(tab.id);
  else view.setVisible(false);
  sendState();
  saveSession();
  return tab;
}

function wireTab(tab) {
  const wc = tab.view.webContents;
  const update = () => sendState();

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
    if (b && tab.favicon && b.favicon !== tab.favicon) { b.favicon = tab.favicon; bookmarks.save(); }
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
  wc.setWindowOpenHandler(({ url, disposition }) => {
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
    createTab(url, { activate: disposition !== 'background-tab', isPrivate: tab.private, openerId: tab.id });
    return { action: 'deny' };
  });
  wc.on('before-input-event', (event, input) => { if (handleShortcut(input)) event.preventDefault(); });
  wc.on('context-menu', (_e, params) => showContextMenu(tab, params));
  wc.on('found-in-page', (_e, r) => { if (tab.id === activeId) uiSend('find-result', { active: r.activeMatchOrdinal, matches: r.matches }); });
  wc.on('zoom-changed', (_e, dir) => zoom(wc, dir === 'in' ? 0.5 : -0.5));
  wc.on('enter-html-full-screen', () => { htmlFullscreen = true; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { htmlFullscreen = false; if (!userFullscreen) win.setFullScreen(false); layout(); });
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

function switchTab(id) {
  const t = getTab(id);
  if (!t) return;
  if (activeId && activeId !== id) {
    const prev = activeTab();
    if (prev) prev.view.webContents.stopFindInPage('clearSelection');
    uiSend('find-close');
  }
  activeId = id;
  for (const x of tabs) x.view.setVisible(x.id === id);
  if (!overlayOpen) t.view.webContents.focus();
  sendState();
  saveSession();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const [t] = tabs.splice(idx, 1);
  const url = tabUrl(t);
  if (url && !url.startsWith('data:')) {
    closedTabs.push({ url, private: t.private });
    if (closedTabs.length > 25) closedTabs.shift();
  }
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (tabs.length === 0) { saveSession(true); win.close(); return; }
  if (activeId === id) {
    const opener = t.openerId && getTab(t.openerId);
    switchTab(opener ? opener.id : tabs[Math.min(idx, tabs.length - 1)].id);
  } else {
    sendState();
  }
  saveSession();
}

function reopenClosedTab() {
  const c = closedTabs.pop();
  if (c) createTab(c.url, { isPrivate: c.private });
}

function cycleTab(dir) {
  if (!tabs.length) return;
  const idx = tabs.findIndex(t => t.id === activeId);
  switchTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
}

function zoom(wc, delta) {
  if (!wc) return;
  const level = delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
}

function setFullscreen(on) {
  userFullscreen = on;
  win.setFullScreen(on);
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

function suggest(q) {
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

function toggleBookmark(tab) {
  if (!tab) return;
  const url = tabUrl(tab);
  if (!/^(https?|cloud|file):/i.test(url)) return;
  const items = bookmarks.data.items;
  const i = items.findIndex(b => b.url === url);
  if (i >= 0) items.splice(i, 1);
  else items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), url, title: tab.view.webContents.getTitle() || hostOf(url), favicon: tab.favicon, added: Date.now() });
  bookmarks.save();
  sendState();
  pagesSend('page:bookmarks', bookmarks.data.items);
}

function saveSession(final = false) {
  if (!sessionStore || (quitting && !final)) return;
  const normal = tabs.filter(t => !t.private);
  sessionStore.data = {
    tabs: normal.map(tabUrl).filter(u => u && !u.startsWith('data:')),
    active: Math.max(0, normal.findIndex(t => t.id === activeId)),
  };
  if (final) sessionStore.flush(); else sessionStore.save();
}

function startTabs(startUrl) {
  const s = sessionStore.data;
  if (settings.data.restoreTabs && Array.isArray(s.tabs) && s.tabs.length) {
    s.tabs.forEach((u, i) => createTab(u, { activate: i === s.active, isPrivate: false }));
    if (startUrl) createTab(startUrl, { isPrivate: false });
  } else {
    createTab(startUrl || homeUrl(), { isPrivate: false });
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
  sendState();
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
      if (state === 'completed') uiSend('download-done', { filename: d.filename });
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

function permissionKey(permission) { return permission; }

function setupPermissions(sess, isPrivate) {
  const saved = (origin) => (isPrivate ? privatePermissions.get(origin) : permissions.data.sites[origin]) || {};

  sess.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    try {
      if (AUTO_ALLOW.has(permission)) return callback(true);
      if (!PROMPT_PERMISSIONS[permission]) return callback(false);
      const origin = originOf(details.requestingUrl || wc.getURL());
      const key = permissionKey(permission);
      const prior = saved(origin)[key];
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
      if (t && t.id !== activeId) switchTab(t.id);
      const res = await dialog.showMessageBox(win, {
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
          privatePermissions.set(origin, { ...saved(origin), [key]: allow ? 'allow' : 'block' });
        } else {
          permissions.data.sites[origin] = { ...saved(origin), [key]: allow ? 'allow' : 'block' };
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
    if (PROMPT_PERMISSIONS[permission]) return saved(originOf(requestingOrigin))[permissionKey(permission)] === 'allow';
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
    blocker.on('request-blocked', (request) => {
      const t = tabs.find(x => !x.view.webContents.isDestroyed() && x.view.webContents.id === request.tabId);
      if (t) t.blocked++;
      settings.data.blockedTotal = (settings.data.blockedTotal || 0) + 1;
      settings.save();
      sendState();
    });
    applyAdblock();
    log('Ad blocker ready');
  } catch (e) {
    blocker = null;
    log('Ad blocker failed to start:', e && e.stack || e);
  }
  sendState();
}

function applyAdblock() {
  if (!blocker) return;
  for (const p of [NORMAL_PARTITION, PRIVATE_PARTITION]) {
    const s = session.fromPartition(p);
    if (settings.data.adblock && !blockingOn.has(p)) {
      // The blocker registers global IPC handlers each time it is enabled for a session,
      // which Electron refuses the second time. Its handlers work for every session, so
      // drop the old one and let it register again.
      for (let attempt = 0; attempt < 6; attempt++) {
        try { blocker.enableBlockingInSession(s); blockingOn.add(p); break; } catch (e) {
          const m = /second handler for '([^']+)'/.exec(e.message);
          if (!m) { log('Ad blocker session error', p, e.message); break; }
          ipcMain.removeHandler(m[1]);
        }
      }
    } else if (!settings.data.adblock && blockingOn.has(p)) {
      try { blocker.disableBlockingInSession(s); } catch (e) { log('Ad blocker disable error', p, e.message); }
      blockingOn.delete(p);
    }
  }
}

// ---------- keyboard shortcuts ----------

function handleShortcut(input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const shift = input.shift;
  const key = (input.key || '').toLowerCase();
  const t = activeTab();
  const wc = t && t.view.webContents;

  if (ctrl && !shift && key === 't') { createTab(); focusAddress(); return true; }
  if (ctrl && shift && key === 't') { reopenClosedTab(); return true; }
  if (ctrl && !shift && key === 'n') { createTab(homeUrl(), { isPrivate: false }); focusAddress(); return true; }
  if (ctrl && shift && key === 'n') { createTab(homeUrl(), { isPrivate: true }); return true; }
  if (ctrl && (key === 'w' || key === 'f4')) { if (t) closeTab(t.id); return true; }
  if (ctrl && key === 'l') { focusAddress(); return true; }
  if (input.alt && key === 'd') { focusAddress(); return true; }
  if ((ctrl && key === 'r') || key === 'f5') { if (wc) (shift ? wc.reloadIgnoringCache() : wc.reload()); return true; }
  if (ctrl && key === 'tab') { cycleTab(shift ? -1 : 1); return true; }
  if (ctrl && key === 'pagedown') { cycleTab(1); return true; }
  if (ctrl && key === 'pageup') { cycleTab(-1); return true; }
  if (ctrl && /^[1-9]$/.test(key)) { const n = Number(key); const target = n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]; if (target) switchTab(target.id); return true; }
  if (ctrl && shift && key === 'p') { togglePrivate(); return true; }
  if (ctrl && !shift && key === 'p') { wc && wc.print(); return true; }
  if (ctrl && !shift && key === 'd') { toggleBookmark(t); return true; }
  if (ctrl && shift && key === 'b') { setSetting('showBookmarksBar', !settings.data.showBookmarksBar); return true; }
  if (ctrl && shift && key === 'o') { openInternal('bookmarks'); return true; }
  if (ctrl && key === 'h') { openInternal('history'); return true; }
  if (ctrl && key === 'j') { openInternal('downloads'); return true; }
  if (ctrl && shift && key === 'delete') { openInternal('settings', '#privacy'); return true; }
  if (ctrl && key === ',') { openInternal('settings'); return true; }
  if (ctrl && (key === 'f' || key === 'g')) {
    if (key === 'g') uiSend('find-next', { forward: !shift }); else uiSend('find-open');
    if (key === 'f') ui.webContents.focus();
    return true;
  }
  if (key === 'f3') { uiSend('find-next', { forward: !shift }); return true; }
  if (input.alt && key === 'arrowleft') { wc && wc.navigationHistory.goBack(); return true; }
  if (input.alt && key === 'arrowright') { wc && wc.navigationHistory.goForward(); return true; }
  if (input.alt && key === 'home') { wc && load(wc, homeUrl()); return true; }
  if (ctrl && (key === '=' || key === '+')) { zoom(wc, 0.5); return true; }
  if (ctrl && key === '-') { zoom(wc, -0.5); return true; }
  if (ctrl && key === '0') { zoom(wc, 0); return true; }
  if (key === 'f11') { setFullscreen(!win.isFullScreen()); return true; }
  if (key === 'f12' || (ctrl && shift && key === 'i')) { wc && wc.toggleDevTools(); return true; }
  if (ctrl && key === 'u') { const u = wc && tabUrl(t); if (u && /^https?:/.test(u)) createTab('view-source:' + u, { isPrivate: t.private, openerId: t.id }); return true; }
  if (key === 'escape' && wc && wc.isLoading() && input.type === 'keyDown' && !ui.webContents.isFocused()) { wc.stop(); return false; }
  return false;
}

function focusAddress() {
  if (!ui) return;
  ui.webContents.focus();
  uiSend('focus-address');
}

function togglePrivate() {
  privateMode = !privateMode;
  sendState();
}

// ---------- menus ----------

function showContextMenu(tab, p) {
  const wc = tab.view.webContents;
  const t = [];
  const sep = () => { if (t.length && t[t.length - 1].type !== 'separator') t.push({ type: 'separator' }); };
  const newTab = (url) => createTab(url, { activate: false, isPrivate: tab.private, openerId: tab.id });

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
      t.push({ label: 'Open link in private tab', click: () => createTab(p.linkURL, { activate: false, isPrivate: true }) });
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
    t.push({ label: `Search ${engine().name} for “${short}”`, click: () => createTab(searchUrl(s), { isPrivate: tab.private, openerId: tab.id }) });
    sep();
  }
  if (!p.linkURL && p.mediaType === 'none' && !p.isEditable && !(p.selectionText || '').trim()) {
    t.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
    t.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
    t.push({ label: 'Reload', click: () => wc.reload() });
    sep();
    t.push({ label: isBookmarked(tabUrl(tab)) ? 'Remove bookmark' : 'Bookmark this page', click: () => toggleBookmark(tab) });
    t.push({ label: 'Save page as…', click: () => savePage(wc) });
    t.push({ label: 'Print…', click: () => wc.print() });
    t.push({ label: 'View page source', enabled: /^https?:/.test(tabUrl(tab)), click: () => createTab('view-source:' + tabUrl(tab), { isPrivate: tab.private, openerId: tab.id }) });
    sep();
  }
  t.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(t).popup({ window: win });
}

async function savePage(wc) {
  const name = (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'page';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), name + '.html'),
    filters: [{ name: 'Web page', extensions: ['html'] }],
  });
  if (!canceled && filePath) wc.savePage(filePath, 'HTMLComplete').catch(e => log('save page failed', e.message));
}

function showMainMenu() {
  const t = activeTab();
  const wc = t && t.view.webContents;
  const zoomPct = wc ? Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100) : 100;
  Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'Ctrl+T', click: () => { createTab(); focusAddress(); } },
    { label: 'New private tab', accelerator: 'Ctrl+Shift+N', click: () => createTab(homeUrl(), { isPrivate: true }) },
    { label: 'Reopen closed tab', accelerator: 'Ctrl+Shift+T', enabled: closedTabs.length > 0, click: reopenClosedTab },
    { type: 'separator' },
    { label: 'History', accelerator: 'Ctrl+H', click: () => openInternal('history') },
    { label: 'Downloads', accelerator: 'Ctrl+J', click: () => openInternal('downloads') },
    { label: 'Bookmarks', accelerator: 'Ctrl+Shift+O', click: () => openInternal('bookmarks') },
    { label: 'Show bookmarks bar', type: 'checkbox', checked: settings.data.showBookmarksBar, accelerator: 'Ctrl+Shift+B',
      click: () => setSetting('showBookmarksBar', !settings.data.showBookmarksBar) },
    { type: 'separator' },
    { label: `Zoom (${zoomPct}%)`, submenu: [
      { label: 'Zoom in', accelerator: 'Ctrl+=', click: () => zoom(wc, 0.5) },
      { label: 'Zoom out', accelerator: 'Ctrl+-', click: () => zoom(wc, -0.5) },
      { label: 'Reset', accelerator: 'Ctrl+0', click: () => zoom(wc, 0) },
    ] },
    { label: 'Find on page…', accelerator: 'Ctrl+F', click: () => { uiSend('find-open'); ui.webContents.focus(); } },
    { label: 'Print…', accelerator: 'Ctrl+P', enabled: !!wc, click: () => wc.print() },
    { label: 'Save page as…', enabled: !!wc, click: () => savePage(wc) },
    { label: 'Full screen', accelerator: 'F11', click: () => setFullscreen(!win.isFullScreen()) },
    { type: 'separator' },
    { label: 'Settings', accelerator: 'Ctrl+,', click: () => openInternal('settings') },
    { label: 'Clear browsing data…', accelerator: 'Ctrl+Shift+Delete', click: () => openInternal('settings', '#privacy') },
    { label: 'Check for updates', click: checkForUpdates },
    { label: 'About CloudBrowser', click: () => openInternal('settings', '#about') },
    { type: 'separator' },
    { label: 'Exit', click: () => win && win.close() },
  ]).popup({ window: win });
}

function showTabMenu(id) {
  const t = getTab(id);
  if (!t) return;
  const idx = tabs.indexOf(t);
  const wc = t.view.webContents;
  Menu.buildFromTemplate([
    { label: 'New tab', click: () => createTab() },
    { type: 'separator' },
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Duplicate', click: () => createTab(tabUrl(t), { isPrivate: t.private, openerId: t.id }) },
    { label: wc.isAudioMuted() ? 'Unmute site' : 'Mute site', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); sendState(); } },
    { label: isBookmarked(tabUrl(t)) ? 'Remove bookmark' : 'Bookmark tab', click: () => toggleBookmark(t) },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(id) },
    { label: 'Close other tabs', enabled: tabs.length > 1, click: () => tabs.filter(x => x.id !== id).map(x => x.id).forEach(closeTab) },
    { label: 'Close tabs to the right', enabled: idx < tabs.length - 1, click: () => tabs.slice(idx + 1).map(x => x.id).forEach(closeTab) },
    { label: 'Reopen closed tab', enabled: closedTabs.length > 0, click: reopenClosedTab },
  ]).popup({ window: win });
}

function showBookmarkMenu(id) {
  const b = bookmarks.data.items.find(x => x.id === id);
  if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => { const t = activeTab(); if (t) load(t.view.webContents, b.url); } },
    { label: 'Open in new tab', click: () => createTab(b.url, { activate: false }) },
    { label: 'Open in private tab', click: () => createTab(b.url, { isPrivate: true }) },
    { type: 'separator' },
    { label: 'Edit…', click: () => openInternal('bookmarks') },
    { label: 'Delete', click: () => {
      bookmarks.data.items = bookmarks.data.items.filter(x => x.id !== id);
      bookmarks.save(); sendState(); pagesSend('page:bookmarks', bookmarks.data.items);
    } },
  ]).popup({ window: win });
}

// ---------- settings ----------

function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS) || key === 'blockedTotal' || key === 'window') return false;
  if (typeof value !== typeof DEFAULT_SETTINGS[key]) return false;
  if (key === 'searchEngine' && !ENGINES[value]) return false;
  if (key === 'theme' && !['system', 'light', 'dark'].includes(value)) return false;
  if (key === 'homePage') value = toUrl(value);
  settings.data[key] = value;
  settings.save();
  if (key === 'theme') nativeTheme.themeSource = value;
  if (key === 'adblock') applyAdblock();
  sendState();
  pagesSend('page:settings', settings.data);
  return true;
}

async function clearData(opts = {}) {
  const s = session.fromPartition(NORMAL_PARTITION);
  if (opts.history) { history.data.items = []; history.save(); for (const t of tabs) t.histEntry = null; }
  if (opts.cookies) await s.clearStorageData();
  if (opts.cache) { await s.clearCache(); await s.clearHostResolverCache(); }
  if (opts.downloads) { downloads = downloads.filter(d => liveDownloads.has(d.id)); persistDownloads(); notifyDownloads(); }
  if (opts.permissions) { permissions.data.sites = {}; permissions.save(); }
  if (opts.history) closedTabs = closedTabs.filter(c => c.private);
  sendState();
  return true;
}

// ---------- auto-update ----------

function setUpdate(status, extra = {}) {
  updateState = { status, ...extra };
  sendState();
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
  ipcMain.on('ui:' + channel, (e, ...args) => { if (ui && e.sender === ui.webContents) fn(...args); });
}

uiOn('new-tab', () => { createTab(); focusAddress(); });
uiOn('close-tab', id => closeTab(id));
uiOn('switch-tab', id => switchTab(id));
uiOn('tab-menu', id => showTabMenu(id));
uiOn('toggle-mute', id => { const t = getTab(id); if (t) { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); sendState(); } });
uiOn('navigate', (text, newTab) => openUrl(toUrl(text), newTab));
uiOn('search', (text, newTab) => openUrl(searchUrl(String(text || '').trim()), newTab));
function openUrl(url, newTab) {
  const t = activeTab();
  if (newTab || !t) { createTab(url); return; }
  load(t.view.webContents, url);
  t.view.webContents.focus();
}
uiOn('back', () => activeTab()?.view.webContents.navigationHistory.goBack());
uiOn('forward', () => activeTab()?.view.webContents.navigationHistory.goForward());
uiOn('reload', () => activeTab()?.view.webContents.reload());
uiOn('stop', () => activeTab()?.view.webContents.stop());
uiOn('home', () => { const t = activeTab(); if (t) load(t.view.webContents, homeUrl()); });
uiOn('toggle-private', togglePrivate);
uiOn('install-update', () => autoUpdater && autoUpdater.quitAndInstall());
uiOn('menu', showMainMenu);
uiOn('toggle-bookmark', () => toggleBookmark(activeTab()));
uiOn('open-bookmark', (url, newTab) => {
  const t = activeTab();
  if (newTab || !t) createTab(url, { activate: !newTab });
  else { load(t.view.webContents, url); t.view.webContents.focus(); }
});
uiOn('bookmark-menu', id => showBookmarkMenu(id));
uiOn('open-internal', (name, hash) => { if (INTERNAL_PAGES.includes(name)) openInternal(name, hash || ''); });
uiOn('find', (text, opts) => {
  const wc = activeTab()?.view.webContents;
  if (!wc) return;
  if (!text) { wc.stopFindInPage('clearSelection'); uiSend('find-result', { active: 0, matches: 0 }); return; }
  wc.findInPage(String(text), { forward: opts?.forward !== false, findNext: !!opts?.newSearch });
});
uiOn('find-stop', () => { const wc = activeTab()?.view.webContents; if (wc) { wc.stopFindInPage('keepSelection'); wc.focus(); } });
uiOn('height', h => { const n = Math.round(Number(h)); if (n > 0 && n < 400 && n !== uiHeight) { uiHeight = n; layout(); } });
uiOn('overlay', open => {
  overlayOpen = !!open;
  layout();
  if (!overlayOpen && !ui.webContents.isFocused()) activeTab()?.view.webContents.focus();
});
uiOn('focus-page', () => activeTab()?.view.webContents.focus());
uiOn('downloads', () => openInternal('downloads'));
ipcMain.handle('ui:suggest', (e, q) => (ui && e.sender === ui.webContents ? suggest(q) : []));

// ---------- IPC: built-in pages ----------

function pageHandle(channel, fn) {
  ipcMain.handle('page:' + channel, (e, ...args) => {
    const url = e.senderFrame && e.senderFrame.url;
    if (!url || !url.startsWith('cloud://')) throw new Error('Not allowed');
    return fn(...args);
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
}));
pageHandle('set-setting', (key, value) => setSetting(key, value));
pageHandle('history', (query) => {
  const q = (query || '').trim().toLowerCase();
  const items = q ? history.data.items.filter(h => (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q)) : history.data.items;
  return items.slice(0, 1000);
});
pageHandle('delete-history', (url, time) => {
  history.data.items = history.data.items.filter(h => !(h.url === url && h.time === time));
  history.save();
  return true;
});
pageHandle('bookmarks', () => bookmarks.data.items);
pageHandle('remove-bookmark', (id) => {
  bookmarks.data.items = bookmarks.data.items.filter(b => b.id !== id);
  bookmarks.save(); sendState();
  return bookmarks.data.items;
});
pageHandle('edit-bookmark', (id, title, url) => {
  const b = bookmarks.data.items.find(x => x.id === id);
  if (b) { b.title = String(title || '').slice(0, 300) || b.title; if (url) b.url = toUrl(url); bookmarks.save(); sendState(); }
  return bookmarks.data.items;
});
pageHandle('move-bookmark', (id, dir) => {
  const items = bookmarks.data.items;
  const i = items.findIndex(b => b.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < items.length) { [items[i], items[j]] = [items[j], items[i]]; bookmarks.save(); sendState(); }
  return items;
});
pageHandle('downloads', () => downloads);
pageHandle('download-action', (id, action) => { downloadAction(id, action); return true; });
pageHandle('clear-downloads', () => { downloads = downloads.filter(d => liveDownloads.has(d.id)); persistDownloads(); notifyDownloads(); return downloads; });
pageHandle('permissions', () => {
  const out = [];
  for (const [origin, perms] of Object.entries(permissions.data.sites)) {
    for (const [permission, value] of Object.entries(perms)) out.push({ origin, permission, value, label: PROMPT_PERMISSIONS[permission] || permission });
  }
  return out.sort((a, b) => a.origin.localeCompare(b.origin));
});
pageHandle('remove-permission', (origin, permission) => {
  const p = permissions.data.sites[origin];
  if (p) { delete p[permission]; if (!Object.keys(p).length) delete permissions.data.sites[origin]; permissions.save(); }
  return true;
});
pageHandle('clear-data', (opts) => clearData(opts || {}));
pageHandle('check-updates', () => { checkForUpdates(); return true; });
pageHandle('install-update', () => { autoUpdater && autoUpdater.quitAndInstall(); return true; });
pageHandle('open-downloads-folder', () => { shell.openPath(app.getPath('downloads')); return true; });

// ---------- app ----------

function createWindow(startUrl) {
  const saved = settings.data.window || {};
  win = new BaseWindow({
    width: saved.width || 1280,
    height: saved.height || 820,
    minWidth: 520,
    minHeight: 320,
    title: 'CloudBrowser',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c2029' : '#e6edf7',
    autoHideMenuBar: true,
  });
  if (saved.maximized) win.maximize();

  ui = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-ui.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  ui.setBackgroundColor('#00000000');
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  ui.webContents.on('before-input-event', (event, input) => { if (handleShortcut(input)) event.preventDefault(); });
  if (SMOKE) {
    ui.webContents.on('console-message', (ev) => log('[ui console]', ev.message));
    ui.webContents.on('preload-error', (_e, p, err) => log('[ui preload-error]', p, String(err)));
  }
  ui.webContents.once('did-finish-load', () => {
    startTabs(startUrl);
    layout();
    pushState();
    if (SMOKE) smokeTest();
  });

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) win.on(ev, layout);
  win.on('close', () => {
    saveSession(true);
    quitting = true;
    const b = win.getNormalBounds();
    settings.data.window = { width: b.width, height: b.height, maximized: win.isMaximized() };
    settings.flush();
  });
  win.on('closed', () => {
    for (const t of tabs) { try { t.view.webContents.close(); } catch {} }
    try { ui.webContents.close(); } catch {}
    tabs = []; win = null; ui = null;
    flushAll();
    app.quit();
  });
}

function argUrl(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-') && a !== '.');
  return args.length ? toUrl(args.join(' ')) : null;
}

process.on('uncaughtException', e => log('Uncaught exception:', e && e.stack || String(e)));
process.on('unhandledRejection', e => log('Unhandled rejection:', e && e.stack || String(e)));

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    createTab(argUrl(argv) || homeUrl());
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cloudbrowser.app');
    Menu.setApplicationMenu(null);

    settings = new Store('settings', DEFAULT_SETTINGS);
    bookmarks = new Store('bookmarks', { items: [] });
    history = new Store('history', { items: [] });
    permissions = new Store('permissions', { sites: {} });
    downloadStore = new Store('downloads', { items: [] });
    sessionStore = new Store('session', { tabs: [], active: 0 });
    downloads = (downloadStore.data.items || []).map(d => (d.state === 'progressing' || d.state === 'paused') ? { ...d, state: 'interrupted' } : d);
    nextDownloadId = downloads.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;
    nativeTheme.themeSource = settings.data.theme;

    for (const [p, isPrivate] of [[NORMAL_PARTITION, false], [PRIVATE_PARTITION, true]]) {
      const s = session.fromPartition(p);
      s.protocol.handle('cloud', handleCloudRequest);
      setupPermissions(s, isPrivate);
      setupDownloads(s, isPrivate);
    }

    createWindow(argUrl(process.argv));
    setupUpdater();
    setupAdblock();
  });

  app.on('before-quit', () => { quitting = true; flushAll(); });
  app.on('window-all-closed', () => app.quit());
}

// ---------- automated smoke test (CI only: CLOUD_SMOKE=1) ----------

async function smokeTest() {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const S = (...a) => log('[SMOKE]', ...a);
  const shot = async (name) => {
    try {
      const t = activeTab();
      const uiImg = await ui.webContents.capturePage();
      const pageImg = t ? await t.view.webContents.capturePage() : null;
      for (const [part, img] of [['ui', uiImg], ['page', pageImg]]) {
        if (!img || img.isEmpty()) { S(`shot ${name}/${part} empty`); continue; }
        const small = img.getSize().width > 1000 ? img.resize({ width: 1000 }) : img;
        const b64 = small.toJPEG(72).toString('base64');
        log(`[SHOT-BEGIN ${name}-${part}]`);
        for (let i = 0; i < b64.length; i += 3000) log('[SHOT] ' + b64.slice(i, i + 3000));
        log(`[SHOT-END ${name}-${part}]`);
      }
    } catch (e) { S('shot failed', name, e.message); }
  };
  try {
    await wait(5000);
    S('version', app.getVersion(), 'tabs', tabs.length, 'uiHeight', uiHeight, 'adblock', !!blocker);
    let t = activeTab();
    S('first tab', tabUrl(t), t.view.webContents.getTitle());
    await shot('start');

    load(t.view.webContents, 'https://example.com/');
    await wait(4000);
    S('example title', t.view.webContents.getTitle(), 'history', history.data.items.length);
    toggleBookmark(t);
    S('bookmarked', isBookmarked(tabUrl(t)), 'count', bookmarks.data.items.length);
    S('suggest exam', suggest('exam'));
    S('toUrl', toUrl('cats and dogs'), toUrl('bbc.co.uk'), toUrl('localhost:3000'), toUrl('cloud://settings'));
    t.view.webContents.findInPage('domain', { findNext: true });
    await wait(1000);

    createTab('https://www.theverge.com/');
    await wait(9000);
    S('ad-heavy page blocked', activeTab().blocked, 'total', settings.data.blockedTotal);
    await shot('verge');

    for (const p of INTERNAL_PAGES) {
      openInternal(p);
      await wait(2000);
      const wc = activeTab().view.webContents;
      const text = await wc.executeJavaScript('document.body.innerText.slice(0, 300)').catch(e => 'ERR ' + e.message);
      const hasApi = await wc.executeJavaScript('typeof window.cloud').catch(() => 'ERR');
      S('page', p, wc.getURL(), JSON.stringify(wc.getTitle()), 'api', hasApi, 'text', JSON.stringify(text));
      await shot(p);
    }
    const apiOnWeb = await tabs[0].view.webContents.executeJavaScript('typeof window.cloud').catch(() => 'ERR');
    S('cloud api exposed on normal website?', apiOnWeb);

    S('blocking sessions', [...blockingOn]);
    const pt = createTab('https://www.theverge.com/', { isPrivate: true });
    await wait(9000);
    S('private tab blocked', pt.blocked, 'history recorded?', history.data.items.filter(h => h.url.includes('theverge')).length);
    load(pt.view.webContents, 'https://example.org/');
    await wait(2500);

    // download
    session.fromPartition(NORMAL_PARTITION).downloadURL('https://github.com/DaCloudi/CloudBrowser/releases/download/v1.0.1/latest.yml');
    await wait(6000);
    S('downloads', downloads.slice(0, 2).map(d => ({ f: d.filename, state: d.state, bytes: d.received, path: d.path })));
    openInternal('downloads');
    await wait(1500);
    await shot('downloads-after');

    // dark theme + address bar suggestions
    setSetting('theme', 'dark');
    await wait(800);
    await ui.webContents.executeJavaScript(`(() => { const a = document.getElementById('address'); a.focus(); a.value = 'exam'; a.dispatchEvent(new Event('input')); })()`);
    await wait(1500);
    S('overlay open', overlayOpen);
    await shot('suggest-dark');
    await ui.webContents.executeJavaScript(`document.getElementById('address').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await ui.webContents.executeJavaScript(`document.getElementById('address').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await wait(500);
    S('overlay after escape', overlayOpen);
    openInternal('settings');
    await wait(1500);
    await shot('settings-dark');
    setSetting('theme', 'system');
    switchTab(pt.id);
    await wait(300);
    closeTab(pt.id);
    reopenClosedTab();
    await wait(1500);
    S('reopened', tabUrl(activeTab()), 'private', activeTab().private);
    uiSend('find-open');
    await wait(500);
    await shot('final');
    S('session', sessionStore.data);
    S('DONE');
  } catch (e) {
    S('ERROR', e && e.stack || String(e));
  } finally {
    flushAll();
    setTimeout(() => app.exit(0), 500);
  }
}
