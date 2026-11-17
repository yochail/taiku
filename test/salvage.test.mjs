import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPersonas, validate } from '../src/lib/data.mjs';
import { loadSpec } from '../src/lib/realism.mjs';
import { salvageDay } from '../src/lib/salvage.mjs';
import { threadCoverage } from '../src/lib/complete-threads.mjs';

const personas = loadPersonas();
const authors = personas.filter((p) => p.kind !== 'news');
const spec = loadSpec();
const isolated = { ...spec, metrics: {}, gate: { ...spec.gate, min_media_items: 0, blocking: [], novelty_blocking: false } };
const post = (id, index, over = {}) => ({ id, authorId: authors[index % authors.length].id,
  type: 'hot_take', text: 'a short observation.', origin: 'cloudflare',
  createdAt: `2026-11-17T10:${String(index).padStart(2, '0')}:17Z`, ...over });
const recover = (posts, over = {}) => salvageDay({ posts, personas, spec: isolated, ...over });

test('salvage excludes a long leaf instead of discarding a whole otherwise valid day', () => {
  const posts = Array.from({ length: 10 }, (_, i) => post(`p${i}`, i, i < 3 ? { text: 'x'.repeat(160) } : {}));
  const result = recover(posts);
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.posts.length, 8);
  assert.equal(result.gate.checks.find((c) => c.id === 'hard.over_140_share').value, 1 / 8);
  assert.ok(result.report.omitted.every((p) => p.reasons.some((r) => r.includes('hard.over_140_share'))));
  for (const p of result.posts) assert.equal(p, posts.find((q) => p.id === q.id), 'never rewrite or truncate retained posts');
});

test('schema/quote/policy rejects and their dependent replies are omitted, complete threads retained', () => {
  const roots = ['safe', 'bad'];
  const posts = roots.flatMap((id, i) => [post(id, i * 5, i ? { text: 'visit https://example.com' } : {}),
    ...Array.from({ length: 3 }, (_, j) => post(`${id}-r${j}`, i * 5 + j + 1, { inReplyTo: id, type: 'joke' }))]);
  posts.push(post('bad-quote', 11, { text: '"a fabricated quotation with many invented words about this world"' }));
  posts.push(post('bad-schema', 12, { extraField: true }));
  const result = recover(posts, { threadPolicy: { min: 3, max: 8 } });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.deepEqual(result.posts.map((p) => p.id), ['safe', 'safe-r0', 'safe-r1', 'safe-r2']);
  assert.ok(result.report.omitted.find((p) => p.id === 'bad').reasons.some((r) => r.startsWith('policy:')));
  assert.ok(result.report.omitted.find((p) => p.id === 'bad-quote').reasons.some((r) => r.includes('quoteRef')));
  assert.ok(result.report.omitted.find((p) => p.id === 'bad-schema').reasons.some((r) => r.includes('extraField')));
  assert.deepEqual(validate(personas, result.posts), []);
  assert.deepEqual([...threadCoverage(result.posts).counts.values()], [3]);
});

test('an unsafe reply causing a thread to fall below the reply floor removes that whole thread', () => {
  const posts = [post('root', 0), ...Array.from({ length: 3 }, (_, j) => post(`r${j}`, j + 1, {
    inReplyTo: 'root', type: 'joke', ...(j === 2 ? { text: 'https://example.com' } : {}) }))];
  const result = recover(posts, { threadPolicy: { min: 3, max: 8 } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.posts, []);
  assert.equal(result.report.omitted.length, posts.length);
  assert.ok(result.report.remainingFailures.includes('hard.thread_reactions'));
});

test('salvage never relaxes a blocking media requirement and never duplicates existing IDs', () => {
  const result = recover([post('one', 0)], { spec: { ...isolated, gate: { ...isolated.gate, min_media_items: 1 } } });
  assert.equal(result.ok, false);
  assert.ok(result.report.remainingFailures.includes('hard.media_items'));
  const duplicate = recover([post('same', 0), post('new', 1)], { context: [post('same', 0)] });
  assert.equal(duplicate.ok, true);
  assert.deepEqual(duplicate.posts.map((p) => p.id), ['new']);
  assert.ok(duplicate.report.omitted.find((p) => p.id === 'same').reasons.includes('already published'));
});
