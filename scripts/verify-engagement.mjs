import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { listSites, siteDir } from '../src/lib/site.mjs';
import path from 'node:path';

export async function verifyEngagement({ origin, site, account, token, fetcher = fetch, pause = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !token) throw new Error('Analytics credentials missing');
  const inventory = await fetcher(`${origin}/_p/engagement.json`);
  if (!inventory.ok) throw new Error('Public event inventory unavailable');
  const index = await inventory.json();
  const id = index.posts?.[0];
  if (index.site !== site || !/^[A-Za-z0-9_.-]{1,80}$/.test(id ?? '') || !/^[a-z0-9-]{1,40}$/.test(site)) throw new Error('Invalid public inventory');
  const since = Math.floor(Date.now() / 1000);
  // One disclosed synthetic share click, using a public target. Never retry this write.
  const event = await fetcher(`${origin}/api/engagement`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'share', id }), credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (event.status !== 204) throw new Error(`Event rejected (HTTP ${event.status})`);
  const query = `SELECT SUM(_sample_interval * double2) AS events FROM visitor_engagement WHERE timestamp >= toDateTime(${since}) AND blob1 = 'share' AND blob2 = '${id}' AND blob3 = '${site}' FORMAT JSON`;
  for (let i = 0; i < 3; i++) {
    await pause(10000);
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: query,
    });
    if (!response.ok) throw new Error(`SQL read rejected (HTTP ${response.status}); Account Analytics Read required`);
    const data = await response.json();
    if (Number(data.data?.[0]?.events) >= 1) return { site, id };
  }
  throw new Error('Event accepted but not observed in SQL within 30 seconds');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const site = process.env.VERIFY_SITE;
    if (!listSites().includes(site)) throw new Error('Unknown site');
    const cfg = JSON.parse(fs.readFileSync(path.join(siteDir(site), 'site.json'), 'utf8'));
    const result = await verifyEngagement({
      site, origin: new URL(cfg.baseUrl).origin,
      account: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_ANALYTICS_API_TOKEN,
    });
    const summary = `Verified one accepted test share in Analytics Engine for ${result.site}, public post ${result.id}. This synthetic share is included in production counts; no visitor identifiers or poll votes were sent.\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch {
    console.error('Live verification failed: check deployment/bindings and Account Analytics Read; no event retries or private response details.');
    process.exitCode = 1;
  }
}
