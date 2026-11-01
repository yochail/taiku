// Topic scan: real headlines and trends from public RSS/Atom/JSON feeds ($0, no keys).
// Two tiers:
//   curated   (BBC, AP via Google News, The Verge)       → auto-publishable
//   community (Hacker News, Google Trends, Reddit r/popular) → staging only, human promote
// Feed items are UNTRUSTED: titles are sanitised here, and the model only ever sees
// sanitised titles + domains wrapped in <untrusted_source> (see wrapUntrusted). URLs are kept
// for link cards / topic.url but never shown to the model.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, safeUrl } from './data.mjs';
import { hash8 } from './pipeline-util.mjs';

export const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures', 'feeds');

/** Default feeds. `fixture` names the offline copy under test/fixtures/feeds/. */
export const FEEDS = [
  { id: 'bbc-world', tier: 'curated', kind: 'news', section: 'world', source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', fixture: 'bbc-world.xml' },
  { id: 'bbc-tech', tier: 'curated', kind: 'news', section: 'tech', source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', fixture: 'bbc-tech.xml' },
  { id: 'bbc-science', tier: 'curated', kind: 'news', section: 'science', source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', fixture: 'bbc-science.xml' },
  { id: 'bbc-culture', tier: 'curated', kind: 'news', section: 'culture', source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', fixture: 'bbc-culture.xml' },
  { id: 'bbc-sport', tier: 'curated', kind: 'news', section: 'sports', source: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', fixture: 'bbc-sport.xml' },
  { id: 'ap', tier: 'curated', kind: 'news', section: 'world', source: 'AP News', url: 'https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en', fixture: 'ap.xml' },
  { id: 'verge', tier: 'curated', kind: 'news', section: 'tech', source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', fixture: 'verge.xml' },
  { id: 'hn', tier: 'community', kind: 'news', section: 'tech', source: 'Hacker News', url: 'https://hnrss.org/frontpage', fixture: 'hn.xml' },
  { id: 'google-trends', tier: 'community', kind: 'trend', section: 'trend', source: 'Google Trends', url: 'https://trends.google.com/trending/rss?geo=US', fixture: 'google-trends.xml' },
  { id: 'reddit-popular', tier: 'community', kind: 'viral', section: 'memes', source: 'Reddit', url: 'https://www.reddit.com/r/popular.json?limit=50&raw_json=1', fixture: 'reddit-popular.json' },
];

// ---------------------------------------------------------------------------
// Untrusted text handling.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INJECTION = /\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(instructions?|rules|prompts?|above|previous|prior|system)\b|\bsystem prompt\b|\byou are now\b|\bnew instructions\b|\bdeveloper mode\b|\bjailbreak\b|\b(assistant|system|user)\s*:|<\/?\s*(untrusted_source|system|task_spec|thread_context)|\bdo anything now\b|\bact as\b|\bpretend to be\b|\breveal (your|the) (prompt|instructions)\b|\btool_calls?\b/i;
export const looksLikeInjection = (s) => INJECTION.test(String(s ?? ''));

/** Sanitise a feed string for model-visible use: no control chars, markup, URLs or brackets; ≤ max chars. */
export function sanitizeUntrusted(s, max = 160) {
  let t = String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[<>{}[\]`\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return t;
}

/** The ONLY way feed-derived text reaches a model: sanitised fields inside an untrusted block. */
export function wrapUntrusted(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${sanitizeUntrusted(v).replace(/untrusted_source/gi, 'source')}`);
  return `<untrusted_source>\n${lines.join('\n')}\n</untrusted_source>`;
}

export const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^(www|feeds|rss|m)\./, '');
  } catch {
    return '';
  }
};

function cleanUrl(u) {
  const s = safeUrl(String(u ?? '').trim());
  if (!s) return null;
  const url = new URL(s);
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|at_|ref$|cmp$|ocid$|ns_)/i.test(k)) url.searchParams.delete(k);
  url.hash = '';
  return url.toString();
}

// ---------------------------------------------------------------------------
// Parsing.

const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1];

function parseReddit(json, feed) {
  const data = JSON.parse(json);
  return (data?.data?.children ?? []).map((c) => c.data ?? {}).map((d) => ({
    title: decode(d.title),
    link: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url,
    source: d.subreddit_name_prefixed ? `Reddit ${d.subreddit_name_prefixed}` : feed.source,
    publishedAt: Number.isFinite(d.created_utc) ? new Date(d.created_utc * 1000).toISOString() : null,
    nsfw: Boolean(d.over_18),
    traffic: Number.isFinite(d.score) ? d.score : null,
  }));
}

