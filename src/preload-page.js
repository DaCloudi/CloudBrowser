// Runs in every tab, but only gives an API to CloudBrowser's own cloud:// pages.
// Normal websites see nothing. The main process also checks the sender's URL.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ---------- Discord Lite ----------
// In CloudBrowser's Discord (the sidebar app), load Discord Lite before Discord's own code:
// Vencord, the Discord Lite plugins and the theme. The main process only answers for that one
// Discord view, so discord.com in an ordinary tab is left alone.
if (location.hostname === 'discord.com' && window === window.top) {
  let parts = null;
  try { parts = ipcRenderer.sendSync('dl-bundle'); } catch {}
  if (Array.isArray(parts)) {
    contextBridge.exposeInMainWorld('__dlBridge', {
      invoke: (cmd, args) => ipcRenderer.invoke('dl-invoke', String(cmd), args == null ? null : JSON.parse(JSON.stringify(args))),
    });
    // The plugins were written for Discord Lite's Tauri shell; give them the same invoke().
    webFrame.executeJavaScript('window.__TAURI_INTERNALS__ = { invoke: function (c, a) { return window.__dlBridge.invoke(c, a); } };');
    for (const code of parts) webFrame.executeJavaScript(code).catch(e => console.error('[Discord Lite]', e));
  }
}

if (location.protocol === 'cloud:') {
  contextBridge.exposeInMainWorld('cloud', {
    call: (channel, ...args) => ipcRenderer.invoke('page:' + channel, ...args),
    on: (channel, cb) => ipcRenderer.on('page:' + channel, (_e, data) => cb(data)),
  });
}

