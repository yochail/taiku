// Writes wrangler.<site>.json for `wrangler deploy` of dist/<site> as a static-assets-only Worker.
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
    // Assets first; the Worker only handles post pages (packed in dist/_p, see src/worker).
    run_worker_first: ['/p/*'],
    html_handling: 'auto-trailing-slash',
    not_found_handling: '404-page',
  },
  ...(deploy.customDomain && host ? { routes: [{ pattern: host, custom_domain: true }] } : {}),
};
const file = path.join(ROOT, `wrangler.${SITE}.json`);
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
console.log(path.relative(ROOT, file));
