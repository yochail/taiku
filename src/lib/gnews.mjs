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
    const page = await fetchImpl(`https://news.google.com/articles/${id}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!page.ok) return null;
    const html = await page.text();
    const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return null;
    const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
    const body = `f.req=${encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]))}`;
    const res = await fetchImpl('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'user-agent': UA },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/\\"garturlres\\",\\"(https?:[^"\\]+(?:\\\\u[0-9a-f]{4}[^"\\]*)*)\\"/i);
    if (!m) return null;
    const url = safeUrl(m[1].replace(/\\\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
    return url && !isGoogleNewsUrl(url) ? remember(url) : null;
  } catch {
    return null;
  }
}