// Google refuses sign-in from browsers it doesn't recognise ("This browser or app may not be
// secure"). On Google's sign-in pages only, fill in the few things real Google Chrome has that
// CloudBrowser's engine doesn't: the "Google Chrome" brand, chrome.app / csi / loadTimes, Web
// Share, and an undecided (not "denied") notification permission.
if (location.hostname === 'accounts.google.com' || location.hostname === 'accounts.youtube.com') {
  const full = process.versions.chrome;
  const disguise = (full) => {
    const major = full.split('.')[0];
    const native = new WeakSet();
    const nat = (fn, name) => { try { Object.defineProperty(fn, 'name', { value: name }); } catch {} native.add(fn); return fn; };
    const origToString = Function.prototype.toString;
    const toString = function () { return native.has(this) ? `function ${this.name}() { [native code] }` : origToString.call(this); };
    native.add(toString);
    Object.defineProperty(Function.prototype, 'toString', { value: toString, configurable: true, writable: true });

    // Brand hints: the real list plus "Google Chrome", in Chrome's order.
    const uad = navigator.userAgentData;
    if (uad) {
      const proto = Object.getPrototypeOf(uad);
      const realBrands = Object.getOwnPropertyDescriptor(proto, 'brands').get;
      const withChrome = (list, v) => list.some(b => b.brand === 'Google Chrome') ? list : [...list, { brand: 'Google Chrome', version: v }];
      Object.defineProperty(proto, 'brands', { get: nat(function () { return withChrome(realBrands.call(this), major); }, 'get brands'), configurable: true });
      const origHigh = proto.getHighEntropyValues;
      Object.defineProperty(proto, 'getHighEntropyValues', {
        value: nat(function getHighEntropyValues(hints) {
          return origHigh.call(this, hints).then(v => {
            const r = { ...v };
            if (r.brands) r.brands = withChrome(r.brands, major);
            if (r.fullVersionList) r.fullVersionList = withChrome(r.fullVersionList, full);
            return r;
          });
        }, 'getHighEntropyValues'), configurable: true, writable: true,
      });
    }

    // window.chrome as in Google Chrome
    const chrome = window.chrome || {};
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: nat(function getDetails() { return null; }, 'getDetails'),
        getIsInstalled: nat(function getIsInstalled() { return false; }, 'getIsInstalled'),
        installState: nat(function installState(cb) { if (typeof cb === 'function') setTimeout(() => cb('not_installed'), 0); }, 'installState'),
        runningState: nat(function runningState() { return 'cannot_run'; }, 'runningState'),
      };
    }
    if (!chrome.csi) {
      chrome.csi = nat(function csi() {
        return { onloadT: Math.round(performance.timeOrigin + (performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart || performance.now())),
          startE: Math.round(performance.timeOrigin), pageT: performance.now(), tran: 15 };
      }, 'csi');
    }
    if (!chrome.loadTimes) {
      chrome.loadTimes = nat(function loadTimes() {
        const t = performance.timing, nav = performance.getEntriesByType('navigation')[0] || {};
        const s = (ms) => ms / 1000;
        return {
          requestTime: s(t.navigationStart), startLoadTime: s(t.navigationStart), commitLoadTime: s(t.responseStart),
          finishDocumentLoadTime: s(t.domContentLoadedEventEnd), finishLoadTime: s(t.loadEventEnd),
          firstPaintTime: s(t.navigationStart + (performance.getEntriesByName('first-paint')[0] || { startTime: 0 }).startTime),
          firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: nav.nextHopProtocol === 'h2' || nav.nextHopProtocol === 'h3',
          wasNpnNegotiated: true, npnNegotiatedProtocol: nav.nextHopProtocol || 'h2', wasAlternateProtocolAvailable: false, connectionInfo: nav.nextHopProtocol || 'h2',
        };
      }, 'loadTimes');
    }
    for (const name of ['addTrustedSyncEncryptionRecoveryMethod', 'setClientEncryptionKeys', 'setSyncEncryptionKeys']) {
      if (!chrome[name]) chrome[name] = nat(function () {}, name);
    }
    window.chrome = chrome;

    // Web Share exists in Chrome on Windows.
    if (!navigator.share) {
      Object.defineProperty(Navigator.prototype, 'share', { value: nat(function share() { return Promise.reject(new DOMException('Share canceled', 'AbortError')); }, 'share'), configurable: true, writable: true });
      Object.defineProperty(Navigator.prototype, 'canShare', { value: nat(function canShare(d) { return !!(d && (d.url || d.text || d.title)); }, 'canShare'), configurable: true, writable: true });
    }

    // A site that hasn't asked yet sees "not decided", like in Chrome.
    try {
      if (window.Notification && Notification.permission === 'denied') {
        Object.defineProperty(Notification, 'permission', { get: nat(function () { return 'default'; }, 'get permission'), configurable: true });
      }
      const pq = Permissions.prototype.query;
      Object.defineProperty(Permissions.prototype, 'query', {
        value: nat(function query(desc) {
          return pq.call(this, desc).then(st => (desc && desc.name === 'notifications' && st.state === 'denied')
            ? Object.create(st, { state: { get: () => 'prompt' } }) : st);
        }, 'query'), configurable: true, writable: true,
      });
    } catch {}

    // Languages: include the plain language as well as the regional one ("en-US", "en").
    try {
      const langs = [...navigator.languages];
      for (const l of [...langs]) { const b = l.split('-')[0]; if (!langs.includes(b)) langs.splice(langs.indexOf(l) + 1, 0, b); }
      Object.defineProperty(Navigator.prototype, 'languages', { get: nat(function () { return langs.slice(); }, 'get languages'), configurable: true });
    } catch {}
  };
  try {
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: disguise, args: [full] });
    else require('electron').webFrame.executeJavaScript(`(${disguise.toString()})(${JSON.stringify(full)})`);
  } catch (e) { console.error('sign-in compatibility failed', e); }
}

// ---------- Better YouTube: SponsorBlock skipping, no Shorts ----------
// Runs in this preload's isolated world, so YouTube's own scripts can't see or break it.
if (/^(www\.|m\.)?youtube\.com$/.test(location.hostname)) {
  let cfg = null;
  try { cfg = ipcRenderer.sendSync('yt-settings'); } catch {}
  if (cfg) youtubeExtras(cfg);
  if (cfg && cfg.lite && cfg.lite.enabled) youtubeLite(cfg.lite);
}
if (/(^|\.)roblox\.com$/.test(location.hostname) && window === window.top) {
  let cfg = null;
  try { cfg = ipcRenderer.sendSync('rbx-settings'); } catch {}
  if (cfg && cfg.enabled) robloxLite(cfg);
}

