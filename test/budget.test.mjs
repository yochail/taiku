import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLlmConfig } from '../src/lib/llm.mjs';
import { contentPlan, neuronsFor, planBudget } from '../src/lib/budget.mjs';

const config = loadLlmConfig();

test('fresh day: 50–90 calls within 80% of every cap, 10% kept as reserve', () => {
  const plan = planBudget({ config });
  assert.ok(plan.totals.calls >= 50 && plan.totals.calls <= 90, `calls ${plan.totals.calls}`);
  assert.ok(plan.totals.neurons <= config.totalCap.cap * config.planShare + 1, `neurons ${plan.totals.neurons}`);
  assert.equal(plan.totals.degraded, false);
  for (const m of plan.models) {
    const p = config.providers.find((x) => x.name === m.name);
    assert.ok(m.allowance <= p.calls, `${m.name} call ceiling`);
    assert.ok(m.allowance * m.perCall <= p.cap * config.planShare + 1e-6, `${m.name} ≤80% of its Neuron cap`);
    assert.equal(m.plan + m.reserve, m.allowance);
    if (m.allowance) assert.ok(m.reserve >= 1 && m.reserve <= Math.ceil(m.allowance * 0.1));
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
