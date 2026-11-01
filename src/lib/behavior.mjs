// X-behaviour profiles: how each persona behaves *as an X user* (how often they post, reply,
// like, quote-dunk, repost; meme/shitpost level; casing/emoji habits; time zone; beats).
// The source of truth is the `x_behavior` key in personas/<id>.json. defaultBehaviorFor() fills a
// missing block (scripts/sync-x-behavior.mjs writes it) and backs any field a file omits.
import { THEME_KEYS } from './themes.mjs';
import { POST_ARCHETYPES, REPLY_ARCHETYPES, ALL_TYPES } from './archetypes.mjs';

const RATE_KEYS = [
  'activity', 'reply_rate', 'like_rate', 'quote_rate', 'repost_rate',
  'dunk_tendency', 'meme_affinity', 'thread_tendency', 'shitpost_level', 'clapback_rate', 'emoji_use', 'caps_use',
];
export const CASINGS = ['lowercase', 'standard', 'caps'];
export const LIKE_VIBES = ['calm', 'spicy', 'funny', 'smart'];

/** Neutral profile; every field documented in README ("Engagement model"). */
export const GENERIC_X_BEHAVIOR = {
  vibe: 'regular poster',
  activity: 0.5,
  reply_rate: 0.3,
  like_rate: 0.35,
  quote_rate: 0.15,
  repost_rate: 0.15,
  dunk_tendency: 0.3,
  meme_affinity: 0.3,
  thread_tendency: 0.2,
  shitpost_level: 0.2,
  clapback_rate: 0.4,
  casing: 'standard',
  emoji_use: 0.2,
  caps_use: 0.05,
  emoji: ['👀'],
  utc_offset: 0,
  active_hours: [8, 23],
  likes_vibe: 'smart',
  formats: [],
  slang: [],
  beats: [],
};

/**
 * Default profile for a persona that has no x_behavior block yet (new casts, parody/news
 * accounts): the generic profile scaled by the persona's reactivity (1-5) and modernity (1-5).
 * News wire accounts post, never reply/quote.
 */
export function defaultBehaviorFor(persona) {
  const r = Math.min(5, Math.max(1, persona.reactivity ?? 3)) / 3;
  const m = Math.min(5, Math.max(1, persona.modernity ?? 3)) / 3;
  const round2 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
  const g = GENERIC_X_BEHAVIOR;
  if (persona.kind === 'news') {
    return { ...g, vibe: 'neutral news wire', activity: 0.6, reply_rate: 0, like_rate: 0, quote_rate: 0, repost_rate: 0, dunk_tendency: 0, meme_affinity: 0, thread_tendency: 0, shitpost_level: 0, clapback_rate: 0, emoji_use: 0, caps_use: 0, emoji: [], active_hours: [0, 24], likes_vibe: 'calm', formats: ['news_wire'] };
  }
  return {
    ...g,
    activity: round2(g.activity * r),
    reply_rate: round2(g.reply_rate * r),
    quote_rate: round2(g.quote_rate * r),
    dunk_tendency: round2(g.dunk_tendency * r),
    clapback_rate: round2(g.clapback_rate * r),
    meme_affinity: round2(g.meme_affinity * m),
    shitpost_level: round2(g.shitpost_level * m),
    emoji_use: round2(g.emoji_use * m),
    casing: (persona.modernity ?? 3) >= 5 ? 'lowercase' : 'standard',
  };
}

/** Validate an x_behavior profile; returns a list of error strings. */
export function validateBehavior(id, b) {
  const errs = [];
  if (!b || typeof b !== 'object') return [`${id}: x_behavior missing`];
  for (const k of RATE_KEYS) if (!(typeof b[k] === 'number' && b[k] >= 0 && b[k] <= 1)) errs.push(`${id}: x_behavior.${k} must be 0..1`);
  if (!CASINGS.includes(b.casing)) errs.push(`${id}: x_behavior.casing must be one of ${CASINGS.join('/')}`);
  if (!LIKE_VIBES.includes(b.likes_vibe)) errs.push(`${id}: x_behavior.likes_vibe must be one of ${LIKE_VIBES.join('/')}`);
  if (!(typeof b.utc_offset === 'number' && b.utc_offset >= -12 && b.utc_offset <= 14)) errs.push(`${id}: x_behavior.utc_offset out of range`);
  if (!(Array.isArray(b.active_hours) && b.active_hours.length === 2 && b.active_hours.every((h) => h >= 0 && h <= 24))) errs.push(`${id}: x_behavior.active_hours must be [start, end] in 0..24`);
  for (const f of b.formats ?? []) if (!ALL_TYPES[f]) errs.push(`${id}: x_behavior.formats has unknown archetype ${f}`);
  for (const t of b.beats ?? []) if (!THEME_KEYS.includes(t)) errs.push(`${id}: x_behavior.beats has unknown theme ${t}`);
  if (!Array.isArray(b.emoji) || !Array.isArray(b.slang)) errs.push(`${id}: x_behavior.emoji/slang must be arrays`);
  return errs;
}

/** Effective profile for a persona: generic ← built-in default ← persona file. */
export function behaviorOf(persona) {
  return { ...defaultBehaviorFor(persona), ...(persona.x_behavior ?? {}) };
}

export function postFormats(b) {
  return (b.formats ?? []).filter((f) => POST_ARCHETYPES[f]);
}
export function replyFormats(b) {
  return (b.formats ?? []).filter((f) => REPLY_ARCHETYPES[f]);
}

/** Is the persona "online" at this instant (their local active window)? */
export function isAwake(b, date) {
  const local = (((date.getUTCHours() + date.getUTCMinutes() / 60 + b.utc_offset) % 24) + 24) % 24;
  const [s, e] = b.active_hours;
  if (e - s >= 24 || s === e) return true;
  return s < e ? local >= s && local < e : local >= s || local < e;
}

/** Personas who would plausibly handle tragedy only with a serious register. */
export function isSerious(b) {
  return b.shitpost_level <= 0.35;
}
