import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEngagement } from '../scripts/verify-engagement.mjs';

const opts = { site: 'taiku', origin: 'https://site.example', account: 'a'.repeat(32), token: 'fixture-token', pause: async () => {} };
test('verification sends one minimal test event and bounded SQL reads, with no credential forwarded to the site', async () => {
  const calls = [];
  const result = await verifyEngagement({ ...opts, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('.json')) return Response.json({ site: 'taiku', posts: ['p1'] });
    if (url.endsWith('/api/engagement')) return new Response(null, { status: 204 });
    return Response.json({ data: [{ events: '1' }] });
  } });
  assert.deepEqual(result, { site: 'taiku', id: 'p1' });
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[1].init.body), { type: 'share', id: 'p1' });
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.equal(calls[2].init.headers.authorization, 'Bearer fixture-token');
});
test('rejected events are never retried or queried; missing delivery makes only three reads', async () => {
  let writes = 0, reads = 0;
  const fetcher = (status) => async (url) => {
    if (url.endsWith('.json')) return Response.json({ site: 'taiku', posts: ['p1'] });
    if (url.endsWith('/api/engagement')) { writes++; return new Response(null, { status }); }
    reads++; return Response.json({ data: [{ events: 0 }] });
  };
  await assert.rejects(verifyEngagement({ ...opts, fetcher: fetcher(429) }), /Event rejected/);
  assert.equal(writes, 1); assert.equal(reads, 0);
  writes = 0;
  await assert.rejects(verifyEngagement({ ...opts, fetcher: fetcher(204) }), /not observed/);
  assert.equal(writes, 1); assert.equal(reads, 3);
});
