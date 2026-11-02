// Media wiring for the generator: planMedia (realism sampler) → the LLM fills the plan's fields →
// materializeMedia(plan, fill, {giphy}). A bad fill never costs a repair call: we fall back to a
// deterministic default fill (charts are illustrative jokes only), or drop the media.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMedia, materializeMedia, resolveMedia, similarReactions } from './media.mjs';
import { claimArt } from './art-select.mjs';
import { gifIdentity, mediaOf, threadRoot, visualKeys } from './visual-dupes.mjs';
import { buildPoll } from './turn.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let mediaProps = null;
/** Media item keys the post schema accepts (schemas are owned by the parent; read at runtime). */
export function schemaMediaKeys() {
  if (!mediaProps) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'post.schema.json'), 'utf8'));
      mediaProps = new Set(Object.keys(s.properties?.media?.items?.properties ?? {}));
    } catch {
      mediaProps = new Set(['kind', 'src', 'alt', 'url', 'title', 'domain', 'description', 'rating', 'origin', 'ai_generated', 'credit', 'width', 'height', 'render']);
    }
  }
  return mediaProps;
}
/** True when the schema can store GIPHY items as returned by giphy.mjs (giphy_id + attribution). */
export const schemaAllowsGiphy = () => schemaMediaKeys().has('giphy_id') && schemaMediaKeys().has('attribution');

/** Strip keys the schema doesn't know and undefined values. */
export function toSchemaMedia(item) {
  if (!item) return null;
  const keys = schemaMediaKeys();
  const out = {};
  for (const [k, v] of Object.entries(item)) if (keys.has(k) && v !== undefined) out[k] = v;
  if (out.credit && typeof out.credit === 'object') {
    const ck = schemaCreditKeys();
    out.credit = Object.fromEntries(Object.entries(out.credit).filter(([k, v]) => (!ck || ck.has(k)) && v !== undefined));
  }
  return out;
}
let creditProps;
function schemaCreditKeys() {
  if (creditProps === undefined) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'post.schema.json'), 'utf8'));
      const p = s.properties?.media?.items?.properties?.credit?.properties;
      creditProps = p ? new Set(Object.keys(p)) : null;
    } catch {
      creditProps = null;
    }
  }
  return creditProps;
}

const CHART_TYPES = ['bar', 'hbar', 'line', 'pie'];
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n + 1).replace(/\s+\S*$/, '');
  return cut.length >= 3 ? cut : t.slice(0, n);
};

