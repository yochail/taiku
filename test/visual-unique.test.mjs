import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateVisuals, gifIdentity } from '../src/lib/visual-dupes.mjs';
import { enforceUniqueVisuals } from '../src/lib/gen-media.mjs';
import { similarReactions } from '../src/lib/media.mjs';
import { validate } from '../src/lib/data.mjs';

const gif = (reaction, caption) => ({ kind: 'gif', render: { reaction, ...(caption ? { caption } : {}) }, src: `/media/gen/gif-${reaction}`, alt: reaction });
const meme = (captions) => ({ kind: 'meme', render: { template: 'drake', captions }, src: `/media/gen/meme-${captions.join('-')}`, alt: 'meme' });
const post = (id, createdAt, media, extra = {}) => ({ id, authorId: 'socrates', type: 'hot_take', text: extra.text ?? '', createdAt, media, ...extra });

test('similarReactions: same-feeling neighbours first, minScore filters strangers', () => {
  const near = similarReactions('meditation-thinking', { minScore: 1 }).map((r) => r.id);
  assert.ok(near.length > 0 && !near.includes('scream-shock'));
  assert.ok(!near.includes('meditation-thinking'));
  assert.ok(similarReactions('meditation-thinking').length >= near.length);
});

test('duplicateVisuals: GIF reused on the same day or in one thread, captions do not matter', () => {
  const posts = [
    post('a', '2026-11-02T08:00:00Z', [gif('horatii-agree', 'yes')]),
    post('b', '2026-11-02T15:00:00Z', [gif('horatii-agree', 'also yes')]),
    post('c', '2026-11-03T09:00:00Z', [gif('horatii-agree')]),
  ];
  const d = duplicateVisuals(posts);
  assert.deepEqual(d.map((g) => [g.scope, g.posts.join()]), [['day', 'a,b']]);
  const thread = [post('r', '2026-11-02T08:00:00Z', [gif('spinner-bored')]), post('s', '2026-11-03T08:00:00Z', [gif('spinner-bored')], { inReplyTo: 'r' })];
  assert.deepEqual(duplicateVisuals(thread).map((g) => g.scope), ['thread']);
});

test('duplicateVisuals: one image per corpus; meme template repeats only with new captions', () => {
  const img = { kind: 'image', render: { art: 'starry-night' }, src: '/media/art/starry-night.jpg', alt: 'x' };
  assert.equal(duplicateVisuals([post('a', '2026-10-01T08:00:00Z', [img]), post('b', '2026-11-01T08:00:00Z', [{ ...img }])]).length > 0, true);
  assert.equal(duplicateVisuals([post('a', '2026-10-01T08:00:00Z', [meme(['x', 'y'])]), post('b', '2026-11-01T08:00:00Z', [meme(['p', 'q'])])]).length, 0);
  assert.ok(duplicateVisuals([post('a', '2026-10-01T08:00:00Z', [meme(['x', 'y'])]), post('b', '2026-11-01T08:00:00Z', [meme(['x', 'y'])])]).length > 0);
});

test('enforceUniqueVisuals: swaps a repeated GIF to a free similar reaction, deterministically', () => {
  const mk = () => [
    post('b', '2026-11-02T15:00:00Z', [gif('meditation-thinking', 'hmm')], { text: 'second' }),
    post('a', '2026-11-02T08:00:00Z', [gif('meditation-thinking', 'hmm')], { text: 'first' }),
  ];
  const x = mk();
  const r = enforceUniqueVisuals(x, []);
  assert.equal(r.changes.length, 1);
  assert.equal(gifIdentity(x[1].media[0]), 'meditation-thinking', 'earlier post keeps its GIF');
  const swapped = gifIdentity(x[0].media[0]);
  assert.notEqual(swapped, 'meditation-thinking');
  assert.ok(similarReactions('meditation-thinking', { minScore: 1 }).some((s) => s.id === swapped));
  assert.equal(x[0].media[0].render.caption, 'hmm');
  assert.equal(duplicateVisuals(x).length, 0);
  const y = mk();
  enforceUniqueVisuals(y, []);
  assert.deepEqual(y, x);
});

test('enforceUniqueVisuals: respects prior corpus and drops an empty media-only duplicate', () => {
  const prior = [post('old', '2026-10-01T08:00:00Z', [meme(['x', 'y'])])];
  const posts = [
    post('n1', '2026-11-02T08:00:00Z', [meme(['x', 'y'])]),
    post('n2', '2026-11-02T09:00:00Z', [meme(['x', 'y'])], { text: 'keep the words' }),
    post('n3', '2026-11-02T10:00:00Z', [meme(['p', 'q'])]),
  ];
  const r = enforceUniqueVisuals(posts, prior);
  assert.deepEqual([...r.drop], ['n1']);
  assert.equal(posts[1].media, undefined);
  assert.equal(posts[1].text, 'keep the words');
  assert.equal(posts[2].media.length, 1);
});

test('validate: flags reused visuals', () => {
  const errs = validate([], [post('a', '2026-11-02T08:00:00Z', [gif('horatii-agree')]), post('b', '2026-11-02T09:00:00Z', [gif('horatii-agree')])], { knownUrls: new Set() });
  assert.ok(errs.some((e) => /media gif horatii-agree reused \(day\): a, b/.test(e)), errs.join('\n'));
});
