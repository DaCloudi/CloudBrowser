'use strict';
const $ = id => document.getElementById(id);
const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function tile(site) {
  const a = document.createElement('a');
  a.className = 'site';
  a.href = site.url;
  a.title = site.url;

  const ico = document.createElement('div');
  ico.className = 'ico';
  const img = document.createElement('img');
  img.alt = '';
  img.src = `https://icons.duckduckgo.com/ip3/${site.host}.ico`;
  img.onerror = () => {
    const s = document.createElement('span');
    s.textContent = (site.title || site.host).trim().charAt(0).toUpperCase();
    img.replaceWith(s);
  };
  ico.append(img);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = site.title;

  const x = document.createElement('button');
  x.className = 'x';
  x.title = 'Don’t show this site';
  x.innerHTML = CLOSE;
  x.onclick = async e => {
    e.preventDefault();
    e.stopPropagation();
    renderSites(await cloud.call('hide-site', site.host));
    $('restore').hidden = false;
  };

  a.append(ico, name, x);
  return a;
}

function renderSites(sites) {
  $('sites').replaceChildren(...sites.map(tile));
}

async function init() {
  const info = await cloud.call('newtab');
  document.body.classList.toggle('incognito', info.incognito);
  document.title = info.incognito ? 'New incognito tab' : 'New tab';
  $('q').placeholder = `Search ${info.engineName} or type a web address`;

  if (info.incognito) {
    $('greeting').textContent = 'Incognito';
    $('sites').hidden = true;
    $('incognito-info').hidden = false;
  } else {
    $('greeting').textContent = greeting();
    renderSites(info.sites);
    if (info.adblock && info.blockedTotal > 0) {
      $('stat').textContent = `🛡 ${info.blockedTotal.toLocaleString()} ads and trackers blocked so far`;
    }
  }
}

$('search').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (q) cloud.call('go', q);
});
$('restore').addEventListener('click', async e => {
  e.preventDefault();
  renderSites(await cloud.call('restore-sites'));
  $('restore').hidden = true;
});

init();
