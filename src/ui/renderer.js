// CloudBrowser - browser UI (tab strip, toolbar, bookmarks bar, find bar, suggestions)
'use strict';
const $ = id => document.getElementById(id);
const address = $('address');
let state = null;
let editing = false;      // the user is typing in the address bar
let lastActiveId = null;

const ICONS = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.1 5.6.8-4.05 3.95.95 5.6L12 16.6l-5 2.65.95-5.6L3.9 9.7l5.6-.8z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  tab: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 9.5h17"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 5 3 3H7l3-3zM12 12v8"/></svg>',
};

// ---------- toolbar buttons ----------

$('newtab').onclick = () => cloud.newTab();
$('back').onclick = () => cloud.back();
$('forward').onclick = () => cloud.forward();
$('home').onclick = () => cloud.home();
$('incognito').onclick = () => cloud.newIncognito();
$('make-default').onclick = () => cloud.makeDefault();
$('dismiss-default').onclick = () => cloud.dismissDefault();
if (new URLSearchParams(location.search).get('incognito') === '1') document.body.classList.add('incognito');
$('menu').onclick = () => cloud.menu();
$('update').onclick = () => cloud.installUpdate();
$('star').onclick = () => cloud.toggleBookmark();
$('shield').onclick = () => cloud.shieldMenu();
$('reader-btn').onclick = () => cloud.reader();
$('translate-btn').onclick = () => cloud.translateMenu();
cloud.onOpenExtension(id => openExtension(id));
$('zoom-badge').onclick = () => cloud.resetZoom();
address.addEventListener('contextmenu', e => { e.preventDefault(); cloud.addressMenu(address.selectionStart !== address.selectionEnd); });
cloud.onBlurAddress(() => { if (!editing) return; editing = false; address.blur(); render(); });
$('downloads').onclick = () => cloud.openInternal('downloads');
$('reload').onclick = () => { const t = activeTab(); t && t.loading ? cloud.stop() : cloud.reload(); };
for (const id of ['back', 'forward']) {
  $(id).addEventListener('auxclick', e => { if (e.button === 1) cloud[id](); });
}

$('vertical-toggle').onclick = () => cloud.toggleVertical();
$('side-newtab').onclick = () => cloud.newTab();
$('side-collapse').onclick = () => cloud.toggleSidebar();

// Tell the main process where pages go: right of the vertical tab bar, below the toolbar.
function reportPageRect() {
  const top = Math.round($('chrome').getBoundingClientRect().height);
  const side = $('sidebar');
  side.style.top = top + 'px';
  const x = document.body.classList.contains('vertical') ? Math.round(side.getBoundingClientRect().width) : 0;
  const railEl = $('apprail');
  railEl.style.top = top + 'px';
  const rail = document.body.classList.contains('has-rail') ? Math.round(railEl.getBoundingClientRect().width) : 0;
  cloud.setPageRect({ x, y: top, rail });
}
new ResizeObserver(reportPageRect).observe($('chrome'));
new ResizeObserver(reportPageRect).observe($('sidebar'));

// "Add to CloudBrowser" bar on Chrome Web Store pages
let storeBusy = false;
$('store-btn').onclick = () => {
  const x = state && state.storeExtension;
  if (!x || storeBusy) return;
  x.installed ? cloud.storeRemove(x.id) : cloud.storeInstall(x.id);
};
cloud.onStoreBusy(b => { storeBusy = b; render(); });
function renderStoreBar() {
  const x = state.storeExtension;
  $('storebar').hidden = !x;
  if (!x) return;
  $('store-text').textContent = x.installed ? `${x.name} is added to CloudBrowser.` : `Add ${x.name} to CloudBrowser?`;
  $('store-btn').textContent = storeBusy ? 'Adding…' : x.installed ? 'Remove' : 'Add to CloudBrowser';
  $('store-btn').classList.toggle('primary', !x.installed);
  $('store-btn').disabled = storeBusy;
}

// ---------- extensions "folder" ----------
// The toolbar only shows pinned extensions; everything is in the puzzle-piece panel.
// Opening an unpinned extension shows its button in the toolbar while its popup is open.
let tempShown = null;

