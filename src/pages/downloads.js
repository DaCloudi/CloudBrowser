'use strict';

function status(d) {
  switch (d.state) {
    case 'progressing': return d.total ? `${fmtBytes(d.received)} of ${fmtBytes(d.total)}` : `${fmtBytes(d.received)} downloaded`;
    case 'paused': return `Paused — ${fmtBytes(d.received)}${d.total ? ' of ' + fmtBytes(d.total) : ''}`;
    case 'completed': return `${fmtBytes(d.total || d.received)} · ${fmtDay(d.time)} ${fmtTime(d.time)}`;
    case 'cancelled': return 'Cancelled';
    case 'interrupted': return 'Failed — the download was interrupted';
    default: return d.state;
  }
}

function render(items) {
  $('empty').hidden = items.length > 0;
  $('list').replaceChildren(...items.map(d => {
    const act = (a) => () => cloud.call('download-action', d.id, a);
    const running = d.state === 'progressing' || d.state === 'paused';
    const done = d.state === 'completed';
    const buttons = [];
    if (done) {
      buttons.push(h('button', { className: 'btn small', onclick: act('open') }, 'Open'));
      buttons.push(h('button', { className: 'btn small', onclick: act('show') }, 'Show in folder'));
    }
    if (d.state === 'progressing') buttons.push(h('button', { className: 'btn small', onclick: act('pause') }, 'Pause'));
    if (d.state === 'paused') buttons.push(h('button', { className: 'btn small', onclick: act('resume') }, 'Resume'));
    if (running) buttons.push(h('button', { className: 'btn small', onclick: act('cancel') }, 'Cancel'));
    if (d.state === 'cancelled' || d.state === 'interrupted') buttons.push(h('button', { className: 'btn small', onclick: act('retry') }, 'Retry'));
    if (!running) buttons.push(iconButton('close', 'Remove from list', act('remove')));

    const pct = d.total ? Math.min(100, Math.round(d.received / d.total * 100)) : 0;
    return h('div', { className: 'item' },
      h('span', { className: 'fav', html: ICON.file }),
      h('div', { className: 'main' },
        h('div', { className: 't' }, done
          ? h('a', { href: '#', title: d.path, onclick: e => { e.preventDefault(); act('open')(); } }, d.filename)
          : h('span', {}, d.filename)),
        running && h('div', { className: 'bar' }, (() => { const b = h('div'); b.style.width = pct + '%'; return b; })()),
        h('div', { className: 's' + (d.state === 'interrupted' ? ' state-bad' : '') }, status(d) + (d.url && /^https?:/.test(d.url) ? ` · ${hostOf(d.url)}` : '')),
      ),
      h('div', { className: 'actions' }, buttons),
    );
  }));
}

$('openFolder').onclick = () => cloud.call('open-downloads-folder');
$('clearAll').onclick = async () => render(await cloud.call('clear-downloads'));
cloud.on('downloads', render);
cloud.call('downloads').then(render);
