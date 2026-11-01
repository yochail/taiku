// GIPHY search for the generator (server-side only; never called from the browser).
// Terms: hotlink GIFs from GIPHY's CDN (no rehosting) and show "Powered by GIPHY".
// We store only the GIF id, CDN URL and attribution on the post.
const API = 'https://api.giphy.com/v1/gifs/search';
const RATINGS = ['g', 'pg', 'pg-13'];
const CDN = /^https:\/\/media\d?\.giphy\.com\//;

/**
 * createGiphyClient({ apiKey, maxCalls, rating, fetchImpl })
 * - apiKey: defaults to process.env.GIPHY_API_KEY (repo secret); without it the client is disabled.
 * - maxCalls: hard cap per process (beta keys allow ~100 calls/hour); default GIPHY_MAX_CALLS or 10.
 * Results are cached per query, so repeated moods cost no extra calls.
 */
export function createGiphyClient({
  apiKey = process.env.GIPHY_API_KEY,
  maxCalls = Number(process.env.GIPHY_MAX_CALLS || 10),
  rating = 'pg-13',
  fetchImpl = globalThis.fetch,
} = {}) {
  const cache = new Map();
  let calls = 0;
  const maxIdx = RATINGS.indexOf(rating);
  return {
    get enabled() { return Boolean(apiKey) && calls < maxCalls; },
    get callsUsed() { return calls; },
    /** Returns a post.media gif item, or null (disabled, over budget, no safe result, or API error). */
    async search(query, { rand = Math.random } = {}) {
      const q = String(query ?? '').replace(/[^\p{L}\p{N}' -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
      if (!q || !apiKey) return null;
      if (!cache.has(q)) {
        if (calls >= maxCalls) return null;
        calls++;
        const url = `${API}?${new URLSearchParams({ api_key: apiKey, q, limit: '12', rating, lang: 'en', bundle: 'messaging_non_clips' })}`;
        try {
          const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) { console.warn(`GIPHY search failed: HTTP ${res.status}`); cache.set(q, []); return null; }
          const body = await res.json();
          cache.set(q, (body.data ?? []).map(toItem).filter((it) => it && RATINGS.indexOf(it.rating) <= maxIdx));
        } catch (e) {
          console.warn(`GIPHY search failed: ${e.message}`);
          cache.set(q, []);
          return null;
        }
      }
      const hits = cache.get(q);
      if (!hits.length) return null;
      return { ...hits[Math.floor(rand() * Math.min(5, hits.length))] };
    },
  };
}

function toItem(g) {
  const img = g?.images?.fixed_width ?? g?.images?.downsized;
  const src = img?.url;
  if (!g?.id || !src || !CDN.test(src) || !RATINGS.includes(g.rating)) return null;
  const who = g.user?.display_name || g.username || 'GIPHY';
  const alt = String(g.alt_text || g.title || 'Reaction GIF').replace(/\s+GIF(\s+by\s+.*)?$/i, '').trim() || 'Reaction GIF';
  return {
    kind: 'gif',
    origin: 'giphy',
    giphy_id: g.id,
    src,
    width: Number(img.width) || undefined,
    height: Number(img.height) || undefined,
    alt: `Reaction GIF: ${alt}`,
    rating: g.rating,
    credit: { author: who, license: 'GIPHY Terms of Service', url: g.url || `https://giphy.com/gifs/${g.id}` },
    attribution: 'Powered by GIPHY',
  };
}
