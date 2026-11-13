// Cloud Desktop: connect your PC to your Quest, see what's happening, and check your USB cable.
'use strict';
const clean = e => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const CABLE_ICON = '<svg viewBox="0 0 24 24"><path d="M12 3v11M9 6l3-3 3 3M8 10v2a4 4 0 0 0 8 0v-2"/><path d="M12 16v5"/></svg>';
const WIFI_ICON = '<svg viewBox="0 0 24 24"><path d="M3.5 9a12.5 12.5 0 0 1 17 0M6.5 12.3a8 8 0 0 1 11 0M9.5 15.5a3.6 3.6 0 0 1 5 0"/><circle cx="12" cy="18.6" r=".9"/></svg>';
const STATE_TEXT = {
  off: ['Not connected', 'Click Connect, then put your headset on and open Cloud Desktop.'],
  starting: ['Starting…', 'SteamVR is starting up. This takes a few seconds.'],
  waiting: ['Waiting for your headset', 'Open Cloud Desktop on your Quest (App Library › Unknown Sources). Plug in a USB cable, or use the same Wi-Fi as this PC.'],
  connecting: ['Connecting…', 'Your headset was found. Hang on a moment.'],
  connected: ['Connected', 'Almost there: the picture starts in a second.'],
  streaming: ['Streaming', ''],
};

let status = null, live = null, busy = false, desktopModeReady = false;

function setProgress(text) { const p = $('progress'); p.hidden = !text; p.textContent = text || ''; }

async function act(btn, fn) {
  if (busy) return;
  busy = true; btn.disabled = true;
  try { await fn(); } catch (e) { setProgress(clean(e)); }
  busy = false; btn.disabled = false;
  tick(); refreshStatus();
}

function render() {
  if (!live) return;
  const hero = $('hero');
  hero.dataset.state = live.state;
  let [title, hint] = STATE_TEXT[live.state] || STATE_TEXT.off;
  if (live.state === 'streaming' || live.state === 'connected') title += live.via === 'cable' ? ' over USB cable' : ' over Wi-Fi';
  if (live.state === 'streaming') hint = live.via === 'cable' ? 'Your PC is on your Quest through the cable. Have fun!' : 'Your PC is on your Quest over Wi-Fi. A USB cable can be smoother.';
  if (!live.installed && live.state === 'off') { title = 'Not installed yet'; hint = 'Install Cloud Desktop on this PC and your Quest below, then come back here and click Connect.'; }
  else if (!live.steamvrInstalled && live.state === 'off') { title = 'SteamVR needed'; hint = 'Install SteamVR from Steam and open it once. Cloud Desktop runs inside it.'; }
  $('stateTitle').textContent = title;
  $('stateHint').textContent = hint;

  const on = live.state !== 'off';
  const c = $('connect');
  c.textContent = on ? 'Disconnect' : 'Connect';
  c.classList.toggle('stop', on);
  if (!busy) c.disabled = !live.installed || (!on && !live.steamvrInstalled) || live.busy;
  if (!busy) $('desktop').disabled = !live.installed || !desktopModeReady || live.busy;
  $('desktop').title = live.installed && !desktopModeReady ? 'Update Cloud Desktop on this PC to get desktop mode' : 'Your Windows desktop on big screens in VR';

  const s = live.stats;
  $('tiles').hidden = !s;
  if (s) {
    $('tLatency').textContent = s.latency;
    $('tLatency').parentElement.classList.toggle('warn', s.latency > 80);
    $('tFps').textContent = s.fps;
    $('tMbps').textContent = s.mbps;
    $('tBattery').textContent = s.battery ? s.battery + '%' : '–';
    $('tBatteryLabel').textContent = s.charging ? 'battery, charging' : 'battery';
  }

  const list = $('headsets');
  const rows = live.headsets.filter(hs => !hs.wired || live.server || hs.state !== 'Disconnected');
  const wired = live.headsets.find(hs => hs.wired);
  list.replaceChildren(...(rows.length ? rows : []).map(hs => h('div', { className: 'hs' },
    h('span', { html: hs.wired ? CABLE_ICON : WIFI_ICON }),
    h('div', { className: 'txt' }, h('b', {}, hs.wired ? 'Quest on the USB cable' : hs.name),
      h('small', {}, hs.wired ? 'Used automatically whenever a cable is plugged in' : (hs.ip ? `Wi-Fi · ${hs.ip}` : 'Wi-Fi'))),
    hs.trusted ? h('span', { className: 'badge ' + hs.state }, hs.state === 'Disconnected' ? 'Not connected' : hs.state)
      : h('span', { className: 'badge untrusted' }, 'New'),
    !hs.trusted && h('button', { className: 'btn primary', onclick: e => act(e.target, () => cloud.call('cd-trust', hs.hostname)) }, 'Trust'),
    !hs.wired && h('button', { className: 'btn', title: 'Remove this headset', onclick: e => act(e.target, () => cloud.call('cd-forget', hs.hostname)) }, hs.trusted ? 'Forget' : 'Ignore'),
  )));
  if (!rows.length) list.append(h('div', { className: 'empty-row' }, live.server ? 'Waiting… Open Cloud Desktop on your Quest and it appears here.' : 'Connect, then open Cloud Desktop on your Quest. It appears here.'));
  if (!live.server && wired && rows.length) list.prepend(h('div', { className: 'empty-row' }, 'USB cable is ready. It connects by itself after you click Connect.'));
}

