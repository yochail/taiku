import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { ROOT, SITE_DIR } from '../src/lib/site.mjs';

function client(initial = {}, id = 'G-TEST1234', navigator = {}) {
  const prefs = { ...initial };
  const scripts = [], handlers = {}, errors = [{ hidden: true }];
  const banner = { hidden: true };
  const buttons = ['accept', 'decline'].map((choice) => ({
    dataset: { ga4Choice: choice }, addEventListener: (_, fn) => { handlers[choice] = fn; },
  }));
  const preference = { addEventListener: (_, fn) => { handlers.preference = fn; } };
  const sandbox = {
    navigator, console, location: { protocol: 'https:', origin: 'https://example.test', reload: () => { sandbox.reloads++; } },
    reloads: 0,
    localStorage: {
      setItem: (key, value) => { prefs[key] = JSON.parse(value); },
      getItem: (key) => JSON.stringify(prefs[key] ?? null),
    },
    document: {
      querySelector: (selector) => selector === '[data-ga4-consent]' ? banner : preference,
      querySelectorAll: (selector) => selector === '[data-ga4-choice]' ? buttons : errors,
      createElement: () => ({}), head: { appendChild: (node) => scripts.push(node) },
    },
    addEventListener: (_, handler) => { handlers.storage = handler; },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/ga4.js', import.meta.url), 'utf8'), sandbox);
  const ga = sandbox.TaikuGA4.create(id, { get: (key, fallback) => prefs[key] ?? fallback });
  return { sandbox, prefs, scripts, handlers, banner, preference, errors, ga };
}

test('Google tag and network activity require explicit consent and respect privacy controls', () => {
  const unset = client();
  assert.equal(unset.banner.hidden, false);
  assert.equal(unset.scripts.length, 0);
  unset.ga.track('like', 'p1', true, true);
  assert.equal(unset.scripts.length, 0);
  unset.handlers.accept();
  assert.equal(unset.prefs.ga4Consent, true);
  assert.equal(unset.sandbox.reloads, 1);
  const enabled = client(unset.prefs);
  assert.equal(enabled.scripts.length, 1);
  assert.equal(enabled.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-TEST1234');
  const config = [...enabled.sandbox.dataLayer].find((item) => item[0] === 'config')[2];
  assert.equal(config.send_page_view, false);
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.cookie_domain, 'none');
  assert.equal(config.page_location, 'https://example.test/');
  assert.equal(config.page_referrer, '');
  const denied = client({ ga4Consent: false });
  assert.equal(denied.scripts.length, 0);
  assert.equal(denied.banner.hidden, true);
  assert.equal(client({ ga4Consent: true, engagementOptOut: true }).scripts.length, 0);
  assert.equal(client({ ga4Consent: true }, 'G-TEST1234', { globalPrivacyControl: true }).scripts.length, 0);
  assert.equal(client({ ga4Consent: true }, 'G-TEST1234', { doNotTrack: '1' }).scripts.length, 0);
  assert.equal(client({ ga4Consent: true }, 'G-invalid?').scripts.length, 0);
  enabled.sandbox.navigator.globalPrivacyControl = true;
  assert.equal(enabled.ga.allowed(), false);
  enabled.sandbox.navigator.globalPrivacyControl = false;
  enabled.sandbox.navigator.doNotTrack = '1';
  assert.equal(enabled.ga.allowed(), false);
  enabled.handlers.decline();
  assert.equal(enabled.prefs.ga4Consent, false);
  assert.equal(enabled.ga.allowed(), false);
  assert.equal(enabled.sandbox['ga-disable-G-TEST1234'], true);
});

test('GA events count only trusted additions and accepted votes, without target or poll option', () => {
  const c = client({ ga4Consent: true });
  for (const type of ['like', 'bookmark', 'follow', 'share']) {
    c.ga.track(type, 'public-id', false, true);
    c.ga.track(type, 'public-id', true, false);
    c.ga.track(type, 'public-id', true, true);
    c.ga.track(type, 'public-id', true, true);
  }
  c.ga.trackAcceptedVote({ ok: false, status: 409 }, 'poll-id', true, true);
  c.ga.trackAcceptedVote({ ok: true }, 'poll-id', false, true);
  c.ga.trackAcceptedVote({ ok: true }, 'poll-id', true, false);
  c.ga.trackAcceptedVote({ ok: true }, 'poll-id', true, true);
  c.ga.trackAcceptedVote({ ok: true }, 'poll-id', true, true);
  const events = [...c.sandbox.dataLayer].filter((entry) => entry[0] === 'event');
  assert.deepEqual(events.map((e) => e[1]), ['engagement_like', 'engagement_bookmark', 'engagement_follow', 'engagement_share', 'engagement_poll_vote']);
  assert.ok(!JSON.stringify(events).includes('public-id'));
  assert.ok(!JSON.stringify(events).includes('poll-id'));
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /ga4\?\.trackAcceptedVote\(r, id, trusted, gaAllowedAtClick\)/);
  c.prefs.engagementOptOut = true;
  c.ga.track('like', 'second', true, true);
  assert.equal([...c.sandbox.dataLayer].filter((entry) => entry[0] === 'event').length, 5);
});

