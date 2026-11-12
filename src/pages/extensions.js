'use strict';

const PUZZLE = '<svg viewBox="0 0 24 24"><path d="M9 4h4v2.5a1.5 1.5 0 0 0 3 0V4a2 2 0 0 1 2 2v3h-2.5a1.5 1.5 0 0 0 0 3H18v6a2 2 0 0 1-2 2h-3v-2.5a1.5 1.5 0 0 0-3 0V20H6a2 2 0 0 1-2-2v-4h2.5a1.5 1.5 0 0 0 0-3H4V6a2 2 0 0 1 2-2z"/></svg>';

function extIcon(src) {
  if (!src) return h('span', { className: 'fav ext-ico', html: PUZZLE });
  return h('img', { className: 'fav ext-ico', src, alt: '' });
}

async function render() {
  const data = await cloud.call('extensions');
  $('unavailable').hidden = data.available;

  $('none').hidden = data.installed.length > 0;
  $('installed').replaceChildren(...data.installed.map(x => h('div', { className: 'item' },
    extIcon(x.icon),
    h('div', { className: 'main' },
      h('div', { className: 't' }, x.name, h('span', { className: 'hint' }, `  ${x.version}`)),
      x.description && h('div', { className: 's' }, x.description)),
    h('div', { className: 'actions' },
      x.hasOptions && h('button', { className: 'btn small', onclick: () => cloud.call('extension-options', x.id) }, 'Options'),
      h('button', { className: 'btn small danger', onclick: async (e) => {
        e.target.disabled = true;
        await cloud.call('remove-extension', x.id);
        render();
      } }, 'Remove')),
  )));

  $('recommended').replaceChildren(...data.recommended.map(r => {
    const status = h('span', { className: 'hint' });
    const btn = h('button', { className: 'btn small' + (r.installed ? '' : ' primary'), disabled: r.installed || !data.available },
      r.installed ? 'Installed' : 'Add');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Adding…';
      const res = await cloud.call('install-extension', r.id);
      if (!res.ok) { status.textContent = 'Couldn’t add it: ' + res.error; btn.disabled = false; btn.textContent = 'Try again'; return; }
      render();
    };
    return h('div', { className: 'item' },
      extIcon(null),
      h('div', { className: 'main' }, h('div', { className: 't' }, r.name), h('div', { className: 's' }, r.about), status),
      h('div', { className: 'actions' }, btn));
  }));
}

$('store').onclick = () => cloud.call('open-web-store');
cloud.on('extensions', () => render());
render();
