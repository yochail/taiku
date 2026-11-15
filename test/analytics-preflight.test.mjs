import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../scripts/analytics-preflight.mjs';

const account = 'a'.repeat(32);
const analyticsToken = 'fixture-analytics-token';

test('preflight uses only the separate analytics credential for one read query', async () => {
  const calls = [];
  const result = await preflight({ account, analyticsToken, fetcher: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ data: [], private: 'do-not-report' });
  } });
  assert.equal(result.sql.accessible, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/analytics_engine/sql'));
  assert.equal(calls[0].init.headers.authorization, `Bearer ${analyticsToken}`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, 'SHOW TABLES');
  for (const privateValue of [analyticsToken, account, 'do-not-report']) assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.deepEqual(Object.keys(result), ['sql'], 'does not infer plan or headroom');
});

test('missing secret, denied access, malformed response and network failures are surfaced safely', async () => {
  const missing = await preflight({ account, fetcher: async () => assert.fail('must not fall back to another token') });
  assert.equal(missing.sql.status, 'missing secret');
  const denied = await preflight({ account, analyticsToken, fetcher: async () => new Response('private response body', { status: 403 }) });
  assert.deepEqual(denied.sql, { status: 403, accessible: false });
  const malformed = await preflight({ account, analyticsToken, fetcher: async () => new Response('not json') });
  assert.equal(malformed.sql.accessible, false);
  const failed = await preflight({ account, analyticsToken, fetcher: async () => { throw new Error(analyticsToken); } });
  assert.equal(failed.sql.accessible, false);
  assert.ok(!JSON.stringify(failed).includes(analyticsToken));
  await assert.rejects(preflight({ account: '', analyticsToken }), /missing or invalid/);
});
