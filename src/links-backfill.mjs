#!/usr/bin/env node
// Backfill real link data into the committed corpus (idempotent; re-run safely):
//  - unfurls every link_card / news.url / topic.url through the fetch cache (og:image hotlinked, never downloaded);
//  - news items without a URL: look up the real article, in order: titles already in the unfurl cache,
//    Bing News RSS, then the Hacker News search API (hn.algolia.com; HN-sourced items keep the HN item URL).
//    A hit needs a title match >= --min-overlap and a date near the post; otherwise the post stays
//    card-less (no invented URLs). Misses are remembered per searcher, so a new searcher retries them;
//  - x.com / bsky.app links become x_post / bsky_post quotes when the account is allowlisted
//    (real-accounts.json); otherwise the card is dropped;
//  - cards whose page is gone (404/410) are dropped.
// Usage: node src/links-backfill.mjs [--offline] [--no-search] [--dry-run] [--min-overlap 0.6]
import fs from 'node:fs';
import path from 'node:path';
import { sitePath } from './lib/site.mjs';
import { safeUrl } from './lib/data.mjs';
import { domainOf, decode } from './lib/news.mjs';
import { loadUnfurlCache, saveUnfurlCache, unfurl, linkCardFrom, UA } from './lib/unfurl.mjs';
import { realPostCached, realPostKind, loadRealAccounts, allowedAccount, titleOverlap as overlap } from './lib/realposts.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const offline = flag('--offline');
const search = !offline && !flag('--no-search');
const dryRun = flag('--dry-run');
const minOverlap = Number(opt('--min-overlap', 0.6));

const words = (s) => new Set(String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));

const OUTLET = { reuters: 'reuters.com', ap: 'apnews.com', 'associated press': 'apnews.com', afp: 'france24.com', bbc: 'bbc.com', 'bbc news': 'bbc.co.uk', guardian: 'theguardian.com', 'the guardian': 'theguardian.com', 'al jazeera': 'aljazeera.com', nyt: 'nytimes.com', 'new york times': 'nytimes.com', npr: 'npr.org', 'hacker news': 'news.ycombinator.com' };
const outletDomain = (src) => {
  const s = String(src ?? '').toLowerCase().trim();
  return OUTLET[s] ?? (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s.replace(/^www\./, '') : null);
};

async function bingNews(query) {
  const res = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const title = decode(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = decode(it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '');
    let url = null;
    try {
      url = safeUrl(new URL(link).searchParams.get('url') ?? '');
    } catch {}
    return { title, url, pubDate: it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? null };
  }).filter((x) => x.url);
}

async function hnSearch(query) {
  const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const doc = await res.json();
  return (doc.hits ?? []).map((h) => ({ title: h.title ?? '', url: safeUrl(h.url ?? ''), hnUrl: `https://news.ycombinator.com/item?id=${h.objectID}`, pubDate: h.created_at ?? null }));
}

/** Titles the unfurl cache already fetched (a real page we saw), as search hits. */
const cacheHits = (cache) => Object.values(cache.items ?? {}).filter((e) => e.ok && e.meta?.title && safeUrl(e.url ?? '')).map((e) => ({ title: e.meta.title, url: e.url, pubDate: e.meta.published ?? null }));

const best = (news, hits) => {
  const want = outletDomain(news.source);
  return hits.map((h) => ({ ...h, score: overlap(news.title, h.title) + (want && h.url && domainOf(h.url).endsWith(want) ? 0.1 : 0) })).sort((a, b) => b.score - a.score)[0] ?? null;
};
const SEARCHERS = {
  cache: async (news, ctx) => best(news, ctx.cacheHits),
  'bing-news-rss': async (news) => findArticle(news),
  'hn-algolia': async (news) => {
    const hn = /hacker news/i.test(news.source ?? '');
    const hits = (await hnSearch(news.title).catch(() => [])).map((h) => ({ ...h, url: hn || !h.url ? h.hnUrl : h.url }));
    return best(news, hits);
  },
};

