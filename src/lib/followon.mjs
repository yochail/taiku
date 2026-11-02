// followon.mjs: reactions that cross the day boundary.
//
// 1) Mention → reaction (spec.sampling.mention_response). Every persona @mentioned in a post's text
//    gets one sampled outcome: reply | quote | like | ignore, with a lognormal delay. The draw is
//    seeded by (post id, persona id), so it is stateless: the day of the post executes it when the
//    delay lands inside that day's horizon; otherwise the next daily run recomputes the same draw
//    from the corpus and executes it when it lands in its own day.
// 2) Resurfacing (spec.sampling.resurfacing). Each day samples past posts (last window_days) by
//    traction = (1 + likes + 2·reposts + 3·(replies + quotes))^exponent × 0.5^(age_h / half_life_h)
//    and gives them follow-on replies/quotes today; with a small chance one of them gets a pile-on.
import { behaviorOf } from './behavior.mjs';
import { crowdFor } from './crowd.mjs';
import { relationOf, RELATION_WEIGHT } from './react.mjs';
import { textMentions } from './realism.mjs';
import { clamp, seededRng, weightedPick } from './pipeline-util.mjs';

const HOUR = 3.6e6;
const isNews = (p) => (p?.kind ?? 'thinker') === 'news';

const normal = (rand) => {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};

/** Deterministic outcome for persona `persona` being @mentioned in post `postId` by `author`. */
export function mentionDecision(spec, persona, postId, author = null) {
  const cfg = spec.sampling.mention_response;
  const rand = seededRng('mention', postId, persona.id);
  const b = behaviorOf(persona);
  const clap = clamp(b.clapback_rate ?? 0.4, 0, 1);
  const heat = clamp(persona.temperament?.heat ?? 3, 1, 5);
  const talk = ((cfg.persona?.base ?? 0.6) + (cfg.persona?.clapback ?? 0.8) * clap) * (0.7 + 0.15 * heat) / 1.15;
  const rel = author ? relationOf(persona, author) : null;
  const tilt = cfg.relation?.[rel] ?? {};
  const w = Object.fromEntries(Object.entries(cfg.actions).map(([a, v]) => [a, v * (a === 'reply' || a === 'quote' ? talk : a === 'ignore' ? Math.max(0.2, 1.4 - clap) : 1) * (tilt[a] ?? 1)]));
  const action = weightedPick(rand, Object.entries(w)) ?? 'ignore';
  const d = cfg.delay_minutes;
  const delayMin = Math.max(1, Math.min(d.max, Math.round(d.lognormal.median * Math.exp(d.lognormal.sigma * normal(rand)))));
  return { action, delayMin };
}

/** Index of who already replied to / quoted each post: Map(postId → Set(authorId)). */
export function reactedIndex(posts) {
  const idx = new Map();
  for (const p of posts) for (const ref of [p.inReplyTo, p.quoteOf]) {
    if (!ref) continue;
    if (!idx.has(ref)) idx.set(ref, new Set());
    idx.get(ref).add(p.authorId);
  }
  return idx;
}

const handleMap = (personas) => new Map(personas.map((p) => [String(p.handle ?? '').toLowerCase(), p]));

/** Mentioned personas (objects) in a post's text, excluding the author and news accounts. */
export function mentionedPersonas(post, personas, handles = handleMap(personas)) {
  return textMentions(post.text, new Set(handles.keys())).map((h) => handles.get(h)).filter((p) => p && p.id !== post.authorId && !isNews(p));
}

/**
 * Mention reactions owed by earlier days that land in [start, end): [{ post, personaId, action, at, reason }].
 * Skips posts the persona already replied to or quoted.
 */
