// Read-only production credential check. Never print response bodies, account IDs or token values.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function preflight({ account, token, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !token) throw new Error('Required production Cloudflare credentials are missing');
  const get = async (path, body) => {
    try {
      const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'text/plain' } : {}) },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(15000),
      });
      let data;
      if (response.ok) {
        try { data = await response.json(); } catch { return { status: response.status, valid: false }; }
      }
      return { status: response.status, valid: response.ok && data?.success !== false, data };
    } catch {
      return { status: 'network failure', valid: false };
    }
  };
  const settings = await get('workers/account-settings');
  const subscriptions = await get('subscriptions');
  const sql = await get('analytics_engine/sql', 'SHOW TABLES');
  const plans = subscriptions.valid && Array.isArray(subscriptions.data?.result)
    ? subscriptions.data.result.map((s) => `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''}`.toUpperCase())
    : [];
  const workersPlans = plans.filter((p) => p.includes('WORKERS'));
  const explicitFree = workersPlans.some((p) => /\bFREE\b|WORKERS_FREE/.test(p));
  const paid = workersPlans.some((p) => !/\bFREE\b|WORKERS_FREE/.test(p));
  return {
    settings: { status: settings.status, accessible: settings.valid },
    subscriptions: { status: subscriptions.status, accessible: subscriptions.valid },
    sql: { status: sql.status, accessible: sql.valid },
    workersFreeVerified: subscriptions.valid && explicitFree && !paid,
    // Subscription absence and a successful SQL read are not proof of free entitlement or unused quota.
    headroomVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await preflight({
      account: process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    const summary = [
      '## Anonymous analytics read-only preflight',
      `Workers account settings: ${result.settings.status} (${result.settings.accessible ? 'accessible' : 'requires Workers Scripts Read or Write'}).`,
      `Subscriptions: ${result.subscriptions.status} (${result.subscriptions.accessible ? 'accessible' : 'requires Account Billing Read'}).`,
      `Analytics Engine SQL: ${result.sql.status} (${result.sql.accessible ? 'accessible' : 'requires Account Analytics Read'}).`,
      `Explicit Workers Free entitlement verified: ${result.workersFreeVerified}.`,
      'Account-wide unused write/read allowance verified: false. This check does not infer quota headroom from subscription or dataset defaults.',
      'Tracking remains disabled. No deployments, bindings, event writes, billing changes or schedules are modified by this workflow.',
    ].join('\n\n') + '\n';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (!result.workersFreeVerified || !result.sql.accessible || !result.headroomVerified) process.exitCode = 1;
  } catch {
    console.error('Analytics preflight unavailable: verify production Cloudflare credentials; tracking remains disabled.');
    process.exitCode = 1;
  }
}
