'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const data = await window.cloud.call('share-sources');
  if (!data) { window.close(); return; }
  let kind = 'screen', chosen = null;
  $('site').textContent = data.site ? `${data.site} wants to share your screen` : '';
  $('audioWrap').hidden = !data.audio;
  const render = () => {
    const items = data.sources.filter(s => s.kind === kind);
    $('list').replaceChildren(...(items.length ? items.map((s, i) => {
      const b = document.createElement('button');
      b.className = 'src' + (chosen === s.id ? ' sel' : '');
      b.dataset.id = s.id;
      const img = s.thumb ? Object.assign(document.createElement('img'), { src: s.thumb, alt: '' }) : Object.assign(document.createElement('div'), { className: 'ph' });
      const name = document.createElement('span');
      name.textContent = s.kind === 'screen' ? (items.length > 1 ? `Screen ${i + 1}` : 'Entire screen') : s.name;
      b.title = s.name;
      b.append(img, name);
      b.onclick = () => { chosen = s.id; render(); };
      b.ondblclick = () => share();
      return b;
    }) : [Object.assign(document.createElement('div'), { id: 'empty', textContent: 'Nothing to share here.' })]));
    $('share').disabled = !chosen;
    $('audioWrap').style.visibility = kind === 'screen' ? 'visible' : 'hidden';
  };
  const share = () => { if (chosen) window.cloud.call('share-choose', chosen, kind === 'screen' && $('audio').checked); };
  for (const t of document.querySelectorAll('.tabs button')) {
    t.onclick = () => { kind = t.dataset.kind; chosen = null; document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === t)); render(); };
  }
  $('share').onclick = share;
  $('cancel').onclick = () => window.cloud.call('share-choose', null);
  const screens = data.sources.filter(s => s.kind === 'screen');
  if (screens.length === 1) chosen = screens[0].id;
  render();
})();
