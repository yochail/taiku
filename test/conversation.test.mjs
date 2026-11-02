import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDistribution } from '../src/lib/crowd.mjs';
import { DEFAULT_CONVERSATION, MOVE_ARCHETYPES, continueProbability, conversationOf, pickMove, turnOf } from '../src/lib/conversation.mjs';
import { seededRng } from '../src/lib/pipeline-util.mjs';
import { cascade, createReactor, syntheticOriginals } from '../src/lib/react.mjs';
import { loadSpec, measure } from '../src/lib/realism.mjs';
import { realPersonas } from './fixtures/pipeline-fixtures.mjs';

const spec = loadDistribution();
const personas = realPersonas();

test('conversationOf: spec block over generic defaults; no spec → defaults', () => {
  assert.deepEqual(conversationOf(null), { ...DEFAULT_CONVERSATION });
  const c = conversationOf({ sampling: { conversation: { continue_probability: 0.9, relation_boost: { rival: 2 } } } });
  assert.equal(c.continue_probability, 0.9);
  assert.equal(c.relation_boost.rival, 2);
  assert.equal(c.relation_boost.ally, DEFAULT_CONVERSATION.relation_boost.ally);
});

test('turnOf: answering the person who replied to you advances the exchange', () => {
  assert.equal(turnOf(null, 'a'), 1);
  assert.equal(turnOf({ role: 'original', authorId: 'a' }, 'b'), 1);
  assert.equal(turnOf({ role: 'reply', authorId: 'b', pairAuthor: 'a', turn: 1 }, 'a'), 2);
  assert.equal(turnOf({ role: 'reply', authorId: 'a', pairAuthor: 'b', turn: 2 }, 'b'), 3);
  assert.equal(turnOf({ role: 'reply', authorId: 'b', pairAuthor: 'a', turn: 2 }, 'c'), 1, 'a third persona starts a new pair');
});

test('continueProbability decays per turn, rivals answer back more, stops at max_turns', () => {
  const c = conversationOf(spec);
  assert.ok(continueProbability(c, 1, 'rival') > continueProbability(c, 1, 'none'));
  assert.ok(continueProbability(c, 2, 'rival') < continueProbability(c, 1, 'rival'));
  assert.equal(continueProbability(c, c.max_turns, 'rival'), 0);
  assert.equal(continueProbability(c, 0, 'rival'), 0);
});

test('pickMove: every move maps to archetypes; allies extend more, rivals rebut/disagree more', () => {
  const c = conversationOf(spec);
  for (const m of Object.keys(c.moves)) assert.ok(MOVE_ARCHETYPES[m]?.length, m);
  const count = (rel) => {
    const rand = seededRng('moves', rel);
    const n = {};
    for (let i = 0; i < 4000; i++) {
      const m = pickMove(rand, c, rel);
      n[m] = (n[m] ?? 0) + 1;
    }
    return n;
  };
  const ally = count('ally');
  const rival = count('rival');
  assert.ok(ally.extend > 2 * rival.extend, JSON.stringify({ ally, rival }));
  assert.ok(rival.rebuttal + rival.disagree > ally.rebuttal + ally.disagree);
});

test('reactor: replied-to personas answer back (A→B→A) and third personas join, budgets hold', () => {
  const run = (sp) => {
    const r = createReactor({ personas, spec: sp, seed: 'convo', nonce: 'n', calibration: { k: 0.07, qTilt: 0.3, rTilt: 1.6 } });
    const nodes = cascade(r, syntheticOriginals(personas, 60, r.rand, 0, r.sampler), { horizon: 864e5, personas });
    for (const p of personas) if (p.kind !== 'news') assert.ok(r.used.get(p.id) <= r.budget.get(p.id), p.id);
    return { nodes, log: r.reactions };
  };
  const on = run(spec);
  const off = run({ ...spec, sampling: { ...spec.sampling, conversation: { continue_probability: 0, third_party_join: 0 } } });
  const exchanges = (nodes) => nodes.filter((n) => (n.turn ?? 1) >= 2).length;
  assert.ok(exchanges(on.nodes) > exchanges(off.nodes), `${exchanges(on.nodes)} vs ${exchanges(off.nodes)}`);
  assert.ok(on.log.some((x) => x.exchange >= 2), 'answer-backs are logged with their turn');
  assert.ok(on.log.some((x) => x.joined), 'third-party joins are logged');
  assert.ok(on.log.filter((x) => x.joined).every((x) => x.draw < x.p && x.terms), 'joins log terms, p and draw');
});

test('realism: back-and-forth metrics on a tiny A→B→A(+C) fixture', () => {
  const t = (m) => new Date(Date.UTC(2026, 11, 1, 10, m, 7)).toISOString();
  const post = (id, authorId, inReplyTo, m) => ({ id, authorId, ...(inReplyTo ? { inReplyTo } : {}), type: inReplyTo ? 'reply' : 'hot_take', text: `text of ${id} with enough words to count`, createdAt: t(m) });
  const [a, b, c] = personas.filter((p) => p.kind !== 'news').map((p) => p.id);
  const posts = [
    post('r1', a, null, 0), post('x1', b, 'r1', 5), post('x2', a, 'x1', 9), post('x3', b, 'x2', 14), post('x4', c, 'x3', 20),
    post('r2', b, null, 1), post('y1', c, 'r2', 7),
    post('r3', c, null, 2),
  ];
  const m = measure(posts, personas, loadSpec());
  assert.equal(m['threads.back_and_forth_share'].value, 0.5, 'one of two conversations has A→B→A');
  assert.equal(m['threads.exchange_turns_median'].value, 3, 'b→a→b: three turns');
  assert.equal(m['threads.third_party_join_share'].value, 1);
  assert.equal(m['threads.replies_per_root_mean'].value, 5 / 3);
});
