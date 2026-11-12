// Runs in every tab, but only gives an API to CloudBrowser's own cloud:// pages.
// Normal websites see nothing. The main process also checks the sender's URL.
const { contextBridge, ipcRenderer } = require('electron');

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
