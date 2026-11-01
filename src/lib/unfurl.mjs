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
    return { version: 1, items: doc.items ?? {}, ...(doc.search ? { search: doc.search } : {}) };
  } catch {
    return { version: 1, items: {} };
  }
}

export function saveUnfurlCache(cache, file = UNFURL_CACHE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const items = Object.fromEntries(Object.entries(cache.items).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify({ version: 1, items, ...(cache.search ? { search: cache.search } : {}) }, null, 1) + '\n');
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
};

const abs = (u, base) => {
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
  const imageUrl = abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || '', baseUrl);
  const num = (v) => (/^\d{2,5}$/.test(v ?? '') ? Number(v) : undefined);
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
    image: imageUrl ? { url: imageUrl, ...(num(meta['og:image:width']) ? { width: num(meta['og:image:width']) } : {}), ...(num(meta['og:image:height']) ? { height: num(meta['og:image:height']) } : {}) } : null,
    icon,
  };
}

/**
 * Unfurl one URL through the cache. Failed fetches are cached too (status, ok:false) and retried after
 * retryDays. offline: cache only. Returns the cache entry {url, ok, status, fetchedAt, meta} or null.
 */
export async function unfurl(rawUrl, { cache, fetchImpl = globalThis.fetch, lookup, timeoutMs = 8000, offline = false, retryDays = 7, now = Date.now() } = {}) {
  const url = safeUrl(rawUrl);
  if (!url) return null;
  const hit = cache?.items[url];
  if (hit && (hit.ok || offline || now - Date.parse(hit.fetchedAt) < retryDays * 864e5)) return hit;
  if (offline || !fetchImpl) return hit ?? null;
  let entry;
  try {
    const res = await safeFetch(url, { fetchImpl, ...(lookup ? { lookup } : {}), expect: 'html', timeoutMs, maxBytes: MAX_BYTES, stopAt: /<\/head>/i });
    const meta = res.ok ? parseMeta(res.text, res.url) : null;
    entry = { url, ok: Boolean(res.ok && meta?.title), status: res.status, fetchedAt: new Date(now).toISOString(), meta, ...(res.error ? { error: res.error } : {}) };
  } catch (e) {
    entry = { url, ok: false, status: 0, error: e?.name === 'BlockedUrlError' ? e.message : String(e?.name ?? 'error'), fetchedAt: new Date(now).toISOString(), meta: null };
  }
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
  const card = {
    kind: 'link_card',
    url: target,
    domain: domainOf(target),
    title: m.title || sanitizeUntrusted(fallback.title ?? '', 200) || domainOf(target),
  };
  if (m.description) card.description = m.description;
  const site = m.site_name || sanitizeUntrusted(fallback.site_name ?? fallback.source ?? '', 80);
  if (site) card.site_name = site;
  const pub = m.published || (Number.isFinite(Date.parse(fallback.published ?? '')) ? new Date(Date.parse(fallback.published)).toISOString() : null);
  if (pub) card.published = pub;
  if (m.image?.url) card.image = m.image;
  card.icon = m.icon || `https://${new URL(target).host}/favicon.ico`;
  return card;
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
