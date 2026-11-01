// react.mjs — cheap, non-LLM, non-deterministic-but-replayable reaction model.
//
// For every candidate persona × post:
//   score = reactivity × affinity × relation × popularity × recency × depth × fatigue × mention
//     reactivity = persona.reactivity / 3                              (1-5 → 0.33-1.67)
//     affinity   = max(0.15, cosine(persona.topic_affinity, post topic vector))
//     relation   = rival 3 · frenemy 2.5 · ally 2 · follows-author 1.5 · else 1
//     popularity = (0.5 + ln(1 + followers/1e4)/ln 101) × (1 + 0.3·ln(1 + engagement so far))  (rich get richer)
//     recency    = exp(−hours between post and would-be reaction / 12)
//     depth      = 0.6^depth (reply depth in the thread)
//     fatigue    = max(0, 1 − actions used today / daily budget), budget = round(4 + 36·x_behavior.activity)
//     mention    = 5 if the post @mentions the persona (id/handle), quotes them, or replies to them
//   p = 1 − exp(−k·score), Bernoulli draw with a RNG seeded by (date, nonce).
// If it fires, the action is sampled from the persona's propensities (x_behavior like/repost/
// reply/quote rates × global multipliers LIKE_BOOST / rTilt / 1 / qTilt) tilted by the relation
// (beef → reply/quote, allies → like/retaik). k, qTilt and rTilt are CALIBRATED by bisection on
// simulated days so the authored mix matches realism/spec.json (sampling.activity) and persona
// likes/retaik ≈ 1 / sampling.engagement.reposts_per_like.median. Reply/quote need an LLM call and
// are capped per day; when the cap is hit they downgrade to a like (logged as capped).
// Every reaction logs its terms, score, p, draw and action — debug only, never in post objects.
import fs from 'node:fs';
import path from 'node:path';
import { TOPIC_KEYS } from './data.mjs';
import { behaviorOf } from './behavior.mjs';
import { createSampler } from './realism.mjs';
import { cosine } from './topics.mjs';
import { clamp, round3, seededRng, sha256, shuffle, weightedPick } from './pipeline-util.mjs';

export const LIKE_BOOST = 6;
export const MAX_DEPTH = 9;
export const RELATION_WEIGHT = { rival: 3, frenemy: 2.5, ally: 2, follows: 1.5 };
const TILT = {
  rival: { like: 0.3, repost: 0.1, reply: 2.5, quote: 2.5 },
  frenemy: { like: 0.8, repost: 0.5, reply: 1.8, quote: 1.8 },
  ally: { like: 2, repost: 2, reply: 1, quote: 0.7 },
};
export const ACTIONS = ['like', 'repost', 'reply', 'quote'];
export const DEFAULT_CALIBRATION = { k: 0.05, qTilt: 1, rTilt: 0.3 };

const isNews = (p) => (p.kind ?? 'thinker') === 'news';

/** Strongest relation between two personas (either direction): rival > frenemy > ally > null. */
export function relationOf(a, b) {
  if (!a || !b) return null;
  const has = (p, list, id) => (p[list] ?? []).some((r) => r.id === id);
  for (const rel of ['rival', 'frenemy', 'ally']) {
    const list = `${rel === 'ally' ? 'allies' : rel === 'rival' ? 'rivals' : 'frenemies'}`;
    if (has(a, list, b.id) || has(b, list, a.id)) return rel;
  }
  return null;
}

/** Synthetic, stable follow graph (no date): P(a follows b) ≈ 0.1 + 0.05·popularity(b); relations always follow. */
export function follows(a, b) {
  if (relationOf(a, b)) return true;
  const u = parseInt(sha256(`follow:${a.id}>${b.id}`).slice(0, 8), 16) / 0xffffffff;
  return u < 0.1 + 0.05 * clamp(b.popularity ?? 5, 1, 10);
}

export const dailyBudget = (persona) => Math.round(4 + 36 * clamp(behaviorOf(persona).activity ?? 0.5, 0, 1));

const followersOf = (p) => p?.x_profile?.followers ?? Math.round(1e4 * 2 ** (p?.popularity ?? 5));

