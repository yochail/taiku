import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPersonas } from '../src/lib/data.mjs';
import { mentionDebts, mentionDecision, resurface, traction } from '../src/lib/followon.mjs';
import { loadSpec, measure } from '../src/lib/realism.mjs';
import { planDay } from '../src/lib/run.mjs';
import { editorialDay } from '../src/lib/pipeline-util.mjs';

const personas = loadPersonas();
const spec = loadSpec();
const byId = new Map(personas.map((p) => [p.id, p]));
const always = (median) => {
  const s = structuredClone(spec);
  s.sampling.mention_response.actions = { reply: 1, quote: 0, like: 0, ignore: 0 };
  s.sampling.mention_response.delay_minutes.lognormal = { median, sigma: 0.001 };
  return s;
};

test('mention decision: seeded by (post, persona), every action reachable, delays bounded', () => {
  const kant = byId.get('kant');
  assert.deepEqual(mentionDecision(spec, kant, 'p1', byId.get('hume')), mentionDecision(spec, kant, 'p1', byId.get('hume')));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const d = mentionDecision(spec, kant, `p${i}`, byId.get('hume'));
    seen.add(d.action);
    assert.ok(d.delayMin >= 1 && d.delayMin <= spec.sampling.mention_response.delay_minutes.max);
  }
  assert.deepEqual([...seen].sort(), ['ignore', 'like', 'quote', 'reply']);
});

test('mention debts: an unanswered mention from yesterday is answered today, once', () => {
  const s = always(600);
  const day = editorialDay('2026-12-02', 'UTC');
  const post = { id: 'old1', authorId: 'hume', text: 'custom is king, ask @' + byId.get('kant').handle, createdAt: new Date(day.start - 300 * 60000).toISOString() };
  const debts = mentionDebts({ past: [post], personas, spec: s, start: day.start, end: day.end });
  assert.equal(debts.length, 1);
  assert.equal(debts[0].personaId, 'kant');
  assert.equal(debts[0].at, day.start + 300 * 60000);
  const answered = [post, { id: 'r1', authorId: 'kant', inReplyTo: 'old1', text: 'no', createdAt: new Date(day.start - 60000).toISOString() }];
  assert.equal(mentionDebts({ past: answered, personas, spec: s, start: day.start, end: day.end }).length, 0);

  const plan = planDay({ personas, spec: s, topics: [], date: '2026-12-02', seed: 't', nonce: 'n', tz: 'UTC', content: { originals: 6 }, past: [post] });
  const ext = plan.nodes.find((n) => n.kind === 'external');
  assert.equal(ext?.external.id, 'old1');
  const follow = plan.nodes.find((n) => n.followOn === 'mention' && n.parent === ext.id);
  assert.equal(follow?.authorId, 'kant');
  assert.ok(follow.createdAt >= day.start);
});

test('mention reactions in-day: every tagged persona with a reply outcome replies to the tagging post', () => {
  const s = always(5);
  s.sampling.mentions.rate = { original: 1, reply: 0, quote: 0 };
  const plan = planDay({ personas, spec: s, topics: [], date: '2026-12-02', seed: 't2', nonce: 'n', tz: 'UTC', content: { originals: 6 } });
  const tagged = plan.nodes.filter((n) => n.role === 'original' && n.textMentions?.length);
  assert.ok(tagged.length > 0);
  for (const n of tagged) for (const m of n.textMentions) {
    if ((byId.get(m)?.kind ?? 'thinker') === 'news') continue;
    assert.ok(plan.nodes.some((x) => x.authorId === m && (x.parent === n.id || x.quoteOf === n.id)), `${m} answers ${n.id}`);
  }
});

test('mention_answered_share metric counts answers from other files via context', () => {
  const h = byId.get('kant').handle;
  const t0 = Date.parse('2026-12-01T10:00:00Z');
  const day = [{ id: 'a', authorId: 'hume', text: `hey @${h} wake up`, createdAt: new Date(t0).toISOString() }];
  const context = [{ id: 'b', authorId: 'kant', inReplyTo: 'a', text: 'I am awake', createdAt: new Date(t0 + 3 * 864e5).toISOString() }];
  const m = measure(day, personas, spec, { context });
  assert.equal(m['engagement.mention_answered_share']?.value ?? m.get?.('engagement.mention_answered_share')?.value, 1);
});


