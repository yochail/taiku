import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadPersonas } from '../src/lib/data.mjs';
import { COOLDOWN_DAYS, appendPoolEntries, chooseStance, createPoolPicker, entryMedia, inCooldown, loadPools, loadReactionUsage, reactionId, saveReactionUsage, usageKey } from '../src/lib/pools.mjs';
import { seededRng } from '../src/lib/pipeline-util.mjs';

const personas = loadPersonas();
const thinker = personas.find((p) => p.kind === 'thinker' && (p.reaction_pool ?? []).length >= 60);
const SCRATCH = path.join(ROOT, 'test', '.pools-scratch');
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const D = '2026-11-02';

test('cooldown: an entry is never reused within 14 days; exhaustion returns null (→ LLM fallback)', async () => {
  const pools = loadPools([thinker]);
  const used = new Map();
  const picker = createPoolPicker({ pools, used, date: D, rand: seededRng('t', 'cool') });
  const emo = pools.get(thinker.id).filter((e) => e.kind === 'emoji');
  const stance = ['mock', 'agree', 'disagree', 'awe', 'confused', 'hype'].find((s) => emo.some((e) => e.stance === s));
  const want = emo.filter((e) => e.stance === stance).length;
  assert.ok(want >= 1, 'fixture persona has emoji entries');
  const got = [];
  for (let i = 0; i < want + 3; i++) got.push(await picker.pick({ persona: thinker, form: 'emoji_only', stance }));
  const picked = got.filter(Boolean);
  assert.equal(picked.length, want);
  assert.equal(new Set(picked.map((e) => e.rid)).size, want, 'no entry twice');
  assert.equal(got.slice(want).every((x) => x === null), true, 'exhausted → null, never early reuse');
  assert.equal(picker.stats.exhausted, 3);
  for (let d = 1; d < COOLDOWN_DAYS; d++) {
    const later = createPoolPicker({ pools, used, date: addDays(D, d) });
    assert.equal(await later.pick({ persona: thinker, form: 'emoji_only', stance }), null, `day +${d} still cooling down`);
  }
  const fresh = createPoolPicker({ pools, used, date: addDays(D, COOLDOWN_DAYS) });
  assert.ok(await fresh.pick({ persona: thinker, form: 'emoji_only', stance }), 'available again after 14 days');
  assert.equal(inCooldown('2026-11-01', '2026-11-14'), true);
  assert.equal(inCooldown('2026-11-01', '2026-11-15'), false);
});

test('stance filter: picks only entries of the requested stance and form; news is always neutral', async () => {
  const pools = loadPools([thinker]);
  const picker = createPoolPicker({ pools, date: D, rand: seededRng('t', 'stance') });
  for (const stance of ['agree', 'disagree', 'mock', 'awe', 'confused', 'hype']) {
    for (const form of ['emoji_only', 'few_words', 'gif_only', 'meme_only']) {
      const e = await picker.pick({ persona: thinker, form, stance });
      if (e) assert.equal(e.stance, stance, `${form}/${stance}`);
    }
  }
  const news = personas.find((p) => p.kind === 'news');
  assert.equal(chooseStance({ persona: news }), 'neutral');
});

test('chooseStance: rivals disagree/mock, allies agree/hype', () => {
  const rivalId = (thinker.rivals ?? [])[0]?.id;
  const allyId = (thinker.allies ?? [])[0]?.id;
  const count = (target) => {
    const rand = seededRng('stance', target ?? 'none');
    const n = {};
    for (let i = 0; i < 400; i++) {
      const s = chooseStance({ persona: thinker, targetAuthorId: target, rand });
      n[s] = (n[s] ?? 0) + 1;
    }
    return n;
  };
  if (rivalId) {
    const r = count(rivalId);
    assert.ok((r.disagree ?? 0) + (r.mock ?? 0) > 260, JSON.stringify(r));
  }
  if (allyId) {
    const a = count(allyId);
    assert.ok((a.agree ?? 0) + (a.hype ?? 0) > 220, JSON.stringify(a));
  }
  const hinted = chooseStance({ persona: thinker, hint: { awe: 1, agree: -0.2, disagree: -0.2, mock: -0.2, confused: -0.2, hype: -0.2 }, rand: () => 0.5 });
  assert.equal(hinted, 'awe', 'embedding stance hint shifts the choice');
});

