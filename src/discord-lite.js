// Discord Lite, built into CloudBrowser.
//
// This is the backend of the standalone Discord Lite app (Rust/Tauri), rewritten for
// CloudBrowser's Electron: Discord's real web client with Vencord, the Discord Lite
// plugins (Desktop Integration, Call Enhancer, Message Logger+), themes, Lite/Compact mode,
// notifications, the unread badge, global push-to-talk and the freeze watchdog.
//
// It shares Discord Lite's data folder (%APPDATA%\com.local.discordlite), so your
// settings, theme.css, plugins, Vencord copy and message logs carry straight over.
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = path.join(__dirname, 'discord-lite');
const VENCORD_JS_URL = 'https://raw.githubusercontent.com/Vencord/builds/main/browser.js';
const VENCORD_CSS_URL = 'https://raw.githubusercontent.com/Vencord/builds/main/browser.css';
const VENCORD_CHECK_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LIMIT_BYTES = 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'discord.gg', 'discord.new', 'discordapp.net'];

const DEFAULT_THEME = `/*
  Discord Lite custom theme.
  Pick "Custom (theme.css)" in Discord Lite settings > Theme to use this file.
  Edit it, then choose "Reload theme" from the Discord button's right-click menu.

  Example: uncomment the block below for an OLED-black look.
*/

/*
.theme-dark, .theme-darker, .theme-midnight {
  --background-primary: #000;
  --background-secondary: #050505;
  --background-secondary-alt: #0a0a0a;
  --background-tertiary: #000;
  --bg-base-primary: #000;
  --bg-base-secondary: #050505;
  --bg-base-tertiary: #000;
}
*/
`;

