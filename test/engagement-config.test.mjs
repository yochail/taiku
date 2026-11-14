import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/lib/site.mjs';

test('Wrangler analytics is explicit opt-in, with exactly one dataset/budget owner and cross-worker member binding', () => {
  const scratch = path.join(ROOT, 'test', '.engagement-config');
  const files = ['engagement-owner-test', 'engagement-member-test'].map((id) => path.join(ROOT, `wrangler.${id}.json`));
  for (const file of files) assert.ok(!fs.existsSync(file), 'never overwrite another configuration');
  fs.mkdirSync(scratch, { recursive: true });
  const pack = (id, engagementAnalytics) => {
    const dir = path.join(scratch, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'site.json'), JSON.stringify({ id, deploy: { worker: id, ...(engagementAnalytics ? { engagementAnalytics } : {}) } }));
  };
  const generate = (id) => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'wrangler-config.mjs')], {
      env: { ...process.env, SITE: id, SITES_DIR: scratch }, stdio: 'pipe',
    });
    return JSON.parse(fs.readFileSync(path.join(ROOT, `wrangler.${id}.json`), 'utf8'));
  };
  try {
    pack('engagement-owner-test');
    let cfg = generate('engagement-owner-test');
    assert.equal(cfg.analytics_engine_datasets, undefined);
    assert.equal(cfg.vars, undefined);
    assert.equal(cfg.durable_objects.bindings.length, 1);
    assert.equal(cfg.migrations.length, 1);
    pack('engagement-owner-test', { budgetWorker: 'engagement-owner-test', enabled: true });
    pack('engagement-member-test', { budgetWorker: 'engagement-owner-test', enabled: true });
    cfg = generate('engagement-owner-test');
    assert.equal(cfg.vars.ENGAGEMENT_ENABLED, 'true');
    assert.ok(cfg.vars.ENGAGEMENT_SITES.includes('engagement-member-test'));
    assert.deepEqual(cfg.analytics_engine_datasets, [{ binding: 'ENGAGEMENT', dataset: 'visitor_engagement' }]);
    assert.deepEqual(cfg.durable_objects.bindings[1], { name: 'ENGAGEMENT_BUDGET', class_name: 'EngagementBudget' });
    assert.deepEqual(cfg.migrations[1], { tag: 'v2-engagement', new_sqlite_classes: ['EngagementBudget'] });
    const member = generate('engagement-member-test');
    assert.equal(member.analytics_engine_datasets, undefined);
    assert.equal(member.migrations.length, 1);
    assert.equal(member.durable_objects.bindings[1].script_name, 'engagement-owner-test');
    pack('engagement-owner-test', { budgetWorker: 'engagement-owner-test', enabled: false });
    cfg = generate('engagement-owner-test');
    assert.equal(cfg.vars.ENGAGEMENT_ENABLED, 'false');
    assert.equal(cfg.migrations.length, 2, 'switch-off keeps namespace/migration history');
  } finally {
    for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
