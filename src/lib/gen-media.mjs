// Media wiring for the generator: planMedia (realism sampler) → the LLM fills the plan's fields →
// materializeMedia(plan, fill, {giphy}). A bad fill never costs a repair call: we fall back to a
// deterministic default fill (charts are illustrative jokes only), or drop the media.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMedia, materializeMedia } from './media.mjs';
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
export function planFor(sampler, role, { news = null, giphy = null, mood = null } = {}) {
  const plan = planMedia(sampler, role === 'wire' ? 'original' : role, { news, giphy, mood });
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
