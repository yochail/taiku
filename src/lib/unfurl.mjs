// Link unfurling: fetch a real article page once, read its og:/twitter: meta, cache the result.
// News images are hotlinked (never downloaded or committed). Cache: sites/<id>/content/state/unfurl-cache.json.
import fs from 'node:fs';
import path from 'node:path';
import { sitePath } from './site.mjs';
import { safeUrl } from './data.mjs';
import { domainOf, decode, sanitizeUntrusted } from './news.mjs';
import { safeFetch } from './safe-fetch.mjs';

export const UNFURL_CACHE = () => sitePath('content', 'state', 'unfurl-cache.json');
export const UA = 'Mozilla/5.0 (compatible; TaikuBot/1.0; +https://taiku.app)';
const MAX_BYTES = 512 * 1024;

export function loadUnfurlCache(file = UNFURL_CACHE()) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, items: doc.items ?? {}, ...(doc.search ? { search: doc.search } : {}), ...(doc.alt ? { alt: doc.alt } : {}) };
  } catch {
    return { version: 1, items: {} };
  }
}

export function saveUnfurlCache(cache, file = UNFURL_CACHE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const items = Object.fromEntries(Object.entries(cache.items).sort(([a], [b]) => a.localeCompare(b)));
  const alt = cache.alt ? Object.fromEntries(Object.entries(cache.alt).sort(([a], [b]) => a.localeCompare(b))) : null;
  fs.writeFileSync(file, JSON.stringify({ version: 1, items, ...(cache.search ? { search: cache.search } : {}), ...(alt ? { alt } : {}) }, null, 1) + '\n');
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
};

// An empty value must stay empty: new URL('', base) is the page itself (an og:image that is the article).
const abs = (u, base) => {
  if (!String(u ?? '').trim()) return null;
  try {
    return safeUrl(new URL(u, base).href);
  } catch {
    return null;
  }
};

/** Parse og:/twitter:/article: meta, canonical and icon links out of an HTML head. */
export function parseMeta(html, baseUrl) {
  const head = String(html).slice(0, MAX_BYTES);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop')).toLowerCase();
    const content = attr(tag, 'content');
    if (key && content && !(key in meta)) meta[key] = content;
  }
  const links = (head.match(/<link\b[^>]*>/gi) ?? []).map((t) => ({ rel: attr(t, 'rel').toLowerCase(), href: attr(t, 'href') }));
  const title = meta['og:title'] || meta['twitter:title'] || decode(head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim();
  const imageSrc = links.find((l) => /(^|\s)image_src(\s|$)/.test(l.rel))?.href || '';
  const imageUrl = abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || imageSrc, baseUrl);
  const num = (v) => (/^\d{2,5}$/.test(v ?? '') ? Number(v) : undefined);
  const bodyImg = imageUrl ? null : articleImage(head, baseUrl);
  const canonical = abs(meta['og:url'] || links.find((l) => l.rel === 'canonical')?.href || '', baseUrl);
  const icon = abs(links.find((l) => /(^|\s)(apple-touch-icon|icon)(\s|$)/.test(l.rel))?.href || '/favicon.ico', baseUrl);
  const published = meta['article:published_time'] || meta['og:article:published_time'] || meta['datepublished'] || meta['date'] || meta['parsely-pub-date'] || '';
  const t = Date.parse(published);
  return {
    url: canonical && domainOf(canonical) === domainOf(baseUrl) ? canonical : null,
    title: title ? sanitizeUntrusted(title, 200) : '',
    description: sanitizeUntrusted(meta['og:description'] || meta['twitter:description'] || meta.description || '', 300),
    site_name: sanitizeUntrusted(meta['og:site_name'] || meta['application-name'] || '', 80),
    published: Number.isFinite(t) ? new Date(t).toISOString() : null,
    image: imageUrl ? { url: imageUrl, ...(num(meta['og:image:width']) ? { width: num(meta['og:image:width']) } : {}), ...(num(meta['og:image:height']) ? { height: num(meta['og:image:height']) } : {}) } : bodyImg,
    icon,
  };
}

const SMALL_IMG = /(logo|icon|avatar|sprite|badge|spinner|placeholder|blank|pixel|1x1|spacer|emoji|button|banner-ad|\/ads?\/|tracking|gravatar)/i;

