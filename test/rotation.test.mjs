import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, llmConfig, loadLlmConfig, LlmError } from '../src/lib/llm.mjs';
import { createRotation, discoverModels, hashPick } from '../src/lib/rotation.mjs';
import { planBudget } from '../src/lib/budget.mjs';

const env = { CF_ACCOUNT_ID: 'acc', CF_AI_TOKEN: 'tok' };
const ok = (text = 'hi') => new Response(JSON.stringify({ result: { choices: [{ message: { role: 'assistant', content: JSON.stringify({ text }) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }, success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
const sleep = async () => {};

/** makeClient for createRotation: per-model scripted responses. */
function fakeClients(scripts, seen) {
  return (p, cfg, allowance) => {
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ name: p.name, url, body, auth: init.headers.authorization });
      const r = (scripts[p.name] ?? []).shift();
      if (!r) return ok(`from ${p.name}`);
      return typeof r === 'function' ? r() : r;
    };
    return createClient({ cfg: { ...cfg, rpm: 0 }, fetchImpl, maxCalls: Math.max(1, allowance), sleep, maxAttempts: 2 });
  };
}

const config = loadLlmConfig();

test('config/llm.json: Cloudflare Workers AI only, the four planned models', () => {
  assert.ok(!JSON.stringify(config).includes('github'), 'GitHub Models is retired');
  const byRole = Object.fromEntries(config.providers.map((p) => [p.role, p]));
  assert.equal(byRole.voice.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(byRole.batch.model, '@cf/google/gemma-4-26b-a4b-it');
  assert.ok(byRole.batch.max_tokens >= 1500);
  assert.equal(byRole.micro.model, '@cf/qwen/qwen3-30b-a3b-fp8');
  assert.match(byRole.micro.userPrefix, /\/no_think/);
  assert.equal(byRole.fallback.model, '@cf/openai/gpt-oss-120b');
  assert.ok(!config.providers.some((p) => /llama-3\.1-8b/.test(p.model)), 'deprecated 8b is not used');
  for (const p of config.providers) {
    assert.match(p.baseURL, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/\$\{CF_ACCOUNT_ID\}\/ai\/v1$/);
    assert.equal(p.keyEnv, 'CF_AI_TOKEN');
    assert.ok(['requests', 'neurons'].includes(p.capUnit) && p.cap > 0 && p.rpm > 0 && p.neuronRate?.input > 0 && p.neuronRate?.output > 0);
    const cfg = llmConfig(env, p);
    assert.equal(cfg.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/v1');
    assert.equal(cfg.apiKey, 'tok');
  }
});

test('voice model is assigned deterministically by persona hash, and voices differ', () => {
  const entries = [['a', 1], ['b', 1], ['c', 2]];
  assert.equal(hashPick('voice:socrates', entries), hashPick('voice:socrates', entries));
  const picks = new Set(Array.from({ length: 40 }, (_, i) => hashPick(`voice:p${i}`, entries)));
  assert.equal(picks.size, 3);
});

test('rotation: 429 / quota / 410 mark the model capped and spill to the next one', async () => {
  const plan = planBudget({ config });
  const seen = [];
  const voice = config.providers.find((p) => p.role === 'voice').name;
  const fallback = config.providers.find((p) => p.role === 'fallback').name;
  const rot = createRotation({
    config,
    plan,
    env,
    makeClient: fakeClients({ [voice]: [new Response('Too many requests', { status: 429, headers: { 'retry-after': '3600' } })] }, seen),
  });
  const c = rot.clientFor('voice', 'socrates');
  const r = await c.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(JSON.parse(r.message.content).text, `from ${fallback}`);
  const rep = Object.fromEntries(rot.report().map((m) => [m.name, m]));
  assert.equal(rep[voice]['429s'], 1);
  assert.ok(rep[voice].capped);
  assert.equal(rep[fallback].calls, 1);
  assert.ok(rep[fallback].neurons_est > 0);
  assert.equal(seen[0].auth, 'Bearer tok');
  assert.match(seen[0].url, /accounts\/acc\/ai\/v1\/chat\/completions$/);
  // capped model is not retried
  await rot.clientFor('voice', 'plato').chat({ messages: [{ role: 'user', content: 'y' }] });
  assert.equal(seen.filter((s) => s.name === voice).length, 1);

  const seen2 = [];
  const rot2 = createRotation({ config, plan, env, makeClient: fakeClients({ [voice]: [new Response('model is deprecated', { status: 410 })] }, seen2) });
  await rot2.clientFor('voice', 'kant').chat({ messages: [{ role: 'user', content: 'z' }] });
  assert.match(rot2.report().find((m) => m.name === voice).capped, /410/);
});

test('rotation: micro role gets /no_think, batch role keeps high max_tokens, fallback low reasoning', async () => {
  const seen = [];
  const rot = createRotation({ config, plan: planBudget({ config }), env, makeClient: fakeClients({}, seen) });
  await rot.clientFor('micro').chat({ messages: [{ role: 'user', content: 'tiny' }] });
  await rot.clientFor('batch').chat({ messages: [{ role: 'user', content: 'many' }] });
  await rot.clientFor('fallback').chat({ messages: [{ role: 'user', content: 'fb' }] });
  assert.match(seen[0].body.messages[0].content, /^\/no_think /);
  assert.ok(seen[1].body.max_tokens >= 1500);
  const fb = seen[2].body;
  assert.ok(fb.reasoning?.effort === 'low' || fb.reasoning_effort === 'low');
});

test('rotation: a plain "OK" body (retired GitHub Models style) is a failure, never content', async () => {
  const seen = [];
  const voice = config.providers.find((p) => p.role === 'voice').name;
  const okBody = () => new Response('OK', { status: 200 });
  const rot = createRotation({ config, plan: planBudget({ config }), env, makeClient: fakeClients({ [voice]: [okBody, okBody] }, seen) });
  await assert.rejects(rot.clientFor('voice', 'x').chat({ messages: [{ role: 'user', content: 'q' }] }), (e) => e instanceof LlmError && /non-JSON/.test(e.message));
});

test('rotation: per-model allowance is respected and spills when used up', async () => {
  const plan = planBudget({ config, maxCalls: 60 });
  const seen = [];
  const rot = createRotation({ config, plan, env, makeClient: fakeClients({}, seen) });
  const micro = plan.models.find((m) => m.role === 'micro');
  const c = rot.clientFor('micro');
  for (let i = 0; i < micro.plan + 2; i++) await c.chat({ messages: [{ role: 'user', content: String(i) }] });
  const rep = Object.fromEntries(rot.report().map((m) => [m.role, m]));
  assert.equal(rep.micro.calls, micro.plan, 'never over the planned share');
  assert.equal(rep.batch.calls + rep.fallback.calls, 2, 'spills to the next model with quota left (config.spill)');
});

test('model discovery skips deprecated and missing models', async () => {
  const list = config.providers.map((p, i) => ({ name: p.model, description: i === 0 ? 'Deprecated: use something else' : 'ok', properties: [] })).slice(0, 3);
  const fetchImpl = async (url) => {
    assert.match(url, /\/ai\/models\/search\?task=Text%20Generation/);
    return new Response(JSON.stringify({ success: true, result: list }), { status: 200 });
  };
  const d = await discoverModels({ config, env, fetchImpl });
  assert.deepEqual(d.skipped.map((s) => s.reason.split(' ')[0]).sort(), ['deprecated', 'missing']);
  assert.equal(d.available.size, 2);
  const failed = await discoverModels({ config, env, fetchImpl: async () => new Response('OK', { status: 200 }) });
  assert.equal(failed.available, null, 'a broken discovery skips nothing');
  const plan = planBudget({ config, available: d.available });
  for (const s of d.skipped) assert.equal(plan.models.find((m) => m.name === s.name).allowance, 0);
});
