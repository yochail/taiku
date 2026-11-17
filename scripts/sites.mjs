// Lists site packs (sites/<id>/site.json), one per line, for CI / workflow loops.
//   node scripts/sites.mjs              all sites
//   node scripts/sites.mjs --generate   sites whose daily generation is on (site.json "generate": true; taiku defaults on)
//   node scripts/sites.mjs --json       JSON array (for a GitHub Actions matrix)
import { listGeneratingSites, listSites } from '../src/lib/site.mjs';

const args = process.argv.slice(2);
const ids = args.includes('--generate') ? listGeneratingSites() : listSites();
console.log(args.includes('--json') ? JSON.stringify(ids) : ids.join('\n'));