/**
 * Last-resort preview: the first large content <img> (inside <article>/<main> when present).
 * Needs the page body, so callers fetch past </head>. Images with explicit dimensions must be
 * at least 300x150; undimensioned ones count only inside the article and only as jpg/png/webp/avif.
 */
export function articleImage(html, baseUrl) {
  const s = String(html);
  const region = s.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? s.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? null;
  const scope = region ?? (s.split(/<\/head>/i)[1] ?? '');
  for (const tag of scope.match(/<img\b[^>]*>/gi) ?? []) {
    const raw = attr(tag, 'data-src') || attr(tag, 'src') || (attr(tag, 'srcset').split(/\s+/)[0] ?? '');
    if (!raw || /^data:/i.test(raw) || /\.(svg|gif)(\?|$)/i.test(raw) || SMALL_IMG.test(raw) || SMALL_IMG.test(attr(tag, 'class')) || SMALL_IMG.test(attr(tag, 'alt'))) continue;
    const w = Number(attr(tag, 'width')) || 0;
    const h = Number(attr(tag, 'height')) || 0;
    if (w || h) {
      if (w < 300 || (h && h < 150)) continue;
    } else if (!region || !/\.(jpe?g|png|webp|avif)(\?|$)/i.test(raw)) continue;
    const url = abs(raw, baseUrl);
    if (url) return { url, ...(w ? { width: w } : {}), ...(w && h ? { height: h } : {}) };
  }
  return null;
}

/**
 * Unfurl one URL through the cache. Failed fetches are cached too (status, ok:false) and retried after
 * retryDays. offline: cache only. refresh: refetch now when the cached entry failed or has no image
 * (a refetch that fails keeps the older ok entry). A page whose head has no og:/twitter: image is
 * fetched once more past </head> for the first large article <img>.
 * Returns the cache entry {url, ok, status, fetchedAt, meta} or null.
 */
export async function unfurl(rawUrl, { cache, fetchImpl = globalThis.fetch, lookup, timeoutMs = 8000, offline = false, retryDays = 7, refresh = false, now = Date.now() } = {}) {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const hit = cache?.items[url];
  const stale = refresh && hit && !(hit.ok && hit.meta?.image);
  if (hit && !stale && (hit.ok || offline || now - Date.parse(hit.fetchedAt) < retryDays * 864e5)) return hit;
  if (offline || !fetchImpl) return hit ?? null;
  let entry;
  const get = (stopAt) => safeFetch(url, { fetchImpl, ...(lookup ? { lookup } : {}), expect: 'html', timeoutMs, maxBytes: MAX_BYTES, stopAt });
  try {
    const res = await get(/<\/head>/i);
    let meta = res.ok ? parseMeta(res.text, res.url) : null;
    if (meta?.title && !meta.image) {
      const full = await get(null).catch(() => null);
      const img = full?.ok ? articleImage(full.text, full.url) : null;
      if (img) meta = { ...meta, image: img };
    }
    entry = { url, ok: Boolean(res.ok && meta?.title), status: res.status, fetchedAt: new Date(now).toISOString(), meta, ...(res.error ? { error: res.error } : {}) };
  } catch (e) {
    entry = { url, ok: false, status: 0, error: e?.name === 'BlockedUrlError' ? e.message : String(e?.name ?? 'error'), fetchedAt: new Date(now).toISOString(), meta: null };
  }
  if (hit?.ok && !entry.ok) return hit;
  if (cache) cache.items[url] = entry;
  return entry;
}

/**
 * Build the link_card media item. The URL must be real (from the news feed or a fetched page);
 * `fallback` carries feed data (title, source/site, published) used when the page blocks bots.
 * No og:image -> `icon` (outlet favicon) so the renderer can draw a logo card.
 */
export function linkCardFrom(url, entry, fallback = {}) {
  const u = safeUrl(url);
  if (!u) return null;
  const m = entry?.meta ?? {};
  const target = m.url || u;
  const feedTitle = sanitizeUntrusted(fallback.title ?? '', 200);
  const pageTitle = m.title && !genericTitle(m.title, target) ? m.title : '';
  const card = {
    kind: 'link_card',
    url: target,
    domain: domainOf(target),
    title: pageTitle || feedTitle || m.title || domainOf(target),
  };
  if (m.description) card.description = m.description;
  const site = m.site_name || sanitizeUntrusted(fallback.site_name ?? fallback.source ?? '', 80);
  if (site) card.site_name = site;
  const pub = m.published || (Number.isFinite(Date.parse(fallback.published ?? '')) ? new Date(Date.parse(fallback.published)).toISOString() : null);
  if (pub) card.published = pub;
  card.image = m.image?.url ? m.image : fallbackImage(`${card.title} ${m.description ?? ''} ${target}`);
  card.icon = m.icon || `https://${new URL(target).host}/favicon.ico`;
  return card;
}

