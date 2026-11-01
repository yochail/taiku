#!/usr/bin/env node
// Re-render every stored meme in the site's posts with the current meme renderer.
// Keeps ids, templates and captions; refreshes only the media fields (src, width, height, alt, credit, origin).
//   node scripts/render-memes.mjs            # rewrite posts in place
//   node scripts/render-memes.mjs --check    # report problems/changes only
//   node scripts/render-memes.mjs --dunks[=postId,postId]  # also turn dunk replies into tweet-screenshot dunks (quote the parent)
import fs from 'node:fs';
import path from 'node:path';
import { sitePath } from '../src/lib/site.mjs';
import { resolveMedia, renderProblems } from '../src/lib/media.mjs';
import { loadTemplates, supported, font } from '../src/lib/meme-render.mjs';
import { pickReaction } from '../src/lib/meme-select.mjs';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const dunkArg = argv.find((a) => a.startsWith('--dunks'));
const DUNKS = Boolean(dunkArg);
const DUNK_IDS = dunkArg?.includes('=') ? new Set(dunkArg.split('=')[1].split(',')) : null;
const POSTS = sitePath('content', 'posts');
const PERSONAS = sitePath('personas');

const persona = (id) => {
  const f = path.join(PERSONAS, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

const files = fs.readdirSync(POSTS).filter((f) => f.endsWith('.json')).sort();
const docs = new Map(files.map((f) => [f, JSON.parse(fs.readFileSync(path.join(POSTS, f), 'utf8'))]));
const byId = new Map();
for (const d of docs.values()) for (const p of d.posts ?? []) byId.set(p.id, p);

const { templates } = loadTemplates();
const plainFont = font('inter-regular');
const quoteOf = (p) => {
  const q = byId.get(p.quoteOf || p.inReplyTo);
  if (!q?.text || supported(plainFont, q.text).replace(/\s/g, '').length < 8) return null;
  const who = persona(q.authorId);
  return { persona: q.authorId, name: who?.name ?? q.authorId, handle: who?.handle ?? q.authorId, text: q.text, ...(who?.avatar?.color ? { color: who.avatar.color } : {}), ...(who?.avatar?.initials ? { initials: who.avatar.initials } : {}) };
};

let seen = 0, changed = 0, converted = 0;
const problems = [];
for (const [f, doc] of docs) {
  let dirty = false;
  for (const p of doc.posts ?? []) {
    for (const [i, m] of (p.media ?? []).entries()) {
      if (m?.kind !== 'meme' || !m.render) continue;
      seen++;
      let render = m.render;
      if (DUNKS && p.type === 'dunk' && render.template !== 'tweet-dunk' && (!DUNK_IDS || DUNK_IDS.has(p.id))) {
        const quote = quoteOf(p);
        const old = templates.get(render.template);
        if (quote && old) {
          const caption = Object.values(render.captions ?? {}).at(-1);
          const reaction = old.reaction ? old.id : pickReaction({ text: `${quote.text} ${caption ?? ''}`, persona: persona(p.authorId) }, Math.random);
          render = { template: 'tweet-dunk', captions: caption ? { caption } : {}, quote, reaction };
          converted++;
        }
      }
      const bad = renderProblems({ kind: 'meme', render });
      if (bad.length) { problems.push(`${f} ${p.id}: ${bad.join('; ')}`); continue; }
      const { svg: _s, raster: _r, ...fresh } = resolveMedia({ kind: 'meme', render, rating: m.rating });
      const next = { ...m, render, src: fresh.src, width: fresh.width, height: fresh.height, alt: fresh.alt, origin: fresh.origin };
      if (fresh.credit) next.credit = fresh.credit; else delete next.credit;
      if (JSON.stringify(next) !== JSON.stringify(m)) { p.media[i] = next; dirty = true; changed++; }
    }
  }
  if (dirty && !CHECK) fs.writeFileSync(path.join(POSTS, f), JSON.stringify(doc, null, 2) + '\n');
}
console.log(`memes: ${seen}, updated: ${changed}${DUNKS ? `, dunks → tweet screenshots: ${converted}` : ''}${CHECK ? ' (check only)' : ''}`);
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
