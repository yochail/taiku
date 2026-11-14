import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { completeThreads, threadCoverage } from '../src/lib/complete-threads.mjs';
import { contentPlan } from '../src/lib/budget.mjs';
import { reactionCount } from '../src/lib/conversation.mjs';
import { seededRng } from '../src/lib/pipeline-util.mjs';
import { selectTopics } from '../src/lib/topics.mjs';
import { planDay, runDaily } from '../src/lib/run.mjs';
import { createMockClient } from '../src/lib/mock.mjs';
import { loadDistribution } from '../src/lib/crowd.mjs';
import { gateDay } from '../src/lib/daygate.mjs';
import { ROOT } from '../src/lib/site.mjs';
import { realPersonas } from './fixtures/pipeline-fixtures.mjs';

const spec = loadDistribution(), personas = realPersonas();
const policy = spec.sampling.conversation.daily_reactions;

test('varied 3-8 replies and an author answer-back per root, budgeted for the upper draw', () => {
  const content = contentPlan({ voice: 120, batch: 120, threadPolicy: policy });
  const plan = planDay({ personas, spec, topics: [], date: '2026-11-02', seed: 'depth', nonce: 'n', tz: 'UTC', content });
  const roots = plan.nodes.filter((n) => !n.parent);
  assert.equal(roots.length, content.originals);
  for (const root of roots) {
    const replies = plan.nodes.filter((n) => n.id.startsWith(`${root.id}.`));
    assert.ok(replies.length >= 3 && replies.length <= 8);
    assert.equal(replies.length, root.plannedReactions);
    assert.ok(replies.some((n) => n.authorId === root.authorId && n.parent !== root.id));
    assert.ok(replies.every((n) => n.exec !== 'pool' && n.role === 'reply'));
  }
  assert.ok(new Set(roots.map((root) => root.plannedReactions)).size >= 3, 'thread counts vary within one plan');
  assert.ok(content.llmReplies >= plan.nodes.filter((n) => n.parent).length, 'reserved reply capacity covers all draws');
  const smaller = contentPlan({ voice: 12, batch: 12, threadPolicy: policy });
  assert.ok(smaller.originals < content.originals);
  assert.equal(contentPlan({ voice: 0, batch: 2, threadPolicy: policy }).originals, 0);
  const upper = contentPlan({ voice: 12, batch: 12, threadPolicy: { ...policy, min: 8, max: 8, weights: [1] } });
  assert.equal(upper.llmReplies, upper.originals * 8);
  assert.ok(upper.replyBatches + Math.max(0, upper.originals - upper.singleTurns) <= 12, 'reply and root batches fit');
  for (const n of [3, 8]) {
    const edge = planDay({ personas, spec, topics: [], date: '2026-11-02', seed: 'edge', nonce: 'n', tz: 'UTC',
      content: { ...smaller, threadPolicy: { ...policy, min: n, max: n, weights: [1] } } });
    for (const root of edge.nodes.filter((node) => !node.parent)) {
      const replies = edge.nodes.filter((node) => node.id.startsWith(`${root.id}.`));
      assert.equal(replies.length, n);
      assert.ok(replies.some((node) => node.authorId === root.authorId && node.parent !== root.id), `${n}-reply answer-back`);
      assert.ok(new Set(replies.map((node) => node.authorId)).size >= 3, `${n}-reply participation`);
    }
  }
});

test('reaction count is seeded, reaches both endpoints and responds to persona popularity/reactivity', () => {
  const draw = (persona) => {
    const rand = seededRng('reaction-count-distribution');
    return Array.from({ length: 2000 }, () => reactionCount(rand, policy, persona));
  };
  const neutral = draw({ popularity: 5, reactivity: 3 });
  assert.deepEqual(new Set(neutral), new Set([3, 4, 5, 6, 7, 8]));
  assert.deepEqual(draw({ popularity: 5, reactivity: 3 }), neutral);
  const total = (a) => a.reduce((s, n) => s + n, 0);
  assert.ok(total(draw({ popularity: 10, reactivity: 5 })) > total(neutral));
  assert.ok(total(draw({ popularity: 1, reactivity: 1 })) < total(neutral));
});

