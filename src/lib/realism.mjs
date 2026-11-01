// Network-realism: measure a corpus against realism/spec.json and sample generator choices from it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './data.mjs';
import { rng as makeRng } from './util.mjs';
import { renderProblems } from './media.mjs';

export const SPEC_PATH = path.join(ROOT, 'realism', 'spec.json');
export const VISUAL_KINDS = new Set(['image', 'gif', 'meme', 'chart', 'video']);
const MINUTE = 60_000;

export function loadSpec(file = SPEC_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------- stats helpers ----------

export function gini(values) {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  const n = xs.length;
  const sum = xs.reduce((s, v) => s + v, 0);
  if (n === 0 || sum === 0) return 0;
  let weighted = 0;
  xs.forEach((v, i) => { weighted += (i + 1) * v; });
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

export function quantile(values, q) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pos = (xs.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export const median = (values) => quantile(values, 0.5);

/** Goh–Barabási burstiness of inter-event gaps: -1 periodic, 0 Poisson, →1 bursty. */
export function burstiness(gaps) {
  if (gaps.length < 2) return null;
  const mu = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  const sigma = Math.sqrt(gaps.reduce((s, v) => s + (v - mu) ** 2, 0) / gaps.length);
  return sigma + mu === 0 ? null : (sigma - mu) / (sigma + mu);
}

export function totalVariation(countsA, weightsB) {
  const sa = countsA.reduce((s, v) => s + v, 0);
  const sb = weightsB.reduce((s, v) => s + v, 0);
  if (!sa || !sb) return null;
  return countsA.reduce((s, v, i) => s + Math.abs(v / sa - weightsB[i] / sb), 0) / 2;
}

const share = (num, den) => (den ? num / den : null);
const charLen = (text) => [...String(text ?? '')].length;
const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/u;
const EMOJI = /\p{Extended_Pictographic}/u;

export function localHour(iso, timeZone) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso));
  return Number(h) % 24;
}

// ---------- post classification ----------

/** original | reply | quote | thread_part (self-thread continuation, counted with its root). */
export function classify(post, byId) {
  if (post.quoteOf || post.type === 'quote_post') return 'quote';
  if (post.inReplyTo) {
    const parent = byId.get(post.inReplyTo);
    if (parent && parent.authorId === post.authorId && post.type === 'thread') return 'thread_part';
    return 'reply';
  }
  return 'original';
}

export function mediaOf(post) {
  if (Array.isArray(post.media)) return post.media.filter(Boolean);
  return post.media ? [post.media] : [];
}

const EMOJI_JUNK = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\s\p{P}]/gu;

/** Shape of a post: emoji_only | few_words | gif_only | meme_only | image_only | media_only | short | full. */
export function replyFormOf(post) {
  const text = String(post.text ?? '').trim();
  if (!text) {
    const kinds = mediaOf(post).map((m) => m.kind);
    for (const k of ['gif', 'meme', 'image']) if (kinds.includes(k)) return `${k}_only`;
    return 'media_only';
  }
  if (EMOJI.test(text) && !text.replace(EMOJI_JUNK, '')) return 'emoji_only';
  const len = charLen(text);
  const words = text.replace(EMOJI_JUNK, ' ').trim().split(/\s+/).filter(Boolean).length;
  if (words <= 3 && len <= 25) return 'few_words';
  return len <= 40 ? 'short' : 'full';
}

