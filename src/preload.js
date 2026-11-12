// Exposes a small, safe API to the browser UI. Web pages in tabs never get this.
const { contextBridge, ipcRenderer } = require('electron');

const send = (channel, arg) => ipcRenderer.send(channel, arg);

contextBridge.exposeInMainWorld('cloud', {
  newTab: () => send('new-tab'),
  closeTab: id => send('close-tab', id),
  switchTab: id => send('switch-tab', id),
  navigate: text => send('navigate', text),
  back: () => send('back'),
  forward: () => send('forward'),
  reload: () => send('reload'),
  stop: () => send('stop'),
  home: () => send('home'),
  togglePrivate: () => send('toggle-private'),
  installUpdate: () => send('install-update'),
  menu: () => send('menu'),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusAddress: cb => ipcRenderer.on('focus-address', () => cb()),
});
