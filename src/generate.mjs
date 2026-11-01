#!/usr/bin/env node
// Daily generation CLI. See src/lib/run.mjs for the pipeline.
//
//   node src/generate.mjs [--date YYYY-MM-DD] [--mock | --dry-run [--live] | --live]
//        [--seed S] [--nonce N] [--topics N] [--max-calls N] [--topics-only] [--fresh]
//        [--summary-only] [--quiet]
//
// --mock     offline fixtures + mock LLM, writes `-mock` files (content/posts/<date>-daily-mock.json …)
// --dry-run  offline fixtures + mock LLM, writes nothing (add --live to dry-run against real feeds/LLM)
// --live     real feeds + real LLM (default when neither --mock nor --dry-run is given)
import { loadDistribution } from './lib/crowd.mjs';
import { isoDate, localDate } from './lib/pipeline-util.mjs';
import { runDaily } from './lib/run.mjs';

export function parseArgs(argv) {
  const o = {};
  const take = (i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => (inline !== undefined ? inline : take(i++));
    switch (flag) {
      case '--mock': o.mock = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--live': o.live = true; break;
      case '--topics-only': o.topicsOnly = true; break;
      case '--fresh': o.fresh = true; break;
      case '--refetch': o.refetch = true; break;
      case '--summary-only': o.summaryOnly = true; break;
      case '--quiet': o.quiet = true; break;
      case '--seed': o.seed = val(); break;
      case '--nonce': o.nonce = val(); break;
      case '--date': o.date = val(); break;
      case '--topics': o.topics = Number(val()); break;
      case '--max-calls': o.maxCalls = Number(val()); break;
      default: throw new Error(`unknown flag ${a}`);
    }
  }
  if (o.mock && o.live) throw new Error('--mock and --live are exclusive');
  return o;
}

function summarize(r) {
  const m = r.manifest;
  if (!m) return { status: r.status, topics: r.topics?.picks?.map((t) => `${t.tier}: ${t.title}`) };
  const by = (k) => m.tasks.reduce((acc, t) => ({ ...acc, [t[k]]: (acc[t[k]] ?? 0) + 1 }), {});
  const likes = [...r.published, ...r.staged].reduce((s, p) => s + p.personaLikes.length, 0);
  const reposts = [...r.published, ...r.staged].reduce((s, p) => s + p.personaReposts.length, 0);
  return {
    runId: m.runId,
    status: m.status,
    mode: m.mode,
    nonce: m.nonce,
    model: m.model,
    topics: m.topics.map((t) => `${t.status} ${t.tier}: ${t.title}`),
    tasks: by('status'),
    roles: by('role'),
    published: m.outputs.published,
    staged: m.outputs.staged,
    personaLikes: likes,
    personaReposts: reposts,
    calls: `${m.budget.used}/${m.budget.maxCalls}`,
    calibration: { k: m.calibration.k, qTilt: m.calibration.qTilt, rTilt: m.calibration.rTilt },
    completeness: m.completeness,
    errors: m.outputs.errors,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const spec = loadDistribution();
  const tz = spec.reference_timezone ?? 'UTC';
  opts.date ??= process.env.GEN_DATE || localDate(Date.now(), tz);
  if (!isoDate(opts.date)) throw new Error(`bad --date ${opts.date}`);
  const offline = opts.mock || (opts.dryRun && !opts.live);
  const realFetch = globalThis.fetch;
  if (offline) {
    globalThis.fetch = async () => {
      throw new Error('network disabled in offline mode');
    };
  }
  try {
    const r = await runDaily({ ...opts, spec, quiet: opts.quiet || opts.summaryOnly });
    console.log(JSON.stringify(summarize(r), null, 2));
    if (r.status === 'partial') console.error('run is PARTIAL: completeness thresholds not met — nothing published; rerun the same date to resume.');
    if (r.status === 'invalid') console.error(`run is INVALID:\n  ${r.errors.slice(0, 20).join('\n  ')}`);
    process.exitCode = r.exitCode;
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^\/?/, '/')}` || process.argv[1]?.endsWith('generate.mjs')) {
  main().catch((e) => {
    console.error(e.stack ?? e);
    process.exitCode = 1;
  });
}