test('quota pruning retains complete threads only; likes, quotes, retaiks and thread parts do not count', () => {
  const posts = [{ id: 'a' }, { id: 'b', personaLikes: ['x', 'y', 'z', 'w'] },
    ...Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, inReplyTo: i ? `r${i - 1}` : 'a', type: 'reply' })),
    { id: 'q', quoteOf: 'b' }, { id: 'rt', retaikOf: 'b' }, { id: 'part', inReplyTo: 'b', type: 'thread_part' }];
  const result = completeThreads(posts, 3, 8);
  assert.equal(result.roots, 1);
  assert.deepEqual(result.posts.map((p) => p.id), ['a', 'r0', 'r1', 'r2']);
  assert.equal(completeThreads(posts.filter((p) => p.id !== 'r2'), 3, 8).roots, 0, 'two replies is incomplete');
  const overflowing = [{ id: 'root' }, ...Array.from({ length: 9 }, (_, i) => ({ id: `over${i}`, inReplyTo: 'root' }))];
  assert.equal(completeThreads(overflowing, 3, 8).roots, 0, 'nine replies violates the upper bound');
});

test('main curated news precedes high-scoring viral posts, with one topic per duplicate URL', () => {
  const items = [
    { id: 'viral', title: 'New technology culture memes', tier: 'community', kind: 'viral', feedId: 'v' },
    { id: 'news', title: 'Science research discovers new planet', url: 'https://example.org/story', tier: 'curated', kind: 'news', feedId: 'n' },
    { id: 'same', title: 'Another headline about the discovery', url: 'https://example.org/story', tier: 'curated', kind: 'news', feedId: 'other' },
  ];
  const r = selectTopics(items, personas, { n: 1, prioritizeNews: true, date: '2026-11-02' });
  assert.deepEqual(r.picks.map((p) => p.id), ['news']);
  assert.ok(r.dropped.some((p) => p.id === 'same' && p.reason === 'duplicate'));
  assert.deepEqual(selectTopics(items, personas, { n: 0, prioritizeNews: true }).picks, []);
});

test('quota exhaustion publishes useful complete threads instead of a shallow partial day', async () => {
  const dir = path.join(ROOT, 'test', '.depth-scratch');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const inner = createMockClient({ maxCalls: 14, nonce: 'depth' });
    const r = await runDaily({ root: dir, date: '2026-11-02', mock: true, quiet: true,
      spec, personas, client: inner, maxCalls: 80, seed: 'depth', nonce: 'depth',
      env: { GEN_EMBEDDINGS: 'off' } });
    assert.equal(r.status, 'complete', JSON.stringify(r.manifest?.completeness));
    assert.ok(r.manifest.budget.budgetHit);
    const posts = [...r.published, ...r.staged];
    const coverage = threadCoverage(posts);
    assert.ok(coverage.roots.length > 0);
    for (const root of coverage.roots) assert.ok(coverage.counts.get(root.id) >= 3 && coverage.counts.get(root.id) <= 8);
    assert.ok(fs.existsSync(r.paths.posts));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deep-thread gate enforces both 3 and 8 boundaries independently of synthetic engagement', () => {
  for (const n of [2, 3, 8, 9]) {
    const posts = [{ id: 'root', authorId: personas[0].id, text: 'A new question for the morning.', type: 'question',
      createdAt: '2026-11-02T10:13:17Z', personaLikes: personas.slice(1, 8).map((p) => p.id) },
    ...Array.from({ length: n }, (_, i) => ({ id: `reply${i}`, authorId: personas[1].id, inReplyTo: 'root',
      text: 'A reply to the question.', type: 'reply', createdAt: '2026-11-02T10:14:17Z' }))];
    const g = gateDay({ posts, personas, spec, threadPolicy: policy });
    assert.equal(g.checks.find((c) => c.id === 'hard.thread_reactions').status, n >= 3 && n <= 8 ? 'pass' : 'fail', `${n} replies`);
  }
});

test('an offline deep-thread day passes blocking checks without weakening voice or content gates', async () => {
  const r = await runDaily({ date: '2026-11-02', dryRun: true, quiet: true, maxCalls: 90,
    spec, personas, env: { GEN_EMBEDDINGS: 'off' }, seed: 'gate-depth', nonce: 'g' });
  const g = gateDay({ posts: [...r.published, ...r.staged], personas, spec, threadPolicy: policy });
  assert.equal(r.status, 'complete');
  assert.equal(g.ok, true, JSON.stringify(g.failures));
  assert.ok(g.checks.some((c) => c.id === 'hard.thread_reactions' && c.status === 'pass'));
  assert.ok(g.checks.some((c) => c.id === 'persona.novelty' && c.blocking));
});
