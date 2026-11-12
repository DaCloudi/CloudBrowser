// CI-only: does real Google Chrome on this machine get past Google's sign-in check?
// (Tells us whether a refusal is about the browser or about the test machine's network.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));
if (!chrome) { console.log('[BASELINE] Chrome not installed'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
const proc = spawn(chrome, ['--remote-debugging-port=9333', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank']);
const wait = ms => new Promise(r => setTimeout(r, ms));
let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await wait(1000);
  try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); } catch {}
}
if (!targets) { console.log('[BASELINE] Chrome did not start'); proc.kill(); process.exit(0); }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
await send('Page.navigate', { url: 'https://accounts.google.com/ServiceLogin?hl=en&continue=https://www.youtube.com/' });
await wait(6000);
console.log('[BASELINE-FP] ' + await evalJs(fs.readFileSync(new URL('./fingerprint.js', import.meta.url), 'utf8')));
await evalJs(`document.querySelector('#identifierId') && document.querySelector('#identifierId').focus()`);
await send('Input.insertText', { text: 'cloudbrowser.signin.test.4821@gmail.com' });
await wait(800);
await evalJs(`(document.querySelector('#identifierNext button') || document.querySelector('#identifierNext')).click()`);
await wait(7000);
const text = await evalJs('document.body.innerText.slice(0, 300)');
const url = await evalJs('location.href');
console.log('[BASELINE] real Chrome after entering email:', url.slice(0, 90), '|', JSON.stringify(text));
console.log('[BASELINE] real Chrome blocked as insecure?', /may not be secure|Couldn.t sign you in/i.test(text));
proc.kill();
process.exit(0);
