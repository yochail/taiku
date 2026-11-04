import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, llmConfig, loadLlmConfig, LlmError } from '../src/lib/llm.mjs';
import { createRotation, discoverModels, hashPick } from '../src/lib/rotation.mjs';
import { planBudget } from '../src/lib/budget.mjs';

const env = { CF_ACCOUNT_ID: 'acc', CF_AI_TOKEN: 'tok', GEMINI_API_KEY: 'gem', GROQ_API_KEY: 'groq', OPENROUTER_API_KEY: 'or' };
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

test('config/llm.json: quality-ranked chains (Gemini → OpenRouter → Groq → Workers AI), each key pinned to its host', () => {
  assert.ok(!JSON.stringify(config).includes('github'), 'GitHub Models is retired');
  const model = (n) => config.providers.find((p) => p.name === n)?.model;
  const chain = (r) => config.chains[r].map(model);
  assert.deepEqual(chain('voice'), ['gemini-3.5-flash', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free', '@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
  assert.deepEqual(chain('batch'), ['gemini-3.5-flash', 'nvidia/nemotron-3.5-super-vl:free', 'openai/gpt-oss-120b', '@cf/google/gemma-4-26b-a4b-it']);
  assert.deepEqual(chain('micro'), ['qwen/qwen3.8-27b', '@cf/qwen/qwen3-30b-a3b-fp8']);
  assert.deepEqual(chain('fallback'), ['@cf/openai/gpt-oss-120b']);
  assert.ok(!config.providers.some((p) => /gemma/.test(p.model) && /googleapis/.test(p.baseURL)), 'no gemma via Gemini (leaks <thought>)');
  assert.ok(!config.providers.some((p) => /gemini-2\.5-flash|inkling|llama-3\.1-8b/.test(p.model)));
  const byName = Object.fromEntries(config.providers.map((p) => [p.name, p]));
  assert.ok(byName['cf-gemma-4-26b'].max_tokens >= 1500);
  assert.match(byName['cf-qwen3-30b'].userPrefix, /\/no_think/);
  const hosts = { CF_AI_TOKEN: 'api.cloudflare.com', GEMINI_API_KEY: 'generativelanguage.googleapis.com', GROQ_API_KEY: 'api.groq.com', OPENROUTER_API_KEY: 'openrouter.ai' };
  for (const p of config.providers) {
    assert.ok(hosts[p.keyEnv], `${p.name} key env`);
    assert.ok(['requests', 'neurons'].includes(p.capUnit) && p.cap > 0 && p.rpm > 0 && p.calls > 0);
    if (p.capUnit === 'neurons') assert.ok(p.neuronRate?.input > 0 && p.neuronRate?.output > 0);
    const cfg = llmConfig(env, p);
    assert.equal(new URL(cfg.baseUrl).hostname, hosts[p.keyEnv]);
    assert.equal(cfg.apiKey, env[p.keyEnv]);
    // the key never goes to another host
    assert.equal(llmConfig(env, { ...p, baseURL: 'https://evil.example/v1' }).apiKey, '');
  }
  assert.equal(llmConfig(env, config.providers.find((p) => p.keyEnv === 'CF_AI_TOKEN')).baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/v1');
});

test('voice model is assigned deterministically by persona hash, and voices differ', () => {
  const entries = [['a', 1], ['b', 1], ['c', 2]];
  assert.equal(hashPick('voice:socrates', entries), hashPick('voice:socrates', entries));
  const picks = new Set(Array.from({ length: 40 }, (_, i) => hashPick(`voice:p${i}`, entries)));
  assert.equal(picks.size, 3);
});

test('rotation: a 429 / quota / 410 moves straight on to the next model in the chain', async () => {
  const plan = planBudget({ config });
  const seen = [];
  const [voice, next] = config.chains.voice;
  const rot = createRotation({
    config,
    plan,
    env,
    makeClient: fakeClients({ [voice]: [new Response('Too many requests', { status: 429, headers: { 'retry-after': '2' } })] }, seen),
  });
  const c = rot.clientFor('voice', 'socrates');
  const r = await c.chat({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(JSON.parse(r.message.content).text, `from ${next}`);
  assert.equal(seen.filter((s) => s.name === voice).length, 1, 'no in-place retry on 429');
  const rep = Object.fromEntries(rot.report().map((m) => [m.name, m]));
  assert.equal(rep[voice]['429s'], 1);
  assert.ok(rep[voice].capped);
  assert.equal(rep[next].calls, 1);
  assert.equal(seen[0].auth, 'Bearer gem');
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(seen[1].auth, 'Bearer or');
  assert.equal(seen[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  // capped model is not retried
  await rot.clientFor('voice', 'plato').chat({ messages: [{ role: 'user', content: 'y' }] });
  assert.equal(seen.filter((s) => s.name === voice).length, 1);

  const seen2 = [];
  const rot2 = createRotation({ config, plan, env, makeClient: fakeClients({ [voice]: [new Response('model is deprecated', { status: 410 })] }, seen2) });
  await rot2.clientFor('voice', 'kant').chat({ messages: [{ role: 'user', content: 'z' }] });
  assert.match(rot2.report().find((m) => m.name === voice).capped, /410/);

  // Every chain ends in Workers AI: with all external models capped, voice lands on CF llama.
  const seen3 = [];
  const r429 = () => new Response('rate limited', { status: 429 });
  const scripts = Object.fromEntries(config.chains.voice.slice(0, -1).map((n) => [n, [r429]]));
  const rot3 = createRotation({ config, plan, env, makeClient: fakeClients(scripts, seen3) });
  const r3 = await rot3.clientFor('voice', 'hume').chat({ messages: [{ role: 'user', content: 'w' }] });
  assert.equal(JSON.parse(r3.message.content).text, 'from cf-llama-3.3-70b');
  assert.match(seen3.at(-1).url, /accounts\/acc\/ai\/v1\/chat\/completions$/);
  assert.equal(seen3.at(-1).auth, 'Bearer tok');
});

test('rotation: a 413 or an empty reply moves this request to the next model without capping', async () => {
  const plan = planBudget({ config });
  const [micro, next] = config.chains.micro;
  const tooLarge = () => new Response('Request too large for model', { status: 413 });
  const empty = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null } }] }), { status: 200 });
  // 413 is not retried in place; an empty reply is retried once (maxAttempts 2) before moving on.
  for (const script of [[tooLarge], [empty, empty]]) {
    const seen = [];
    const rot = createRotation({ config, plan, env, makeClient: fakeClients({ [micro]: script }, seen) });
    const r = await rot.clientFor('micro').chat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(JSON.parse(r.message.content).text, `from ${next}`);
    assert.ok(!rot.report().find((m) => m.name === micro).capped, 'model stays usable for later requests');
    const r2 = await rot.clientFor('micro').chat({ messages: [{ role: 'user', content: 'y' }] });
    assert.equal(JSON.parse(r2.message.content).text, `from ${micro}`);
  }
});

test('llm client: an assistant tool-call message with content null is sent as "" (Workers AI rejects null)', async () => {
  const bodies = [];
  const c = createClient({ cfg: { ...llmConfig(env), rpm: 0 }, fetchImpl: async (u, init) => (bodies.push(JSON.parse(init.body)), ok()), sleep });
  await c.chat({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'r' }] });
  assert.equal(bodies[0].messages[1].content, '');
  assert.equal(bodies[0].messages[1].tool_calls.length, 1);
});

