// Reaction pools: pre-written, no-LLM micro-reactions (persona.reaction_pool + content/pools/<id>.json)
// with a HARD 14-day per-persona cooldown. Usage is rebuilt from content/state/reaction-usage.json AND
// a scan of every content/posts/*.json file (each generated item stores `reactionId`), so posts written
// by any path (local session runs, Cloudflare runs, mock) count.
import fs from 'node:fs';
import path from 'node:path';
import { REACTION_STANCES, reactionEntryProblems, reactionKind } from './data.mjs';
import { affinityFromCosine, cosineVec, tagOverlap, tokens } from './embed.mjs';
import { lintTaik } from './house-style.mjs';
import { readJson, sha256, writeJsonAtomic } from './pipeline-util.mjs';

export const COOLDOWN_DAYS = 14;
export const PRUNE_DAYS = 30;
const DAY = 86400000;

/** Stable id of a pool entry: rx- + sha256(kind:value)[0..10]. */
export const reactionId = (entry) => {
  const k = reactionKind(entry);
  return `rx-${sha256(`${k}:${entry[k]}`).slice(0, 10)}`;
};
export const usageKey = (personaId, rid) => `${personaId}|${rid}`;

/** Form (sampler.replyForm) → the pool entry kinds that can serve it. */
export const FORM_KINDS = {
  emoji_only: ['emoji'],
  few_words: ['text'],
  gif_only: ['gif_query'],
  meme_only: ['meme_template'],
  short: ['text'],
};
const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
export function fitsForm(entry, form) {
  const k = reactionKind(entry);
  if (!(FORM_KINDS[form] ?? []).includes(k)) return false;
  if (form === 'few_words') return words(entry.text) <= 3 && [...entry.text].length <= 25;
  if (form === 'short') return [...entry.text].length <= 40;
  return true;
}

/** Validate a pool entry with data.mjs rules + the house-style lint on text. Returns problems[]. */
export function entryProblems(entry, persona) {
  const errs = reactionEntryProblems(entry, persona);
  if (entry && typeof entry.text === 'string') errs.push(...lintTaik(entry.text, persona));
  return errs;
}

export const poolFile = (root, id) => path.join(root, 'content', 'pools', `${id}.json`);

/** Map<personaId, entry[]> with entries {…orig, rid, kind, source}. Invalid extra entries are dropped. */
export function loadPools(personas, { root = null, log = () => {} } = {}) {
  const out = new Map();
  const lintDropped = [];
  out.lintDropped = lintDropped;
  for (const p of personas) {
    const seen = new Set();
    const list = [];
    const extra = root ? readJson(poolFile(root, p.id))?.entries ?? [] : [];
    for (const [src, arr] of [['persona', p.reaction_pool ?? []], ['pool', extra]]) {
      for (const e of arr) {
        const kind = reactionKind(e);
        if (!kind) continue;
        if (src === 'pool' && entryProblems(e, p).length) {
          log(`pool ${p.id}: dropping invalid entry ${JSON.stringify(e).slice(0, 60)}`);
          continue;
        }
        if (src === 'persona' && typeof e.text === 'string' && lintTaik(e.text, p).length) {
          lintDropped.push(`${p.id}: ${e.text}`);
          continue;
        }
        const rid = reactionId(e);
        if (seen.has(rid)) continue;
        seen.add(rid);
        list.push({ ...e, rid, kind, source: src });
      }
    }
    out.set(p.id, list);
  }
  return out;
}

/** Append validated new entries to content/pools/<id>.json. Returns the accepted entries. */
export function appendPoolEntries(root, persona, entries, { date, existing = [] } = {}) {
  const have = new Set(existing.map((e) => e.rid ?? reactionId(e)));
  const ok = [];
  for (const raw of entries) {
    const kind = reactionKind(raw);
    if (!kind) continue;
    const e = { [kind]: String(raw[kind]).trim(), stance: raw.stance, tags: raw.tags, tone: raw.tone };
    if (entryProblems(e, persona).length) continue;
    const rid = reactionId(e);
    if (have.has(rid)) continue;
    have.add(rid);
    ok.push(e);
  }
  if (!ok.length || !root) return ok;
  const file = poolFile(root, persona.id);
  const cur = readJson(file) ?? { personaId: persona.id, entries: [] };
  cur.entries.push(...ok.map((e) => ({ ...e, added: date })));
  cur.updatedAt = date;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, cur);
  return ok;
}

export const usageFile = (root, mock = false) => path.join(root, 'content', 'state', `reaction-usage${mock ? '-mock' : ''}.json`);

/**
 * Rebuild usage: state file + scan of ALL post files in postsDir (except `exclude` basenames, i.e. this
 * run's own output which is re-added as it is generated). Returns { used: Map<key, 'YYYY-MM-DD'>, scanned }.
 */
