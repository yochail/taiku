import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyEngagement, verificationFailure } from '../scripts/verify-engagement.mjs';

const opts = { site: 'taiku', origin: 'https://site.example', account: 'a'.repeat(32), token: 'fixture-token', pause: async () => {} };
test('deployment propagates piped Wrangler errors rather than claiming publication succeeded', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /run: \|\n\s+set -euo pipefail[\s\S]*wrangler deploy --config "\$cfg" \| tee deploy\.log/);
});
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
test('diagnostics show safe failure stage and status, but omit unexpected private errors', async () => {
  let error;
  try {
    await verifyEngagement({ ...opts, fetcher: async (url) => url.endsWith('.json')
      ? Response.json({ site: 'taiku', posts: ['p1'] })
      : new Response(null, { status: 429 }) });
  } catch (failure) { error = failure; }
  assert.match(verificationFailure(error), /Event rejected \(HTTP 429\); no SQL query performed/);
  assert.doesNotMatch(verificationFailure(new Error('secret-token private-account response')), /secret-token|private-account|response$/);
});
