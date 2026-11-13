// Cloud Desktop: CloudBrowser's own wireless PC-to-Quest streamer (built from ALVR, see cloud-desktop/).
// This installs and starts it from CloudBrowser: the PC streamer into %LOCALAPPDATA%\CloudDesktop,
// and the Quest app over USB with Google's adb tool (downloaded the first time it's needed).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const REPO = 'DaCloudi/CloudBrowser';
const PLATFORM_TOOLS = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const QUEST_APP_ID = 'com.cloudbrowser.desktop';
const WIRED = 'client.wired'; // the streamer's name for the headset on the USB cable
const STEAMVR_URL = 'steam://rungameid/250820';

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 120000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message += (stderr ? `\n${stderr}` : ''); reject(err); } else resolve(String(stdout));
    });
  });
}

class CloudDesktop {
  constructor({ session, log }) {
    this.session = session; // () => Electron.Session used for downloads
    this.log = log;
    this.dir = path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'CloudDesktop');
    this.busy = false;
  }

  /** The newest Cloud Desktop release: { version, pcZip, questApk, page } or null. */
  async latest() {
    const r = await this.session().fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub said ${r.status}`);
    const rel = (await r.json()).find(x => /^cloud-desktop-v/.test(x.tag_name) && !x.draft);
    if (!rel) return null;
    const asset = re => (rel.assets.find(a => re.test(a.name)) || {}).browser_download_url || null;
    return { version: rel.tag_name.replace('cloud-desktop-v', ''), pcZip: asset(/^CloudDesktop-PC-.*\.zip$/), questApk: asset(/^CloudDesktop-Quest-.*\.apk$/), page: rel.html_url };
  }

  exePath() {
    // The advanced settings window (the streamer's own dashboard). Older zips had a sub-folder.
    for (const p of [path.join(this.dir, 'pc', 'alvr_streamer_windows', 'ALVR Dashboard.exe'), path.join(this.dir, 'pc', 'ALVR Dashboard.exe')]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  installedVersion() { try { return fs.readFileSync(path.join(this.dir, 'pc', 'VERSION'), 'utf8').trim(); } catch { return null; } }
  desktopModePath() {
    const p = path.join(this.dir, 'pc', 'desktop-mode', 'DesktopPlus.exe');
    return fs.existsSync(p) ? p : null;
  }

  async status() {
    let latest = null, error = null;
    try { latest = await this.latest(); } catch (e) { error = e.message; }
    return {
      windows: process.platform === 'win32',
      installed: !!this.driverDir(), installedVersion: this.installedVersion(), desktopMode: !!this.desktopModePath(),
      latest: latest && latest.version, available: !!(latest && latest.pcZip && latest.questApk), page: latest && latest.page,
      running: await this.steamvrRunning(), steamvr: this.steamvrInstalled(), error,
    };
  }

  /** True when the dashboard window (advanced settings) is open. */
  async isRunning() { return this.processRunning('ALVR Dashboard.exe'); }
  async steamvrRunning() { return this.processRunning('vrserver.exe'); }
  async processRunning(name) {
    if (process.platform !== 'win32') return false;
    try { return (await run('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', `IMAGENAME eq ${name}`], { timeout: 8000 })).toLowerCase().includes(name.toLowerCase()); } catch { return false; }
  }

  // ---------- the streamer itself (no dashboard needed) ----------

  /** The folder SteamVR loads the streamer from (it holds driver.vrdrivermanifest). */
  driverDir() {
    for (const d of [path.join(this.dir, 'pc'), path.join(this.dir, 'pc', 'alvr_streamer_windows')]) {
      if (fs.existsSync(path.join(d, 'driver.vrdrivermanifest'))) return d;
    }
    return null;
  }
  sessionFile() { const d = this.driverDir(); return d && path.join(d, 'session.json'); }
  readSession() { try { return JSON.parse(fs.readFileSync(this.sessionFile(), 'utf8')); } catch { return null; } }
  port() {
    const s = this.live && this.live.session || this.readSession();
    const p = s && s.session_settings && s.session_settings.connection && s.session_settings.connection.web_server_port;
    return Number(p) || 8082;
  }

  openvrPathsFile() { return path.join(process.env.LOCALAPPDATA || '', 'openvr', 'openvrpaths.vrpath'); }
  steamvrInstalled() { return process.platform === 'win32' && fs.existsSync(this.openvrPathsFile()); }

  /** Tell SteamVR to load Cloud Desktop (and not any other copy of ALVR, whose network ports would clash). */
  registerDriver() {
    const dir = this.driverDir();
    const file = this.openvrPathsFile();
    if (!fs.existsSync(file)) throw new Error('SteamVR isn’t set up on this PC yet. Install SteamVR from Steam, open it once, then try again.');
    const json = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const same = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
    const before = Array.isArray(json.external_drivers) ? json.external_drivers : [];
    const after = before.filter(p => typeof p === 'string' && !same(p, dir) && !/alvr/i.test(path.basename(p)) && !fs.existsSync(path.join(p, 'bin', 'win64', 'driver_alvr_server.dll')));
    const removed = before.length - after.length - (before.some(p => typeof p === 'string' && same(p, dir)) ? 1 : 0);
    after.push(dir);
    json.external_drivers = after;
    const tmp = file + '.cloud-desktop';
    fs.writeFileSync(tmp, JSON.stringify(json, null, '\t'));
    fs.renameSync(tmp, file);
    return { removedOthers: Math.max(0, removed) };
  }

  /** Our adb copy, also where the streamer looks for it, so both use the same one (two different adb versions fight). */
  async shareAdb(progress) {
    const dir = this.driverDir();
    const mine = await this.adb(progress);
    const theirs = path.join(dir, 'platform-tools');
    if (!fs.existsSync(path.join(theirs, 'adb.exe'))) fs.cpSync(path.dirname(mine), theirs, { recursive: true });
    return mine;
  }

  /** Connect: start the streamer in SteamVR. The headset (cable or Wi-Fi) joins by itself. */
  connect(progress = () => {}) {
    return this.guard(async () => {
      if (process.platform !== 'win32') throw new Error('Cloud Desktop is for Windows PCs.');
      if (!this.driverDir()) throw new Error('Install Cloud Desktop on this PC first.');
      const running = await this.steamvrRunning();
      if (running && await this.ping()) { progress('Cloud Desktop is already running. Put your headset on.'); return true; }
      const adb = await this.shareAdb(progress).catch(() => null);
      if (adb && !running) await run(adb, ['kill-server'], { timeout: 8000 }).catch(() => {}); // a stuck adb from last time blocks the cable
      const { removedOthers } = this.registerDriver();
      if (removedOthers) this.log && this.log(`cloud desktop: unregistered ${removedOthers} other ALVR copies`);
      if (running) {
        progress('Restarting SteamVR to load Cloud Desktop…');
        await this.stopSteamvr();
      }
      progress('Starting SteamVR…');
      spawn('cmd.exe', ['/c', 'start', '', STEAMVR_URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        if (await this.ping()) { this.watch(); progress('Ready. Put your headset on and open Cloud Desktop.'); return true; }
        if (i === 30) progress('SteamVR is taking a while… (the first start can take a minute)');
      }
      throw new Error('SteamVR started, but Cloud Desktop didn’t answer. Close SteamVR and click Connect again.');
    });
  }

  async stopSteamvr() {
    try { await this.request('ShutdownSteamvr'); } catch {}
    for (let i = 0; i < 10 && await this.steamvrRunning(); i++) await sleep(1000);
    for (const exe of ['vrmonitor.exe', 'vrserver.exe', 'vrcompositor.exe', 'vrdashboard.exe', 'vrwebhelper.exe']) await run('taskkill.exe', ['/im', exe, '/f'], { timeout: 8000 }).catch(() => {});
  }

  async disconnect() {
    this.stopWatching();
    await this.stopSteamvr();
    return true;
  }

  /** Open the streamer's own settings window, for the many advanced options. */
  advanced() { return this.start(); }

  // ---------- talking to the streamer (http://127.0.0.1:8082/api, needs the X-ALVR header) ----------

  http(method, p, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ host: '127.0.0.1', port: this.port(), path: p, method, timeout: 3000,
        headers: { 'X-ALVR': 'true', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
        let out = '';
        res.on('data', c => { out += c; });
        res.on('end', () => (res.statusCode < 300 ? resolve(out) : reject(new Error(`streamer said ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(data);
    });
  }
  async ping() { try { await this.http('GET', '/api/version'); return true; } catch { return false; } }
  request(req) { return this.http('POST', '/api/dashboard-request', req); }
  trust(hostname) { return this.request({ UpdateClientList: { hostname: String(hostname), action: 'Trust' } }); }
  forget(hostname) { return this.request({ UpdateClientList: { hostname: String(hostname), action: 'RemoveEntry' } }); }

  /** Listen to the streamer's live events (session + statistics) over its websocket. */
  watch() {
    this.watchWanted = Date.now();
    if (this.ws) return;
    if (!this.live) this.live = { session: null, stats: null, statsAt: 0, version: null };
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: '127.0.0.1', port: this.port(), path: '/api/events',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'X-ALVR': 'true' } });
    this.ws = req;
    const drop = () => { if (this.ws === req) this.ws = null; };
    req.on('error', drop);
    req.on('response', res => { res.resume(); drop(); });
    req.on('upgrade', (_res, socket, head) => {
      this.wsSocket = socket;
      const reader = wsReader(text => this.onEvent(text), op => {
        if (op.type === 'ping') socket.write(wsFrame(0xA, op.payload));
      });
      socket.on('data', reader);
      socket.on('close', () => { drop(); if (this.wsSocket === socket) this.wsSocket = null; });
      socket.on('error', () => socket.destroy());
      if (head && head.length) reader(head);
      this.request('GetSession').catch(() => {});
    });
    req.end();
  }
  stopWatching() {
    try { this.wsSocket && this.wsSocket.destroy(); } catch {}
    try { this.ws && this.ws.destroy(); } catch {}
    this.ws = null; this.wsSocket = null;
  }
  onEvent(text) {
    // Most events are logs and per-frame graph numbers; only parse the two we show.
    const head = text.slice(0, 80);
    if (!head.includes('"Session"') && !head.includes('"StatisticsSummary"')) return;
    let e;
    try { e = JSON.parse(text).event_type; } catch { return; }
    if (!e) return;
    if (e.id === 'Session') this.live.session = e.data;
    else if (e.id === 'StatisticsSummary') { this.live.stats = e.data; this.live.statsAt = Date.now(); }
  }

  /** Everything the Cloud Desktop page shows, refreshed about once a second. */
  async liveStatus() {
    // The streamer answering means SteamVR is up; otherwise ask Windows (at most every 3 seconds).
    const server = await this.ping();
    if (!server && (!this.svrAt || Date.now() - this.svrAt > 3000)) { this.svrAt = Date.now(); this.svr = await this.steamvrRunning(); }
    const steamvr = server || !!this.svr;
    if (server) {
      this.watch();
      if (!this.lastSessionAsk || Date.now() - this.lastSessionAsk > 3000) { this.lastSessionAsk = Date.now(); this.request('GetSession').catch(() => {}); }
    } else this.stopWatching();
    const live = this.live || {};
    const session = (server && live.session) || this.readSession();
    const list = (session && session.client_connections) || {};
    const headsets = Object.entries(list).map(([hostname, c]) => ({
      hostname, name: hostname === WIRED ? 'USB cable' : (c.display_name || hostname), wired: hostname === WIRED,
      trusted: !!c.trusted, state: server ? (c.connection_state || 'Disconnected') : 'Disconnected',
      ip: c.current_ip || (c.manual_ips || [])[0] || null,
    })).sort((a, b) => (b.wired - a.wired) || a.name.localeCompare(b.name));
    const active = headsets.find(h => h.state === 'Streaming') || headsets.find(h => h.state === 'Connected' || h.state === 'Connecting');
    const fresh = live.stats && Date.now() - live.statsAt < 5000;
    const st = fresh && active && active.state === 'Streaming' ? live.stats : null;
    return {
      installed: !!this.driverDir(), steamvrInstalled: this.steamvrInstalled(), steamvr, server, busy: this.busy,
      state: !steamvr ? 'off' : !server ? 'starting' : active ? active.state.toLowerCase() : 'waiting',
      via: active ? (active.wired ? 'cable' : 'wifi') : null,
      headsets,
      stats: st && {
        latency: Math.round(st.total_latency_ms), network: Math.round(st.network_latency_ms), fps: st.client_fps,
        mbps: Math.round(st.video_mbits_per_sec), lost: st.packets_lost_per_sec, battery: st.battery_hmd, charging: !!st.hmd_plugged,
      },
    };
  }

  // ---------- USB cable checker ----------

  /** How good is the USB cable? USB 2 or 3, the real speed, and whether the headset is charging. */
  checkCable(progress = () => {}) {
    return this.guard(async () => {
      if (process.platform !== 'win32') throw new Error('Cloud Desktop is for Windows PCs.');
      const adb = this.driverDir() ? await this.shareAdb(progress) : await this.adb(progress);
      progress('Looking for your Quest on the cable…');
      await run(adb, ['start-server'], { timeout: 20000 }).catch(() => {});
      const devices = (await run(adb, ['devices', '-l'], { timeout: 10000 })).split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean)
        .map(l => { const [serial, state] = l.split(/\s+/); return { serial, state, usb: !/:\d+$/.test(serial) && !serial.startsWith('adb-'), model: (l.match(/model:(\S+)/) || [])[1] || '' }; })
        .filter(d => d.usb);
      if (!devices.length) {
        return { found: false, verdict: 'none', title: 'No headset on the cable',
          tips: ['Plug the cable straight into your PC (not a hub), then put the headset on and look for a USB message.', 'Developer Mode must be on: Meta Horizon app › Devices › Headset settings › Developer Mode.', 'Some cables only charge and can’t carry data. Try the cable that came with your Quest, or a Link cable.'] };
      }
      const dev = devices.find(d => d.state === 'device') || devices[0];
      if (dev.state === 'unauthorized') {
        return { found: true, verdict: 'allow', title: 'Allow this PC in your headset',
          tips: ['Put your Quest on. Choose “Allow” on the USB debugging message, and tick “Always allow from this computer”. Then check again.'] };
      }
      if (dev.state !== 'device') return { found: true, verdict: 'none', title: `Your Quest is ${dev.state}`, tips: ['Unplug the cable, plug it back in, and check again.'] };
      const sh = (cmd, t = 10000) => run(adb, ['-s', dev.serial, 'shell', cmd], { timeout: t }).catch(() => '');

      progress('Checking the USB connection type…');
      const speedText = (await sh('cat /sys/class/udc/*/current_speed 2>/dev/null; getprop sys.usb.speed')).toLowerCase();
      const link = /super-speed-plus|superspeedplus/.test(speedText) ? 'usb3+' : /super-speed|superspeed/.test(speedText) ? 'usb3' : /high-speed|highspeed/.test(speedText) ? 'usb2' : /full-speed/.test(speedText) ? 'usb1' : 'unknown';

      progress('Measuring the real speed (about 5 seconds)…');
      const mbps = await this.measure(adb, dev.serial);

      const battery = await sh('dumpsys battery');
      const level = Number((battery.match(/level:\s*(\d+)/) || [])[1]) || null;
      const charging = /USB powered:\s*true|AC powered:\s*true/.test(battery);
      const streaming = !!(this.live && this.live.stats && Date.now() - this.live.statsAt < 5000);

      const linkName = { 'usb3+': 'USB 3 (10 Gbps)', usb3: 'USB 3 (5 Gbps)', usb2: 'USB 2 (480 Mbps)', usb1: 'USB 1 (12 Mbps)', unknown: 'Unknown' }[link];
      let verdict, title;
      const tips = [];
      if (link === 'usb2' || link === 'usb1' || (mbps && mbps < 300)) {
        verdict = 'slow'; title = 'Too slow for smooth streaming';
        tips.push('This is a USB 2 connection. Use a blue (USB 3) port on your PC, or one marked SS, and a USB 3 or Link cable. The Quest’s charging cable that came in the box is USB 2 on some models.');
        tips.push('It still works, but Cloud Desktop may look blurry or stutter in fast games. Wi-Fi 6 on a good router can be better.');
      } else if (mbps && mbps < 800) {
        verdict = 'ok'; title = 'Good enough';
        tips.push('Fine for desktop mode and films. For fast games, try another USB 3 port (ones on the back of the PC are often faster) or a shorter cable.');
      } else {
        verdict = 'great'; title = 'Great cable';
        tips.push('Plenty of speed for top quality.');
      }
      if (!charging) tips.push('Your headset isn’t charging from this port, so the battery will run down while you play. Some USB 3 ports give more power.');
      if (streaming) tips.push('You were streaming during the test, so the speed reads lower than it really is.');
      return { found: true, model: dev.model.replace(/_/g, ' '), link, linkName, mbps, battery: level, charging, verdict, title, tips };
    });
  }

  /** Pull zeros from the headset over the cable for a few seconds and time it. */
  measure(adb, serial) {
    return new Promise(resolve => {
      const child = spawn(adb, ['-s', serial, 'exec-out', 'dd if=/dev/zero bs=1048576 count=4096 2>/dev/null'], { windowsHide: true });
      let bytes = 0, t0 = 0, done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        const secs = t0 ? (Date.now() - t0) / 1000 : 0;
        resolve(secs > 0.5 && bytes > 4 * 1048576 ? Math.round(bytes * 8 / secs / 1e6) : null);
      };
      child.stdout.on('data', b => { if (!t0) { t0 = Date.now(); return; } bytes += b.length; });
      child.on('error', finish);
      child.on('close', finish);
      const timer = setTimeout(finish, 5000);
    });
  }
  async download(url, file, progress, label) {
    const r = await this.session().fetch(url);
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    const total = Number(r.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(file);
    let got = 0, last = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      out.write(Buffer.from(value));
      if (total && Date.now() - last > 300) { last = Date.now(); progress(`${label}: ${Math.round(got / total * 100)}% of ${Math.round(total / 1048576)} MB`); }
    }
    await new Promise((res, rej) => out.end(err => (err ? rej(err) : res())));
  }

  async unzip(zip, dest) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    // Windows' own tar.exe opens zip files.
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest], { timeout: 300000 });
  }

  async guard(fn) {
    if (this.busy) throw new Error('Cloud Desktop is already busy with something. Give it a moment.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  /** Download (or update) the PC streamer. */
  installPc(progress) {
    return this.guard(async () => {
      const latest = await this.latest();
      if (!latest || !latest.pcZip) throw new Error('No Cloud Desktop release is out yet.');
      fs.mkdirSync(this.dir, { recursive: true });
      const zip = path.join(this.dir, 'pc.zip');
      await this.download(latest.pcZip, zip, progress, 'Downloading Cloud Desktop for PC');
      progress('Unpacking…');
      if (await this.isRunning()) await run('taskkill.exe', ['/im', 'ALVR Dashboard.exe', '/f']).catch(() => {});
      if (await this.ping()) { progress('Closing SteamVR so the update can replace files…'); this.stopWatching(); await this.stopSteamvr(); }
      const keep = this.sessionFile() && fs.existsSync(this.sessionFile()) ? fs.readFileSync(this.sessionFile()) : null; // your headsets and settings
      await run('taskkill.exe', ['/im', 'DesktopPlus.exe', '/f']).catch(() => {});
      await run('taskkill.exe', ['/im', 'DesktopPlusUI.exe', '/f']).catch(() => {});
      await this.unzip(zip, path.join(this.dir, 'pc'));
      if (keep && this.driverDir()) fs.writeFileSync(this.sessionFile(), keep);
      fs.writeFileSync(path.join(this.dir, 'pc', 'VERSION'), latest.version);
      fs.rmSync(zip, { force: true });
      progress(`Cloud Desktop ${latest.version} is installed on your PC.`);
      return true;
    });
  }

  start() {
    const exe = this.exePath();
    if (!exe) throw new Error('Install Cloud Desktop on this PC first.');
    spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  }

  /** Desktop mode: your Windows desktop in VR (Desktop+). It starts SteamVR itself if needed. */
  async desktopMode() {
    const exe = this.desktopModePath();
    if (!exe) throw new Error('Install (or update) Cloud Desktop on this PC first. Desktop mode came in Cloud Desktop 1.1.');
    if (!(await this.ping())) await this.connect(); // the streamer, so the headset can connect
    spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  async adb(progress) {
    const exe = path.join(this.dir, 'platform-tools', 'adb.exe');
    if (fs.existsSync(exe)) return exe;
    progress('Getting Google’s Android tools (one time only)…');
    fs.mkdirSync(this.dir, { recursive: true });
    const zip = path.join(this.dir, 'platform-tools.zip');
    await this.download(PLATFORM_TOOLS, zip, progress, 'Downloading Android tools');
    await this.unzip(zip, this.dir + '\\pt-tmp');
    fs.rmSync(path.join(this.dir, 'platform-tools'), { recursive: true, force: true });
    fs.renameSync(path.join(this.dir, 'pt-tmp', 'platform-tools'), path.join(this.dir, 'platform-tools'));
    fs.rmSync(path.join(this.dir, 'pt-tmp'), { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
    return exe;
  }

  /** Install (or update) the Quest app over USB. */
  installQuest(progress) {
    return this.guard(async () => {
      const latest = await this.latest();
      if (!latest || !latest.questApk) throw new Error('No Cloud Desktop release is out yet.');
      const adb = await this.adb(progress);
      progress('Looking for your Quest…');
      await run(adb, ['start-server']).catch(() => {});
      const devices = (await run(adb, ['devices'])).split(/\r?\n/).slice(1).map(l => l.trim().split(/\s+/)).filter(x => x[0]);
      if (!devices.length) {
        throw new Error('No Quest found. Plug your Quest into this PC with a USB cable, make sure Developer Mode is on (Meta Horizon app on your phone › Devices › Headset settings › Developer Mode), then try again.');
      }
      if (devices.some(d => d[1] === 'unauthorized')) {
        throw new Error('Put your Quest on and choose “Allow” (tick “Always allow from this computer”) on the USB debugging message, then try again.');
      }
      const apk = path.join(this.dir, 'CloudDesktop-Quest.apk');
      await this.download(latest.questApk, apk, progress, 'Downloading the Quest app');
      progress('Installing on your Quest…');
      const out = await run(adb, ['install', '-r', apk], { timeout: 300000 });
      if (!/Success/i.test(out)) throw new Error('The Quest said: ' + out.trim().slice(-300));
      progress(`Installed. On your Quest: App Library › Unknown Sources › Cloud Desktop.`);
      return true;
    });
  }

  async questInstalled() {
    const adb = path.join(this.dir, 'platform-tools', 'adb.exe');
    if (!fs.existsSync(adb)) return null;
    try { return (await run(adb, ['shell', 'pm', 'list', 'packages', QUEST_APP_ID], { timeout: 8000 })).includes(QUEST_APP_ID); } catch { return null; }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A tiny websocket reader: calls onText for each text message (handles split and joined frames). */
function wsReader(onText, onControl) {
  let buf = Buffer.alloc(0), parts = [];
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskAt = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) { payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)]; }
      buf = buf.subarray(off + len);
      if (op === 0x9) onControl({ type: 'ping', payload });
      else if (op === 0x1 || op === 0x0 || op === 0x2) {
        parts.push(payload);
        if (fin) { const msg = Buffer.concat(parts); parts = []; if (op !== 0x2) try { onText(msg.toString('utf8')); } catch {} }
      }
    }
  };
}

/** A masked client frame (pong replies). */
function wsFrame(op, payload = Buffer.alloc(0)) {
  const mask = crypto.randomBytes(4);
  const head = Buffer.from([0x80 | op, 0x80 | payload.length]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

module.exports = { CloudDesktop, wsReader };
