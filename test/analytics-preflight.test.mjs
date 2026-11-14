import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../scripts/analytics-preflight.mjs';

const account = 'a'.repeat(32);
const token = 'fixture-not-a-credential';

test('production preflight only reads metadata and never exposes credentials or response data', async () => {
  const calls = [];
  const result = await preflight({ account, token, fetcher: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/subscriptions') || url.endsWith('/sql')
      ? new Response('private response body', { status: 403 })
      : Response.json({ success: true, result: { default_usage_model: 'standard' } });
  } });
  assert.equal(result.settings.accessible, true);
  assert.equal(result.subscriptions.status, 403);
  assert.equal(result.sql.status, 403);
  assert.equal(result.workersFreeVerified, false);
  assert.equal(result.headroomVerified, false);
  assert.deepEqual(calls.map((c) => c.init.method), ['GET', 'GET', 'POST']);
  assert.equal(calls[2].init.body, 'SHOW TABLES', 'one read query; no event writes or row contents');
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(account));
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('successful reads or missing subscriptions do not infer free entitlement or quota headroom', async () => {
  const check = async (plans) => preflight({ account, token, fetcher: async (url) => Response.json({
    success: true, result: url.endsWith('/subscriptions') ? plans.map((id) => ({ rate_plan: { id } })) : {},
  }) });
  assert.equal((await check([])).workersFreeVerified, false);
  assert.equal((await check(['WORKERS_PAID'])).workersFreeVerified, false);
  assert.equal((await check(['WORKERS_FREE', 'WORKERS_PAID'])).workersFreeVerified, false);
  const free = await check(['WORKERS_FREE']);
  assert.equal(free.workersFreeVerified, true);
  assert.equal(free.headroomVerified, false);
});

test('network failures, malformed responses and missing credentials fail closed without private error details', async () => {
  const failed = await preflight({ account, token, fetcher: async () => { throw new Error(token); } });
  assert.equal(failed.sql.accessible, false);
  assert.ok(!JSON.stringify(failed).includes(token));
  await assert.rejects(preflight({ account: '', token }), /credentials are missing/);
});
