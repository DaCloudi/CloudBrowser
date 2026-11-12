'use strict';
let all = [];

function render() {
  const q = $('q').value.trim().toLowerCase();
  const items = q ? all.filter(b => (b.title || '').toLowerCase().includes(q) || b.url.toLowerCase().includes(q)) : all;
  $('empty').hidden = items.length > 0;
  $('empty').textContent = q ? 'No bookmarks match that.' : 'No bookmarks yet. Press Ctrl+D on any page, or click the ☆ in the address bar.';
  $('list').replaceChildren(...items.map(b => row(b, !q)));
}

function row(b, canMove) {
  const el = h('div', { className: 'item' },
    favicon(b.url, b.favicon),
    h('div', { className: 'main' },
      h('div', { className: 't' }, h('a', { href: b.url, title: b.url }, b.title || b.url)),
      h('div', { className: 's' }, b.url)),
    h('div', { className: 'actions' },
      canMove && iconButton('up', 'Move up', async () => { all = await cloud.call('move-bookmark', b.id, -1); render(); }),
      canMove && iconButton('down', 'Move down', async () => { all = await cloud.call('move-bookmark', b.id, 1); render(); }),
      iconButton('edit', 'Edit', () => el.replaceWith(editor(b))),
      iconButton('close', 'Delete', async () => { all = await cloud.call('remove-bookmark', b.id); render(); }),
    ),
  );
  return el;
}

function editor(b) {
  const title = h('input', { type: 'text', value: b.title || '', placeholder: 'Name', spellcheck: 'false' });
  const url = h('input', { type: 'text', value: b.url, placeholder: 'Address', spellcheck: 'false' });
  const save = async () => { all = await cloud.call('edit-bookmark', b.id, title.value, url.value); render(); };
  for (const i of [title, url]) i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') render(); });
  const el = h('div', { className: 'item' },
    favicon(b.url, b.favicon),
    h('div', { className: 'main' }, title, url),
    h('div', { className: 'actions' },
      h('button', { className: 'btn small primary', onclick: save }, 'Save'),
      h('button', { className: 'btn small', onclick: render }, 'Cancel')),
  );
  setTimeout(() => title.focus(), 0);
  return el;
}

$('q').addEventListener('input', render);
cloud.on('bookmarks', items => { all = items; render(); });
cloud.call('bookmarks').then(items => { all = items; render(); });
