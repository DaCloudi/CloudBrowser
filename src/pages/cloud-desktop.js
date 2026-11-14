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
  tick(); refreshStatus(); loadAudio();
}

function render() {
  if (!live) return;
  const hero = $('hero');
  hero.dataset.state = live.state;
  let [title, hint] = STATE_TEXT[live.state] || STATE_TEXT.off;
  if (live.state === 'streaming' || live.state === 'connected') title += live.via === 'cable' ? ' over USB cable' : ' over Wi-Fi';
  if (live.state === 'streaming') hint = live.via === 'cable' ? 'Your PC is on your Quest through the cable. Have fun!' : 'Your PC is on your Quest over Wi-Fi. A USB cable can be smoother.';
  if (live.restarting) { title = 'Getting SteamVR ready for your headset…'; hint = 'SteamVR restarts once to match your headset’s screen. Keep the headset on; it reconnects by itself.'; }
  else if (!live.installed && live.state === 'off') { title = 'Not installed yet'; hint = 'Install Cloud Desktop on this PC and your Quest below, then come back here and click Connect.'; }
  else if (!live.steamvrInstalled && live.state === 'off') { title = 'SteamVR needed'; hint = 'Install SteamVR from Steam and open it once. Cloud Desktop runs inside it.'; }
  $('stateTitle').textContent = title;
  $('stateHint').textContent = hint;

  const on = live.state !== 'off';
  const c = $('connect');
  c.textContent = on ? 'Disconnect' : 'Connect';
  c.classList.toggle('stop', on);
  if (!busy) c.disabled = !live.installed || (!on && !live.steamvrInstalled) || live.busy;
  if (!busy) $('desktop').disabled = !live.installed || !desktopModeReady || live.busy;
  $('desktop').textContent = live.desktopMode ? 'Leave desktop mode' : 'Desktop mode';
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

  // Wi-Fi tips from what the stream is actually doing.
  const tips = [];
  if (s && live.via === 'wifi') {
    if (s.network > 15) tips.push(`Wi-Fi delay is high (${s.network} ms). Move closer to the router, or use its 5 GHz or 6 GHz network.`);
    if (s.lost > 0) tips.push('Some picture data is being lost. Fewer devices streaming on your Wi-Fi at the same time helps, and so does a router in the same room.');
    if (s.mbps < 60) tips.push('The picture is running at a low bitrate. The biggest fix: plug your PC into the router with an ethernet cable.');
  }
  $('wifiTips').hidden = !tips.length;
  $('wifiTipList').replaceChildren(...tips.map(t => h('li', {}, t)));

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
    $('installBoost').disabled = !status.available;
    $('setupBoost').disabled = !status.available;
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
  if (live && live.desktopMode) { await cloud.call('cd-set-desktop-mode', false); setProgress(''); return; }
  setProgress('Starting desktop mode… Put your headset on. The first time, Desktop+ shows a quick setup.');
  await cloud.call('cd-set-desktop-mode', true);
});
$('installPc').onclick = e => act(e.target, () => cloud.call('cd-install-pc'));
$('installQuest').onclick = e => act(e.target, () => cloud.call('cd-install-quest'));
$('installBoost').onclick = e => act(e.target, () => cloud.call('cd-install-boost'));
$('setupBoost').onclick = e => act(e.target, () => cloud.call('cd-setup-boost'));
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
      $('cSpeed').textContent = { 'usb3+': 'up to 10 Gbps', usb3: 'up to 5 Gbps', usb2: 'up to 480 Mbps', usb1: '12 Mbps' }[r.link] || '–';
      $('cBattery').textContent = r.battery ? `${r.battery}%${r.charging ? ', charging' : ', not charging'}` : (r.charging ? 'Charging' : '–');
      $('cMeter').style.width = ({ 'usb3+': 100, usb3: 70, usb2: 12, usb1: 2 }[r.link] || 0) + '%';
      $('cMeter').style.background = r.verdict === 'great' ? '#3ba55d' : r.verdict === 'ok' ? '#f0b232' : 'var(--danger)';
    }
    $('cTips').replaceChildren(...r.tips.map(t => h('li', {}, t)));
    setProgress('');
  } finally { e.target.textContent = 'Check again'; }
});

