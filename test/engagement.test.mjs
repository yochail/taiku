import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EngagementBudget, DAILY_LIMIT, MINUTE_LIMIT, handleEngagement, validateEvent } from '../src/worker/engagement.mjs';

const origin = 'https://site.example';
const index = { site: 'fixture', posts: ['p1'], personas: ['thinker'], polls: ['poll1'] };
const request = (body, headers = {}, method = 'POST') => new Request(`${origin}/api/engagement`, {
  method, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  headers: { origin, 'content-type': 'application/json', ...headers },
});

function fixture() {
  let row;
  const points = [];
  const storage = {
    transactionSync: (fn) => fn(),
    sql: {
      exec(query, ...values) {
        if (query.startsWith('SELECT')) return row ? [structuredClone(row)] : [];
        if (query.startsWith('INSERT')) row = { day: values[0], used: values[1], minute: values[2], burst: values[3] };
        return [];
      },
    },
  };
  const ownerEnv = { ENGAGEMENT_ENABLED: 'true', ENGAGEMENT_SITES: 'fixture,other', ENGAGEMENT: { writeDataPoint: (p) => points.push(p) } };
  let budget = new EngagementBudget({ storage }, ownerEnv);
  const env = {
    ENGAGEMENT_ENABLED: 'true',
    ENGAGEMENT_RL: { limit: async ({ key }) => (assert.equal(key, 'engagement'), { success: true }) },
    ASSETS: { fetch: async () => Response.json(index) },
    ENGAGEMENT_BUDGET: { idFromName: (n) => (assert.equal(n, 'account-engagement-v1'), n), get: () => ({ fetch: (r) => budget.fetch(r) }) },
  };
  return { env, ownerEnv, points, storage, get row() { return row; }, set row(v) { row = v; }, restart() { budget = new EngagementBudget({ storage }, ownerEnv); } };
}

test('only known public targets and action types are accepted; client cannot submit poll votes or dimensions', async () => {
  const f = fixture();
  for (const type of ['like', 'bookmark', 'share', 'follow']) {
    assert.equal((await handleEngagement(request({ type, id: type === 'follow' ? 'thinker' : 'p1' }), f.env)).status, 204);
  }
  for (const body of [
    { type: 'poll_vote', id: 'poll1' }, { type: 'view', id: 'p1' }, { type: 'like', id: 'unknown' },
    { type: 'follow', id: 'p1' }, { type: 'like', id: 'thinker' }, { type: 'like', id: '../p1' },
    { type: 'like', id: ' p1 ' }, { type: 'like', id: 'p1', site: 'other' },
    { type: 'like', id: 'p1', ip: '1.2.3.4' }, { type: 'like', id: ['p1'] }, null, [],
  ]) {
    assert.equal(validateEvent(body, index), null);
    assert.equal((await handleEngagement(request(body), f.env)).status, 400);
  }
  assert.equal(f.points.length, 4);
});

test('analytics writes only minimal server-selected fields, ignoring private request headers', async () => {
  const f = fixture();
  const r = await handleEngagement(request({ type: 'like', id: 'p1' }, {
    'cf-connecting-ip': '1.2.3.4', 'user-agent': 'private-agent', cookie: 'private-cookie', referer: `${origin}/private`,
  }), f.env);
  assert.equal(r.status, 204);
  assert.deepEqual(f.points[0].indexes, ['fixture']);
  assert.deepEqual(f.points[0].blobs, ['like', 'p1', 'fixture']);
  assert.equal(f.points[0].doubles[1], 1);
  assert.equal(f.points[0].doubles[0] % 60, 0);
  const dump = JSON.stringify({ points: f.points, row: f.row });
  for (const privateValue of ['1.2.3.4', 'private-agent', 'private-cookie', '/private']) assert.ok(!dump.includes(privateValue));
});

test('same-origin, method, JSON, streamed size and fail-closed rate controls', async () => {
  const f = fixture();
  const body = { type: 'like', id: 'p1' };
  assert.equal((await handleEngagement(request(body, { origin: 'https://evil.example' }), f.env)).status, 403);
  const missingOrigin = request(body); missingOrigin.headers.delete('origin');
  assert.equal((await handleEngagement(missingOrigin, f.env)).status, 403);
  assert.equal((await handleEngagement(request(body, { 'sec-fetch-site': 'cross-site' }), f.env)).status, 403);
  assert.equal((await handleEngagement(request(body, {}, 'GET'), f.env)).status, 405);
  assert.equal((await handleEngagement(request(body, { 'content-type': 'text/plain' }), f.env)).status, 415);
  assert.equal((await handleEngagement(request('x'.repeat(257)), f.env)).status, 400);
  assert.equal((await handleEngagement(request('{'), f.env)).status, 400);
  delete f.env.ENGAGEMENT_RL;
  assert.equal((await handleEngagement(request(body), f.env)).status, 503);
  f.env.ENGAGEMENT_RL = { limit: async () => ({ success: false }) };
  assert.equal((await handleEngagement(request(body), f.env)).status, 429);
  f.env.ENGAGEMENT_RL = { limit: async () => { throw new Error('private information'); } };
  assert.equal((await handleEngagement(request(body), f.env)).status, 503);
  assert.equal(f.points.length, 0);
});

