// Topic picking: filter the feed pool (tragedy, NSFW, injection, duplicates), score items
// (source weight × recency × how many personas care), then pick 3–5 with diversity (MMR over
// topic vectors and feeds). Evergreen fallbacks fill a thin day. Writes content/topics/<date>.json.
import { TOPIC_KEYS } from './data.mjs';
import { isGrave, topicVector } from './themes.mjs';
import { hash8, sha256, tokens } from './pipeline-util.mjs';

export const MIN_TOPICS = 3;
export const MAX_TOPICS = 5;

/** NSFW keywords (feed titles). Reddit over_18 is honoured separately. */
const NSFW = /\b(nsfw|porn\w*|nude\w*|naked|onlyfans|sex\w*|xxx|fetish\w*|erotic\w*|hentai|strip(?:per|club)|escort\w*|boob\w*|horny|nip+les?|genital\w*|gore|gory|beheading|dismember\w*|corpse\w*|not safe for work|you should not open at work)\b/i;
export const isNsfw = (item) => Boolean(item.nsfw) || NSFW.test(item.title ?? '');

const SOURCE_WEIGHT = { curated: 1, community: 0.85, evergreen: 0.5 };
const KIND_BONUS = { news: 1, trend: 1.05, viral: 1.1, evergreen: 1 };

/** Evergreen shitpost topics (no URL) used when the day's pool is thin. */
export const EVERGREEN = [
  { title: 'Monday motivation posts', keys: ['memes', 'culture'] },
  { title: 'Is a hot dog a sandwich', keys: ['memes', 'culture'] },
  { title: 'Inbox zero as a lifestyle', keys: ['tech', 'economy'] },
  { title: 'Gym selfies and the meaning of discipline', keys: ['sports', 'culture'] },
  { title: 'Group chats that never stop', keys: ['memes', 'tech'] },
  { title: 'People who reply-all', keys: ['memes', 'economy'] },
];

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of TOPIC_KEYS) {
    const x = a?.[k] ?? 0;
    const y = b?.[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const jaccard = (a, b) => {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
};

/** Split the pool into kept items and dropped items with a reason. */
export function filterPool(items) {
  const kept = [];
  const dropped = [];
  for (const it of items) {
    const reason = it.injection ? 'injection' : isNsfw(it) ? 'nsfw' : isGrave(it.title) ? 'tragedy' : tokens(it.title).length < 1 ? 'empty' : kept.some((k) => (it.url && k.url === it.url) || jaccard(k.title, it.title) >= 0.6) ? 'duplicate' : null;
    if (reason) dropped.push({ id: it.id, feedId: it.feedId, reason });
    else kept.push(it);
  }
  return { kept, dropped };
}

/** Score kept items. `ref` (ms) anchors recency (defaults to the freshest item, so fixtures work any day). */
export function scorePool(items, personas, { ref } = {}) {
  const times = items.map((i) => Date.parse(i.publishedAt)).filter(Number.isFinite);
  const anchor = ref ?? (times.length ? Math.max(...times) : Date.now());
  const thinkers = personas.filter((p) => (p.kind ?? 'thinker') !== 'news');
  return items.map((it) => {
    const keys = topicVector(`${it.title}`, [it.section].filter((s) => TOPIC_KEYS.includes(s)));
    const sims = thinkers.map((p) => cosine(p.topic_affinity, keys)).sort((a, b) => b - a);
    const top = sims.slice(0, Math.max(3, Math.ceil(sims.length / 6)));
    const care = top.length ? top.reduce((s, v) => s + v, 0) / top.length : 0.5;
    const t = Date.parse(it.publishedAt);
    const ageH = Number.isFinite(t) ? Math.max(0, (anchor - t) / 3.6e6) : 24;
    const recency = Math.max(0.3, Math.exp(-ageH / 36));
    const score = (SOURCE_WEIGHT[it.tier] ?? 0.7) * (KIND_BONUS[it.kind] ?? 1) * recency * (0.4 + care);
    return { ...it, keys, score: Math.round(score * 1000) / 1000 };
  });
}

/** Greedy MMR pick: relevance minus redundancy against already-picked topics (vector + same feed). */
export function pickTopics(scored, n, { lambda = 0.55 } = {}) {
  const pool = [...scored].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const picks = [];
  while (picks.length < n && pool.length) {
    let best = 0;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const red = picks.length ? Math.max(...picks.map((p) => cosine(p.keys, c.keys) + (p.feedId === c.feedId ? 0.3 : 0) + (p.tier === c.tier && c.tier === 'community' ? 0.15 : 0))) : 0;
      const val = c.score - lambda * red * c.score;
      if (val > bestVal) {
        bestVal = val;
        best = i;
      }
    });
    picks.push(pool.splice(best, 1)[0]);
  }
  return picks;
}

export const topicCount = (v) => Math.min(MAX_TOPICS, Math.max(MIN_TOPICS, Number(v) || 4));

/** Full selection: filter → score → MMR, then evergreen fill. Returns { picks, dropped, poolHash }. */
export function selectTopics(items, personas, { n = 4, date, rand = Math.random, prioritizeNews = false } = {}) {
  const { kept, dropped } = filterPool(items);
  const scored = scorePool(kept, personas);
  const count = prioritizeNews ? Math.max(0, Math.min(MAX_TOPICS, n)) : topicCount(n);
  const main = prioritizeNews ? scored.filter((t) => t.tier === 'curated' && t.kind === 'news')
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, count) : [];
  const picks = [...main, ...pickTopics(scored.filter((t) => !main.some((p) => p.id === t.id)), count - main.length)];
  const ever = [...EVERGREEN].sort(() => rand() - 0.5);
  while (picks.length < (prioritizeNews ? count : MIN_TOPICS) && ever.length) {
    const e = ever.shift();
    picks.push({ id: `e${hash8(`${date}:${e.title}`)}`, title: e.title, url: null, domain: '', source: 'Taiku', feedId: 'evergreen', tier: 'evergreen', kind: 'evergreen', section: e.keys[0], publishedAt: null, keys: topicVector(e.title, e.keys), score: 0.2 });
  }
  const poolHash = sha256(items.map((i) => `${i.url}\t${i.title}`).sort().join('\n')).slice(0, 16);
  return { picks: picks.map(publicTopic), dropped, poolHash, kept: scored };
}

/** The shape stored in content/topics/<date>.json and copied into posts' topic{}. */
export function publicTopic(t) {
  return { id: t.id, title: t.title, url: t.url ?? null, source: t.source, domain: t.domain ?? '', feedId: t.feedId, tier: t.tier, kind: t.kind, section: t.section ?? null, publishedAt: t.publishedAt ?? null, score: t.score, keys: t.keys };
}

/** topic{} for a post (schema: id, title, url, source, kind, tier). */
export const postTopic = (t) => ({ id: t.id, title: t.title, url: t.url ?? null, source: t.source, kind: t.kind, tier: t.tier });
