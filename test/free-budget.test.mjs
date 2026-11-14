import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFreeBudget, freeProvider, ledgerUsage, mergeLedgers, readLedger, requestBound } from '../src/lib/free-budget.mjs';
import { createClient } from '../src/lib/llm.mjs';

const day = '2026-11-14';
const now = () => day;
const p = { name: 'a', keyEnv: 'CF_AI_TOKEN', capUnit: 'neurons', cap: 10000,
  calls: 1000, max_tokens: 10, neuronRate: { input: 1000000, output: 1000000 } };
const body = { messages: [{ role: 'user', content: 'שלום' }], max_tokens: 10 };
const cost = requestBound(p, body).neurons;
const config = { totalCap: { cap: cost * 2 }, providers: [p, { ...p, name: 'b' }] };

test('shared neuron boundary reserves the full request before sending, not after', () => {
  const b = createFreeBudget({ config, day, now });
  assert.ok(b.take(p, body));
  assert.ok(b.take({ ...p, name: 'b' }, body));
  assert.equal(b.take(p, body), null);
  assert.equal(Object.values(b.usage()).reduce((n, u) => n + u.neurons, 0), cost * 2);
});

test('pre-existing usage is added to new charges, never used as a non-additive floor', () => {
  const b = createFreeBudget({ config, day, now, used: { a: { calls: 10, neurons: cost, tokens: cost } } });
  assert.ok(b.take(p, body));
  assert.equal(b.usage().a.calls, 11);
  assert.equal(b.take(p, body), null);
});

test('multi-site reruns restore charges, deduplicate artifact history and reuse actual headroom', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiku-quota-'));
  const file = path.join(dir, 'quota.json');
  try {
    const first = createFreeBudget({ config, day, now, file, shares: 2 });
    first.take(p, body).settle({ prompt_tokens: 10, completion_tokens: 10 });
    const doc = readLedger(file, day);
    assert.deepEqual(ledgerUsage(mergeLedgers([doc, doc], day)), ledgerUsage(doc));
    const second = createFreeBudget({ config, day, now, file, shares: 1 });
    assert.ok(second.take({ ...p, name: 'b' }, body));
    const rerun = createFreeBudget({ config, day, now, file });
    assert.equal(rerun.take(p, body), null, 'the next worst-case request does not fit');
    assert.deepEqual(ledgerUsage(readLedger(file, '2026-11-15')), {}, 'UTC reset only');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shared request and token pools do not multiply across models', () => {
  const providers = ['a', 'b'].map((name) => ({ ...p, name, keyEnv: 'GROQ_API_KEY', capUnit: 'requests' }));
  const cfg = { providers, totalCap: { cap: 10000 }, freePools: { GROQ_API_KEY: { calls: 100, tokens: cost * 2 - 1 } } };
  const b = createFreeBudget({ config: cfg, day, now });
  assert.ok(b.take(providers[0], body));
  assert.equal(b.take(providers[1], body), null, 'one token over shared limit');
});

test('empty responses and retries are charged and cannot overflow the run ceiling', async () => {
  const b = createFreeBudget({ config: { ...config, totalCap: { cap: cost * 10 } }, day, now, maxCalls: 2 });
  let calls = 0;
  const c = createClient({ cfg: { model: 'test', baseUrl: 'https://example.invalid', rpm: 0, maxTokens: 10 },
    sleep: async () => {}, reserve: (request) => b.take(p, request),
    fetchImpl: async () => { calls++; return new Response('{"choices":[{"message":{"content":null}}]}'); } });
  await assert.rejects(c.chat(body), /allowance exhausted/);
  assert.equal(calls, 2);
  assert.equal(b.usage().a.calls, 2);
});

test('free-only attestation excludes paid-capable providers, :free models need none', () => {
  assert.equal(freeProvider({ ...p, model: '@cf/model' }, {}), false);
  assert.equal(freeProvider({ ...p, model: '@cf/model' }, { CF_FREE_ONLY: 'true' }), true);
  assert.equal(freeProvider({ ...p, model: 'model:free' }, {}), true);
  const b = createFreeBudget({ config, day, now: () => '2026-11-15' });
  assert.equal(b.take(p, body), null, 'stop a run crossing UTC midnight');
});
