'use strict';
let range = 7;

function fmt(n) { return Number(n || 0).toLocaleString(); }
function toast(text) {
  const t = h('div', { className: 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function render(r) {
  $('total').textContent = fmt(r.total);
  $('totalLabel').textContent = `trackers and ads blocked in the last ${range} days`;
  $('allTime').textContent = `${fmt(r.allTime)} blocked since you started using CloudBrowser`;

  const max = Math.max(1, ...r.days.map(d => d.total));
  const todayKey = r.days[r.days.length - 1].date;
  $('chart').replaceChildren(...r.days.map(d => {
    const date = new Date(d.date + 'T12:00:00');
    const label = range === 7 ? date.toLocaleDateString(undefined, { weekday: 'short' }) : (date.getDate() % 5 === 1 ? String(date.getDate()) : '');
    return h('div', { className: 'bar' + (d.date === todayKey ? ' today' : ''), title: `${date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}: ${fmt(d.total)} blocked` },
      h('i', { style: `height:${Math.round((d.total / max) * 100)}%` }), h('span', {}, label));
  }));

  const cmax = Math.max(1, ...r.companies.map(c => c.count));
  $('companies').replaceChildren(...(r.companies.length ? r.companies.map(c => h('div', { className: 'row' },
    h('div', { className: 'name' }, h('b', {}, c.name), h('small', {}, c.known ? c.domains.join(', ') : 'tracker or ad server')),
    h('div', { className: 'meter' }, h('i', { style: `width:${Math.round((c.count / cmax) * 100)}%` })),
    h('div', { className: 'num' }, fmt(c.count)))) : [h('div', { className: 'empty-row' }, 'Nothing blocked yet. Browse a little and check back.')]));

  const smax = Math.max(1, ...r.sites.map(s => s.count));
  $('sites').replaceChildren(...(r.sites.length ? r.sites.map(s => h('div', { className: 'row' },
    h('div', { className: 'name' }, h('b', {}, s.host), h('small', {}, s.allowed ? 'Ads allowed on this site' : '')),
    h('div', { className: 'meter' }, h('i', { style: `width:${Math.round((s.count / smax) * 100)}%` })),
    h('div', { className: 'num' }, fmt(s.count)),
    h('div', { className: 'acts' }, h('button', {
      className: 'btn small', title: `Delete ${s.host}'s cookies, saved data and history`,
      onclick: async () => {
        if (!confirm(`Forget ${s.host}?\n\nThis signs you out of it and deletes its cookies, saved data and history.`)) return;
        const res = await cloud.call('forget-site', s.host);
        toast(`Forgot ${s.host}: ${res.cookies} cookie${res.cookies === 1 ? '' : 's'}, ${res.history} history entr${res.history === 1 ? 'y' : 'ies'}`);
      },
    }, 'Forget site')))) : [h('div', { className: 'empty-row' }, 'No sites yet.')]));

  const p = r.protections;
  const prots = [
    [p.adblock, 'Ad and tracker blocker', p.adblock ? `On${p.allowlist ? `, with ads allowed on ${p.allowlist} site${p.allowlist === 1 ? '' : 's'}` : ' everywhere'}` : 'Off: trackers can load', '#privacy'],
    [p.vpn, 'VPN', p.vpn ? `On (${p.vpnMode === 'wireguard' ? 'WireGuard' : 'Tor network'}): sites can’t see your IP address` : 'Off: sites can see your IP address and rough location', '#vpn'],
    [p.stripTracking, 'Tracking links cleaned', p.stripTracking ? 'Tracking codes (like utm_ and fbclid) are removed from links' : 'Off', '#privacy'],
    [p.gpc, 'Do-not-sell signal (GPC)', p.gpc ? 'Sites are told not to sell or share your data' : 'Off', '#privacy'],
    [p.incognitoVpn || p.vpn, 'Incognito through the VPN', p.incognitoVpn || p.vpn ? 'Incognito windows use the VPN' : 'Off', '#vpn'],
    [p.clearOnExit, 'Clear data when you close CloudBrowser', p.clearOnExit ? 'On' : 'Off: cookies stay so you stay signed in', '#privacy'],
  ];
  $('protections').replaceChildren(...prots.map(([on, name, desc, hash]) => h('div', { className: 'prot' },
    h('span', { className: 'dot' + (on ? '' : ' off') }),
    h('div', { className: 'txt' }, h('b', {}, name), h('small', {}, desc)),
    h('a', { className: 'btn small', href: 'cloud://settings/' + hash }, 'Change'))));
}

async function load() { render(await cloud.call('privacy-report', range)); }
for (const b of document.querySelectorAll('#range button')) {
  b.onclick = () => { range = Number(b.dataset.r); document.querySelectorAll('#range button').forEach(x => x.classList.toggle('on', x === b)); load(); };
}
$('reset').onclick = async () => { if (confirm('Reset the privacy report? (Your all-time total stays.)')) render(await cloud.call('privacy-reset')); };
load();
setInterval(load, 15000);