/** Mentioned persona ids in a text (@id or @handle, case-insensitive). */
export function mentionsIn(text, personas) {
  const out = new Set();
  const t = String(text ?? '').toLowerCase();
  for (const m of t.matchAll(/@([a-z0-9_]{1,30})/g)) {
    const p = personas.find((x) => x.id.toLowerCase() === m[1] || String(x.handle).toLowerCase() === m[1]);
    if (p) out.add(p.id);
  }
  return out;
}

/**
 * Reactor: holds per-day state (fatigue, LLM cap, log). Deterministic for (seed, nonce).
 * @param {object} o { personas, spec, seed, nonce, calibration, llmCap }
 */
export function createReactor({ personas, spec, seed, nonce = '', calibration = DEFAULT_CALIBRATION, llmCap = Infinity, log = true, formFn = null, affinityFn = null }) {
  const rand = seededRng('react', seed, nonce);
  const sampler = createSampler(spec, `react:${seed}:${nonce}`);
  const byId = new Map(personas.map((p) => [p.id, p]));
  const used = new Map(personas.map((p) => [p.id, 0]));
  const budget = new Map(personas.map((p) => [p.id, dailyBudget(p)]));
  const beh = new Map(personas.map((p) => [p.id, behaviorOf(p)]));
  const followMemo = new Map();
  const reactors = personas.filter((p) => !isNews(p));
  const reactions = [];
  let llmUsed = 0;
  const { k, qTilt, rTilt } = { ...DEFAULT_CALIBRATION, ...calibration };

  const followsMemo = (a, b) => {
    const key = `${a.id}>${b.id}`;
    if (!followMemo.has(key)) followMemo.set(key, follows(a, b));
    return followMemo.get(key);
  };

  function terms(persona, post, delayMin) {
    const author = byId.get(post.authorId);
    const rel = relationOf(persona, author);
    const relation = rel ? RELATION_WEIGHT[rel] : author && followsMemo(persona, author) ? RELATION_WEIGHT.follows : 1;
    const eng = post.likes.length + post.reposts.length + (post.replies ?? 0) + (post.quotes ?? 0);
    const popularity = (0.5 + Math.log(1 + followersOf(author) / 1e4) / Math.log(101)) * (1 + 0.3 * Math.log(1 + eng));
    const mentioned = post.mentions?.has(persona.id);
    // Embedding affinity arrives as a mean-1 multiplier (cosine of post and persona-interest
    // embeddings, centred per persona) so the calibrated volume (k) stays valid; null → topic cosine only.
    const base = Math.max(0.15, cosine(persona.topic_affinity, post.vector));
    const emb = affinityFn ? affinityFn(persona, post) : null;
    return {
      reactivity: clamp(persona.reactivity ?? 3, 1, 5) / 3,
      affinity: emb == null ? base : Math.max(0.15, base * emb),
      relation,
      popularity,
      recency: Math.exp(-delayMin / 60 / 12),
      depth: 0.6 ** (post.depth ?? 0),
      fatigue: Math.max(0, 1 - used.get(persona.id) / budget.get(persona.id)),
      mention: mentioned ? 5 : 1,
      rel: rel ?? (relation > 1 ? 'follows' : null),
    };
  }

  function chooseAction(persona, rel, mentioned, depth) {
    const b = beh.get(persona.id);
    const t = TILT[rel] ?? { like: 1, repost: 1, reply: 1, quote: 1 };
    const w = {
      like: (b.like_rate ?? 0.3) * LIKE_BOOST * t.like,
      repost: (b.repost_rate ?? 0.15) * rTilt * t.repost,
      reply: (b.reply_rate ?? 0.3) * t.reply * (mentioned && rel !== 'ally' ? 2 : 1) * (depth >= MAX_DEPTH ? 0 : 1),
      quote: (b.quote_rate ?? 0.15) * qTilt * t.quote,
    };
    return weightedPick(rand, ACTIONS.map((a) => [a, w[a]])) ?? 'like';
  }

  /**
   * Evaluate every candidate for one post. Mutates post.likes/reposts and fatigue; returns new
   * reply/quote events [{ personaId, action, at }]. `post`: { id, authorId, createdAt(ms), vector,
   * depth, mentions:Set, likes:[], reposts:[], replies, quotes, noReply? }.
   */
  function consider(post, { horizon = Infinity, exclude = new Set() } = {}) {
    const out = [];
    for (const persona of shuffle(rand, reactors)) {
      if (persona.id === post.authorId || exclude.has(persona.id)) continue;
      const delayMin = sampler.replyDelayMinutes();
      const tm = terms(persona, post, delayMin);
      const score = tm.reactivity * tm.affinity * tm.relation * tm.popularity * tm.recency * tm.depth * tm.fatigue * tm.mention;
      const p = 1 - Math.exp(-k * score);
      const draw = rand();
      if (!(draw < p)) continue;
      let action = chooseAction(persona, tm.rel, tm.mention > 1, post.depth ?? 0);
      let capped = false;
      const at = post.createdAt + delayMin * 60000 + Math.floor(rand() * 60000);
      // Reply form (emoji-only, few words, GIF-only, … short, full): cheap forms come from pools and
      // don't count toward the LLM cap.
      let form = null;
      if ((action === 'reply' || action === 'quote') && formFn && !(at > horizon || post.noReply)) form = formFn(persona, action, post, tm.rel);
      const cheap = Boolean(form?.cheap);
      if ((action === 'reply' || action === 'quote') && ((!cheap && llmUsed >= llmCap) || at > horizon || post.noReply)) {
        capped = true;
        action = 'like';
      }
      used.set(persona.id, used.get(persona.id) + 1);
      if (action === 'like') post.likes.push(persona.id);
      else if (action === 'repost') post.reposts.push(persona.id);
      else {
        if (!cheap) llmUsed++;
        if (action === 'reply') post.replies = (post.replies ?? 0) + 1;
        else post.quotes = (post.quotes ?? 0) + 1;
        out.push({ personaId: persona.id, action, at, rel: tm.rel, ...(form ? { form: form.form, cheap } : {}) });
      }
      if (log) {
        reactions.push({
          postId: post.id,
          personaId: persona.id,
          action,
          ...(capped ? { capped: true } : {}),
          ...(form && action !== 'like' && action !== 'repost' ? { form: form.form } : {}),
          terms: Object.fromEntries(Object.entries(tm).filter(([key]) => key !== 'rel').map(([key, v]) => [key, round3(v)])),
          rel: tm.rel,
          delayMin,
          score: round3(score),
          // Unrounded so the log always shows draw < p (rounding could make them equal).
          p,
          draw,
        });
      }
    }
    return out;
  }

  /** Force an action (e.g. topic opener). Counts toward fatigue and the LLM cap; logged with a reason. */
  function force(post, personaId, action, reason, at) {
    used.set(personaId, used.get(personaId) + 1);
    if (action === 'reply' || action === 'quote') llmUsed++;
    if (action === 'quote') post.quotes = (post.quotes ?? 0) + 1;
    if (action === 'reply') post.replies = (post.replies ?? 0) + 1;
    if (log) reactions.push({ postId: post.id, personaId, action, forced: reason, at: new Date(at).toISOString() });
  }

  /** Count an authored original against the persona's daily budget. */
  const spend = (personaId, n = 1) => used.set(personaId, (used.get(personaId) ?? 0) + n);

  return { consider, force, spend, reactions, sampler, rand, get llmUsed() { return llmUsed; }, used, budget };
}

