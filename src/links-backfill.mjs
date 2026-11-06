#!/usr/bin/env node
// Backfill real link data into the committed corpus (idempotent; re-run safely):
//  - Google News redirect links (news.google.com/rss/articles/…) become the publisher's article URL
//    (src/lib/gnews.mjs); unresolvable ones are removed;
//  - unfurls every link_card / news.url / topic.url through the fetch cache (og:image hotlinked, never downloaded);
//  - news items without a URL: look up the real article, in order: titles already in the unfurl cache,
//    Bing News RSS, then the Hacker News search API (hn.algolia.com; HN-sourced items keep the HN item URL).
//    A hit needs a title match >= --min-overlap and a date near the post; otherwise the post stays
//    card-less (no invented URLs). Misses are remembered per searcher, so a new searcher retries them;
//  - x.com / bsky.app links become x_post / bsky_post quotes when the account is allowlisted
//    (real-accounts.json); otherwise the card is dropped;
//  - cards whose page is gone (404/410) are dropped;
//  - --refresh-images: refetch cached pages that have no preview image (og:image, twitter:image,
//    link rel=image_src, then the first large article <img>). A card whose page still has no image
//    (bot-blocked, JS-only, or imageless) is swapped to the same story on another outlet that has one:
//    the HN item's own story URL, else a Bing News match (same title-overlap and date rules). Swaps are
//    remembered in the cache under `alt`.
// Usage: node src/links-backfill.mjs [--offline] [--no-search] [--dry-run] [--refresh-images] [--min-overlap 0.6]
import fs from 'node:fs';
import path from 'node:path';
import { sitePath } from './lib/site.mjs';
import { safeUrl } from './lib/data.mjs';
import { domainOf, decode } from './lib/news.mjs';
import { safeFetch } from './lib/safe-fetch.mjs';
import { isGoogleNewsUrl, resolveGoogleNews } from './lib/gnews.mjs';
import { loadUnfurlCache, saveUnfurlCache, unfurl, linkCardFrom, genericTitle, UA } from './lib/unfurl.mjs';
import { realPostCached, realPostKind, loadRealAccounts, allowedAccount, titleOverlap as overlap } from './lib/realposts.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const offline = flag('--offline');
const search = !offline && !flag('--no-search');
const dryRun = flag('--dry-run');
const minOverlap = Number(opt('--min-overlap', 0.6));
const refreshImages = flag('--refresh-images') && !offline;
// Outlets whose pages never yield a preview for a bot (JS-only shells or hard bot walls): never swap *to* them.
// Ranking for swaps: established outlets first; content farms / aggregators never.
const MAJOR = /(^|\.)(bbc\.co\.uk|bbc\.com|theguardian\.com|aljazeera\.com|france24\.com|dw\.com|npr\.org|cnn\.com|cbsnews\.com|nbcnews\.com|abcnews\.go\.com|abc\.net\.au|bloomberg\.com|cnbc\.com|straitstimes\.com|channelnewsasia\.com|japantimes\.co\.jp|euronews\.com|independent\.co\.uk|sky\.com|washingtonpost\.com|theverge\.com|arstechnica\.com|techcrunch\.com|wired\.com|politico\.(com|eu)|axios\.com|latimes\.com|cbc\.ca|globalnews\.ca|time\.com|scientificamerican\.com|nature\.com|phys\.org|theconversation\.com|espn\.com|pbs\.org|ft\.com|economist\.com|theatlantic\.com|scmp\.com|thehindu\.com|timesofindia\.indiatimes\.com|lemonde\.fr|nytimes\.com|usatoday\.com|foxnews\.com|newsweek\.com|engadget\.com|404media\.co|zdnet\.com|heise\.de|theregister\.com|gizmodo\.com|semafor\.com|voanews\.com|rfi\.fr|swissinfo\.ch|abc7\.com|nbclosangeles\.com|orlandosentinel\.com|mirror\.co\.uk|thetimes\.com)$/;
const LOW_QUALITY = /(^|\.)(hngn\.com|menafn\.com|udaipurkiran\.com|kenya-today\.com|fakti\.bg|says\.com|radiohc\.cu|ntd\.com|cryptobriefing\.com|naijanews\.com|devdiscourse\.com|marketscreener\.com|latestly\.com|newsbreak\.com|ground\.news|inkl\.com|flipboard\.com|newsnow\.co\.uk|dailymotion\.com|youtube\.com)$/;
const NOT_ARTICLE = /\/(topics?|tags?|section|sections|authors?|category|categories|live-news|search)(\/|$|\?)/i;
const NO_PREVIEW = /(^|\.)(msn\.com|reuters\.com|apnews\.com|news\.ycombinator\.com|news\.google\.com|bing\.com)$/;
const EXCLUDE_Q = ' -site:msn.com -site:reuters.com -site:apnews.com';
/** Same-story check for a swap when headlines are worded differently: every proper noun of the
 * original headline appears in the candidate, half the words overlap, and it ran within 3 days. */
