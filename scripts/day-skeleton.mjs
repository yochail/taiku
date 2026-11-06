#!/usr/bin/env node
// Day skeleton for hand-written (session) daily runs: the generator samples the day, you write the words.
//
//   SITE=<id> node scripts/day-skeleton.mjs --date D [--seed S | --tries N] [--out dir] [--offline]
//
// Runs the real planner (src/lib/run.mjs, mock text) on a scratch copy of the site's corpus, so who
// posts, who replies to whom (A->B->A answer-backs, spread over many targets), roles, reply forms,
// media kinds, link-card share, polls, mentions, resurfacing and timestamps over the whole local day
// all come from realism/spec.json x persona, exactly like a generator run. Topics are today's real
// news from the site's feeds (fixtures with --offline) and their link cards are unfurled.
//
// Writes to _scratch/skeleton/<site>/ (gitignored):
//   daily-D.json       the day in its final shape. Items you must write carry the text ⟦write⟧
//                      (the validator rejects it); pool replies, GIF-only replies, wires and retaiks are done.
//   daily-D.todo.json  one entry per item to write: persona, type, reply form, target length, parent /
//                      quoted text, topic, stance and conversational move.
// Fill every ⟦write⟧ in voice (keep ids, authors, parents, timestamps, media, topics and polls as they
// are), copy the file to sites/<id>/content/posts/daily-D.json, then `npm run links:backfill -- --refresh-images`,
// `npm run validate` and `npm run gate -- D --strict`, and commit the day file AND content/state/unfurl-cache.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE_DIR, SKELETON_PLACEHOLDER, loadPersonas, displayName } from '../src/lib/data.mjs';
import { SITE } from '../src/lib/site.mjs';
import { loadDistribution } from '../src/lib/crowd.mjs';
import { gateDay } from '../src/lib/daygate.mjs';
import { isoDate, localDate } from '../src/lib/pipeline-util.mjs';
import { loadOtherPosts, outputPaths, runDaily } from '../src/lib/run.mjs';
import { loadUnfurlCache, saveUnfurlCache, unfurl } from '../src/lib/unfurl.mjs';
import { isGoogleNewsUrl, resolveGoogleNews } from '../src/lib/gnews.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const spec = loadDistribution();
const tz = spec.reference_timezone ?? 'UTC';
const date = opt('--date') ?? localDate(Date.now(), tz);
if (!isoDate(date)) throw new Error(`bad --date ${date}`);
const fixedSeed = opt('--seed');
let seed = fixedSeed ?? `session-${date}`;
const offline = args.includes('--offline');
const out = path.resolve(opt('--out') ?? path.join(ROOT, '_scratch', 'skeleton', SITE));
const scratch = path.join(out, 'work', date);
const personas = loadPersonas();
const pById = new Map(personas.map((p) => [p.id, p]));

// 1) Scratch root: the corpus before today (real history for rotation, resurfacing, mentions, novelty).
fs.rmSync(scratch, { recursive: true, force: true });
const src = path.join(SITE_DIR, 'content');
fs.mkdirSync(path.join(scratch, 'content', 'posts'), { recursive: true });
fs.mkdirSync(path.join(scratch, 'content', 'state'), { recursive: true });
for (const f of fs.readdirSync(path.join(src, 'posts')).filter((x) => x.endsWith('.json') && !x.startsWith(`daily-${date}`)))
  fs.copyFileSync(path.join(src, 'posts', f), path.join(scratch, 'content', 'posts', f));
const copy = (from, to) => fs.existsSync(path.join(src, from)) && fs.cpSync(path.join(src, from), path.join(scratch, 'content', to), { recursive: true });
copy(path.join('state', 'unfurl-cache.json'), path.join('state', 'unfurl-cache.json'));
copy(path.join('state', 'reaction-usage.json'), path.join('state', 'reaction-usage-mock.json'));
copy('pools', 'pools');

