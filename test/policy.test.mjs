import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPersonas, loadPosts } from '../src/lib/data.mjs';
import { checkPost, nameCandidates, policyContext, repairHint } from '../src/lib/policy.mjs';

const personas = loadPersonas();
const ctx = policyContext(personas, { allowNames: ['Taylor Swift'] });
const rules = (post, opts) => checkPost(post, ctx, opts).violations.map((v) => v.rule);

test('clean taiks pass', () => {
  assert.deepEqual(rules({ text: 'the unexamined feed is not worth scrolling. 🤔' }), []);
  assert.deepEqual(rules({ text: `@${personas[0].handle} counterpoint: no.` }), []);
  assert.deepEqual(rules({ text: `@${personas[0].id} you again` }), [], 'persona ids are fine too');
  assert.deepEqual(rules({ text: 'damn, this senate bill is a mess' }, { topic: { title: 'Senate passes AI label bill' } }), [], 'mild profanity + politics are allowed');
});

test('URLs, domains and non-persona @handles are rejected (text, poll, media, original)', () => {
  assert.ok(rules({ text: 'read this https://evil.example/x' }).includes('url'));
  assert.ok(rules({ text: 'more at evil-site.com tonight' }).includes('url'));
  assert.ok(rules({ text: 'hey @elonmusk explain yourself' }).includes('handle'));
  assert.ok(rules({ text: 'vote', poll: { options: [{ text: 'yes' }, { text: 'visit www.x.io' }] } }).includes('url'));
  assert.ok(rules({ text: 'ok', media: [{ kind: 'meme', alt: 'meme', render: { lines: ['top', 'follow @randomguy'] } }] }).includes('handle'));
  assert.ok(rules({ text: 'ok', original: { lang: 'de', text: 'siehe www.beispiel.de' } }).includes('url'));
});

test('blocklist: sexual, gore, self-harm terms', () => {
  assert.ok(rules({ text: 'this take is pure porn for pedants' }).includes('sexual'));
  assert.ok(rules({ text: 'the debate ended with everyone decapitated' }).includes('gore'));
  assert.ok(rules({ text: 'kys, sophist' }).includes('self-harm'));
});

test('living people must be in the topic title or the allowlist', () => {
  assert.ok(rules({ text: 'Jeff Bezos would never read Seneca' }).includes('living-person'));
  assert.deepEqual(rules({ text: 'Jeff Bezos would never read Seneca' }, { topic: { title: 'Jeff Bezos launches a new rocket' } }), []);
  assert.deepEqual(rules({ text: 'Taylor Swift understands eternal recurrence' }), [], 'POLICY_ALLOW_NAMES works');
  assert.deepEqual(rules({ text: 'Immanuel Kant would hate this' }), [], 'historical names from persona data are fine');
  assert.ok(nameCandidates('Elon Musk and Mark Zuckerberg walk into the agora').length === 2);
});

test('tragedy mockery and tragedy topics fail', () => {
  assert.ok(rules({ text: 'earthquake death toll rises lol' }).includes('tragedy-mockery'));
  assert.ok(rules({ text: 'thoughts.' }, { topic: { title: 'Dozens killed in train crash' } }).includes('tragedy-topic'));
});

test('repair hint names the broken rules', () => {
  const v = checkPost({ text: 'see www.x.com @nobody_real' }, ctx).violations;
  assert.match(repairHint(v), /url/);
  assert.match(repairHint(v), /handle/);
});

test('no false positives on the committed corpus', () => {
  const bad = [];
  for (const p of loadPosts()) {
    if (p.origin === 'mock') continue;
    const r = checkPost({ text: p.text, poll: p.poll, original: p.original }, ctx, { topic: p.topic });
    const real = r.violations.filter((v) => v.rule !== 'living-person');
    if (real.length) bad.push(`${p.id}: ${real.map((v) => `${v.rule}(${v.detail})`).join(',')}`);
  }
  assert.deepEqual(bad, []);
});

test('capitalised words inside a verified source passage are not treated as living people', () => {
  const canonical = 'Virtu contro al Furore Prendera l’arme, e fia il combatter corto';
  const post = { text: `Petrarch said it: "${canonical}". Still true.`, quoteRefs: [{ text: canonical, canonical, sourceId: 'x', work: 'The Prince', section: 'XXVI' }] };
  assert.equal(checkPost(post, ctx).ok, true);
  assert.equal(checkPost({ text: 'Furore Prendera is a fraud.' }, ctx).ok, false, 'same name without a verified passage still fails');
});
