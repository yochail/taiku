// Idea ledger + novelty guard: keep each persona going deep and wide into its own literature instead
// of repeating the famous line. Three parts:
//  1. ledger: core_ideas + key_works + quote_bank works + sites/<id>/ideas/<persona>.json deep_cuts,
//     sampled least-recently-used (usage detected lexically in the persona's past posts);
//  2. catchphrase caps: sites/<id>/ideas/<persona>.json catchphrases, max N per window (default 14 days);
//  3. novelty: hashed-embedding cosine + shared content tokens / word n-grams against the same
//     persona's last 7 days. Used in-turn (validateItem), by the day gate and the corpus audit.
import fs from 'node:fs';
import { sitePath } from './site.mjs';
import { cosineVec, hashEmbed, tokens } from './embed.mjs';

const DAY = 864e5;
export const NOVELTY_DEFAULTS = { window_days: 7, cosine: 0.36, min_shared_tokens: 3, ngram: 4, min_tokens: 6, dims: 512, catchphrase_window_days: 14, lru_days: 14 };
export const noveltyConfig = (spec) => ({ ...NOVELTY_DEFAULTS, ...(spec?.sampling?.novelty ?? {}) });

const fileCache = new Map();
/** sites/<id>/ideas/<persona>.json (or persona.ideas inline), {} when missing. */
export function ideaFile(persona) {
  if (persona?.ideas && typeof persona.ideas === 'object') return persona.ideas;
  const id = persona?.id;
  if (!id) return {};
  if (!fileCache.has(id)) {
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(sitePath('ideas', `${id}.json`), 'utf8'));
    } catch {
      doc = {};
    }
    fileCache.set(id, doc);
  }
  return fileCache.get(id);
}

const KEY_MIN = 5;
const keysOf = (s) => [...new Set(tokens(s).filter((w) => w.length >= KEY_MIN))];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** Everything a persona can draw on: [{ id, label, work, keys }]. */
export function ledgerItems(persona) {
  const out = [];
  const seen = new Set();
  const push = (id, label, work) => {
    const keys = keysOf(label);
    if (!label || !keys.length || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: String(label).slice(0, 140), work: work ? String(work).slice(0, 100) : null, keys });
  };
  (persona.core_ideas ?? []).forEach((s, i) => push(`core:${i}`, String(s).split(/[.;:—(]/)[0].trim() || String(s), null));
  for (const w of persona.key_works ?? []) push(`work:${slug(w.title ?? w)}`, w.title ?? String(w), w.title ?? String(w));
  for (const q of persona.quote_bank ?? []) if (q.work) push(`work:${slug(q.work)}`, q.work, q.work);
  (ideaFile(persona).deep_cuts ?? []).forEach((d, i) => push(`deep:${i}`, d.idea, d.work));
  return out;
}

/** True when a post's text draws on a ledger item (≥2 distinctive tokens shared, or the only one). */
export function usesIdea(item, textKeys) {
  const need = Math.min(2, item.keys.length);
  let n = 0;
  for (const k of item.keys) if (textKeys.has(k) && ++n >= need) return true;
  return false;
}

/** Map item id → last-used time (ms) from past posts [{text, createdAt}]. */
export function ideaUsage(items, posts) {
  const last = new Map();
  for (const p of posts) {
    const t = Date.parse(p.createdAt);
    if (!p.text || Number.isNaN(t)) continue;
    const keys = new Set(keysOf(p.text));
    for (const it of items) if (usesIdea(it, keys) && !(last.get(it.id) > t)) last.set(it.id, t);
  }
  return last;
}

/** LRU weight: unused = 1; else ((days since)/lruDays)², clamped to [0.02, 1]. */
export const lruWeight = (lastMs, now, lruDays = 14) => (lastMs === undefined ? 1 : Math.min(1, Math.max(0.02, ((now - lastMs) / DAY / lruDays) ** 2)));

export function pickIdea(rand, items, usage, now, lruDays = 14) {
  if (!items.length) return null;
  const w = items.map((it) => lruWeight(usage.get(it.id), now, lruDays));
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= w[i]) <= 0) return items[i];
  return items.at(-1);
}

/** Compiled catchphrases: [{ label, re, max }]. */
export function catchphrases(persona) {
  return (ideaFile(persona).catchphrases ?? []).flatMap((c) => {
    try {
      return [{ label: c.label, re: new RegExp(c.pattern, 'i'), max: Math.max(1, c.max ?? 1) }];
    } catch {
      return [];
    }
  });
}
export const catchphraseHits = (text, list) => list.filter((c) => c.re.test(String(text ?? ''))).map((c) => c.label);

