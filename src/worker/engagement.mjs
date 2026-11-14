// Only this singleton Durable Object writes Analytics Engine points. Share its namespace across packs.
export const DAILY_LIMIT = 90000; // Account-wide headroom below the 100,000/day free inclusion.
export const MINUTE_LIMIT = 60;
const ID = /^[A-Za-z0-9_.-]{1,80}$/;
const SITE = /^[a-z0-9-]{1,40}$/;
const TYPES = new Set(['like', 'bookmark', 'follow', 'share', 'poll_vote']);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const enabled = (env) => env.ENGAGEMENT_ENABLED === 'true' && !!env.ENGAGEMENT_BUDGET;
export const optedOut = (request) => request.headers.get('x-engagement-opt-out') === '1'
  || request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1';

export async function readEvent(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing body');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256) { await reader.cancel(); throw new Error('oversized body'); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

const indexes = new WeakMap();
async function eventIndex(env, origin) {
  let pending = indexes.get(env.ASSETS);
  if (!pending) {
    pending = env.ASSETS.fetch(new Request(`${origin}/_p/engagement.json`)).then(async (r) => {
      if (!r.ok) throw new Error('engagement index unavailable');
      return r.json();
    });
    indexes.set(env.ASSETS, pending);
  }
  try { return await pending; } catch (e) { indexes.delete(env.ASSETS); throw e; }
}

export function validateEvent(body, index) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'id,type'
    || !TYPES.has(body.type) || body.type === 'poll_vote'
    || typeof body.id !== 'string' || !ID.test(body.id) || !SITE.test(index.site)) return null;
  const ids = body.type === 'follow' ? index.personas : index.posts;
  return Array.isArray(ids) && ids.includes(body.id) ? { type: body.type, id: body.id, site: index.site } : null;
}

export async function recordEngagement(env, event) {
  if (!enabled(env)) return false;
  try {
    const stub = env.ENGAGEMENT_BUDGET.get(env.ENGAGEMENT_BUDGET.idFromName('account-engagement-v1'));
    const response = await stub.fetch(new Request('https://engagement.internal/', {
      method: 'POST', body: JSON.stringify(event),
    }));
    if (response.status === 503) console.warn('Engagement analytics unavailable');
    return response.ok;
  } catch {
    console.warn('Engagement analytics unavailable');
    return false;
  }
}

export async function recordPollVote(request, env, id) {
  if (!enabled(env) || optedOut(request) || request.headers.get('origin') !== new URL(request.url).origin) return;
  try {
    const index = await eventIndex(env, new URL(request.url).origin);
    if (ID.test(id) && SITE.test(index.site) && index.polls?.includes(id)) {
      await recordEngagement(env, { type: 'poll_vote', id, site: index.site });
    }
  } catch {
    console.warn('Engagement index unavailable');
  }
}

export async function handleEngagement(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/engagement') return null;
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!enabled(env)) return json({ error: 'disabled' }, 503);
  if (request.headers.get('origin') !== url.origin
    || (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) {
    return json({ error: 'forbidden' }, 403);
  }
  if (optedOut(request)) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'unsupported' }, 415);
  if (Number(request.headers.get('content-length')) > 256) return json({ error: 'invalid' }, 400);
  // A constant key, not a client/IP key; missing or failing limiter fails closed.
  if (!env.ENGAGEMENT_RL) return json({ error: 'unavailable' }, 503);
  try {
    if (!(await env.ENGAGEMENT_RL.limit({ key: 'engagement' })).success) return json({ error: 'limited' }, 429);
  } catch {
    console.warn('Engagement rate limiter unavailable');
    return json({ error: 'unavailable' }, 503);
  }
  let body;
  try { body = await readEvent(request); } catch { return json({ error: 'invalid' }, 400); }
  let index;
  try { index = await eventIndex(env, url.origin); } catch {
    console.warn('Engagement index unavailable');
    return json({ error: 'unavailable' }, 503);
  }
  const event = validateEvent(body, index);
  if (!event) return json({ error: 'invalid' }, 400);
  return (await recordEngagement(env, event))
    ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    : json({ error: 'not recorded' }, 429);
}

export class EngagementBudget {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.env = env;
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY, day INTEGER, used INTEGER, minute INTEGER, burst INTEGER)');
  }

  async fetch(request) {
    const env = this.env;
    if (env.ENGAGEMENT_ENABLED !== 'true' || !env.ENGAGEMENT) return json({ error: 'disabled' }, 503);
    let event;
    try { event = await readEvent(request); } catch { return json({ error: 'invalid' }, 400); }
    const sites = (env.ENGAGEMENT_SITES ?? '').split(',');
    if (!event || Object.keys(event).sort().join(',') !== 'id,site,type' || !TYPES.has(event.type)
      || typeof event.id !== 'string' || !ID.test(event.id) || !SITE.test(event.site) || !sites.includes(event.site)) {
      return json({ error: 'invalid' }, 400);
    }
    const now = Date.now();
    const day = Math.floor(now / 864e5);
    const minute = Math.floor(now / 60000);
    // Synchronous reservation + write: no await crosses midnight, no write inside a retried transaction.
    const reserved = this.storage.transactionSync(() => {
      const row = [...this.storage.sql.exec('SELECT day, used, minute, burst FROM budget WHERE id = 1')][0];
      const used = row?.day === day ? row.used : 0;
      const burst = row?.minute === minute ? row.burst : 0;
      if (used >= DAILY_LIMIT || burst >= MINUTE_LIMIT) return false;
      this.storage.sql.exec('INSERT OR REPLACE INTO budget (id, day, used, minute, burst) VALUES (1, ?, ?, ?, ?)', day, used + 1, minute, burst + 1);
      return true;
    });
    if (!reserved) return json({ error: 'limited' }, 429);
    try {
      env.ENGAGEMENT.writeDataPoint({
        indexes: [event.site],
        blobs: [event.type, event.id, event.site],
        doubles: [minute * 60, 1],
      });
    } catch {
      // Keep the reservation consumed: failures must never increase the free-budget allowance.
      console.warn('Engagement write failed');
      return json({ error: 'unavailable' }, 503);
    }
    return new Response(null, { status: 204 });
  }
}