const LITE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition: none !important;
  scroll-behavior: auto !important;
}
* { backdrop-filter: none !important; }
[class*="nowPlayingColumn"] { display: none !important; }
`;

const COMPACT_CSS = `
[class*="cozyMessage_"] { padding-left: 58px !important; padding-top: 1px !important; padding-bottom: 1px !important; min-height: 0 !important; }
[class*="cozyMessage_"][class*="groupStart_"] { margin-top: 8px !important; }
[class*="cozyMessage_"] img[class*="avatar_"] { width: 30px !important; height: 30px !important; left: 16px !important; margin-top: 3px !important; }
[class*="cozyMessage_"] [class*="header_"] { min-height: 0 !important; line-height: 1.2 !important; }
[class*="cozyMessage_"] [class*="messageContent_"] { line-height: 1.3 !important; }
li[class*="containerDefault_"] { padding-top: 0 !important; padding-bottom: 0 !important; }
li[class*="containerDefault_"] [class*="link_"] { padding-top: 3px !important; padding-bottom: 3px !important; min-height: 0 !important; }
li[class*="containerDefault_"] [class*="mainContent_"] { padding-top: 10px !important; }
`;

const DEFAULTS = {
  liteMode: true,
  compactMode: false,
  theme: 'custom',
  autostart: false,
  startMinimized: true,
  openLinksInBrowser: true,
  notifications: true,
  unreadBadge: true,
  readAllButton: true,
  plainFolders: true,
  autoUpdateVencord: true,
  autoRecover: true,
  backgroundStart: true, // CloudBrowser: keep Discord running in the background for notifications
  ptt: { enabled: false, key: 'F13', releaseDelayMs: 150 },
  logger: {
    logDeletes: true, logEdits: true, ignoreOwnMessages: true, ignoreBots: true, logWhere: 'all',
    cacheAttachments: 'all', maxAttachmentMb: 25, ghostPingAlerts: true, ghostPingWindowMinutes: 15,
    rememberMessages: 30000, showButton: true, shortcut: true, keepDays: 30,
  },
  call: {
    maxBitrateKbps: 96, stereo: false, receiveStereo: true, fec: true, dtx: false,
    levelling: 'off', rawMic: true, micMeter: true,
  },
};

function merge(def, val) {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return JSON.parse(JSON.stringify(def));
  const out = {};
  for (const k of Object.keys(def)) {
    if (def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) out[k] = merge(def[k], val[k]);
    else out[k] = (k in val && typeof val[k] === typeof def[k]) ? val[k] : def[k];
  }
  return out;
}

function styleScript(id, css) {
  return `(function () {
  var css = ${JSON.stringify(css)};
  function apply() {
    var s = document.getElementById(${JSON.stringify(id)});
    if (!s) { s = document.createElement('style'); s.id = ${JSON.stringify(id)}; (document.head || document.documentElement).appendChild(s); }
    s.textContent = css;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
})();`;
}

function sanitize(name, max) {
  let s = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+|\.+$/g, '').slice(0, max);
  return s || 'file';
}

function isDiscordHost(host) {
  host = String(host || '').toLowerCase();
  return DISCORD_HOSTS.some(d => host === d || host.endsWith('.' + d));
}

function allowedCdnUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['discordapp.com', 'discordapp.net', 'discord.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}

function pluginVersion(code) {
  const line = code.split('\n').slice(0, 10).find(l => l.includes('@version'));
  const n = line ? parseInt(line.split('@version')[1], 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

class DiscordLite {
  /**
   * @param {object} o
   * @param {Electron.App} o.app
   * @param {() => Electron.Session} o.session  session Discord runs in (for downloads)
   * @param {Function} o.log
   * @param {(title: string, body: string, onClick?: Function) => void} o.notify
   * @param {(url: string) => void} o.openUrl            open a link in a CloudBrowser tab
   * @param {(page: string) => void} o.openPage          open cloud://<page>/
   * @param {() => void} o.showDiscord
   * @param {(mentions: number, unread: boolean, isNewMention: boolean) => void} o.onBadge
   * @param {() => boolean} o.discordVisible
   * @param {() => boolean} o.anyWindowFocused
   */
  constructor(o) {
    Object.assign(this, o);
    const appData = o.app.getPath('appData');
    const local = process.env.LOCALAPPDATA || appData;
    this.configDir = path.join(appData, 'com.local.discordlite');
    this.cacheDir = path.join(local, 'com.local.discordlite', 'attachment-cache');
    this.logDir = path.join(this.configDir, 'message-log');
    this.keptDir = path.join(this.logDir, 'deleted-attachments');
    this.vencordDir = path.join(this.configDir, 'vencord');
    this.pluginsDir = path.join(this.configDir, 'plugins');
    this.views = new Set();           // Discord webContents running Discord Lite
    this.keepIds = new Set();         // attachments to keep once downloaded
    this.downloads = 0;
    this.badge = { mentions: 0, unread: false };
    this.lastBeat = Date.now();
    this.pttHook = null;
    this.pttState = false;
    this.settings = this.loadSettings();
    this.bundleCache = null;
  }

  // ---------- settings ----------

  loadSettings() {
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(this.configDir, 'settings.json'), 'utf8')); } catch {}
    const merged = merge(DEFAULTS, s);
    if (!s) this.saveSettings(merged);
    return merged;
  }
  saveSettings(s) {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      fs.writeFileSync(path.join(this.configDir, 'settings.json'), JSON.stringify(s, null, 2));
    } catch (e) { this.log('discord-lite: saving settings failed', e.message); throw e; }
  }

  // ---------- what gets injected into Discord ----------

  themeCss(theme) {
    const read = f => { try { return fs.readFileSync(path.join(HERE, 'themes', f), 'utf8'); } catch { return ''; } };
    if (theme === 'clean-lite') return read('clean-lite.css');
    if (theme === 'root-style') return read('root-style.css');
    if (theme === 'phoenix') return read('root-style.css') + '\n' + read('phoenix.css');
    if (theme === 'custom') return this.loadTheme();
    return '';
  }
  themePath() { return path.join(this.configDir, 'theme.css'); }
  loadTheme() {
    const p = this.themePath();
    try {
      if (!fs.existsSync(p)) { fs.mkdirSync(this.configDir, { recursive: true }); fs.writeFileSync(p, DEFAULT_THEME); }
      return fs.readFileSync(p, 'utf8');
    } catch { return ''; }
  }

  bootstrapScript() {
    return `(function () {
  window.__DL_SETTINGS = ${JSON.stringify(this.settings)};
  window.__dlOnSettings = [];
  window.__dlApplySettings = function (next) {
    var cur = window.__DL_SETTINGS;
    Object.keys(next || {}).forEach(function (k) {
      if (next[k] && typeof next[k] === 'object' && cur[k] && typeof cur[k] === 'object') Object.assign(cur[k], next[k]);
      else cur[k] = next[k];
    });
    window.__dlOnSettings.forEach(function (f) { try { f(cur); } catch (e) { console.warn(e); } });
  };
})();`;
  }

  /** Install bundled plugins (upgrading older copies; yours is kept as .bak), then read them all. */
  loadPlugins() {
    try { fs.mkdirSync(this.pluginsDir, { recursive: true }); } catch {}
    const upgraded = [];
    for (const name of fs.readdirSync(path.join(HERE, 'plugins'))) {
      if (!name.endsWith('.js')) continue;
      if (fs.existsSync(path.join(this.pluginsDir, '_' + name))) continue; // switched off
      const code = fs.readFileSync(path.join(HERE, 'plugins', name), 'utf8');
      const dest = path.join(this.pluginsDir, name);
      let existing = null;
      try { existing = fs.readFileSync(dest, 'utf8'); } catch {}
      try {
        if (existing === null) fs.writeFileSync(dest, code);
        else if (pluginVersion(existing) < pluginVersion(code)) {
          fs.writeFileSync(dest + '.bak', existing);
          fs.writeFileSync(dest, code);
          upgraded.push(name);
        }
      } catch {}
    }
    if (upgraded.length) this.notify('Discord Lite plugins updated', `${upgraded.join(', ')} updated.`);
    let files = [];
    try { files = fs.readdirSync(this.pluginsDir).filter(n => n.endsWith('.js') && !n.startsWith('_')).sort(); } catch {}
    return files.map(name => {
      let code = '';
      try { code = fs.readFileSync(path.join(this.pluginsDir, name), 'utf8'); } catch { return ''; }
      const label = JSON.stringify(name);
      return `(function () {\ntry {\n${code}\n} catch (e) { console.error('[Discord Lite] plugin ' + ${label} + ' failed:', e); }\n})();\n//# sourceURL=discord-lite-plugin/${name.replace(/[^A-Za-z0-9.-]/g, '_')}\n`;
    });
  }

  readVencord() {
    try {
      return {
        js: fs.readFileSync(path.join(this.vencordDir, 'browser.js'), 'utf8'),
        css: fs.readFileSync(path.join(this.vencordDir, 'browser.css'), 'utf8'),
      };
    } catch { return null; }
  }

  async fetchText(url) {
    const r = await this.session().fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
  }

  /** Download Vencord if it's missing; returns true if it changed. */
  async updateVencord(onlyIfMissing) {
    if (onlyIfMissing && this.readVencord()) return false;
    const [js, css] = await Promise.all([this.fetchText(VENCORD_JS_URL), this.fetchText(VENCORD_CSS_URL)]);
    const cur = this.readVencord();
    if (cur && cur.js === js && cur.css === css) return false;
    fs.mkdirSync(this.vencordDir, { recursive: true });
    for (const [name, body] of [['browser.js', js], ['browser.css', css]]) {
      const tmp = path.join(this.vencordDir, name + '.tmp');
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, path.join(this.vencordDir, name));
    }
    try { fs.writeFileSync(path.join(this.vencordDir, 'last-check'), String(Math.floor(Date.now() / 1000))); } catch {}
    this.bundleCache = null;
    return true;
  }

  /** Everything injected before Discord's own code runs, in order. */
  bundle() {
    if (this.bundleCache) return this.bundleCache;
    const parts = [
      this.bootstrapScript(),
      styleScript('discord-lite-lite-mode', this.settings.liteMode ? LITE_CSS : ''),
      styleScript('discord-lite-compact', this.settings.compactMode ? COMPACT_CSS : ''),
    ];
    const v = this.readVencord();
    if (v) parts.push(`${v.js}\n;\n//# sourceURL=vencord-browser.js\n`, styleScript('vencord-css', v.css));
    parts.push(...this.loadPlugins());
    parts.push(styleScript('discord-lite-theme', this.themeCss(this.settings.theme)));
    this.bundleCache = parts; // run one after another, each on its own (like separate init scripts)
    return this.bundleCache;
  }

  // ---------- Discord views ----------

  attach(wc) {
    this.views.add(wc);
    wc.once('destroyed', () => this.views.delete(wc));
  }
  isView(wc) { return this.views.has(wc); }
  evalAll(js) {
    for (const wc of this.views) if (!wc.isDestroyed()) wc.executeJavaScript(js).catch(() => {});
  }

  // ---------- start-up and background jobs ----------

  async start() {
    this.started = true;
    try {
      if (await this.updateVencord(true)) this.log('discord-lite: Vencord downloaded');
    } catch (e) {
      this.log('discord-lite: Vencord download failed', e.message);
      this.notify('Discord Lite: couldn\'t load Vencord', String(e.message || e));
    }
    this.applyPtt(this.settings.ptt).catch(e => this.notify('Push-to-talk key not set', String(e.message || e)));
    setTimeout(() => this.dailyJobs(), 60 * 1000);
    setInterval(() => this.dailyJobs(), 6 * 60 * 60 * 1000);
    setInterval(() => this.watchdog(), 15 * 1000);
  }

  async dailyJobs() {
    if (this.settings.logger.keepDays > 0) this.cleanupOld(this.settings.logger.keepDays);
    if (this.settings.autoUpdateVencord) {
      let last = 0;
      try { last = Number(fs.readFileSync(path.join(this.vencordDir, 'last-check'), 'utf8')) * 1000 || 0; } catch {}
      if (Date.now() - last >= VENCORD_CHECK_MS) {
        try {
          if (await this.updateVencord(false)) this.notify('Vencord updated', 'The new version loads the next time Discord reloads (right-click the Discord button › Reload Discord).');
        } catch {}
      }
    }
  }

  /** If Discord is on screen but stops answering, ask once, then reload it. */
  async watchdog() {
    if (!this.settings.autoRecover || !this.discordVisible()) { this.lastBeat = Date.now(); return; }
    if (Date.now() - this.lastBeat < 60 * 1000) return;
    this.evalAll('window.__dlPing && window.__dlPing()');
    await new Promise(r => setTimeout(r, 20 * 1000));
    if (Date.now() - this.lastBeat >= 80 * 1000) {
      this.log('discord-lite: Discord stopped responding, reloading');
      for (const wc of this.views) if (!wc.isDestroyed()) wc.loadURL('https://discord.com/app').catch(() => {});
      this.lastBeat = Date.now();
    }
  }

  // ---------- global push-to-talk ----------

  async applyPtt(ptt) {
    if (this.pttHook) { try { this.pttHook.stop(); } catch {} this.pttHook = null; }
    if (!ptt || !ptt.enabled) return;
    let lib;
    try { lib = require('uiohook-napi'); } catch (e) { throw new Error('Global push-to-talk isn\'t available on this computer (' + e.message + ')'); }
    const { uIOhook, UiohookKey } = lib;
    const parts = String(ptt.key || '').split('+');
    const code = parts.pop();
    const mods = new Set(parts);
    const name = code.replace(/^Key([A-Z])$/, '$1').replace(/^Digit(\d)$/, '$1')
      .replace(/^ControlLeft$/, 'Ctrl').replace(/^ControlRight$/, 'CtrlRight').replace(/^ShiftLeft$/, 'Shift')
      .replace(/^AltLeft$/, 'Alt').replace(/^MetaLeft$|^OSLeft$/, 'Meta').replace(/^NumpadEnter$/, 'Enter');
    const keycode = UiohookKey[name];
    if (keycode == null) throw new Error(`"${ptt.key}" isn't a key that can be used for push-to-talk`);
    const send = (pressed) => {
      if (pressed === this.pttState) return;
      this.pttState = pressed;
      this.evalAll(`window.__dlPTT && window.__dlPTT(${pressed})`);
    };
    const modsOk = e => (!mods.has('Ctrl') || e.ctrlKey) && (!mods.has('Alt') || e.altKey) && (!mods.has('Shift') || e.shiftKey) && (!mods.has('Super') || e.metaKey);
    uIOhook.on('keydown', e => { if (e.keycode === keycode && modsOk(e)) send(true); });
    uIOhook.on('keyup', e => { if (e.keycode === keycode) send(false); });
    uIOhook.start();
    this.pttHook = { stop: () => { uIOhook.removeAllListeners('keydown'); uIOhook.removeAllListeners('keyup'); uIOhook.stop(); } };
  }

  stop() { if (this.pttHook) { try { this.pttHook.stop(); } catch {} this.pttHook = null; } }

  // ---------- message logger ----------

  findCached(id) {
    try {
      const n = fs.readdirSync(this.cacheDir).find(f => f.startsWith(id + '__'));
      return n ? path.join(this.cacheDir, n) : null;
    } catch { return null; }
  }
  keepFile(cached) {
    try { fs.mkdirSync(this.keptDir, { recursive: true }); fs.copyFileSync(cached, path.join(this.keptDir, path.basename(cached))); } catch {}
  }
  pruneCache() {
    let files = [];
    try {
      files = fs.readdirSync(this.cacheDir).map(n => {
        const p = path.join(this.cacheDir, n);
        const st = fs.statSync(p);
        return { p, t: st.mtimeMs, len: st.size };
      });
    } catch { return; }
    let total = files.reduce((a, f) => a + f.len, 0);
    if (total <= CACHE_LIMIT_BYTES) return;
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= CACHE_LIMIT_BYTES) break;
      try { fs.unlinkSync(f.p); total -= f.len; } catch {}
    }
  }
  cleanupOld(days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sweep = (dir, filter) => {
      try {
        for (const n of fs.readdirSync(dir)) {
          const p = path.join(dir, n);
          try { const st = fs.statSync(p); if (st.isFile() && filter(n) && st.mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
        }
      } catch {}
    };
    sweep(this.logDir, n => n.endsWith('.txt') || n.endsWith('.jsonl'));
    sweep(this.keptDir, () => true);
  }
  keptFiles() {
    const map = new Map();
    try { for (const n of fs.readdirSync(this.keptDir)) { const i = n.indexOf('__'); if (i > 0) map.set(n.slice(0, i), n); } } catch {}
    return map;
  }
  /** Serves saved attachments to the log viewer (cloud://discord-log/file/<name>). */
  keptFile(name) {
    if (!name || name.length >= 200 || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return null;
    try { return fs.readFileSync(path.join(this.keptDir, name)); } catch { return null; }
  }

  // ---------- commands (what the Tauri app's invoke() handled) ----------

  async invoke(cmd, args, sender) {
    args = args || {};
    const s = this.settings;
    switch (cmd) {
      case 'dl_get_settings': return s;
      case 'dl_save_settings': return this.saveFromPage(args.settings);
      case 'dl_open_theme_file': {
        this.loadTheme();
        require('child_process').spawn('notepad.exe', [this.themePath()], { detached: true, stdio: 'ignore' }).unref();
        return null;
      }
      case 'dl_open_external': {
        try { const u = new URL(String(args.url)); if (/^https?:$/.test(u.protocol)) this.openUrl(u.href); } catch {}
        return null;
      }
      case 'dl_notify':
        if (s.notifications) this.notify(String(args.title || 'Discord'), String(args.body || ''), () => this.showDiscord());
        return null;
      case 'dl_set_unread': {
        if (!s.unreadBadge) return null;
        const mentions = Math.max(0, Number(args.mentions) || 0), unread = !!args.unread;
        const prev = this.badge;
        if (prev.mentions === mentions && prev.unread === unread) return null;
        this.badge = { mentions, unread };
        this.onBadge(mentions, unread, mentions > prev.mentions);
        return null;
      }
      case 'dl_open_settings': this.openPage('discord-settings'); return null;
      case 'dl_reload_theme': this.reloadTheme(); return null;
      case 'dl_test_notification': this.notify('Discord Lite', 'Notifications are working.'); return null;
      case 'dl_heartbeat': this.lastBeat = Date.now(); return null;
      case 'dl_update_status': return { current: this.app.getVersion(), sourceKnown: true, available: null };
      case 'dl_run_update': throw new Error('Discord Lite updates come with CloudBrowser updates now.');
      case 'dl_save_capture': {
        const dir = path.join(this.configDir, 'captures');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `layout-${Math.floor(Date.now() / 1000)}.html`);
        fs.writeFileSync(file, String(args.html || ''));
        return file;
      }
      case 'dl_set_titlebar': return null; // CloudBrowser keeps its own title bar
      case 'ml_log': return this.mlLog(args.entry, args.ids);
      case 'ml_cache_attachment': this.cacheAttachment(args.id, args.url, args.name); return null;
      case 'ml_ghost_ping':
        this.notify(String(args.title || 'Ghost ping'), String(args.body || ''), () => this.showDiscord());
        if (!this.anyWindowFocused()) this.onBadge(this.badge.mentions, this.badge.unread, true);
        return null;
      case 'ml_list_days': {
        try { return fs.readdirSync(this.logDir).filter(n => n.endsWith('.jsonl')).map(n => n.slice(0, -6)).sort().reverse(); } catch { return []; }
      }
      case 'ml_read_day': return this.readDay(args.date);
      case 'ml_open_folder': {
        fs.mkdirSync(this.logDir, { recursive: true });
        require('electron').shell.openPath(this.logDir);
        return null;
      }
      case 'ml_open_viewer': this.openPage('discord-log'); return null;
      default: throw new Error('Unknown Discord Lite command: ' + cmd);
    }
  }

  async saveFromPage(next) {
    const old = this.settings;
    const s = merge(DEFAULTS, next);
    if (JSON.stringify(s.ptt) !== JSON.stringify(old.ptt)) {
      try { await this.applyPtt(s.ptt); } catch (e) { await this.applyPtt(old.ptt).catch(() => {}); throw e; }
    }
    this.saveSettings(s);
    this.settings = s;
    this.bundleCache = null;
    if (s.liteMode !== old.liteMode) this.evalAll(styleScript('discord-lite-lite-mode', s.liteMode ? LITE_CSS : ''));
    if (s.compactMode !== old.compactMode) this.evalAll(styleScript('discord-lite-compact', s.compactMode ? COMPACT_CSS : ''));
    if (s.theme !== old.theme) this.evalAll(styleScript('discord-lite-theme', this.themeCss(s.theme)));
    if (!s.unreadBadge) { this.badge = { mentions: 0, unread: false }; this.onBadge(0, false, false); }
    this.evalAll(`window.__dlApplySettings && window.__dlApplySettings(${JSON.stringify(s)});`);
    return null;
  }

  reloadTheme() {
    this.bundleCache = null;
    this.evalAll(styleScript('discord-lite-theme', this.themeCss(this.settings.theme)));
  }

  mlLog(entry, ids) {
    if (!entry || typeof entry !== 'object') return null;
    fs.mkdirSync(this.logDir, { recursive: true });
    const date = String(entry.date || 'unknown-date').replace(/[^0-9-]/g, '').slice(0, 10) || 'unknown-date';
    fs.appendFileSync(path.join(this.logDir, `${date}.txt`), String(entry.text || '') + '\n\n');
    fs.appendFileSync(path.join(this.logDir, `${date}.jsonl`), JSON.stringify(entry) + '\n');
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = sanitize(raw, 32);
      const cached = this.findCached(id);
      if (cached) this.keepFile(cached); else this.keepIds.add(id);
    }
    return null;
  }

  async cacheAttachment(rawId, url, rawName) {
    if (!allowedCdnUrl(url)) return;
    const id = sanitize(rawId, 32), name = sanitize(rawName, 80);
    const file = path.join(this.cacheDir, `${id}__${name}`);
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      if (fs.existsSync(file)) return;
      const r = await this.session().fetch(url);
      if (!r.ok) return;
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_FILE_BYTES) return;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) return;
      fs.writeFileSync(file, buf);
      if (this.keepIds.delete(id)) this.keepFile(file);
      if (this.downloads++ % 25 === 0) this.pruneCache();
    } catch {}
  }

  readDay(date) {
    date = String(date || '').replace(/[^0-9-]/g, '').slice(0, 10);
    let text = '';
    try { text = fs.readFileSync(path.join(this.logDir, `${date}.jsonl`), 'utf8'); } catch {}
    const kept = this.keptFiles();
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (Array.isArray(e.attachments)) {
        for (const a of e.attachments) {
          if (!a || typeof a !== 'object') continue;
          const id = a.id != null ? sanitize(String(a.id), 32) : null;
          a.file = (id && kept.get(id)) || null;
          delete a.url; // signed CDN links expire
        }
      }
      out.push(e);
    }
    return out.reverse();
  }
}

module.exports = { DiscordLite, isDiscordHost };
