import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pinUsedArtCorpus } from '../src/lib/art-select.mjs';
import { withDisplayStats } from '../src/lib/crowd.mjs';
import { ROOT, loadPersonas } from '../src/lib/data.mjs';
import { binomCdf, gateDay, widenBand } from '../src/lib/daygate.mjs';
import { checkCorpus, loadSpec } from '../src/lib/realism.mjs';
import { outputPaths, runDaily } from '../src/lib/run.mjs';
import { loadLlmConfig } from '../src/lib/llm.mjs';

const SCRATCH = path.join(ROOT, 'test', '.daygate-scratch');
const DATES = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05'];
// Product choices, not realism: mock GIFs never come from GIPHY.
const PRODUCT_CHOICE = new Set(['media.gif.giphy_share']);
const spec = loadSpec();
delete spec.sampling.conversation.daily_reactions;
// Pin the old cascade's recipe; deep-thread policies have separate integration coverage.
const legacyCaps = {
  'cf-llama-3.3-70b': [4000, 35], 'cf-gemma-4-26b': [1500, 30],
  'cf-gemma-4-26b-micro': [1300, 50], 'cf-gpt-oss-120b': [1000, 10],
  'gemini-3.5-flash': [200, 40], 'or-nemotron-3-ultra': [25, 20],
  'or-nemotron-3.5-super': [20, 16], 'groq-gpt-oss-120b': [1000, 25],
  'groq-qwen3.8-27b': [1000, 50],
};
const config = loadLlmConfig();
const llmConfig = { ...config, freePools: {}, totalCap: { cap: 8000 }, planShare: 0.8, reserveShare: 0.1,
  targetCalls: { min: 50, max: 90 }, providers: config.providers.map((p) => ({
    ...p, cap: legacyCaps[p.name][0], calls: legacyCaps[p.name][1],
  })) };
const personas = loadPersonas();
const days = new Map();
const fileOf = (date) => outputPaths(SCRATCH, date, { mock: true }).posts;
const clone = (x) => JSON.parse(JSON.stringify(x));

before(async () => {
  // The mock days' art picks depend on what the corpus already used; pin that to the seed + backfill
  // so each new daily file landing on main doesn't reshuffle the fixture.
  pinUsedArtCorpus({ include: (f) => f === '0000-seed.json' || f.startsWith('backfill-') });
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  for (const [i, date] of DATES.entries()) {
    const r = await runDaily({ date, mock: true, quiet: true, seed: `gate${i}`, nonce: `n${i}`, spec, personas, env: {}, root: SCRATCH, llmConfig, maxCalls: 90 });
    assert.equal(r.status, 'complete', `${date}: ${r.errors?.slice(0, 3).join('; ')}`);
    days.set(date, JSON.parse(fs.readFileSync(fileOf(date), 'utf8')).posts);
  }
});
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  pinUsedArtCorpus();
});

const runCli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'realism.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });

/** A bad day built from a good one: essays, round-minute stamps, no media/polls, Diogenes lecturing. */
function badDay(posts) {
  const day = clone(posts);
  const essay = 'Consider, if you will, the long and winding argument that follows from first principles, every clause qualified, every premise stated twice for safety, until the reader forgets the question entirely and the post runs out of room.';
  for (const p of day) {
    delete p.media;
    delete p.poll;
    if (p.news) delete p.news.url;
    const d = new Date(p.createdAt);
    d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
    p.createdAt = d.toISOString();
    if (!p.retaikOf && p.text) p.text = essay.slice(0, 150 + (p.id.length % 60));
  }
  return day;
}

test('widenBand: binomial interval for shares, relative slack otherwise', () => {
  const g = spec.gate;
  const b = widenBand('activity.reply_share', { min: 0.4, max: 0.6 }, 150, g);
  assert.ok(b.min < 0.4 && b.min > 0.3 && b.max > 0.6 && b.max < 0.7, JSON.stringify(b));
  const wide = widenBand('activity.reply_share', { min: 0.4, max: 0.6 }, 30, g);
  assert.ok(wide.min < b.min && wide.max > b.max, 'smaller samples get wider bands');
  const m = widenBand('length.median_chars', { min: 55, max: 95 }, 150, g);
  assert.deepEqual([Math.round(m.min * 100) / 100, Math.round(m.max * 100) / 100], [46.75, 109.25]);
});