/** Deterministic fallback when the model's fill is missing or invalid. */
export function defaultFill(plan, { text = '', rand = Math.random } = {}) {
  if (!plan) return null;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  if (plan.kind === 'meme' && plan.options?.length) {
    const t = pick(plan.options);
    const words = String(text).replace(/https?:\S+/g, '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    const captions = {};
    (t.slots ?? []).forEach((s, i) => { captions[s.name] = clip(words[i] ?? words[0] ?? 'me', s.max ?? 40) || 'me'; });
    return { template: t.id, captions };
  }
  if (plan.kind === 'gif' && plan.options?.length) return { reaction: pick(plan.options).id };
  if (plan.kind === 'image' && plan.options?.length) return { art: pick(plan.options).id };
  if (plan.kind === 'chart') {
    const pairs = [['thinking', 'doing'], ['citing myself', 'citing others'], ['being right', 'being thanked'], ['reading the replies', 'regretting it']];
    const labels = pick(pairs);
    const a = 60 + Math.floor(rand() * 35);
    return { type: pick(CHART_TYPES), title: `time spent: ${labels[0]} vs. ${labels[1]}`, labels, values: [a, 100 - a], unit: '%' };
  }
  return null;
}

/** Charts are illustrative jokes only: never keep a "source". */
const sanitizeFill = (plan, fill) => {
  if (!fill || typeof fill !== 'object') return null;
  if (plan.kind === 'chart') {
    const { source: _s, ...rest } = fill;
    const type = rest.type ?? rest.chartType;
    return { ...rest, type: CHART_TYPES.includes(type) ? type : 'bar' };
  }
  return fill;
};

/** Plan media for a task (null when none). link cards use the topic and are rendered by run.mjs. */
export function planFor(sampler, role, { news = null, giphy = null, mood = null, persona = null, kind = null, rotation = null, ...memeCtx } = {}) {
  // memeCtx: { topic?, text?, quote?, excludeMemes? } steers the meme template shortlist (meme-select.mjs).
  // rotation: { rot, pid } (formats.mjs) down-weights media kinds the persona used recently.
  const plan = planMedia(sampler, role === 'wire' ? 'original' : role, { news, giphy, mood, persona, kind, rotation, ...memeCtx });
  return plan;
}

/**
 * Turn the model's media answer into post fields: { media: [item] } | { poll } | {}.
 * Never throws; invalid fills use defaultFill, and if that fails too the media is dropped.
 */
export async function materializeFor(plan, fill, { giphy = null, rand = Math.random, text = '', postId = 'p' } = {}) {
  if (!plan || plan.kind === 'link_card') return {};
  if (plan.kind === 'poll') {
    const poll = buildPoll({ options: fill?.options ?? fill?.poll?.options }, postId);
    return poll ? { poll } : {};
  }
  for (const f of [sanitizeFill(plan, fill), defaultFill(plan, { text, rand })]) {
    if (!f) continue;
    try {
      const item = toSchemaMedia(await materializeMedia(plan, f, { giphy, rand }));
      if (item) return { media: [item] };
    } catch { /* try the default fill */ }
  }
  return {};
}

/**
 * Generator rule for visual uniqueness (visual-dupes.mjs keys): every image, meme (template + captions)
 * and chart appears on at most one post corpus-wide; a reaction GIF at most once per day and per
 * conversation. Visits `posts` (this run's new posts) in (createdAt, id) order against `prior` (the
 * rest of the corpus), so the outcome is deterministic. A repeated GIF swaps to the closest free reaction,
 * a repeated picture to a free piece of art; anything else repeated loses its media (a media-only post
 * with no replies is dropped). Mutates posts; returns { changes: [string], drop: Set<postId> }.
 */
export function enforceUniqueVisuals(posts, prior = []) {
  const byId = new Map([...prior, ...posts].map((p) => [p.id, p]));
  const used = new Set();
  for (const p of prior) for (const m of mediaOf(p)) for (const k of visualKeys(p, m, threadRoot(p, byId))) used.add(k.key);
  const hasChild = new Set(posts.flatMap((p) => [p.inReplyTo, p.quoteOf, p.retaikOf]).filter(Boolean));
  const changes = [];
  const drop = new Set();
  const order = [...posts].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  // Keys any post (kept or not yet visited) already carries: a swap avoids them so it never forces a later swap.
  const reserved = new Set([...prior, ...posts].flatMap((p) => mediaOf(p).flatMap((m) => visualKeys(p, m, threadRoot(p, byId)).map((k) => k.key))));
  const free = (p, m, root, strict = false) => !visualKeys(p, m, root).some((k) => used.has(k.key) || (strict && reserved.has(k.key)));
  const swap = (m, render) => {
    const { svg: _s, raster: _r, ...item } = resolveMedia({ kind: m.kind, render, rating: m.rating });
    return toSchemaMedia(item);
  };
  for (const p of order) {
    const root = threadRoot(p, byId);
    const media = mediaOf(p);
    const keep = [];
    for (const m of media) {
      let item = m;
      if (!free(p, item, root)) {
        let alt = null;
        if (m.kind === 'gif' && m.render?.reaction) {
          // Same feeling first (unreserved, then merely unused); any free reaction only as a last resort.
          const near = similarReactions(m.render.reaction, { minScore: 1 }).map((r) => swap(m, { ...m.render, reaction: r.id }));
          const any = similarReactions(m.render.reaction).map((r) => swap(m, { ...m.render, reaction: r.id }));
          alt = near.find((c) => free(p, c, root, true)) ?? near.find((c) => free(p, c, root)) ?? any.find((c) => free(p, c, root, true)) ?? any.find((c) => free(p, c, root)) ?? null;
        } else if (m.kind === 'image' && m.render?.art) {
          const cand = swap(m, { art: claimArt(m.render.art, { ctx: { text: p.text, alt: m.alt } }) });
          if (free(p, cand, root)) alt = cand;
        }
        changes.push(`${p.id}: ${m.kind} ${gifIdentity(m) ?? m.src} ${alt ? `-> ${gifIdentity(alt) ?? alt.src}` : 'dropped (already used)'}`);
        item = alt;
      }
      if (!item) continue;
      for (const k of visualKeys(p, item, root)) used.add(k.key);
      keep.push(item);
    }
    if (keep.length === media.length && keep.every((m, i) => m === media[i])) continue;
    if (keep.length) p.media = keep;
    else delete p.media;
    if (!keep.length && !String(p.text ?? '').trim() && !p.poll && !hasChild.has(p.id)) drop.add(p.id);
  }
  return { changes, drop };
}