function actionElements() {
  if (!actionList || !actionList.shadowRoot) return [];
  return [...actionList.shadowRoot.querySelectorAll('*')].filter(e => (e.getAttribute('part') || '').split(/\s+/).includes('action'));
}
function actionExtensionId(el) {
  for (const a of el.attributes) { const m = /[a-p]{32}/.exec(a.value); if (m) return m[0]; }
  for (const v of Object.values(el.dataset || {})) { const m = /[a-p]{32}/.exec(v); if (m) return m[0]; }
  const bg = getComputedStyle(el).backgroundImage || '';
  const m = /[a-p]{32}/.exec(bg) || /[a-p]{32}/.exec(el.innerHTML || '');
  return m ? m[0] : null;
}
function filterActions() {
  const pinned = new Set((state && state.pinnedExtensions) || []);
  for (const el of actionElements()) {
    const id = actionExtensionId(el);
    el.style.display = (id && (pinned.has(id) || id === tempShown)) ? '' : 'none';
  }
}
let actionObserver = null;
function watchActions() {
  if (actionObserver || !actionList || !actionList.shadowRoot) return;
  actionObserver = new MutationObserver(() => filterActions());
  actionObserver.observe(actionList.shadowRoot, { childList: true, subtree: true });
  filterActions();
}
window.addEventListener('focus', () => { if (tempShown) { tempShown = null; filterActions(); } });

async function openExtPanel() {
  const r = $('ext-btn').getBoundingClientRect();
  const panel = $('ext-panel');
  panel.style.top = (r.bottom + 8) + 'px';
  panel.style.left = Math.max(8, Math.min(window.innerWidth - 328, r.right - 320)) + 'px';
  const list = await cloud.extensionList();
  $('ep-empty').hidden = list.length > 0;
  $('ep-list').replaceChildren(...list.map(x => {
    const row = document.createElement('div');
    row.className = 'ep-row';
    row.title = `Open ${x.name}`;
    let icon;
    if (x.icon) { icon = document.createElement('img'); icon.src = x.icon; } else { icon = document.createElement('span'); icon.className = 'ep-ph'; }
    const name = document.createElement('span');
    name.className = 'ep-name';
    name.textContent = x.name;
    const pin = document.createElement('button');
    pin.className = x.pinned ? 'on' : '';
    pin.title = x.pinned ? 'Unpin from toolbar' : 'Pin to toolbar';
    pin.innerHTML = ICONS.pin;
    pin.onclick = e => { e.stopPropagation(); cloud.pinExtension(x.id); x.pinned = !x.pinned; pin.className = x.pinned ? 'on' : ''; pin.title = x.pinned ? 'Unpin from toolbar' : 'Pin to toolbar'; };
    row.onclick = () => openExtension(x.id);
    row.append(icon, name, pin);
    return row;
  }));
  panel.hidden = false;
  $('ext-btn').classList.add('open');
  document.body.classList.add('panel');
  cloud.setOverlay(true);
}
function closeExtPanel() {
  if ($('ext-panel').hidden) return;
  $('ext-panel').hidden = true;
  $('ext-btn').classList.remove('open');
  document.body.classList.remove('panel');
  cloud.setOverlay(false);
}
function openExtension(id) {
  closeExtPanel();
  tempShown = id;
  filterActions();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = actionElements().find(e => actionExtensionId(e) === id);
    if (el) el.click(); else cloud.manageExtensions();
  }));
}
$('ext-btn').onclick = () => ($('ext-panel').hidden ? openExtPanel() : closeExtPanel());
$('ep-manage').onclick = () => { closeExtPanel(); cloud.manageExtensions(); };
$('ep-store').onclick = () => { closeExtPanel(); cloud.openWebStore(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeExtPanel(); });

// Chrome extension buttons
let actionList = null;
function renderActions() {
  if (!state.extensions) { if (actionList) { actionList.remove(); actionList = null; } return; }
  if (!actionList && customElements.get('browser-action-list')) {
    actionList = document.createElement('browser-action-list');
    actionList.setAttribute('partition', 'persist:cloudbrowser');
    actionList.setAttribute('alignment', 'bottom left');
    $('actions-slot').append(actionList);
  }
  watchActions();
  filterActions();
  if (actionList && state.activeWcId && actionList.getAttribute('tab') !== String(state.activeWcId)) {
    actionList.setAttribute('tab', String(state.activeWcId));
  }
}

// ---------- address bar + suggestions ----------

let rows = [];
let sel = 0;
let typed = '';

