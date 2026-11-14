// Cloudflare Worker for a site pack: static assets first; only /p/* runs this script (wrangler
// assets.run_worker_first). Post pages are reassembled from dist/_p (see posts.mjs), byte-identical to
// what build.mjs renders, with the _headers rules for HTML applied and an edge-cache copy per build.
import { assemble, bucketOf, readRecord } from './posts.mjs';
import { handlePolls, PollVotes } from './polls.mjs';
import { handleEngagement, EngagementBudget } from './engagement.mjs';

export { PollVotes, EngagementBudget };

const POST = /^\/p\/([^/]+)(\/|\/index\.html)?$/;
const BROWSER_CACHE = 'public, max-age=0, must-revalidate';
const EDGE_TTL = 'public, max-age=86400';

let metaPromise = null;
function getMeta(env, origin) {
  metaPromise ??= env.ASSETS.fetch(new Request(`${origin}/_p/meta.json`)).then((r) => {
    if (!r.ok) throw new Error(`meta.json HTTP ${r.status}`);
    return r.json();
  });
  return metaPromise.catch((e) => {
    metaPromise = null;
    throw e;
  });
}

async function render(env, origin, meta, id) {
  const bucket = await env.ASSETS.fetch(new Request(`${origin}/_p/${bucketOf(id, meta.n)}.bin`));
  if (!bucket.ok) return null;
  const rec = readRecord(new Uint8Array(await bucket.arrayBuffer()), id);
  return rec ? assemble(meta.segs, rec) : null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/engagement') return handleEngagement(request, env);
    if (url.pathname.startsWith('/api/')) return handlePolls(request, env, ctx);
    const m = POST.exec(url.pathname);
    if (!m || (request.method !== 'GET' && request.method !== 'HEAD')) return env.ASSETS.fetch(request);
    // Same canonical form the assets layer enforces (auto-trailing-slash).
    if (m[2] !== '/') return Response.redirect(`${url.origin}/p/${m[1]}/${url.search}`, 307);
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return env.ASSETS.fetch(request);
    }

    let meta;
    try {
      meta = await getMeta(env, url.origin);
    } catch {
      return env.ASSETS.fetch(request);
    }
    const etag = `"${meta.build}-${m[1]}"`;
    const key = new Request(`${url.origin}/p/${m[1]}/?build=${meta.build}`);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    let res = cache ? await cache.match(key) : undefined;
    if (!res) {
      const html = await render(env, url.origin, meta, id);
      // Not packed: a static fallback file (if the build wrote one) or the site's 404 page.
      if (html == null) return env.ASSETS.fetch(request);
      res = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': EDGE_TTL } });
      if (cache) ctx.waitUntil(cache.put(key, res.clone()));
    }

    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(meta.headers ?? {})) headers.set(k, v);
    headers.set('cache-control', BROWSER_CACHE);
    headers.set('etag', etag);
    // Weak comparison (RFC 9110): Cloudflare weakens the ETag to W/"…" when it compresses the body.
    const inm = (request.headers.get('if-none-match') ?? '').split(',').map((v) => v.trim().replace(/^W\//, ''));
    if (inm.includes(etag) || inm.includes('*')) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : res.body, { status: 200, headers });
  },
};
