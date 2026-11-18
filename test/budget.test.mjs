import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLlmConfig } from '../src/lib/llm.mjs';
import { contentPlan, neuronsFor, planBudget } from '../src/lib/budget.mjs';

const config = loadLlmConfig();

test('fresh day: available allowance within shared caps, 5% kept as repair reserve', () => {
  const plan = planBudget({ config });
  assert.ok(plan.totals.calls >= 50 && plan.totals.calls <= config.targetCalls.max, `calls ${plan.totals.calls}`);
  assert.ok(plan.totals.neurons <= config.totalCap.cap * config.planShare + 1, `neurons ${plan.totals.neurons}`);
  assert.equal(plan.totals.degraded, false);
  for (const m of plan.models) {
    const p = config.providers.find((x) => x.name === m.name);
    assert.ok(m.allowance <= p.calls, `${m.name} call ceiling`);
    assert.ok(m.allowance * m.perCall <= p.cap * config.planShare + 1e-6, `${m.name} ≤80% of its Neuron cap`);
    assert.equal(m.plan + m.reserve, m.allowance);
    if (m.allowance) assert.ok(m.reserve >= 1 && m.reserve <= Math.ceil(m.allowance * config.reserveShare));
  }
  assert.ok(plan.content.topics >= 1 && plan.content.llmItems > plan.totals.calls, 'batching: more items than calls');
});

test('Neuron arithmetic per M tokens', () => {
  assert.equal(neuronsFor({ neuronRate: { input: 1e6, output: 2e6 } }, 10, 5), 20);
  assert.equal(Math.round(neuronsFor(config.providers[0], 1e6, 0)), config.providers[0].neuronRate.input);
});

test('degrades gracefully as the quota runs out', () => {
  const full = planBudget({ config });
  const used = Object.fromEntries(config.providers.map((p) => [p.name, p.capUnit === 'requests' ? { calls: Math.ceil(p.calls * 0.85), neurons: 0 } : { calls: 0, neurons: p.cap * 0.85 }]));
  const half = planBudget({ config, used });
  assert.ok(half.totals.calls < full.totals.calls && half.totals.calls > 0);
  assert.ok(half.content.llmItems < full.content.llmItems);
  const gone = Object.fromEntries(config.providers.map((p) => [p.name, { calls: p.calls, neurons: p.cap }]));
  const none = planBudget({ config, used: gone });
  assert.equal(none.totals.calls, 0);
  assert.equal(none.totals.degraded, true);
  assert.equal(none.content.llmItems, 0);
  const capped = planBudget({ config, maxCalls: 12 });
  assert.ok(capped.totals.calls <= 12, 'GEN_MAX_CALLS caps the total');
  assert.ok(capped.roles.voice.calls > 0 && capped.roles.voice.calls >= capped.roles.micro.calls, 'voice is trimmed last');
});

test('content plan scales with the role budgets', () => {
  const a = contentPlan({ voice: 20, batch: 20, micro: 10 });
  const b = contentPlan({ voice: 5, batch: 4, micro: 2 });
  assert.ok(a.topics > b.topics || a.llmItems > b.llmItems);
  assert.equal(b.microPool, 0, 'no micro call without enough micro budget');
  assert.equal(a.microPool, 1);
  assert.deepEqual(contentPlan({}).llmItems, 0);
});

test('combined budgets add independent pools, divide both sites fairly and retain odd requests', () => {
  const available = new Set(config.providers.filter((p) => ['CF_AI_TOKEN', 'OPENROUTER_API_KEY'].includes(p.keyEnv)).map((p) => p.name));
  const orNames = config.providers.filter((p) => p.keyEnv === 'OPENROUTER_API_KEY').map((p) => p.name);
  const used = { [orNames[0]]: { calls: 999, neurons: 0 }, retired: { keyEnv: 'CF_AI_TOKEN', calls: 1, neurons: 1000 } };
  const plan = planBudget({ config, used, available, threadPolicy: { max: 8 }, shares: 1 });
  assert.equal(plan.models.filter((m) => orNames.includes(m.name)).reduce((n, m) => n + m.allowance, 0), 1, 'last OpenRouter request is not rounded away');
  assert.equal(plan.pools.CF_AI_TOKEN.remaining.neurons, 9000, 'retired-model usage still counts');
  assert.ok(plan.totals.calls > 1, 'remaining Cloudflare capacity is added');
  assert.ok(plan.content.originals > 0);
  const half = planBudget({ config, available, shares: 2, threadPolicy: { max: 8 } });
  assert.equal(half.pools.CF_AI_TOKEN.share.neurons, 5000);
  assert.equal(half.pools.OPENROUTER_API_KEY.share.calls, 500);
  assert.equal(half.models.filter((m) => orNames.includes(m.name)).reduce((n, m) => n + m.allowance, 0), 500);
  assert.ok(half.totals.neurons <= 5000);
  for (const m of half.models.filter((m) => orNames.includes(m.name))) assert.ok(m.capacity <= 500, 'rotation ceilings respect site share');
  const exhausted = planBudget({ config, available, used: { [orNames[0]]: { calls: 1000 } } });
  assert.equal(exhausted.pools.OPENROUTER_API_KEY.remaining.calls, 0);
  assert.ok(exhausted.totals.calls > 0, 'an exhausted request pool does not exhaust Neurons');
});

test('OpenRouter free-model pool is 1,000 account-level requests shared across free models and sites', () => {
  const providers = config.providers.filter((p) => p.keyEnv === 'OPENROUTER_API_KEY');
  const names = new Set(providers.map((p) => p.name));
  assert.equal(config.freePools.OPENROUTER_API_KEY.calls, 1000);
  assert.equal(providers.length, 2);
  assert.ok(providers.every((p) => p.model.endsWith(':free') && p.cap === 1000 && p.calls === 1000));

  const available = names;
  const all = planBudget({ config, available, maxCalls: 1000 });
  assert.equal(all.pools.OPENROUTER_API_KEY.remaining.calls, 1000);
  assert.equal(all.models.filter((m) => names.has(m.name)).reduce((n, m) => n + m.allowance, 0), 1000);
  assert.equal(all.totals.calls, 1000);

  const shared = planBudget({ config, available, maxCalls: 1000, shares: 2 });
  assert.equal(shared.pools.OPENROUTER_API_KEY.share.calls, 500);
  assert.equal(shared.models.filter((m) => names.has(m.name)).reduce((n, m) => n + m.allowance, 0), 500);

  const partiallyUsed = planBudget({ config, available, maxCalls: 1000, used: { [providers[0].name]: { calls: 173 } } });
  assert.equal(partiallyUsed.pools.OPENROUTER_API_KEY.remaining.calls, 827);
  assert.equal(partiallyUsed.models.filter((m) => names.has(m.name)).reduce((n, m) => n + m.allowance, 0), 827);
  assert.ok(providers.every((p) => p.model.endsWith(':free')), 'the increased cap contains no paid route');
});
