import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersonas, loadPosts } from '../src/lib/data.mjs';
import {
  loadSpec, gini, burstiness, classify, mediaProblems, measure, evaluate, checkCorpus, createSampler, totalVariation,
} from '../src/lib/realism.mjs';

const spec = loadSpec();
const personas = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, popularity: 1 + (i % 10) }));
const okImage = { kind: 'image', src: '/media/x.svg', alt: 'A chart', rating: 'g', origin: 'local-render' };

test('spec is well-formed', () => {
  for (const [id, t] of Object.entries(spec.metrics)) {
    assert.ok(t.min <= t.max, `${id} min<=max`);
    assert.ok(['warn', 'fail'].includes(t.severity), `${id} severity`);
    for (const s of t.sources) assert.ok(spec.sources[s], `${id} cites unknown source ${s}`);
  }
  for (const [role, w] of Object.entries(spec.sampling.media)) {
    if (role.startsWith('_')) continue;
    const sum = Object.values(w).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `media.${role} sums to 1 (${sum})`);
  }
  assert.equal(spec.sampling.diurnal_local.weights.length, 24);
  assert.ok(spec.sampling.length_chars.buckets.every(([, max]) => max <= 280));
});

test('stats helpers', () => {
  assert.equal(gini([5, 5, 5, 5]), 0);
  assert.ok(Math.abs(gini([0, 0, 0, 1]) - 0.75) < 1e-9);
  assert.equal(burstiness([10, 10, 10, 10]), -1);
  assert.ok(burstiness([1, 1, 1, 1, 200]) > 0.3);
  assert.equal(totalVariation([1, 1], [1, 1]), 0);
});

test('classify roles', () => {
  const posts = [
    { id: 'a', authorId: 'x' },
    { id: 'b', authorId: 'x', inReplyTo: 'a', type: 'thread' },
    { id: 'c', authorId: 'y', inReplyTo: 'a', type: 'dunk' },
    { id: 'd', authorId: 'y', quoteOf: 'a' },
  ];
  const byId = new Map(posts.map((p) => [p.id, p]));
  assert.deepEqual(posts.map((p) => classify(p, byId)), ['original', 'thread_part', 'reply', 'quote']);
});

test('media safety rules', () => {
  const pol = spec.media_policy;
  assert.deepEqual(mediaProblems(okImage, pol), []);
  const commons = { kind: 'image', src: 'https://upload.wikimedia.org/a/b.jpg', alt: 'Painting', rating: 'g', origin: 'commons', credit: { author: 'Raphael', license: 'Public domain', url: 'https://commons.wikimedia.org/wiki/File:b.jpg' } };
  assert.deepEqual(mediaProblems(commons, pol), []);
  assert.match(mediaProblems({ ...commons, credit: undefined }, pol).join(), /credit/);
  assert.match(mediaProblems({ ...commons, src: 'https://evil.example/a.jpg' }, pol).join(), /not allowlisted/);
  assert.match(mediaProblems({ ...commons, src: 'https://upload.wikimedia.org/page.html' }, pol).join(), /not a media file/);
  assert.match(mediaProblems({ ...okImage, alt: '' }, pol).join(), /alt/);
  assert.match(mediaProblems({ ...okImage, rating: 'r' }, pol).join(), /rating/);
  assert.match(mediaProblems({ ...okImage, origin: 'ai' }, pol).join(), /ai_generated/);
  assert.deepEqual(mediaProblems({ ...okImage, origin: 'ai', ai_generated: true }, pol), []);
  assert.match(mediaProblems({ kind: 'poll', options: ['yes'] }, pol).join(), /poll/);
  assert.match(mediaProblems({ kind: 'hologram' }, pol).join(), /unknown media kind/);
});

test('hard rules fail: >280 chars, reply before parent, unsafe media', () => {
  const posts = [
    { id: 'a', authorId: 'p0', text: 'x'.repeat(281), createdAt: '2026-11-01T12:00:00Z' },
    { id: 'b', authorId: 'p1', text: 'no', inReplyTo: 'a', createdAt: '2026-11-01T11:00:00Z', media: [{ kind: 'gif', src: 'https://media.giphy.com/x.gif', alt: 'lol' }] },
  ];
  const res = evaluate(measure(posts, personas, spec), spec);
  const status = Object.fromEntries(res.map((r) => [r.id, r.status]));
  assert.equal(status['length.max_chars'], 'fail');
  assert.equal(status['time.replies_before_parent'], 'fail');
  assert.equal(status['media.safety_violations'], 'fail');
  assert.equal(status['activity.reply_share'], 'skip', 'small samples are skipped, not judged');
});

test('sampler output satisfies its own spec (sampling and metrics stay consistent)', () => {
  const s = createSampler(spec, 'test-seed');
  const posts = [];
  const start = Date.parse('2026-10-01T00:00:00Z');
  const pick = (arr) => arr[Math.floor(s.rand() * arr.length)];
  const dayOffsetEt = 4; // EDT hours behind UTC in October
  for (let i = 0; i < 1500; i++) {
    const role = s.activity();
    const author = pick(personas);
    const day = Math.floor(i / 50);
    const created = start + day * 86_400_000 + ((s.localHour() + dayOffsetEt) % 24) * 3_600_000 + s.minute() * 60_000;
    const { min, max } = s.lengthRange();
    const len = min + Math.floor(s.rand() * (max - min + 1));
    const kind = s.mediaKind(role);
    const media = kind === 'none' ? undefined
      : kind === 'poll' ? [{ kind, options: ['a', 'b'] }]
      : kind === 'link_card' ? [{ kind, url: 'https://example.org/n' }]
      : [{ ...okImage, kind }];
    const post = { id: `t${i}`, authorId: author.id, type: 'x', text: 'y'.repeat(len), createdAt: new Date(created).toISOString(), media };
    if (role !== 'original' && posts.length) {
      const parent = pick(posts);
      if (role === 'reply') post.inReplyTo = parent.id; else post.quoteOf = parent.id;
      post.createdAt = new Date(Date.parse(parent.createdAt) + s.replyDelayMinutes() * 60_000).toISOString();
    }
    post.stats = s.engagement({ popularity: author.popularity, isReply: role === 'reply' });
    posts.push(post);
  }
  const { results } = checkCorpus(posts, personas, spec);
  const must = [
    'activity.original_share', 'activity.reply_share', 'activity.quote_share',
    'media.original.visual_share', 'media.original.link_card_share', 'media.original.poll_share', 'media.reply.visual_share',
    'media.gif_share_of_visual', 'media.safety_violations',
    'length.max_chars', 'length.median_chars', 'length.short_share', 'length.over_140_share', 'length.near_limit_share',
    'time.round_minute_share', 'time.reply_delay_median_min', 'time.replies_before_parent',
    'engagement.likes_gini', 'engagement.top10_like_share', 'engagement.likes_per_repost_median', 'engagement.quotes_per_repost_median',
  ];
  for (const id of must) {
    const r = results.find((x) => x.id === id);
    assert.equal(r.status, 'pass', `${id} = ${r.value} not in [${r.min}, ${r.max}] (n=${r.n})`);
  }
});

test('real corpus has no hard-rule failures', () => {
  const { results } = checkCorpus(loadPosts(), loadPersonas(), spec);
  const failed = results.filter((r) => r.status === 'fail');
  assert.deepEqual(failed.map((r) => `${r.id}: ${JSON.stringify(r.detail ?? r.value)}`), []);
});
