#!/usr/bin/env node
// Daily generation CLI. See src/lib/run.mjs for the pipeline.
//
//   node src/generate.mjs [--date YYYY-MM-DD] [--mock | --dry-run [--live] | --live]
//        [--seed S] [--nonce N] [--topics N] [--max-calls N] [--topics-only] [--fresh]
//        [--force] [--repair] [--summary-only] [--quiet]
//
// --mock     offline fixtures + mock LLM, writes `-mock` files (content/posts/daily-<date>-mock.json …)
// --dry-run  offline fixtures + mock LLM, writes nothing (add --live to dry-run against real feeds/LLM)
// --live     real feeds + Workers AI (default when neither --mock nor --dry-run is given)
// --force    live only: run even if the local-first content/posts/daily-<date>.json exists. The cloud
//            run then writes next to it as daily-<date>-cf.json (separate ids; never merges or overwrites).
//
// --repair   re-run the day's distribution gate (src/lib/daygate.mjs) on the file this run owns and
//            regenerate the flagged items once (cache skipped for them, their length target fixed);
//            everything else resumes from the work cache. The workflow gates again afterwards.
//
// Local-first: a live run first checks content/posts/daily-<date>.json. If it exists and was not
// written by a cloud run (origin "cloudflare"), it logs "local run present, skipping" and exits 0
// without any LLM call.
import { loadDistribution } from './lib/crowd.mjs';
import { SITE_DIR } from './lib/data.mjs';
import { isoDate, localDate } from './lib/pipeline-util.mjs';
import { gateDay } from './lib/daygate.mjs';
import { loadPersonas } from './lib/data.mjs';
import { loadOtherPosts, localDailyFile, outputPaths, runDaily } from './lib/run.mjs';
import fs from 'node:fs';

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
      case '--force': o.force = true; break;
      case '--repair': o.repair = true; break;
      case '--seed': o.seed = val(); break;
      case '--nonce': o.nonce = val(); break;
      case '--date': o.date = val(); break;
      case '--topics': o.topics = Number(val()); break;
      case '--max-calls': o.maxCalls = Number(val()); break;
      default: throw new Error(`unknown flag ${a}`);
    }
  }
  if (o.mock && o.live) throw new Error('--mock and --live are exclusive');
  if (o.repair && o.dryRun) throw new Error('--repair needs a written day file (not --dry-run)');
  return o;
}

function summarize(r) {
  const m = r.manifest;
  if (!m) return { status: r.status, topics: r.topics?.picks?.map((t) => `${t.tier}: ${t.title}`) };
  const by = (k) => m.tasks.reduce((acc, t) => ({ ...acc, [t[k]]: (acc[t[k]] ?? 0) + 1 }), {});
  const likes = [...r.published, ...r.staged].reduce((s, p) => s + (p.personaLikes?.length ?? 0), 0);
  const reposts = [...r.published, ...r.staged].reduce((s, p) => s + (p.personaReposts?.length ?? 0), 0);
  return {
    runId: m.runId,
    status: m.status,
    mode: m.mode,
    nonce: m.nonce,
    path: m.path,
    degraded: m.degraded,
    embeddings: m.embeddings.kind,
    models: m.models.filter((x) => x.calls > 0 || x.plan > 0).map((x) => `${x.name}: ${x.calls}/${x.plan}+${x.reserve} calls, ~${x.neurons_est} N, ${x.items} items${x['429s'] ? `, ${x['429s']}x429` : ''}`),
    plannedNeurons: m.budgetPlan.totals.neurons,
    items: m.items,
    pools: m.pools,
    micro: { calls: m.micro.calls, replies: m.micro.replies, added: m.micro.added.length },
    topics: m.topics.map((t) => `${t.status} ${t.tier}: ${t.title}`),
    tasks: by('status'),
    roles: by('role'),
    published: m.outputs.published,
    staged: m.outputs.staged,
    personaLikes: likes,
    personaReposts: reposts,
    calls: `${m.budget.used}/${m.budget.maxCalls} (~${m.budget.neurons_est} Neurons)`,
    wallClockSec: m.wallClockSec,
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
  if (!offline && !opts.topicsOnly) {
    const local = localDailyFile(SITE_DIR, opts.date);
    if (local && local.origin !== 'cloudflare') {
      if (!opts.force) {
        console.log(`local run present, skipping (${local.file}: origin ${local.origin ?? '?'}, ${local.posts} posts)`);
        return;
      }
      opts.suffix = '-cf';
      console.error(`--force: local run present; the cloud run writes daily-${opts.date}-cf.json`);
    }
  }
  if (opts.repair) {
    const paths = outputPaths(SITE_DIR, opts.date, { mock: opts.mock, suffix: opts.suffix ?? null });
    if (!fs.existsSync(paths.posts)) throw new Error(`--repair: ${paths.posts} does not exist; run the day first`);
    const doc = JSON.parse(fs.readFileSync(paths.posts, 'utf8'));
    const posts = doc.posts ?? [];
    const g = gateDay({ posts, context: loadOtherPosts(paths.postsDir, [paths.posts]), personas: loadPersonas(), spec, label: paths.posts,
      threadPolicy: doc.threadPolicy ? spec.sampling.conversation?.daily_reactions : null });
    const fixable = g.offenders.filter((o) => o.taskId);
    if (g.ok || !fixable.length) {
      console.log(g.ok ? 'day gate passes; nothing to repair' : `day gate fails but no item is regenerable (${g.failures.map((c) => c.id).join(', ')}); not repairing`);
      return;
    }
    console.error(`--repair: regenerating ${fixable.length} item(s): ${fixable.map((o) => `${o.taskId} ${o.reason}`).join(', ')}`);
    opts.repair = fixable;
  } else delete opts.repair;
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
