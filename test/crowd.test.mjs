import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crowdFor, displayStats, withDisplayStats } from '../src/lib/crowd.mjs';

const author = { id: 'diogenes', popularity: 6 };
const root = { id: 'crowd-root', authorId: 'diogenes', type: 'hot_take', text: 'x', createdAt: '2026-11-01T10:03:00Z' };

test('crowd counts are deterministic per post id', () => {
  assert.deepEqual(crowdFor(root, author), crowdFor({ ...root }, author));
  assert.notDeepEqual(crowdFor(root, author), crowdFor({ ...root, id: 'crowd-other' }, author));
});

test('display stats: persona likes add on top, reposts include quotes, stored crowd bases win', () => {
  const base = { ...root, crowdLikeBase: 40, crowdRepostBase: 5, crowdQuoteBase: 2 };
  const s = displayStats({ ...base, personaLikes: ['kant', 'hume'], personaReposts: ['marx'] }, author, { replies: 3, quotes: 1 });
  assert.equal(s.likes, 42);
  assert.equal(s.quotes, 3);
  assert.equal(s.reposts, 1 + 5 + 3);
  assert.equal(s.replies, 3);
  assert.ok(s.views >= 0 && Number.isInteger(s.bookmarks));
});

test('withDisplayStats: graph counts, retaik rows counted once per author, no stats on retaik rows', () => {
  const personas = [author, { id: 'kant', popularity: 5 }, { id: 'marx', popularity: 5 }];
  const posts = [
    { ...root, crowdLikeBase: 10, crowdRepostBase: 0, crowdQuoteBase: 0, personaReposts: ['marx'] },
    { id: 'c-r1', authorId: 'kant', inReplyTo: 'crowd-root', text: 'no', createdAt: '2026-11-01T10:09:00Z' },
    { id: 'c-q1', authorId: 'kant', quoteOf: 'crowd-root', text: 'lol', createdAt: '2026-11-01T10:11:00Z' },
    { id: 'c-rt1', authorId: 'marx', type: 'retaik', retaikOf: 'crowd-root', text: '', createdAt: '2026-11-01T10:12:00Z' },
    { id: 'c-rt2', authorId: 'kant', type: 'retaik', retaikOf: 'crowd-root', text: '', createdAt: '2026-11-01T10:13:00Z' },
  ];
  withDisplayStats(posts, personas);
  const s = posts[0].stats;
  assert.equal(s.replies, 1);
  assert.equal(s.quotes, 1);
  assert.equal(s.reposts, 2 + 0 + 1, 'marx (personaReposts + row) once, kant once, plus the quote');
  assert.equal(posts[3].stats, undefined);
  assert.equal(posts[4].stats, undefined);
});

test('replies draw a smaller crowd than originals on average', () => {
  let orig = 0, rep = 0;
  for (let i = 0; i < 300; i++) {
    orig += crowdFor({ id: `o${i}`, type: 'observation' }, author).likes;
    rep += crowdFor({ id: `r${i}`, type: 'observation', inReplyTo: 'x' }, author).likes;
  }
  assert.ok(orig > rep, `originals ${orig} vs replies ${rep}`);
});
