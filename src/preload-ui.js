// API for the browser UI (tab strip + toolbar). Web pages never get this.
const { contextBridge, ipcRenderer } = require('electron');

const send = (channel, ...args) => ipcRenderer.send('ui:' + channel, ...args);
const on = (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('cloud', {
  newTab: () => send('new-tab'),
  closeTab: id => send('close-tab', id),
  switchTab: id => send('switch-tab', id),
  tabMenu: id => send('tab-menu', id),
  toggleMute: id => send('toggle-mute', id),
  navigate: (text, newTab) => send('navigate', text, !!newTab),
  search: (text, newTab) => send('search', text, !!newTab),
  back: () => send('back'),
  forward: () => send('forward'),
  reload: () => send('reload'),
  stop: () => send('stop'),
  home: () => send('home'),
  togglePrivate: () => send('toggle-private'),
  installUpdate: () => send('install-update'),
  menu: () => send('menu'),
  toggleBookmark: () => send('toggle-bookmark'),
  openBookmark: (url, newTab) => send('open-bookmark', url, !!newTab),
  bookmarkMenu: id => send('bookmark-menu', id),
  openInternal: (name, hash) => send('open-internal', name, hash || ''),
  find: (text, opts) => send('find', text, opts || {}),
  findStop: () => send('find-stop'),
  setHeight: h => send('height', h),
  setOverlay: open => send('overlay', !!open),
  focusPage: () => send('focus-page'),
  suggest: q => ipcRenderer.invoke('ui:suggest', q),
  onState: cb => on('state', cb),
  onFocusAddress: cb => on('focus-address', cb),
  onFindOpen: cb => on('find-open', cb),
  onFindNext: cb => on('find-next', cb),
  onFindClose: cb => on('find-close', cb),
  onFindResult: cb => on('find-result', cb),
  onDownloadDone: cb => on('download-done', cb),
});