// A <style> element we own, kept up to date (works before <head> exists).
function liteStyle(id, css) {
  const put = () => {
    let el = document.getElementById(id);
    if (!css) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('style'); el.id = id; (document.head || document.documentElement).append(el); }
    if (el.textContent !== css) el.textContent = css;
  };
  if (document.documentElement) put(); else document.addEventListener('DOMContentLoaded', put, { once: true });
}

// ---------- YouTube Lite ----------
function youtubeLite(initial) {
  let lite = initial;
  const NAVY = `
    html[dark], [dark] {
      --yt-spec-base-background: #07101b; --yt-spec-raised-background: #0c1624; --yt-spec-menu-background: #0c1624;
      --yt-spec-general-background-a: #07101b; --yt-spec-general-background-b: #07101b; --yt-spec-general-background-c: #0c1624;
      --yt-spec-brand-background-solid: #07101b; --yt-spec-brand-background-primary: rgba(7, 16, 27, .96); --yt-spec-brand-background-secondary: rgba(12, 22, 36, .96);
      --yt-spec-badge-chip-background: #152233; --yt-spec-additive-background: rgba(255, 255, 255, .07); --yt-spec-10-percent-layer: #19212b;
      --yt-spec-outline: #19212b; --yt-spec-call-to-action: #4d8dff; --yt-spec-themed-blue: #4d8dff; --yt-spec-suggested-action: rgba(77, 141, 255, .18);
    }
    html[dark] body, html[dark] ytd-app, html[dark] #masthead-container #background { background: #07101b !important; }
    html[dark] .cloud-dislikes { color: #9aa7b6; }`;
  const css = () => [
    lite.navyTheme ? NAVY : '',
    lite.hideComments ? 'ytd-comments#comments, ytd-comments { display: none !important; }' : '',
    lite.hideRelated ? 'ytd-watch-flexy #secondary #related, ytd-watch-next-secondary-results-renderer { display: none !important; }' : '',
    lite.hideHomeFeed ? 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer { display: none !important; } ytd-browse[page-subtype="home"]::after { content: "Home feed hidden by YouTube Lite. Search for what you want to watch."; display: block; padding: 80px 24px; text-align: center; color: #9aa7b6; font: 500 16px Roboto, Arial, sans-serif; }' : '',
    lite.hideEndCards ? '.ytp-ce-element, .ytp-ce-covering-overlay, .ytp-endscreen-content, .ytp-ce-element-show { display: none !important; }' : '',
    '.cloud-dislikes { margin-left: 6px; font-weight: 500; white-space: nowrap; }',
  ].join('\n');
  liteStyle('cloud-yt-lite', css());

  // Best quality and remembered speed use YouTube's own player controls, which live in the page itself.
  const MAIN = `(() => {
    if (window.__cloudYtLiteOn) return; window.__cloudYtLiteOn = true;
    const ORDER = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
    const CAP = { max: 'highres', 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720' };
    let lastVid = null, done = false, tries = 0;
    setInterval(() => {
      const c = window.__cloudYtLite || {};
      const p = document.getElementById('movie_player');
      if (!p || typeof p.getAvailableQualityLevels !== 'function' || typeof p.getVideoData !== 'function') return;
      const vid = (p.getVideoData() || {}).video_id || null;
      if (vid !== lastVid) { lastVid = vid; done = false; tries = 0; }
      if (done || !vid || ++tries > 60) return;
      if (p.classList.contains('ad-showing')) { tries--; return; }
      const levels = (p.getAvailableQualityLevels() || []).filter(l => l !== 'auto');
      if (!levels.length) return;
      if (c.quality && c.quality !== 'auto') {
        const cap = ORDER.indexOf(CAP[c.quality] || 'highres');
        const pick = levels.find(l => ORDER.indexOf(l) >= cap);
        if (pick) { try { p.setPlaybackQualityRange(pick, pick); } catch (e) {} }
      }
      if (c.rememberSpeed && p.setPlaybackRate) {
        const r = Number(localStorage.getItem('cloudbrowser-speed') || 1);
        if (r > 0 && r !== 1) p.setPlaybackRate(r);
      }
      done = true;
    }, 500);
    document.addEventListener('ratechange', e => {
      const c = window.__cloudYtLite || {};
      if (!c.rememberSpeed || !(e.target instanceof HTMLVideoElement) || !done) return;
      if (document.querySelector('.html5-video-player.ad-showing')) return;
      try { localStorage.setItem('cloudbrowser-speed', String(e.target.playbackRate)); } catch (err) {}
    }, true);
  })();`;
  const pushToPage = () => webFrame.executeJavaScript(`window.__cloudYtLite = ${JSON.stringify({ quality: lite.quality, rememberSpeed: lite.rememberSpeed })};`).catch(() => {});
  pushToPage();
  webFrame.executeJavaScript(MAIN).catch(() => {});

  // Dislike counts, next to the dislike button.
  const videoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const fmt = n => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  let shownFor = null, votes = null, fetching = null;
  const dislikeButton = () => document.querySelector('#top-level-buttons-computed dislike-button-view-model button, ytd-watch-metadata dislike-button-view-model button, #segmented-dislike-button button, ytd-watch-metadata like-button-view-model + dislike-button-view-model button');
  const showDislikes = async () => {
    const id = videoId();
    const old = document.querySelectorAll('.cloud-dislikes');
    if (!lite.dislikes || !id) { old.forEach(x => x.remove()); shownFor = null; return; }
    if (shownFor !== id) {
      votes = null;
      if (fetching !== id) {
        fetching = id;
        const v = await ipcRenderer.invoke('yt-dislikes', id).catch(() => null);
        if (videoId() !== id) return;
        votes = v; shownFor = id;
      } else return;
    }
    if (!votes) return;
    const btn = dislikeButton();
    if (!btn) return;
    let span = btn.querySelector('.cloud-dislikes');
    if (!span) { old.forEach(x => x.remove()); span = document.createElement('span'); span.className = 'cloud-dislikes'; btn.append(span); }
    const text = fmt(votes.dislikes);
    if (span.textContent !== text) span.textContent = text;
    btn.title = `${votes.dislikes.toLocaleString()} dislikes (estimated by Return YouTube Dislike)`;
  };

  // Ads that slip past the blocker: skip them.
  const skipAds = () => {
    if (!lite.skipAds) return;
    const player = document.querySelector('.html5-video-player.ad-showing');
    if (!player) return;
    const v = player.querySelector('video');
    if (v && Number.isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.2) { v.muted = true; v.currentTime = v.duration - 0.1; }
    const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"]');
    if (skip) skip.click();
  };

  setInterval(() => { skipAds(); if (videoId()) showDislikes(); }, 700);
  document.addEventListener('yt-navigate-finish', () => { shownFor = null; fetching = null; showDislikes(); });

  // Changes from the Lite menu apply straight away.
  ipcRenderer.on('lite-settings', (_e, app, next) => {
    if (app !== 'ytLite') return;
    lite = next;
    liteStyle('cloud-yt-lite', lite.enabled ? css() : '');
    pushToPage();
    shownFor = null; fetching = null; showDislikes();
  });
}

// ---------- Roblox Lite ----------
function robloxLite(initial) {
  let lite = initial;
  const NAVY = `
    body.dark-theme, html:has(body.dark-theme), .dark-theme #container-main, .dark-theme .container-main, .dark-theme #wrap, .dark-theme .content,
    .dark-theme #content, .dark-theme main { background-color: #07101b !important; }
    .dark-theme #header, .dark-theme .rbx-header, .dark-theme #navigation, .dark-theme .rbx-left-col, .dark-theme .left-col-list { background-color: #0c1624 !important; }
    .dark-theme .section-content, .dark-theme .game-card-container, .dark-theme .border-bottom, .dark-theme .rbx-tabs-horizontal .rbx-tab { border-color: #19212b !important; }
    .dark-theme .section-content, .dark-theme .modal-content, .dark-theme .popover, .dark-theme .dropdown-menu { background-color: #0c1624 !important; }
    .dark-theme .input-field, .dark-theme input.form-control, .dark-theme .form-control { background-color: #121e2d !important; border-color: #323b48 !important; }`;
  const PANEL = `
    #cloud-rbx-btn { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; display: flex; gap: 8px; align-items: center; padding: 10px 16px;
      border: 0; border-radius: 22px; background: #fff; color: #07101b; font: 700 14px "Builder Sans", system-ui, sans-serif; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,.35); }
    #cloud-rbx-btn:hover { background: #e6e9ee; }
    #cloud-rbx { position: fixed; right: 18px; bottom: 72px; z-index: 2147483000; width: 440px; max-height: min(70vh, 620px); display: flex; flex-direction: column;
      background: #0c1624; color: #fff; border: 1px solid #19212b; border-radius: 14px; box-shadow: 0 16px 50px rgba(0,0,0,.5); font: 14px "Builder Sans", system-ui, sans-serif; overflow: hidden; }
    #cloud-rbx[hidden] { display: none; }
    #cloud-rbx .hd { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; }
    #cloud-rbx .hd b { flex: 1; font-size: 15px; }
    #cloud-rbx .muted { color: #9aa7b6; font-size: 12px; }
    #cloud-rbx .acts { display: flex; gap: 8px; padding: 0 16px 10px; }
    #cloud-rbx button.big { flex: 1; border: 0; border-radius: 9px; padding: 9px 10px; font-weight: 700; font-size: 13px; font-family: inherit; cursor: pointer; background: #152233; color: #fff; }
    #cloud-rbx button.big.primary { background: #fff; color: #07101b; }
    #cloud-rbx .sort { display: flex; gap: 4px; padding: 0 16px 8px; }
    #cloud-rbx .sort button { border: 0; background: transparent; color: #9aa7b6; padding: 4px 9px; border-radius: 7px; font-weight: 600; font-size: 12px; font-family: inherit; cursor: pointer; }
    #cloud-rbx .sort button.on { background: #152233; color: #fff; }
    #cloud-rbx .list { overflow-y: auto; padding: 0 8px 10px; }
    #cloud-rbx .srv { display: grid; grid-template-columns: 1fr 64px 52px auto; gap: 10px; align-items: center; padding: 8px; border-radius: 9px; }
    #cloud-rbx .srv:hover { background: #141c27; }
    #cloud-rbx .bar { height: 6px; border-radius: 3px; background: #19212b; overflow: hidden; margin-top: 5px; }
    #cloud-rbx .bar i { display: block; height: 100%; background: #3ba55d; }
    #cloud-rbx .srv .ping.bad { color: #f0b232; } #cloud-rbx .srv .ping.worse { color: #f0565b; }
    #cloud-rbx .srv button { border: 0; border-radius: 8px; padding: 6px 12px; background: #4d8dff; color: #fff; font-weight: 700; font-size: 12px; font-family: inherit; cursor: pointer; }
    #cloud-rbx .srv button.link { background: transparent; color: #9aa7b6; padding: 6px 6px; }
    #cloud-rbx .empty { padding: 24px; text-align: center; color: #9aa7b6; }`;
  const css = () => (lite.navyTheme ? NAVY : '') + (lite.serverBrowser ? PANEL : '');
  liteStyle('cloud-rbx-lite', css());

  const placeId = () => { const m = /^\/games\/(\d+)/.exec(location.pathname); return m ? m[1] : null; };
  let servers = [], sortBy = 'ping', loadedFor = null, loading = false;
  const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props || {}); e.append(...kids.filter(k => k != null)); return e; };
  const join = (id) => ipcRenderer.send('rbx-join', placeId(), id || null);
  const pingClass = p => (p > 160 ? 'worse' : p > 90 ? 'bad' : '');
  const best = () => servers.filter(s => s.playing < s.maxPlayers).sort((a, b) => (a.ping || 999) - (b.ping || 999) || b.playing - a.playing)[0];
  const smallest = () => servers.filter(s => s.playing < s.maxPlayers).sort((a, b) => a.playing - b.playing || (a.ping || 999) - (b.ping || 999))[0];

  const render = () => {
    const panel = document.getElementById('cloud-rbx');
    if (!panel) return;
    const list = panel.querySelector('.list');
    const sorted = [...servers].sort(sortBy === 'ping' ? (a, b) => (a.ping || 999) - (b.ping || 999) : sortBy === 'full' ? (a, b) => b.playing - a.playing : (a, b) => a.playing - b.playing);
    panel.querySelector('.muted').textContent = loading ? 'Finding servers…' : `${servers.length} server${servers.length === 1 ? '' : 's'} with space`;
    list.replaceChildren(...(sorted.length ? sorted.slice(0, 120).map(s => el('div', { className: 'srv' },
      el('div', {}, el('div', { textContent: `${s.playing} / ${s.maxPlayers} players` }), el('div', { className: 'bar' }, el('i', { style: `width:${Math.round(s.playing / s.maxPlayers * 100)}%` }))),
      el('div', { className: 'ping ' + pingClass(s.ping), textContent: s.ping ? `${s.ping} ms` : '–', title: 'Average ping of the players in this server' }),
      el('div', { className: 'muted', textContent: s.fps ? `${Math.round(s.fps)} fps` : '', title: 'Server frame rate' }),
      el('div', {},
        el('button', { className: 'link', textContent: 'Link', title: 'Copy a link that joins this exact server', onclick: () => {
          navigator.clipboard.writeText(`https://www.roblox.com/games/start?placeId=${placeId()}&gameInstanceId=${s.id}`).then(() => ipcRenderer.send('rbx-toast', 'Server link copied')).catch(() => {});
        } }),
        el('button', { textContent: 'Join', onclick: () => join(s.id) })),
    )) : [el('div', { className: 'empty', textContent: loading ? 'Finding servers…' : 'No public servers with space right now.' })]));
  };
  const load = async () => {
    const id = placeId();
    if (!id || loading) return;
    loading = true; render();
    try { servers = await ipcRenderer.invoke('rbx-servers', id); } catch { servers = []; }
    loadedFor = id; loading = false; render();
  };
  const build = () => {
    const id = placeId();
    const btn = document.getElementById('cloud-rbx-btn'), panel = document.getElementById('cloud-rbx');
    if (!id || !lite.serverBrowser) { if (btn) btn.remove(); if (panel) panel.remove(); return; }
    if (btn) { if (loadedFor && loadedFor !== id) { servers = []; loadedFor = null; panel.hidden = true; } return; }
    if (!document.body) return;
    const p = el('div', { id: 'cloud-rbx', hidden: true },
      el('div', { className: 'hd' }, el('b', { textContent: 'Servers' }), el('span', { className: 'muted' }), el('button', { className: 'big', style: 'flex:none;padding:6px 10px', textContent: '↻', title: 'Refresh', onclick: () => load() })),
      el('div', { className: 'acts' },
        el('button', { className: 'big primary', textContent: 'Join best server', title: 'Lowest ping, with space', onclick: () => { const s = best(); if (s) join(s.id); else join(null); } }),
        el('button', { className: 'big', textContent: 'Join smallest server', onclick: () => { const s = smallest(); if (s) join(s.id); else join(null); } })),
      el('div', { className: 'sort' }, ...[['ping', 'Lowest ping'], ['small', 'Fewest players'], ['full', 'Most players']].map(([k, l]) =>
        el('button', { className: k === sortBy ? 'on' : '', textContent: l, onclick: (e) => { sortBy = k; e.target.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target)); render(); } }))),
      el('div', { className: 'list' }));
    const b = el('button', { id: 'cloud-rbx-btn', textContent: 'Servers', title: 'Roblox Lite: pick a server' });
    b.onclick = () => { p.hidden = !p.hidden; if (!p.hidden && loadedFor !== placeId()) load(); };
    document.body.append(p, b);
  };
  setInterval(build, 1000);
  document.addEventListener('DOMContentLoaded', build);
  ipcRenderer.on('lite-settings', (_e, app, next) => {
    if (app !== 'robloxLite') return;
    lite = next;
    liteStyle('cloud-rbx-lite', lite.enabled ? css() : '');
    if (!lite.enabled) lite = { ...lite, serverBrowser: false };
    build();
  });
}