function looksLikeUrl(s) {
  s = s.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s) ||
    (!/\s/.test(s) && /^[^\s/]+\.[a-z][a-z0-9-]{1,}(:\d+)?([/?#].*)?$/i.test(s));
}

function openOverlay() {
  if (document.body.classList.contains('overlay')) return;
  const r = $('addressbox').getBoundingClientRect();
  const box = $('suggestions');
  box.style.left = (r.left - 4) + 'px';
  box.style.top = (r.bottom + 6) + 'px';
  box.style.width = (r.width + 8) + 'px';
  document.body.classList.add('overlay');
  cloud.setOverlay(true);
}
function closeOverlay() {
  if (!document.body.classList.contains('overlay')) return;
  document.body.classList.remove('overlay');
  cloud.setOverlay(false);
  rows = [];
}

function highlight(text, q) {
  const span = document.createElement('span');
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) { span.textContent = text; return span; }
  const b = document.createElement('b');
  b.textContent = text.slice(i, i + q.length);
  span.append(text.slice(0, i), b, text.slice(i + q.length));
  return span;
}

function renderSuggestions() {
  const box = $('suggestions');
  box.replaceChildren(...rows.map((r, i) => {
    const el = document.createElement('div');
    el.className = 'sg' + (i === sel ? ' sel' : '');
    el.insertAdjacentHTML('afterbegin', ICONS[r.icon]);
    const t = document.createElement('span');
    t.className = 't';
    t.append(highlight(r.title, typed));
    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = r.sub || '';
    el.append(t, u);
    el.onmousedown = e => {
      e.preventDefault();
      go(r, e.button === 1 || e.ctrlKey);
    };
    el.onmousemove = () => { if (sel !== i) { sel = i; renderSuggestions(); } };
    return el;
  }));
}

async function updateSuggestions() {
  const q = address.value;
  typed = q.trim();
  if (!typed) { closeOverlay(); return; }
  const items = await cloud.suggest(q);
  if (address.value !== q || document.activeElement !== address) return;
  const engine = state ? state.engineName : 'DuckDuckGo';
  rows = [];
  if (looksLikeUrl(typed)) rows.push({ icon: 'globe', title: typed, sub: '', text: typed });
  rows.push({ icon: 'search', title: typed, sub: `${engine} search`, text: typed, search: true });
  for (const it of items) {
    if (it.type === 'tab') { rows.push({ icon: 'tab', title: it.title || it.url, sub: 'Switch to this tab', url: it.url, tabId: it.tabId }); continue; }
    rows.push({ icon: it.type === 'bookmark' ? 'star' : 'clock', title: it.title || it.url, sub: it.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''), url: it.url });
  }
  sel = 0;
  openOverlay();
  renderSuggestions();
  cloud.preconnect(rows[0].url || rows[0].text);
}

function go(row, newTab) {
  const target = row ? (row.url || row.text) : address.value;
  closeOverlay();
  if (row && row.tabId && !newTab) { editing = false; address.blur(); cloud.focusTab(row.tabId); return; }
  editing = false;
  if (row && row.search) cloud.search(target, newTab);
  else cloud.navigate(target, newTab);
  address.blur();
}

let typedSinceFocus = false;
address.addEventListener('input', () => { editing = true; typedSinceFocus = true; updateSuggestions(); });
address.addEventListener('focus', () => { editing = true; typedSinceFocus = false; address.select(); });
address.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== address) { editing = false; closeOverlay(); render(); } }, 0); });
address.addEventListener('keydown', e => {
  const open = document.body.classList.contains('overlay') && rows.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); sel = (sel + 1) % rows.length; renderSuggestions(); address.value = rows[sel].url || rows[sel].text; }
  else if (e.key === 'ArrowUp' && open) { e.preventDefault(); sel = (sel - 1 + rows.length) % rows.length; renderSuggestions(); address.value = rows[sel].url || rows[sel].text; }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const newTab = e.altKey;
    if (open && sel > 0) go(rows[sel], newTab);
    else go(null, newTab);
  }
  else if (e.key === 'Escape') {
    e.preventDefault();
    if (open) { closeOverlay(); address.value = typed; }
    else { editing = false; address.blur(); render(); cloud.focusPage(); }
  }
});
$('backdrop').addEventListener('mousedown', e => {
  e.preventDefault();
  if (document.body.classList.contains('panel')) { closeVpnPanel(); closeExtPanel(); closeMediaPanel(); return; }
  closeOverlay(); editing = false; address.blur(); render(); cloud.focusPage();
});

// ---------- VPN panel ----------