/** Hard safety/attribution rules for one media item. Returns a list of problems. */
export function mediaProblems(item, policy) {
  const out = [];
  const kinds = new Set(policy.kinds);
  if (!kinds.has(item.kind)) out.push(`unknown media kind "${item.kind}"`);
  const needsSrc = VISUAL_KINDS.has(item.kind);
  if (needsSrc && !item.src) out.push(`${item.kind} without src`);
  if (needsSrc && !String(item.alt ?? '').trim()) out.push(`${item.kind} without alt text`);
  if (item.kind === 'poll' && !(Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 4)) {
    out.push('poll needs 2-4 options');
  }
  if (item.kind === 'link_card' && !/^https:\/\//.test(item.url ?? '')) out.push('link_card needs an https url');
  if (item.src) {
    if (/^https?:\/\//i.test(item.src)) {
      let host = '';
      try {
        const u = new URL(item.src);
        host = u.hostname;
        if (u.protocol !== 'https:') out.push(`non-https src ${item.src}`);
      } catch { out.push(`bad src ${item.src}`); }
      if (host && !policy.allowed_remote_hosts.includes(host)) out.push(`remote host not allowlisted: ${host}`);
      if (!/\.(png|jpe?g|gif|webp|svg|mp4|webm)(\?.*)?$/i.test(item.src)) out.push(`remote src is not a media file: ${item.src}`);
    } else if (!item.src.startsWith('/')) out.push(`src must be site-absolute or https: ${item.src}`);
  }
  const thirdParty = item.origin && !['local-render', 'ai'].includes(item.origin);
  if ((thirdParty || /^https?:\/\//i.test(item.src ?? '')) && !(item.credit?.author && item.credit?.license && item.credit?.url)) {
    out.push('third-party media without credit {author, license, url}');
  }
  if (item.origin === 'ai' && item.ai_generated !== true) out.push('AI image without ai_generated: true');
  if (item.origin === 'giphy') {
    if (!item.giphy_id) out.push('GIPHY media without giphy_id');
    const attribution = policy.giphy?.attribution ?? 'Powered by GIPHY';
    if (item.attribution !== attribution) out.push(`GIPHY media without attribution "${attribution}"`);
    if (!/^https:\/\/media\d?\.giphy\.com\//.test(item.src ?? '')) out.push('GIPHY media must be served from media*.giphy.com');
  }
  if (item.render) out.push(...renderProblems(item));
  if (needsSrc) {
    const ratings = policy.ratings;
    const r = item.rating ?? 'unrated';
    if (!ratings.includes(r) || ratings.indexOf(r) > ratings.indexOf(policy.max_rating)) out.push(`rating "${r}" not allowed`);
  }
  return out;
}

// ---------- measurement ----------

/**
 * Compute every metric in the spec. Returns { metricId: { value, n, detail? } }.
 * Optional post fields used when present: media[], stats { likes, reposts, quotes, views }.
 */
export function measure(allPosts, personas, spec) {
  // Plain retaiks are not authored content; they are only counted.
  const retaiks = allPosts.filter((p) => p.retaikOf);
  const posts = allPosts.filter((p) => !p.retaikOf);
  const byId = new Map(posts.map((p) => [p.id, p]));
  const cls = new Map(posts.map((p) => [p.id, classify(p, byId)]));
  const of = (role) => posts.filter((p) => cls.get(p.id) === role);
  const originals = of('original');
  const replies = of('reply');
  const quotes = of('quote');
  const authored = originals.length + replies.length + quotes.length;
  const m = {};
  const set = (id, value, n, detail) => { m[id] = { value, n, ...(detail ? { detail } : {}) }; };

  set('activity.original_share', share(originals.length, authored), authored);
  set('activity.reply_share', share(replies.length, authored), authored);
  set('activity.quote_share', share(quotes.length, authored), authored);

  // media
  // A news link renders as a link card, so it counts as one.
  const kindsOf = (p) => [...mediaOf(p).map((x) => x.kind), ...(p.news?.url ? ['link_card'] : [])];
  const hasVisual = (p) => kindsOf(p).some((k) => VISUAL_KINDS.has(k));
  set('media.original.visual_share', share(originals.filter(hasVisual).length, originals.length), originals.length);
  set('media.original.link_card_share', share(originals.filter((p) => kindsOf(p).includes('link_card')).length, originals.length), originals.length);
  set('media.original.poll_share', share(originals.filter((p) => kindsOf(p).includes('poll')).length, originals.length), originals.length);
  set('media.reply.visual_share', share(replies.filter(hasVisual).length, replies.length), replies.length);
  const visualItems = posts.flatMap((p) => mediaOf(p)).filter((x) => VISUAL_KINDS.has(x.kind));
  set('media.gif_share_of_visual', share(visualItems.filter((x) => x.kind === 'gif').length, visualItems.length), visualItems.length);
  const gifs = visualItems.filter((x) => x.kind === 'gif');
  set('media.gif.giphy_share', share(gifs.filter((x) => x.origin === 'giphy').length, gifs.length), gifs.length);
  const problems = [];
  for (const p of posts) for (const item of mediaOf(p)) for (const pr of mediaProblems(item, spec.media_policy)) problems.push(`${p.id}: ${pr}`);
  set('media.safety_violations', problems.length, posts.length, problems.slice(0, 20));

  // length (media-only posts have no text and are left out)
  const lens = posts.map((p) => charLen(p.text)).filter((l) => l > 0);
  const over = posts.filter((p) => charLen(p.text) > 280).map((p) => `${p.id} (${charLen(p.text)})`);
  set('length.max_chars', lens.length ? Math.max(...lens) : null, lens.length, over.slice(0, 20));
  set('length.median_chars', median(lens), lens.length);
  set('length.short_share', share(lens.filter((l) => l <= 40).length, lens.length), lens.length);
  set('length.over_140_share', share(lens.filter((l) => l > 140).length, lens.length), lens.length);
  set('length.near_limit_share', share(lens.filter((l) => l >= 261).length, lens.length), lens.length);

  // threads: thread_part edges add 0 depth and are not counted as replies
  const kids = new Map();
  for (const p of posts) if (p.inReplyTo && byId.has(p.inReplyTo)) {
    if (!kids.has(p.inReplyTo)) kids.set(p.inReplyTo, []);
    kids.get(p.inReplyTo).push(p);
  }
  const walk = (p, depth, acc, seen) => {
    for (const c of kids.get(p.id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const isPart = cls.get(c.id) === 'thread_part';
      const d = depth + (isPart ? 0 : 1);
      if (!isPart) acc.count++;
      acc.depth = Math.max(acc.depth, d);
      walk(c, d, acc, seen);
    }
    return acc;
  };
  const roots = posts.filter((p) => !p.inReplyTo);
  const trees = roots.map((r) => walk(r, 0, { count: 0, depth: 0 }, new Set([r.id])));
  const convos = trees.filter((t) => t.count > 0);
  set('threads.zero_reply_root_share', share(trees.filter((t) => t.count === 0).length, trees.length), trees.length);
  set('threads.depth1_share_of_conversations', share(convos.filter((t) => t.depth === 1).length, convos.length), convos.length);
  set('threads.deep_share_of_conversations', share(convos.filter((t) => t.depth >= 4).length, convos.length), convos.length);
  set('threads.replies_per_root_gini', trees.length ? gini(trees.map((t) => t.count)) : null, trees.length);

  // authors and reply graph
  const counts = new Map(personas.map((p) => [p.id, 0]));
  for (const p of posts) if (cls.get(p.id) !== 'thread_part') counts.set(p.authorId, (counts.get(p.authorId) ?? 0) + 1);
  const cv = [...counts.values()].sort((a, b) => b - a);
  const total = cv.reduce((s, v) => s + v, 0);
  set('authors.posts_gini', cv.length ? gini(cv) : null, total);
  set('authors.top20_share', share(cv.slice(0, Math.max(1, Math.ceil(cv.length * 0.2))).reduce((s, v) => s + v, 0), total), total);
  const inDeg = new Map(personas.map((p) => [p.id, 0]));
  const edges = new Set();
  for (const r of replies) {
    const parent = byId.get(r.inReplyTo);
    if (!parent || parent.authorId === r.authorId) continue;
    inDeg.set(parent.authorId, (inDeg.get(parent.authorId) ?? 0) + 1);
    edges.add(`${r.authorId}>${parent.authorId}`);
  }
  set('authors.reply_in_degree_gini', inDeg.size ? gini([...inDeg.values()]) : null, replies.length);
  const recip = [...edges].filter((e) => { const [a, b] = e.split('>'); return edges.has(`${b}>${a}`); }).length;
  set('graph.reply_reciprocity', share(recip, edges.size), edges.size);

  // time
  const tz = spec.reference_timezone ?? 'UTC';
  const timed = posts.filter((p) => !Number.isNaN(Date.parse(p.createdAt)));
  const hours = new Array(24).fill(0);
  for (const p of timed) hours[localHour(p.createdAt, tz)]++;
  set('time.diurnal_tvd', totalVariation(hours, spec.sampling.diurnal_local.weights), timed.length, hours);
  set('time.round_minute_share', share(timed.filter((p) => new Date(p.createdAt).getUTCMinutes() % 5 === 0).length, timed.length), timed.length);
  const byAuthor = new Map();
  for (const p of timed) {
    if (!byAuthor.has(p.authorId)) byAuthor.set(p.authorId, []);
    byAuthor.get(p.authorId).push(Date.parse(p.createdAt));
  }
  const bs = [];
  for (const ts of byAuthor.values()) {
    if (ts.length < 8) continue;
    ts.sort((a, b) => a - b);
    const b = burstiness(ts.slice(1).map((t, i) => (t - ts[i]) / MINUTE));
    if (b !== null) bs.push(b);
  }
  set('time.burstiness_median', median(bs), bs.length);
  const delays = [];
  const early = [];
  for (const p of timed) {
    for (const refId of [p.inReplyTo, p.quoteOf]) {
      const parent = refId && byId.get(refId);
      if (!parent || Number.isNaN(Date.parse(parent.createdAt))) continue;
      const d = (Date.parse(p.createdAt) - Date.parse(parent.createdAt)) / MINUTE;
      if (d < 0) early.push(`${p.id} before ${parent.id}`);
      if (refId === p.inReplyTo && cls.get(p.id) === 'reply') delays.push(d);
    }
  }
  for (const r of retaiks) {
    const parent = byId.get(r.retaikOf);
    if (parent && Date.parse(r.createdAt) < Date.parse(parent.createdAt)) early.push(`${r.id} (retaik) before ${parent.id}`);
  }
  set('time.reply_delay_median_min', median(delays), delays.length);
  set('time.replies_before_parent', early.length, timed.length, early.slice(0, 20));

  // text
  set('text.hashtag_share', share(posts.filter((p) => HASHTAG.test(p.text ?? '')).length, posts.length), posts.length);
  set('text.emoji_share', share(posts.filter((p) => EMOJI.test(p.text ?? '')).length, posts.length), posts.length);

  // reply forms
  const replyForms = replies.map(replyFormOf);
  const rf = (...forms) => share(replyForms.filter((f) => forms.includes(f)).length, replyForms.length);
  set('reply_form.reply.emoji_only_share', rf('emoji_only'), replies.length);
  set('reply_form.reply.few_words_share', rf('few_words'), replies.length);
  set('reply_form.reply.media_only_share', rf('gif_only', 'meme_only', 'image_only', 'media_only'), replies.length);
  set('reply_form.reply.short_share', rf('short'), replies.length);
  set('reply_form.reply.full_share', rf('full'), replies.length);
  const quoteForms = quotes.map(replyFormOf);
  set('reply_form.quote.minimal_share', share(quoteForms.filter((f) => f === 'emoji_only' || f === 'few_words').length, quoteForms.length), quotes.length);
  set('retaik.per_authored', authored ? retaiks.length / authored : null, authored);

  // engagement (only when the corpus carries stats)
  const withStats = posts.filter((p) => p.stats && Number.isFinite(p.stats.likes));
  const likes = withStats.map((p) => p.stats.likes);
  set('engagement.likes_gini', withStats.length ? gini(likes) : null, withStats.length);
  const sortedLikes = [...likes].sort((a, b) => b - a);
  const likeSum = likes.reduce((s, v) => s + v, 0);
  set('engagement.top10_like_share', share(sortedLikes.slice(0, Math.max(1, Math.ceil(likes.length * 0.1))).reduce((s, v) => s + v, 0), likeSum), withStats.length);
  const lpr = withStats.filter((p) => p.stats.reposts > 0).map((p) => p.stats.likes / p.stats.reposts);
  set('engagement.likes_per_repost_median', median(lpr), lpr.length);
  const qpr = withStats.filter((p) => p.stats.reposts > 0 && Number.isFinite(p.stats.quotes)).map((p) => p.stats.quotes / p.stats.reposts);
  set('engagement.quotes_per_repost_median', median(qpr), qpr.length);

  return m;
}

/** Compare measurements with spec ranges. status: pass | warn | fail | skip. */
export function evaluate(measured, spec) {
  return Object.entries(spec.metrics).map(([id, t]) => {
    const r = measured[id] ?? { value: null, n: 0 };
    let status;
    if (r.value === null || r.value === undefined || Number.isNaN(r.value)) status = 'skip';
    else if (t.min_n && r.n < t.min_n) status = 'skip';
    else status = r.value >= t.min && r.value <= t.max ? 'pass' : (t.severity ?? 'warn');
    return { id, status, value: r.value, n: r.n, min: t.min, max: t.max, target: t.target, min_n: t.min_n ?? 0, confidence: t.confidence, detail: r.detail };
  });
}

export function checkCorpus(posts, personas, spec = loadSpec()) {
  const results = evaluate(measure(posts, personas, spec), spec);
  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, summary: { pass: count('pass'), warn: count('warn'), fail: count('fail'), skip: count('skip') } };
}

// ---------- sampling (for the generator) ----------

function weighted(rand, entries) {
  const list = entries.filter(([k, w]) => !k.startsWith('_') && typeof w === 'number' && w > 0);
  const total = list.reduce((s, [, w]) => s + w, 0);
  let x = rand() * total;
  for (const [k, w] of list) { x -= w; if (x <= 0) return k; }
  return list[list.length - 1][0];
}

/** terse | punchy | balanced | discursive. persona.reply_style wins, then the spec map, then balanced. */
export function personaReplyStyle(spec, persona) {
  const rf = spec.sampling.reply_forms;
  const id = typeof persona === 'string' ? persona : persona?.id;
  const own = typeof persona === 'object' ? persona?.reply_style : undefined;
  const style = own ?? rf.persona_style[id] ?? 'balanced';
  return rf.persona_styles[style] ? style : 'balanced';
}

/** Deterministic sampler over spec.sampling. */
export function createSampler(spec = loadSpec(), seed = 'taiku') {
  const rand = makeRng(seed);
  const s = spec.sampling;
  const normal = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const lognormal = ({ median: med, sigma }) => med * Math.exp(sigma * normal());
  return {
    rand,
    /** 'original' | 'reply' | 'quote' */
    activity: () => weighted(rand, Object.entries(s.activity)),
    /** media kind for a role, or 'none' */
    mediaKind: (role = 'original') => weighted(rand, Object.entries(s.media[role] ?? s.media.original)),
    /** { min, max } character range to ask the LLM for (never truncate to fit) */
    lengthRange: () => {
      const i = Number(weighted(rand, s.length_chars.buckets.map((b, idx) => [String(idx), b[2]])));
      const [min, max] = s.length_chars.buckets[i];
      return { min, max };
    },
    /** local hour 0-23 in spec.reference_timezone */
    localHour: () => Number(weighted(rand, s.diurnal_local.weights.map((w, h) => [String(h), w]))),
    /** minute offset with no :00/:05 clustering */
    minute: () => Math.floor(rand() * 60),
    replyDelayMinutes: () => Math.max(1, Math.min(s.reply_delay_minutes.max, Math.round(lognormal(s.reply_delay_minutes.lognormal)))),
    /** simulated counters; popularity 1-10 (persona.popularity), isReply lowers reach */
    engagement: ({ popularity = 5, isReply = false } = {}) => {
      const e = s.engagement;
      const likes = Math.max(0, Math.round(lognormal(e.likes_lognormal) * (popularity / 5) * (isReply ? e.reply_factor : 1)));
      const reposts = Math.round(likes * lognormal(e.reposts_per_like));
      const quotes = Math.round(reposts * lognormal(e.quotes_per_repost));
      const views = Math.round(likes * lognormal(e.views_per_like)) + 20;
      return { likes, reposts, quotes, views };
    },
    /** 'giphy' | 'local' source for a sampled gif */
    gifSource: () => weighted(rand, Object.entries(s.gif_sources ?? { local: 1 })),
    /**
     * Shape of a reply or quote, biased by the persona's style.
     * Returns { form, chars: { min, max }, maxWords?, media? }. A form with media has empty text;
     * for text forms the generator may still call mediaKind(role).
     */
    replyForm: (role = 'reply', persona = null) => {
      const rf = s.reply_forms;
      const base = rf[role] ?? rf.reply;
      const style = personaReplyStyle(spec, persona);
      const mult = rf.persona_styles[style] ?? {};
      const form = weighted(rand, Object.entries(base).map(([k, w]) => [k, w * (mult[k] ?? 1)]));
      const def = rf.forms[form];
      let [min, max] = def.chars;
      if (form === 'full') {
        const buckets = s.length_chars.buckets.filter(([lo]) => lo > 40);
        const i = Number(weighted(rand, buckets.map((b, idx) => [String(idx), b[2]])));
        [min, max] = buckets[i];
      }
      return { form, style, chars: { min, max }, ...(def.max_words ? { maxWords: def.max_words } : {}), ...(def.media ? { media: def.media } : {}) };
    },
    /** how many plain retaiks to emit for a batch of `authored` new posts */
    retaikCount: (authored) => {
      const mean = authored * (s.retaik?.per_authored ?? 0);
      let n = Math.floor(mean);
      if (rand() < mean - n) n++;
      return n;
    },
    wantsHashtag: () => rand() < s.hashtag_probability,
    wantsEmoji: () => rand() < s.emoji_probability,
  };
}
