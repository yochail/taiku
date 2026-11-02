// Real poll votes: Worker /api routes + the per-poll Durable Object, with in-memory fakes for ASSETS, DO storage and caches.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { PollVotes } from '../src/worker/index.mjs';
import { PER_IP, MAX_VOTES, voterKeys } from '../src/worker/polls.mjs';

const ORIGIN = 'https://taiku.example';
const H = 3600e3;
let index, objects, env;

function storage() {
  const m = new Map();
  let alarm = null;
  return {
    m,
    get alarm() { return alarm; },
    async get(k) { return structuredClone(m.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list() { return new Map(m); },
    async setAlarm(t) { alarm = t; },
  };
}

beforeEach(() => {
  index = { open: [['0', '1', '2'], Date.now() + 5 * H], shut: [['a', 'b'], Date.now() - H] };
  objects = new Map();
  env = {
    POLL_SECRET: 'test-secret',
    ASSETS: { fetch: async (req) => (new URL(req.url).pathname === '/_p/polls.json' ? Response.json(index) : new Response('nf', { status: 404 })) },
    POLLS: {
      idFromName: (name) => name,
      get(name) {
        if (!objects.has(name)) { const s = storage(); objects.set(name, { s, obj: new PollVotes({ storage: s }) }); }
        return { fetch: (req) => objects.get(name).obj.fetch(req) };
      },
    },
  };
});

// The Worker caches polls.json per isolate; tests share one module, so all use the same index ids.
const ctx = { waitUntil() {} };
const vote = (id, opt, { ip = '1.1.1.1', ua = 'ua', origin = ORIGIN, ct = 'application/json' } = {}) =>
  worker.fetch(new Request(`${ORIGIN}/api/poll/${id}`, { method: 'POST', body: JSON.stringify({ opt }), headers: { 'content-type': ct, 'cf-connecting-ip': ip, 'user-agent': ua, ...(origin ? { origin } : {}) } }), env, ctx);
const counts = async (ids) => (await worker.fetch(new Request(`${ORIGIN}/api/polls?ids=${ids}`), env, ctx)).json();

test('vote counts once per voter, returns totals, and GET batches known polls only', async () => {
  const r = await vote('open', '1');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).c, { 1: 1 });
  assert.equal((await vote('open', '2')).status, 409, 'same IP+UA cannot vote twice');
  assert.equal((await vote('open', '2', { ua: 'other' })).status, 200);
  const got = await counts('open,shut,nope,../x');
  assert.deepEqual(Object.keys(got).sort(), ['open', 'shut']);
  assert.deepEqual(got.open.c, { 1: 1, 2: 1 });
  assert.deepEqual(got.shut.c, {});
  assert.equal(typeof got.open.at, 'number');
});

test('rejects closed, unknown, invalid options, cross-origin posts and oversized bodies; caps votes per IP', async () => {
  assert.equal((await vote('shut', 'a')).status, 403);
  assert.equal((await vote('nope', '0')).status, 404);
  assert.equal((await vote('open', '9')).status, 400);
  assert.equal((await vote('open', '0', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await vote('open', '0', { ct: 'text/plain' })).status, 415, 'JSON only (no simple cross-site form posts)');
  const big = await worker.fetch(new Request(`${ORIGIN}/api/poll/open`, { method: 'POST', body: JSON.stringify({ opt: '0', pad: 'x'.repeat(400) }), headers: { 'content-type': 'application/json' } }), env, ctx);
  assert.equal(big.status, 400);
  for (let i = 0; i < PER_IP; i++) assert.equal((await vote('open', '0', { ip: '2.2.2.2', ua: `u${i}` })).status, 200);
  assert.equal((await vote('open', '0', { ip: '2.2.2.2', ua: 'one-more' })).status, 429);
  assert.equal((await counts('open')).open.c['0'], PER_IP);
});

test('rate-limit bindings and the global per-poll cap return 429; no secret means no voting', async () => {
  const seen = [];
  env.VOTE_RL = { limit: async ({ key }) => (seen.push(key), { success: seen.length < 2 }) };
  assert.equal((await vote('open', '0', { ip: '3.3.3.3' })).status, 200);
  assert.equal((await vote('open', '0', { ip: '3.3.3.3', ua: 'b' })).status, 429);
  assert.ok(!seen[0].includes('3.3.3.3'), 'rate-limit key is hashed');
  delete env.VOTE_RL;
  env.READ_RL = { limit: async () => ({ success: false }) };
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/polls?ids=open`), env, ctx)).status, 429);
  delete env.READ_RL;
  await objects.get('open').s.put('c', { 1: MAX_VOTES });
  assert.equal((await vote('open', '1', { ip: '4.4.4.4' })).status, 429);
  delete env.POLL_SECRET;
  assert.equal((await vote('open', '1', { ip: '5.5.5.5' })).status, 503);
});

test('voter keys are secret-keyed HMACs that rotate by poll day', async () => {
  const a = await voterKeys('s1', 'p', Date.UTC(2026, 0, 1, 12), '1.2.3.4', 'ua');
  assert.match(a.voter, /^v:[0-9a-f]{64}$/);
  assert.notEqual(a.voter, (await voterKeys('s2', 'p', Date.UTC(2026, 0, 1, 12), '1.2.3.4', 'ua')).voter);
  assert.notEqual(a.voter, (await voterKeys('s1', 'p', Date.UTC(2026, 0, 2, 12), '1.2.3.4', 'ua')).voter);
  assert.equal(a.voter, (await voterKeys('s1', 'p', Date.UTC(2026, 0, 1, 20), '1.2.3.4', 'ua')).voter);
});

test('stores no raw IP/UA, and the alarm 30 days after close forgets voters but keeps totals', async () => {
  await vote('open', '0', { ip: '9.8.7.6', ua: 'Mozilla/5.0 secret' });
  const { s } = objects.get('open');
  const dump = JSON.stringify([...s.m]);
  assert.ok(!dump.includes('9.8.7.6') && !dump.includes('secret'));
  assert.ok(s.alarm >= index.open[1] + 29 * 864e5);
  await objects.get('open').obj.alarm();
  assert.deepEqual([...s.m.keys()], ['c']);
  assert.deepEqual((await counts('open')).open.c, { 0: 1 });
});

test('API degrades cleanly without the Durable Object binding', async () => {
  delete env.POLLS;
  const r = await worker.fetch(new Request(`${ORIGIN}/api/polls?ids=open`), env, ctx);
  assert.equal(r.status, 503);
});
