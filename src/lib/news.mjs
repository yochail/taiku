// Fetch real headlines from public RSS feeds (no key needed). Failures are non-fatal.
const DEFAULT_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  'https://feeds.bbci.co.uk/news/technology/rss.xml',
];

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();

export function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const block = m[0];
    const title = decode(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = decode(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '');
    const description = decode(block.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '');
    if (title && /^https?:\/\//.test(link)) items.push({ title, url: link.split('?')[0], description, source });
  }
  return items;
}

export async function fetchHeadlines(env = process.env) {
  if (env.NEWS_DISABLED === 'true') return [];
  const feeds = (env.NEWS_FEEDS || DEFAULT_FEEDS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const all = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(feed, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'taiku.app generator (+https://taiku.app)' } });
      if (!res.ok) continue;
      const source = new URL(feed).hostname.replace(/^(www|feeds)\./, '');
      all.push(...parseRss(await res.text(), source).slice(0, 15));
    } catch {
      // ignore network errors; news is optional
    }
  }
  return all;
}

export const MOCK_HEADLINES = [
  { title: 'Study finds most people check their phone within minutes of waking', url: 'https://example.com/news/phones', source: 'example.com', description: 'Mock headline for offline runs.' },
  { title: 'City council debates banning cars from historic centre', url: 'https://example.com/news/cars', source: 'example.com', description: 'Mock headline for offline runs.' },
  { title: 'New AI model passes professional ethics exam', url: 'https://example.com/news/ai-ethics', source: 'example.com', description: 'Mock headline for offline runs.' },
];
