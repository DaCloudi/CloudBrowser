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
const VBCABLE_ZIPS = ['https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip', 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack43.zip'];
const BUFFER_NORMAL = 50, BUFFER_LOW = 25; // ms of sound kept in hand to smooth over hiccups

/** A device on the cable (not Wi-Fi debugging, not a phone emulator like BlueStacks). */
const isUsbSerial = s => !!s && !s.includes(':') && !/^(emulator-|adb-)/.test(s);
const isQuestModel = m => /quest|eureka|hollywood|seacliff|panther|monterey/i.test(m || '');

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
    if (this._pathAdb) return mine; // the streamer finds that one on PATH too
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
      if (running && await this.ping()) {
        this.keepWatching(true);
        this.watch();
        await this.request({ UpdateClientList: { hostname: WIRED, action: { AddIfMissing: { trusted: true, manual_ips: [] } } } }).catch(() => {});
        progress('Cloud Desktop is already running. Put your headset on.');
        return true;
      }
      await this.shareAdb(progress).catch(() => null);
      const { removedOthers } = this.registerDriver();
      if (removedOthers) this.log && this.log(`cloud desktop: unregistered ${removedOthers} other ALVR copies`);
      this.ensureWiredInFile();
      await this.ensureFirewall(progress);
      if (running) {
        progress('Restarting SteamVR to load Cloud Desktop…');
        await this.stopSteamvr();
      }
      await this.startSteamvr(progress);
      progress('Ready. Put your headset on and open Cloud Desktop.');
      return true;
    });
  }

  /** Start SteamVR and wait for the streamer inside it to answer, then get it ready. */
  async startSteamvr(progress = () => {}) {
    progress('Starting SteamVR…');
    spawn('cmd.exe', ['/c', 'start', '', STEAMVR_URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (await this.ping()) {
        this.keepWatching(true);
        this.watch();
        // The USB cable entry (older settings files don't have it), then sound settings.
        await this.request({ UpdateClientList: { hostname: WIRED, action: { AddIfMissing: { trusted: true, manual_ips: [] } } } }).catch(() => {});
        await this.applyAudio().catch(e => this.log && this.log('cloud desktop: audio settings', e.message));
        return true;
      }
      if (i === 30) progress('SteamVR is taking a while… (the first start can take a minute)');
    }
    throw new Error('SteamVR started, but Cloud Desktop didn’t answer. Close SteamVR and click Connect again.');
  }

  /**
   * The streamer asks for this when a headset needs different settings (always the first time a
   * headset connects): SteamVR must restart with them. ALVR's own window used to do it.
   */
  async restartSteamvr() {
    if (this.restarting) return;
    if (await this.isRunning()) return; // the advanced settings window is open and does it itself
    this.restarting = Date.now();
    this.log && this.log('cloud desktop: restarting SteamVR for the headset');
    try {
      await sleep(1500); // let the streamer tell the headset first
      this.stopWatching();
      await this.stopSteamvr();
      await sleep(1500);
      await this.startSteamvr();
    } catch (e) { this.log && this.log('cloud desktop: restart failed', e.message); }
    this.restarting = 0;
  }

  /** Keep the live connection to the streamer, reconnecting after SteamVR restarts. */
  keepWatching(on) {
    clearInterval(this.watchdog);
    this.watchdog = null;
    if (!on) return;
    this.watchdog = setInterval(async () => {
      if (!this.ws && !this.restarting && await this.ping()) this.watch();
      if ((this.roomProc || this.menuProc) && !this._dmBusy && !(await this.desktopModeActive(true))) {
        this.stopMenu(); // Desktop+ was closed: no menu or green room without it
        this.stopRoom().catch(() => {});
      }
    }, 3000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  /** Older settings files have no USB cable entry, so the cable was never used. Add it. */
  ensureWiredInFile() {
    const file = this.sessionFile();
    const s = file && this.readSession();
    if (!s) return;
    s.client_connections = s.client_connections || {};
    if (s.client_connections[WIRED]) return;
    s.client_connections[WIRED] = { display_name: 'USB cable', current_ip: null, manual_ips: [], trusted: true, connection_state: 'Disconnected' };
    fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2));
    fs.renameSync(file + '.tmp', file);
    this.log && this.log('cloud desktop: added the USB cable entry');
  }

  /** Let SteamVR through the Windows firewall for Wi-Fi (asks for admin once, like ALVR's setup did). */
  async ensureFirewall(progress) {
    const rule = 'SteamVR ALVR vrserver';
    if (this.prefs().firewall) return;
    const exists = await run('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${rule}`], { timeout: 15000 }).then(() => true, () => false);
    if (exists) { this.savePrefs({ firewall: true }); return; }
    let root = null;
    try { root = JSON.parse(fs.readFileSync(this.openvrPathsFile(), 'utf8').replace(/^\uFEFF/, '')).runtime[0]; } catch {}
    if (!root) return;
    progress('Windows will ask to let Cloud Desktop through the firewall for Wi-Fi (one time only). Click Yes.');
    const bat = path.join(this.dir, 'firewall.bat');
    fs.writeFileSync(bat, ['win64', 'win32'].map(b => `netsh advfirewall firewall add rule name="${rule}" dir=in program="${path.join(root, 'bin', b, 'vrserver.exe')}" action=allow`).join('\r\n') + '\r\n');
    const ok = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${bat.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`], { timeout: 120000 }).then(() => true, () => false);
    this.savePrefs({ firewall: true, firewallOk: ok }); // ask once; the USB cable works either way
    if (!ok) progress('Firewall permission was skipped. The USB cable still works; Wi-Fi may not.');
  }

  async stopSteamvr() {
    try { await this.request('ShutdownSteamvr'); } catch {}
    for (let i = 0; i < 10 && await this.steamvrRunning(); i++) await sleep(1000);
    for (const exe of ['vrmonitor.exe', 'vrserver.exe', 'vrcompositor.exe', 'vrdashboard.exe', 'vrwebhelper.exe']) await run('taskkill.exe', ['/im', exe, '/f'], { timeout: 8000 }).catch(() => {});
  }

  async disconnect() {
    await this.setDesktopMode(false).catch(() => {});
    this.keepWatching(false);
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
    if (head.includes('"ServerRequestsSelfRestart"')) { this.restartSteamvr(); return; }
    if (head.includes('"Buttons"')) {
      if (text.includes('menu/click') || text.includes('thumbstick/click')) { try { this.onButtons(JSON.parse(text).event_type.data); } catch {} }
      return;
    }
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
    if (active && active.state === 'Streaming') {
      const via = active.wired ? 'cable' : 'wifi';
      if (this.prefs().lastVia !== via) { this.savePrefs({ lastVia: via }); this.applyAudio(via === 'cable').catch(() => {}); }
    }
    const fresh = live.stats && Date.now() - live.statsAt < 5000;
    const st = fresh && active && active.state === 'Streaming' ? live.stats : null;
    return {
      installed: !!this.driverDir(), steamvrInstalled: this.steamvrInstalled(), steamvr, server, busy: this.busy, restarting: !!this.restarting,
      desktopMode: steamvr ? await this.desktopModeActive() : false, passthrough: !!(this._passthrough && this.roomProc),
      state: this.restarting ? 'starting' : !steamvr ? 'off' : !server ? 'starting' : active ? active.state.toLowerCase() : 'waiting',
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
      const devices = (await this.listDevices(adb)).filter(d => d.usb)
        .sort((x, y) => (y.state === 'device') - (x.state === 'device') || isQuestModel(y.model) - isQuestModel(x.model));
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

      // No speed test: pushing lots of data down a shaky cable can upset Windows' USB driver.
      const mbps = null;

      const battery = await sh('dumpsys battery');
      const level = Number((battery.match(/level:\s*(\d+)/) || [])[1]) || null;
      const charging = /USB powered:\s*true|AC powered:\s*true/.test(battery);

      const linkName = { 'usb3+': 'USB 3 (10 Gbps)', usb3: 'USB 3 (5 Gbps)', usb2: 'USB 2 (480 Mbps)', usb1: 'USB 1 (12 Mbps)', unknown: 'Unknown' }[link];
      let verdict, title;
      const tips = [];
      if (link === 'usb2' || link === 'usb1') {
        verdict = 'slow'; title = 'Too slow for smooth streaming';
        tips.push('This is a USB 2 connection. Use a blue (USB 3) port on your PC, or one marked SS, and a USB 3 or Link cable. The Quest’s charging cable that came in the box is USB 2 on some models.');
        tips.push('It still works, but Cloud Desktop may look blurry or stutter in fast games. Wi-Fi 6 on a good router can be better.');
      } else if (link === 'unknown') {
        verdict = 'ok'; title = 'Connected (speed unknown)';
        tips.push('Your Quest didn’t say which USB type it’s using. If the picture stutters, try a USB 3 port on the back of the PC.');
      } else {
        verdict = 'great'; title = 'Great cable';
        tips.push('Plenty of speed for top quality.');
      }
      if (!charging) tips.push('Your headset isn’t charging from this port, so the battery will run down while you play. Some USB 3 ports give more power.');
      this.savePrefs({ lastCable: verdict });
      return { found: true, model: dev.model, link, linkName, mbps, battery: level, charging, verdict, title, tips };
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
      this.stopMenu();
      for (const exe of ['CloudDesktopTool.exe', 'CloudDesktopRoom.exe']) await run('taskkill.exe', ['/im', exe, '/f']).catch(() => {});
      if (await this.ping()) { progress('Closing SteamVR so the update can replace files…'); this.stopWatching(); await this.stopSteamvr(); }
      const keep = this.sessionFile() && fs.existsSync(this.sessionFile()) ? fs.readFileSync(this.sessionFile()) : null; // your headsets and settings
      const dpConfig = path.join(this.dir, 'pc', 'desktop-mode', 'config.ini');
      const newer = v => { const [a, b] = String(v || '0').split('.').map(Number); return a > 1 || (a === 1 && b >= 6); };
      const keepDp = newer(this.installedVersion()) && fs.existsSync(dpConfig) ? fs.readFileSync(dpConfig) : null; // your screen layout
      await run('taskkill.exe', ['/im', 'DesktopPlus.exe', '/f']).catch(() => {});
      await run('taskkill.exe', ['/im', 'DesktopPlusUI.exe', '/f']).catch(() => {});
      await this.unzip(zip, path.join(this.dir, 'pc'));
      if (keep && this.driverDir()) fs.writeFileSync(this.sessionFile(), keep);
      if (keepDp && fs.existsSync(path.dirname(dpConfig))) fs.writeFileSync(dpConfig, keepDp);
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
  roomPath() {
    const p = path.join(this.dir, 'pc', 'desktop-mode', 'room', 'CloudDesktopRoom.exe');
    return fs.existsSync(p) ? p : null;
  }
  toolPath() {
    const p = path.join(this.dir, 'pc', 'desktop-mode', 'room', 'CloudDesktopTool.exe');
    return fs.existsSync(p) ? p : null;
  }

  // ---------- the in-headset menu (CloudDesktopTool.exe menu) ----------

  startMenu() {
    if (this.menuProc || !this.toolPath()) return;
    const dir = path.join(path.dirname(this.toolPath()), 'menu');
    const proc = spawn(this.toolPath(), ['menu', dir], { cwd: path.dirname(this.toolPath()), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.menuProc = proc;
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); this.onMenuLine(line); }
    });
    proc.on('exit', () => { if (this.menuProc === proc) this.menuProc = null; });
    proc.on('error', () => { if (this.menuProc === proc) this.menuProc = null; });
  }
  stopMenu() {
    const proc = this.menuProc;
    this.menuProc = null;
    if (proc) { try { proc.stdin.write('quit\n'); } catch {} setTimeout(() => { try { proc.kill(); } catch {} }, 1500); }
  }
  menuSend(cmd) {
    if (!this.menuProc) return false;
    try { this.menuProc.stdin.write(cmd + '\n'); return true; } catch { return false; }
  }
  onMenuLine(line) {
    if (!line.startsWith('click ')) return;
    const code = line.slice(6);
    this.log && this.log('cloud desktop: menu', code);
    if (code === 'EXIT') this.setDesktopMode(false).catch(() => {});
    else if (code === 'ROOM') this.toggleRoomView().catch(() => {});
  }

  /** Room view (passthrough) on or off while in desktop mode, from the menu. */
  async toggleRoomView() {
    const on = !this.roomProc;
    this.savePrefs({ passthrough: on });
    if (on) await this.startRoom(); else await this.stopRoom();
  }

  async startRoom() {
    if (!this.roomPath() || this.roomProc) return;
    const room = spawn(this.roomPath(), [], { cwd: path.dirname(this.roomPath()), stdio: 'ignore', windowsHide: true });
    this.roomProc = room;
    room.on('exit', () => {
      if (this.roomProc !== room) return;
      this.roomProc = null;
      this.setPassthrough(false).catch(() => {}); // a game took over: no more see-through green
    });
    room.on('error', () => { if (this.roomProc === room) this.roomProc = null; });
    await this.setPassthrough(true).catch(e => this.log && this.log('cloud desktop: passthrough', e.message));
  }

  /** Put the desktop screens back in front of you. */
  recenter() {
    if (this.menuSend('recenter')) return true;
    if (!this.toolPath()) return false;
    spawn(this.toolPath(), ['recenter'], { cwd: path.dirname(this.toolPath()), stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return true;
  }

  /** Desktop mode: your Windows desktop in VR (Desktop+), with your real room around it (passthrough). */
  async desktopMode() { return this.setDesktopMode(true); }
  async toggleDesktopMode() { return this.setDesktopMode(!(await this.desktopModeActive(true))); }

  async desktopModeActive(fresh) {
    if (!fresh && this._dmAt && Date.now() - this._dmAt < 3000) return this._dm;
    this._dm = await this.processRunning('DesktopPlus.exe');
    this._dmAt = Date.now();
    return this._dm;
  }

  async setDesktopMode(on) {
    if (this._dmBusy) return this._dm;
    this._dmBusy = true;
    try {
      if (on) {
        const exe = this.desktopModePath();
        if (!exe) throw new Error('Install (or update) Cloud Desktop on this PC first. Desktop mode came in Cloud Desktop 1.1.');
        if (!(await this.ping())) await this.connect(); // the streamer, so the headset can connect
        // The green backdrop first (it's the SteamVR "app"), then the desktop screens on top.
        if (this.prefs().passthrough) await this.startRoom();
        const wasRunning = await this.desktopModeActive(true);
        if (!wasRunning) spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
        this.startMenu();
        if (!wasRunning) setTimeout(() => this.recenter(), 4000); // screens in front of wherever you're facing
        this._dm = true; this._dmAt = Date.now();
      } else {
        this.stopMenu();
        for (const name of ['DesktopPlus.exe', 'DesktopPlusUI.exe']) await run('taskkill.exe', ['/im', name, '/f'], { timeout: 8000 }).catch(() => {});
        await this.stopRoom();
        this._dm = false; this._dmAt = Date.now();
      }
      return this._dm;
    } finally { this._dmBusy = false; }
  }

  async stopRoom() {
    const room = this.roomProc;
    this.roomProc = null;
    if (room) { try { room.kill(); } catch {} }
    await run('taskkill.exe', ['/im', 'CloudDesktopRoom.exe', '/f'], { timeout: 8000 }).catch(() => {});
    await this.setPassthrough(false).catch(() => {});
  }

  // ---------- health check ----------

  /** Check the usual things that stop Cloud Desktop working. Each problem can carry a fix. */
  async health() {
    const out = [];
    const add = (id, ok, title, detail, fix) => out.push({ id, ok, title, detail, fix: ok ? null : fix || null });
    if (process.platform !== 'win32') { add('windows', false, 'Windows needed', 'Cloud Desktop runs on Windows PCs.'); return out; }

    const installed = !!this.driverDir();
    let latest = null;
    try { latest = await this.latest(); } catch {}
    add('installed', installed, installed ? 'Installed on this PC' : 'Not installed on this PC', installed ? '' : 'Install Cloud Desktop to start.', 'install');
    if (installed && latest && latest.version) {
      const cur = this.installedVersion();
      add('version', cur === latest.version, cur === latest.version ? `Up to date (${cur})` : `Update available: ${cur || '?'} → ${latest.version}`, cur === latest.version ? '' : 'Newer versions fix problems and add features.', 'install');
    }

    const steam = this.steamvrInstalled();
    add('steamvr', steam, steam ? 'SteamVR is set up' : 'SteamVR isn’t set up', steam ? '' : 'Install SteamVR from Steam and open it once. Cloud Desktop runs inside it.');

    if (steam && installed) {
      let drivers = [];
      try { drivers = JSON.parse(fs.readFileSync(this.openvrPathsFile(), 'utf8').replace(/^\uFEFF/, '')).external_drivers || []; } catch {}
      const mine = this.driverDir().toLowerCase();
      const registered = drivers.some(d => path.normalize(String(d)).toLowerCase() === path.normalize(mine));
      add('driver', registered, registered ? 'SteamVR knows about Cloud Desktop' : 'SteamVR doesn’t know about Cloud Desktop yet', registered ? '' : 'Connect does this for you, or fix it now.', 'driver');
      const others = drivers.filter(d => /alvr/i.test(path.basename(String(d))) || fs.existsSync(path.join(String(d), 'bin', 'win64', 'driver_alvr_server.dll')))
        .filter(d => path.normalize(String(d)).toLowerCase() !== path.normalize(mine));
      add('otheralvr', !others.length, others.length ? 'Another copy of ALVR is set up in SteamVR' : 'No other ALVR copies', others.length ? 'Two copies fight over the same network ports. Fix removes the other one from SteamVR (its files stay).' : '', 'driver');
      const vd = drivers.some(d => /virtual desktop/i.test(String(d)));
      if (vd) add('vd', true, 'Virtual Desktop is also installed', 'That’s fine. Just don’t run the Virtual Desktop Streamer and Cloud Desktop at the same time.');
    }

    if (installed) {
      const session = this.readSession();
      const wired = !!(session && session.client_connections && session.client_connections[WIRED]);
      add('wired', !session || wired, !session || wired ? 'USB cable ready' : 'USB cable isn’t set up', !session || wired ? '' : 'Older settings were missing the cable entry.', 'wired');
      const fw = await run('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', 'name=SteamVR ALVR vrserver'], { timeout: 15000 }).then(() => true, () => false);
      add('firewall', fw, fw ? 'Windows firewall lets Wi-Fi through' : 'Windows firewall may block Wi-Fi', fw ? '' : 'The USB cable works anyway. Fix asks Windows for permission once.', 'firewall');
      add('desktopmode', !!(this.desktopModePath() && this.roomPath() && this.toolPath()), this.desktopModePath() && this.toolPath() ? 'Desktop mode ready' : 'Desktop mode needs an update', '', 'install');
    }

    const p = this.prefs();
    if (p.mic) {
      const vb = await this.vbCableInstalled(true);
      add('mic', vb, vb ? 'Headset microphone ready (VB-Cable)' : 'Headset microphone needs VB-Cable', vb ? '' : 'A free virtual microphone Windows needs for your Quest’s mic.', 'vbcable');
    }
    return out;
  }

  /** Fix one health-check problem. */
  async fix(id, progress = () => {}) {
    if (id === 'install') return this.installPc(progress);
    if (id === 'driver') { const r = this.registerDriver(); progress(r.removedOthers ? 'Done. The other ALVR copy was removed from SteamVR. Restart SteamVR if it’s open.' : 'Done. Restart SteamVR if it’s open.'); return true; }
    if (id === 'wired') { this.ensureWiredInFile(); if (await this.ping()) await this.request({ UpdateClientList: { hostname: WIRED, action: { AddIfMissing: { trusted: true, manual_ips: [] } } } }).catch(() => {}); return true; }
    if (id === 'firewall') { this.savePrefs({ firewall: false }); await this.ensureFirewall(progress); return true; }
    if (id === 'vbcable') return this.installVbCable(progress);
    throw new Error('Nothing to fix for that.');
  }

  /** Turn the headset's green-to-room chroma key on or off (it changes live, no restart). */
  async setPassthrough(on) {
    this._passthrough = !!on;
    if (!(await this.ping())) return;
    const v = (keys, value) => ({ path: ['session_settings', 'video', 'passthrough', ...keys].map(k => ({ Name: k })), value });
    await this.request({ SetValues: [
      v(['content', 'variant'], 'RgbChromaKey'),
      v(['content', 'RgbChromaKey', 'red'], 0),
      v(['content', 'RgbChromaKey', 'green'], 255),
      v(['content', 'RgbChromaKey', 'blue'], 0),
      v(['content', 'RgbChromaKey', 'distance_threshold'], 85),
      v(['content', 'RgbChromaKey', 'feathering'], 0.05),
      v(['enabled'], !!on),
    ] });
  }

  /**
   * Left ☰: one press opens the Cloud Desktop menu (in desktop mode), two quick presses switch
   * desktop mode on or off. Clicking the right thumbstick recenters the screens.
   */
  onButtons(list) {
    if (!Array.isArray(list)) return;
    for (const b of list) {
      const down = b.value && b.value.Binary === true;
      if (!down) continue;
      if (/right\/input\/thumbstick\/click$/.test(b.path || '')) {
        if (this._dm) this.recenter();
        continue;
      }
      if (!/left\/input\/menu\/click$/.test(b.path || '')) continue;
      const now = Date.now();
      if (this._menuAt && now - this._menuAt < 450) {
        this._menuAt = 0;
        clearTimeout(this._menuTimer);
        if (!this.prefs().menuShortcut) continue;
        this.log && this.log('cloud desktop: menu double-press, toggling desktop mode');
        this.menuSend('hide');
        this.toggleDesktopMode().catch(e => this.log && this.log('cloud desktop: desktop mode', e.message));
      } else {
        this._menuAt = now;
        clearTimeout(this._menuTimer);
        this._menuTimer = setTimeout(() => { this._menuAt = 0; if (this._dm) this.menuSend('toggle'); }, 460);
      }
    }
  }


  async adb(progress) {
    // The streamer uses an adb on PATH first (SideQuest, Android Studio…). Two different adb
    // versions keep restarting each other's server and the cable connection, so use that one too.
    if (this._pathAdb === undefined) {
      this._pathAdb = null;
      try {
        const found = (await run('where.exe', ['adb'], { timeout: 8000 })).split(/\r?\n/).map(x => x.trim()).find(x => /adb\.exe$/i.test(x));
        if (found && fs.existsSync(found)) this._pathAdb = found;
      } catch {}
    }
    if (this._pathAdb) return this._pathAdb;
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
      const quest = await this.pickQuest(adb);
      const apk = path.join(this.dir, 'CloudDesktop-Quest.apk');
      await this.download(latest.questApk, apk, progress, 'Downloading the Quest app');
      progress('Installing on your Quest…');
      const out = await run(adb, ['-s', quest.serial, 'install', '-r', apk], { timeout: 300000 });
      if (!/Success/i.test(out)) throw new Error('The Quest said: ' + out.trim().slice(-300));
      progress(`Installed. On your Quest: App Library › Unknown Sources › Cloud Desktop.`);
      return true;
    });
  }

  async questInstalled() {
    const adb = path.join(this.dir, 'platform-tools', 'adb.exe');
    if (!fs.existsSync(adb)) return null;
    try {
      const quest = await this.pickQuest(adb);
      return (await run(adb, ['-s', quest.serial, 'shell', 'pm', 'list', 'packages', QUEST_APP_ID], { timeout: 8000 })).includes(QUEST_APP_ID);
    } catch { return null; }
  }

  /** Every Android device adb can see: { serial, state, model, usb }. */
  async listDevices(adb) {
    await run(adb, ['start-server'], { timeout: 20000 }).catch(() => {});
    return (await run(adb, ['devices', '-l'], { timeout: 10000 })).split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean)
      .map(l => { const [serial, state] = l.split(/\s+/); return { serial, state, usb: isUsbSerial(serial), model: ((l.match(/model:(\S+)/) || [])[1] || '').replace(/_/g, ' '), product: (l.match(/product:(\S+)/) || [])[1] || '' }; });
  }

  /**
   * The Quest on the USB cable. Other devices (a phone, BlueStacks, the Quest's own Wi-Fi
   * debugging) are ignored, so adb never says "more than one device".
   */
  async pickQuest(adb) {
    const all = await this.listDevices(adb);
    const usb = all.filter(d => d.usb);
    const score = d => (d.state === 'device' ? 4 : d.state === 'unauthorized' ? 2 : 0) + (isQuestModel(d.model) || isQuestModel(d.product) ? 1 : 0);
    const best = usb.sort((a, b) => score(b) - score(a))[0];
    if (!best) {
      const wifiQuest = all.find(d => !d.usb && d.state === 'device' && (isQuestModel(d.model) || isQuestModel(d.product)));
      if (wifiQuest) return wifiQuest; // the Quest over Wi-Fi debugging still works for installing
      throw new Error('No Quest found on the USB cable. Plug your Quest into this PC, make sure Developer Mode is on (Meta Horizon app on your phone › Devices › Headset settings › Developer Mode), then try again.');
    }
    if (best.state === 'unauthorized') throw new Error('Put your Quest on and choose “Allow” (tick “Always allow from this computer”) on the USB debugging message, then try again.');
    if (best.state !== 'device') throw new Error(`Your Quest is ${best.state}. Unplug the cable, plug it back in, and try again.`);
    return best;
  }

  // ---------- sound: headset mic (needs VB-Cable on Windows) and audio delay ----------

  prefsFile() { return path.join(this.dir, 'prefs.json'); }
  prefs() {
    if (!this._prefs) { try { this._prefs = JSON.parse(fs.readFileSync(this.prefsFile(), 'utf8')); } catch { this._prefs = {}; } }
    return { mic: true, lowDelay: true, autoQuality: true, passthrough: true, menuShortcut: true, autoUpdate: true, lastCable: null, lastVia: null, ...this._prefs };
  }
  savePrefs(change) {
    this._prefs = { ...this.prefs(), ...change };
    try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.prefsFile(), JSON.stringify(this._prefs, null, 2)); } catch {}
    return this._prefs;
  }

  /** Is VB-Cable (the free virtual microphone) installed? */
  async vbCableInstalled(fresh) {
    if (process.platform !== 'win32') return false;
    if (!fresh && this._vb && Date.now() - this._vb.at < 15000) return this._vb.ok;
    let ok = false;
    try {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_SoundDevice | ForEach-Object { $_.Name }'], { timeout: 15000 });
      ok = /VB-Audio Virtual Cable|CABLE Input/i.test(out);
    } catch {}
    this._vb = { ok, at: Date.now() };
    return ok;
  }

  async audioStatus() {
    const p = this.prefs();
    return { vbcable: await this.vbCableInstalled(), mic: p.mic, lowDelay: p.lowDelay, autoQuality: p.autoQuality, passthrough: p.passthrough, menuShortcut: p.menuShortcut, autoUpdate: p.autoUpdate, room: !!this.roomPath(), lastCable: p.lastCable, lastVia: p.lastVia, applied: this._audioApplied || null };
  }

  async setAudio(change) {
    const pick = {};
    for (const k of ['mic', 'lowDelay', 'autoQuality', 'passthrough', 'menuShortcut', 'autoUpdate']) if (change[k] !== undefined) pick[k] = !!change[k];
    this.savePrefs(pick);
    await this.applyAudio().catch(e => this.log && this.log('cloud desktop: settings', e.message));
    return await this.audioStatus();
  }

  /**
   * Put the sound settings into the streamer: mic on when wanted and VB-Cable is there, and a
   * smaller sound buffer (less delay) on a good USB cable. Wi-Fi keeps the safer buffer.
   */
  async applyAudio(onCable) {
    const p = this.prefs();
    // How the headset connected last time (no need to touch the USB cable to find out).
    if (onCable === undefined) onCable = p.lastVia === 'cable';
    const mic = p.mic && await this.vbCableInstalled();
    const buffer = p.lowDelay && onCable && p.lastCable !== 'slow' ? BUFFER_LOW : BUFFER_NORMAL;
    const values = [
      [['audio', 'microphone', 'enabled'], mic],
      [['audio', 'microphone', 'content', 'buffering', 'average_buffering_ms'], buffer],
      [['audio', 'game_audio', 'content', 'buffering', 'average_buffering_ms'], buffer],
    ];
    // Best picture automatically: HEVC (sharper than H.264 at the same speed) and a bitrate that
    // rises as high as the connection allows and backs off when Wi-Fi gets busy, instead of a fixed 30 Mbps.
    const maxMbps = onCable ? 400 : 200;
    values.push(
      [['extra', 'logging', 'log_button_presses'], true], // so CloudBrowser sees ☰ and the thumbstick click
      [['video', 'passthrough', 'enabled'], !!(this._passthrough && this.roomProc)],
    );
    if (p.autoQuality) {
      values.push(
        [['video', 'preferred_codec', 'variant'], 'Hevc'],
        [['video', 'bitrate', 'mode', 'variant'], 'Adaptive'],
        [['video', 'bitrate', 'mode', 'Adaptive', 'max_throughput_mbps', 'enabled'], true],
        [['video', 'bitrate', 'mode', 'Adaptive', 'max_throughput_mbps', 'content'], maxMbps],
        [['video', 'bitrate', 'mode', 'Adaptive', 'min_throughput_mbps', 'enabled'], true],
        [['video', 'bitrate', 'mode', 'Adaptive', 'min_throughput_mbps', 'content'], 20],
      );
    }
    this._audioApplied = { mic, buffer, onCable, quality: p.autoQuality ? { codec: 'HEVC', maxMbps } : null };
    if (await this.ping()) {
      await this.request({ SetValues: values.map(([keys, value]) => ({ path: ['session_settings', ...keys].map(k => ({ Name: k })), value })) });
      return this._audioApplied;
    }
    // Not running: change the saved settings file, which the streamer reads when it starts.
    const file = this.sessionFile();
    const session = file && this.readSession();
    if (!session) return this._audioApplied;
    for (const [keys, value] of values) {
      let o = session.session_settings;
      for (const k of keys.slice(0, -1)) { if (!o || typeof o !== 'object') { o = null; break; } o = o[k]; }
      if (o && typeof o === 'object' && keys[keys.length - 1] in o) o[keys[keys.length - 1]] = value;
    }
    fs.writeFileSync(file + '.tmp', JSON.stringify(session, null, 2));
    fs.renameSync(file + '.tmp', file);
    return this._audioApplied;
  }

  /** Download VB-Cable from its maker and open its installer (it asks for admin, then a restart). */
  installVbCable(progress = () => {}) {
    return this.guard(async () => {
      if (process.platform !== 'win32') throw new Error('VB-Cable is for Windows.');
      fs.mkdirSync(this.dir, { recursive: true });
      const zip = path.join(this.dir, 'vbcable.zip');
      let lastErr = null;
      for (const url of VBCABLE_ZIPS) {
        try { await this.download(url, zip, progress, 'Downloading VB-Cable'); lastErr = null; break; } catch (e) { lastErr = e; }
      }
      if (lastErr) throw new Error('Couldn’t download VB-Cable. Get it from vb-audio.com/Cable instead.');
      const dir = path.join(this.dir, 'vbcable');
      await this.unzip(zip, dir);
      fs.rmSync(zip, { force: true });
      const want = process.arch === 'arm64' ? /^VBCABLE_Setup_(arm64|ARM64)\.exe$/ : /^VBCABLE_Setup_x64\.exe$/i;
      const files = fs.readdirSync(dir, { recursive: true }).map(String);
      const setup = files.find(f => want.test(path.basename(f))) || files.find(f => /setup.*\.exe$/i.test(f));
      if (!setup) throw new Error('VB-Cable’s installer wasn’t in the download. Get it from vb-audio.com/Cable instead.');
      progress('Opening the VB-Cable installer… Click Yes, then “Install Driver”, then restart your PC.');
      const exe = path.join(dir, setup).replace(/'/g, "''");
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${exe}' -WorkingDirectory '${path.dirname(exe)}' -Verb RunAs`], { timeout: 60000 })
        .catch(() => { throw new Error('The VB-Cable installer needs admin permission. Try again and click Yes.'); });
      this._vb = null;
      return true;
    });
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
