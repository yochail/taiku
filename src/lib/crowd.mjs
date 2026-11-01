// Displayed engagement = real persona engagement + a deterministic, seeded crowd sampled from
// the site's realism/spec.json. Visitor likes (D1, later) add on top.
import { createSampler, loadSpec, SPEC_PATH } from './realism.mjs';

let cached;
export function loadDistribution() {
  if (!cached) {
    cached = loadSpec(SPEC_PATH);
  }
  return cached;
}

const SPICY = { dunk: 1.6, ratio: 1.8, quote_dunk: 1.7, clapback: 1.5, this_you: 1.6, hot_take: 1.4, unpopular_opinion: 1.4, shitpost: 1.3, meme: 1.5, copypasta: 1.3, subtweet: 1.3, news_take: 1.2, poll: 1.1 };
/** 1 (calm) .. ~1.8 (very spicy): post archetype heat. */
export const spiciness = (post) => SPICY[post?.type] ?? 1;

/** Deterministic crowd counters for a post (seeded by post id; popularity × spiciness). */
export function crowdFor(post, author, spec = loadDistribution()) {
  const s = createSampler(spec, `crowd:${post.id}`);
  const e = s.engagement({ popularity: author?.popularity ?? 5, isReply: Boolean(post.inReplyTo) });
  const k = spiciness(post);
  const likes = Math.round(e.likes * k);
  return { likes, reposts: Math.round(e.reposts * k), quotes: e.quotes, views: Math.max(likes * 8, Math.round(e.views * k)), bookmarks: Math.round(likes * 0.04 * s.rand()) };
}

/**
 * Counts shown in the UI. replies = real graph count; quotes = quote-taiks + the crowd's quotes
 * (sampling.engagement.quotes_per_repost), which also count as reposts.
 * Persona reposts = `personaReposts` ∪ authors of plain retaik rows of this post (counted once each).
 * `visitorLikes` is the hook for real viewer likes from the D1 API later (0 for now).
 */
export function displayStats(post, author, { replies = 0, quotes = 0, retaikers = [], visitorLikes = 0 } = {}) {
  const c = crowdFor(post, author);
  const likeBase = post.crowdLikeBase ?? c.likes;
  const repostBase = post.crowdRepostBase ?? c.reposts;
  const allQuotes = quotes + (post.crowdQuoteBase ?? c.quotes);
  return {
    replies,
    quotes: allQuotes,
    likes: (post.personaLikes?.length ?? 0) + likeBase + visitorLikes,
    reposts: new Set([...(post.personaReposts ?? []), ...retaikers]).size + repostBase + allQuotes,
    views: post.views ?? c.views,
    bookmarks: post.bookmarks ?? c.bookmarks,
  };
}

/** Graph counts per post id: replies, quote-taiks and plain-retaik authors. */
export function engagementIndex(posts) {
  const replies = new Map(), quotes = new Map(), retaikers = new Map();
  const add = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const p of posts) {
    if (p.inReplyTo) add(replies, p.inReplyTo);
    if (p.quoteOf) add(quotes, p.quoteOf);
    if (p.retaikOf) retaikers.set(p.retaikOf, [...(retaikers.get(p.retaikOf) ?? []), p.authorId]);
  }
  return (id) => ({ replies: replies.get(id) ?? 0, quotes: quotes.get(id) ?? 0, retaikers: retaikers.get(id) ?? [] });
}

/**
 * Fill `post.stats` (where missing) the way visitors see it: persona engagement + seeded crowd +
 * graph counts. Plain retaik rows get no stats of their own (they display the retaiked post).
 */
export function withDisplayStats(posts, personas) {
  const byP = new Map(personas.map((p) => [p.id, p]));
  const graph = engagementIndex(posts);
  for (const p of posts) if (!p.retaikOf) p.stats ??= displayStats(p, byP.get(p.authorId), graph(p.id));
  return posts;
}