async function tick() {
  try { live = await cloud.call('cd-live'); render(); } catch (e) { $('stateHint').textContent = clean(e); }
}

async function refreshStatus() {
  try {
    status = await cloud.call('cd-status');
    desktopModeReady = !!status.desktopMode;
    $('ver').textContent = status.installedVersion ? 'Version ' + status.installedVersion : '';
    const upd = status.installed && status.available && status.installedVersion !== status.latest;
    $('installPc').textContent = status.installed ? (upd ? `Update to ${status.latest}` : 'Reinstall') : 'Install on this PC';
    $('installPc').classList.toggle('primary', !status.installed || upd);
    $('installPc').disabled = !status.available;
    $('installQuest').disabled = !status.available;
    $('notes').disabled = !status.page;
    $('pcHint').textContent = !status.windows ? 'Cloud Desktop is for Windows PCs.'
      : status.installed ? `Installed${status.installedVersion ? ` (${status.installedVersion})` : ''}.${upd ? ` Version ${status.latest} is out.` : ' Up to date.'}`
      : status.available ? 'Downloads Cloud Desktop for this PC (about 100 MB).' : (status.error ? `Couldn’t check for Cloud Desktop (${status.error}).` : 'Not available yet.');
    $('steamHint').textContent = status.steamvr ? 'Installed. Cloud Desktop starts it for you.' : 'Not found. Install SteamVR from Steam and open it once.';
    render();
  } catch (e) { $('pcHint').textContent = clean(e); }
}

cloud.on('cd-progress', setProgress);

$('connect').onclick = e => act(e.target, async () => {
  if (live && live.state !== 'off') { setProgress('Disconnecting…'); await cloud.call('cd-disconnect'); setProgress(''); }
  else { await cloud.call('cd-connect'); setTimeout(() => setProgress(''), 6000); }
});
$('desktop').onclick = e => act(e.target, async () => {
  setProgress('Starting desktop mode… Put your headset on. The first time, Desktop+ shows a quick setup.');
  await cloud.call('cd-desktop-mode');
});
$('installPc').onclick = e => act(e.target, () => cloud.call('cd-install-pc'));
$('installQuest').onclick = e => act(e.target, () => cloud.call('cd-install-quest'));
$('notes').onclick = () => cloud.call('cd-release-page');
$('advanced').onclick = e => act(e.target, () => cloud.call('cd-advanced'));
$('credits').onclick = () => { $('creditsText').hidden = !$('creditsText').hidden; };

$('checkCable').onclick = e => act(e.target, async () => {
  e.target.textContent = 'Checking…';
  try {
    const r = await cloud.call('cd-check-cable');
    $('cableResult').hidden = false;
    $('verdict').className = 'verdict ' + r.verdict;
    $('verdictTitle').textContent = r.title + (r.model ? ` · ${r.model}` : '');
    const measured = r.found && r.link;
    document.querySelector('.facts').classList.toggle('hide', !measured);
    document.querySelector('.meter').classList.toggle('hide', !measured);
    if (measured) {
      $('cLink').textContent = r.linkName;
      $('cSpeed').textContent = r.mbps ? `${r.mbps.toLocaleString()} Mbps` : 'Couldn’t measure';
      $('cBattery').textContent = r.battery ? `${r.battery}%${r.charging ? ', charging' : ', not charging'}` : (r.charging ? 'Charging' : '–');
      $('cMeter').style.width = Math.min(100, (r.mbps || 0) / 20) + '%';
      $('cMeter').style.background = r.verdict === 'great' ? '#3ba55d' : r.verdict === 'ok' ? '#f0b232' : 'var(--danger)';
    }
    $('cTips').replaceChildren(...r.tips.map(t => h('li', {}, t)));
    setProgress('');
  } finally { e.target.textContent = 'Check again'; }
});

refreshStatus();
tick();
setInterval(() => { if (!document.hidden) tick(); }, 1000);
