#!/usr/bin/env node
// Repetition audit over the existing corpus: per persona, the taiks that repeat one of their own recent
// taiks (embedding cosine + shared n-gram, spec.sampling.novelty) or exceed a catchphrase cap
// (sites/<id>/ideas/<persona>.json). Deterministic. Content is rewritten by the backfill agents, so this
// only writes a list: staging/repetition-audit.json { generated_from, config, total, by_reason, personas }.
// Language-aware (Hebrew niqqud/prefix folding, src/lib/textnorm.mjs). Run per site: SITE=<id>.
// --model adds a semantic pass with the multilingual embedding model (reason "semantic") when it loads.
//   node scripts/repetition-audit.mjs [--out staging/repetition-audit.json] [--model]
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas, loadPosts } from '../src/lib/data.mjs';
import { noveltyConfig, scanRepetition, semanticRepetition } from '../src/lib/ideas.mjs';
import { loadSpec } from '../src/lib/realism.mjs';
import { SITE, sitePath } from '../src/lib/site.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const out = sitePath(arg('--out', path.join('staging', 'repetition-audit.json')));
const cfg = noveltyConfig(loadSpec());
const personas = loadPersonas();
const posts = loadPosts();
const byId = new Map(posts.map((p) => [p.id, p]));
const fileOf = (p) => (p?._file ? `content/posts/${p._file}` : null);
const snip = (p) => String(p?.text ?? '').replace(/\s+/g, ' ').slice(0, 140);

const hits = scanRepetition(posts, { personas, cfg });
let model = null;
if (process.argv.includes('--model')) {
  const { createEmbedder, MODEL_ID } = await import('../src/lib/embed.mjs');
  const embedder = await createEmbedder({ mode: 'auto', log: console.error, cacheDir: path.join('.cache', 'models') });
  if (embedder.kind === 'minilm') {
    const texts = posts.filter((p) => p.text && !p.retaikOf);
    const vecs = new Map();
    for (let i = 0; i < texts.length; i += 64) (await embedder.embed(texts.slice(i, i + 64).map((p) => p.text))).forEach((v, k) => vecs.set(texts[i + k].id, v));
    hits.push(...semanticRepetition(posts, { personas, cfg, vecOf: (p) => vecs.get(p.id) ?? null, skip: new Set(hits.map((h) => h.postId)) }));
    model = MODEL_ID;
  } else console.error('repetition audit: embedding model unavailable, lexical pass only');
}
const groups = {};
const byReason = {};
for (const h of hits) {
  byReason[h.reason] = (byReason[h.reason] ?? 0) + 1;
  const p = byId.get(h.postId);
  const o = h.otherId ? byId.get(h.otherId) : null;
  (groups[h.personaId] ??= []).push({
    file: fileOf(p),
    id: h.postId,
    createdAt: p?.createdAt,
    reason: h.reason,
    ...(h.reason === 'catchphrase' ? { label: h.label } : { otherId: h.otherId, otherFile: fileOf(o), score: h.score, ...(h.gram ? { gram: h.gram } : {}) }),
    text: snip(p),
    ...(o ? { otherText: snip(o) } : {}),
  });
}
const personasOut = Object.fromEntries(Object.keys(groups).sort().map((k) => [k, groups[k].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))]));
const doc = {
  site: SITE,
  note: 'Rewrite each listed taik to a different idea from the persona ledger (sites/<id>/ideas); keep id, timing, media and thread links.',
  config: cfg,
  ...(model ? { model } : {}),
  scanned: posts.length,
  total: hits.length,
  by_reason: byReason,
  by_persona: Object.fromEntries(Object.entries(personasOut).map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  personas: personasOut,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`repetition audit: ${hits.length} offenders in ${posts.length} taiks (${JSON.stringify(byReason)}) -> ${path.relative(process.cwd(), out)}`);
