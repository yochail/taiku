// Engagement model: who interacts with a taik (reply / like / quote / repost), and the
// simulated public counts (likes, reposts, views, bookmarks) with a heavy-tailed, X-like shape.
import { ALL_TYPES } from './archetypes.mjs';
import { isSerious } from './behavior.mjs';

const clamp = (x, lo = 0, hi = 0.95) => Math.max(lo, Math.min(hi, x));

export function relationOf(byId, a, b) {
  if (a === b) return 'self';
  const pa = byId.get(a);
  const pb = byId.get(b);
  if (pa?.rivals?.some((r) => r.id === b) || pb?.rivals?.some((r) => r.id === a)) return 'rival';
  if (pa?.allies?.some((r) => r.id === b) || pb?.allies?.some((r) => r.id === a)) return 'ally';
  return 'any';
}

const REL = {
  rival: { reply: 1.9, like: 0.25, repost: 0.05, quote: 2.2 },
  ally: { reply: 1.2, like: 2.2, repost: 2.5, quote: 0.7 },
  any: { reply: 1, like: 1, repost: 1, quote: 1 },
};

/**
 * Per-persona probabilities of reacting to a root taik.
 * actorB/authorB are x_behavior profiles; relevance is 0..1 topic relevance for the actor.
 */
export function interactionProbs({ actorB, author, rel, relevance, archetype, grave }) {
  const base = actorB.activity * (0.35 + 0.65 * relevance) * (0.7 + 0.06 * (author.popularity ?? 5));
  const m = REL[rel] ?? REL.any;
  const vibe = ALL_TYPES[archetype]?.vibe;
  const vibeMult = vibe && actorB.likes_vibe === vibe ? 1.6 : 0.8;
  let reply = actorB.reply_rate * base * m.reply;
  let like = actorB.like_rate * base * m.like * vibeMult;
  let quote = actorB.quote_rate * base * m.quote * (rel === 'rival' ? 0.5 + actorB.dunk_tendency : 1);
  let repost = actorB.repost_rate * base * m.repost;
  if (vibe === 'spicy') reply *= 1 + 0.6 * actorB.dunk_tendency; // hot takes pull replies
  if (grave) {
    const serious = isSerious(actorB);
    reply *= serious ? 0.8 : 0.25;
    quote *= serious ? 0.6 : 0.1;
    repost *= 1.2;
    if (rel === 'rival') like *= 2; // grief isn't a rivalry
  }
  return { reply: clamp(reply * 0.85), like: clamp(like), quote: clamp(quote * 0.6), repost: clamp(repost * 0.7) };
}

/** Standard normal via Box–Muller. */
export function gauss(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}
export const lognormal = (rand, sigma) => Math.exp(sigma * gauss(rand));

/** Reply delay in ms: lognormal, median ~25 min, long tail. */
export const replyDelayMs = (rand) => Math.min(10 * 3600_000, 25 * 60_000 * lognormal(rand, 1.0));

const VIEW_FACTOR = { meme: 1.4, shitpost: 1.35, copypasta: 1.3, hot_take: 1.3, unpopular_opinion: 1.4, poll: 1.25, quote_dunk: 1.25, subtweet: 1.2, pov: 1.25, hear_me_out: 1.15, thread: 1.1, teaching: 0.75, reminder: 0.85, question: 0.85, aphorism: 0.95 };
const LIKE_RATE = { meme: 0.016, shitpost: 0.017, copypasta: 0.014, aphorism: 0.015, pov: 0.015, hot_take: 0.009, unpopular_opinion: 0.008, poll: 0.007, question: 0.008, news_take: 0.01, quote_dunk: 0.013 };
const REPOST_RATIO = { meme: 0.22, shitpost: 0.15, aphorism: 0.16, copypasta: 0.2, thread: 0.14, listicle: 0.18, hot_take: 0.1, news_take: 0.12 };
const BOOKMARK_RATIO = { thread: 0.35, listicle: 0.4, teaching: 0.3, aphorism: 0.15, reminder: 0.18, news_take: 0.08, meme: 0.03, shitpost: 0.02, copypasta: 0.05, poll: 0.01 };
const DUNKY = new Set(['ratio', 'dunk', 'this_you', 'quote_dunk', 'clapback', 'well_actually']);

/**
 * Fill `engagement` for every post in `created` (new posts). `ctx.children(id)` / `ctx.quotes(id)`
 * list in-batch interactions; `ctx.byId` maps personas; `now` in ms.
 */