const pastDays = (date, n = 30) => {
  const day = editorialDay(date, 'UTC');
  const authors = ['kant', 'hume', 'nietzsche', 'diogenes', 'camus', 'spinoza'];
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, authorId: authors[i % authors.length], text: `a past taik number ${i} with enough words`, createdAt: new Date(day.start - (30 + i * 4) * 3.6e6).toISOString(), crowdLikeBase: i === 3 ? 900 : 5, crowdRepostBase: 1 }));
};

test('resurface: deterministic, heavy-tailed toward traction, past posts only, respects timing', () => {
  const s = structuredClone(spec);
  s.sampling.resurfacing.seeds_per_day_mean = 6;
  const day = editorialDay('2026-12-05', 'UTC');
  const past = pastDays('2026-12-05');
  const atFn = (h = 0) => day.start + Math.max(h, 12) * 3.6e6;
  const run = (seed) => resurface({ past, personas, spec: s, start: day.start, end: day.end, seed, atFn });
  assert.deepEqual(run('a'), run('a'));
  let hot = 0;
  let total = 0;
  for (let i = 0; i < 60; i++) for (const e of run(`s${i}`)) {
    total++;
    if (e.post.id === 'p3') hot++;
    assert.notEqual(e.personaId, e.post.authorId);
    assert.ok(e.at >= day.start && e.at < day.end && e.at >= Date.parse(e.post.createdAt) + 3.6e6);
    assert.ok(Date.parse(e.post.createdAt) >= day.start - s.sampling.resurfacing.window_days * 864e5);
    assert.ok(['reply', 'quote'].includes(e.action));
  }
  assert.ok(total > 100);
  assert.ok(hot / total > 0.3, `high-traction post dominates (${hot}/${total})`);
  assert.ok(traction(past[3], new Map(), day.start, s.sampling.resurfacing) > traction(past[4], new Map(), day.start, s.sampling.resurfacing));
});

test('resurface: planDay adds cross-day follow-ons as external reactions; metric counts them', () => {
  const s = structuredClone(spec);
  s.sampling.resurfacing.seeds_per_day_mean = 5;
  const past = pastDays('2026-12-05');
  const plan = planDay({ personas, spec: s, topics: [], date: '2026-12-05', seed: 'r', nonce: 'n', tz: 'UTC', content: { originals: 6 }, past });
  const follow = plan.nodes.filter((n) => n.followOn === 'resurface' || n.followOn === 'pile-on');
  assert.ok(follow.length > 0);
  for (const n of follow) assert.ok(plan.nodes.some((x) => x.kind === 'external' && x.id === (n.parent ?? n.quoteOf)));
  const again = planDay({ personas, spec: s, topics: [], date: '2026-12-05', seed: 'r', nonce: 'n', tz: 'UTC', content: { originals: 6 }, past });
  assert.deepEqual(again.nodes.filter((n) => n.followOn === 'resurface' || n.followOn === 'pile-on').map((n) => [n.id, n.createdAt]), follow.map((n) => [n.id, n.createdAt]));

  const t0 = Date.parse('2026-12-01T10:00:00Z');
  const context = [{ id: 'old', authorId: 'kant', text: 'duty first', createdAt: new Date(t0).toISOString() }];
  const day = [
    { id: 'r1', authorId: 'hume', inReplyTo: 'old', text: 'late but no', createdAt: new Date(t0 + 2 * 864e5).toISOString() },
    { id: 'r2', authorId: 'camus', inReplyTo: 'old', text: 'same day', createdAt: new Date(t0 + 3.6e6).toISOString() },
  ];
  assert.equal(measure(day, personas, spec, { context })['engagement.cross_day_reaction_share'].value, 0.5);
});