test('revocation and cross-tab changes disable the tag, even when storage fails', () => {
  const c = client({ ga4Consent: true });
  c.sandbox.localStorage.setItem = () => { throw new Error('blocked'); };
  c.handlers.decline();
  assert.equal(c.errors[0].hidden, false);
  assert.equal(c.ga.allowed(), false);
  c.ga.track('share', 'p1', true, true);
  assert.equal([...c.sandbox.dataLayer].filter((entry) => entry[0] === 'event').length, 0);
  const other = client({ ga4Consent: true });
  other.handlers.storage({ key: 'ga4Consent' });
  assert.equal(other.ga.allowed(), false);
  assert.equal(other.sandbox.reloads, 1);
});

test('GA4 configuration is opt-in, validated, and included in packed post CSP', () => {
  const scratch = path.join(ROOT, 'test', '.ga4-fixture');
  const sites = path.join(scratch, 'sites'), pack = path.join(sites, 'taiku');
  const posts = path.join(scratch, 'posts'), out = path.join(scratch, 'out');
  const build = () => execFileSync(process.execPath, [path.join(ROOT, 'src', 'build.mjs')], {
    env: { ...process.env, SITE: 'taiku', SITES_DIR: sites, POSTS_DIR: posts, OUT_DIR: out }, stdio: 'pipe',
  });
  try {
    fs.mkdirSync(scratch, { recursive: true });
    fs.cpSync(SITE_DIR, pack, { recursive: true, filter: (src) => !['content', 'staging', 'docs'].includes(path.relative(SITE_DIR, src).split(path.sep)[0]) });
    fs.mkdirSync(posts);
    fs.copyFileSync(path.join(SITE_DIR, 'content', 'posts', '0000-seed.json'), path.join(posts, 'seed.json'));
    const configPath = path.join(pack, 'site.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete cfg.analytics;
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    build();
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /data-ga4=/);
    assert.doesNotMatch(fs.readFileSync(path.join(out, '_headers'), 'utf8'), /googletagmanager/);
    cfg.analytics = { ga4MeasurementId: 'G-TEST1234', ga4Enabled: false };
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    build();
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /data-ga4=/);
    assert.doesNotMatch(fs.readFileSync(path.join(out, '_headers'), 'utf8'), /googletagmanager/);
    cfg.analytics.ga4Enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    build();
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /data-ga4="G-TEST1234"/);
    assert.match(html, /data-ga4-consent hidden/);
    assert.match(fs.readFileSync(path.join(out, 'me', 'index.html'), 'utf8'), /data-ga4-preference/);
    assert.match(fs.readFileSync(path.join(out, '_headers'), 'utf8'), /https:\/\/www\.googletagmanager\.com/);
    assert.match(JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, '_p', 'meta.json'), 'utf8')).headers), /googletagmanager/);
    cfg.analytics.ga4MeasurementId = 'G-X"><script>';
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    assert.throws(build, /site.json analytics.ga4MeasurementId/);
    delete cfg.analytics.ga4MeasurementId;
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    assert.throws(build, /site.json analytics.ga4MeasurementId/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