test('explicit disable, absent bindings and browser privacy signals never write', async () => {
  const f = fixture();
  const body = { type: 'like', id: 'p1' };
  for (const header of ['x-engagement-opt-out', 'dnt', 'sec-gpc']) {
    assert.equal((await handleEngagement(request(body, { [header]: '1' }), f.env)).status, 204);
  }
  f.env.ENGAGEMENT_ENABLED = 'false';
  assert.equal((await handleEngagement(request(body), f.env)).status, 503);
  delete f.env.ENGAGEMENT_ENABLED;
  assert.equal((await handleEngagement(request(body), f.env)).status, 503);
  f.env.ENGAGEMENT_ENABLED = 'true';
  delete f.env.ENGAGEMENT_BUDGET;
  assert.equal((await handleEngagement(request(body), f.env)).status, 503);
  assert.equal(f.points.length, 0);
});

test('one persistent budget caps all sites and remains consumed on write failure; UTC day rollover', async () => {
  const f = fixture();
  const now = Date.now;
  let time = Date.UTC(2026, 10, 14, 23, 59, 30);
  Date.now = () => time;
  const event = (site = 'fixture') => new Request('https://budget/', { method: 'POST', body: JSON.stringify({ type: 'share', id: 'p1', site }) });
  try {
    const budget = () => new EngagementBudget({ storage: f.storage }, f.ownerEnv);
    f.row = { day: Math.floor(time / 864e5), used: DAILY_LIMIT - 1, minute: Math.floor(time / 60000), burst: 0 };
    assert.equal((await budget().fetch(event())).status, 204);
    f.restart();
    assert.equal((await budget().fetch(event('other'))).status, 429, 'other site shares the cap after restart');
    assert.equal(f.row.used, DAILY_LIMIT);
    time += 60000;
    assert.equal((await budget().fetch(event('other'))).status, 204);
    assert.equal(f.row.used, 1, 'new UTC day');
    f.row = { day: Math.floor(time / 864e5), used: 1, minute: Math.floor(time / 60000), burst: MINUTE_LIMIT };
    assert.equal((await budget().fetch(event())).status, 429);
    time += 60000;
    f.ownerEnv.ENGAGEMENT.writeDataPoint = () => { throw new Error('private error'); };
    assert.equal((await budget().fetch(event())).status, 503);
    assert.equal(f.row.used, 2, 'failure does not refund reservation');
    delete f.ownerEnv.ENGAGEMENT;
    assert.equal((await budget().fetch(event())).status, 503);
    assert.equal(f.row.used, 2);
    assert.equal((await new EngagementBudget({ storage: f.storage }, { ...f.ownerEnv, ENGAGEMENT_ENABLED: 'false' }).fetch(event())).status, 503);
  } finally {
    Date.now = now;
  }
});

test('client counts only trusted additions/share clicks, once per target per page, without cookies or retries', async () => {
  const sent = [];
  const prefs = {};
  const sandbox = {
    navigator: {}, location: { protocol: 'https:' }, console,
    fetch: async (url, init) => (sent.push({ url, init }), { ok: true }),
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/engagement.js', import.meta.url), 'utf8'), sandbox);
  const client = sandbox.TaikuEngagement.create({ get: (key, fallback) => prefs[key] ?? fallback });
  for (const type of ['like', 'bookmark', 'follow', 'share']) {
    client.track(type, 'p1', false, true);
    client.track(type, 'p1', true, false);
    client.track(type, 'p1', true, true);
    client.track(type, 'p1', false, true);
    client.track(type, 'p1', true, true);
  }
  assert.equal(sent.length, 4);
  assert.deepEqual(sent.map((s) => JSON.parse(s.init.body).type), ['like', 'bookmark', 'follow', 'share']);
  for (const { init } of sent) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), ['id', 'type']);
  }
  prefs.engagementOptOut = true;
  assert.equal(client.optedOut(), true);
  client.track('like', 'p2', true, true);
  prefs.engagementOptOut = false;
  sandbox.navigator.globalPrivacyControl = true;
  client.track('like', 'p2', true, true);
  sandbox.navigator.globalPrivacyControl = false;
  sandbox.navigator.doNotTrack = '1';
  client.track('like', 'p2', true, true);
  sandbox.navigator.doNotTrack = '0';
  client.track('poll_vote', 'poll1', true, true);
  client.track('like', '../p2', true, true);
  assert.equal(sent.length, 4);
  sandbox.fetch = async (url, init) => { sent.push({ url, init }); throw new Error('offline'); };
  client.track('like', 'p2', true, true);
  await Promise.resolve();
  client.track('like', 'p2', true, true);
  assert.equal(sent.length, 5, 'no retry after network error');
});
