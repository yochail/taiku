// Displayed engagement = real persona engagement + a deterministic, seeded crowd sampled from
// realism/spec.json (via config/distribution.json). Visitor likes (D1, later) add on top.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './data.mjs';
import { createSampler, loadSpec } from './realism.mjs';

let cached;
export function loadDistribution() {
  if (!cached) {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'distribution.json'), 'utf8'));
    cached = loadSpec(path.join(ROOT, cfg.spec));
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
 * `visitorLikes` is the hook for real viewer likes from the D1 API later (0 for now).
 */
export function displayStats(post, author, { replies = 0, quotes = 0, visitorLikes = 0 } = {}) {
  const c = crowdFor(post, author);
  const likeBase = post.crowdLikeBase ?? c.likes;
  const repostBase = post.crowdRepostBase ?? c.reposts;
  const allQuotes = quotes + (post.crowdQuoteBase ?? c.quotes);
  return {
    replies,
    quotes: allQuotes,
    likes: (post.personaLikes?.length ?? 0) + likeBase + visitorLikes,
    reposts: (post.personaReposts?.length ?? 0) + repostBase + allQuotes,
    views: post.views ?? c.views,
    bookmarks: post.bookmarks ?? c.bookmarks,
  };
}

/** Fill `post.stats` (where missing) the way visitors see it: persona engagement + seeded crowd + quote counts. */
export function withDisplayStats(posts, personas) {
  const byP = new Map(personas.map((p) => [p.id, p]));
  const quoteN = new Map();
  for (const p of posts) if (p.quoteOf) quoteN.set(p.quoteOf, (quoteN.get(p.quoteOf) ?? 0) + 1);
  for (const p of posts) p.stats ??= displayStats(p, byP.get(p.authorId), { quotes: quoteN.get(p.id) ?? 0 });
  return posts;
}
