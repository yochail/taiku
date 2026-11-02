import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDistribution } from '../src/lib/crowd.mjs';
import { calibrate, calibrationTargets, cascade, createReactor, dailyBudget, follows, simulate, syntheticOriginals } from '../src/lib/react.mjs';
import { realPersonas, syntheticPersonas } from './fixtures/pipeline-fixtures.mjs';

const spec = loadDistribution();
const personas = realPersonas();
const targets = calibrationTargets(spec);

test('calibrated rates converge to realism/spec.json over 10k simulated posts', () => {
  const cal = calibrate({ personas, spec });
  assert.ok(cal.k > 0 && Number.isFinite(cal.k));
  const s = simulate({ personas, spec, calibration: cal, days: 180, seed: 'converge' });
  const authored = s.counts.original + s.counts.reply + s.counts.quote;
  assert.ok(authored >= 10000, `authored ${authored}`);
  const a = spec.sampling.activity;
  assert.ok(Math.abs(s.shares.original - a.original) < 0.03, `original ${s.shares.original}`);
  assert.ok(Math.abs(s.shares.reply - a.reply) < 0.03, `reply ${s.shares.reply}`);
  assert.ok(Math.abs(s.shares.quote - a.quote) < 0.02, `quote ${s.shares.quote}`);
  assert.ok(Math.abs(s.likesPerRepost / targets.likesPerRepost - 1) < 0.2, `likes/repost ${s.likesPerRepost}`);
  // roughly half of the roots get no reply at all, like real X
  const zero = s.counts.rootsZeroReply / s.counts.roots;
  assert.ok(zero > 0.3 && zero < 0.75, `zero-reply roots ${zero}`);
});

function trio() {
  const base = { reactivity: 4, popularity: 5, topic_affinity: { ethics: 5, politics: 5 }, x_behavior: { activity: 1, reply_rate: 0.4, like_rate: 0.4, repost_rate: 0.1, quote_rate: 0.1 }, x_profile: { followers: 50000 } };
  const author = { ...base, id: 'author_x', handle: 'author_x', allies: [], rivals: [], frenemies: [] };
  const rival = { ...base, id: 'rival_r', handle: 'rival_r', rivals: [{ id: 'author_x', why: 'beef' }], allies: [], frenemies: [] };
  // pick a neutral id that the synthetic follow graph does not connect to the author
  const neutralId = ['neutral_a', 'neutral_b', 'neutral_c', 'neutral_d', 'neutral_e', 'neutral_f', 'neutral_g'].find((id) => !follows({ id }, author));
  const neutral = { ...base, id: neutralId, handle: neutralId, rivals: [], allies: [], frenemies: [] };
  return { author, rival, neutral };
}

test('beefs react more than neutrals, and lean to reply/quote', () => {
  const { author, rival, neutral } = trio();
  const ps = [author, rival, neutral];
  const counts = { [rival.id]: 0, [neutral.id]: 0 };
  const llm = { [rival.id]: 0, [neutral.id]: 0 };
  for (let i = 0; i < 400; i++) {
    const r = createReactor({ personas: ps, spec, seed: `beef${i}`, nonce: 'n', calibration: { k: 0.05, qTilt: 0.3, rTilt: 1.6 } });
    const post = { id: `p${i}`, authorId: author.id, createdAt: 0, vector: { ethics: 1 }, depth: 0, mentions: new Set(), likes: [], reposts: [] };
    const ev = r.consider(post);
    for (const id of [...post.likes, ...post.reposts]) counts[id]++;
    for (const e of ev) { counts[e.personaId]++; llm[e.personaId]++; }
  }
  assert.ok(counts[rival.id] > 1.6 * counts[neutral.id], `rival ${counts[rival.id]} vs neutral ${counts[neutral.id]}`);
  assert.ok(llm[rival.id] / counts[rival.id] > llm[neutral.id] / Math.max(1, counts[neutral.id]), 'rivals prefer reply/quote');
});

test('fatigue caps per-persona daily activity', () => {
  const r = createReactor({ personas, spec, seed: 'fatigue', nonce: 'x', calibration: { k: 2, qTilt: 0.3, rTilt: 1.6 } });
  const originals = syntheticOriginals(personas, 400, r.rand, 0, r.sampler);
  cascade(r, originals, { horizon: 864e5, personas });
  let capped = 0;
  for (const p of personas) {
    if (p.kind === 'news') continue;
    assert.ok(r.used.get(p.id) <= dailyBudget(p), `${p.id} used ${r.used.get(p.id)} > ${dailyBudget(p)}`);
    if (r.used.get(p.id) === dailyBudget(p)) capped++;
  }
  assert.ok(capped > personas.length / 2, `only ${capped} personas hit their budget under heavy load`);
});