let vpnInfo = null;
function openVpnPanel() {
  const r = $('vpn-btn').getBoundingClientRect();
  const panel = $('vpn-panel');
  panel.hidden = false;
  panel.style.top = (r.bottom + 8) + 'px';
  panel.style.left = Math.max(8, Math.min(window.innerWidth - 368, r.right - 360)) + 'px';
  document.body.classList.add('panel');
  cloud.setOverlay(true);
  cloud.vpnInfo().then(i => { if (i) { vpnInfo = i; renderVpn(); } });
}
function closeVpnPanel() {
  if ($('vpn-panel').hidden) return;
  $('vpn-panel').hidden = true;
  document.body.classList.remove('panel');
  cloud.setOverlay(false);
}
$('vpn-btn').onclick = () => ($('vpn-panel').hidden ? openVpnPanel() : closeVpnPanel());
$('vp-toggle').onchange = () => cloud.vpnToggle();
$('vp-country').onchange = e => cloud.vpnCountry(e.target.value);
$('vp-import').onclick = () => cloud.vpnImport();
$('vp-check').onclick = () => { closeVpnPanel(); cloud.vpnCheckIp(); };
$('vp-newip').onclick = () => cloud.vpnNewIp();
$('vp-incog').onchange = e => cloud.vpnIncognito(e.target.checked);
for (const b of document.querySelectorAll('.vp-seg button')) b.onclick = () => cloud.vpnMode(b.dataset.mode);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeVpnPanel(); });
cloud.onVpn(i => { vpnInfo = i; renderVpn(); });

function vpnStatusText(i) {
  if (!i) return '';
  const where = i.location ? ` · ${i.location}` : '';
  switch (i.status) {
    case 'on': return `${i.scope === 'incognito' ? 'Incognito protected' : 'Protected'}${where} · ${i.ip}`;
    case 'connecting': return i.mode === 'tor' ? `Connecting to Tor… ${i.progress || 0}%` : 'Connecting…';
    case 'error': return i.error || 'Something went wrong';
    default: return i.incognitoVpn ? 'Off · incognito windows will use it automatically' : 'Off · websites can see your real IP address';
  }
}

function renderVpn() {
  const i = vpnInfo;
  if (!i) return;
  const btn = $('vpn-btn');
  const active = i.enabled || (i.scope === 'incognito' && document.body.classList.contains('incognito'));
  btn.className = 'vpn-pill' + (active ? ' ' + i.status : '');
  $('vpn-label').textContent = active && i.status === 'connecting' ? `${i.progress || 0}%` : 'VPN';
  btn.title = 'CloudBrowser VPN: ' + vpnStatusText(i);
  if ($('vpn-panel').hidden) return;
  $('vp-toggle').checked = i.enabled;
  $('vp-incog').checked = i.incognitoVpn;
  $('vp-newip').disabled = i.status !== 'on';
  const st = $('vp-status');
  st.textContent = vpnStatusText(i);
  st.className = 'vp-status ' + (i.enabled ? i.status : '');
  $('vp-progress').classList.toggle('show', i.enabled && i.status === 'connecting');
  $('vp-progress').firstElementChild.style.width = (i.progress || 0) + '%';
  for (const b of document.querySelectorAll('.vp-seg button')) b.classList.toggle('sel', b.dataset.mode === i.mode);
  $('vp-tor').hidden = i.mode !== 'tor';
  $('vp-wg').hidden = i.mode !== 'wireguard';
  const sel = $('vp-country');
  if (sel.options.length !== i.countries.length) sel.replaceChildren(...i.countries.map(([id, name]) => { const o = document.createElement('option'); o.value = id; o.textContent = name; return o; }));
  sel.value = i.country;
  $('vp-wg-file').textContent = i.wgConfigName ? `Using ${i.wgConfigName}` : 'No config imported yet';
}

cloud.onFocusAddress(() => { address.focus(); address.select(); });

// ---------- find bar ----------

const findInput = $('find-input');
function openFind() {
  $('findbar').hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value) cloud.find(findInput.value, { newSearch: true, forward: true });
}
function closeFind() {
  if ($('findbar').hidden) return;
  $('findbar').hidden = true;
  $('find-count').textContent = '';
  findInput.classList.remove('none');
  cloud.findStop();
}
function findNext(forward) {
  if ($('findbar').hidden) { openFind(); return; }
  if (findInput.value) cloud.find(findInput.value, { forward, newSearch: false });
}
findInput.addEventListener('input', () => cloud.find(findInput.value, { newSearch: true, forward: true }));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); findNext(!e.shiftKey); }
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
$('find-next').onclick = () => findNext(true);
$('find-prev').onclick = () => findNext(false);
$('find-close').onclick = closeFind;
cloud.onFindOpen(openFind);
cloud.onFindNext(o => findNext(o.forward));
cloud.onFindClose(closeFind);
cloud.onFindResult(r => {
  const none = !!findInput.value && r.matches === 0;
  findInput.classList.toggle('none', none);
  $('find-count').textContent = !findInput.value ? '' : none ? 'No results' : `${r.active} of ${r.matches}`;
});

