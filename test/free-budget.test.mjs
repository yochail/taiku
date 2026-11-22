import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFreeBudget, freeProvider, ledgerUsage, mergeLedgers, readLedger, requestBound } from '../src/lib/free-budget.mjs';
import { createClient } from '../src/lib/llm.mjs';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/lib/site.mjs';

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
  assert.equal(freeProvider({ ...p, model: '@cf/model', freeTier: true }, { CF_FREE_ONLY: 'true' }), true);
  assert.equal(freeProvider({ ...p, model: '@cf/paid-model' }, { CF_FREE_ONLY: 'true' }), false);
  assert.equal(freeProvider({ ...p, model: '@cf/model', freeTier: true, neuronRate: {} }, { CF_FREE_ONLY: 'true' }), false);
  assert.equal(freeProvider({ ...p, model: 'model:free' }, {}), false, 'suffix alone does not make a Cloudflare model free');
  assert.equal(freeProvider({ ...p, keyEnv: 'OPENROUTER_API_KEY', model: 'model:free' }, {}), true);
  assert.equal(freeProvider({ ...p, keyEnv: 'OPENROUTER_API_KEY', model: 'paid-model' }, { OPENROUTER_FREE_ONLY: 'true' }), false);
  const b = createFreeBudget({ config, day, now: () => '2026-11-15' });
  assert.equal(b.take(p, body), null, 'stop a run crossing UTC midnight');
});

test('both independent free pools remain usable when the other is exhausted', () => {
  const or = { ...p, name: 'or', keyEnv: 'OPENROUTER_API_KEY', capUnit: 'requests', cap: 2, calls: 2, neuronRate: null };
  const cfg = { ...config, providers: [p, or], freePools: { OPENROUTER_API_KEY: { calls: 2 } } };
  const b = createFreeBudget({ config: cfg, day, now });
  assert.ok(b.take(or, body));
  assert.ok(b.take(or, body));
  assert.equal(b.take(or, body), null);
  assert.ok(b.take(p, body), 'OpenRouter exhaustion does not disable Cloudflare');
  assert.ok(b.take(p, body));
  assert.equal(b.take(p, body), null);
  assert.equal(b.usage().a.neurons, config.totalCap.cap);
  assert.equal(b.usage().or.calls, 2);
});

test('NVIDIA requires free-only and serialized-workflow attestations; usage is a per-run bound', () => {
  const nv = { ...p, name: 'nvidia', keyEnv: 'NVIDIA_KAY', model: 'qwen/qwen3.5-122b-a10b', capUnit: 'run', cap: 2, calls: 2 };
  const cfg = { ...config, providers: [p, nv] };
  assert.equal(freeProvider(nv, { NVIDIA_FREE_ONLY: 'true', NVIDIA_KAY_FREE_ONLY: 'true' }), false);
  assert.equal(freeProvider(nv, { NVIDIA_FREE_ONLY: 'true', GITHUB_ACTIONS: 'true', NVIDIA_CI_SERIALIZED: 'true' }), true);
  for (const [siteDay, shares] of [[day, 2], [day, 1], ['2026-11-15', 1]]) {
    const b = createFreeBudget({ config: cfg, day: siteDay, now: () => siteDay, shares, used: { nvidia: { calls: 9999 } } });
    assert.ok(b.take(nv, body));
    assert.ok(b.take(nv, body));
    assert.equal(b.take(nv, body), null);
    assert.ok(b.take(p, body), 'other pools remain available');
  }
});

test('workflow matrix and quota sharing both count the default-on site', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiku-sites-'));
  try {
    for (const [id, cfg] of Object.entries({ taiku: {}, second: { generate: true }, disabled: { generate: false }, unspecified: {} })) {
      fs.mkdirSync(path.join(dir, id));
      fs.writeFileSync(path.join(dir, id, 'site.json'), JSON.stringify(cfg));
    }
    const output = path.join(dir, 'output.txt');
    const env = { ...process.env, SITES_DIR: dir, SITE: 'taiku', GITHUB_ACTIONS: 'false',
      GEN_USAGE_FILE: path.join(dir, 'usage.json'), GITHUB_OUTPUT: output };
    const matrix = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sites.mjs'), '--generate', '--json'], { env, encoding: 'utf8' });
    assert.equal(matrix.status, 0, matrix.stderr);
    assert.deepEqual(JSON.parse(matrix.stdout), ['second', 'taiku']);
    const sync = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'free-budget-sync.mjs')], { env, encoding: 'utf8' });
    assert.equal(sync.status, 0, sync.stderr);
    assert.match(fs.readFileSync(output, 'utf8'), /^remaining=2$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workflow confines NVIDIA to serialized legs with a cross-process cooldown on generate and repair', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'generate.yml'), 'utf8');
  assert.match(workflow, /group: generate/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /NVIDIA_FREE_ONLY: \$\{\{ vars\.NVIDIA_FREE_ONLY \}\}/);
  assert.match(workflow, /NVIDIA_CI_SERIALIZED: 'true'/);
  assert.equal((workflow.match(/NVIDIA_KAY: \$\{\{ secrets\.NVIDIA_KAY \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/if \[ "\$NVIDIA_FREE_ONLY" = "true" \]; then sleep 60; fi/g) ?? []).length, 2);
});
