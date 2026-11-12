// Runs in every tab, but only gives an API to CloudBrowser's own cloud:// pages.
// Normal websites see nothing. The main process also checks the sender's URL.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'cloud:') {
  contextBridge.exposeInMainWorld('cloud', {
    call: (channel, ...args) => ipcRenderer.invoke('page:' + channel, ...args),
    on: (channel, cb) => ipcRenderer.on('page:' + channel, (_e, data) => cb(data)),
  });
}

// Google refuses sign-in from browsers it doesn't recognise. On Google's sign-in pages, the page
// sees the same "brand" hints as Google Chrome (matching the headers set in main.js).
if (location.hostname === 'accounts.google.com' || location.hostname === 'accounts.youtube.com') {
  const full = process.versions.chrome;
  const disguise = (full) => {
    const major = full.split('.')[0];
    const brands = [{ brand: 'Google Chrome', version: major }, { brand: 'Chromium', version: major }, { brand: 'Not_A Brand', version: '24' }];
    const fullVersionList = [{ brand: 'Google Chrome', version: full }, { brand: 'Chromium', version: full }, { brand: 'Not_A Brand', version: '24.0.0.0' }];
    const real = navigator.userAgentData;
    if (!real) return;
    const proto = Object.getPrototypeOf(real);
    try {
      Object.defineProperty(proto, 'brands', { get: () => brands.map(b => ({ ...b })), configurable: true });
      const origHigh = proto.getHighEntropyValues;
      Object.defineProperty(proto, 'getHighEntropyValues', {
        value: function (hints) {
          return origHigh.call(this, hints).then(v => ({ ...v, brands: brands.map(b => ({ ...b })), fullVersionList: fullVersionList.map(b => ({ ...b })), uaFullVersion: full }));
        }, configurable: true, writable: true,
      });
      Object.defineProperty(proto, 'toJSON', { value: function () { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; }, configurable: true, writable: true });
    } catch {}
  };
  try {
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: disguise, args: [full] });
    else require('electron').webFrame.executeJavaScript(`(${disguise.toString()})(${JSON.stringify(full)})`);
  } catch (e) { console.error('sign-in compatibility failed', e); }
}
