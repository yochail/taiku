import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPersonas } from '../src/lib/data.mjs';
import { stripTells } from '../src/lib/house-style.mjs';
import { seededRng } from '../src/lib/pipeline-util.mjs';
import { userMessage } from '../src/lib/prompts.mjs';
import { relationOf } from '../src/lib/react.mjs';
import { checkCorpus, createSampler, hashtagFactor, loadSpec, mentionFactor, textMentions } from '../src/lib/realism.mjs';
import { ensureMentions, mentionTargets } from '../src/lib/tags.mjs';

const spec = loadSpec();
const personas = loadPersonas();
const byId = new Map(personas.map((p) => [p.id, p]));

test('textMentions skips the leading reply @ and dedupes', () => {
  assert.deepEqual(textMentions('@kant_irl no. ask @dio_in_a_barrel and @dio_in_a_barrel'), ['dio_in_a_barrel']);
  assert.deepEqual(textMentions('cc @a_b, email me@x.com'), ['a_b']);
  assert.deepEqual(textMentions('hi @nobody_here', new Set(['kant_irl'])), []);
});

test('stripTells keeps exactly the sampled number of hashtags', () => {
  assert.equal(stripTells('wrong again #stoic #philosophy'), 'wrong again');
  assert.equal(stripTells('wrong again #stoic #philosophy #x', { hashtags: 2 }), 'wrong again #stoic #philosophy');
  assert.equal(stripTells('#Kant was right #lol', { hashtags: 1 }), '#Kant was right');
  assert.equal(stripTells('a — b #one', { hashtags: 1 }), 'a, b #one');
});

test('spec: mention and hashtag sampling is sourced and the rates land near the cited shares', () => {
  for (const k of ['mentions', 'hashtags']) {
    const s = spec.sampling[k];
    assert.ok(s.sources.length && s.sources.every((id) => spec.sources[id]), `${k} cites known sources`);
    assert.ok(s.confidence.count.startsWith('low'), `${k} count is marked as a product choice`);
  }
  const sm = createSampler(spec, 'tags-test');
  const N = 20000;
  let m = 0;
  let co = 0;
  let h = 0;
  for (let i = 0; i < N; i++) {
    const k = sm.mentionCount('original');
    if (k) m++;
    if (k >= 2) co++;
    if (sm.hashtagCount('original')) h++;
  }
  assert.ok(Math.abs(m / N - spec.sampling.mentions.rate.original) < 0.01, `mention rate ${m / N}`);
  assert.ok(co / m > 0.12 && co / m < 0.28, `co-mention share ${co / m}`);
  assert.ok(Math.abs(h / N - spec.sampling.hashtags.rate.original) < 0.01, `hashtag rate ${h / N}`);
});

test('persona multipliers: hot-headed dunkers tag more, modern/parody accounts hashtag more', () => {
  const dio = byId.get('diogenes');
  const calm = [...personas].filter((p) => p.kind !== 'news').sort((a, b) => mentionFactor(spec, a) - mentionFactor(spec, b))[0];
  assert.ok(mentionFactor(spec, dio) > mentionFactor(spec, calm));
  const parody = personas.find((p) => p.kind === 'parody');
  const ancient = personas.filter((p) => p.kind !== 'parody' && p.kind !== 'news').sort((a, b) => (a.modernity ?? 3) - (b.modernity ?? 3))[0];
  if (parody) assert.ok(hashtagFactor(spec, parody) > hashtagFactor(spec, ancient));
  const lo = spec.sampling.mentions.persona;
  for (const p of personas) assert.ok(mentionFactor(spec, p) >= lo.min && mentionFactor(spec, p) <= lo.max);
});

test('mentionTargets: favours rivals/allies, never self, news or excluded ids', () => {
  const kant = byId.get('kant');
  const rand = seededRng('targets');
  const hits = new Map();
  for (let i = 0; i < 400; i++) {
    for (const id of mentionTargets({ author: kant, personas, n: 2, spec, rand, exclude: ['hume'] })) hits.set(id, (hits.get(id) ?? 0) + 1);
  }
  assert.ok(!hits.has('kant') && !hits.has('hume'));
  assert.ok([...hits.keys()].every((id) => byId.get(id).kind !== 'news'));
  const related = [...hits].filter(([id]) => relationOf(kant, byId.get(id))).reduce((s, [, n]) => s + n, 0);
  assert.ok(related / 800 > 0.4, `related share ${related / 800}`);
});

test('ensureMentions appends missing tags only when they fit', () => {
  assert.equal(ensureMentions('you again', ['kant_irl']), 'you again @kant_irl');
  assert.equal(ensureMentions('yo @kant_irl', ['kant_irl']), 'yo @kant_irl');
  assert.equal(ensureMentions('x'.repeat(275), ['kant_irl']), 'x'.repeat(275));
});

test('prompt carries the sampled tags and hashtag count', () => {
  const task = { role: 'original', archetype: 'hot_take', length: { min: 40, max: 90 }, hashtags: 2, mentions: ['kant_irl', 'dio_in_a_barrel'] };
  const msg = userMessage(task, {});
  assert.match(msg, /add exactly 2 hashtags/);
  assert.match(msg, /tag @kant_irl and @dio_in_a_barrel/);
  assert.match(userMessage({ ...task, hashtags: 0, mentions: [] }, {}), /no hashtags/);
});

test('realism measures mention and co-mention shares', () => {
  const h = (id) => byId.get(id).handle;
  const posts = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, authorId: 'kant', createdAt: '2026-10-01T12:03:00Z', text: i < 4 ? `look @${h('hume')}${i < 2 ? ` @${h('diogenes')}` : ''}` : i < 8 ? `@${h('hume')} leading only` : 'plain' }));
  const r = Object.fromEntries(checkCorpus(posts, personas, spec).results.map((x) => [x.id, x.value]));
  assert.equal(r['text.mention_share'], 4 / 40);
  assert.equal(r['text.co_mention_share'], 0.5);
});
