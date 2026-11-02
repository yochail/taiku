#!/usr/bin/env node
// Make every visual asset in the corpus unique: the first post (by createdAt) to use an image keeps
// it; every later use gets the best-fitting unused picture from the art library (art-select.mjs,
// scored on the post's text, tags, news and old alt, optionally re-ranked with MiniLM embeddings).
// Local reaction GIFs may repeat across days, but not within one day or one conversation: repeats
// get another reaction sharing a mood.
//   SITE=taiku node scripts/dedupe-media.mjs [--dry-run] [--embed]
import fs from 'node:fs';
import path from 'node:path';
import { sitePath } from '../src/lib/site.mjs';
import { loadLibrary, resolveMedia } from '../src/lib/media.mjs';
import { artLibrary, shortlistArt, rerankArt } from '../src/lib/art-select.mjs';
import { duplicateVisuals } from '../src/lib/visual-dupes.mjs';

const dry = process.argv.includes('--dry-run');
const dir = sitePath('content', 'posts');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const docs = files.map((f) => ({ f, j: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
const postsOf = (j) => (Array.isArray(j) ? j : j.posts ?? []);
const all = docs.flatMap((d) => postsOf(d.j));
const byId = new Map(all.map((p) => [p.id, p]));
const personas = new Map(fs.readdirSync(sitePath('personas')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(sitePath('personas', f), 'utf8'))).map((p) => [p.id, p]));
let embedder = null;
if (process.argv.includes('--embed')) {
  const { createEmbedder } = await import('../src/lib/embed.mjs');
  embedder = await createEmbedder({ mode: 'auto', log: console.error, cacheDir: '.cache/models' });
  console.log(`embeddings: ${embedder.kind}`);
}

const before = duplicateVisuals(all);
const order = [...all].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
const items = (p) => (Array.isArray(p.media) ? p.media : []);
const lib = loadLibrary();
const artBySrc = new Map(artLibrary().map((a) => [a.src, a.id]));
const used = new Set();
const changes = [];

// ---- images
for (const p of order) {
  for (const [i, m] of items(p).entries()) {
    if (m?.kind !== 'image') continue;
    const artId = m.render?.art ?? artBySrc.get(m.src);
    const key = m.src;
    if (!used.has(key) && !used.has(artId)) {
      used.add(key);
      if (artId) used.add(artId);
      continue;
    }
    const persona = personas.get(p.authorId);
    const parent = byId.get(p.inReplyTo) ?? byId.get(p.quoteOf);
    const ctx = { text: p.text || parent?.text || '', alt: m.alt, tags: p.tags ?? [], news: p.news, persona, mood: p.mood };
    let picks = shortlistArt(ctx, { n: 8, used, jitter: 0 });
    if (embedder) picks = await rerankArt(ctx, picks, embedder);
    const a = picks[0];
    if (!a) throw new Error(`art library exhausted at ${p.id}`);
    const { svg: _s, raster: _r, ...item } = resolveMedia({ kind: 'image', render: { art: a.id }, rating: m.rating });
    p.media[i] = item;
    used.add(a.id);
    used.add(a.src);
    changes.push(`${p.id}: image ${m.src} -> ${a.src}  ("${(p.text || parent?.text || '').slice(0, 60).replace(/\s+/g, ' ')}" / ${a.title})`);
  }
}

// ---- local reaction gifs: unique per day and per conversation
const rootOf = (p) => {
  let cur = p;
  for (let k = 0; k < 50 && cur?.inReplyTo && byId.has(cur.inReplyTo); k++) cur = byId.get(cur.inReplyTo);
  return cur?.id ?? p.id;
};
const seenDay = new Map();
const seenThread = new Map();
const setFor = (map, k) => map.get(k) ?? map.set(k, new Set()).get(k);
for (const p of order) {
  for (const [i, m] of items(p).entries()) {
    if (m?.kind !== 'gif') continue;
    const day = setFor(seenDay, String(p.createdAt).slice(0, 10));
    const thread = setFor(seenThread, rootOf(p));
    const taken = (src) => day.has(src) || thread.has(src);
    if (taken(m.src) && m.render?.reaction) {
      const cur = lib.reactions.get(m.render.reaction);
      const alts = [...lib.reactions.values()].filter((r) => r.id !== cur?.id)
        .map((r) => ({ r, s: r.moods.filter((x) => cur?.moods.includes(x)).length }))
        .sort((x, y) => y.s - x.s);
      let done = false;
      for (const { r } of alts) {
        const { svg: _s, raster: _r, ...item } = resolveMedia({ kind: 'gif', render: { ...m.render, reaction: r.id }, rating: m.rating });
        if (taken(item.src)) continue;
        p.media[i] = item;
        changes.push(`${p.id}: gif ${m.render.reaction} -> ${r.id}`);
        done = true;
        break;
      }
      if (!done) throw new Error(`no free reaction for ${p.id}`);
    }
    day.add(p.media[i].src);
    thread.add(p.media[i].src);
  }
}

const after = duplicateVisuals(all);
console.log(changes.join('\n'));
console.log(`\nchanged ${changes.length} media item(s)`);
console.log(`duplicates before: ${before.length} (${before.reduce((s, d) => s + d.posts.length - 1, 0)} extra uses), after: ${after.length}`);
for (const d of after) console.log(`  still duplicated: ${d.kind} ${d.src} on ${d.posts.join(', ')}`);
if (!dry) {
  for (const d of docs) fs.writeFileSync(path.join(dir, d.f), JSON.stringify(d.j, null, 2) + '\n');
  console.log(`wrote ${docs.length} file(s)`);
}