// ---------- downloads ----------

cloud.onDownloadDone(() => {
  const b = $('downloads');
  b.classList.remove('bounce');
  void b.offsetWidth;
  b.classList.add('bounce');
});

// ---------- rendering ----------

cloud.onState(s => { state = s; render(); });

function activeTab() { return state && state.tabs.find(t => t.id === state.activeId); }

function displayUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith('data:') || url.startsWith('cloud://newtab')) return '';
  return url;
}

function siteKind(url) {
  if (!url) return 'search';
  if (url.startsWith('https://')) return 'secure';
  if (url.startsWith('cloud://')) return 'internal';
  if (url.startsWith('http://')) return 'insecure';
  return 'search';
}

// Tabs are kept and updated in place (not rebuilt on every change), so the strip stays smooth
// even while a page is loading or the ad blocker is busy.
const tabEls = new Map(); // id -> { el, key }
let tabsLayoutKey = '';

function tabKey(t, vertical, narrow) {
  return [t.title, t.favicon, t.loading, t.private, t.audible, t.muted, t.pinned, t.sleeping, t.id === state.activeId, vertical, narrow].join('|');
}

function buildTab(t, vertical, narrow) {
  const el = document.createElement('div');
  el.dataset.id = String(t.id);
  el.draggable = true;
  el.onmousedown = e => {
    if (e.button === 0) cloud.switchTab(t.id);
    if (e.button === 1) e.preventDefault();
  };
  el.onauxclick = e => { if (e.button === 1) cloud.closeTab(t.id); };
  el.oncontextmenu = e => { e.preventDefault(); cloud.tabMenu(t.id); };
  el.ondblclick = e => e.stopPropagation();
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-tab', String(t.id)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-tab')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const after = state.verticalTabs ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-after', 'drop-before'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/x-tab'));
    const after = el.classList.contains('drop-after');
    el.classList.remove('drop-after', 'drop-before');
    const from = state.tabs.findIndex(x => x.id === id);
    let to = state.tabs.findIndex(x => x.id === Number(el.dataset.id)) + (after ? 1 : 0);
    if (from < to) to--;
    if (id && from !== to) cloud.moveTab(id, to);
  });
  fillTab(el, t, vertical, narrow);
  return el;
}

function fillTab(el, t, vertical, narrow) {
  el.className = 'tab' + (t.id === state.activeId ? ' active' : '') + (narrow && !t.pinned ? ' narrow' : '')
    + (t.pinned ? ' pinned' : '') + (t.sleeping ? ' sleeping' : '');
  el.title = t.title + (t.pinned ? ' (pinned)' : '') + (t.sleeping ? ' (sleeping: click to wake)' : '');

  let icon;
  if (t.loading) {
    icon = document.createElement('div');
    icon.className = 'spinner';
  } else if (t.favicon) {
    icon = document.createElement('img');
    icon.className = 'favicon';
    icon.src = t.favicon;
    icon.onerror = () => { const d = document.createElement('div'); d.className = 'favicon placeholder'; icon.replaceWith(d); };
  } else {
    icon = document.createElement('div');
    icon.className = 'favicon placeholder';
  }
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = t.title;
  const parts = [icon, title];
  if (t.pinned) { const p = document.createElement('span'); p.className = 'pin'; p.innerHTML = ICONS.pin; parts.push(p); }
  if (t.audible || t.muted) {
    const a = document.createElement('button');
    a.className = 'audio';
    a.title = t.muted ? 'Unmute tab' : 'Mute tab';
    a.innerHTML = t.muted ? ICONS.muted : ICONS.sound;
    a.onmousedown = e => e.stopPropagation();
    a.onclick = () => cloud.toggleMute(t.id);
    parts.push(a);
  }
  if (!t.pinned || vertical) {
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Close tab (Ctrl+W)';
    close.innerHTML = ICONS.close;
    close.onmousedown = e => e.stopPropagation();
    close.onclick = () => cloud.closeTab(t.id);
    parts.push(close);
  }
  el.replaceChildren(...parts);
}

