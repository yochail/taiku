import test from 'node:test';
import assert from 'node:assert/strict';
import { isGoogleNewsUrl, googleNewsId, resolveGoogleNews } from '../src/lib/gnews.mjs';
import { fetchPool } from '../src/lib/news.mjs';
import { cardProblems, loadPosts } from '../src/lib/data.mjs';

const GN = 'https://news.google.com/rss/articles/CBMiAU_yqLtestid123?oc=5';
const REAL = 'https://www.reuters.com/world/some-story-2026-11-05/';

const resp = (body, ok = true) => ({ ok, status: ok ? 200 : 500, text: async () => body });
// Fake Google: the article page carries the signature/timestamp, batchexecute answers garturlres.
const fakeGoogle = (target = REAL) => async (url) => {
  if (String(url).startsWith('https://news.google.com/articles/')) return resp('<c-wiz><div data-n-a-sg="SIG" data-n-a-ts="1730000000"></div></c-wiz>');
  if (String(url).includes('batchexecute')) return resp(`)]}'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"${target}\\",1]",null,null,null,"generic"]]`);
  if (String(url) === 'https://feeds.example.com/gn.xml') {
    return resp(`<?xml version="1.0"?><rss><channel><title>GN</title>
<item><title>Story one - Reuters</title><link>${GN}</link><pubDate>Wed, 05 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Story two</title><link>https://apnews.com/article/two</link><pubDate>Wed, 05 Nov 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`);
  }
  return resp('', false);
};

test('gnews: recognises Google News redirect links and their ids', () => {
  assert.equal(isGoogleNewsUrl(GN), true);
  assert.equal(isGoogleNewsUrl('https://news.google.com/articles/abc'), true);
  assert.equal(isGoogleNewsUrl(REAL), false);
  assert.equal(isGoogleNewsUrl('not a url'), false);
  assert.equal(googleNewsId(GN), 'CBMiAU_yqLtestid123');
  assert.equal(googleNewsId(REAL), null);
});

test('gnews: resolves to the publisher URL (memoised), null when Google fails or offline', async () => {
  const cache = {};
  assert.equal(await resolveGoogleNews(GN, { fetchImpl: fakeGoogle(), cache }), REAL);
  assert.equal(cache.CBMiAU_yqLtestid123, REAL);
  assert.equal(await resolveGoogleNews(GN, { fetchImpl: async () => { throw new Error('no network'); }, cache }), REAL);
  assert.equal(await resolveGoogleNews(GN, { fetchImpl: async () => resp('', false) }), null);
  assert.equal(await resolveGoogleNews(GN, { fetchImpl: fakeGoogle(), offline: true }), null);
  // a redirect that points back at Google is not a resolution
  assert.equal(await resolveGoogleNews(GN, { fetchImpl: fakeGoogle('https://news.google.com/x') }), null);
});

test('gnews: fetchPool swaps Google News items for the publisher URL, or drops them', async () => {
  const feeds = [{ id: 'gn', url: 'https://feeds.example.com/gn.xml', name: 'GN', tier: 'news' }];
  const ok = await fetchPool({ env: {}, feeds, fetchImpl: fakeGoogle(), resolveRedirects: true });
  assert.deepEqual(ok.items.map((x) => x.url), [REAL, 'https://apnews.com/article/two']);
  assert.equal(ok.items[0].domain, 'reuters.com');
  const failing = async (url) => (String(url).includes('news.google.com') ? resp('', false) : fakeGoogle()(url));
  const dropped = await fetchPool({ env: {}, feeds, fetchImpl: failing, resolveRedirects: true });
  assert.deepEqual(dropped.items.map((x) => x.url), ['https://apnews.com/article/two']);
});

test('validate: Google News links are rejected as cards and as news/topic URLs', () => {
  const knownUrls = new Set([GN]);
  assert.match(cardProblems({ media: [{ kind: 'link_card', url: GN }] }, { knownUrls }).join('\n'), /Google News/);
  assert.match(cardProblems({ news: { url: GN } }, { knownUrls }).join('\n'), /Google News/);
  assert.match(cardProblems({ topic: { url: GN } }, { knownUrls }).join('\n'), /Google News/);
  assert.deepEqual(cardProblems({ news: { url: REAL }, media: [{ kind: 'link_card', url: REAL }] }, { knownUrls }), []);
});

test('corpus: no committed post links to Google News', () => {
  const bad = [];
  for (const p of loadPosts()) {
    for (const u of [p.news?.url, p.topic?.url, ...(p.media ?? []).map((m) => m.url)]) if (isGoogleNewsUrl(u)) bad.push(`${p.id}: ${u}`);
  }
  assert.deepEqual(bad, []);
});
