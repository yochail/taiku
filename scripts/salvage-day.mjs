// Recover already generated, curated posts without changing text, thresholds or provider usage.
import fs from 'node:fs';
import path from 'node:path';
import { cachedUrls, loadPersonas, loadPosts, POSTS_DIR } from '../src/lib/data.mjs';
import { loadSpec } from '../src/lib/realism.mjs';
import { writeJsonAtomic } from '../src/lib/pipeline-util.mjs';
import { salvageDay } from '../src/lib/salvage.mjs';

const args = process.argv.slice(2);
const opt = (key) => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const input = opt('--file'), output = opt('--out'), reportFile = opt('--report');
if (!input || !output || !reportFile) throw new Error('required: --file candidates.json --out daily.json --report report.json');
const doc = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(doc.posts) || doc.origin === 'mock' || doc.provider === 'mock' || doc.posts.some((p) => p.origin === 'mock'))
  throw new Error('salvage requires real generated posts, never mock output');
if (path.resolve(input) !== path.resolve(output) && fs.existsSync(output)) throw new Error('refusing to overwrite an existing daily file');
const spec = loadSpec();
const owned = new Set([input, output, opt('--dayfile')].filter(Boolean).map((p) => path.resolve(p)));
const context = loadPosts().filter((p) => !owned.has(path.resolve(POSTS_DIR, p._file)));
const knownUrls = new Set([...cachedUrls(), ...(opt('--cache') ? cachedUrls(opt('--cache')) : [])]);
const result = salvageDay({ posts: doc.posts, context, personas: loadPersonas(), spec, knownUrls,
  threadPolicy: doc.threadPolicy ? spec.sampling.conversation?.daily_reactions : null,
  allowNames: String(process.env.POLICY_ALLOW_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
if (doc.completeness) result.report.generationCompleteness = doc.completeness;
writeJsonAtomic(reportFile, result.report);
const summary = [`### Partial daily publication: ${result.report.status}`, '',
  `${result.report.retained}/${doc.posts.length} existing posts retained. No model calls; all blocking gates and schema/quote/policy checks remain required.`,
  ...(doc.completeness ? [`Generation completeness: ${doc.completeness.done}/${doc.completeness.counted} tasks; ${doc.completeness.pending} pending. Only validated curated output is eligible.`] : []),
  '', ...result.report.omitted.map((p) => `- ${p.id}: ${p.reasons.join('; ')}`),
  ...result.report.remainingFailures.map((id) => `- Still blocked: ${id}`), ''].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (!result.ok) process.exitCode = 2;
else {
  writeJsonAtomic(output, { ...doc, publication: result.report, posts: result.posts });
  console.log(result.gate.scorecard);
}