// Page titles that name the outlet or a bot wall rather than the story ("MSN", "Just a moment...").
export function genericTitle(title, url) {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t) return true;
  if (/^(just a moment|access denied|attention required|are you a robot|robot check|403 forbidden|404|page not found|error|loading|redirecting|log ?in|sign in|subscribe)\b/.test(t)) return true;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const brand = host.split('.').slice(-2, -1)[0] ?? '';
  return t.replace(/[^a-z0-9]/g, '') === brand.replace(/[^a-z0-9]/g, '') || t === host;
}

// Last-resort card art when the article has no preview image (bot-blocked, JS-only or imageless page):
// a text-free topic illustration (public/media/news/<topic>.svg), first matching rule wins.
const TOPICS = [
  ['tech', /\b(ai|llms?|gpt|openai|anthropic|claude|software|code|coding|programming|python|rust|javascript|linux|github|chip|cpu|gpu|nvidia|apple|google|microsoft|meta|startup|app|browser|chrome|cyber|hack|hacker|data|algorithm|robot|compute|server|cloud|crypto|bitcoin|internet|web|api|database|open[- ]source|model)\b|ycombinator|github\.com/i],
  ['disaster', /\b(earthquake|tsunami|hurricane|typhoon|cyclone|storm|flood|flooding|wildfire|fire|blaze|drought|landslide|collapse|crash|derail|explosion|volcano|eruption|heatwave|rescue|sinks?)\b/i],
  ['health', /\b(ebola|virus|vaccine|disease|outbreak|plague|hospital|health|medical|cancer|doctor|nurse|pandemic|covid|drug|mpox|measles|cholera|malaria|mosquito(es)?)\b/i],
  ['science', /\b(scien\w*|study|researchers?|nasa|space|mars|moon|planet|asteroid|meteorite|telescope|physics|chemistry|biology|species|fossil|dinosaur|climate|nobel|math|mathematic\w*|genome|quantum|ocean|penguin|lizard)\b/i],
  ['sports', /\b(win|wins|won|beat|beats|defeat|champion\w*|title|cup|league|nba|wnba|nfl|nhl|mlb|f1|grand prix|olympic\w*|football|soccer|baseball|basketball|tennis|golf|cricket|rugby|marathon|race|coach|goal|world series|ballon|mvp|gymnast\w*|derby)\b/i],
  ['business', /\b(stocks?|shares?|market|ipo|bank|banks|economy|economic|inflation|prices?|tariffs?|trade|oil|gas|billion|million|deal|merger|acquires?|acquisition|profit|revenue|investors?|fund|ecb|fed|imf|debt|budget)\b/i],
  ['politics', /\b(elect\w*|vote|votes|voting|referendum|parliament|congress|senate|president\w*|prime minister|minister|government|mayor|court|judge|law|bill|party|campaign|protest\w*|strike|sanctions?|policy|impeach\w*|ruling)\b/i],
  ['culture', /\b(film|movie|music|album|song|singer|artist|art|museum|painting|book|novel|author|poet|festival|award|prize|tv|series|theatre|theater|fashion|dictionary|word of the year|game|games)\b/i],
];
export const FALLBACK_TOPICS = [...TOPICS.map(([t]) => t), 'world'];
export function fallbackImage(text) {
  const topic = TOPICS.find(([, re]) => re.test(String(text ?? '')))?.[0] ?? 'world';
  return { url: `/media/news/${topic}.svg`, width: 1200, height: 630, fallback: true };
}

/** All URLs a card may legitimately point to: unfurl-cache keys plus their canonical targets. */
export function knownUrls(cache) {
  const s = new Set();
  for (const [k, v] of Object.entries(cache.items)) {
    s.add(k);
    if (v.meta?.url) s.add(v.meta.url);
  }
  return s;
}
