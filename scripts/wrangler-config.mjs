// Writes wrangler.<site>.json for `wrangler deploy` of dist/<site>: static assets + a Worker for /p/* and /api/*.
//   SITE=<id> node scripts/wrangler-config.mjs   → prints the config path
// site.json "deploy": { "worker": "<name>" (default: site id), "customDomain": false }.
// Keep customDomain false: domains are attached once in the Cloudflare dashboard and persist across deploys;
// the CI token has no zone/DNS permissions, so deploys must not touch routes.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, SITE_CONFIG, listSites } from '../src/lib/site.mjs';

const deploy = SITE_CONFIG.deploy || {};
const host = SITE_CONFIG.domain;
const config = {
  name: deploy.worker || SITE,
  main: './src/worker/index.mjs',
  compatibility_date: '2025-01-01',
  // Only the custom domain serves the site (no *.workers.dev or preview URLs).
  workers_dev: false,
  preview_urls: false,
  assets: {
    directory: `./dist/${SITE}`,
    binding: 'ASSETS',
    // Assets first; the Worker only handles post pages (packed in dist/_p) and the poll vote API (see src/worker).
    run_worker_first: ['/p/*', '/api/*'],
    html_handling: 'auto-trailing-slash',
    not_found_handling: '404-page',
  },
  // Real poll votes: one SQLite-backed Durable Object per poll (Workers Free; created by the script upload, no extra token scope).
  durable_objects: { bindings: [{ name: 'POLLS', class_name: 'PollVotes' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['PollVotes'] }],
  // Workers Rate Limiting (free, per Cloudflare location): votes and count reads per client.
  ratelimits: [
    { name: 'VOTE_RL', namespace_id: '1001', simple: { limit: 10, period: 60 } },
    { name: 'READ_RL', namespace_id: '1002', simple: { limit: 120, period: 60 } },
  ],
  // POLL_SECRET (HMAC key for voter hashes) is a Worker secret; deploy.yml creates it once if missing.
  ...(deploy.customDomain && host ? { routes: [{ pattern: host, custom_domain: true }] } : {}),
};
// Explicit pack opt-in only; existing packs/deploy schedules remain unchanged.
const engagement = deploy.engagementAnalytics;
if (engagement) {
  if (!/^[a-z0-9-]{1,63}$/.test(engagement.budgetWorker ?? '')) throw new Error('engagementAnalytics.budgetWorker must name the single shared budget Worker');
  const owner = engagement.budgetWorker === config.name;
  config.vars = { ENGAGEMENT_ENABLED: engagement.enabled === true ? 'true' : 'false' };
  config.durable_objects.bindings.push({
    name: 'ENGAGEMENT_BUDGET', class_name: 'EngagementBudget',
    ...(!owner ? { script_name: engagement.budgetWorker } : {}),
  });
  config.ratelimits.push({ name: 'ENGAGEMENT_RL', namespace_id: '1003', simple: { limit: 60, period: 60 } });
  if (owner) {
    config.analytics_engine_datasets = [{ binding: 'ENGAGEMENT', dataset: 'visitor_engagement' }];
    config.vars.ENGAGEMENT_SITES = listSites().join(',');
    config.migrations.push({ tag: 'v2-engagement', new_sqlite_classes: ['EngagementBudget'] });
  }
}
const file = path.join(ROOT, `wrangler.${SITE}.json`);
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(path.relative(ROOT, file));
