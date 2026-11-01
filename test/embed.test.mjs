import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/data.mjs';
import { affinityFromCosine, cosineVec, createEmbedder, hashEmbed, personaHash, personaVectors, stanceAnchors, stanceHint, tagOverlap } from '../src/lib/embed.mjs';

// Deterministic tiny "model": 4 dims keyed on words. No package needed.
const fakeModel = async () => async (texts) =>
  texts.map((t) => {
    const s = t.toLowerCase();
    return [/(mind|soul|conscious)/.test(s) ? 1 : 0, /(war|fight|clown|wrong|nonsense)/.test(s) ? 1 : 0, /(yes|agree|exactly|right)/.test(s) ? 1 : 0, 0.1];
  });

test('mocked MiniLM loader: kind minilm, not degraded, batched embed', async () => {
  const e = await createEmbedder({ loader: fakeModel });
  assert.equal(e.kind, 'minilm');
  assert.equal(e.degraded, false);
  const [a, b, c] = await e.embed(['the mind and soul', 'consciousness of mind', 'war is nonsense']);
  assert.ok(cosineVec(a, b) > cosineVec(a, c));
});

test('missing package / failed load → tag-overlap fallback, run marked degraded', async () => {
  const logs = [];
  const e = await createEmbedder({ loader: async () => { throw new Error("Cannot find package '@huggingface/transformers'"); }, log: (m) => logs.push(m) });
  assert.equal(e.kind, 'none');
  assert.equal(e.degraded, true);
  assert.match(e.reason, /Cannot find package/);
  assert.equal(await e.embed(['x']), null);
  assert.match(logs[0], /tag overlap/);
  const slow = await createEmbedder({ loader: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(slow.degraded, true, 'load timeout keeps the step bounded');
  assert.ok(tagOverlap(['football', 'robots'], ['robots']) > tagOverlap(['football'], ['wine']));
});

test('auto mode without the package installed never throws', async () => {
  const e = await createEmbedder({ mode: 'auto', timeoutMs: 30000 });
  assert.ok(['minilm', 'none'].includes(e.kind));
  if (e.kind === 'none') assert.equal(e.degraded, true);
});

test('persona interest vectors are cached and rebuilt only when a persona changes', async () => {
  const file = path.join(ROOT, 'test', '.embed-scratch', 'personas.json');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  let calls = 0;
  const e = await createEmbedder({ loader: async () => { const f = await fakeModel(); return async (t) => { calls += t.length; return f(t); }; } });
  const ps = [{ id: 'a', name: 'A', bio: 'mind and soul', topic_affinity: { philosophy: 1 } }, { id: 'b', name: 'B', bio: 'war', topic_affinity: { politics: 1 } }];
  const v1 = await personaVectors(ps, e, { file });
  assert.equal(v1.size, 2);
  assert.equal(calls, 2);
  await personaVectors(ps, e, { file });
  assert.equal(calls, 2, 'cache hit');
  const changed = [ps[0], { ...ps[1], bio: 'war and clowns' }];
  assert.notEqual(personaHash(changed[1]), personaHash(ps[1]));
  await personaVectors(changed, e, { file });
  assert.equal(calls, 3, 'only the changed persona is re-embedded');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('stance hint from anchor phrases; hash vectors are deterministic', async () => {
  const e = await createEmbedder({ loader: fakeModel });
  const anchors = await stanceAnchors(e);
  const [v] = await e.embed(['exactly right, I agree']);
  const hint = stanceHint(v, anchors);
  assert.ok(hint.agree > hint.confused, JSON.stringify(hint));
  assert.equal(stanceHint(null, anchors), null);
  assert.deepEqual(hashEmbed('robot referee'), hashEmbed('robot referee'));
  assert.equal(affinityFromCosine(1), 1);
  assert.equal(affinityFromCosine(-1), 0);
});

test('the site build never imports the optional embeddings package', () => {
  for (const f of ['src/build.mjs', 'src/lib/util.mjs', 'src/lib/data.mjs']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/huggingface|embed\.mjs/.test(s), f);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.optionalDependencies?.['@huggingface/transformers']);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'zero runtime dependencies');
});