test('good fixture days (mock generator) pass the day gate', () => {
  for (const [date, posts] of days) {
    const g = gateDay({ posts, personas, spec, label: date });
    assert.ok(g.ok, `${date} failed: ${g.failures.map((c) => `${c.id}=${c.value} ${c.detail?.join('; ') ?? ''}`).join(' | ')}`);
    assert.equal(g.offenders.length, 0);
    assert.match(g.scorecard, /Day gate: .* PASS/);
    assert.ok(g.checks.some((c) => c.id === 'hard.polls' && c.value >= 1), `${date}: the planner guarantees a poll`);
  }
});

test('bad fixture day fails every hard check and names offenders', () => {
  const [date, posts] = [...days][0];
  const g = gateDay({ posts: badDay(posts), personas, spec, label: `${date}-bad` });
  assert.equal(g.ok, false);
  const failed = new Set(g.failures.map((c) => c.id));
  for (const id of ['hard.media_items', 'hard.polls', 'hard.over_140_share', 'hard.round_minute_share', 'length.median_chars', 'length.short_share', 'media.original.visual_share']) {
    assert.ok(failed.has(id), `${id} should fail (failed: ${[...failed].join(', ')})`);
  }
  assert.ok(g.offenders.length > 0 && g.offenders.every((o) => o.taskId && o.reason), 'regenerable offenders with a reason');
  assert.ok(g.offenders.some((o) => o.reason === 'over_140' && o.length.max <= 140));
  assert.match(g.scorecard, /FAIL/);
});

test('role mix outside its band fails (everything posted as originals)', () => {
  const day = clone([...days.values()][1]).filter((p) => !p.retaikOf);
  for (const p of day) {
    delete p.inReplyTo;
    delete p.quoteOf;
  }
  const g = gateDay({ posts: day, personas, spec });
  const ids = g.failures.map((c) => c.id);
  assert.ok(ids.includes('activity.original_share') && ids.includes('activity.reply_share'), ids.join(', '));
});

test('per persona: Diogenes writing essays and Kant grunting both fail; other personas unaffected', () => {
  const day = clone([...days.values()][2]).filter((p) => p.authorId !== 'diogenes' && p.authorId !== 'kant');
  const t0 = Date.parse(day[0].createdAt);
  const at = (i) => new Date(t0 + (i * 37 + 3) * 60_000 + 17_000).toISOString();
  const long = 'Let me set out, in order, why the city is mistaken about virtue, wealth and the proper use of a barrel, beginning with the definitions and proceeding to the objections, each answered in turn with care.';
  for (let i = 0; i < 6; i++) day.push({ id: `dio-${i}`, taskId: `dio-${i}`, authorId: 'diogenes', type: 'hot_take', text: long, createdAt: at(i) });
  const parent = day.find((p) => !p.inReplyTo && !p.quoteOf && !p.retaikOf);
  for (let i = 0; i < 6; i++) day.push({ id: `kant-${i}`, taskId: `kant-${i}`, authorId: 'kant', type: 'reply', inReplyTo: parent.id, text: 'no.', createdAt: at(i + 7) });
  const g = gateDay({ posts: day, personas, spec });
  const row = (id) => g.personas.find((r) => r.personaId === id);
  assert.equal(row('diogenes')?.status, 'fail', 'Diogenes essays');
  assert.equal(row('kant')?.status, 'fail', 'Kant two-word day');
  assert.ok(g.offenders.some((o) => o.postId.startsWith('dio-') && /persona_too_long/.test(o.reason) && o.length.max <= 40));
  assert.ok(g.offenders.some((o) => o.postId.startsWith('kant-') && /persona_too_short/.test(o.reason)));
  assert.ok(g.personas.filter((r) => !['diogenes', 'kant'].includes(r.personaId)).every((r) => r.status === 'pass'));
});