async function findArticle(news) {
  const want = outletDomain(news.source);
  const hits = await bingNews(news.title).catch(() => []);
  const scored = hits.map((h) => ({ ...h, score: overlap(news.title, h.title) + (want && domainOf(h.url).endsWith(want) ? 0.1 : 0) })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score >= minOverlap ? best : null;
}

/** A search hit counts only if it matches strongly (short headlines need more) and is dated near the post. */
function accept(hit, post) {
  if (!hit?.url) return null;
  const n = words(post.news.title).size;
  if (hit.score < (n <= 4 ? 0.85 : n <= 6 ? 0.72 : minOverlap)) return null;
  const pub = Date.parse(hit.published ?? '');
  const at = Date.parse(post.createdAt ?? '');
  if (Number.isFinite(pub) && Number.isFinite(at) && Math.abs(pub - at) > 10 * 864e5) return null;
  return hit;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function main() {
  const dir = sitePath('content', 'posts');
  const cache = loadUnfurlCache();
  const accounts = loadRealAccounts();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const docs = files.map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    return { f, crlf: raw.includes('\r\n'), doc: JSON.parse(raw) };
  });
  const posts = docs.flatMap((d) => (Array.isArray(d.doc) ? d.doc : d.doc.posts));
  const stats = { cards: 0, enriched: 0, images: 0, added: 0, searched: 0, found: 0, notFound: 0, realPosts: 0, dropped: [], unresolved: [] };

  // 1) Real article lookups for URL-less news items (by unique title).
  const gone = (u) => [404, 410].includes(cache.items[u]?.status);
  const needsUrl = (p) => p.news?.title && (!safeUrl(p.news.url ?? '') || gone(p.news.url)) && !(p.media ?? []).some((m) => m.kind === 'link_card' && !gone(m.url));
  const missing = [...new Map(posts.filter(needsUrl).map((p) => [p.news.title, p.news])).values()];
  const found = new Map(Object.entries(cache.search ?? {}));
  const ctx = { cacheHits: cacheHits(cache) };
  const tried = (e) => (e?.url ? null : new Set(e?.tried ?? (e === null ? ['bing-news-rss'] : [])));
  const datedOk = (n, hit) => accept({ ...hit, published: hit.pubDate }, { news: n, createdAt: n._at });
  for (const p of posts.filter(needsUrl)) missing.find((n) => n.title === p.news.title)._at ??= p.createdAt;
  await pool(missing.filter((n) => !found.get(n.title)?.url), 3, async (n) => {
    const done = tried(found.get(n.title));
    for (const [via, fn] of Object.entries(SEARCHERS)) {
      if (done.has(via) || (via !== 'cache' && !search)) continue;
      stats.searched++;
      const hit = await fn(n, ctx);
      if (hit?.url && datedOk(n, hit)) {
        found.set(n.title, { url: hit.url, title: hit.title, published: hit.pubDate, score: Math.round(hit.score * 100) / 100, via });
        return;
      }
      if (via !== 'cache') done.add(via);
      found.set(n.title, { url: null, tried: [...done].sort() });
    }
  });
  for (const n of missing) delete n._at;
  cache.search = Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));

  // 2) Unfurl / fetch every URL we may render.
  const urls = new Set();
  for (const p of posts) {
    for (const m of p.media ?? []) if (m.kind === 'link_card' && safeUrl(m.url ?? '')) urls.add(m.url);
    if (safeUrl(p.news?.url ?? '')) urls.add(p.news.url);
    if (safeUrl(p.topic?.url ?? '')) urls.add(p.topic.url);
    const hit = p.news?.title && accept(found.get(p.news.title), p);
    if (hit?.url) urls.add(hit.url);
  }
  await pool([...urls], 6, async (u) => {
    if (realPostKind(u)) await realPostCached(u, { cache, offline });
    else await unfurl(u, { cache, offline });
  });

  // 3) Rewrite cards.
  const cardFor = (url, fallback) => {
    const kind = realPostKind(url);
    if (kind) {
      const e = cache.items[url];
      const acct = e?.ok && allowedAccount(accounts, kind === 'x_post' ? 'x' : 'bluesky', e.post.handle);
      if (!acct) return { drop: `real post not from an allowlisted public account (${url})` };
      stats.realPosts++;
      return { card: { ...e.post } };
    }
    const e = cache.items[url];
    if (e && [404, 410].includes(e.status)) return { drop: `page gone (${e.status}) ${url}` };
    const card = linkCardFrom(url, e, fallback);
    if (card?.image) stats.images++;
    return card ? { card } : { drop: `bad url ${url}` };
  };
  for (const p of posts) {
    const fallback = { title: p.news?.title ?? p.topic?.title, source: p.news?.source ?? p.topic?.source };
    if (needsUrl(p)) {
      if (gone(p.news.url)) p.news.url = null;
      if (p.topic?.url && gone(p.topic.url)) p.topic.url = null;
      const hit = accept(found.get(p.news.title), p);
      if (hit?.url) {
        p.news.url = hit.url;
        stats.found++;
      } else if (!(p.media ?? []).some((m) => m.kind === 'link_card')) {
        stats.notFound++;
        stats.unresolved.push(`${p.id}: ${p.news.title}`);
      }
    }
    const media = [];
    let hasCard = false;
    for (const m of p.media ?? []) {
      if (!['link_card', 'x_post', 'bsky_post'].includes(m.kind)) {
        media.push(m);
        continue;
      }
      stats.cards++;
      const r = cardFor(m.url, { ...fallback, title: m.title ?? fallback.title });
      if (r.card) {
        media.push(r.card);
        hasCard = true;
        stats.enriched++;
      } else stats.dropped.push(`${p.id}: ${r.drop}`);
    }
    const url = safeUrl(p.news?.url ?? '') ?? safeUrl(p.topic?.url ?? '');
    if (!hasCard && url && media.length < 4) {
      const r = cardFor(url, fallback);
      if (r.card) {
        media.push(r.card);
        stats.added++;
      } else {
        stats.dropped.push(`${p.id}: ${r.drop}`);
        if (p.news?.url === url) p.news.url = null;
        if (p.topic?.url === url) p.topic.url = null;
      }
    }
    if (media.length) p.media = media;
    else delete p.media;
  }

  if (flag('--show')) for (const [t, e] of found) if (e?.url) console.error(`${e.via} ${e.score} | ${t} | ${e.title} | ${e.url}`);
  if (!dryRun) {
    saveUnfurlCache(cache);
    for (const d of docs) {
      let out = JSON.stringify(d.doc, null, 2) + '\n';
      if (d.crlf) out = out.replace(/\n/g, '\r\n');
      fs.writeFileSync(path.join(dir, d.f), out);
    }
  }
  const ok = Object.values(cache.items).filter((e) => e.ok).length;
  console.log(JSON.stringify({ ...stats, cacheEntries: Object.keys(cache.items).length, cacheOk: ok, dropped: stats.dropped, unresolved: stats.unresolved.length }, null, 1));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('links-backfill.mjs')) await main();
