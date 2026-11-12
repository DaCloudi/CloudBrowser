// CloudBrowser VPN
//
// Routes browsing through a local SOCKS5 proxy provided by one of:
//   - Tor (bundled tor.exe), optionally pinned to an exit country
//   - WireGuard (bundled wireproxy.exe) using a config file from the user's VPN provider,
//     e.g. a free Proton VPN WireGuard config
//
// Two independent switches decide which windows go through it:
//   - "VPN on" (settings.vpnEnabled): every window, plus CloudBrowser's own background traffic
//   - "Incognito through the VPN" (settings.incognitoVpn): incognito windows only
//
// Kill switch: whenever a window is meant to use the VPN, its traffic is pointed at the
// local proxy *before* anything loads. If the VPN isn't connected (yet, or any more),
// pages simply don't load - nothing ever falls back to your normal connection.
// DNS goes through the VPN too (SOCKS5 with remote name resolution), and WebRTC is
// limited so it can't reveal your real IP address.
'use strict';

const { app, session, webContents } = require('electron');
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
  constructor({ settings, normalPartition, privatePartition, log, onChange }) {
    this.settings = settings;
    this.normalPartition = normalPartition;
    this.privatePartition = privatePartition;
    this.log = log || console.log;
    this.onChange = onChange || (() => {});
    this.proc = null;
    this.state = { status: 'off', progress: 0, ip: null, location: null, error: null };
    this.generation = 0;
    this.incognitoOpen = false;
    this.retries = 0;
    this.proxied = { normal: false, private: false };
  }

  vendorDir(name) {
    const base = app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, '..', 'vendor');
    return path.join(base, name);
  }

  get mode() { return this.settings.data.vpnMode === 'wireguard' ? 'wireguard' : 'tor'; }
  get port() { return this.mode === 'tor' ? TOR_PORT : WG_PORT; }
  get wgConfigPath() { return path.join(app.getPath('userData'), 'wireguard.conf'); }

  // Which windows should go through the VPN right now?
  wanted() {
    const all = !!this.settings.data.vpnEnabled;
    return { normal: all, private: all || (!!this.settings.data.incognitoVpn && this.incognitoOpen) };
  }

  info() {
    const want = this.wanted();
    return {
      ...this.state,
      enabled: !!this.settings.data.vpnEnabled,
      incognitoVpn: !!this.settings.data.incognitoVpn,
      scope: want.normal ? 'all' : want.private ? 'incognito' : 'none',
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

  // Apply the kill switch for whatever is wanted. Await this before any window loads.
  async applyKillSwitch() { await this.applyProxy(this.wanted()); }

  async setEnabled(on) {
    this.settings.data.vpnEnabled = !!on;
    this.settings.save();
    await this.ensure();
  }

  async setIncognitoVpn(on) {
    this.settings.data.incognitoVpn = !!on;
    this.settings.save();
    await this.ensure();
  }

  async setIncognitoOpen(open) {
    if (this.incognitoOpen === open) return;
    this.incognitoOpen = open;
    await this.ensure();
  }

  // Start/stop the tunnel and point each kind of window at the right place.
  async ensure({ restart = false } = {}) {
    const want = this.wanted();
    if (!want.normal && !want.private) {
      this.generation++;
      this.stopProcess();
      await this.applyProxy(want);
      this.set({ status: 'off', progress: 0, ip: null, location: null, error: null });
      return;
    }
    await this.applyProxy(want); // kill switch first
    if (restart || !this.proc || this.state.status === 'off' || this.state.status === 'error') {
      this.retries = 0;
      this.connect();
    } else {
      this.onChange(this.info());
    }
  }

  // Country / mode changed, or "New IP": reconnect if the VPN is in use.
  async restart() { const w = this.wanted(); if (w.normal || w.private) await this.ensure({ restart: true }); else this.onChange(this.info()); }

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

  // WebRTC can reveal IP addresses. Through the VPN: only proxied traffic. Otherwise: hide local IPs.
  protectContents(wc, isPrivate) {
    const proxied = isPrivate ? this.proxied.private : this.proxied.normal;
    try { wc.setWebRTCIPHandlingPolicy(proxied ? 'disable_non_proxied_udp' : 'default_public_interface_only'); } catch {}
  }

  // ----- internals -----

  async connect() {
    const gen = ++this.generation;
    this.stopProcess();
    this.set({ status: 'connecting', progress: 0, ip: null, location: null, error: null });
    try {
      if (this.mode === 'tor') await this.startTor(gen);
      else await this.startWireGuard(gen);
      if (gen !== this.generation) return;
      this.set({ progress: 100 });
      await this.verify(gen);
      this.retries = 0;
    } catch (e) {
      if (gen !== this.generation) return;
      this.log('VPN failed:', e && e.message || e);
      this.set({ status: 'error', error: String(e && e.message || e) });
      this.scheduleRetry(gen);
    }
  }

  // The tunnel dropped or failed: the kill switch keeps pages blocked; try again a few times.
  scheduleRetry(gen) {
    const want = this.wanted();
    if ((!want.normal && !want.private) || this.retries >= 5) return;
    this.retries++;
    setTimeout(() => {
      if (gen === this.generation) { this.log('VPN reconnecting, attempt', this.retries); this.connect(); }
    }, 3000 * this.retries);
  }

  async applyProxy(want) {
    const proxy = { proxyRules: `socks5://127.0.0.1:${this.port}`, proxyBypassRules: '<-loopback>' };
    const direct = { mode: 'direct' };
    const targets = [
      [session.fromPartition(this.normalPartition), want.normal],
      [session.defaultSession, want.normal], // CloudBrowser's own traffic (updates, ad-block lists)
      [session.fromPartition(this.privatePartition), want.private],
    ];
    for (const [s, on] of targets) {
      await s.setProxy(on ? proxy : direct);
      await s.closeAllConnections().catch(() => {});
    }
    this.proxied = { normal: want.normal, private: want.private };
    const priv = session.fromPartition(this.privatePartition);
    for (const wc of webContents.getAllWebContents()) this.protectContents(wc, wc.session === priv);
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
    // Quote paths (user folders can contain spaces); forward slashes avoid torrc escape rules.
    const q = (p) => `"${p.replace(/\\/g, '/')}"`;
    const torrc = [
      `SocksPort 127.0.0.1:${TOR_PORT}`,
      `DataDirectory ${q(data)}`,
      `GeoIPFile ${q(path.join(dir, 'geoip'))}`,
      `GeoIPv6File ${q(path.join(dir, 'geoip6'))}`,
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
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('Tor took too long to connect. Check your internet connection.')); } }, 240000);
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
        if (!done) { done = true; clearTimeout(timer); reject(new Error(`Tor stopped (code ${code}).`)); return; }
        if (gen === this.generation) {
          this.set({ status: 'error', error: 'The connection dropped. Pages are blocked until it reconnects.' });
          this.scheduleRetry(gen);
        }
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
      let started = false;
      const keep = (b) => { out = (out + String(b)).slice(-2000); };
      proc.stdout.on('data', keep);
      proc.stderr.on('data', keep);
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (this.proc === proc) this.proc = null;
        const why = (out.trim().split('\n').pop() || '').slice(0, 200);
        if (!started) { reject(new Error(`WireGuard stopped (code ${code}). ${why}`)); return; }
        if (gen === this.generation) {
          this.set({ status: 'error', error: 'The connection dropped. Pages are blocked until it reconnects.' });
          this.scheduleRetry(gen);
        }
      });
      // wireproxy has no "connected" message; give it a moment, then verify() tests the tunnel.
      setTimeout(() => { if (this.proc === proc) { started = true; resolve(); } }, 1500);
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
    const chosen = this.mode === 'tor' && (this.settings.data.vpnCountry || 'auto') !== 'auto'
      ? (COUNTRIES.find(([id]) => id === this.settings.data.vpnCountry) || [])[1] : null;
    this.set({ status: 'on', ip, location: chosen, error: null });
    this.log('VPN on:', this.mode, ip, chosen || '');
    if (chosen) return; // Tor enforces the chosen exit country itself
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
