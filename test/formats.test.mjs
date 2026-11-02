import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotation, entropy, formatOf, formatOfTask, maxRun, rotateMediaWeights, rotationStats } from '../src/lib/formats.mjs';
import { createSampler, loadSpec } from '../src/lib/realism.mjs';
import { gateDay } from '../src/lib/daygate.mjs';
import { loadPersonas } from '../src/lib/data.mjs';

const at = (d, h) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:17:00Z`;
const p = (id, authorId, createdAt, extra = {}) => ({ id, authorId, createdAt, type: 'hot_take', text: 'x'.repeat(50), ...extra });

test('formatOf / formatOfTask classify items', () => {
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { media: [{ kind: 'meme' }] })), 'meme');
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { media: [{ kind: 'x_post' }] })), 'ref');
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { quoteOf: 'z' })), 'quote');
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { quoteOf: 'z', media: [{ kind: 'chart' }] })), 'quote:chart');
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { inReplyTo: 'z' })), 'reply');
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { poll: { options: [] } })), 'poll');
  assert.equal(formatOf(p('a', 'kant', at(1, 9), { type: 'daily_life' })), 'daily_life');
  assert.equal(formatOfTask({ role: 'original', media: 'link_card', archetype: 'news_take' }), 'ref');
  assert.equal(formatOfTask({ role: 'original', media: null, archetype: 'aphorism' }), 'aphorism');
});

test('rotation: penalty^k over the persona\'s last items across days; replies/retaiks ignored', () => {
  const prior = [
    p('1', 'kant', at(1, 9), { media: [{ kind: 'meme' }] }),
    p('2', 'kant', at(2, 9), { media: [{ kind: 'meme' }] }),
    p('3', 'kant', at(2, 10), { inReplyTo: '1' }),
    p('4', 'kant', at(3, 9), { retaikOf: '9' }),
    p('5', 'hume', at(3, 9), { media: [{ kind: 'meme' }] }),
  ];
  const rot = createRotation(prior, { lookback: 5, penalty: 0.3 });
  assert.deepEqual(rot.history('kant'), ['meme', 'meme']);
  assert.ok(Math.abs(rot.factor('kant', 'meme') - 0.09) < 1e-9);
  assert.equal(rot.factor('kant', 'chart'), 1);
  assert.equal(rot.factor('kant', 'reply'), 1);
  for (const f of ['a', 'b', 'c', 'd', 'e']) rot.push('kant', f);
  assert.equal(rot.factor('kant', 'meme'), 1, 'only the last lookback items count');
});

test('rotateMediaWeights keeps the media mass (spec share) and shifts it away from recent kinds', () => {
  const rot = createRotation([p('1', 'kant', at(1, 9), { media: [{ kind: 'meme' }] }), p('2', 'kant', at(1, 10), { media: [{ kind: 'meme' }] })]);
  const ws = [['none', 0.7], ['meme', 0.1], ['image', 0.1], ['chart', 0.1]];
  const out = Object.fromEntries(rotateMediaWeights(ws, rot, 'kant'));
  assert.equal(out.none, 0.7);
  assert.ok(Math.abs(out.meme + out.image + out.chart - 0.3) < 1e-9);
  assert.ok(out.meme < 0.02 && out.image > 0.14, JSON.stringify(out));
});

test('sampler.mediaKind with rotation avoids the persona\'s recent kind', () => {
  const spec = loadSpec();
  const persona = loadPersonas().find((x) => x.id === 'diogenes');
  const rot = createRotation(Array.from({ length: 5 }, (_, i) => p(`m${i}`, persona.id, at(1, 8 + i), { media: [{ kind: 'meme' }] })));
  const count = (rotation) => {
    const s = createSampler(spec, 'rot-test');
    let memes = 0;
    for (let i = 0; i < 4000; i++) if (s.mediaKind('original', persona, rotation) === 'meme') memes++;
    return memes;
  };
  assert.ok(count({ rot, pid: persona.id }) < count(null) * 0.05);
});

test('maxRun / entropy / rotationStats', () => {
  assert.equal(maxRun(['a', 'a', 'b', 'a', 'a', 'a']), 3);
  assert.equal(entropy(['a', 'a']), 0);
  assert.equal(entropy(['a', 'b']), 1);
  const st = rotationStats([p('1', 'kant', at(1, 9)), p('2', 'kant', at(1, 10)), p('3', 'kant', at(1, 11), { type: 'aphorism' })]);
  assert.deepEqual(st.map((r) => [r.personaId, r.maxRun, r.run.f]), [['kant', 2, 'hot_take']]);
});

test('day gate: a same-format run of 5 ending today fails persona.format_run; earlier runs do not', () => {
  const spec = loadSpec();
  const personas = loadPersonas();
  const context = [1, 2, 3].map((h) => p(`c${h}`, 'kant', at(4, 8 + h)));
  const day = [p('d1', 'kant', at(5, 9)), p('d2', 'kant', at(5, 11))];
  const g = gateDay({ posts: day, context, personas, spec });
  const c = g.checks.find((x) => x.id === 'persona.format_run');
  assert.equal(c.status, 'fail');
  assert.match(c.detail[0], /kant: 5× hot_take/);
  const ok = gateDay({ posts: [p('d1', 'kant', at(5, 9), { type: 'aphorism' }), p('d2', 'kant', at(5, 11), { media: [{ kind: 'chart' }] })], context: [...context, p('c0', 'kant', at(4, 8))], personas, spec });
  assert.equal(ok.checks.find((x) => x.id === 'persona.format_run').status, 'pass');
});