export function computeEngagement(created, { byId, now, rand, rel }) {
  const postsById = new Map(created.map((p) => [p.id, p]));
  const ratios = new Set();
  const ratioed = new Set();
  const kids = new Map();
  for (const p of created) {
    const parent = p.inReplyTo ?? p.quoteOf;
    if (parent) (kids.get(parent) ?? kids.set(parent, []).get(parent)).push(p);
  }
  const ageSat = (p) => {
    const ageH = Math.max(0.15, (now - Date.parse(p.createdAt)) / 3600_000);
    return 1 - Math.exp(-ageH / 3);
  };
  const interactions = (p) => (kids.get(p.id)?.length ?? 0) + (p.likedBy?.length ?? 0) * 0.5 + (p.repostedBy?.length ?? 0);
  const finish = (p, views, likes, reposts, bookmarks) => {
    likes = Math.max(Math.round(likes), p.likedBy?.length ?? 0);
    reposts = Math.max(Math.round(reposts), p.repostedBy?.length ?? 0);
    views = Math.max(Math.round(views), likes * 8 + 20);
    p.engagement = { likes, reposts, views, bookmarks: Math.max(0, Math.round(bookmarks)) };
  };
  const counts = (p, views) => {
    const lr = (LIKE_RATE[p.type] ?? 0.011) * lognormal(rand, 0.35);
    const likes = views * lr;
    const reposts = likes * (REPOST_RATIO[p.type] ?? 0.08) * lognormal(rand, 0.4);
    const bookmarks = likes * (BOOKMARK_RATIO[p.type] ?? 0.08) * lognormal(rand, 0.5);
    return [likes, reposts, bookmarks];
  };
  const authorViews = (p) => 300 * 1.7 ** (byId.get(p.authorId)?.popularity ?? 5);

  // Process in time order so parents are done before children.
  const order = [...created].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const p of order) {
    const parent = p.inReplyTo ? postsById.get(p.inReplyTo) : null;
    const quoted = p.quoteOf ? postsById.get(p.quoteOf) : null;
    if (p.type === 'thread' && parent && parent.authorId === p.authorId && parent.engagement) {
      const k = 0.5 + 0.15 * rand();
      const v = parent.engagement.views * k;
      finish(p, v, parent.engagement.likes * k * 0.8, parent.engagement.reposts * k * 0.5, parent.engagement.bookmarks * k);
      continue;
    }
    if (parent?.engagement) {
      const r = rel(p.authorId, parent.authorId);
      let views = parent.engagement.views * (0.02 + 0.1 * rand()) * (0.6 + 0.08 * (byId.get(p.authorId)?.popularity ?? 5));
      let [likes, reposts, bookmarks] = counts(p, views);
      likes *= 1.4; // replies under big posts over-index on likes per view
      if (DUNKY.has(p.type) && p.type !== 'clapback' && r !== 'ally' && !parent.inReplyTo && !parent.quoteOf && !ratioed.has(parent.id) && rand() < (r === 'rival' ? 0.4 : 0.12)) {
        ratioed.add(parent.id);
        // the ratio: the dunk out-likes the original
        likes = parent.engagement.likes * (1.1 + 1.5 * rand());
        views = Math.max(views, parent.engagement.views * (0.25 + 0.3 * rand()));
        reposts = likes * 0.06;
        ratios.add(p.id);
      }
      finish(p, views, likes, reposts, bookmarks * 0.3);
      continue;
    }
    // roots and quote-taiks: own audience, heavy tail, scaled by in-feed interactions and age
    let views = authorViews(p) * lognormal(rand, 0.9) * (VIEW_FACTOR[p.type] ?? 1) * (1 + 0.12 * interactions(p)) * ageSat(p);
    if (quoted) views *= 0.6 + 0.4 * rand();
    const [likes, reposts, bookmarks] = counts(p, views);
    finish(p, views, likes, reposts, bookmarks);
  }
  // Quotes and replies feed views back into what they reference.
  for (const p of order) {
    const isRatio = ratios.has(p.id);
    const target = postsById.get(p.quoteOf ?? '') ?? (isRatio ? postsById.get(p.inReplyTo) : null);
    if (!target?.engagement) continue;
    target.engagement.views += Math.round(p.engagement.views * (isRatio ? 0.5 : 0.25));
  }
  return { ratios: [...ratios] };
}