test('CLI: --file exits 0 on a good day, 1 on a bad day, writes the scorecard and --json', () => {
  const good = fileOf(DATES[0]);
  const ok = runCli('--file', good, '--posts', path.dirname(good));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Day gate: .* PASS/);
  const badFile = path.join(SCRATCH, 'daily-bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ posts: badDay(days.get(DATES[0])) }));
  const json = path.join(SCRATCH, 'gate.json');
  const bad = runCli('--file', badFile, '--posts', path.dirname(good), '--json', json);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /FAIL/);
  const rep = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.equal(rep.reports[0].ok, false);
  assert.ok(rep.reports[0].offenders.length > 0);
  const missing = runCli('--date', '2001-01-01', '--posts', path.dirname(good), '--allow-missing');
  assert.equal(missing.status, 0);
});

test('repair: flagged tasks are regenerated to their new target; everything else is untouched', async () => {
  const date = DATES[3];
  const beforePosts = days.get(date);
  const long = beforePosts.filter((p) => p.taskId && !p.retaikOf && [...(p.text ?? '')].length > 100).slice(0, 3);
  assert.ok(long.length >= 2);
  const r = await runDaily({ date, mock: true, quiet: true, seed: 'gate3', nonce: 'n3', spec, personas, env: {}, root: SCRATCH, repair: long.map((p) => ({ taskId: p.taskId, reason: 'over_140', length: { min: 5, max: 40 } })) });
  assert.equal(r.status, 'complete');
  const afterPosts = JSON.parse(fs.readFileSync(fileOf(date), 'utf8')).posts;
  const byId = new Map(afterPosts.map((p) => [p.id, p]));
  for (const p of long) assert.ok([...byId.get(p.id).text].length <= 60, `${p.id} shortened: ${byId.get(p.id).text}`);
  // Plain retaik rows are re-derived from the day's engagement (which the shortened items change); authored items must not move.
  const others = beforePosts.filter((p) => !long.includes(p) && !p.retaikOf);
  const changed = others.filter((p) => byId.get(p.id)?.text !== p.text).map((p) => `${p.id} [${p.text}] -> [${byId.get(p.id)?.text}]`);
  assert.deepEqual(changed, [], 'cached items resume unchanged');
  days.set(date, afterPosts);
});

test('repair: a flagged self-thread part regenerates its whole thread (no dangling inReplyTo)', async () => {
  const date = DATES[4];
  const beforePosts = days.get(date);
  const part = beforePosts.find((p) => /\.t2$/.test(p.taskId ?? ''));
  assert.ok(part, 'fixture day has a self-thread');
  const root = part.taskId.replace(/\.t2$/, '');
  const r = await runDaily({ date, mock: true, quiet: true, seed: 'gate4', nonce: 'n4', spec, personas, env: {}, root: SCRATCH, repair: [{ taskId: part.taskId, reason: 'catchphrase:x' }] });
  assert.equal(r.status, 'complete', r.errors?.slice(0, 3).join('; '));
  const afterPosts = JSON.parse(fs.readFileSync(fileOf(date), 'utf8')).posts;
  const ids = new Set(afterPosts.map((p) => p.id));
  const sameDay = new Set(beforePosts.map((p) => p.id));
  for (const p of afterPosts) for (const k of ['inReplyTo', 'quoteOf', 'retaikOf']) if (sameDay.has(p[k])) assert.ok(ids.has(p[k]), `${p.id}.${k} -> ${p[k]} dangling`);
  const thread = afterPosts.filter((p) => p.taskId === root || (p.taskId ?? '').startsWith(`${root}.t`));
  assert.ok(thread.length >= 3 && thread.some((p) => p.taskId === part.taskId), 'whole thread present after repair');
  days.set(date, afterPosts);
});

test('realism on mock output: 0 warnings across days except product-choice metrics', () => {
  const posts = [...days.values()].flat().map((p) => ({ ...p }));
  withDisplayStats(posts, personas);
  const { results } = checkCorpus(posts, personas, spec);
  const bad = results.filter((r) => (r.status === 'warn' || r.status === 'fail') && !PRODUCT_CHOICE.has(r.id));
  assert.deepEqual(bad.map((r) => `${r.id}=${r.value}`), []);
});

test('per-persona misses must be binomially unlikely: 4 of 7 long at p=.12 is noise, 7 of 7 is not', () => {
  assert.ok(1 - binomCdf(3, 7, 0.12) > spec.gate.persona_alpha);
  assert.ok(1 - binomCdf(6, 7, 0.12) < spec.gate.persona_alpha);
  assert.equal(binomCdf(7, 7, 0.5), 1);
});