function renderTabs() {
  const vertical = !!state.verticalTabs;
  const strip = vertical ? $('vtabs') : $('tabs');
  const other = vertical ? $('tabs') : $('vtabs');
  const narrow = !vertical && state.tabs.length > 0 && (strip.parentElement.clientWidth - 200) / state.tabs.length < 90;
  const layoutKey = `${vertical}`;
  if (layoutKey !== tabsLayoutKey) { tabsLayoutKey = layoutKey; tabEls.clear(); other.replaceChildren(); strip.replaceChildren(); }

  const seen = new Set();
  state.tabs.forEach((t, i) => {
    seen.add(t.id);
    const key = tabKey(t, vertical, narrow);
    let entry = tabEls.get(t.id);
    if (!entry) { entry = { el: buildTab(t, vertical, narrow), key }; tabEls.set(t.id, entry); }
    else if (entry.key !== key) { fillTab(entry.el, t, vertical, narrow); entry.key = key; }
    if (strip.children[i] !== entry.el) strip.insertBefore(entry.el, strip.children[i] || null);
  });
  for (const [id, entry] of tabEls) if (!seen.has(id)) { entry.el.remove(); tabEls.delete(id); }
  if (vertical) { const a = strip.querySelector('.tab.active'); if (a) a.scrollIntoView({ block: 'nearest' }); }
}

function renderBookmarksBar() {
  const bar = $('bookmarksbar');
  bar.classList.toggle('show', !!state.showBookmarksBar);
  if (!state.showBookmarksBar) return;
  if (!state.bookmarks.length) {
    const hint = document.createElement('span');
    hint.className = 'bm-hint';
    hint.textContent = 'Press Ctrl+D or click ☆ to bookmark a page. It will show up here.';
    bar.replaceChildren(hint);
    return;
  }
  bar.replaceChildren(...state.bookmarks.map(b => {
    const el = document.createElement('button');
    el.className = 'bm';
    el.title = `${b.title}\n${b.url}`;
    let icon;
    if (b.favicon) {
      icon = document.createElement('img');
      icon.src = b.favicon;
      icon.onerror = () => { const d = document.createElement('span'); d.className = 'dot'; icon.replaceWith(d); };
    } else {
      icon = document.createElement('span');
      icon.className = 'dot';
    }
    const label = document.createElement('span');
    label.textContent = b.title || b.url;
    el.append(icon, label);
    el.onclick = e => cloud.openBookmark(b.url, e.ctrlKey);
    el.onauxclick = e => { if (e.button === 1) cloud.openBookmark(b.url, true); };
    el.oncontextmenu = e => { e.preventDefault(); cloud.bookmarkMenu(b.id); };
    return el;
  }));
}