test('config/llm.json: reasoning that eats max_tokens is switched off', () => {
  const byName = Object.fromEntries(config.providers.map((p) => [p.name, p]));
  for (const n of ['or-nemotron-3-ultra', 'or-nemotron-3.5-super']) assert.equal(byName[n].extra?.reasoning?.enabled, false, n);
  assert.equal(byName['cf-gemma-4-26b'].extra?.chat_template_kwargs?.enable_thinking, false);
});

test('rotation: providers without their secret are skipped (live runs)', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return ok('cf');
  };
  const cfOnly = { CF_ACCOUNT_ID: 'acc', CF_AI_TOKEN: 'tok' };
  const rot = createRotation({ config, plan: planBudget({ config }), env: cfOnly, fetchImpl, sleep });
  const r = await rot.clientFor('voice', 'kant').chat({ messages: [{ role: 'user', content: 'q' }] });
  assert.equal(JSON.parse(r.message.content).text, 'cf');
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /api\.cloudflare\.com/);
  assert.match(rot.report().find((m) => m.name === 'gemini-3.5-flash').capped ?? '', /GEMINI_API_KEY/);
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
  const voice = config.chains.voice[0];
  const okBody = () => new Response('OK', { status: 200 });
  const rot = createRotation({ config, plan: planBudget({ config }), env, makeClient: fakeClients({ [voice]: [okBody, okBody] }, seen) });
  await assert.rejects(rot.clientFor('voice', 'x').chat({ messages: [{ role: 'user', content: 'q' }] }), (e) => e instanceof LlmError && /non-JSON/.test(e.message));
});