/** Labels already at their cap within the window before `now` (counted over `posts` by this persona). */
export function cappedPhrases(list, posts, now, windowDays = 14) {
  if (!list.length) return [];
  const counts = new Map();
  for (const p of posts) {
    const t = Date.parse(p.createdAt);
    if (!(t < now && t >= now - windowDays * DAY)) continue;
    for (const l of catchphraseHits(p.text, list)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return list.filter((c) => (counts.get(c.label) ?? 0) >= c.max).map((c) => c.label);
}

const cleanText = (t) => String(t ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/[@#][\w-]+/g, ' ');
const wordsOf = (t) => cleanText(t).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9']+/).filter(Boolean);

/** Precomputed novelty fingerprint of a text (null when too short to judge). */
export function fingerprint(text, cfg = NOVELTY_DEFAULTS) {
  const tk = tokens(cleanText(text));
  if (tk.length < cfg.min_tokens) return null;
  const w = wordsOf(text);
  const content = new Set(tk);
  const grams = new Set();
  for (let i = 0; i + cfg.ngram <= w.length; i++) {
    const g = w.slice(i, i + cfg.ngram);
    if (g.filter((x) => content.has(x) && x.length >= 4).length >= 3) grams.add(g.join(' '));
  }
  return { vec: hashEmbed(cleanText(text), cfg.dims), tokens: content, grams };
}

/**
 * Compare a fingerprint with earlier ones [{ id, fp }]. Repetitive when cosine ≥ cfg.cosine with
 * ≥ cfg.min_shared_tokens shared content tokens, or a shared content word n-gram.
 * Returns { repetitive, score, otherId, shared, gram }.
 */
export function compareNovelty(fp, prev, cfg = NOVELTY_DEFAULTS) {
  let best = { repetitive: false, score: 0, otherId: null, shared: 0, gram: null };
  if (!fp) return best;
  for (const o of prev) {
    if (!o.fp) continue;
    const score = cosineVec(fp.vec, o.fp.vec);
    let shared = 0;
    for (const t of fp.tokens) if (o.fp.tokens.has(t)) shared++;
    let gram = null;
    for (const g of fp.grams) if (o.fp.grams.has(g)) { gram = g; break; }
    const repetitive = (score >= cfg.cosine && shared >= cfg.min_shared_tokens) || Boolean(gram);
    if ((repetitive && !best.repetitive) || (repetitive === best.repetitive && score > best.score)) best = { repetitive, score: Math.round(score * 1000) / 1000, otherId: o.id, shared, gram };
  }
  return best;
}

/** Repair hint for the model (prefixed "House style:" so batch/mock repair loops treat it as style). */
export const noveltyRepair = ({ otherText, phrases = [] }) =>
  `House style: ${phrases.length ? `you already used ${phrases.map((p) => `"${p}"`).join(', ')} recently; don't use it this time. ` : ''}${otherText ? `This repeats your recent taik ("${String(otherText).slice(0, 90)}"). ` : ''}Make a different point: draw on a less-famous idea or work of yours.`;

/**
 * Per-persona novelty context for the generator: earlier posts in the window + capped catchphrases.
 * `past`: the persona's posts before `now`.
 */
export function noveltyContext(persona, past, now, cfg = NOVELTY_DEFAULTS) {
  const list = catchphrases(persona);
  const recent = past.filter((p) => { const t = Date.parse(p.createdAt); return t < now && t >= now - cfg.window_days * DAY && p.text && !p.retaikOf; });
  const counts = new Map();
  for (const p of past) {
    const t = Date.parse(p.createdAt);
    if (t < now && t >= now - cfg.catchphrase_window_days * DAY) for (const l of catchphraseHits(p.text, list)) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  return {
    cfg,
    phrases: list,
    counts,
    capped: new Set(list.filter((c) => (counts.get(c.label) ?? 0) >= c.max).map((c) => c.label)),
    prev: recent.map((p) => ({ id: p.id, text: p.text, fp: fingerprint(p.text, cfg) })).filter((x) => x.fp),
  };
}

/** In-turn check: null when novel, else { problem, reason }. Adds accepted text via `accept`. */
export function checkNovelty(text, nctx) {
  if (!nctx) return null;
  const hits = catchphraseHits(text, nctx.phrases).filter((l) => nctx.capped.has(l));
  const cmp = compareNovelty(fingerprint(text, nctx.cfg), nctx.prev, nctx.cfg);
  if (!hits.length && !cmp.repetitive) return null;
  const other = cmp.repetitive ? nctx.prev.find((p) => p.id === cmp.otherId) : null;
  return { problem: noveltyRepair({ otherText: other?.text, phrases: hits }), reason: hits.length ? `catchphrase:${hits[0]}` : `repetitive:${cmp.otherId}`, score: cmp.score };
}
export function acceptNovelty(nctx, id, text) {
  if (!nctx) return;
  const fp = fingerprint(text, nctx.cfg);
  if (fp) nctx.prev.push({ id, text, fp });
  for (const c of nctx.phrases) if (c.re.test(String(text ?? ''))) {
    nctx.counts.set(c.label, (nctx.counts.get(c.label) ?? 0) + 1);
    if (nctx.counts.get(c.label) >= c.max) nctx.capped.add(c.label);
  }
}

const groupByPersona = (posts, personas) => {
  const byP = new Map(personas.map((p) => [p.id, p]));
  const groups = new Map();
  for (const p of posts) {
    if (!p.text || p.retaikOf || Number.isNaN(Date.parse(p.createdAt))) continue;
    const persona = byP.get(p.authorId);
    if (!persona || (persona.kind ?? 'thinker') === 'news') continue;
    (groups.get(p.authorId) ?? groups.set(p.authorId, []).get(p.authorId)).push(p);
  }
  for (const xs of groups.values()) xs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  return { byP, groups: [...groups].sort(([a], [b]) => a.localeCompare(b)) };
};

/**
 * Scan posts for repetition: each item vs the same persona's previous window, plus catchphrases over
 * their cap (news accounts exempt). `isTarget(p)` limits which items are judged (others still count
 * as history). Returns [{ postId, personaId, reason, otherId?, score?, gram?, label? }].
 */
export function scanRepetition(posts, { personas, cfg = NOVELTY_DEFAULTS, isTarget = () => true }) {
  const { byP, groups } = groupByPersona(posts, personas);
  const out = [];
  for (const [pid, xs] of groups) {
    const list = catchphrases(byP.get(pid));
    const fps = xs.map((p) => ({ id: p.id, t: Date.parse(p.createdAt), fp: fingerprint(p.text, cfg) }));
    const hitsAt = xs.map((p) => catchphraseHits(p.text, list));
    for (let i = 0; i < xs.length; i++) {
      if (!isTarget(xs[i])) continue;
      const t = fps[i].t;
      const over = hitsAt[i].find((label) => {
        const cap = list.find((c) => c.label === label).max;
        let n = 0;
        for (let j = 0; j < i; j++) if (fps[j].t >= t - cfg.catchphrase_window_days * DAY && hitsAt[j].includes(label)) n++;
        return n >= cap;
      });
      if (over) {
        out.push({ postId: xs[i].id, personaId: pid, reason: 'catchphrase', label: over });
        continue;
      }
      const cmp = compareNovelty(fps[i].fp, fps.slice(0, i).filter((o) => o.t >= t - cfg.window_days * DAY), cfg);
      if (cmp.repetitive) out.push({ postId: xs[i].id, personaId: pid, reason: 'repetitive', otherId: cmp.otherId, score: cmp.score, shared: cmp.shared, ...(cmp.gram ? { gram: cmp.gram } : {}) });
    }
  }
  return out;
}

/** Per-persona max cosine of a judged item vs the same persona's previous window (reports). */
export function maxSimilarityByPersona(posts, { personas, cfg = NOVELTY_DEFAULTS, isTarget = () => true }) {
  const res = new Map();
  for (const [pid, xs] of groupByPersona(posts, personas).groups) {
    const fps = xs.map((p) => ({ t: Date.parse(p.createdAt), fp: fingerprint(p.text, cfg) }));
    let best = 0;
    for (let i = 0; i < xs.length; i++) {
      if (!isTarget(xs[i]) || !fps[i].fp) continue;
      for (let j = 0; j < i; j++) if (fps[j].fp && fps[j].t >= fps[i].t - cfg.window_days * DAY) best = Math.max(best, cosineVec(fps[i].fp.vec, fps[j].fp.vec));
    }
    res.set(pid, Math.round(best * 1000) / 1000);
  }
  return res;
}


