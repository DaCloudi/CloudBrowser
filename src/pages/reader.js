'use strict';
const $ = id => document.getElementById(id);
const prefs = (() => { try { return JSON.parse(localStorage.getItem('reader') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('reader', JSON.stringify(prefs)); } catch {} };

function applyPrefs() {
  document.body.classList.remove('light', 'sepia', 'dark');
  const theme = prefs.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.body.classList.add(theme);
  document.body.classList.toggle('sans', !!prefs.sans);
  document.documentElement.style.setProperty('--size', (prefs.size || 20) + 'px');
  for (const b of document.querySelectorAll('[data-theme]')) b.classList.toggle('sel', b.dataset.theme === theme);
  $('font').textContent = prefs.sans ? 'Sans' : 'Serif';
}

// Keep only harmless markup from the extracted article.
function clean(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, link, meta').forEach(e => e.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n === 'style' || ((n === 'href' || n === 'src') && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
  }
  return doc.body.innerHTML;
}

async function load() {
  const id = new URLSearchParams(location.search).get('id');
  const a = await cloud.call('reader-article', id);
  if (!a) { $('missing').hidden = false; $('original').onclick = e => { e.preventDefault(); history.back(); }; return; }
  document.title = a.title;
  $('site').textContent = a.siteName || new URL(a.url).host.replace(/^www\./, '');
  $('title').textContent = a.title;
  const words = Math.round((a.length || 0) / 5.5);
  const mins = Math.max(1, Math.round(words / 230));
  $('meta').textContent = [a.byline, `${mins} min read`].filter(Boolean).join(' · ');
  $('content').innerHTML = clean(a.content);
  $('original').href = a.url;
}

$('bigger').onclick = () => { prefs.size = Math.min(30, (prefs.size || 20) + 2); save(); applyPrefs(); };
$('smaller').onclick = () => { prefs.size = Math.max(14, (prefs.size || 20) - 2); save(); applyPrefs(); };
$('font').onclick = () => { prefs.sans = !prefs.sans; save(); applyPrefs(); };
for (const b of document.querySelectorAll('[data-theme]')) b.onclick = () => { prefs.theme = b.dataset.theme; save(); applyPrefs(); };
applyPrefs();
load();
