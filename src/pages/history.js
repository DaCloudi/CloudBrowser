'use strict';

async function render() {
  const items = await cloud.call('history', $('q').value);
  const list = $('list');
  $('empty').hidden = items.length > 0;
  $('empty').textContent = $('q').value ? 'Nothing in your history matches that.' : 'No history yet. Pages you visit (outside private tabs) show up here.';

  const out = [];
  let day = null;
  let group = null;
  for (const it of items) {
    const d = fmtDay(it.time);
    if (d !== day) {
      day = d;
      out.push(h('div', { className: 'day' }, d));
      group = h('div', { className: 'list' });
      out.push(group);
    }
    const row = h('div', { className: 'item' },
      h('span', { className: 'time' }, fmtTime(it.time)),
      favicon(it.url),
      h('div', { className: 'main' },
        h('div', { className: 't' }, h('a', { href: it.url, title: it.url }, it.title || it.url)),
        h('div', { className: 's' }, hostOf(it.url))),
      iconButton('close', 'Remove from history', async () => {
        await cloud.call('delete-history', it.url, it.time);
        row.remove();
      }),
    );
    group.append(row);
  }
  list.replaceChildren(...out);
}

$('q').addEventListener('input', debounce(render, 150));
$('clearAll').onclick = async () => {
  if (!confirm('Clear all browsing history?')) return;
  await cloud.call('clear-data', { history: true });
  render();
};

render();
