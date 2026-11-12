// Home page sky: soft procedurally drawn clouds drifting slowly in three layers.
'use strict';
(() => {
  const body = document.body;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const darkTheme = matchMedia('(prefers-color-scheme: dark)');

  function timeOfDay() {
    if (body.classList.contains('incognito')) return 'incognito';
    return darkTheme.matches ? 'dark' : 'light';
  }

  // Seeded random so the clouds don't change shape every time something re-renders.
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

  const TINTS = {
    light: { light: [255, 255, 255], shade: [188, 206, 232], alpha: 0.9 },
    dark: { light: [120, 140, 180], shade: [40, 52, 80], alpha: 0.28 },
    incognito: { light: [140, 120, 190], shade: [40, 30, 66], alpha: 0.2 },
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
      { count: 3, size: 0.6, top: [0.06, 0.35], speed: 280, opacity: 0.55 },
      { count: 3, size: 0.9, top: [0.20, 0.65], speed: 200, opacity: 0.75 },
      { count: 2, size: 1.2, top: [0.55, 0.88], speed: 140, opacity: 0.9 },
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

  let current = null;
  function render(force) {
    const time = timeOfDay();
    if (time === current && !force) return;
    current = time;
    buildClouds(time);
  }

  window.CloudSky = { refresh: () => render(true) };
  render(true);
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => render(true), 250); });
  darkTheme.addEventListener('change', () => render(true));
})();
