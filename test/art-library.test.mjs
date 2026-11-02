import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPosts } from '../src/lib/data.mjs';
import { duplicateVisuals } from '../src/lib/visual-dupes.mjs';
import { artLibrary, claimArt, shortlistArt, usedArtFromPosts } from '../src/lib/art-select.mjs';
import { ROOT } from '../src/lib/site.mjs';

test('corpus: no visual asset (image/meme/chart) is used twice; gifs never repeat within a day or thread', () => {
  const dupes = duplicateVisuals(loadPosts());
  assert.deepEqual(dupes.map((d) => `${d.kind} ${d.src} (${d.scope}): ${d.posts.join(', ')}`), []);
});

test('duplicateVisuals flags shared images and same-day gifs, allows gifs on different days', () => {
  const img = { kind: 'image', src: '/media/art/a.webp', render: { art: 'a' } };
  const gif = { kind: 'gif', src: '/media/gen/gif-x.svg', render: { reaction: 'r' } };
  const posts = [
    { id: 'p1', createdAt: '2026-10-01T01:00:00Z', media: [img] },
    { id: 'p2', createdAt: '2026-10-02T01:00:00Z', media: [img] },
    { id: 'p3', createdAt: '2026-10-01T02:00:00Z', media: [gif] },
    { id: 'p4', createdAt: '2026-10-01T03:00:00Z', media: [gif] },
    { id: 'p5', createdAt: '2026-10-05T03:00:00Z', media: [gif] },
  ];
  const d = duplicateVisuals(posts);
  assert.ok(d.some((x) => x.kind === 'image' && x.posts.join() === 'p1,p2'));
  assert.ok(d.some((x) => x.kind === 'gif' && x.scope === 'day' && x.posts.join() === 'p3,p4'));
  assert.ok(!d.some((x) => x.posts.includes('p5')));
});

test('art library: manifest entries are complete, licensed and their files exist', () => {
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'media', 'art-library.json'), 'utf8'));
  assert.ok(man.items.length >= 500, `library has ${man.items.length} items`);
  const ids = new Set();
  for (const a of man.items) {
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    for (const k of ['id', 'src', 'src_600', 'title', 'artist', 'source_url', 'license', 'alt']) assert.ok(a[k], `${a.id}: missing ${k}`);
    assert.ok(a.width > 0 && a.height > 0 && Math.max(a.width, a.height) <= 1200, `${a.id}: bad size`);
    assert.match(a.license, /public domain|cc0|pd/i, `${a.id}: license ${a.license}`);
    assert.ok(Array.isArray(a.tags?.themes) && a.tags.themes.length, `${a.id}: no themes`);
    for (const s of [a.src, a.src_600]) assert.ok(fs.existsSync(path.join(ROOT, 'public', s)), `${a.id}: missing file ${s}`);
  }
});

test('shortlistArt: fits the post and never returns used art', () => {
  const cats = shortlistArt({ text: 'my cat knocked the books off the desk again' }, { n: 5, used: new Set(), jitter: 0 });
  assert.ok(cats.some((a) => a.tags.themes.includes('cats')), 'a cat post gets a cat picture');
  const used = new Set(cats.map((a) => a.id));
  const next = shortlistArt({ text: 'my cat knocked the books off the desk again' }, { n: 5, used, jitter: 0 });
  assert.ok(next.every((a) => !used.has(a.id)));
  const all = usedArtFromPosts(loadPosts());
  for (const a of shortlistArt({ text: 'the stars tonight' }, { n: 20, used: all })) assert.ok(!all.has(a.id) && !all.has(a.src));
  assert.ok(artLibrary().length > 500);
});

test('claimArt: two posts in one run never get the same picture', () => {
  const [a, b] = shortlistArt({ text: 'a quiet library at night' }, { n: 2, jitter: 0 });
  assert.equal(claimArt(a.id), a.id);
  const second = claimArt(a.id, { alternatives: [a.id, b.id] });
  assert.equal(second, b.id, 'falls back to the next offered option');
  const third = claimArt(a.id);
  assert.ok(![a.id, b.id].includes(third), 'then to the closest free piece');
});
