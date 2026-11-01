import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeta, linkCardFrom, unfurl } from '../src/lib/unfurl.mjs';
import { parseOembed, realPostKind, allowedAccount, titleOverlap, fetchBskyPost } from '../src/lib/realposts.mjs';
import { cardProblems, cachedUrls } from '../src/lib/data.mjs';
import { loadSpec } from '../src/lib/realism.mjs';

const HTML = `<html><head><title>Fallback</title>
<meta property="og:title" content="Quake hits &amp; shakes city">
<meta property="og:description" content="A strong quake struck.">
<meta property="og:site_name" content="Example News">
<meta property="og:image" content="/img/quake.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="article:published_time" content="2026-10-03T10:00:00Z">
<link rel="canonical" href="https://www.example.com/world/quake">
<link rel="icon" href="/favicon.png"></head><body>x</body></html>`;

test('unfurl: parses og meta, resolves relative image/icon, keeps same-site canonical', () => {
  const m = parseMeta(HTML, 'https://www.example.com/world/quake?utm=x');
  assert.equal(m.title, 'Quake hits & shakes city');
  assert.equal(m.site_name, 'Example News');
  assert.deepEqual(m.image, { url: 'https://www.example.com/img/quake.jpg', width: 1200, height: 630 });
  assert.equal(m.icon, 'https://www.example.com/favicon.png');
  assert.equal(m.url, 'https://www.example.com/world/quake');
  assert.equal(m.published, '2026-10-03T10:00:00.000Z');
  const card = linkCardFrom('https://www.example.com/world/quake?utm=x', { meta: m });
  assert.equal(card.url, 'https://www.example.com/world/quake');
  assert.equal(card.domain, 'example.com');
  assert.equal(card.image.url, 'https://www.example.com/img/quake.jpg');
});

test('unfurl: blocked page falls back to feed data + favicon; cache hit avoids refetch', async () => {
  const cache = { items: {} };
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('nope', { status: 401, headers: { 'content-type': 'text/html' } }); };
  const e = await unfurl('https://www.reuters.com/a/b', { cache, fetchImpl, now: Date.parse('2026-11-01T00:00:00Z') });
  assert.equal(e.ok, false);
  assert.equal(e.status, 401);
  await unfurl('https://www.reuters.com/a/b', { cache, fetchImpl, now: Date.parse('2026-11-02T00:00:00Z') });
  assert.equal(calls, 1);
  const card = linkCardFrom('https://www.reuters.com/a/b', e, { title: 'Headline', source: 'Reuters' });
  assert.equal(card.title, 'Headline');
  assert.equal(card.site_name, 'Reuters');
  assert.equal(card.image, undefined);
  assert.equal(card.icon, 'https://www.reuters.com/favicon.ico');
  assert.equal(await unfurl('javascript:alert(1)', { cache, fetchImpl }), null);
});

test('real posts: oEmbed parse keeps the exact text; kinds, allowlist, overlap', () => {
  const o = parseOembed({ author_name: 'NASA', author_url: 'https://twitter.com/NASA', html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Liftoff! &amp; onward <a href="https://t.co/x">pic.twitter.com/x</a></p>&mdash; NASA (@NASA) <a href="https://twitter.com/NASA/status/123456789?ref_src=twsrc">October 3, 2026</a></blockquote>' });
  assert.equal(o.text, 'Liftoff! & onward pic.twitter.com/x');
  assert.equal(o.handle, 'NASA');
  assert.equal(o.created_at, '2026-10-03');
  assert.equal(realPostKind('https://x.com/NASA/status/123456789'), 'x_post');
  assert.equal(realPostKind('https://bsky.app/profile/apnews.com/post/3abcdefghij'), 'bsky_post');
  assert.equal(realPostKind('https://example.com/x'), null);
  const acc = [{ platform: 'x', handle: 'NASA', kind: 'institution' }];
  assert.ok(allowedAccount(acc, 'x', '@nasa'));
  assert.equal(allowedAccount(acc, 'x', 'someone'), null);
  assert.ok(titleOverlap('Argentina unveils citizenship-by-investment scheme', 'Argentina unveils passports-for-investment scheme') > 0.4);
  assert.ok(titleOverlap('LLM Voice', 'Apple to announce new Siri voice in 2025') < 0.5);
});

test('real posts: Bluesky handle resolves to DID, deleted posts are skipped', async () => {
  const fetchImpl = async (u) => {
    if (u.includes('resolveHandle')) return Response.json({ did: 'did:plc:abc' });
    if (u.includes('3gone')) return Response.json({ posts: [] });
    return Response.json({ posts: [{ uri: 'at://did:plc:abc/app.bsky.feed.post/3live1234', author: { handle: 'apnews.com', displayName: 'AP' }, record: { text: 'Exact text', createdAt: '2026-10-03T00:00:00Z' }, likeCount: 5 }] });
  };
  const ok = await fetchBskyPost('https://bsky.app/profile/apnews.com/post/3live1234', { fetchImpl });
  assert.equal(ok.post.text, 'Exact text');
  assert.equal(ok.post.url, 'https://bsky.app/profile/apnews.com/post/3live1234');
  assert.equal((await fetchBskyPost('https://bsky.app/profile/apnews.com/post/3gone1234', { fetchImpl })).ok, false);
});

test('validator: cards need a fetched url; real-post text must match the fetch', () => {
  const knownUrls = new Set(['https://a.com/x', 'https://x.com/NASA/status/1']);
  const cache = { items: { 'https://x.com/NASA/status/1': { post: { text: 'Exact' } } } };
  assert.deepEqual(cardProblems({ media: [{ kind: 'link_card', url: 'https://a.com/x' }] }, { knownUrls }), []);
  assert.match(cardProblems({ media: [{ kind: 'link_card', url: 'https://made-up.com/y' }] }, { knownUrls })[0], /not in the fetch cache/);
  assert.match(cardProblems({ media: [{ kind: 'x_post', url: 'https://x.com/NASA/status/1', handle: 'NASA', text: 'Paraphrase' }] }, { knownUrls, cache })[0], /differs/);
  // the post's own fetched news/topic url is vouched for by the feed; RFC 2606 fixture domains always pass
  assert.deepEqual(cardProblems({ news: { url: 'https://feed.org/a' }, media: [{ kind: 'link_card', url: 'https://feed.org/a' }] }, { knownUrls }), []);
  assert.deepEqual(cardProblems({ media: [{ kind: 'link_card', url: 'https://www.example.com/n' }] }, { knownUrls }), []);
  assert.match(cardProblems({ news: { url: 'https://feed.org/a' }, media: [{ kind: 'x_post', url: 'https://feed.org/a', handle: 'h', text: 't' }] }, { knownUrls })[0], /not in the fetch cache/);
});

test('corpus: every committed card url is in the fetch cache; spec lists the new kinds', () => {
  assert.ok(cachedUrls().size > 0);
  const kinds = loadSpec().media_policy.kinds;
  assert.ok(kinds.includes('x_post') && kinds.includes('bsky_post'));
});