function render() {
  if (!state) return;
  const tab = activeTab();

  if (state.activeId !== lastActiveId) {
    lastActiveId = state.activeId;
    if (!editing) closeOverlay();
    // Switched tab while the address bar has focus but nothing was typed: show the new tab's address.
    if (editing && !typedSinceFocus) {
      const nt = activeTab();
      address.value = nt ? displayUrl(nt.url) : '';
      address.select();
    }
  }

  document.body.classList.toggle('vertical', !!state.verticalTabs);
  document.body.classList.toggle('collapsed', !!state.sidebarCollapsed);
  document.body.classList.toggle('maximized', !!state.maximized);
  $('vertical-toggle').title = state.verticalTabs ? 'Turn off vertical tabs' : 'Turn on vertical tabs';
  $('side-collapse').title = state.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  $('win-title').textContent = tab ? tab.title : '';
  renderTabs();
  renderBookmarksBar();
  renderActions();
  $('ext-btn').classList.toggle('show', !!state.extensions);
  renderStoreBar();
  renderRail();
  renderMedia();
  $('vr-badge').classList.toggle('show', !!state.vrActive);
  reportPageRect();

  $('back').disabled = !(tab && tab.canGoBack);
  $('forward').disabled = !(tab && tab.canGoForward);
  $('reload').classList.toggle('loading', !!(tab && tab.loading));
  $('reload').title = tab && tab.loading ? 'Stop (Esc)' : 'Reload (F5)';
  document.body.classList.toggle('incognito', !!state.incognito);
  $('defaultbar').hidden = !state.defaultBanner;

  const url = tab ? tab.url : '';
  if (!editing) address.value = displayUrl(url);
  else if (!typedSinceFocus && address.value !== displayUrl(url)) { address.value = displayUrl(url); address.select(); }
  address.placeholder = `Search ${state.engineName} or enter address`;
  const kind = siteKind(displayUrl(url));
  $('siteicon').dataset.kind = kind;
  $('siteicon').title = { secure: 'Secure connection', insecure: 'Not secure: this site doesn’t use HTTPS', internal: 'CloudBrowser page', search: '' }[kind];

  const star = $('star');
  star.disabled = !tab || !/^(https?|cloud|file):/.test(url) || url.startsWith('cloud://newtab');
  star.classList.toggle('on', !!(tab && tab.bookmarked));
  star.title = tab && tab.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';

  const zb = $('zoom-badge');
  const zoomed = tab && tab.zoom && tab.zoom !== 100;
  zb.classList.toggle('show', !!zoomed);
  zb.textContent = zoomed ? `${tab.zoom}%` : '';
  $('reader-btn').classList.toggle('show', !!(tab && tab.readerable));
  const tr = $('translate-btn');
  tr.classList.toggle('show', !!(tab && (tab.translatable || tab.translated)));
  tr.classList.toggle('on', !!(tab && tab.translated));
  tr.title = tab && tab.translated ? 'Translated · click to show the original' : 'Translate this page';
  if (state.vpn) { vpnInfo = state.vpn; renderVpn(); }

  const shield = $('shield');
  shield.classList.toggle('off', !state.adblock);
  shield.classList.toggle('allowlisted', !!(tab && tab.adblockOff));
  const blocked = tab ? tab.blocked : 0;
  $('shield-count').textContent = state.adblock && blocked ? (blocked > 99 ? '99+' : String(blocked)) : '';
  shield.title = !state.adblock ? 'Ad & tracker blocking is off'
    : tab && tab.adblockOff ? 'Ad blocking is off for this site'
    : `${blocked} ad${blocked === 1 ? '' : 's'} and tracker${blocked === 1 ? '' : 's'} blocked on this page`;
  if (tab && tab.adblockOff) $('shield-count').textContent = '';

  const dl = state.downloads || {};
  const db = $('downloads');
  db.classList.toggle('show', !!dl.show);
  db.classList.toggle('active', dl.active > 0);
  if (dl.active > 0) {
    const pct = dl.progress == null ? 25 : Math.round(dl.progress * 100);
    $('dl-ring').style.background = `conic-gradient(var(--accent) ${pct}%, color-mix(in srgb, var(--accent) 18%, transparent) 0)`;
    $('dl-ring').style.mask = 'radial-gradient(circle, transparent 9px, #000 9.5px)';
    db.title = `${dl.active} download${dl.active === 1 ? '' : 's'} in progress` + (dl.progress != null ? ` (${Math.round(dl.progress * 100)}%)` : '');
  } else {
    db.title = 'Downloads (Ctrl+J)';
  }

  const p = $('progress');
  if (tab && tab.loading) p.className = 'loading';
  else if (p.className === 'loading') p.className = 'done';

  const u = state.update || {};
  const upd = $('update');
  upd.classList.toggle('show', u.status === 'ready');
  if (u.status === 'ready') upd.textContent = `Update ${u.version} ready – restart`;
}

// ---------- sidebar apps (right rail) ----------