test('ranking: embedding cosine when available, tag overlap otherwise', async () => {
  const p = { ...thinker, reaction_pool: [
    { text: 'robots again', stance: 'mock', tags: ['robots', 'tech'], tone: 'smug' },
    { text: 'wine o clock', stance: 'mock', tags: ['wine', 'party'], tone: 'giddy' },
  ] };
  const pools = loadPools([p]);
  const tagPick = await createPoolPicker({ pools, date: D, rand: () => 0 }).pick({ persona: p, form: 'few_words', stance: 'mock', postTags: ['wine'] });
  assert.equal(tagPick.text, 'wine o clock');
  const embedder = { kind: 'minilm', embed: async (texts) => texts.map((t) => (/robot/.test(t) ? [1, 0] : [0, 1])) };
  const embPick = await createPoolPicker({ pools, date: D, rand: () => 0, embedder }).pick({ persona: p, form: 'few_words', stance: 'mock', postVec: [1, 0], postTags: ['wine'] });
  assert.equal(embPick.text, 'robots again');
});

test('usage is rebuilt from the state file AND a scan of every post file (all paths count)', () => {
  const dir = path.join(SCRATCH, 'scan');
  fs.rmSync(dir, { recursive: true, force: true });
  const postsDir = path.join(dir, 'content', 'posts');
  fs.mkdirSync(postsDir, { recursive: true });
  const [e1, e2, e3] = loadPools([thinker]).get(thinker.id);
  fs.writeFileSync(path.join(postsDir, 'daily-2026-10-30.json'), JSON.stringify({ origin: 'local', provider: 'local', posts: [{ id: 'a', authorId: thinker.id, reactionId: e1.rid, createdAt: '2026-10-30T10:00:00Z' }] }));
  fs.writeFileSync(path.join(postsDir, 'handwritten.json'), JSON.stringify([{ id: 'b', authorId: thinker.id, reactionId: e2.rid, createdAt: '2026-10-31T10:00:00Z' }]));
  fs.writeFileSync(path.join(postsDir, `daily-${D}.json`), JSON.stringify({ posts: [{ id: 'c', authorId: thinker.id, reactionId: e3.rid, createdAt: `${D}T10:00:00Z` }] }));
  const stateFile = path.join(dir, 'content', 'state', 'reaction-usage.json');
  saveReactionUsage(stateFile, new Map([[usageKey(thinker.id, e3.rid), '2026-10-29'], [usageKey('x', 'rx-old'), '2026-01-01']]), D);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).used['x|rx-old'], undefined, 'old usage is pruned');
  const { used, scanned } = loadReactionUsage({ stateFile, postsDir, exclude: [`daily-${D}.json`] });
  assert.equal(scanned, 2);
  assert.equal(used.get(usageKey(thinker.id, e1.rid)), '2026-10-30');
  assert.equal(used.get(usageKey(thinker.id, e2.rid)), '2026-10-31');
  assert.equal(used.get(usageKey(thinker.id, e3.rid)), '2026-10-29', 'state file counts; this run’s own file is excluded');
});

test('micro-call refills: only validated entries are appended to content/pools and merged on load', () => {
  const root = path.join(SCRATCH, 'refill');
  fs.rmSync(root, { recursive: true, force: true });
  const ok = appendPoolEntries(root, thinker, [
    { text: 'brand new sulk', stance: 'mock', tags: ['sulk'], tone: 'petty' },
    { text: "Ah, let's unpack this", stance: 'mock', tags: ['x'], tone: 'smug' },
    { emoji: '🙄', stance: 'nope', tags: ['x'], tone: 'smug' },
    { text: 'brand new sulk', stance: 'mock', tags: ['sulk'], tone: 'petty' },
  ], { date: D });
  assert.deepEqual(ok.map((e) => e.text), ['brand new sulk']);
  const merged = loadPools([thinker], { root }).get(thinker.id);
  assert.ok(merged.some((e) => e.text === 'brand new sulk' && e.source === 'pool'));
  assert.ok(merged.length > (thinker.reaction_pool.length - 30));
  assert.equal(reactionId({ text: 'brand new sulk' }), merged.find((e) => e.text === 'brand new sulk').rid);
});

test('gif_query → giphy plan with local fallback; meme_template → meme render spec', () => {
  const g = entryMedia({ kind: 'gif_query', gif_query: 'slow clap', stance: 'mock' }, { giphyEnabled: false, rand: () => 0 });
  assert.equal(g.plan.kind, 'gif');
  assert.equal(g.plan.source, 'local');
  assert.equal(g.fill.query, 'slow clap');
  assert.equal(entryMedia({ kind: 'gif_query', gif_query: 'slow clap', stance: 'mock' }, { giphyEnabled: true }).plan.source, 'giphy');
  const m = entryMedia({ kind: 'meme_template', meme_template: 'Drake: hemlock / more hemlock', stance: 'mock' }, { rand: () => 0 });
  assert.equal(m.plan.kind, 'meme');
});
