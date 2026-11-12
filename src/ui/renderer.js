// CloudBrowser - browser UI (tab strip + toolbar)
const $ = id => document.getElementById(id);
const address = $('address');
let state = null;
let editing = false; // don't overwrite the address bar while the user is typing

$('newtab').onclick = () => cloud.newTab();
$('back').onclick = () => cloud.back();
$('forward').onclick = () => cloud.forward();
$('home').onclick = () => cloud.home();
$('private').onclick = () => cloud.togglePrivate();
$('menu').onclick = () => cloud.menu();
$('update').onclick = () => cloud.installUpdate();
$('reload').onclick = () => {
  const t = activeTab();
  t && t.loading ? cloud.stop() : cloud.reload();
};

$('addressform').onsubmit = e => {
  e.preventDefault();
  editing = false;
  cloud.navigate(address.value);
  address.blur();
};
address.addEventListener('focus', () => { editing = true; address.select(); });
address.addEventListener('blur', () => { editing = false; render(); });
address.addEventListener('keydown', e => {
  if (e.key === 'Escape') { editing = false; address.blur(); render(); }
});

cloud.onFocusAddress(() => { address.focus(); address.select(); });
cloud.onState(s => { state = s; render(); });

function activeTab() {
  return state && state.tabs.find(t => t.id === state.activeId);
}

function displayUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith('data:')) return '';
  return url;
}

function render() {
  if (!state) return;
  const tab = activeTab();

  // Tabs
  const strip = $('tabs');
  strip.replaceChildren(...state.tabs.map(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === state.activeId ? ' active' : '');
    el.title = t.title;
    el.onmousedown = e => {
      if (e.button === 1) { e.preventDefault(); cloud.closeTab(t.id); } // middle-click closes
      else if (e.button === 0) cloud.switchTab(t.id);
    };

    let icon;
    if (t.loading) {
      icon = document.createElement('div');
      icon.className = 'spinner';
    } else if (t.favicon) {
      icon = document.createElement('img');
      icon.className = 'favicon';
      icon.src = t.favicon;
      icon.onerror = () => { icon.removeAttribute('src'); icon.classList.add('placeholder'); };
    } else {
      icon = document.createElement('div');
      icon.className = 'favicon placeholder';
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab (Ctrl+W)';
    close.onmousedown = e => e.stopPropagation();
    close.onclick = () => cloud.closeTab(t.id);

    el.append(icon);
    if (t.private) { const d = document.createElement('span'); d.className = 'private-dot'; d.title = 'Private tab'; el.append(d); }
    el.append(title, close);
    return el;
  }));

  // Toolbar
  $('back').disabled = !(tab && tab.canGoBack);
  $('forward').disabled = !(tab && tab.canGoForward);
  $('reload').classList.toggle('loading', !!(tab && tab.loading));
  $('reload').title = tab && tab.loading ? 'Stop' : 'Reload (F5)';
  $('private').classList.toggle('on', state.privateMode);
  document.body.classList.toggle('private-mode', !!(tab && tab.private));

  if (!editing) address.value = tab ? displayUrl(tab.url) : '';
  $('lock').classList.toggle('on', !!(tab && tab.url.startsWith('https://')));

  // Progress bar
  const p = $('progress');
  if (tab && tab.loading) { p.className = 'loading'; }
  else if (p.className === 'loading') { p.className = 'done'; }

  // Update button
  const u = state.update || {};
  const upd = $('update');
  upd.classList.toggle('show', u.status === 'ready');
  if (u.status === 'ready') upd.textContent = `Update ${u.version} ready – restart`;
}