const ENTITY_STOP = new Set(['The', 'A', 'An', 'In', 'On', 'At', 'Of', 'For', 'To', 'And', 'After', 'As', 'With', 'From', 'New', 'More', 'Why', 'How', 'What', 'Who', 'US', 'UK']);
function sameStory(title, cand, at) {
  const ents = String(title).split(/\s+/).slice(1).map((w) => w.replace(/[^\p{L}\p{N}-]/gu, '').replace(/s$/, '')).filter((w) => /^\p{Lu}/u.test(w) && w.length > 2 && !ENTITY_STOP.has(w));
  const low = String(cand.title).toLowerCase();
  if (!ents.length || !ents.every((e) => low.includes(e.toLowerCase()))) return false;
  const pub = Date.parse(cand.pubDate ?? '');
  const t = Date.parse(at ?? '');
  return overlap(title, cand.title) >= 0.5 && Number.isFinite(pub) && Number.isFinite(t) && Math.abs(pub - t) <= 3 * 864e5;
}

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

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'its', 'has', 'have', 'after', 'over', 'into', 'about', 'new']);
const best = (news, hits) => {
  const want = outletDomain(news.source);
  return hits.map((h) => ({ ...h, score: overlap(news.title, h.title) + (want && h.url && domainOf(h.url).endsWith(want) ? 0.1 : 0) })).sort((a, b) => b.score - a.score)[0] ?? null;
};
const SEARCHERS = {
  cache: async (news, ctx) => best(news, ctx.cacheHits),
  'bing-news-rss': async (news) => findArticle(news),
  'bing-keywords': async (news) => {
    const q = [...words(news.title)].filter((w) => !STOP.has(w)).slice(0, 7).join(' ');
    return q ? best(news, await bingNews(q).catch(() => [])) : null;
  },
  // Differently-worded headline of the same story (proper nouns + date), only from a page with a preview image.
  'bing-same-story': async (news) => {
    const kw = [...words(news.title)].filter((w) => !STOP.has(w)).slice(0, 8).join(' ');
    const hits = (await Promise.all([news.title + EXCLUDE_Q, kw + EXCLUDE_Q].map((q) => bingNews(q).catch(() => [])))).flat();
    for (const h of hits.filter((x) => !NO_PREVIEW.test(domainOf(x.url)) && !LOW_QUALITY.test(domainOf(x.url)) && !realPostKind(x.url) && sameStory(news.title, x, news._at))) {
      const e = await unfurl(h.url, { cache: news._cache, refresh: true });
      if (e?.ok && e.meta?.image?.url) return { ...h, score: overlap(news.title, h.title), same: true };
    }
    return null;
  },
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
  if (!hit.same && hit.score < (n <= 4 ? 0.85 : n <= 6 ? 0.72 : minOverlap)) return null;
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
  const stats = { cards: 0, enriched: 0, images: 0, added: 0, searched: 0, found: 0, notFound: 0, realPosts: 0, googleNews: 0, dropped: [], unresolved: [] };

  // 0) Google News redirect links (news.google.com/rss/articles/…) → the publisher's article URL
  //    (memoised in the cache under `gnews`). Unresolvable ones are removed: never a card or news/topic URL.
  const gmemo = (cache.gnews ??= {});
  const gurls = new Set();
  for (const p of posts) {
    for (const m of p.media ?? []) if (m.kind === 'link_card' && isGoogleNewsUrl(m.url)) gurls.add(m.url);
    for (const u of [p.news?.url, p.topic?.url]) if (isGoogleNewsUrl(u)) gurls.add(u);
  }
  const gres = new Map();
  await pool([...gurls], 3, async (u) => gres.set(u, await resolveGoogleNews(u, { cache: gmemo, offline })));
  for (const p of posts) {
    if (p.media) {
      p.media = p.media.filter((m) => {
        if (m.kind !== 'link_card' || !isGoogleNewsUrl(m.url)) return true;
        const to = gres.get(m.url);
        if (to) {
          m.url = to;
          stats.googleNews++;
          return true;
        }
        stats.dropped.push(`${p.id}: unresolved Google News link ${m.url}`);
        return false;
      });
      if (!p.media.length) delete p.media;
    }
    if (isGoogleNewsUrl(p.news?.url)) p.news.url = gres.get(p.news.url) ?? null;
    if (isGoogleNewsUrl(p.topic?.url)) p.topic.url = gres.get(p.topic.url) ?? null;
  }

  // 1) Real article lookups for URL-less news items (by unique title).
  const gone = (u) => [404, 410].includes(cache.items[u]?.status);
  const needsUrl = (p) => p.news?.title && (!safeUrl(p.news.url ?? '') || gone(p.news.url)) && !(p.media ?? []).some((m) => m.kind === 'link_card' && !gone(m.url));
  const missing = [...new Map(posts.filter(needsUrl).map((p) => [p.news.title, p.news])).values()];
  const found = new Map(Object.entries(cache.search ?? {}));
  const ctx = { cacheHits: cacheHits(cache) };
  const tried = (e) => (e?.url ? null : new Set(e?.tried ?? (e === null ? ['bing-news-rss'] : [])));
  const datedOk = (n, hit) => accept({ ...hit, published: hit.pubDate }, { news: n, createdAt: n._at });
  for (const p of posts.filter(needsUrl)) missing.find((n) => n.title === p.news.title)._at ??= p.createdAt;
  for (const n of missing) Object.defineProperty(n, '_cache', { value: cache, enumerable: false, configurable: true });
  await pool(missing.filter((n) => !found.get(n.title)?.url), 3, async (n) => {
    const done = tried(found.get(n.title));
    for (const [via, fn] of Object.entries(SEARCHERS)) {
      if (done.has(via) || (via !== 'cache' && !search)) continue;
      stats.searched++;
      const hit = await fn(n, ctx);
      if (hit?.url && datedOk(n, hit)) {
        found.set(n.title, { url: hit.url, title: hit.title, published: hit.pubDate, score: Math.round(hit.score * 100) / 100, via, ...(hit.same ? { same: true } : {}) });
        return;
      }
      if (via !== 'cache') done.add(via);
      found.set(n.title, { url: null, tried: [...done].sort() });
    }
  });
  for (const n of missing) delete n._at, delete n._cache;
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
    else await unfurl(u, { cache, offline, refresh: refreshImages });
  });

  // 2b) Cards still without a preview image: find the same story on an outlet that has one.
  const alt = (cache.alt ??= {});
  const hasImage = (u) => Boolean(cache.items[u]?.ok && cache.items[u]?.meta?.image?.url);
  if (refreshImages) {
    const need = new Map();
    for (const p of posts) {
      const cardUrls = (p.media ?? []).filter((m) => m.kind === 'link_card' && safeUrl(m.url ?? '')).map((m) => [m.url, m.title]);
      if (!cardUrls.length && safeUrl(p.news?.url ?? '') && !realPostKind(p.news.url)) cardUrls.push([p.news.url, p.news.title]);
      for (const [u, title] of cardUrls) if (!hasImage(u) && !alt[u]?.url && !need.has(u)) need.set(u, { title: p.news?.title || title || '', source: p.news?.source, at: p.createdAt });
    }
    await pool([...need], 3, async ([u, info]) => {
      const tried = new Set(alt[u]?.tried ?? []);
      const cands = [];
      const hn = u.match(/^https:\/\/news\.ycombinator\.com\/item\?id=(\d+)/);
      if (hn && !tried.has('hn-story')) {
        tried.add('hn-story');
        const item = await safeFetch(`https://hn.algolia.com/api/v1/items/${hn[1]}`, { expect: 'json', timeoutMs: 10000 }).then((r) => (r.ok ? JSON.parse(r.text) : null)).catch(() => null);
        if (safeUrl(item?.url ?? '') && !realPostKind(item.url)) cands.push({ url: item.url, title: item.title ?? info.title, score: 1, via: 'hn-story' });
      }
      if (words(info.title).size >= 4 && search && !tried.has('bing-news-rss')) {
        tried.add('bing-news-rss');
        const news = { title: info.title, source: info.source };
        const kw = [...words(info.title)].filter((w) => !STOP.has(w)).slice(0, 8).join(' ');
        const hits = (await Promise.all([info.title, info.title + EXCLUDE_Q, kw + EXCLUDE_Q].map((q) => bingNews(q).catch(() => [])))).flat();
        const seen = new Set();
        for (const h of hits) {
          if (seen.has(h.url)) continue;
          seen.add(h.url);
          if (!h.url || realPostKind(h.url) || domainOf(h.url) === domainOf(u) || LOW_QUALITY.test(domainOf(h.url)) || NOT_ARTICLE.test(new URL(h.url).pathname) || NO_PREVIEW.test(domainOf(h.url))) continue;
          const hit = accept({ ...h, score: overlap(info.title, h.title), published: h.pubDate }, { news, createdAt: info.at }) ?? (sameStory(info.title, h, info.at) ? { ...h, score: overlap(info.title, h.title) } : null);
          if (hit) cands.push({ url: h.url, title: h.title, score: Math.round(hit.score * 100) / 100, rank: hit.score + (MAJOR.test(domainOf(h.url)) ? 0.2 : 0), via: 'bing-news-rss' });
        }
      }
      cands.sort((a, b) => (b.rank ?? 9) - (a.rank ?? 9));
      for (const c of cands.slice(0, 5)) {
        const e = await unfurl(c.url, { cache, refresh: true });
        if (e?.ok && e.meta?.image?.url && !(e.status >= 400)) {
          alt[u] = { url: c.url, title: c.title, score: c.score, via: c.via };
          return;
        }
      }
      alt[u] = { url: null, tried: [...tried].sort() };
    });
  }
  const swap = (u) => (u && !hasImage(u) && alt[u]?.url && hasImage(alt[u].url) ? alt[u].url : u);
  let swapped = 0;

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
      const to = m.kind === 'link_card' ? swap(m.url) : m.url;
      if (to !== m.url) {
        swapped++;
        if (p.news?.url === m.url) p.news.url = to;
        if (p.topic?.url === m.url) p.topic.url = to;
      }
      const r = cardFor(to, { ...fallback, title: to === m.url ? (m.title && !genericTitle(m.title, m.url) ? m.title : fallback.title ?? m.title) : alt[m.url]?.title ?? fallback.title });
      if (r.card) {
        media.push(r.card);
        hasCard = true;
        stats.enriched++;
      } else stats.dropped.push(`${p.id}: ${r.drop}`);
    }
    const url0 = safeUrl(p.news?.url ?? '') ?? safeUrl(p.topic?.url ?? '');
    const url = swap(url0);
    if (!hasCard && url && media.length < 4) {
      if (url !== url0) {
        swapped++;
        if (p.news?.url === url0) p.news.url = url;
        if (p.topic?.url === url0) p.topic.url = url;
      }
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
  const noImage = posts.flatMap((p) => (p.media ?? []).filter((m) => m.kind === 'link_card' && !m.image?.url)).length;
  console.log(JSON.stringify({ ...stats, swapped, noImage, cacheEntries: Object.keys(cache.items).length, cacheOk: ok, dropped: stats.dropped, unresolved: stats.unresolved.length }, null, 1));
}

// Node 24 on Windows intermittently dies mid-run with a native fast-fail (0xC0000409, no JS stack,
// roughly 1 run in 10). Nothing is written until the very end, so the parent reruns the work in a
// child process and retries only on that kind of native crash.
const NATIVE_CRASH = (code, signal) => signal != null || code < 0 || code > 255;
async function supervise(tries = 3) {
  const { spawnSync } = await import('node:child_process');
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(process.execPath, [...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, LINKS_BACKFILL_CHILD: '1' } });
    if (!NATIVE_CRASH(r.status, r.signal) || attempt >= tries) {
      process.exitCode = r.status ?? 1;
      return;
    }
    console.error(`links:backfill: worker crashed natively (${r.signal ?? `0x${(r.status >>> 0).toString(16)}`}), retrying (${attempt + 1}/${tries})`);
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('links-backfill.mjs')) {
  if (process.env.LINKS_BACKFILL_CHILD) await main();
  else await supervise();
}
