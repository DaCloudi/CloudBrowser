// Who's behind the trackers CloudBrowser blocks, for the privacy report.
// A short list of the big tracking and advertising companies; anything else is shown by its domain.
'use strict';

const COMPANIES = {
  Google: ['google-analytics.com', 'googletagmanager.com', 'googlesyndication.com', 'doubleclick.net', 'googleadservices.com',
    'google.com', 'googleapis.com', 'gstatic.com', 'adservice.google.com', 'googletagservices.com', 'youtube.com', 'ytimg.com', '2mdn.net', 'app-measurement.com'],
  Meta: ['facebook.com', 'facebook.net', 'fbcdn.net', 'instagram.com', 'fbsbx.com'],
  Amazon: ['amazon-adsystem.com', 'amazon.com', 'assoc-amazon.com', 'media-amazon.com'],
  Microsoft: ['bing.com', 'clarity.ms', 'microsoft.com', 'msn.com', 'live.com', 'licdn.com', 'linkedin.com', 'ads.linkedin.com'],
  TikTok: ['tiktok.com', 'tiktokv.com', 'byteoversea.com', 'ttwstatic.com', 'analytics.tiktok.com'],
  'X (Twitter)': ['twitter.com', 'ads-twitter.com', 't.co', 'x.com', 'twimg.com'],
  Snap: ['snapchat.com', 'sc-static.net'],
  Pinterest: ['pinterest.com', 'pinimg.com'],
  Reddit: ['redditstatic.com', 'redditmedia.com', 'reddit.com'],
  Adobe: ['demdex.net', 'omtrdc.net', 'everesttech.net', 'adobedtm.com', '2o7.net'],
  Oracle: ['bluekai.com', 'addthis.com', 'moat.com', 'moatads.com'],
  Criteo: ['criteo.com', 'criteo.net'],
  'The Trade Desk': ['adsrvr.org'],
  Taboola: ['taboola.com'],
  Outbrain: ['outbrain.com'],
  Hotjar: ['hotjar.com', 'hotjar.io'],
  'Quantcast': ['quantserve.com', 'quantcount.com', 'quantcast.com'],
  Comscore: ['scorecardresearch.com', 'comscore.com'],
  'Index Exchange': ['casalemedia.com', 'indexww.com'],
  PubMatic: ['pubmatic.com'],
  Magnite: ['rubiconproject.com'],
  OpenX: ['openx.net'],
  Xandr: ['adnxs.com'],
  Yahoo: ['yahoo.com', 'advertising.com', 'yimg.com'],
  Yandex: ['yandex.ru', 'yandex.net', 'mc.yandex.ru'],
  Segment: ['segment.com', 'segment.io'],
  Mixpanel: ['mixpanel.com', 'mxpnl.com'],
  Amplitude: ['amplitude.com'],
  'New Relic': ['nr-data.net', 'newrelic.com'],
  Sentry: ['sentry.io', 'sentry-cdn.com'],
  Cloudflare: ['cloudflareinsights.com'],
  Branch: ['branch.io', 'app.link'],
  AppsFlyer: ['appsflyer.com'],
  OneSignal: ['onesignal.com'],
  Disqus: ['disqus.com', 'disquscdn.com'],
  Lotame: ['crwdcntrl.net'],
  LiveRamp: ['rlcdn.com', 'pippio.com'],
  Media_net: ['media.net'],
  Teads: ['teads.tv'],
  Smartadserver: ['smartadserver.com'],
  'Integral Ad Science': ['adsafeprotected.com'],
  DoubleVerify: ['doubleverify.com'],
  Sharethrough: ['sharethrough.com'],
  'Amazon (Twitch)': ['twitch.tv', 'ttvnw.net'],
};

const BY_DOMAIN = new Map();
for (const [company, domains] of Object.entries(COMPANIES)) for (const d of domains) BY_DOMAIN.set(d, company.replace('_', '.'));

const TWO_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'com.mx', 'co.za', 'com.tr', 'com.cn']);

/** example: "stats.g.doubleclick.net" -> "doubleclick.net" */
function baseDomain(host) {
  host = String(host || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  return TWO_PART_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** The company behind a domain, or null if it isn't one we know. */
function companyOf(host) {
  host = String(host || '').toLowerCase();
  let h = host;
  while (h) {
    const c = BY_DOMAIN.get(h);
    if (c) return c;
    const dot = h.indexOf('.');
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  return null;
}

module.exports = { baseDomain, companyOf };
