// Realism report: measures content/posts against realism/spec.json.
// Usage: node scripts/realism.mjs [--json out.json] [--strict]
//   exit 1 on any "fail" metric (hard rules); with --strict also on "warn" (drift).
import fs from 'node:fs';
import { loadPersonas, loadPosts } from '../src/lib/data.mjs';
import { checkCorpus, loadSpec } from '../src/lib/realism.mjs';
import { displayStats } from '../src/lib/crowd.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const strict = args.includes('--strict');

const spec = loadSpec(opt('--spec'));
const posts = loadPosts(opt('--posts') ?? undefined);
const personas = loadPersonas();
const byP = new Map(personas.map((p) => [p.id, p]));
const quoteN = new Map();
for (const p of posts) if (p.quoteOf) quoteN.set(p.quoteOf, (quoteN.get(p.quoteOf) ?? 0) + 1);
// Measure what visitors see: persona engagement + seeded crowd (same function as the build).
for (const p of posts) p.stats ??= displayStats(p, byP.get(p.authorId), { quotes: quoteN.get(p.id) ?? 0 });
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
