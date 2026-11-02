import test from 'node:test';
import assert from 'node:assert/strict';
import { applyHandleStyle, classifyRef, handleRates, nameIndex, seededDecide, siteNameIndex, unlinkUnknown, unresolvedHandles } from '../src/lib/handles.mjs';
import { loadPersonas, validate } from '../src/lib/data.mjs';
import { loadSpec } from '../src/lib/realism.mjs';

const personas = loadPersonas();
const H = Object.fromEntries(personas.map((p) => [p.id, p.handle]));
const yes = () => true;

test('handles: spec carries the @handle-vs-name rates (address > about)', () => {
  const r = handleRates(loadSpec());
  assert.ok(r.address >= 0.6 && r.address <= 0.9, `address ${r.address}`);
  assert.ok(r.about >= 0.2 && r.about <= 0.5, `about ${r.about}`);
  assert.ok(r.address > r.about);
});

test('handles: name index is unambiguous and skips common words and news accounts', () => {
  const idx = siteNameIndex();
  const owner = new Map();
  for (const e of idx) for (const n of e.names) {
    assert.ok(!owner.has(n.toLowerCase()) || owner.get(n.toLowerCase()) === e.id, `${n} ambiguous`);
    owner.set(n.toLowerCase(), e.id);
  }
  assert.equal(owner.get('kant'), 'kant');
  assert.equal(owner.get('galileo'), 'galileo');
  for (const w of ['truth', 'tesla', 'franklin', 'simone', 'mary', 'the ratio']) assert.equal(owner.get(w), undefined, w);
  assert.ok(!idx.some((e) => personas.find((p) => p.id === e.id)?.kind === 'news'));
});

test('handles: vocatives and reply/quote targets are "address"; third-person talk is "about"', () => {
  const at = (t, name, o) => classifyRef(t, t.indexOf(name), t.indexOf(name) + name.length, o);
  assert.equal(at('hey Kant, your walk is late', 'Kant'), 'address');
  assert.equal(at('Nietzsche you clown.', 'Nietzsche'), 'address');
  assert.equal(at('Kant, explain this.', 'Kant'), 'address');
  assert.equal(at('nice try, Marx', 'Marx'), 'address');
  assert.equal(at('cc Hume', 'Hume'), 'address');
  assert.equal(at('Reading Kant on Sundays.', 'Kant'), 'about');
  assert.equal(at('Marx would hate this headline.', 'Marx'), 'about');
  assert.equal(at('Marx would hate this headline.', 'Marx', { isTarget: true }), 'address');
});

test('handles: converts the first reference only, never the author, never inside quotes; idempotent', () => {
  const r = applyHandleStyle('hey Kant, Kant again', { decide: yes });
  assert.equal(r.text, `hey @${H.kant}, Kant again`);
  assert.equal(applyHandleStyle(r.text, { decide: yes }).text, r.text);
  assert.equal(applyHandleStyle('hey Kant, nice walk', { decide: yes, authorId: 'kant' }).text, 'hey Kant, nice walk');
  assert.equal(applyHandleStyle('as he wrote, "hey Kant, wake up"', { decide: yes }).text, 'as he wrote, "hey Kant, wake up"');
  assert.equal(applyHandleStyle('Reading Kant on Sundays.', { decide: yes, only: 'address' }).text, 'Reading Kant on Sundays.');
  assert.equal(applyHandleStyle('Reading Kant on Sundays.', { decide: yes }).text, `Reading @${H.kant} on Sundays.`);
  assert.equal(applyHandleStyle('hey Kant', { decide: yes, maxChars: 9 }).text, 'hey Kant', 'never exceeds the length cap');
});

test('handles: seeded decisions reproduce and land near the spec rates', () => {
  const rates = { address: 0.75, about: 0.35 };
  const d1 = seededDecide(rates, 'p1');
  const d2 = seededDecide(rates, 'p1');
  assert.equal(d1('kant', 'address'), d2('kant', 'address'));
  let a = 0;
  let b = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (seededDecide(rates, `p${i}`)('kant', 'address')) a++;
    if (seededDecide(rates, `p${i}`)('kant', 'about')) b++;
  }
  assert.ok(Math.abs(a / N - 0.75) < 0.04, `address ${a / N}`);
  assert.ok(Math.abs(b / N - 0.35) < 0.04, `about ${b / N}`);
});

test('handles: invented handles never become links; the validator rejects unknown @handles', () => {
  const known = new Set(personas.map((p) => p.handle.toLowerCase()));
  const t = `@${H.kant} and @totally_made_up walk into a bar. mail me@example.org`;
  assert.deepEqual(unresolvedHandles(t, known), ['totally_made_up']);
  assert.equal(unlinkUnknown(t, known), `@${H.kant} and totally_made_up walk into a bar. mail me@example.org`);
  const post = { id: 'x1', authorId: 'kant', type: 'hot_take', text: 'ask @nobody_here_at_all', createdAt: '2026-11-01T10:00:00Z', origin: 'seed', _file: 'f' };
  assert.ok(validate(personas, [post], { knownUrls: new Set() }).some((e) => /@nobody_here_at_all is not a persona handle/.test(e)));
  const ok = { ...post, text: `ask @${H.hume}` };
  assert.ok(!validate(personas, [ok], { knownUrls: new Set() }).some((e) => /persona handle/.test(e)));
});

test('handles: a custom index works for any pack', () => {
  const idx = nameIndex([{ id: 'a', name: 'Rabbi Akiva', handle: 'akiva_ben_y', kind: 'thinker' }, { id: 'n', name: 'Wire', handle: 'wire_news', kind: 'news' }]);
  assert.deepEqual(idx.map((e) => e.id), ['a']);
  assert.equal(applyHandleStyle('hey Akiva, explain', { index: idx, decide: yes }).text, 'hey @akiva_ben_y, explain');
});