function runOnce(nonce) {
  const r = createReactor({ personas, spec, seed: '2026-11-02:seed', nonce, calibration: { k: 0.07, qTilt: 0.3, rTilt: 1.6 } });
  const originals = syntheticOriginals(personas, 20, r.rand, 0, r.sampler);
  const nodes = cascade(r, originals, { horizon: 864e5, personas });
  return JSON.stringify({ nodes: nodes.map((n) => [n.id, n.authorId, n.createdAt, n.likes, n.reposts]), log: r.reactions });
}

test('same seed+nonce replays exactly; a different nonce changes outcomes', () => {
  assert.equal(runOnce('abc123'), runOnce('abc123'));
  assert.notEqual(runOnce('abc123'), runOnce('def456'));
});

test('reaction log explains every decision (terms, p, draw, action)', () => {
  const r = createReactor({ personas, spec, seed: 'log', nonce: 'n', calibration: { k: 0.07, qTilt: 0.3, rTilt: 1.6 } });
  cascade(r, syntheticOriginals(personas, 5, r.rand, 0, r.sampler), { personas });
  assert.ok(r.reactions.length > 0);
  for (const x of r.reactions) {
    for (const key of ['reactivity', 'affinity', 'relation', 'popularity', 'recency', 'depth', 'fatigue', 'mention']) assert.equal(typeof x.terms[key], 'number', key);
    assert.ok(x.draw < x.p, 'only fired reactions are logged');
    assert.ok(['like', 'repost', 'reply', 'quote'].includes(x.action));
  }
});

test('scales to 60+ synthetic personas (with parody accounts) and still calibrates', () => {
  const synth = syntheticPersonas(64);
  const cal = calibrate({ personas: synth, spec, days: 4 });
  const s = simulate({ personas: synth, spec, calibration: cal, days: 40, originalsPerDay: 40, seed: 'synth' });
  const a = spec.sampling.activity;
  assert.ok(Math.abs(s.shares.reply - a.reply) < 0.05, `reply ${s.shares.reply}`);
  assert.ok(Math.abs(s.shares.quote - a.quote) < 0.04, `quote ${s.shares.quote}`);
  const actors = new Set([...s.perPersona.keys()].map((k) => k.split(':')[1]));
  assert.ok(actors.size > 50, `only ${actors.size} personas ever reacted`);
});

test('LLM cap downgrades replies/quotes to likes', () => {
  const r = createReactor({ personas, spec, seed: 'cap', nonce: 'n', calibration: { k: 0.2, qTilt: 0.3, rTilt: 1.6 }, llmCap: 3 });
  const nodes = cascade(r, syntheticOriginals(personas, 30, r.rand, 0, r.sampler), { personas });
  assert.equal(nodes.filter((n) => n.role !== 'original').length, 3);
  assert.ok(r.reactions.some((x) => x.capped));
});

test('conversation.target_saturation spreads replies over more authors (lower in-degree concentration)', () => {
  const top3 = (sat) => {
    const s2 = { ...spec, sampling: { ...spec.sampling, conversation: { ...(spec.sampling.conversation ?? {}), target_saturation: sat } } };
    let share = 0;
    for (const seed of ['s1', 's2', 's3', 's4']) {
      const { nodes } = simulate({ personas, spec: s2, days: 1, originalsPerDay: 40, seed });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const inD = new Map();
      for (const n of nodes) if (n.role === 'reply' && byId.get(n.parent) && byId.get(n.parent).authorId !== n.authorId) inD.set(byId.get(n.parent).authorId, (inD.get(byId.get(n.parent).authorId) ?? 0) + 1);
      const v = [...inD.values()].sort((a, b) => b - a);
      share += v.slice(0, 3).reduce((a, b) => a + b, 0) / Math.max(1, v.reduce((a, b) => a + b, 0));
    }
    return share / 4;
  };
  assert.ok(top3(1.5) < top3(0), `top-3 share of replies: ${top3(1.5).toFixed(3)} vs ${top3(0).toFixed(3)} without saturation`);
});
