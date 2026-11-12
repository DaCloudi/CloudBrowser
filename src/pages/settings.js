'use strict';
let info = null;

async function load() {
  info = await cloud.call('info');
  const s = info.settings;

  const engine = $('searchEngine');
  engine.replaceChildren(...info.engines.map(e => h('option', { value: e.id }, e.name)));
  fill(s);
  $('dlFolder').textContent = info.downloadsFolder;
  $('version').textContent = info.version;
  $('engineVersions').textContent = `Chromium ${info.chrome} · Electron ${info.electron}`;
  renderAdblockHint(s);
  renderUpdate(info.update);
  renderPermissions();
}

function fill(s) {
  $('searchEngine').value = s.searchEngine;
  if (document.activeElement !== $('homePage')) $('homePage').value = s.homePage;
  $('restoreTabs').checked = s.restoreTabs;
  $('theme').value = s.theme;
  $('showBookmarksBar').checked = s.showBookmarksBar;
  $('adblock').checked = s.adblock;
  $('askDownloadLocation').checked = s.askDownloadLocation;
}

function renderAdblockHint(s) {
  $('adblockHint').textContent = !info.adblockAvailable
    ? 'The blocker couldn’t start. It will try again next time CloudBrowser opens.'
    : `${(s.blockedTotal || 0).toLocaleString()} ads and trackers blocked so far.`;
}

function renderUpdate(u) {
  const el = $('updateStatus');
  el.className = 'update';
  $('installUpdate').hidden = u.status !== 'ready';
  $('checkUpdates').hidden = u.status === 'ready';
  switch (u.status) {
    case 'checking': el.textContent = 'Checking for updates…'; break;
    case 'downloading': el.textContent = `Downloading version ${u.version}… ${u.percent || 0}%`; break;
    case 'ready': el.textContent = `Version ${u.version} is ready. Restart to finish updating.`; el.classList.add('ok'); break;
    case 'none': el.textContent = 'CloudBrowser is up to date.'; el.classList.add('ok'); break;
    case 'error': el.textContent = `Couldn’t check for updates: ${u.message}`; el.classList.add('bad'); break;
    default: el.textContent = info && info.packaged ? 'Updates install automatically.' : 'Updates only work in the installed app.';
  }
}

async function renderPermissions() {
  const list = await cloud.call('permissions');
  const box = $('permissions');
  if (!list.length) { box.replaceChildren(); return; }
  box.replaceChildren(...list.map(p => h('div', { className: 'item' },
    favicon(p.origin),
    h('div', { className: 'main' },
      h('div', { className: 't' }, hostOf(p.origin)),
      h('div', { className: 's' }, p.label)),
    h('span', { className: 'pill ' + p.value }, p.value === 'allow' ? 'Allowed' : 'Blocked'),
    iconButton('close', 'Forget this choice', async () => { await cloud.call('remove-permission', p.origin, p.permission); renderPermissions(); }),
  )));
}

const set = (key, value) => cloud.call('set-setting', key, value);

$('searchEngine').onchange = e => set('searchEngine', e.target.value);
$('homePage').onchange = async e => { await set('homePage', e.target.value); load(); };
$('homeReset').onclick = async () => {
  const e = info.engines.find(x => x.id === $('searchEngine').value);
  await set('homePage', e ? e.home : 'https://duckduckgo.com/');
  load();
};
for (const id of ['restoreTabs', 'showBookmarksBar', 'adblock', 'askDownloadLocation']) {
  $(id).onchange = e => set(id, e.target.checked);
}
$('theme').onchange = e => set('theme', e.target.value);
$('openDlFolder').onclick = () => cloud.call('open-downloads-folder');
$('checkUpdates').onclick = () => cloud.call('check-updates');
$('installUpdate').onclick = () => cloud.call('install-update');

$('clear').onclick = async () => {
  const opts = {
    history: $('c-history').checked, cookies: $('c-cookies').checked, cache: $('c-cache').checked,
    downloads: $('c-downloads').checked, permissions: $('c-permissions').checked,
  };
  if (!Object.values(opts).some(Boolean)) return;
  $('clear').disabled = true;
  $('clearDone').textContent = 'Clearing…';
  await cloud.call('clear-data', opts);
  $('clear').disabled = false;
  $('clearDone').textContent = 'Done.';
  renderPermissions();
  setTimeout(() => { $('clearDone').textContent = ''; }, 3000);
};

cloud.on('update', u => renderUpdate(u));
cloud.on('settings', s => { if (info) { info.settings = s; fill(s); renderAdblockHint(s); } });

load();
