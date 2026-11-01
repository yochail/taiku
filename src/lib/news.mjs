// Topic scan: real headlines + trending searches from public RSS/Atom feeds. $0, no API keys.
// Real X trends aren't freely available via API, so Google Trends' daily RSS (what people are
// searching right now) + Google News + Hacker News front page act as the "trending" proxy.
// Every feed is optional: timeouts and failures are tolerated per feed.

export const DEFAULT_NEWS_FEEDS = [
  'world|https://feeds.bbci.co.uk/news/world/rss.xml',
  'tech|https://feeds.bbci.co.uk/news/technology/rss.xml',
  'science|https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  'business|https://feeds.bbci.co.uk/news/business/rss.xml',
  'culture|https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
  'us|https://feeds.npr.org/1001/rss.xml',
  'world|https://www.aljazeera.com/xml/rss/all.xml',
  'top|https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
  'wire|https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en',
  'wire|https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en',
  'tech|https://hnrss.org/frontpage',
];
export const DEFAULT_TRENDS_FEEDS = ['trend|https://trends.google.com/trending/rss?geo=US'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tag = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1];

function cleanUrl(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|at_|ref$|cmp$|ocid$)/i.test(k)) url.searchParams.delete(k);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Parse RSS 2.0 / Atom / Google Trends RSS into topic candidates. */
const SOURCE_NAMES = { 'bbci.co.uk': 'BBC News', 'bbc.co.uk': 'BBC News', 'npr.org': 'NPR', 'aljazeera.com': 'Al Jazeera', 'hnrss.org': 'Hacker News', 'news.ycombinator.com': 'Hacker News', 'trends.google.com': 'Google Trends' };

export function parseFeed(xml, { source, section = 'news', kind = 'news' } = {}) {
  const items = [];
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const atom = blocks.length ? [] : [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  const isGoogleNews = /news\.google\.com/.test(source);
  for (const block of [...blocks, ...atom]) {
    let title = decode(tag(block, 'title'));
    let link = decode(tag(block, 'link')) || block.match(/<link\b[^>]*href="([^"]+)"/i)?.[1] || '';
    let description = decode(tag(block, 'description') ?? tag(block, 'summary') ?? '');
    let src = decode(tag(block, 'source')) || source;
    const published = decode(tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published') ?? '');
    let traffic = null;
    if (kind === 'trend') {
      // Google Trends: <title> is the search query; the first related news item carries a real link.
      const newsTitle = decode(tag(block, 'ht:news_item_title'));
      const newsUrl = decode(tag(block, 'ht:news_item_url'));
      traffic = decode(tag(block, 'ht:approx_traffic')) || null;
      if (newsTitle) description = newsTitle;
      if (newsUrl) link = newsUrl;
      src = decode(tag(block, 'ht:news_item_source')) || 'Google Trends';
      if (!/^https?:/.test(link)) link = `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}`;
    } else if (isGoogleNews) {
      // Google News titles look like "Headline - Publisher".
      const m = title.match(/^(.*\S) - ([^-]{2,60})$/);
      if (m) {
        title = m[1].trim();
        if (src === source) src = m[2].trim();
      }
      description = '';
    }
    if (/hnrss|ycombinator|^Hacker News$/.test(source)) {
      description = '';
      src = 'Hacker News';
    }
    const url = cleanUrl(link);
    if (!title || !url || !/^https?:/.test(url)) continue;
    const t = Date.parse(published);
    items.push({ title, url, source: src || source, description: description.slice(0, 400), section, kind, publishedAt: Number.isNaN(t) ? null : new Date(t).toISOString(), traffic });
  }
  return items;
}

/** Backwards-compatible helper (RSS only). */
export function parseRss(xml, source) {
  return parseFeed(xml, { source });
}

function feedList(value, defaults) {
  const list = value && value.trim() ? value.split(',') : defaults;
  return list
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^([a-z_-]+)\|(https?:.*)$/i);
      return m ? { section: m[1].toLowerCase(), url: m[2] } : { section: 'news', url: s };
    });
}

export const normTitle = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Fetch topic candidates from all configured feeds in parallel.
 * Env: NEWS_FEEDS, TRENDS_FEEDS (comma-separated URLs, optional "section|" prefix; "none" disables a group),
 * NEWS_DISABLED=true (no network at all), NEWS_TIMEOUT_MS (default 8000), NEWS_PER_FEED (default 20).
 */
