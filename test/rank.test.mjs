import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/rank.js';

const R = globalThis.TaikuRank;
const H = 3600000;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const item = (id, a, hAgo, o = {}) => ({ id, a, t: NOW - hAgo * H, l: 10, r: 1, rt: 1, m: false, ...o });
const ctx = (o = {}) => ({ now: NOW, seed: 42, seen: {}, follows: new Set(), affinity: {}, ...o });

test('recency halves every 24h and engagement is log-scaled', () => {
  assert.equal(R.recency(item('a', 'x', 0), NOW), 1);
  assert.ok(Math.abs(R.recency(item('a', 'x', 24), NOW) - 0.5) < 1e-9);
  const e1 = R.engagement({ l: 9 });
  const e2 = R.engagement({ l: 99 });
  assert.ok(Math.abs(e1 - 2) < 1e-9 && Math.abs(e2 - 3) < 1e-9);
});

test('ranking is deterministic for a seed and changes with the seed', () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`p${i}`, `a${i % 7}`, 1 + (i % 3) * 0.01, { l: 100 }));
  const a = R.rankFeed(items, ctx()).fresh.map((x) => x.id);
  const b = R.rankFeed(items, ctx()).fresh.map((x) => x.id);
  const c = R.rankFeed(items, ctx({ seed: 7 })).fresh.map((x) => x.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('followed and liked authors get boosted', () => {
  const items = [item('p1', 'stranger', 1), item('p2', 'friend', 3)];
  assert.equal(R.rankFeed(items, ctx()).fresh[0].id, 'p1');
  assert.equal(R.rankFeed(items, ctx({ follows: new Set(['friend']) })).fresh[0].id, 'p2');
  assert.equal(R.rankFeed(items, ctx({ affinity: { friend: 4 } })).fresh[0].id, 'p2');
});

test('seen once goes after the fresh posts; seen twice is hidden', () => {
  const items = [item('new', 'a', 30), item('once', 'b', 0), item('twice', 'c', 0)];
  const seen = { once: [1, NOW], twice: [2, NOW] };
  const r = R.rankFeed(items, ctx({ seen }));
  assert.deepEqual(r.fresh.map((x) => x.id), ['new']);
  assert.deepEqual(r.seen.map((x) => x.id), ['once']);
});

test('never more than 2 posts in a row by the same author when others are available', () => {
  const items = [...Array.from({ length: 6 }, (_, i) => item(`k${i}`, 'kant', 0, { l: 10000 })), item('o1', 'other', 5), item('o2', 'else', 6)];
  const ids = R.rankFeed(items, ctx()).fresh.map((x) => x.a);
  for (let i = 2; i < ids.length; i++) assert.ok(!(ids[i] === ids[i - 1] && ids[i] === ids[i - 2]), ids.join(','));
});

test('media gets mixed into long runs of text posts', () => {
  const items = [...Array.from({ length: 8 }, (_, i) => item(`t${i}`, `a${i}`, 0, { l: 1000 })), item('img', 'z', 10, { m: true })];
  const out = R.diversify(R.rankFeed(items, ctx()).fresh);
  assert.ok(out.findIndex((x) => x.m) <= 3);
});

test('markSeen counts views and pruneSeen keeps the newest entries', () => {
  const s = {};
  R.markSeen(s, 'a', 1);
  R.markSeen(s, 'a', 5);
  R.markSeen(s, 'b', 3);
  assert.deepEqual(s.a, [2, 5]);
  assert.deepEqual(Object.keys(R.pruneSeen(s, 1)), ['a']);
  assert.equal(Object.keys(R.pruneSeen({ ...s }, 10)).length, 2);
});

test('a retaik and its original appear once', () => {
  const items = [item('orig', 'x', 3), item('rt1', 'y', 1, { k: 'orig' })];
  const out = R.rankFeed(items, ctx()).fresh.map((x) => x.id);
  assert.equal(out.length, 1);
});