export function loadReactionUsage({ stateFile = null, postsDir = null, exclude = [] } = {}) {
  const used = new Map();
  const put = (k, d) => {
    if (!d) return;
    const prev = used.get(k);
    if (!prev || d > prev) used.set(k, d);
  };
  const state = stateFile ? readJson(stateFile) : null;
  for (const [k, d] of Object.entries(state?.used ?? {})) put(k, d);
  let scanned = 0;
  if (postsDir && fs.existsSync(postsDir)) {
    const skip = new Set(exclude);
    for (const f of fs.readdirSync(postsDir).filter((x) => x.endsWith('.json') && !skip.has(x)).sort()) {
      const j = readJson(path.join(postsDir, f));
      const posts = Array.isArray(j) ? j : j?.posts ?? [];
      scanned++;
      for (const p of posts) if (p?.reactionId && p.authorId) put(usageKey(p.authorId, p.reactionId), String(p.createdAt ?? '').slice(0, 10));
    }
  }
  return { used, scanned };
}

export function saveReactionUsage(file, used, today) {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - PRUNE_DAYS * DAY).toISOString().slice(0, 10);
  const out = {};
  for (const [k, d] of [...used.entries()].sort()) if (d >= cutoff) out[k] = d;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { cooldownDays: COOLDOWN_DAYS, updatedAt: today, used: out });
}

/** True when `lastUsed` (YYYY-MM-DD) is within the cooldown window of `date`. */
export function inCooldown(lastUsed, date, days = COOLDOWN_DAYS) {
  if (!lastUsed) return false;
  return Date.parse(`${date}T00:00:00Z`) - Date.parse(`${lastUsed}T00:00:00Z`) < days * DAY;
}

// ---------- stance ----------

export function relationOf(persona, targetId) {
  if (!targetId || !persona) return null;
  const has = (k) => (persona[k] ?? []).some((r) => (r?.id ?? r) === targetId);
  if (has('frenemies')) return 'frenemy';
  if (has('rivals')) return 'rival';
  if (has('allies')) return 'ally';
  return null;
}

/**
 * Pick a stance: relation (rival → disagree/mock, ally → agree/hype, frenemy mixed), else persona
 * propensity (x_behavior), blended with the target post's stance and an optional embedding hint.
 */
export function chooseStance({ persona, targetAuthorId = null, targetStance = null, hint = null, relation = undefined, rand = Math.random }) {
  if (persona?.kind === 'news') return 'neutral';
  const xb = persona?.x_behavior ?? {};
  const dunk = Number(xb.dunk_tendency ?? 0.3);
  const meme = Number(xb.meme_affinity ?? 0.3);
  const w = { agree: 1, disagree: 0.8 + dunk, mock: 0.4 + dunk + meme * 0.5, awe: 0.4, confused: 0.4, hype: 0.3 + meme * 0.3 };
  const rel = relation === undefined ? relationOf(persona, targetAuthorId) : relation;
  if (rel === 'rival') Object.assign(w, { disagree: w.disagree + 3, mock: w.mock + 2.5, agree: 0.15, hype: 0.05, awe: 0.1 });
  else if (rel === 'ally') Object.assign(w, { agree: w.agree + 3, hype: w.hype + 2, disagree: w.disagree * 0.3, mock: w.mock * 0.2 });
  else if (rel === 'frenemy') Object.assign(w, { mock: w.mock + 1.5, disagree: w.disagree + 1, agree: w.agree + 0.8 });
  // Target stance: pile-ons (agree with an agreeing post of an ally, push back on a hot take).
  if (targetStance === 'mock' || targetStance === 'disagree') {
    if (rel === 'ally') w.agree += 1;
    else w.disagree += 0.8;
  } else if (targetStance === 'hype' || targetStance === 'awe') {
    w.mock += 0.6;
    w.hype += 0.4;
  } else if (targetStance === 'confused') w.confused += 0.5;
  if (hint) for (const s of REACTION_STANCES) w[s] = Math.max(0.02, w[s] + Math.max(0, Number(hint[s] ?? 0)) * 6);
  const total = REACTION_STANCES.reduce((s, k) => s + w[k], 0);
  let x = rand() * total;
  for (const s of REACTION_STANCES) {
    x -= w[s];
    if (x < 0) return s;
  }
  return 'disagree';
}

// ---------- picker ----------

/**
 * createPoolPicker({ pools, used, date, rand, embedder?, cooldownDays? })
 * pick({ persona, form, stance, postVec?, postTags? }) → entry | null (null = no fresh entry for that
 * stance/form: the caller falls back to an LLM short reply; entries are NEVER reused early).
 * Using an entry records it in `used` immediately.
 */