// ---------- microphone and sound ----------
let audio = null;
function renderAudio() {
  if (!audio) return;
  $('mic').checked = audio.mic;
  $('lowDelay').checked = audio.lowDelay;
  $('autoQuality').checked = audio.autoQuality;
  $('passthrough').checked = audio.passthrough;
  $('menuShortcut').checked = audio.menuShortcut;
  $('autoUpdate').checked = audio.autoUpdate !== false;
  if (!audio.room) $('ptHint').textContent = 'Update Cloud Desktop on this PC to get this. Your real room around your desktop screens (passthrough), like Virtual Desktop.';
  $('vbRow').hidden = !(audio.mic && !audio.vbcable);
  $('micHint').textContent = !audio.mic ? 'Off. Your Quest’s mic won’t reach this PC.'
    : audio.vbcable ? 'On. In Discord or your game, pick “CABLE Output” as the microphone. Changes apply the next time your headset connects.'
    : 'Needs VB-Cable first (below).';
  $('delayHint').textContent = audio.lastCable === 'slow'
    ? 'Your cable checked as too slow, so the safer setting stays on even on the cable.'
    : 'Halves the sound delay (50 ms to 25 ms) when your Quest is on a good USB cable. Wi-Fi keeps the safer setting so sound doesn’t crackle.';
}
async function loadAudio() { try { audio = await cloud.call('cd-audio'); renderAudio(); } catch {} }
$('mic').onchange = async () => { audio = await cloud.call('cd-set-audio', { mic: $('mic').checked }).catch(() => audio); renderAudio(); };
for (const id of ['passthrough', 'menuShortcut', 'autoUpdate']) {
  $(id).onchange = async () => { audio = await cloud.call('cd-set-audio', { [id]: $(id).checked }).catch(() => audio); renderAudio(); };
}
$('autoQuality').onchange = async () => { audio = await cloud.call('cd-set-audio', { autoQuality: $('autoQuality').checked }).catch(() => audio); renderAudio(); };
$('lowDelay').onchange = async () => { audio = await cloud.call('cd-set-audio', { lowDelay: $('lowDelay').checked }).catch(() => audio); renderAudio(); };
$('getVb').onclick = e => act(e.target, async () => {
  await cloud.call('cd-install-vbcable');
  $('micHint').textContent = 'Finish the VB-Cable installer, then restart your PC. Come back here afterwards.';
});

let micTest = null;
async function stopMicTest() {
  if (!micTest) return;
  clearTimeout(micTest.timer); cancelAnimationFrame(micTest.raf);
  micTest.stream.getTracks().forEach(t => t.stop());
  micTest.ctx.close().catch(() => {});
  micTest = null;
  $('testMic').textContent = 'Test';
  $('level').style.width = '0';
}
$('testMic').onclick = async () => {
  if (micTest) return stopMicTest();
  try {
    // Ask once so device names show, then listen to VB-Cable's output (that's where the headset mic arrives).
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach(t => t.stop());
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    const cable = inputs.find(d => /CABLE Output/i.test(d.label));
    if (!cable) { $('testHint').textContent = 'VB-Cable’s “CABLE Output” wasn’t found. Install VB-Cable and restart your PC first.'; return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cable.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext();
    const an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let heard = 0;
    micTest = { stream, ctx, raf: 0, timer: 0 };
    $('levelWrap').hidden = false;
    $('testMic').textContent = 'Stop';
    $('testHint').textContent = live && live.state === 'streaming' ? 'Listening… talk into your headset.' : 'Listening… Connect your headset first, then talk.';
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      if (level > 0.08) heard++;
      $('level').style.width = Math.round(level * 100) + '%';
      micTest.raf = requestAnimationFrame(loop);
    };
    loop();
    micTest.timer = setTimeout(() => {
      $('testHint').textContent = heard > 10 ? 'Working: this PC can hear your headset mic.' : 'Didn’t hear anything. Check the headset is connected and the mic switch is on, then reconnect.';
      stopMicTest();
    }, 12000);
  } catch (e) {
    $('testHint').textContent = e && e.name === 'NotFoundError' ? 'This PC has no microphones yet. Install VB-Cable and restart your PC first.' : 'Couldn’t open the microphone: ' + clean(e);
    stopMicTest();
  }
};

// ---------- health check ----------
async function checkHealth() {
  const list = await cloud.call('cd-health');
  const box = $('healthList');
  box.hidden = false;
  const bad = list.filter(x => !x.ok).length;
  box.replaceChildren(
    h('div', { className: 'verdict ' + (bad ? 'ok' : 'great') }, h('span', { className: 'dot' }), h('b', {}, bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix` : 'Everything looks good')),
    ...list.map(x => h('div', { className: 'hc' + (x.ok ? '' : ' bad') }, h('span', { className: 'dot' }),
      h('div', { className: 'txt' }, x.title, x.detail ? h('small', {}, x.detail) : null),
      x.fix && h('button', { className: 'btn', onclick: e => act(e.target, async () => { await cloud.call('cd-fix', x.fix); await checkHealth(); }) }, x.fix === 'install' ? 'Update' : 'Fix'))));
}
$('checkHealth').onclick = e => act(e.target, checkHealth);

// Update automatically: when a newer version is out and SteamVR isn't running.
let autoUpdateTried = false;
async function maybeAutoUpdate() {
  if (autoUpdateTried || !status || !audio || audio.autoUpdate === false) return;
  if (!status.installed || !status.available || !status.latest || status.installedVersion === status.latest || status.running) return;
  autoUpdateTried = true;
  setProgress(`Updating Cloud Desktop to ${status.latest}…`);
  await act($('installPc'), () => cloud.call('cd-install-pc'));
}

loadAudio().then(() => refreshStatus()).then(() => maybeAutoUpdate());
tick();
setInterval(() => { if (!document.hidden) tick(); }, 1000);