export function mentionDebts({ past, personas, spec, start, end }) {
  const byId = new Map(personas.map((p) => [p.id, p]));
  const handles = handleMap(personas);
  const reacted = reactedIndex(past);
  const maxBack = (spec.sampling.mention_response.delay_minutes.max ?? 2880) * 60000;
  const out = [];
  for (const post of past) {
    const t = Date.parse(post.createdAt);
    if (post.retaikOf || !(t < start) || t < start - maxBack) continue;
    for (const persona of mentionedPersonas(post, personas, handles)) {
      if (reacted.get(post.id)?.has(persona.id)) continue;
      const d = mentionDecision(spec, persona, post.id, byId.get(post.authorId));
      const at = t + d.delayMin * 60000;
      if ((d.action === 'reply' || d.action === 'quote') && at >= start && at < end) out.push({ post, personaId: persona.id, action: d.action, at, reason: 'mention' });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Traction of a past post at time `now` (engagement × recency decay). Engagement is what readers
 * see: stored crowd bases, else the seeded crowd (crowdFor) when `spec` is given, plus persona engagement.
 */
export function traction(post, counts, now, cfg, author = null, spec = null) {
  const crowd = spec && (post.crowdLikeBase == null || post.crowdRepostBase == null) ? crowdFor(post, author, spec) : null;
  const likes = (post.crowdLikeBase ?? crowd?.likes ?? 0) + (post.personaLikes?.length ?? 0);
  const reposts = (post.crowdRepostBase ?? crowd?.reposts ?? 0) + (post.personaReposts?.length ?? 0);
  const c = counts.get(post.id) ?? 0;
  const ageH = Math.max(0, (now - Date.parse(post.createdAt)) / HOUR);
  return (1 + likes + 2 * reposts + 3 * c) ** (cfg.traction_exponent ?? 1) * 0.5 ** (ageH / (cfg.half_life_hours ?? 36));
}

const poisson = (rand, mean) => {
  const L = Math.exp(-mean);
  let k = 0;
  for (let p = rand(); p > L; p *= rand()) k++;
  return k;
};

/**
 * Follow-on reactions to past posts for the day [start, end): [{ post, personaId, action, at, reason }].
 * `online(personaId)` weights reactors (people already online today see resurfacing posts first).
 * `atFn(minHour, personaId)` returns a timestamp inside the day (the planner's diurnal / sitting sampler).
 */
export function resurface({ past, personas, spec, start, end, seed, atFn, skip = [], online = () => 1 }) {
  const cfg = spec.sampling.resurfacing;
  if (!cfg || !past.length) return [];
  const rand = seededRng('resurface', seed, start);
  const byId = new Map(personas.map((p) => [p.id, p]));
  const counts = new Map();
  for (const p of past) for (const ref of [p.inReplyTo, p.quoteOf]) if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  const reacted = reactedIndex(past);
  const minAge = (cfg.min_age_hours ?? 24) * HOUR;
  const cands = past.filter((p) => {
    const t = Date.parse(p.createdAt);
    return !p.retaikOf && byId.has(p.authorId) && t < start - minAge + 12 * HOUR && t >= start - cfg.window_days * 24 * HOUR && String(p.text ?? '').trim().length >= (cfg.min_text_chars ?? 15);
  });
  if (!cands.length) return [];
  const weights = cands.map((p) => [p, traction(p, counts, start, cfg, byId.get(p.authorId), spec)]);
  const taken = new Set(skip.map((s) => `${s.post.id}:${s.personaId}`));
  const reactors = personas.filter((p) => !isNews(p));
  const out = [];
  const react = (post, n, reason) => {
    const author = byId.get(post.authorId);
    const pool = reactors
      .filter((p) => p.id !== post.authorId && !taken.has(`${post.id}:${p.id}`) && !reacted.get(post.id)?.has(p.id))
      .map((p) => {
        const rel = relationOf(p, author);
        return [p.id, (rel ? RELATION_WEIGHT[rel] : 1) * clamp(p.reactivity ?? 3, 1, 5) / 3 * (0.3 + clamp(behaviorOf(p).dunk_tendency ?? 0.3, 0, 1)) * online(p.id)];
      });
    for (let i = 0; i < n && pool.length; i++) {
      const pid = weightedPick(rand, pool);
      pool.splice(pool.findIndex(([id]) => id === pid), 1);
      taken.add(`${post.id}:${pid}`);
      const action = rand() < (cfg.quote_share ?? 0.3) ? 'quote' : 'reply';
      const at = Math.min(end - 60000, Math.max(atFn(cfg.earliest_hour ?? 7, pid), Date.parse(post.createdAt) + HOUR));
      out.push({ post, personaId: pid, action, at, reason });
    }
  };
  const seeds = poisson(rand, cfg.seeds_per_day_mean ?? 4);
  for (let i = 0; i < seeds; i++) {
    const post = weightedPick(rand, weights);
    if (!post) break;
    let n = 1;
    while (n < (cfg.max_per_seed ?? 4) && rand() < (cfg.more_probability ?? 0.35)) n++;
    react(post, n, 'resurface');
  }
  if (rand() < (cfg.pile_on.probability_per_day ?? 0.1)) {
    // Pile-ons hit the most-traction posts: weights squared sharpen the heavy tail.
    const post = weightedPick(rand, weights.map(([p, w]) => [p, w * w]));
    const [lo, hi] = cfg.pile_on.reactors;
    if (post) react(post, lo + Math.floor(rand() * (hi - lo + 1)), 'pile-on');
  }
  return out.sort((a, b) => a.at - b.at);
}
