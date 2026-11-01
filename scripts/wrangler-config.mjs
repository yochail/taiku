// Writes wrangler.<site>.json for `wrangler deploy` of dist/<site>: static assets + a Worker for /p/* and /api/*.
//   SITE=<id> node scripts/wrangler-config.mjs   → prints the config path
// site.json "deploy": { "worker": "<name>" (default: site id), "customDomain": false }.
// Keep customDomain false: domains are attached once in the Cloudflare dashboard and persist across deploys;
// the CI token has no zone/DNS permissions, so deploys must not touch routes.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, SITE_CONFIG } from '../src/lib/site.mjs';

const deploy = SITE_CONFIG.deploy || {};
const host = SITE_CONFIG.domain;
const config = {
  name: deploy.worker || SITE,
  main: './src/worker/index.mjs',
  compatibility_date: '2025-01-01',
  workers_dev: true,
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
  ...(deploy.customDomain && host ? { routes: [{ pattern: host, custom_domain: true }] } : {}),
};
const file = path.join(ROOT, `wrangler.${SITE}.json`);
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(path.relative(ROOT, file));