function parseXml(xml, feed) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const entries = blocks.length ? blocks : [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  return entries.map((block) => {
    let title = decode(tag(block, 'title'));
    let link = decode(tag(block, 'link')) || block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || '';
    let source = decode(tag(block, 'source')) || feed.source;
    let traffic = null;
    if (feed.kind === 'trend') {
      const newsUrl = decode(tag(block, 'ht:news_item_url'));
      const newsSrc = decode(tag(block, 'ht:news_item_source'));
      traffic = decode(tag(block, 'ht:approx_traffic')) || null;
      if (newsUrl) link = newsUrl;
      if (newsSrc) source = `${feed.source} · ${newsSrc}`;
    } else if (/news\.google\.com/.test(feed.url)) {
      const m = title.match(/^(.*\S) - ([^-]{2,60})$/);
      if (m) {
        title = m[1].trim();
        source = m[2].trim();
      }
    }
    const nsfw = /<category[^>]*>\s*(?:<!\[CDATA\[)?\s*nsfw/i.test(block) || /\bover_18>\s*true/i.test(block);
    const pub = decode(tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published') ?? '');
    const t = Date.parse(pub);
    return { title, link, source, publishedAt: Number.isNaN(t) ? null : new Date(t).toISOString(), nsfw, traffic };
  });
}

/** Parse one feed body into normalised items (title sanitised, url via safeUrl). */
export function parseFeed(body, feed) {
  const raw = String(body ?? '').trimStart().startsWith('{') ? parseReddit(body, feed) : parseXml(String(body ?? ''), feed);
  const out = [];
  for (const r of raw) {
    const url = cleanUrl(r.link);
    const rawTitle = decode(r.title);
    const title = sanitizeUntrusted(rawTitle, 180);
    if (!url || !title) continue;
    out.push({
      id: `t${hash8(url)}`,
      title,
      url,
      domain: domainOf(url),
      source: sanitizeUntrusted(r.source, 60) || feed.source,
      feedId: feed.id,
      tier: feed.tier,
      kind: feed.kind,
      section: feed.section,
      publishedAt: r.publishedAt,
      nsfw: Boolean(r.nsfw),
      injection: looksLikeInjection(rawTitle) || looksLikeInjection(r.source),
      traffic: r.traffic ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fetching.

/** Offline fetch: serves FEEDS[].fixture for known feed URLs, 404 otherwise. Never touches the network. */
export function fixtureFetch(feeds = FEEDS, dir = FIXTURE_DIR) {
  return async (url) => {
    const f = feeds.find((x) => x.url === String(url));
    const file = f?.fixture && path.join(dir, f.fixture);
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(fs.readFileSync(file, 'utf8'), { status: 200 });
  };
}

/**
 * Feed list. NEWS_FEEDS (comma-separated `tier|kind|section|url` or plain URLs = curated news)
 * replaces the defaults; `none` disables fetching (evergreen topics only).
 */
export function feedConfig(env = process.env) {
  const v = (env.NEWS_FEEDS ?? '').trim();
  if (!v) return FEEDS;
  if (v.toLowerCase() === 'none') return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean).map((s, i) => {
    const parts = s.split('|');
    const url = parts.pop();
    const [tier = 'curated', kind = 'news', section = 'news'] = parts;
    return { id: `custom-${i}`, tier: tier === 'community' ? 'community' : 'curated', kind: ['news', 'trend', 'viral'].includes(kind) ? kind : 'news', section, source: domainOf(url), url };
  });
}

/** Fetch + parse all feeds in parallel; per-feed failures are tolerated and reported. */
export async function fetchPool({ env = process.env, fetchImpl = globalThis.fetch, feeds = feedConfig(env), log = () => {} } = {}) {
  const timeout = Number(env.NEWS_TIMEOUT_MS) || 8000;
  const perFeed = Number(env.NEWS_PER_FEED) || 25;
  const results = await Promise.allSettled(feeds.map(async (f) => {
    const res = await fetchImpl(f.url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; taiku.app feed reader; +https://taiku.app)', accept: 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.5' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), f).slice(0, perFeed);
  }));
  const items = [];
  const report = [];
  const seen = new Set();
  results.forEach((r, i) => {
    const f = feeds[i];
    if (r.status === 'rejected') {
      const error = String(r.reason?.message ?? r.reason).slice(0, 120);
      report.push({ feed: f.id, ok: false, error });
      log(`  ! feed ${f.id} failed: ${error}`);
      return;
    }
    let kept = 0;
    for (const it of r.value) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      items.push(it);
      kept++;
    }
    report.push({ feed: f.id, ok: true, items: r.value.length, kept });
  });
  return { items, report };
}
