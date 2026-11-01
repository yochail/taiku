import { SITE_CONFIG } from './site.mjs';

export const SITE = {
  name: SITE_CONFIG.name,
  tagline: SITE_CONFIG.tagline,
  baseUrl: (process.env.SITE_URL || SITE_CONFIG.baseUrl || `https://${SITE_CONFIG.domain}`).replace(/\/+$/, ''),
  description: SITE_CONFIG.description,
  repo: SITE_CONFIG.repo,
  locale: SITE_CONFIG.locale,
  dir: SITE_CONFIG.dir,
};

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** FNV-1a 32-bit hash, deterministic across runs. */
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hash(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

export function weightedPick(rand, items, weightFn) {
  const weights = items.map((it) => Math.max(0, weightFn(it)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return items[Math.floor(rand() * items.length)];
  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function slugify(s) {
  const ascii = String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii) return ascii;
  // Non-Latin text (e.g. Hebrew): keep letters and digits, drop niqqud/cantillation marks.
  return String(s).normalize('NFC').toLowerCase().replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const INTL = !/^en\b/.test(SITE_CONFIG.locale || 'en');
const fmtShort = INTL && new Intl.DateTimeFormat(SITE_CONFIG.locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtLong = INTL && new Intl.DateTimeFormat(SITE_CONFIG.locale, { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', timeZoneName: 'short' });

export function shortDate(iso) {
  const d = new Date(iso);
  if (fmtShort) return fmtShort.format(d);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function longDate(iso) {
  const d = new Date(iso);
  if (fmtLong) return fmtLong.format(d);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm} UTC · ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

export function compactNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/**
 * Escape and enrich post text: @handles -> profile links, #tags -> tag pages,
 * bare URLs -> links, newlines -> <br>.
 */
export function renderText(text, handleMap) {
  let html = esc(text);
  html = html.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}" rel="nofollow noopener" target="_blank">${url}</a>`);
  html = html.replace(/(^|[^\w/&])@([A-Za-z0-9_]{2,30})/g, (m, pre, h) => {
    const p = handleMap.get(h.toLowerCase());
    return p ? `${pre}<a class="mention" href="/thinkers/${p.id}/">@${h}</a>` : m;
  });
  html = html.replace(/(^|[^\w&/])#([A-Za-z][A-Za-z0-9_]{1,40})/g, (m, pre, t) => `${pre}<a class="hashtag" href="/tags/${slugify(t)}/">#${t}</a>`);
  return html
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n/g, '<br>'))
    .join('<br><br>');
}

export function newId(date = new Date(), rand = Math.random) {
  const ts = date.getTime().toString(36);
  const r = Math.floor(rand() * 36 ** 3).toString(36).padStart(3, '0');
  return `${ts}${r}`;
}
