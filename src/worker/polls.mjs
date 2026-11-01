// Real poll votes on Workers Free: one SQLite-backed Durable Object per poll (KV storage API).
// The build writes _p/polls.json ({ pollId: [[optionIds], endsMs] }), so the Worker only accepts known
// options while a poll is open. Shown totals = simulated persona/crowd votes (in the HTML) + real votes.
// Privacy: voters are keyed by SHA-256(per-poll random salt | IP | UA); no raw IP/UA is stored, and the
// salt and voter keys are deleted 30 days after the poll closes (only the per-option counts remain).

export const MAX_IDS = 20;
export const PER_IP = 5; // votes per IP per poll (shared NATs, households)
const RETAIN_MS = 30 * 864e5;
const OPEN_TTL = 30;
const CLOSED_TTL = 3600;
const ID = /^[\w.-]{1,80}$/;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });

/** Durable Object: counts and voter keys for one poll. */
export class PollVotes {
  constructor(ctx) {
    this.storage = ctx.storage;
  }

  async fetch(request) {
    const body = request.method === 'POST' ? await request.json() : {};
    if (body.op === 'vote') return json(await this.vote(body));
    return json({ c: (await this.storage.get('c')) ?? {}, at: Date.now() });
  }

  async vote({ opt, opts, ends, ip, ua }) {
    const now = Date.now();
    const c = (await this.storage.get('c')) ?? {};
    if (!(now < ends)) return { error: 'closed', c, at: now };
    if (!opts.includes(opt)) return { error: 'invalid', c, at: now };
    let salt = await this.storage.get('salt');
    if (!salt) {
      salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      await this.storage.put('salt', salt);
      await this.storage.setAlarm(ends + RETAIN_MS);
    }
    const voter = `v:${await sha(`${salt}|${ip}|${ua}`)}`;
    const ipKey = `i:${await sha(`${salt}|${ip}`)}`;
    if (await this.storage.get(voter)) return { error: 'duplicate', c, at: now };
    const n = (await this.storage.get(ipKey)) ?? 0;
    if (n >= PER_IP) return { error: 'limited', c, at: now };
    c[opt] = (c[opt] ?? 0) + 1;
    await this.storage.put({ c, [voter]: 1, [ipKey]: n + 1 });
    return { ok: true, c, at: now };
  }

  /** 30 days after close: forget who voted, keep the totals. */
  async alarm() {
    const keys = [...(await this.storage.list()).keys()].filter((k) => k !== 'c');
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
  }
}

let indexPromise = null;
function pollIndex(env, origin) {
  indexPromise ??= env.ASSETS.fetch(new Request(`${origin}/_p/polls.json`)).then((r) => (r.ok ? r.json() : {}));
  return indexPromise.catch(() => ((indexPromise = null), {}));
}

const STATUS = { closed: 403, invalid: 400, duplicate: 409, limited: 429 };

/** /api/polls?ids=a,b (GET, batched, edge-cached) and /api/poll/<id> (POST {opt}). Returns null for other paths. */
export async function handlePolls(request, env, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (!env.POLLS) return json({ error: 'unavailable' }, 503);
  const index = await pollIndex(env, url.origin);
  const stub = (id) => env.POLLS.get(env.POLLS.idFromName(id));

  if (url.pathname === '/api/polls' && (request.method === 'GET' || request.method === 'HEAD')) {
    const ids = [...new Set((url.searchParams.get('ids') ?? '').split(','))].filter((id) => ID.test(id) && index[id]).slice(0, MAX_IDS);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const out = {};
    await Promise.all(
      ids.map(async (id) => {
        const key = new Request(`${url.origin}/api/_poll/${encodeURIComponent(id)}`);
        let res = cache ? await cache.match(key) : undefined;
        if (!res) {
          const r = await stub(id).fetch(new Request('https://poll/'));
          const ttl = Date.now() < index[id][1] ? OPEN_TTL : CLOSED_TTL;
          res = new Response(await r.text(), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } });
          if (cache) ctx.waitUntil(cache.put(key, res.clone()));
        }
        out[id] = await res.json();
      }),
    );
    return json(out, 200, { 'cache-control': 'public, max-age=0, must-revalidate' });
  }

  const m = /^\/api\/poll\/([^/]+)$/.exec(url.pathname);
  if (m && request.method === 'POST') {
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return json({ error: 'invalid' }, 400);
    }
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);
    const poll = ID.test(id) && index[id];
    if (!poll) return json({ error: 'unknown' }, 404);
    if (!(Date.now() < poll[1])) return json({ error: 'closed' }, 403);
    const raw = await request.text();
    if (raw.length > 256) return json({ error: 'invalid' }, 400);
    let opt;
    try {
      opt = String(JSON.parse(raw).opt);
    } catch {
      return json({ error: 'invalid' }, 400);
    }
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    const ua = (request.headers.get('user-agent') ?? '').slice(0, 256);
    const r = await (await stub(id).fetch(new Request('https://poll/', { method: 'POST', body: JSON.stringify({ op: 'vote', opt, opts: poll[0], ends: poll[1], ip, ua }) }))).json();
    if (r.ok && typeof caches !== 'undefined') ctx.waitUntil(caches.default.delete(new Request(`${url.origin}/api/_poll/${encodeURIComponent(id)}`)));
    return json(r, r.ok ? 200 : STATUS[r.error] ?? 400);
  }
  return json({ error: 'not found' }, 404);
}
