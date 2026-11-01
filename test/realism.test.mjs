import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPersonas, loadPosts } from '../src/lib/data.mjs';
import {
  loadSpec, gini, burstiness, classify, mediaProblems, measure, evaluate, checkCorpus, createSampler, totalVariation,
  replyFormOf, personaReplyStyle,
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
  for (const role of ['original', 'reply', 'quote']) {
    const w = spec.sampling.media[role];
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
  const giphyItem = { kind: 'gif', origin: 'giphy', giphy_id: 'abc123', src: 'https://media2.giphy.com/media/v1.x/abc123/200w.gif?cid=1&rid=200w.gif&ct=g', alt: 'Reaction GIF: slow clap', rating: 'pg', credit: { author: 'someone', license: 'GIPHY Terms of Service', url: 'https://giphy.com/gifs/abc123' }, attribution: 'Powered by GIPHY' };
  assert.deepEqual(mediaProblems(giphyItem, pol), []);
  assert.match(mediaProblems({ ...giphyItem, credit: undefined }, pol).join(), /credit/);
  assert.match(mediaProblems({ ...giphyItem, attribution: undefined }, pol).join(), /Powered by GIPHY/);
  assert.match(mediaProblems({ ...giphyItem, giphy_id: undefined }, pol).join(), /giphy_id/);
  assert.match(mediaProblems({ ...giphyItem, rating: 'r' }, pol).join(), /rating/);
  assert.match(mediaProblems({ ...giphyItem, src: 'https://evil.example/a.gif' }, pol).join(), /not allowlisted/);
  assert.match(mediaProblems({ ...giphyItem, src: 'https://media.giphy.com/page.html' }, pol).join(), /not a media file/);
  assert.match(mediaProblems({ ...giphyItem, src: 'https://upload.wikimedia.org/a.jpg' }, pol).join(), /not allowlisted/, 'art is local, not hotlinked');
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
  const real = loadPersonas();
  const posts = [];
  const start = Date.parse('2026-10-01T00:00:00Z');
  const pick = (arr) => arr[Math.floor(s.rand() * arr.length)];
  const between = ({ min, max }) => min + Math.floor(s.rand() * (max - min + 1));
  const mk = (kind, i) => kind === 'poll' ? [{ kind, options: ['a', 'b'] }]
    : kind === 'link_card' ? [{ kind, url: 'https://example.org/n' }]
    : kind === 'gif' && s.gifSource() === 'giphy' ? [{ kind, origin: 'giphy', giphy_id: `g${i}`, src: `https://media1.giphy.com/media/g${i}/200w.gif`, alt: 'gif', rating: 'pg', credit: { author: 'a', license: 'GIPHY Terms of Service', url: 'https://giphy.com/gifs/x' }, attribution: 'Powered by GIPHY' }]
    : [{ ...okImage, kind }];
  const textFor = (form, chars) => {
    if (form === 'emoji_only') return '😂'.repeat(1 + Math.floor(s.rand() * 3));
    if (form === 'few_words') return ['based', 'this.', 'source?', 'ratio', 'so true'][Math.floor(s.rand() * 5)];
    if (form === 'short') return Array(Math.max(4, Math.floor((between(chars) + 1) / 3))).fill('yy').join(' ');
    return 'y'.repeat(between(chars));
  };
  const dayOffsetEt = 4; // EDT hours behind UTC in October
  for (let i = 0; i < 1500; i++) {
    const role = s.activity();
    const author = pick(real);
    const day = Math.floor(i / 50);
    const created = start + day * 86_400_000 + ((s.localHour() + dayOffsetEt) % 24) * 3_600_000 + s.minute() * 60_000;
    let text;
    let media;
    if (role === 'original' || !posts.length) {
      text = 'y'.repeat(between(s.lengthRange()));
    } else {
      const rf = s.replyForm(role, author);
      text = rf.media ? '' : textFor(rf.form, rf.chars);
      if (rf.media) media = mk(rf.media, i);
    }
    if (text && text.length > 40 && s.wantsEmoji()) text = `${text.slice(0, -2)} 🙂`;
    if (text) {
      const kind = s.mediaKind(role);
      if (kind !== 'none') media = mk(kind, i);
    }
    const post = { id: `t${i}`, authorId: author.id, type: 'x', text, createdAt: new Date(created).toISOString(), media };
    if (role !== 'original' && posts.length) {
      const parent = pick(posts);
      if (role === 'reply') post.inReplyTo = parent.id; else post.quoteOf = parent.id;
      post.createdAt = new Date(Date.parse(parent.createdAt) + s.replyDelayMinutes() * 60_000).toISOString();
    }
    post.stats = s.engagement({ popularity: author.popularity, isReply: role === 'reply' });
    posts.push(post);
  }
  const authored = posts.length;
  for (let i = 0, n = s.retaikCount(authored); i < n; i++) {
    const parent = pick(posts.slice(0, authored));
    posts.push({ id: `rt${i}`, authorId: pick(real).id, retaikOf: parent.id, text: '', createdAt: new Date(Date.parse(parent.createdAt) + s.replyDelayMinutes() * 60_000).toISOString() });
  }
  const { results } = checkCorpus(posts, real, spec);
  const must = [
    'reply_form.reply.emoji_only_share', 'reply_form.reply.few_words_share', 'reply_form.reply.media_only_share',
    'reply_form.reply.short_share', 'reply_form.reply.full_share', 'reply_form.quote.minimal_share', 'retaik.per_authored', 'text.emoji_share',
    'activity.original_share', 'activity.reply_share', 'activity.quote_share',
    'media.original.visual_share', 'media.original.link_card_share', 'media.original.poll_share', 'media.reply.visual_share',
    'media.gif_share_of_visual', 'media.gif.giphy_share', 'media.safety_violations',
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

test('replyFormOf classifies X-style reply shapes', () => {
  const f = (text, media) => replyFormOf({ text, media });
  assert.equal(f('💀'), 'emoji_only');
  assert.equal(f('😂😂 '), 'emoji_only');
  assert.equal(f('👍🏽!'), 'emoji_only');
  assert.equal(f('this.'), 'few_words');
  assert.equal(f('based'), 'few_words');
  assert.equal(f('source? 🤨'), 'few_words');
  assert.equal(f('', [{ kind: 'gif' }]), 'gif_only');
  assert.equal(f('', [{ kind: 'meme' }]), 'meme_only');
  assert.equal(f('', [{ kind: 'image' }]), 'image_only');
  assert.equal(f('ok but who asked you'), 'short');
  assert.equal(f('Universalize it: if everyone lied, promising would cease to exist.'), 'full');
});

test('persona bias: Diogenes is terse, Kant is long-winded, reply_style overrides', () => {
  assert.equal(personaReplyStyle(spec, 'diogenes'), 'terse');
  assert.equal(personaReplyStyle(spec, { id: 'kant' }), 'discursive');
  assert.equal(personaReplyStyle(spec, { id: 'kant', reply_style: 'terse' }), 'terse');
  assert.equal(personaReplyStyle(spec, { id: 'kant', reply_style: 'nonsense' }), 'balanced');
  assert.equal(personaReplyStyle(spec, 'unknown'), 'balanced');
  const s = createSampler(spec, 'bias');
  const n = 3000;
  const minimal = (id) => {
    let k = 0;
    for (let i = 0; i < n; i++) if (s.replyForm('reply', id).form !== 'full') k++;
    return k / n;
  };
  const dio = minimal('diogenes');
  const kant = minimal('kant');
  assert.ok(dio > 0.75, `diogenes non-full share ${dio}`);
  assert.ok(kant < 0.35, `kant non-full share ${kant}`);
  for (let i = 0; i < 200; i++) {
    const r = s.replyForm('quote', 'hume');
    assert.ok(!r.media, 'quote forms carry text');
    assert.ok(r.chars.max <= 280 && r.chars.min <= r.chars.max);
    if (r.form === 'full') assert.ok(r.chars.min > 40);
  }
});

test('quotes per repost: corpus without stored stats is scored with display stats (crowd + quote-taiks), not 0', () => {
  const real = loadPersonas();
  const s = createSampler(spec, 'qpr');
  const posts = Array.from({ length: 300 }, (_, i) => ({ id: `q${i}`, authorId: real[i % real.length].id, text: 'hm', createdAt: new Date(Date.UTC(2026, 9, 1) + i * 7 * 60_000).toISOString() }));
  for (let i = 0; i < 20; i++) posts.push({ id: `qq${i}`, authorId: real[(i + 3) % real.length].id, quoteOf: `q${i}`, text: 'no', createdAt: '2026-10-03T00:00:00Z' });
  const r = checkCorpus(posts, real, spec).results.find((x) => x.id === 'engagement.quotes_per_repost_median');
  assert.ok(r.n >= 30 && r.value > 0, `quotes_per_repost_median = ${r.value} (n=${r.n})`);
  assert.equal(r.status, 'pass');
  assert.ok(posts.every((p) => !p.stats), 'checkCorpus does not mutate its input');
  // stochastic rounding keeps the ratio even for small repost counts
  let q = 0; let rp = 0;
  for (let i = 0; i < 4000; i++) { const e = s.engagement({ popularity: 2 }); q += e.quotes; rp += e.reposts; }
  assert.ok(q / rp > 0.12 && q / rp < 0.4, `aggregate quotes/reposts ${q / rp}`);
});

test('spec policy: every sites/*/realism/spec.json describes distributions only (no real users, handles or post URLs)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { listSites, siteDir } = await import('../src/lib/site.mjs');
  const GENERIC = new Set(['mention', 'mentions', 'mentioned', 'mentioning', 'user', 'users', 'handle', 'handles', 'someone']);
  const X_URL = /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+(?:\/status(?:es)?\/\d+)?/gi;
  const HANDLE = /(?<![\w.@\/])@([A-Za-z0-9_]{1,30})\b/g;
  let checked = 0;
  for (const id of listSites()) {
    const file = path.join(siteDir(id), 'realism', 'spec.json');
    if (!fs.existsSync(file)) continue;
    checked++;
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(JSON.parse(raw)._policy ?? '', /distribution/i, `${id}: spec.json needs a _policy line`);
    const dir = path.join(siteDir(id), 'personas');
    const handles = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => String(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).handle ?? '').toLowerCase()).filter(Boolean) : []);
    assert.deepEqual(raw.match(X_URL) ?? [], [], `${id}: spec.json links to real X/Twitter users or posts`);
    const bad = [...raw.matchAll(HANDLE)].map((m) => m[1]).filter((h) => !handles.has(h.toLowerCase()) && !GENERIC.has(h.toLowerCase()));
    assert.deepEqual([...new Set(bad)], [], `${id}: spec.json @handles must be persona handles in that pack (samples must be invented)`);
  }
  assert.ok(checked >= 1);
});
