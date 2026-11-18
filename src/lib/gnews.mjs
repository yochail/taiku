// Google News RSS links (news.google.com/rss/articles/<id>) are redirect shells: no preview, and the
// id only resolves through Google's JS. Feed items, skeleton link cards and the links backfill map them
// to the publisher's article URL; when that fails the link is dropped (never published as a card).
// Self-contained (data.mjs imports this module): https only, no credentials, default port.
const safeUrl = (u) => {
  try {
    const url = new URL(String(u ?? ''));
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url.toString() : null;
  } catch {
    return null;
  }
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function googleNewsLocale(u) {
  const url = new URL(String(u));
  const hlValue = url.searchParams.get('hl') ?? '';
  const glValue = url.searchParams.get('gl') ?? '';
  const hl = /^[a-z]{2}(?:-[A-Z]{2})?$/.test(hlValue) ? hlValue : 'en';
  const gl = /^[A-Z]{2}$/.test(glValue) ? glValue : 'US';
  const ceidValue = url.searchParams.get('ceid') ?? '';
  const ceid = /^[A-Z]{2}:[a-z]{2}(?:-[A-Z]{2})?$/.test(ceidValue) ? ceidValue : `${gl}:${hl.split('-')[0]}`;
  return { hl, gl, ceid };
}

function gartUrlFromResponse(text) {
  const payload = String(text).replace(/^\)\]\}'\s*/, '').trim();
  let root;
  try {
    root = JSON.parse(payload);
  } catch {
    return null;
  }
  const visit = (value, depth = 0) => {
    if (depth > 8) return null;
    if (Array.isArray(value)) {
      if (value[0] === 'garturlres' && typeof value[1] === 'string') return value[1];
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
    } else if (typeof value === 'string') {
      try {
        const nested = JSON.parse(value);
        if (nested !== value) return visit(nested, depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  };
  return visit(root);
}

/** True for a Google News article redirect (rss/articles, articles, read). */
export function isGoogleNewsUrl(u) {
  try {
    const url = new URL(String(u ?? ''));
    return /(^|\.)news\.google\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function googleNewsId(u) {
  try {
    const url = new URL(String(u ?? ''));
    if (!/(^|\.)news\.google\.com$/i.test(url.hostname)) return null;
    return url.pathname.match(/^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Old-style ids embed the URL in the protobuf payload; new-style ("AU_yqL…") need the batchexecute call. */
export function decodeGoogleNewsIdOffline(id) {
  let buf;
  try {
    buf = Buffer.from(String(id).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
  const s = buf.toString('latin1');
  const m = s.match(/https?:\/\/[\x21-\x7e]+/);
  if (!m || /^AU_yqL/.test(s.slice(4))) return null;
  return safeUrl(m[0].replace(/[\x00-\x20\x7f-\xff].*$/s, '')) || null;
}

/**
 * Resolve a Google News article link to the publisher URL. Returns null when it can't (offline,
 * blocked, changed format). `cache` (optional Map-like object) memoises results by id.
 */
export async function resolveGoogleNews(u, { fetchImpl = globalThis.fetch, cache = null, timeoutMs = 10000, offline = false } = {}) {
  const id = googleNewsId(u);
  if (!id) return null;
  if (cache && Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
  const remember = (v) => {
    if (cache) cache[id] = v;
    return v;
  };
  const offlineHit = decodeGoogleNewsIdOffline(id);
  if (offlineHit && !isGoogleNewsUrl(offlineHit)) return remember(offlineHit);
  if (offline) return null;
  try {
    const locale = googleNewsLocale(u);
    const pageUrls = [String(u)];
    const fallbackPage = new URL(`https://news.google.com/articles/${id}`);
    fallbackPage.searchParams.set('hl', locale.hl);
    fallbackPage.searchParams.set('gl', locale.gl);
    fallbackPage.searchParams.set('ceid', locale.ceid);
    if (!pageUrls.includes(fallbackPage.toString())) pageUrls.push(fallbackPage.toString());
    let sg;
    let ts;
    let pageUrl;
    for (const candidate of pageUrls) {
      let page;
      try {
        page = await fetchImpl(candidate, {
          headers: { 'user-agent': UA, 'accept-language': `${locale.hl},en;q=0.8` },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        continue;
      }
      if (!page.ok) continue;
      const finalUrl = safeUrl(page.url);
      if (finalUrl && !isGoogleNewsUrl(finalUrl)) {
        await page.body?.cancel().catch(() => {});
        return remember(finalUrl);
      }
      const html = await page.text();
      const attr = (name) => html.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
      sg = attr('data-n-a-sg');
      ts = attr('data-n-a-ts');
      if (sg && ts) {
        pageUrl = isGoogleNewsUrl(page.url) ? page.url : candidate;
        break;
      }
    }
    if (!sg || !ts) return null;
    const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, locale.ceid, null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
    const res = await fetchImpl('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA, origin: 'https://news.google.com', referer: pageUrl },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const url = safeUrl(gartUrlFromResponse(text));
    return url && !isGoogleNewsUrl(url) ? remember(url) : null;
  } catch {
    return null;
  }
}