test('rotation: per-model allowance is respected and spills when used up', async () => {
  const plan = planBudget({ config: { ...config, targetCalls: { min: 0, max: 1e6 } } });
  const seen = [];
  const rot = createRotation({ config, plan, env, makeClient: fakeClients({}, seen) });
  const microPlan = Object.fromEntries(plan.models.filter((m) => m.role === 'micro').map((m) => [m.name, m.allowance]));
  const total = Object.values(microPlan).reduce((a, b) => a + b, 0);
  const c = rot.clientFor('micro');
  for (let i = 0; i < total + 2; i++) await c.chat({ messages: [{ role: 'user', content: String(i) }] });
  const rep = rot.report();
  for (const [n, p] of Object.entries(microPlan)) assert.equal(rep.find((m) => m.name === n).calls, p, `${n} never over its allowance (plan + reserve)`);
  assert.equal(seen[0].name, config.chains.micro[0], 'chain order: Groq qwen first');
  const spilled = rep.filter((m) => m.role !== 'micro').reduce((s, m) => s + m.calls, 0);
  assert.equal(spilled, 2, 'spills to the next model with quota left (config.spill)');
});

test('model discovery skips deprecated and missing models', async () => {
  const cf = config.providers.filter((p) => p.keyEnv === 'CF_AI_TOKEN');
  const list = cf.map((p, i) => ({ name: p.model, description: i === 0 ? 'Deprecated: use something else' : 'ok', properties: [] })).slice(0, cf.length - 1);
  const fetchImpl = async (url) => {
    assert.match(url, /\/ai\/models\/search\?task=Text%20Generation/);
    return new Response(JSON.stringify({ success: true, result: list }), { status: 200 });
  };
  const d = await discoverModels({ config, env, fetchImpl });
  assert.deepEqual(d.skipped.map((s) => s.reason.split(' ')[0]).sort(), ['deprecated', 'missing']);
  assert.equal(d.available.size, config.providers.length - 2, 'non-Cloudflare providers are not judged by the CF catalogue');
  const failed = await discoverModels({ config, env, fetchImpl: async () => new Response('OK', { status: 200 }) });
  assert.equal(failed.available, null, 'a broken discovery skips nothing');
  const plan = planBudget({ config, available: d.available });
  for (const s of d.skipped) assert.equal(plan.models.find((m) => m.name === s.name).allowance, 0);
});

test('rotation: the day-size total (GEN_MAX_CALLS / targetCalls) is a hard cap across all models', async () => {
  const plan = planBudget({ config, maxCalls: 10 });
  assert.equal(plan.totals.calls, 10);
  const rot = createRotation({ config, plan, env, makeClient: fakeClients({}, []) });
  const c = rot.clientFor('micro');
  let n = 0;
  await assert.rejects(async () => {
    for (;;) {
      await c.chat({ messages: [{ role: 'user', content: String(n) }], _repair: true });
      n++;
    }
  }, /quota left/);
  assert.equal(n, 10);
  assert.equal(rot.calls, 10);
});