export function createPoolPicker({ pools, used = new Map(), date, rand = Math.random, embedder = null, cooldownDays = COOLDOWN_DAYS, log = () => {} }) {
  const vecCache = new Map();
  const stats = { picked: 0, exhausted: 0, byKind: {} };
  const entryText = (e) => `${e[e.kind]} ${(e.tags ?? []).join(' ')} ${e.tone ?? ''}`;

  function fresh(personaId, form, stance) {
    const list = pools.get(personaId) ?? [];
    return list.filter((e) => e.stance === stance && fitsForm(e, form) && !inCooldown(used.get(usageKey(personaId, e.rid)), date, cooldownDays));
  }

  async function rank(cands, { postVec, postTags }) {
    let sims = null;
    if (postVec && embedder && embedder.kind !== 'none') {
      const miss = cands.filter((e) => !vecCache.has(e.rid));
      if (miss.length) {
        const vecs = await embedder.embed(miss.map(entryText));
        if (vecs) miss.forEach((e, i) => vecCache.set(e.rid, vecs[i]));
      }
      sims = cands.map((e) => (vecCache.has(e.rid) ? affinityFromCosine(cosineVec(postVec, vecCache.get(e.rid)), embedder.kind) : 0));
    }
    if (!sims) sims = cands.map((e) => tagOverlap(postTags ?? [], [...(e.tags ?? []), ...tokens(e[e.kind]).slice(0, 4)]));
    return cands.map((e, i) => ({ e, score: sims[i] + rand() * 0.3 })).sort((a, b) => b.score - a.score);
  }

  async function pick({ persona, form, stance, postVec = null, postTags = [] }) {
    const st = persona.kind === 'news' ? 'neutral' : stance;
    const cands = fresh(persona.id, form, st);
    if (!cands.length) {
      stats.exhausted++;
      return null;
    }
    const [best] = await rank(cands, { postVec, postTags });
    used.set(usageKey(persona.id, best.e.rid), date);
    stats.picked++;
    stats.byKind[best.e.kind] = (stats.byKind[best.e.kind] ?? 0) + 1;
    return best.e;
  }

  /** Personas with few fresh entries left (any form) → candidates for micro-call pool refills. */
  function lowPersonas(personas, threshold = 25) {
    return personas
      .filter((p) => p.kind !== 'news')
      .map((p) => [p, (pools.get(p.id) ?? []).filter((e) => !inCooldown(used.get(usageKey(p.id, e.rid)), date, cooldownDays)).length])
      .filter(([, n]) => n < threshold)
      .sort((a, b) => a[1] - b[1])
      .map(([p, n]) => ({ persona: p, fresh: n }));
  }

  const freshCount = (personaId, form, stance) => fresh(personaId, form, stance).length;
  return { pick, fresh: freshCount, lowPersonas, used, stats };
}

// ---------- entry → post fields ----------

const STANCE_REACTION = {
  agree: ['horatii-agree'],
  hype: ['horatii-agree', 'starry-awe'],
  mock: ['cossacks-roar', 'democritus-lol', 'laughing-boy-lol'],
  disagree: ['pollice-thumbs-down', 'eternity-facepalm'],
  awe: ['starry-awe', 'rembrandt-gasp'],
  confused: ['desperate-disbelief', 'meditation-thinking'],
  neutral: ['meditation-thinking'],
};
export const localReactionFor = (stance, rand = Math.random) => {
  const l = STANCE_REACTION[stance] ?? STANCE_REACTION.neutral;
  return l[Math.floor(rand() * l.length)];
};
const MEME_ONE = ['athens-everyone', 'scream-when', 'socrates-one-more', 'aristotle-respect'];
const MEME_TWO = ['plato-vs-aristotle', 'diogenes-searching'];

/**
 * Media plan + fill for a gif_query / meme_template entry, for materializeMedia(plan, fill, {giphy}).
 * gif: GIPHY when enabled (query = entry text), with the local reaction as fallback.
 * meme: "Template: caption" → a local meme render (two-slot templates when the caption splits on / or vs).
 */
export function entryMedia(entry, { stance = entry.stance, giphyEnabled = false, rand = Math.random } = {}) {
  if (entry.kind === 'gif_query') {
    const reaction = localReactionFor(stance, rand);
    const plan = { kind: 'gif', source: giphyEnabled ? 'giphy' : 'local', options: [{ id: reaction }] };
    return { plan, fill: { query: entry.gif_query, reaction } };
  }
  if (entry.kind === 'meme_template') {
    const caption = entry.meme_template.replace(/^[^:]+:\s*/, '').trim();
    const parts = caption.split(/\s+\/\s+|\s+vs\.?\s+/i).filter(Boolean);
    if (parts.length === 2 && parts.every((x) => [...x].length <= 32)) {
      const template = MEME_TWO[Math.floor(rand() * MEME_TWO.length)];
      const slots = template === 'plato-vs-aristotle' ? ['up', 'down'] : ['top', 'bottom'];
      return { plan: { kind: 'meme', options: [{ id: template }] }, fill: { template, captions: { [slots[0]]: parts[0], [slots[1]]: parts[1] } } };
    }
    const template = MEME_ONE[Math.floor(rand() * MEME_ONE.length)];
    return { plan: { kind: 'meme', options: [{ id: template }] }, fill: { template, captions: { caption: caption.slice(0, 110) } } };
  }
  return null;
}
