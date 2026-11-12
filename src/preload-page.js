// Runs in every tab, but only gives an API to CloudBrowser's own cloud:// pages.
// Normal websites see nothing. The main process also checks the sender's URL.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'cloud:') {
  contextBridge.exposeInMainWorld('cloud', {
    call: (channel, ...args) => ipcRenderer.invoke('page:' + channel, ...args),
    on: (channel, cb) => ipcRenderer.on('page:' + channel, (_e, data) => cb(data)),
  });
}