// 2) Topics: today's real feeds (the planner's selection), then unfurl their cards into the site cache.
const realFetch = globalThis.fetch;
const base = { date, mock: true, quiet: true, seed, root: scratch, env: {}, personas, spec };
if (!offline) {
  // resolveRedirects: Google News items become the publisher's URL (or are dropped), never a card URL.
  const t = await runDaily({ ...base, topicsOnly: true, fetchImpl: realFetch, resolveRedirects: true });
  const siteCache = loadUnfurlCache();
  for (const tp of t.topics?.picks ?? []) if (tp.url) await unfurl(tp.url, { cache: siteCache, fetchImpl: realFetch, timeoutMs: spec.media_policy?.link_preview?.fetch_timeout_ms ?? 8000 }).catch(() => null);
  saveUnfurlCache(siteCache);
  fs.copyFileSync(path.join(src, 'state', 'unfurl-cache.json'), path.join(scratch, 'content', 'state', 'unfurl-cache.json'));
}
// 3) Plan and gate the structure (mock text stands in for the lengths you'll write to). Without
// --seed, up to --tries seeds are planned and the first one fully in band is kept (else the best),
// because one draw of a ~150-post day can land a few hundredths off a band by chance.
// Text checks judge the planner's stand-in words, which get rewritten; gate those after writing.
const TEXT_CHECKS = new Set(['persona.novelty', 'persona.max_similarity', 'persona.length_mix', 'hard.over_140_share']);
const mockPaths = outputPaths(scratch, date, { mock: true });
async function plan(seed) {
  for (const f of [mockPaths.run, mockPaths.work, mockPaths.posts]) fs.rmSync(f, { force: true });
  copy(path.join('state', 'reaction-usage.json'), path.join('state', 'reaction-usage-mock.json'));
  globalThis.fetch = async () => { throw new Error('network disabled while planning'); };
  let r;
  try {
    r = await runDaily({ ...base, seed });
  } finally {
    globalThis.fetch = realFetch;
  }
  if (r.status !== 'complete') return { seed, r, ok: false, warns: Infinity };
  const mockPosts = JSON.parse(fs.readFileSync(mockPaths.posts, 'utf8')).posts;
  const context = loadOtherPosts(path.join(scratch, 'content', 'posts'), [mockPaths.posts]);
  const structural = gateDay({ posts: mockPosts, context, personas, spec, label: `skeleton ${date}` }).checks.filter((c) => !TEXT_CHECKS.has(c.id));
  const ok = !structural.some((c) => c.status === 'fail');
  return { seed, r, mockPosts, context, g: { checks: structural, ok }, ok, warns: structural.filter((c) => c.status === 'warn').length };
}
const tries = fixedSeed ? 1 : Math.max(1, Number(opt('--tries') ?? 6));
let best = null;
for (let i = 0; i < tries; i++) {
  const p = await plan(i === 0 ? seed : `${seed}~${i + 1}`);
  if (tries > 1) console.log(`  plan seed ${p.seed}: ${p.r.status !== 'complete' ? p.r.status : `${p.ok ? 'pass' : 'FAIL'}, ${p.warns} warning(s)`}`);
  if (!best || (p.ok && !best.ok) || (p.ok === best.ok && p.warns < best.warns)) best = p;
  if (best.ok && best.warns === 0) break;
}
const { r, mockPosts, context, g } = best;
seed = best.seed;
if (r.status !== 'complete') {
  console.error(`planner run ${r.status}: ${(r.errors ?? []).slice(0, 5).join('; ')}`);
  process.exit(1);
}
// 4) Final shape: d<YYYYMMDD>-<n> ids by time, origin local, placeholders where words are needed.
const ymd = date.replace(/-/g, '');
const sorted = [...mockPosts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
const idMap = new Map(sorted.map((p, i) => [p.id, `d${ymd}-${i + 1}`]));
const mapId = (id) => idMap.get(id) ?? id;
const pastById = new Map(context.map((p) => [p.id, p]));
const needsWords = (p) => !p.retaikOf && p.model && p.model !== 'none';
const todo = [];
const posts = sorted.map((p0) => {
  const { runId, model, promptVersion, taskId, origin, ...p } = p0;
  p.id = mapId(p.id);
  for (const k of ['inReplyTo', 'quoteOf', 'retaikOf']) if (p[k]) p[k] = mapId(p[k]);
  p.origin = 'local';
  if (!needsWords(p0)) return p;
  const len = [...String(p0.text ?? '')].length;
  const ref = (id) => {
    if (!id) return null;
    const q = mockPosts.find((x) => x.id === id) ?? pastById.get(id);
    if (!q) return { id: mapId(id) };
    return { id: mapId(id), authorId: q.authorId, text: needsWords(q) && mockPosts.includes(q) ? '(written earlier in this file)' : q.text };
  };
  const persona = pById.get(p.authorId);
  todo.push({
    id: p.id,
    authorId: p.authorId,
    name: persona ? displayName(persona) : p.authorId,
    at: p.createdAt,
    type: p.type,
    role: p0.retaikOf ? 'retaik' : p0.quoteOf ? 'quote' : p0.inReplyTo ? 'reply' : 'original',
    replyForm: p.replyForm ?? null,
    targetChars: p.replyForm === 'short' ? [8, 40] : [Math.max(10, Math.round(len * 0.7)), Math.min(280, Math.max(40, Math.round(len * 1.3)))],
    stance: p.stance ?? null,
    inReplyTo: ref(p0.inReplyTo),
    quoteOf: ref(p0.quoteOf),
    topic: p.topic ? { title: p.topic.title, url: p.topic.url, source: p.topic.source } : null,
    media: (p.media ?? []).map((m) => ({ kind: m.kind, alt: m.alt ?? m.title ?? null })),
    poll: p.poll ? { options: p.poll.options } : null,
    sourceQuote: p.quoteRefs?.length || p.note ? { quoteRefs: p.quoteRefs ?? null, note: p.note ?? null, rule: 'keep quoteRefs/note only if your text quotes this passage verbatim' } : null,
    plannerDraft: p0.text,
  });
  delete p.quoteRefs;
  delete p.note;
  p.text = SKELETON_PLACEHOLDER;
  return p;
});

// Safeguard: no Google News redirect (news.google.com/rss/articles/…) may reach the day file. Resolve it to
// the publisher's URL (memoised in the site cache) or drop the card / URL; validation rejects them too.
{
  const siteCache = loadUnfurlCache();
  const memo = (siteCache.gnews ??= {});
  const fix = async (u) => (isGoogleNewsUrl(u) ? await resolveGoogleNews(u, { cache: memo, offline, fetchImpl: realFetch }) : u);
  let fixed = 0;
  for (const p of posts) {
    if (p.media) {
      const kept = [];
      for (const m of p.media) {
        if (m.kind === 'link_card' && isGoogleNewsUrl(m.url)) {
          m.url = await fix(m.url);
          fixed++;
          if (!m.url) continue;
        }
        kept.push(m);
      }
      if (kept.length) p.media = kept;
      else delete p.media;
    }
    for (const k of ['news', 'topic']) if (isGoogleNewsUrl(p[k]?.url)) { p[k].url = await fix(p[k].url); fixed++; }
  }
  for (const t of todo) if (isGoogleNewsUrl(t.topic?.url)) t.topic.url = await fix(t.topic.url);
  if (fixed) {
    saveUnfurlCache(siteCache);
    console.log(`  rewrote/dropped ${fixed} Google News link(s)`);
  }
}

fs.mkdirSync(out, { recursive: true });
const dayFile = path.join(out, `daily-${date}.json`);
const todoFile = path.join(out, `daily-${date}.todo.json`);
fs.writeFileSync(dayFile, JSON.stringify({ generatedAt: new Date().toISOString(), provider: 'session-daily', skeleton: { seed, planner: 'scripts/day-skeleton.mjs' }, posts }, null, 2) + '\n');
fs.writeFileSync(todoFile, JSON.stringify({ date, site: SITE, seed, items: todo }, null, 2) + '\n');
fs.rmSync(scratch, { recursive: true, force: true });

const show = ['activity.reply_share', 'threads.back_and_forth_share', 'authors.reply_in_degree_gini', 'graph.reply_reciprocity', 'media.original.link_card_share', 'time.diurnal_tvd', 'persona.format_entropy'];
console.log(`skeleton ${SITE} ${date} (seed ${seed}): ${posts.length} rows, ${todo.length} to write, topics: ${(r.topics?.picks ?? r.manifest?.topics ?? []).map((t) => t.title).join(' | ')}`);
for (const c of g.checks.filter((x) => show.includes(x.id))) console.log(`  ${c.status === 'pass' ? 'ok  ' : c.status.padEnd(4)} ${c.id} ${typeof c.value === 'number' ? c.value.toFixed(3) : c.value}`);
for (const c of g.checks.filter((x) => x.status !== 'pass' && !show.includes(x.id))) console.log(`  ${c.status.padEnd(4)} ${c.id} ${typeof c.value === 'number' ? c.value.toFixed(3) : c.value} ${String(c.detail ?? '').slice(0, 160)}`);
console.log(`planned structure: ${g.ok ? 'PASS' : 'FAIL'}, ${g.checks.filter((c) => c.status === 'warn').length} warning(s)`);
console.log(`wrote ${path.relative(ROOT, dayFile)} and ${path.relative(ROOT, todoFile)}`);
if (!g.ok || g.checks.some((c) => c.status === 'warn')) {
  console.log('the plan itself is off-band: rerun with another --seed or more --tries');
  process.exitCode = 2;
}
