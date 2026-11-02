#!/usr/bin/env node
// One-off virality pass for an existing corpus: for every corpus day, sample the cross-day follow-ons
// (spec.sampling.resurfacing) the daily generator would have added, given the posts before that day.
// Deterministic from (date, seed). Content is written by the backfill agents, so this only writes a
// plan: staging/resurface-plan.json [{ date, parentId, parentFile, parentAuthor, personaId, action, at, reason }].
//   node scripts/resurface-plan.mjs [--seed backfill] [--out staging/resurface-plan.json]
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas, loadPosts } from '../src/lib/data.mjs';
import { mentionDebts, resurface } from '../src/lib/followon.mjs';
import { createSampler, loadSpec, measure } from '../src/lib/realism.mjs';
import { editorialDay, seededRng } from '../src/lib/pipeline-util.mjs';
import { sitePath } from '../src/lib/site.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const seed = arg('--seed', 'backfill');
const out = sitePath(arg('--out', path.join('staging', 'resurface-plan.json')));
const spec = loadSpec();
const personas = loadPersonas();
const posts = loadPosts();
const tz = spec.reference_timezone ?? 'UTC';
const dayOf = (p) => /(\d{4}-\d{2}-\d{2})/.exec(p._file ?? '')?.[1];
const dates = [...new Set(posts.map(dayOf).filter(Boolean))].sort();

const plan = [];
for (const date of dates) {
  const day = editorialDay(date, tz);
  const past = posts.filter((p) => Date.parse(p.createdAt) < day.start);
  if (!past.length) continue;
  const rsamp = createSampler(spec, `resurface:${date}:${seed}`);
  const rrand = seededRng('resurface-at', date, seed);
  const atFn = (minHour = 0) => day.start + Math.max(minHour, rsamp.localHour()) * 3.6e6 + rsamp.minute() * 6e4 + Math.floor(rrand() * 6e4);
  const skip = mentionDebts({ past, personas, spec, start: day.start, end: day.end });
  for (const e of resurface({ past, personas, spec, start: day.start, end: day.end, seed: `${date}:${seed}`, atFn, skip })) {
    plan.push({
      date,
      parentId: e.post.id,
      parentFile: e.post._file ? path.basename(e.post._file) : null,
      parentAuthor: e.post.authorId,
      parentText: String(e.post.text ?? '').slice(0, 140),
      personaId: e.personaId,
      action: e.action,
      at: new Date(e.at).toISOString(),
      reason: e.reason,
    });
  }
}
const before = measure(posts, personas, spec)['engagement.cross_day_reaction_share'];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify({
  _note: 'Cross-day follow-ons (virality / resurfacing) for the existing corpus, sampled by scripts/resurface-plan.mjs from realism/spec.json sampling.resurfacing. Each row is a reply or quote-taik that persona should post at `at` (into backfill-<date>.json), aimed at parentId. Keep the timestamp; write in the persona voice as someone who just came across the older post (pile-on rows: the post is blowing up today).',
  seed,
  cross_day_reaction_share_before: before,
  count: plan.length,
  plan,
}, null, 2)}\n`);
console.log(`resurface plan: ${plan.length} follow-ons over ${dates.length} days -> ${path.relative(process.cwd(), out)} (cross-day share now ${before?.value?.toFixed?.(3)} of ${before?.n})`);
