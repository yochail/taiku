// The other pipeline tests run with `mock: true`, which also sets `offline` and skips every network-only
// branch of runDaily (real-post candidates, live unfurls, usage accounting, model rotation). A
// ReferenceError in those branches (e.g. a missing `shuffle` import) shipped unnoticed and broke the
// daily workflow. This runs the live (non-offline) code path end to end with a mock LLM client and
// stubbed network so undefined identifiers there fail `npm test`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/data.mjs';
import { loadDistribution } from '../src/lib/crowd.mjs';
import { runDaily } from '../src/lib/run.mjs';
import { createMockClient } from '../src/lib/mock.mjs';
import { createEmbedder } from '../src/lib/embed.mjs';
import { FEEDS, fixtureFetch } from '../src/lib/news.mjs';
import { realPersonas } from './fixtures/pipeline-fixtures.mjs';

const SCRATCH = path.join(ROOT, 'test', '.live-path-scratch');
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

test('live (non-offline) runDaily path completes with a mock client and stubbed network', async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const spec = loadDistribution();
  assert.ok(spec.sampling?.real_posts, 'spec enables real posts, so the bluesky candidate branch runs');
  const linkCalls = [];
  const linkFetch = async (url) => {
    linkCalls.push(String(url));
    return new Response('not found', { status: 404 });
  };
  const r = await runDaily({
    date: '2026-11-02',
    maxCalls: 90,
    quiet: true,
    seed: 'live-path',
    nonce: 'live1',
    spec,
    personas: realPersonas(),
    env: { NEWS_FEEDS: '', GEN_EMBEDDINGS: 'off' },
    root: SCRATCH,
    client: createMockClient({ nonce: 'live1' }),
    fetchImpl: fixtureFetch(FEEDS),
    linkFetch,
    embedder: await createEmbedder({ mode: 'hash' }),
  });
  assert.notEqual(r.error, 'no-key');
  assert.ok([0, 2].includes(r.exitCode), `live path finished (status ${r.status}, error ${r.error ?? '-'})`);
  assert.equal(r.path, 'cloudflare', 'ran the non-mock path');
  assert.ok(linkCalls.some((u) => /bsky/.test(u)), 'real-post candidate fetch ran');
});
