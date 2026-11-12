// Runs in every tab, but only gives an API to CloudBrowser's own cloud:// pages.
// Normal websites see nothing. The main process also checks the sender's URL.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'cloud:') {
  contextBridge.exposeInMainWorld('cloud', {
    call: (channel, ...args) => ipcRenderer.invoke('page:' + channel, ...args),
    on: (channel, cb) => ipcRenderer.on('page:' + channel, (_e, data) => cb(data)),
  });
}

// Google refuses sign-in from Electron-based browsers but supports Firefox, so on Google's
// sign-in pages the page sees Firefox (matching the request headers set in main.js).
if (location.hostname === 'accounts.google.com' || location.hostname === 'accounts.youtube.com') {
  const v = 128 + Math.max(0, Math.floor((Date.now() - Date.UTC(2024, 6, 9)) / (28 * 86400000)));
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
  const disguise = (ua) => {
    const nav = Navigator.prototype;
    const def = (k, val) => { try { Object.defineProperty(nav, k, { get: () => val, configurable: true }); } catch {} };
    def('userAgent', ua);
    def('appVersion', '5.0 (Windows)');
    def('vendor', '');
    def('platform', 'Win32');
    def('oscpu', 'Windows NT 10.0; Win64; x64');
    def('buildID', '20181001000000');
    def('userAgentData', undefined);
    try { delete window.chrome; } catch {}
  };
  try {
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: disguise, args: [ua] });
    else require('electron').webFrame.executeJavaScript(`(${disguise.toString()})(${JSON.stringify(ua)})`);
  } catch (e) { console.error('sign-in compatibility failed', e); }
}