function youtubeExtras(cfg) {
  const LABEL = { sponsor: 'sponsor', selfpromo: 'self-promotion', interaction: '“like and subscribe” reminder', intro: 'intro', outro: 'end cards', preview: 'preview', music_offtopic: 'non-music part', filler: 'filler' };

  // Shorts: hidden from feeds, and opened as normal videos (with a seek bar).
  const shortsToWatch = () => {
    const m = /^\/shorts\/([\w-]{6,})/.exec(location.pathname);
    if (m) location.replace('/watch?v=' + m[1]);
  };
  if (cfg.hideShorts) {
    shortsToWatch();
    const css = `
      ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
      ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model), grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
      ytd-guide-entry-renderer:has(a[title="Shorts"]), ytd-mini-guide-entry-renderer[aria-label="Shorts"],
      ytd-video-renderer:has(a[href^="/shorts/"]), ytd-grid-video-renderer:has(a[href^="/shorts/"]),
      ytd-rich-item-renderer:has(a[href^="/shorts/"]), ytd-compact-video-renderer:has(a[href^="/shorts/"]),
      yt-tab-shape[tab-title="Shorts"], ytm-shorts-lockup-view-model, ytm-reel-shelf-renderer { display: none !important; }`;
    const add = () => {
      if (document.getElementById('cloud-no-shorts')) return;
      const st = document.createElement('style');
      st.id = 'cloud-no-shorts';
      st.textContent = css;
      (document.head || document.documentElement).append(st);
    };
    if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
  }

  // SponsorBlock: segments come from the main process, which asks the community database using
  // only the first 4 characters of a hash of the video id, so it never learns what you watch.
  let segments = [];
  let forVideo = null;
  let skipped = new Set();
  let toastTimer = 0;
  const videoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);

  const toast = (text) => {
    let el = document.getElementById('cloud-sb-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cloud-sb-toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;padding:9px 16px;border-radius:8px;'
        + 'background:#0c1624;color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);pointer-events:none;transition:opacity .3s';
      document.documentElement.append(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
  };

  const load = async () => {
    if (cfg.hideShorts) shortsToWatch();
    const id = videoId();
    if (id === forVideo) return;
    forVideo = id; segments = []; skipped = new Set();
    if (!id || !cfg.sponsorBlock) return;
    try {
      const segs = await ipcRenderer.invoke('yt-segments', id, cfg.categories);
      if (forVideo === id) segments = segs || [];
    } catch {}
  };

  const onTime = (e) => {
    const v = e.target;
    if (!segments.length || !(v instanceof HTMLVideoElement) || videoId() !== forVideo) return;
    // Ads play in the same <video>; YouTube marks the player while one is showing.
    if (document.querySelector('.html5-video-player.ad-showing')) return;
    const t = v.currentTime;
    for (const s of segments) {
      if (t >= s.start && t < s.end - 0.4 && !skipped.has(s.uuid)) {
        skipped.add(s.uuid);
        v.currentTime = Math.min(s.end, v.duration || s.end);
        toast(`Skipped ${LABEL[s.category] || s.category}`);
        break;
      }
    }
  };

  document.addEventListener('timeupdate', onTime, true);
  document.addEventListener('yt-navigate-finish', load);
  window.addEventListener('popstate', load);
  setInterval(load, 1500); // backstop for navigations YouTube doesn't announce
  load();
}