const APP_LOOK = {
  'discord.com': ['#5865f2', '<svg viewBox="0 0 24 24" class="fill"><path d="M19.3 5.3A16.6 16.6 0 0 0 15.2 4l-.5 1a15 15 0 0 0-5.4 0L8.8 4a16.5 16.5 0 0 0-4.1 1.3C2.1 9.2 1.4 13 1.7 16.7a16.7 16.7 0 0 0 5 2.5l1.1-1.7-1.8-.9.4-.3a11.9 11.9 0 0 0 11.2 0l.4.3-1.8.9 1.1 1.7a16.6 16.6 0 0 0 5-2.5c.4-4.3-.7-8-3-11.4zM8.7 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z"/></svg>'],
  'music.youtube.com': ['#ff0033', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><path class="fill" d="M10 8.8v6.4l5.2-3.2z"/></svg>'],
  'vrchat.com': ['#1b6b7c', '<svg viewBox="0 0 24 24"><path d="M3.5 9.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-3.3l-1.7-2.2h-3l-1.7 2.2H5.5a2 2 0 0 1-2-2z"/></svg>'],
  'www.youtube.com': ['#ff0033', '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="4"/><path class="fill" d="M10.3 9.3v5.4l4.5-2.7z"/></svg>'],
  'www.twitch.tv': ['#9146ff', '<svg viewBox="0 0 24 24"><path d="M5 4h15v10l-4 4h-3.5L10 20.5V18H5zM11 8v4M15.5 8v4"/></svg>'],
  'web.whatsapp.com': ['#25d366', '<svg viewBox="0 0 24 24"><path d="M4 20l1.3-4A8 8 0 1 1 8.4 19z"/></svg>'],
};
function railLook(url) {
  try { const h = new URL(url).hostname; return APP_LOOK[h] || null; } catch { return null; }
}
let railKey = '';
function renderRail() {
  const sb = state.sidebar;
  document.body.classList.toggle('has-rail', !!sb);
  if (!sb) { railKey = ''; return; }
  const key = JSON.stringify(sb);
  if (key === railKey) return;
  railKey = key;
  $('rail-apps').replaceChildren(...sb.apps.map(a => {
    const b = document.createElement('button');
    b.className = 'rail-btn app' + (sb.open === a.id ? ' open' : '');
    b.title = a.title + (sb.open === a.id ? ' (click to hide)' : '');
    b.dataset.id = a.id;
    const look = railLook(a.url);
    if (look) { b.style.setProperty('--app', look[0]); b.innerHTML = look[1]; }
    else {
      b.style.setProperty('--app', `hsl(${[...a.title].reduce((h, c) => h + c.charCodeAt(0) * 37, 0) % 360} 55% 45%)`);
      const l = document.createElement('span'); l.className = 'letter'; l.textContent = (a.title || '?').trim().charAt(0).toUpperCase();
      b.append(l);
    }
    if (a.badge) { const d = document.createElement('span'); d.className = 'rail-badge'; d.textContent = a.badge > 0 ? (a.badge > 99 ? '99+' : a.badge) : ''; b.append(d); }
    b.onclick = () => cloud.sidebarApp(a.id);
    b.oncontextmenu = e => { e.preventDefault(); cloud.sidebarAppMenu(a.id); };
    return b;
  }));
}
$('rail-add').onclick = () => cloud.sidebarAddMenu();

// ---------- now playing ----------

const PLAY_ICON = '<svg viewBox="0 0 24 24" class="fill"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" class="fill"><rect x="6.5" y="5.5" width="4" height="13" rx="1"/><rect x="13.5" y="5.5" width="4" height="13" rx="1"/></svg>';
function renderMedia() {
  const m = state.media;
  const btn = $('media-btn');
  btn.classList.toggle('show', !!m);
  btn.classList.toggle('playing', !!(m && m.playing));
  if (m) btn.title = `${m.playing ? 'Playing' : 'Paused'}: ${m.title}${m.artist ? ' · ' + m.artist : ''}`;
  if (!m) { closeMediaPanel(); return; }
  $('mp-title').textContent = m.title || 'Untitled';
  $('mp-artist').textContent = m.artist || '';
  $('mp-source').textContent = m.sourceTitle || '';
  const art = $('mp-art');
  if (m.artwork && /^https:/.test(m.artwork)) {
    if (art.dataset.src !== m.artwork) { art.dataset.src = m.artwork; art.style.backgroundImage = `url("${m.artwork.replace(/["\\]/g, '')}")`; }
  } else { art.dataset.src = ''; art.style.backgroundImage = ''; }
  art.classList.toggle('empty', !art.dataset.src);
  $('mp-play').innerHTML = m.playing ? PAUSE_ICON : PLAY_ICON;
  $('mp-prev').disabled = !m.canPrev;
  $('mp-next').disabled = !m.canNext;
}
function openMediaPanel() {
  const r = $('media-btn').getBoundingClientRect();
  const panel = $('media-panel');
  panel.style.top = (r.bottom + 8) + 'px';
  panel.style.left = Math.max(8, Math.min(window.innerWidth - 328, r.right - 320)) + 'px';
  panel.hidden = false;
  $('media-btn').classList.add('open');
  document.body.classList.add('panel');
  cloud.setOverlay(true);
}
function closeMediaPanel() {
  if ($('media-panel').hidden) return;
  $('media-panel').hidden = true;
  $('media-btn').classList.remove('open');
  document.body.classList.remove('panel');
  cloud.setOverlay(false);
}
$('media-btn').onclick = () => ($('media-panel').hidden ? openMediaPanel() : closeMediaPanel());
$('mp-play').onclick = () => cloud.media('toggle');
$('mp-prev').onclick = () => cloud.media('prev');
$('mp-next').onclick = () => cloud.media('next');
$('mp-goto').onclick = () => { closeMediaPanel(); cloud.media('focus'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMediaPanel(); });

// Opening the suggestions makes this view taller, so only react to width changes.
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  if (state) renderTabs();
  closeOverlay();
});
