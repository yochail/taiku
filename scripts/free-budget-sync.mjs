// Restore every charge from today's serialized workflow legs, including unsuccessful runs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, listSites, siteDir } from '../src/lib/site.mjs';
import { mergeLedgers, readLedger } from '../src/lib/free-budget.mjs';
import { writeJsonAtomic } from '../src/lib/pipeline-util.mjs';

const day = new Date().toISOString().slice(0, 10);
const file = process.env.GEN_USAGE_FILE || path.join(ROOT, '_scratch', 'free-budget.json');
const docs = [readLedger(file, day)];
const completedSites = new Set();
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (process.env.GITHUB_ACTIONS === 'true') {
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required to restore shared quota usage');
  const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp',
    `repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/generate.yml/runs?created=>=${since}&per_page=100`]));
  for (const run of pages.flatMap((p) => p.workflow_runs)) {
    const artifactPages = JSON.parse(gh(['api', '--paginate', '--slurp',
      `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.id}/artifacts?per_page=100`]));
    for (const artifact of artifactPages.flatMap((p) => p.artifacts)) {
      if (!artifact.name.startsWith(`free-budget-${day}-`)) continue;
      const prefix = `free-budget-${day}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-`;
      if (artifact.name.startsWith(prefix)) completedSites.add(artifact.name.slice(prefix.length));
      if (artifact.expired) throw new Error(`shared quota artifact ${artifact.id} expired`);
      const dir = path.join(ROOT, '_scratch', 'quota-artifacts', String(artifact.id));
      gh(['run', 'download', String(run.id), '--repo', process.env.GITHUB_REPOSITORY,
        '--name', artifact.name, '--dir', dir]);
      docs.push(readLedger(path.join(dir, path.basename(file)), day));
    }
  }
}
const doc = mergeLedgers(docs, day);
// One-time migration from the previous per-site counters; never reimport shared totals.
if (!Object.keys(doc.events).length) for (const site of listSites()) {
  const old = path.join(siteDir(site), 'content', 'state', 'llm-usage.json');
  if (!fs.existsSync(old)) continue;
  const usage = JSON.parse(fs.readFileSync(old, 'utf8'));
  if (usage.day !== day) continue;
  for (const [name, u] of Object.entries(usage.models ?? {})) {
    doc.events[`legacy:${site}:${name}`] = { name, calls: u.calls ?? 0, neurons: u.neurons ?? 0,
      tokens: u.tokens ?? ((u.calls ?? 0) * 5000) };
  }
}
writeJsonAtomic(file, doc);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
  `day=${day}\nremaining=${Math.max(1, listSites().filter((s) => JSON.parse(fs.readFileSync(path.join(siteDir(s), 'site.json'), 'utf8')).generate && !completedSites.has(s)).length)}\n`);
