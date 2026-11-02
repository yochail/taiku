import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { ROOT, loadPersonas } from '../src/lib/data.mjs';
import { checkNovelty, cappedPhrases, catchphrases, compareNovelty, fingerprint, ideaUsage, ledgerItems, lruWeight, noveltyConfig, noveltyContext, pickIdea, scanRepetition } from '../src/lib/ideas.mjs';
import { loadSpec } from '../src/lib/realism.mjs';
import { sitePath } from '../src/lib/site.mjs';

const DAY = 864e5;
const personas = loadPersonas();
const byId = new Map(personas.map((p) => [p.id, p]));
const descartes = byId.get('descartes');
const cfg = noveltyConfig(loadSpec());
const now = Date.parse('2026-12-10T00:00:00Z');
const at = (d) => new Date(now - d * DAY).toISOString();

test('ledger: every thinker has core ideas, works and deep cuts beyond the famous ones', () => {
  for (const p of personas.filter((x) => x.kind !== 'news' && fs.existsSync(sitePath('ideas', `${x.id}.json`)))) {
    const items = ledgerItems(p);
    assert.ok(items.some((i) => i.id.startsWith('deep:')), `${p.id} has deep cuts`);
    assert.ok(items.length >= 8, `${p.id} ledger has ${items.length} items`);
  }
});

test('LRU: recently used ideas are rarely drawn, unused ones dominate', () => {
  assert.equal(lruWeight(undefined, now), 1);
  assert.ok(lruWeight(now - DAY, now) < 0.03);
  assert.equal(lruWeight(now - 30 * DAY, now), 1);
  const items = ledgerItems(descartes);
  const usage = new Map(items.slice(1).map((i) => [i.id, now - DAY]));
  let r = 0;
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const counts = new Map();
  for (let i = 0; i < 400; i++) { const it = pickIdea(rand, items, usage, now); counts.set(it.id, (counts.get(it.id) ?? 0) + 1); }
  assert.ok((counts.get(items[0].id) ?? 0) > 400 / 3, 'the one unused idea wins most draws');
  const used = ideaUsage(items, [{ text: 'the wax argument again: melt the wax, the senses lie, knowing is by the mind', createdAt: at(2) }]);
  assert.ok([...used.keys()].some((k) => k.startsWith('deep:')), 'usage detects a deep cut');
});

test('catchphrase cap: the cogito at most once per persona per two weeks', () => {
  const list = catchphrases(descartes);
  assert.ok(list.some((c) => /cogito/i.test(c.label)));
  const past = [{ id: 'a', text: 'I think, therefore I am. Still true on a Monday.', createdAt: at(3) }];
  assert.ok(cappedPhrases(list, past, now, cfg.catchphrase_window_days).length >= 1);
  assert.equal(cappedPhrases(list, [{ ...past[0], createdAt: at(20) }], now, cfg.catchphrase_window_days).length, 0);
  const nctx = noveltyContext(descartes, past, now, cfg);
  const v = checkNovelty('Cogito, ergo sum, and your feed cannot doubt that away.', nctx);
  assert.match(v?.reason ?? '', /^catchphrase:/);
});

test('similarity: a reworded repeat is caught, a different idea passes', () => {
  const prev = [{ id: 'old', text: 'Method first: divide every difficulty into as many parts as possible, then order your thoughts from simplest to hardest.' }].map((p) => ({ ...p, fp: fingerprint(p.text, cfg) }));
  const again = compareNovelty(fingerprint('Divide every difficulty into as many parts as possible, then order your thoughts simplest to hardest. Method first, always.', cfg), prev, cfg);
  assert.equal(again.repetitive, true);
  assert.equal(again.otherId, 'old');
  const fresh = compareNovelty(fingerprint('Wonder is the first passion. Before you judge the comet, be astonished by it for one honest minute.', cfg), prev, cfg);
  assert.equal(fresh.repetitive, false);
});

test('scanRepetition flags only the later item, per persona, and exempts other personas', () => {
  const text = 'Method first: divide every difficulty into as many parts as possible, then order your thoughts from simplest to hardest.';
  const posts = [
    { id: 'p1', authorId: 'descartes', text, createdAt: at(3) },
    { id: 'p2', authorId: 'descartes', text: `${text} Again.`, createdAt: at(1) },
    { id: 'p3', authorId: 'kant', text, createdAt: at(1) },
  ];
  const hits = scanRepetition(posts, { personas, cfg });
  assert.deepEqual(hits.map((h) => [h.postId, h.reason, h.otherId]), [['p2', 'repetitive', 'p1']]);
});

test('repetition audit script is deterministic and lists file + id per persona', () => {
  const out = 'staging/.repetition-audit.test.json';
  const run = () => {
    const r = spawnSync(process.execPath, ['scripts/repetition-audit.mjs', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(sitePath(out), 'utf8');
  };
  try {
    const a = run();
    assert.equal(run(), a);
    const doc = JSON.parse(a);
    assert.equal(doc.total, Object.values(doc.personas).reduce((n, xs) => n + xs.length, 0));
    for (const xs of Object.values(doc.personas)) for (const x of xs) {
      assert.ok(x.file && x.id && x.reason);
      assert.ok(fs.existsSync(sitePath(x.file)), x.file);
    }
  } finally {
    fs.rmSync(sitePath(out), { force: true });
  }
});
