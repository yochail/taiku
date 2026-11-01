import test from 'node:test';
import assert from 'node:assert/strict';
import { createStyleTracker, endsWithMoral, endsWithQuestion, houseStyle, lintBatch, lintTaik, ruleOfThree } from '../src/lib/house-style.mjs';
import { batchMessages, microMessages, systemMessage } from '../src/lib/prompts.mjs';
import { loadPersonas } from '../src/lib/data.mjs';

const nietzsche = { id: 'nietzsche', name: 'Friedrich Nietzsche', handle: 'GodIsDeadLol', kind: 'thinker' };
const has = (problems, re) => problems.some((p) => re.test(p));

test('house-style.md says the important things', () => {
  const md = houseStyle();
  for (const re of [/larger-than-life/i, /noisy/i, /hot-headed/i, /em[- ]dash/i, /delve/i, /tapestry/i, /rule-of-three|rule of three/i, /own name/i, /moral/i, /typos/i, /hashtags/i]) assert.match(md, re);
});

test('every LLM system prompt carries the house style', () => {
  const all = loadPersonas();
  const byId = new Map(all.map((x) => [x.id, x]));
  const p = all.find((x) => x.kind === 'thinker');
  const needle = houseStyle().slice(0, 80);
  const sys = (msgs) => msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const single = systemMessage(p, byId);
  assert.ok((typeof single === 'string' ? single : single.content).includes(needle), 'single turns');
  const task = { taskId: 't', postId: 'p', role: 'reply', archetype: 'hot_take', length: { min: 20, max: 120 }, media: null };
  assert.ok(sys(batchMessages([{ id: 'a', persona: p, task, ctx: { thread: [] }, passages: [] }], byId)).includes(needle), 'batches');
  assert.ok(sys(microMessages({ requests: [{ id: 'a', persona: p, form: 'short', stance: 'mock', parentText: 'hi' }] }, byId)).includes(needle), 'micro calls');
});

test('banned AI tells are flagged', () => {
  const cases = [
    ['Ah, the eternal question of football.', /Ah/],
    ['This is indeed a robot.', /Indeed/],
    ["Let's unpack this referee.", /unpack/],
    ["It's not a referee, it's a mirror.", /not X/],
    ['The VAR is a testament to our decline.', /testament/],
    ['We must delve into the offside rule.', /delve/],
    ['a rich tapestry of yellow cards', /tapestry/],
    ['how do we navigate this', /navigate/],
    ["in today's world nobody reads", /today/],
    ['The ref — a machine — a god — a joke', /em dash/],
    ['Nietzsche here: the ref is dead', /own name/],
    ['@godisdeadlol says hi', /own name/],
    ['Power, glory, and money.', /rule of three/],
    ['Football. Money. Death.', /rule of three/],
  ];
  for (const [t, re] of cases) assert.ok(has(lintTaik(t, nietzsche), re), `${t} → ${JSON.stringify(lintTaik(t, nietzsche))}`);
});

test('clean, messy human posts pass', () => {
  for (const t of [
    'lmao the robot ref has more conviction than every bishop i ever met',
    'no. absolutely not. i am logging off',
    'the ref — fine, one dash is allowed',
    'Zarathustra would have red-carded the whole league',
    'they gave the whistle to a toaster and called it progress',
    '',
  ]) assert.deepEqual(lintTaik(t, nietzsche), [], t);
});

test('ending heuristics', () => {
  assert.equal(endsWithQuestion('who even asked? 🙄'), true);
  assert.equal(endsWithQuestion('who asked. nobody'), false);
  assert.equal(endsWithMoral('The robot ref won. The lesson here is humility.'), true);
  assert.equal(endsWithMoral('The robot ref won. I lost twenty drachmas.'), false);
  assert.equal(ruleOfThree('I came and saw it'), false);
});

test('batch repetition lint: >40% ending in a question flags the extra items only', () => {
  const texts = ['why?', 'really?', 'is it?', 'ok fine.', 'no.'];
  const flagged = lintBatch(texts);
  assert.deepEqual([...flagged.keys()], [2], 'two of five (40%) are allowed, the third is flagged');
  assert.match(flagged.get(2)[0], /question/);
  assert.equal(lintBatch(['why?', 'what?']).size, 0, 'tiny batches are not judged');
  const morals = lintBatch(['a. the lesson here is pain.', 'b. we must all suffer.', 'c. moral of the story: run.', 'd.', 'e.']);
  assert.ok([...morals.values()].flat().some((x) => /moral/.test(x)));
});

test('run-level tracker flags question endings once the share is too high', () => {
  const tr = createStyleTracker();
  for (const t of ['a.', 'b?', 'c?', 'd.', 'e.']) tr.add(t);
  assert.deepEqual(tr.check('fine.'), []);
  assert.equal(tr.check('who?').length, 1, '3 of 6 would end with "?" (50% > 40%)');
  tr.add('x.');
  tr.add('y.');
  assert.deepEqual(tr.check('who?'), [], '3 of 8 is fine');
});
