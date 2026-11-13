// Cloud Desktop: CloudBrowser's own wireless PC-to-Quest streamer (built from ALVR, see cloud-desktop/).
// This installs and starts it from CloudBrowser: the PC streamer into %LOCALAPPDATA%\CloudDesktop,
// and the Quest app over USB with Google's adb tool (downloaded the first time it's needed).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'DaCloudi/CloudBrowser';
const PLATFORM_TOOLS = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const QUEST_APP_ID = 'com.cloudbrowser.desktop';

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
    // The streamer folder inside the zip is "alvr_streamer_windows".
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
      installed: !!this.exePath(), installedVersion: this.installedVersion(), desktopMode: !!this.desktopModePath(),
      latest: latest && latest.version, available: !!(latest && latest.pcZip && latest.questApk), page: latest && latest.page,
      running: await this.isRunning(), error,
    };
  }

  async isRunning() {
    if (process.platform !== 'win32') return false;
    try { return /ALVR Dashboard\.exe/i.test(await run('tasklist.exe', ['/fo', 'csv', '/nh', '/fi', 'IMAGENAME eq ALVR Dashboard.exe'])); } catch { return false; }
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
      await run('taskkill.exe', ['/im', 'DesktopPlus.exe', '/f']).catch(() => {});
      await run('taskkill.exe', ['/im', 'DesktopPlusUI.exe', '/f']).catch(() => {});
      await this.unzip(zip, path.join(this.dir, 'pc'));
      fs.writeFileSync(path.join(this.dir, 'pc', 'VERSION'), latest.version);
      fs.rmSync(zip, { force: true });
      progress(`Cloud Desktop ${latest.version} is installed on your PC.`);
      return true;
    });
  }

  start() {
    const exe = this.exePath();
    if (!exe) throw new Error('Install Cloud Desktop on your PC first.');
    spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  }

  /** Desktop mode: your Windows desktop in VR (Desktop+). It starts SteamVR itself if needed. */
  async desktopMode() {
    const exe = this.desktopModePath();
    if (!exe) throw new Error('Install (or update) Cloud Desktop on this PC first. Desktop mode came in Cloud Desktop 1.1.');
    if (!(await this.isRunning())) this.start(); // the streamer, so the headset can connect
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

module.exports = { CloudDesktop };
