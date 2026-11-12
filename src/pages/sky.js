// Home page sky: time-of-day colours, soft procedurally drawn clouds drifting in three layers,
// and stars at night.
'use strict';
(() => {
  const body = document.body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const darkTheme = matchMedia('(prefers-color-scheme: dark)');

  const forced = new URLSearchParams(location.search).get('time');
  function timeOfDay() {
    if (['dawn', 'day', 'dusk', 'night'].includes(forced)) return forced;
    if (body.classList.contains('incognito') || darkTheme.matches) return 'night';
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    if (h >= 5.5 && h < 8) return 'dawn';
    if (h >= 8 && h < 17.5) return 'day';
    if (h >= 17.5 && h < 20) return 'dusk';
    return 'night';
  }

  // Seeded random so the clouds don't change shape every time something re-renders.
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const TINTS = {
    dawn: { light: [255, 246, 244], shade: [222, 170, 190], alpha: 0.95 },
    day: { light: [255, 255, 255], shade: [176, 196, 228], alpha: 0.95 },
    dusk: { light: [255, 226, 210], shade: [168, 120, 160], alpha: 0.9 },
    night: { light: [120, 138, 176], shade: [40, 52, 86], alpha: 0.38 },
  };

  // Draw one cloud: lots of overlapping soft puffs, lit from above, shaded underneath.
  function drawCloud(w, h, tint) {
    const c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const puffs = 26 + Math.floor(rnd() * 14);
    for (let i = 0; i < puffs; i++) {
      const t = i / puffs;
      const x = w * (0.12 + 0.76 * rnd());
      const hump = Math.sin(Math.PI * ((x / w - 0.1) / 0.8));        // taller in the middle
      const r = h * (0.16 + 0.22 * rnd()) * (0.7 + 0.5 * hump);
      const y = h * 0.78 - hump * h * 0.32 * rnd() - r * 0.25;
      const grad = g.createRadialGradient(x - r * 0.15, y - r * 0.35, r * 0.1, x, y, r);
      const [lr, lg, lb] = tint.light;
      grad.addColorStop(0, `rgba(${lr},${lg},${lb},${0.9 * tint.alpha})`);
      grad.addColorStop(0.55, `rgba(${lr},${lg},${lb},${0.55 * tint.alpha})`);
      grad.addColorStop(1, `rgba(${lr},${lg},${lb},0)`);
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // shade the underside
    g.globalCompositeOperation = 'source-atop';
    const [sr, sg, sb] = tint.shade;
    const shade = g.createLinearGradient(0, h * 0.35, 0, h);
    shade.addColorStop(0, `rgba(${sr},${sg},${sb},0)`);
    shade.addColorStop(1, `rgba(${sr},${sg},${sb},0.55)`);
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
    return c;
  }

  function buildClouds(time) {
    const box = document.getElementById('clouds');
    box.replaceChildren();
    seed = 7;
    const vw = window.innerWidth, vh = window.innerHeight;
    const tint = TINTS[time];
    const layers = [
      { count: 5, size: 0.55, top: [0.04, 0.35], speed: 260, opacity: 0.65 },
      { count: 4, size: 0.85, top: [0.10, 0.60], speed: 180, opacity: 0.85 },
      { count: 3, size: 1.25, top: [0.45, 0.85], speed: 120, opacity: 1 },
    ];
    for (const L of layers) {
      for (let i = 0; i < L.count; i++) {
        const w = Math.round((260 + rnd() * 220) * L.size);
        const h = Math.round(w * (0.38 + rnd() * 0.12));
        const c = drawCloud(w, h, tint);
        c.style.top = Math.round(vh * (L.top[0] + rnd() * (L.top[1] - L.top[0])) - h / 2) + 'px';
        c.style.opacity = String(L.opacity);
        box.append(c);
        const start = -w - 40, end = vw + 40;
        const duration = L.speed * 1000 * (0.85 + rnd() * 0.3) * (vw + w) / 1400;
        const progress = (i + rnd() * 0.6) / L.count; // spread across the screen
        if (reduced) {
          c.style.transform = `translateX(${start + (end - start) * progress}px)`;
        } else {
          c.animate([{ transform: `translateX(${start}px)` }, { transform: `translateX(${end}px)` }],
            { duration, iterations: Infinity, delay: -duration * progress, easing: 'linear' });
        }
      }
    }
  }

  function buildStars() {
    const box = document.getElementById('stars');
    if (box.childElementCount) return;
    seed = 3;
    for (let i = 0; i < 90; i++) {
      const s = document.createElement('div');
      s.className = 'star';
      s.style.left = (rnd() * 100) + '%';
      s.style.top = (rnd() * 100) + '%';
      const size = rnd() < 0.85 ? 1.5 : 2.5;
      s.style.width = s.style.height = size + 'px';
      s.style.opacity = String(0.4 + rnd() * 0.6);
      s.style.animationDelay = (-rnd() * 3.5) + 's';
      s.style.animationDuration = (2.5 + rnd() * 3) + 's';
      box.append(s);
    }
  }

  let current = null;
  function render(force) {
    const time = timeOfDay();
    if (time === current && !force) return;
    current = time;
    body.dataset.time = time;
    if (time === 'night') buildStars();
    buildClouds(time);
  }

  window.CloudSky = { refresh: () => render(true) };
  render(true);
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(true), 250); });
  darkTheme.addEventListener('change', () => render(true));
  setInterval(() => render(false), 60000);
})();
