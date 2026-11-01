// Lists site packs (sites/<id>/site.json), one per line, for CI / workflow loops.
//   node scripts/sites.mjs              all sites
//   node scripts/sites.mjs --generate   sites whose daily generation is on (site.json "generate": true; taiku defaults on)
//   node scripts/sites.mjs --json       JSON array (for a GitHub Actions matrix)
import fs from 'node:fs';
import path from 'node:path';
import { SITES_DIR, DEFAULT_SITE, listSites } from '../src/lib/site.mjs';

const args = process.argv.slice(2);
let ids = listSites();
if (args.includes('--generate')) {
  ids = ids.filter((id) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(SITES_DIR, id, 'site.json'), 'utf8'));
    return cfg.generate ?? id === DEFAULT_SITE;
  });
}
console.log(args.includes('--json') ? JSON.stringify(ids) : ids.join('\n'));
