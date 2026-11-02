// Realism report: measures content/posts against realism/spec.json.
//
// Corpus mode (non-blocking report in CI):
//   node scripts/realism.mjs [--json out.json] [--strict]
//   exit 1 on any "fail" metric (hard rules); with --strict also on "warn" (drift).
//
// Day gate (blocking): scores just one day's generated file(s) against the spec, bands widened for
// a ~150-item sample, plus hard checks and per-persona plausibility (src/lib/daygate.mjs).
//   node scripts/realism.mjs --file content/posts/daily-D.json [--file …] [--json out.json]
//   node scripts/realism.mjs --date D        (gates daily-D.json and daily-D-cf.json when present)
//   node scripts/realism.mjs --date today    (today in UTC; what the local daily automation runs)
//   --allow-missing  exit 0 when --date finds no file
//   --strict         also exit 1 when any non-blocking check warns (the bar for a hand-written day)
//   exit 1 when any gated file fails; the markdown scorecard goes to stdout and $GITHUB_STEP_SUMMARY.
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas, loadPosts, POSTS_DIR } from '../src/lib/data.mjs';
import { checkCorpus, loadSpec } from '../src/lib/realism.mjs';
import { withDisplayStats } from '../src/lib/crowd.mjs';
import { gateDay } from '../src/lib/daygate.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const strict = args.includes('--strict');

const spec = loadSpec(opt('--spec'));
const postsDir = path.resolve(opt('--posts') ?? POSTS_DIR);
let gateFiles = opts('--file').map((f) => path.resolve(f));
const dateArg = opt('--date');
if (dateArg) {
  const d = dateArg === 'today' ? new Date().toISOString().slice(0, 10) : dateArg;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad --date ${dateArg}`);
  const found = [`daily-${d}.json`, `daily-${d}-cf.json`].map((n) => path.join(postsDir, n)).filter((p) => fs.existsSync(p));
  if (!found.length) {
    console.log(`day gate: no daily file for ${d} in ${postsDir}`);
    process.exit(args.includes('--allow-missing') ? 0 : 1);
  }
  gateFiles.push(...found);
}
gateFiles = [...new Set(gateFiles)];
if (gateFiles.length) {
  const personas = loadPersonas();
  const everything = loadPosts(postsDir);
  const reports = [];
  let failed = 0;
  for (const file of gateFiles) {
    if (!fs.existsSync(file)) {
      console.log(`day gate: ${file} not found (deleted?), skipping`);
      continue;
    }
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const posts = doc.posts ?? doc;
    const ids = new Set(posts.map((p) => p.id));
    const g = gateDay({ posts, context: everything.filter((p) => !ids.has(p.id)), personas, spec, label: path.basename(file) });
    if (!g.ok) failed++;
    const warns = g.checks.filter((c) => c.status === 'warn');
    if (strict && g.ok && warns.length) failed++;
    console.log(g.scorecard + '\n');
    for (const c of warns) console.log(`warn ${c.id} = ${typeof c.value === 'number' ? c.value.toFixed(3) : c.value}${Array.isArray(c.detail) && c.detail.length ? `: ${c.detail.slice(0, 6).join('; ')}` : ''}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, g.scorecard + '\n\n');
    reports.push({ file: path.relative(process.cwd(), file).replace(/\\/g, '/'), ok: g.ok, failures: g.failures.map(({ id, value, min, max, detail }) => ({ id, value, min, max, detail })), personas: g.personas, offenders: g.offenders });
  }
  const out = opt('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  console.log(failed ? `day gate FAILED for ${failed} file(s)${strict ? ' (--strict: warnings count)' : ''}` : 'day gate passed');
  process.exit(failed ? 1 : 0);
}
const posts = loadPosts(postsDir);
const personas = loadPersonas();
// Measure what visitors see: persona engagement + seeded crowd (same function as the build).
withDisplayStats(posts, personas);
const { results, summary } = checkCorpus(posts, personas, spec);

const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(3));
const icon = { pass: '✅', warn: '⚠️', fail: '❌', skip: '·' };
const lines = [
  `## Taiku realism report — ${posts.length} posts`,
  '',
  `pass ${summary.pass} · warn ${summary.warn} · fail ${summary.fail} · skipped (too few samples / no data) ${summary.skip}`,
  '',
  '| | metric | value | range | n | confidence |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${icon[r.status]} | ${r.id} | ${fmt(r.value)} | ${fmt(r.min)}–${fmt(r.max)} | ${r.n}${r.status === 'skip' && r.min_n ? `/${r.min_n}` : ''} | ${r.confidence ?? ''} |`),
];
for (const r of results) {
  if ((r.status === 'fail' || r.status === 'warn') && Array.isArray(r.detail) && r.detail.length && typeof r.detail[0] === 'string') {
    lines.push('', `**${r.id}**: ${r.detail.join('; ')}`);
  }
}
const report = lines.join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
const out = opt('--json');
if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), posts: posts.length, summary, results }, null, 2));

if (summary.fail || (strict && summary.warn)) process.exit(1);
