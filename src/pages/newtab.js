'use strict';
const $ = id => document.getElementById(id);
const ICON = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
};
const MAX_SHORTCUTS = 12;
let info = null;
let sites = [];
let editing = -1; // index being edited in the dialog, -1 = adding

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function hostOf(url) { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } }

function iconFor(site) {
  const ico = document.createElement('div');
  ico.className = 'ico';
  const host = site.host || hostOf(site.url);
  const letter = () => {
    const s = document.createElement('span');
    s.textContent = (site.title || host || '?').trim().charAt(0).toUpperCase();
    return s;
  };
  if (!host) { ico.append(letter()); return ico; }
  const img = document.createElement('img');
  img.alt = '';
  img.src = `https://icons.duckduckgo.com/ip3/${host}.ico`;
  img.onerror = () => img.replaceWith(letter());
  ico.append(img);
  return ico;
}

function tile(site, i) {
  const custom = info.mode === 'custom';
  const a = document.createElement('a');
  a.className = 'site';
  a.href = site.url;
  a.title = site.url;
  a.draggable = custom;

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = site.title;

  const x = document.createElement('button');
  x.className = 'x' + (custom ? ' edit' : '');
  x.title = custom ? 'Edit shortcut' : 'Don’t show this site';
  x.innerHTML = custom ? ICON.edit : ICON.close;
  x.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();
    if (custom) { openDialog(i); return; }
    sites = await cloud.call('hide-site', site.host);
    render();
    $('restore').hidden = false;
  };
  a.append(iconFor(site), name, x);

  if (custom) {
    a.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-index', String(i)); a.classList.add('dragging'); });
    a.addEventListener('dragend', () => a.classList.remove('dragging'));
    a.addEventListener('dragover', e => { e.preventDefault(); a.classList.add('drop-target'); });
    a.addEventListener('dragleave', () => a.classList.remove('drop-target'));
    a.addEventListener('drop', async e => {
      e.preventDefault();
      a.classList.remove('drop-target');
      const from = Number(e.dataTransfer.getData('text/x-index'));
      if (Number.isNaN(from) || from === i) return;
      const list = sites.map(s => ({ title: s.title, url: s.url }));
      const [moved] = list.splice(from, 1);
      list.splice(i, 0, moved);
      sites = await cloud.call('save-shortcuts', list);
      render();
    });
  }
  return a;
}

function addTile() {
  const a = document.createElement('a');
  a.className = 'site add';
  a.href = '#';
  const ico = document.createElement('div');
  ico.className = 'ico';
  const plus = document.createElement('span');
  plus.textContent = '+';
  ico.append(plus);
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = 'Add shortcut';
  a.append(ico, name);
  a.onclick = e => { e.preventDefault(); openDialog(-1); };
  return a;
}

function render() {
  const box = $('sites');
  box.hidden = !info.show || info.incognito;
  const tiles = sites.map(tile);
  if (info.mode === 'custom' && sites.length < MAX_SHORTCUTS) tiles.push(addTile());
  box.replaceChildren(...tiles);
}

// ----- add / edit dialog -----

function openDialog(i) {
  editing = i;
  const s = i >= 0 ? sites[i] : { title: '', url: '' };
  $('dialog-title').textContent = i >= 0 ? 'Edit shortcut' : 'Add shortcut';
  $('d-name').value = s.title || '';
  $('d-url').value = s.url || '';
  $('d-remove').hidden = i < 0;
  $('dialog-back').hidden = false;
  (i >= 0 ? $('d-name') : $('d-url')).focus();
}
function closeDialog() { $('dialog-back').hidden = true; }

$('dialog').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('d-url').value.trim();
  if (!url) { $('d-url').focus(); return; }
  let title = $('d-name').value.trim();
  if (!title) { const h = hostOf(/^[a-z]+:\/\//i.test(url) ? url : 'https://' + url); title = h.split('.')[0] || url; title = title.charAt(0).toUpperCase() + title.slice(1); }
  const list = sites.map(s => ({ title: s.title, url: s.url }));
  if (editing >= 0) list[editing] = { title, url }; else list.push({ title, url });
  sites = await cloud.call('save-shortcuts', list);
  closeDialog();
  render();
});
$('d-remove').onclick = async () => {
  const list = sites.map(s => ({ title: s.title, url: s.url }));
  list.splice(editing, 1);
  sites = await cloud.call('save-shortcuts', list);
  closeDialog();
  render();
};
$('d-cancel').onclick = closeDialog;
$('dialog-back').addEventListener('mousedown', e => { if (e.target === $('dialog-back')) closeDialog(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeDialog(); $('panel').hidden = true; } });

// ----- customise panel -----

$('customize').onclick = () => {
  $('panel').hidden = !$('panel').hidden;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === info.mode;
  $('show').checked = info.show;
};
$('panel-done').onclick = () => { $('panel').hidden = true; };
for (const r of document.querySelectorAll('input[name=mode]')) {
  r.onchange = async () => {
    await cloud.call('set-setting', 'shortcutsMode', r.value);
    await load();
  };
}
$('show').onchange = async () => {
  await cloud.call('set-setting', 'showShortcuts', $('show').checked);
  info.show = $('show').checked;
  render();
};

// ----- search -----

$('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) cloud.call('go', q);
});
$('restore').addEventListener('click', async e => {
  e.preventDefault();
  sites = await cloud.call('restore-sites');
  render();
  $('restore').hidden = true;
});

async function load() {
  info = await cloud.call('newtab');
  sites = info.sites;
  document.body.classList.toggle('incognito', info.incognito);
  document.title = info.incognito ? 'New incognito tab' : 'New tab';
  $('q').placeholder = `Search ${info.engineName} or type a web address`;
  if (info.incognito) {
    $('greeting').textContent = 'Incognito';
    $('incognito-info').hidden = false;
  } else {
    $('greeting').textContent = greeting();
    if (info.adblock && info.blockedTotal > 0) {
      $('stat').textContent = `🛡 ${info.blockedTotal.toLocaleString()} ads and trackers blocked so far`;
    }
  }
  render();
}

load();