/**
 * Event-ordered cascade over a day's originals. Each node: { id, authorId, createdAt(ms), vector,
 * depth, mentions, likes, reposts }. Reply/quote events become new nodes (id = `${parent}.r<n>` /
 * `.q<n>`) evaluated in time order. Returns all nodes (originals first) — no text involved.
 */
export function cascade(reactor, originals, { horizon = Infinity, personas = [] } = {}) {
  const nodes = [...originals];
  const queue = [...originals].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const counters = new Map();
  const byId = new Map(personas.map((p) => [p.id, p]));
  while (queue.length) {
    const post = queue.shift();
    const events = reactor.consider(post, { horizon });
    for (const ev of events) {
      const kind = ev.action === 'reply' ? 'r' : 'q';
      const n = (counters.get(`${post.id}${kind}`) ?? 0) + 1;
      counters.set(`${post.id}${kind}`, n);
      const node = {
        id: `${post.id}.${kind}${n}`,
        authorId: ev.personaId,
        createdAt: ev.at,
        vector: post.vector,
        topicId: post.topicId ?? null,
        depth: ev.action === 'reply' ? (post.depth ?? 0) + 1 : (post.depth ?? 0) + 1,
        role: ev.action,
        parent: ev.action === 'reply' ? post.id : null,
        quoteOf: ev.action === 'quote' ? post.id : null,
        rel: ev.rel,
        ...(ev.form ? { form: ev.form, cheap: ev.cheap, noReply: Boolean(ev.cheap) } : {}),
        mentions: new Set([post.authorId].filter((id) => byId.size === 0 || byId.has(id))),
        likes: [],
        reposts: [],
      };
      nodes.push(node);
      const i = queue.findIndex((q) => q.createdAt > node.createdAt);
      queue.splice(i < 0 ? queue.length : i, 0, node);
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Simulation + calibration.

/** Synthetic originals for a simulated day (authors ∝ activity × popularity, topic vectors over TOPIC_KEYS). */
export function syntheticOriginals(personas, n, rand, dayStart = 0, sampler = null) {
  const authors = personas.filter((p) => !isNews(p));
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = weightedPick(rand, authors.map((p) => [p.id, (behaviorOf(p).activity ?? 0.5) * (p.popularity ?? 5)]));
    const k1 = TOPIC_KEYS[Math.floor(rand() * TOPIC_KEYS.length)];
    const k2 = TOPIC_KEYS[Math.floor(rand() * TOPIC_KEYS.length)];
    const hour = sampler ? sampler.localHour() : Math.floor(rand() * 24);
    out.push({ id: `s${i}`, authorId: a, createdAt: dayStart + hour * 3.6e6 + Math.floor(rand() * 3.6e6), vector: { [k1]: 1, [k2]: 0.5 }, depth: 0, mentions: new Set(), likes: [], reposts: [], role: 'original' });
  }
  return out;
}

/** Simulate `days` days; returns counts { original, reply, quote, like, repost } and nodes. */
export function simulate({ personas, spec, calibration, days = 1, originalsPerDay = 25, seed = 'sim', nonce = '', llmCap = Infinity }) {
  const counts = { original: 0, reply: 0, quote: 0, like: 0, repost: 0, rootsZeroReply: 0, roots: 0 };
  const perPersona = new Map();
  let allNodes = [];
  for (let d = 0; d < days; d++) {
    const reactor = createReactor({ personas, spec, seed: `${seed}:${d}`, nonce, calibration, llmCap, log: false });
    const originals = syntheticOriginals(personas, originalsPerDay, reactor.rand, d * 864e5, reactor.sampler);
    for (const o of originals) reactor.spend(o.authorId);
    const nodes = cascade(reactor, originals, { horizon: (d + 1.25) * 864e5, personas });
    const repliesTo = new Map();
    for (const n of nodes) {
      counts[n.role === 'original' ? 'original' : n.role]++;
      counts.like += n.likes.length;
      counts.repost += n.reposts.length;
      if (n.parent) repliesTo.set(n.parent, (repliesTo.get(n.parent) ?? 0) + 1);
      for (const pid of [...n.likes, ...n.reposts, ...(n.role !== 'original' ? [n.authorId] : [])]) perPersona.set(`${d}:${pid}`, (perPersona.get(`${d}:${pid}`) ?? 0) + 1);
    }
    for (const n of nodes) if (!n.parent) {
      counts.roots++;
      if (!repliesTo.get(n.id)) counts.rootsZeroReply++;
    }
    if (days <= 2) allNodes = allNodes.concat(nodes);
  }
  const authored = counts.original + counts.reply + counts.quote;
  return {
    counts,
    perPersona,
    nodes: allNodes,
    shares: { original: counts.original / authored, reply: counts.reply / authored, quote: counts.quote / authored },
    likesPerRepost: counts.repost ? counts.like / counts.repost : Infinity,
  };
}

/** Targets from the spec (never duplicated): activity mix and likes per retaik. */
export function calibrationTargets(spec) {
  const a = spec.sampling.activity;
  return { replyShare: a.reply, quoteShare: a.quote, likesPerRepost: 1 / spec.sampling.engagement.reposts_per_like.median };
}

function bisect(f, lo, hi, target, iters) {
  for (let i = 0; i < iters; i++) {
    const mid = Math.sqrt(lo * hi);
    const v = f(mid);
    if (v < target) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

const calCache = new Map();
/**
 * Calibrate k (→ reply+quote volume), qTilt (→ quote/reply ratio) and rTilt (→ likes per retaik)
 * by coordinate-wise bisection over simulated days with the real personas. Deterministic (fixed
 * seed); cached in memory per persona set and day size, and recorded in the run manifest.
 */
export function calibrate({ personas, spec, originalsPerDay = 25, days = 8, rounds = 2, cacheFile = null, writeCache = true }) {
  const key = sha256(JSON.stringify([personas.map((p) => [p.id, p.reactivity, p.popularity, p.topic_affinity, p.x_behavior, p.kind, (p.rivals ?? []).length]), originalsPerDay, days, spec.sampling.activity, spec.sampling.engagement.reposts_per_like]));
  if (calCache.has(key)) return calCache.get(key);
  const disk = cacheFile && fs.existsSync(cacheFile) ? (() => { try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return null; } })() : null;
  if (disk?.entries?.[key]) {
    calCache.set(key, disk.entries[key]);
    return disk.entries[key];
  }
  const t = calibrationTargets(spec);
  const cal = { ...DEFAULT_CALIBRATION };
  const run = (c) => simulate({ personas, spec, calibration: c, days, originalsPerDay, seed: 'calibration' });
  const authoredRatio = (t.replyShare + t.quoteShare) / (1 - t.replyShare - t.quoteShare);
  const quoteRatio = t.quoteShare / t.replyShare;
  // 1) bisection for k on short simulations (monotone in k), 2) multiplicative fixed-point
  // refinement of all three on longer simulations (ratios are ~proportional to the tilts).
  cal.k = bisect((k) => {
    const s = run({ ...cal, k });
    return (s.counts.reply + s.counts.quote) / s.counts.original;
  }, 1e-3, 5, authoredRatio, 16);
  const long = (c) => simulate({ personas, spec, calibration: c, days: days * 8, originalsPerDay, seed: 'calibration-long' });
  let last;
  for (let r = 0; r < rounds + 4; r++) {
    last = long(cal);
    const ar = (last.counts.reply + last.counts.quote) / last.counts.original;
    const qr = last.counts.quote / Math.max(1, last.counts.reply);
    cal.k *= clamp((authoredRatio / ar) ** 0.8, 0.5, 2);
    cal.qTilt *= clamp((quoteRatio / Math.max(qr, 1e-3)) ** 0.8, 0.3, 3);
    cal.rTilt *= clamp((last.likesPerRepost / t.likesPerRepost) ** 0.8, 0.3, 3);
  }
  last = long(cal);
  const out = {
    k: Number(cal.k.toPrecision(4)),
    qTilt: round3(cal.qTilt),
    rTilt: round3(cal.rTilt),
    originalsPerDay,
    targets: { authoredRatio: round3(authoredRatio), quoteRatio: round3(quoteRatio), likesPerRepost: round3(t.likesPerRepost) },
    achieved: { original: round3(last.shares.original), reply: round3(last.shares.reply), quote: round3(last.shares.quote), likesPerRepost: round3(last.likesPerRepost) },
  };
  calCache.set(key, out);
  if (cacheFile && writeCache) {
    // Keep only the latest few keys (persona set × day size) so the committed file stays small.
    const entries = Object.fromEntries([...Object.entries(disk?.entries ?? {}), [key, out]].slice(-6));
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, `${JSON.stringify({ note: 'react.mjs calibration cache (keyed by persona set + spec)', entries }, null, 2)}\n`);
  }
  return out;
}
