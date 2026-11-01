import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/data.mjs';
import { loadSpec, mediaProblems, createSampler } from '../src/lib/realism.mjs';
import { loadLibrary, resolveMedia, renderProblems, planMedia, materializeMedia, wrap, CHART_TYPES } from '../src/lib/media.mjs';
import { createGiphyClient } from '../src/lib/giphy.mjs';

const spec = loadSpec();
const pol = spec.media_policy;
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'media', 'library.json'), 'utf8'));
const lib = loadLibrary();

test('library: every art piece is fetched, public domain/CC0 and credited; templates reference real art', () => {
  assert.equal(lib.art.size, raw.art.length, 'every library art entry has credits (run npm run media:fetch)');
  for (const a of lib.art.values()) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', a.src)), `${a.id} file missing`);
    assert.ok(raw.allowed_licenses.includes(a.license), `${a.id} license ${a.license}`);
    assert.match(a.url, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    assert.ok(a.alt && a.width > 0 && a.height > 0);
  }
  assert.equal(lib.memes.size, raw.memes.length);
  assert.equal(lib.reactions.size, raw.reactions.length);
  const ids = [...raw.art, ...raw.memes, ...raw.reactions].map((x) => x.id);
  assert.equal(new Set(raw.art.map((x) => x.id)).size, raw.art.length);
  assert.ok(ids.length >= 40, 'starter set: art + memes + reactions');
});