export async function fetchTopics(env = process.env, log = () => {}) {
  if ((env.NEWS_DISABLED ?? '').trim().toLowerCase() === 'true') return { items: [], report: [] };
  const timeout = Number(env.NEWS_TIMEOUT_MS) || 8000;
  const perFeed = Number(env.NEWS_PER_FEED) || 20;
  const off = (v) => (v ?? '').trim().toLowerCase() === 'none';
  const news = off(env.NEWS_FEEDS) ? [] : feedList(env.NEWS_FEEDS, DEFAULT_NEWS_FEEDS).map((f) => ({ ...f, kind: 'news' }));
  const trends = off(env.TRENDS_FEEDS) ? [] : feedList(env.TRENDS_FEEDS, DEFAULT_TRENDS_FEEDS).map((f) => ({ ...f, kind: 'trend' }));
  const feeds = [...news, ...trends];
  const results = await Promise.allSettled(
    feeds.map(async (f) => {
      const res = await fetch(f.url, {
        signal: AbortSignal.timeout(timeout),
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; taiku.app content bot; +https://taiku.app)',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const host = new URL(f.url).hostname.replace(/^(www|feeds|rss)\./, '');
      const source = SOURCE_NAMES[host] ?? host;
      return parseFeed(await res.text(), { source, section: f.section, kind: f.kind }).slice(0, perFeed);
    }),
  );
  const items = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  const report = [];
  results.forEach((r, i) => {
    const f = feeds[i];
    if (r.status === 'rejected') {
      const msg = String(r.reason?.message ?? r.reason).slice(0, 120);
      report.push({ feed: f.url, ok: false, error: msg });
      log(`  ! feed failed: ${f.url} (${msg})`);
      return;
    }
    let kept = 0;
    for (const it of r.value) {
      const nt = normTitle(it.title);
      if (seenUrl.has(it.url) || seenTitle.has(nt)) continue;
      seenUrl.add(it.url);
      seenTitle.add(nt);
      items.push(it);
      kept++;
    }
    report.push({ feed: f.url, ok: true, items: r.value.length, kept });
  });
  return { items, report };
}

/** Offline fixtures for --mock / --dry-run (no network). */
export const FIXTURE_TOPICS = [
  { title: 'Tech giant unveils AI companion that remembers every conversation you have ever had with it', url: 'https://example.com/news/ai-companion', source: 'Example Tech', description: 'The always-on assistant promises "a friend who never forgets".', section: 'tech', kind: 'news' },
  { title: 'Billionaire announces plan to build a private city in the desert with no elected council', url: 'https://example.com/news/private-city', source: 'Example Wire', description: 'Residents would accept a terms-of-service instead of voting.', section: 'business', kind: 'news' },
  { title: 'Study: average person checks their phone 144 times a day', url: 'https://example.com/news/phone-checks', source: 'Example Science', description: 'Researchers tracked 10,000 volunteers for a month.', section: 'science', kind: 'news' },
  { title: 'Four-day work week trial ends with most firms refusing to go back', url: 'https://example.com/news/four-day-week', source: 'Example Business', description: 'Productivity held steady while burnout fell, organisers say.', section: 'business', kind: 'news' },
  { title: 'Top football club sells its stadium naming rights to a crypto app', url: 'https://example.com/news/stadium-crypto', source: 'Example Sport', description: 'Fans protested outside the ground before kick-off.', section: 'sports', kind: 'news' },
  { title: 'Court rules influencers must label filtered photos as "edited"', url: 'https://example.com/news/filter-law', source: 'Example Law', description: 'Fines of up to €50,000 for undisclosed retouching.', section: 'culture', kind: 'news' },
  { title: 'Flooding displaces thousands after record rainfall', url: 'https://example.com/news/flooding', source: 'Example World', description: 'Aid agencies call for urgent support for families who lost their homes.', section: 'world', kind: 'news' },
  { title: 'dopamine fasting', url: 'https://example.com/trends/dopamine-fasting', source: 'Example Trends', description: 'Influencers swear by 24 hours with no screens, music or conversation', section: 'trend', kind: 'trend', traffic: '200K+' },
  { title: 'mars colony waitlist', url: 'https://example.com/trends/mars-waitlist', source: 'Example Trends', description: 'Space company opens a paid waitlist for a one-way trip to Mars', section: 'trend', kind: 'trend', traffic: '100K+' },
  { title: 'Show HN: An app that writes your apology texts for you', url: 'https://example.com/hn/apology-app', source: 'Hacker News', description: '', section: 'tech', kind: 'news' },
];

/** @deprecated kept for older callers */
export const MOCK_HEADLINES = FIXTURE_TOPICS.filter((t) => t.kind === 'news');
export async function fetchHeadlines(env = process.env) {
  return (await fetchTopics(env)).items.filter((t) => t.kind === 'news');
}
