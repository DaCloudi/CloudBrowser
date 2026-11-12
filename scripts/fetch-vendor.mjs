// Downloads the programs CloudBrowser's VPN uses into ./vendor (bundled with the app):
//   vendor/tor/        Tor (from the official Tor Expert Bundle) + geoip files
//   vendor/wireproxy/  wireproxy.exe (userspace WireGuard client exposing a SOCKS5 proxy)
// Run on Windows: node scripts/fetch-vendor.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const vendor = path.join(root, 'vendor');
const headers = { 'user-agent': 'CloudBrowser-build' };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': 'CloudBrowser-build' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log('downloaded', url, fs.statSync(file).size, 'bytes');
}

function extract(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // Use Windows' own tar (bsdtar); Git's GNU tar misreads "C:\..." paths.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', dest], { stdio: 'inherit' });
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

async function tor() {
  const out = path.join(vendor, 'tor');
  if (fs.existsSync(path.join(out, 'tor.exe'))) { console.log('tor already present'); return; }
  const listing = await (await fetch('https://dist.torproject.org/torbrowser/', { headers })).text();
  const versions = [...new Set([...listing.matchAll(/href="(\d+\.\d+(?:\.\d+)*)\/"/g)].map(m => m[1]))]
    .sort((a, b) => b.split('.').map(Number).reduce((r, n, i) => r || n - (a.split('.').map(Number)[i] || 0), 0));
  let file = null, version = null;
  for (const v of versions) {
    const url = `https://dist.torproject.org/torbrowser/${v}/tor-expert-bundle-windows-x86_64-${v}.tar.gz`;
    const head = await fetch(url, { method: 'HEAD', headers });
    if (head.ok) { file = url; version = v; break; }
  }
  if (!file) throw new Error('Could not find a Tor Expert Bundle for Windows');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-'));
  const archive = path.join(tmp, 'tor.tar.gz');
  await download(file, archive);
  extract(archive, path.join(tmp, 'x'));
  const exe = findFile(path.join(tmp, 'x'), 'tor.exe');
  if (!exe) throw new Error('tor.exe not found in bundle');
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(path.dirname(exe))) {
    const src = path.join(path.dirname(exe), f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(out, f));
  }
  for (const g of ['geoip', 'geoip6']) {
    const p = findFile(path.join(tmp, 'x'), g);
    if (p) fs.copyFileSync(p, path.join(out, g));
  }
  fs.writeFileSync(path.join(out, 'VERSION'), `Tor Expert Bundle ${version}\n${file}\n`);
  console.log('Tor', version, '->', fs.readdirSync(out).join(', '));
}

async function wireproxy() {
  const out = path.join(vendor, 'wireproxy');
  if (fs.existsSync(path.join(out, 'wireproxy.exe'))) { console.log('wireproxy already present'); return; }
  let release = null;
  for (const repo of ['windtf/wireproxy', 'whyvl/wireproxy', 'pufferffish/wireproxy']) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    if (res.ok) { release = await res.json(); release.repo = repo; break; }
  }
  if (!release) throw new Error('Could not find a wireproxy release');
  const asset = release.assets.find(a => /windows_amd64\.(tar\.gz|zip)$/.test(a.name));
  if (!asset) throw new Error('No Windows build in wireproxy ' + release.tag_name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-'));
  const archive = path.join(tmp, asset.name);
  await download(asset.browser_download_url, archive);
  extract(archive, path.join(tmp, 'x'));
  const exe = findFile(path.join(tmp, 'x'), 'wireproxy.exe');
  if (!exe) throw new Error('wireproxy.exe not found');
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(exe, path.join(out, 'wireproxy.exe'));
  fs.writeFileSync(path.join(out, 'VERSION'), `${release.repo} ${release.tag_name}\n`);
  console.log('wireproxy', release.repo, release.tag_name);
}

await tor();
await wireproxy();
