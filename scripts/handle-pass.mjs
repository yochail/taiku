#!/usr/bin/env node
// One-off/idempotent corpus pass: where a taik speaks to or dunks on a persona (a reply or quote aimed at
// them, or a vocative like "hey Kant," / "Nietzsche you clown"), write the reference as the clickable
// @handle, sampled at spec.sampling.mentions.handle_vs_name.address. Third-person talk keeps the name.
// Deterministic (seeded by post id + persona); only the name → @handle swap, nothing else changes.
//   node scripts/handle-pass.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas, MAX_TAIK_CHARS, POSTS_DIR } from '../src/lib/data.mjs';
import { applyHandleStyle, handleRates, nameIndex, seededDecide } from '../src/lib/handles.mjs';
import { loadSpec } from '../src/lib/realism.mjs';

const dry = process.argv.includes('--dry');
const personas = loadPersonas();
const index = nameIndex(personas);
const rates = handleRates(loadSpec());
const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json')).sort();
const docs = files.map((f) => {
  const file = path.join(POSTS_DIR, f);
  const raw = fs.readFileSync(file, 'utf8');
  return { file, raw, doc: JSON.parse(raw) };
});
const author = new Map();
for (const { doc } of docs) for (const p of doc.posts ?? []) author.set(p.id, p.authorId);

let seen = 0;
let changed = 0;
const byPersona = {};
for (const d of docs) {
  let dirty = false;
  for (const p of d.doc.posts ?? []) {
    if (!p.text || p.type === 'retaik' || personas.find((x) => x.id === p.authorId)?.kind === 'news') continue;
    const targetId = author.get(p.inReplyTo ?? p.quoteOf ?? '') ?? null;
    const r = applyHandleStyle(p.text, { index, authorId: p.authorId, targetId, decide: seededDecide(rates, p.id), maxChars: MAX_TAIK_CHARS, only: 'address' });
    seen++;
    if (r.text === p.text) continue;
    changed++;
    for (const c of r.converted) byPersona[c.id] = (byPersona[c.id] ?? 0) + 1;
    p.text = r.text;
    dirty = true;
  }
  if (dirty && !dry) fs.writeFileSync(d.file, JSON.stringify(d.doc, null, 2) + (d.raw.endsWith('\n') ? '\n' : ''));
}
console.log(`${dry ? '[dry] ' : ''}${changed}/${seen} taiks now @-address someone (rate ${rates.address}); top: ${Object.entries(byPersona).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ')}`);