test('every meme template renders safe, escaped SVG at max caption length', () => {
  for (const t of lib.memes.values()) {
    const captions = Object.fromEntries(t.slots.map((s) => [s.name, ('Tom & "Jerry" ' + 'word '.repeat(40)).slice(0, s.max).trim()]));
    const m = resolveMedia({ kind: 'meme', render: { template: t.id, captions } });
    assert.match(m.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(m.svg, /<script|on\w+=|href="http/i);
    assert.match(m.svg, /Tom &amp; &quot;Jerry&quot;|TOM &amp; &quot;JERRY&quot;/);
    assert.match(m.src, /^\/media\/gen\/meme-[a-z0-9]+-[a-z0-9]+\.svg$/);
    assert.deepEqual(mediaProblems(m, pol), [], t.id);
    assert.ok(m.credit.license && m.alt.includes('Tom'));
  }
});

test('reaction GIFs animate, loop and honor reduced motion', () => {
  for (const r of lib.reactions.values()) {
    const m = resolveMedia({ kind: 'gif', render: { reaction: r.id, caption: 'when the syllogism is invalid' } });
    assert.match(m.svg, /animation:fx [\d.]+s ease-in-out infinite/);
    assert.match(m.svg, /prefers-reduced-motion:reduce/);
    assert.equal(m.origin, 'local-render');
    assert.deepEqual(mediaProblems(m, pol), [], r.id);
  }
});

test('charts render for every type and reject bad data', () => {
  for (const type of CHART_TYPES) {
    const m = resolveMedia({ kind: 'chart', render: { chart: { type, title: 'Time spent: thinking vs. doing', labels: ['thinking', 'doing', 'arguing'], values: [70, 5, 25], unit: '%' } } });
    assert.match(m.svg, /illustrative, not real data/);
    assert.match(m.alt, /thinking: 70%/);
    assert.deepEqual(mediaProblems(m, pol), []);
  }
  const bad = (chart) => renderProblems({ kind: 'chart', render: { chart } }).join();
  assert.match(bad({ type: 'radar', title: 't', labels: ['a', 'b'], values: [1, 2] }), /chart type/);
  assert.match(bad({ type: 'bar', title: 't', labels: ['a'], values: [1, 2] }), /equal-length/);
  assert.match(bad({ type: 'pie', title: 't', labels: ['a', 'b'], values: [1, -2] }), />= 0/);
  assert.match(bad({ type: 'bar', title: 't', labels: ['a', 'b'], values: [1, NaN] }), /finite/);
});

test('caption rules: too long is rejected (never truncated), markup/URLs rejected, unknown ids rejected', () => {
  const t = lib.memes.get('scream-when');
  assert.match(renderProblems({ kind: 'meme', render: { template: t.id, captions: { caption: 'x'.repeat(111) } } }).join(), /never truncate/);
  assert.match(renderProblems({ kind: 'meme', render: { template: t.id, captions: { caption: 'see https://x.y' } } }).join(), /URL or markup/);
  assert.match(renderProblems({ kind: 'meme', render: { template: 'nope', captions: {} } }).join(), /unknown meme/);
  assert.match(renderProblems({ kind: 'gif', render: { reaction: 'nope' } }).join(), /unknown reaction/);
  assert.throws(() => resolveMedia({ kind: 'image', render: { art: 'nope' } }), /unknown art/);
  assert.deepEqual(wrap('a bb ccc dddd', 6), ['a bb', 'ccc', 'dddd']);
});

const stubSampler = (kind, gifSource = 'local') => ({ rand: () => 0.42, mediaKind: () => kind, gifSource: () => gifSource });

test('planMedia/materializeMedia: sampler-driven plans produce valid post.media items', async () => {
  assert.equal(planMedia(stubSampler('none')), null);
  assert.equal(planMedia(stubSampler('video')), null);
  assert.equal(planMedia(stubSampler('link_card')), null, 'no news, no link card');
  assert.equal(planMedia(stubSampler('link_card'), 'original', { news: { url: 'https://bbc.co.uk' } }).kind, 'link_card');

  const meme = planMedia(stubSampler('meme'));
  assert.equal(meme.options.length, 3);
  assert.match(meme.prompt, /never truncate/);
  const tpl = lib.memes.get(meme.options[0].id);
  const item = await materializeMedia(meme, { template: tpl.id, captions: Object.fromEntries(tpl.slots.map((s) => [s.name, 'ok'])) });
  assert.equal(item.svg, undefined, 'svg is rendered at build time, not stored');
  assert.deepEqual(mediaProblems(item, pol), []);
  await assert.rejects(materializeMedia(meme, { template: 'not-offered', captions: {} }), /not one of the offered/);

  const gif = planMedia(stubSampler('gif'), 'reply', { mood: 'laughing' });
  assert.ok(gif.options.every((o) => o.moods.some((m) => m.includes('laughing'))));
  assert.equal((await materializeMedia(gif, { reaction: gif.options[0].id })).origin, 'local-render');

  const chart = planMedia(stubSampler('chart'));
  const c = await materializeMedia(chart, { type: 'pie', title: 'Where my day goes', labels: ['doubt', 'tea'], values: [3, 1] });
  assert.equal(c.kind, 'chart');
  const poll = planMedia(stubSampler('poll'));
  assert.deepEqual(await materializeMedia(poll, { options: ['Yes', 'No'] }), { kind: 'poll', options: ['Yes', 'No'] });
  await assert.rejects(materializeMedia(poll, { options: ['only one'] }), /2-4/);
  const img = planMedia(stubSampler('image'));
  assert.equal((await materializeMedia(img, { art: img.options[0].id })).origin, 'commons');
});

// ---------- GIPHY ----------

function fakeGiphy(data, log = []) {
  return async (url) => {
    log.push(url);
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
}
const gif = (id, rating = 'pg') => ({
  id, rating, url: `https://giphy.com/gifs/${id}`, title: 'Slow Clap GIF by Someone', alt_text: '', username: 'someone',
  images: { fixed_width: { url: `https://media3.giphy.com/media/v1.Y2lk/${id}/200w.gif?cid=1&rid=200w.gif&ct=g`, width: '200', height: '150' } },
});

test('GIPHY client: server-side pg-13 search, safe CDN items with attribution, cache and call cap', async () => {
  const log = [];
  const client = createGiphyClient({ apiKey: 'k', maxCalls: 2, fetchImpl: fakeGiphy([gif('r1', 'r'), gif('a1'), { id: 'bad', rating: 'g', images: { fixed_width: { url: 'https://evil.example/x.gif' } } }], log) });
  const item = await client.search('slow clap!!', { rand: () => 0 });
  const q = new URL(log[0]).searchParams;
  assert.equal(q.get('rating'), 'pg-13');
  assert.equal(q.get('q'), 'slow clap');
  assert.equal(item.giphy_id, 'a1', 'r-rated and off-CDN results are dropped');
  assert.equal(item.attribution, 'Powered by GIPHY');
  assert.equal(item.alt, 'Reaction GIF: Slow Clap');
  assert.ok(!JSON.stringify(item).includes('api_key'), 'key never stored on the post');
  assert.deepEqual(mediaProblems(item, pol), []);
  await client.search('slow clap');
  assert.equal(client.callsUsed, 1, 'cached per query');
  await client.search('mind blown');
  assert.equal(client.enabled, false, 'cap reached');
  assert.equal(await client.search('facepalm'), null);
  assert.equal(log.length, 2);
  assert.equal(createGiphyClient({ apiKey: '' }).enabled, false);
});

test('GIPHY plans follow spec gif_sources and fall back to local reactions', async () => {
  const giphy = createGiphyClient({ apiKey: 'k', fetchImpl: fakeGiphy([gif('a1')]) });
  const plan = planMedia(stubSampler('gif', 'giphy'), 'reply', { giphy });
  assert.equal(plan.source, 'giphy');
  assert.match(plan.prompt, /GIPHY search query/);
  assert.equal((await materializeMedia(plan, { query: 'slow clap', reaction: plan.options[0].id }, { giphy })).origin, 'giphy');

  const empty = createGiphyClient({ apiKey: 'k', fetchImpl: fakeGiphy([]) });
  const fb = await materializeMedia({ ...plan }, { query: 'nothing', reaction: plan.options[0].id }, { giphy: empty });
  assert.equal(fb.origin, 'local-render', 'falls back when GIPHY has no safe hit');
  const down = createGiphyClient({ apiKey: 'k', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal((await materializeMedia({ ...plan }, { query: 'x', reaction: plan.options[0].id }, { giphy: down })).origin, 'local-render');

  assert.equal(planMedia(stubSampler('gif', 'giphy'), 'reply', {}).source, 'local', 'no client -> local');

  const s = createSampler(spec, 'mix');
  const n = 4000;
  let g = 0;
  for (let i = 0; i < n; i++) if (s.gifSource() === 'giphy') g++;
  assert.ok(Math.abs(g / n - spec.sampling.gif_sources.giphy) < 0.03);
});
