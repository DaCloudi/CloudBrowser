// CloudBrowser VPN
//
// Routes every tab (normal and incognito) through a local SOCKS5 proxy provided by one of:
//   - Tor (bundled tor.exe), optionally pinned to an exit country
//   - WireGuard (bundled wireproxy.exe) using a config file from the user's VPN provider,
//     e.g. a free Proton VPN WireGuard config
//
// While the VPN is switched on but not yet connected, pages can't load (the proxy isn't
// answering), so nothing leaks out over the normal connection ("kill switch").
'use strict';

const { app, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOR_PORT = 19050;
const WG_PORT = 19051;

const COUNTRIES = [
  ['auto', 'Fastest available'], ['gb', 'United Kingdom'], ['us', 'United States'], ['de', 'Germany'],
  ['nl', 'Netherlands'], ['fr', 'France'], ['se', 'Sweden'], ['ch', 'Switzerland'], ['ca', 'Canada'],
  ['fi', 'Finland'], ['no', 'Norway'], ['ro', 'Romania'], ['at', 'Austria'], ['jp', 'Japan'],
];

class Vpn {
  constructor({ settings, partitions, log, onChange }) {
    this.settings = settings;
    this.partitions = partitions;
    this.log = log || console.log;
    this.onChange = onChange || (() => {});
    this.proc = null;
    this.state = { status: 'off', progress: 0, ip: null, location: null, error: null };
    this.generation = 0;
  }

  vendorDir(name) {
    const base = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, '..', 'vendor');
    return path.join(base, name);
  }

  get mode() { return this.settings.data.vpnMode === 'wireguard' ? 'wireguard' : 'tor'; }
  get port() { return this.mode === 'tor' ? TOR_PORT : WG_PORT; }
  get wgConfigPath() { return path.join(app.getPath('userData'), 'wireguard.conf'); }

  info() {
    return {
      ...this.state,
      enabled: !!this.settings.data.vpnEnabled,
      mode: this.mode,
      country: this.settings.data.vpnCountry || 'auto',
      countries: COUNTRIES,
      wgConfigName: this.settings.data.vpnWgConfigName || null,
      torAvailable: fs.existsSync(path.join(this.vendorDir('tor'), 'tor.exe')),
      wgAvailable: fs.existsSync(path.join(this.vendorDir('wireproxy'), 'wireproxy.exe')),
    };
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.info());
  }

  // ----- public -----

  async start() {
    const gen = ++this.generation;
    this.stopProcess();
    this.settings.data.vpnEnabled = true;
    this.settings.save();
    this.set({ status: 'connecting', progress: 0, ip: null, location: null, error: null });
    await this.applyProxy(true); // kill switch: traffic goes to the (not yet running) proxy
    try {
      if (this.mode === 'tor') await this.startTor(gen);
      else await this.startWireGuard(gen);
      if (gen !== this.generation) return;
      this.set({ progress: 100 });
      await this.verify(gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.log('VPN failed:', e && e.message || e);
      this.set({ status: 'error', error: String(e && e.message || e) });
    }
  }

  async stop() {
    this.generation++;
    this.settings.data.vpnEnabled = false;
    this.settings.save();
    this.stopProcess();
    await this.applyProxy(false);
    this.set({ status: 'off', progress: 0, ip: null, location: null, error: null });
  }

  async restartIfOn() { if (this.settings.data.vpnEnabled) await this.start(); }

  shutdown() { this.generation++; this.stopProcess(); }

  importWireGuardConfig(file) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/\[Interface\]/i.test(text) || !/\[Peer\]/i.test(text) || !/PrivateKey\s*=/.test(text)) {
      throw new Error('That doesn’t look like a WireGuard config file.');
    }
    fs.writeFileSync(this.wgConfigPath, text, { mode: 0o600 });
    this.settings.data.vpnWgConfigName = path.basename(file);
    this.settings.data.vpnMode = 'wireguard';
    this.settings.save();
    this.onChange(this.info());
  }

  // Apply to any new tab: stop WebRTC from revealing the real IP while the VPN is on.
  protectContents(wc) {
    try { wc.setWebRTCIPHandlingPolicy(this.settings.data.vpnEnabled ? 'disable_non_proxied_udp' : 'default'); } catch {}
  }

  // ----- internals -----

  async applyProxy(on) {
    for (const p of this.partitions) {
      const s = session.fromPartition(p);
      if (on) await s.setProxy({ proxyRules: `socks5://127.0.0.1:${this.port}`, proxyBypassRules: '<-loopback>' });
      else await s.setProxy({ mode: 'direct' });
      await s.closeAllConnections().catch(() => {});
    }
    const { webContents } = require('electron');
    for (const wc of webContents.getAllWebContents()) this.protectContents(wc);
  }

  stopProcess() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  startTor(gen) {
    const dir = this.vendorDir('tor');
    const exe = path.join(dir, 'tor.exe');
    if (!fs.existsSync(exe)) return Promise.reject(new Error('Tor isn’t included in this build.'));
    const data = path.join(app.getPath('userData'), 'tor-data');
    fs.mkdirSync(data, { recursive: true });
    const country = this.settings.data.vpnCountry || 'auto';
    const torrc = [
      `SocksPort 127.0.0.1:${TOR_PORT}`,
      `DataDirectory ${data}`,
      `GeoIPFile ${path.join(dir, 'geoip')}`,
      `GeoIPv6File ${path.join(dir, 'geoip6')}`,
      'ClientOnly 1',
      'AvoidDiskWrites 1',
      'Log notice stdout',
      ...(country !== 'auto' ? [`ExitNodes {${country}}`, 'StrictNodes 1'] : []),
    ].join('\n');
    const rc = path.join(data, 'torrc');
    fs.writeFileSync(rc, torrc);

    return new Promise((resolve, reject) => {
      const proc = spawn(exe, ['-f', rc], { cwd: dir, windowsHide: true });
      this.proc = proc;
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('Tor took too long to connect. Check your internet connection.')); } }, 120000);
      const onData = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          const m = /Bootstrapped (\d+)%/.exec(line);
          if (m && gen === this.generation) {
            this.set({ progress: Math.min(99, Number(m[1])) });
            if (m[1] === '100' && !done) { done = true; clearTimeout(timer); resolve(); }
          }
          if (/\[err\]/.test(line)) this.log('tor:', line);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (code) => {
        if (this.proc === proc) this.proc = null;
        if (!done) { done = true; clearTimeout(timer); reject(new Error(`Tor stopped (code ${code}).`)); }
        else if (gen === this.generation && this.settings.data.vpnEnabled) this.set({ status: 'error', error: 'Tor stopped unexpectedly.' });
      });
      proc.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    });
  }

  startWireGuard(gen) {
    const exe = path.join(this.vendorDir('wireproxy'), 'wireproxy.exe');
    if (!fs.existsSync(exe)) return Promise.reject(new Error('WireGuard support isn’t included in this build.'));
    if (!fs.existsSync(this.wgConfigPath)) return Promise.reject(new Error('Import a WireGuard config file first.'));
    const cfg = path.join(app.getPath('userData'), 'wireproxy.conf');
    fs.writeFileSync(cfg, `WGConfig = ${this.wgConfigPath}\n\n[Socks5]\nBindAddress = 127.0.0.1:${WG_PORT}\n`, { mode: 0o600 });
    return new Promise((resolve, reject) => {
      const proc = spawn(exe, ['-c', cfg], { windowsHide: true });
      this.proc = proc;
      let out = '';
      const keep = (b) => { out = (out + String(b)).slice(-2000); };
      proc.stdout.on('data', keep);
      proc.stderr.on('data', keep);
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (this.proc === proc) this.proc = null;
        if (gen === this.generation && this.settings.data.vpnEnabled) {
          const why = (out.trim().split('\n').pop() || '').slice(0, 200);
          this.set({ status: 'error', error: `WireGuard stopped (code ${code}). ${why}` });
        }
        reject(new Error(`WireGuard stopped (code ${code}). ${(out.trim().split('\n').pop() || '').slice(0, 200)}`));
      });
      // wireproxy has no "connected" message; give it a moment, then verify() tests the tunnel.
      setTimeout(() => { if (this.proc === proc) resolve(); }, 1500);
    });
  }

  // Ask the internet what our address is, through the VPN (using a session that goes via the proxy).
  async verify(gen) {
    const s = session.fromPartition('cloudbrowser-vpn-check');
    await s.setProxy({ proxyRules: `socks5://127.0.0.1:${this.port}` });
    await s.closeAllConnections().catch(() => {});
    const get = async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 25000);
      try {
        const res = await s.fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } finally { clearTimeout(t); }
    };
    let ip = null, lastErr = null;
    for (let attempt = 0; attempt < 4 && !ip; attempt++) {
      if (gen !== this.generation) return;
      try {
        if (this.mode === 'tor') {
          const j = await get('https://check.torproject.org/api/ip');
          if (!j.IsTor) throw new Error('traffic is not going through Tor');
          ip = j.IP;
        } else {
          ip = (await get('https://api.ipify.org?format=json')).ip;
        }
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 2500)); }
    }
    if (gen !== this.generation) return;
    if (!ip) throw new Error('Connected, but no traffic gets through' + (lastErr ? ` (${lastErr.message})` : '') + '.');
    this.set({ status: 'on', ip, location: null, error: null });
    this.log('VPN on:', this.mode, ip);
    // Where are we? (best effort; some lookup services refuse Tor)
    for (const url of ['https://ipwho.is/', 'https://ipapi.co/json/']) {
      try {
        const j = await get(url);
        const country = j.success === false ? null : (j.country_name || (j.country && j.country.length > 3 ? j.country : null));
        if (country && gen === this.generation) { this.set({ location: country }); this.log('VPN location:', country); }
        if (country) break;
      } catch {}
    }
  }
}

module.exports = { Vpn, COUNTRIES };
