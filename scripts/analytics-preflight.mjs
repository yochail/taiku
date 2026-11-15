// Read-only production credential check. Never print response bodies, account IDs or token values.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function preflight({ account, analyticsToken, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? '')) throw new Error('Required Cloudflare account ID is missing or invalid');
  const query = async () => {
    if (!analyticsToken) return { status: 'missing secret', valid: false };
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
        method: 'POST',
        headers: { authorization: `Bearer ${analyticsToken}`, 'content-type': 'text/plain' },
        body: 'SHOW TABLES',
        signal: AbortSignal.timeout(15000),
      });
      let data;
      if (response.ok) {
        try { data = await response.json(); } catch { return { status: response.status, valid: false }; }
      }
      return { status: response.status, valid: response.ok && data?.success !== false };
    } catch {
      return { status: 'network failure', valid: false };
    }
  };
  const sql = await query();
  return {
    sql: { status: sql.status, accessible: sql.valid },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await preflight({
      account: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
      analyticsToken: process.env.CLOUDFLARE_ANALYTICS_API_TOKEN,
    });
    const summary = [
      '## Anonymous analytics read-only preflight',
      `Analytics Engine SQL: ${result.sql.status} (${result.sql.accessible ? 'accessible' : 'CLOUDFLARE_ANALYTICS_API_TOKEN requires Account Analytics Read'}).`,
      'This access check does not check billing, plan, account-wide headroom or confirm that tracking is enabled.',
      'No deployments, bindings, event writes, billing changes or schedules are modified by this workflow.',
    ].join('\n\n') + '\n';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (!result.sql.accessible) process.exitCode = 1;
  } catch {
    console.error('Analytics preflight unavailable: verify the production Cloudflare account ID; tracking remains disabled.');
    process.exitCode = 1;
  }
}
