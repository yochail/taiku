// @mention targets and enforcement for generated taiks (spec.sampling.mentions).
// Counts come from the realism sampler; this module picks WHO gets tagged and makes sure the
// sampled handles end up in the text.
import { relationOf } from './react.mjs';
import { taikLength } from './data.mjs';
import { textMentions } from './realism.mjs';
import { weightedPick } from './pipeline-util.mjs';

const isNews = (p) => p?.kind === 'news';

/**
 * Pick `n` distinct personas for `author` to tag: rivals > frenemies > allies > anyone (by popularity),
 * per spec.sampling.mentions.targets. Never the author, news accounts or ids in `exclude`.
 */
export function mentionTargets({ author, personas, n, spec, rand, exclude = [] }) {
  const w = spec.sampling.mentions?.targets ?? { rival: 3, frenemy: 2.5, ally: 2, other: 0.3 };
  const skip = new Set([author?.id, ...exclude]);
  const pool = personas
    .filter((p) => !skip.has(p.id) && !isNews(p) && p.handle)
    .map((p) => [p.id, (w[relationOf(author, p) ?? 'other'] ?? w.other ?? 0.3) * Math.sqrt(p.popularity ?? 5)]);
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const id = weightedPick(rand, pool);
    if (!id) break;
    out.push(id);
    pool.splice(pool.findIndex(([x]) => x === id), 1);
  }
  return out;
}

/**
 * Make sure every required handle appears as a non-leading @mention. Missing ones are appended
 * (" @a @b", the way people tag at the end) when they fit within `maxChars`; otherwise left out.
 */
export function ensureMentions(text, handles = [], maxChars = 280) {
  const want = (handles ?? []).map((h) => String(h).replace(/^@/, ''));
  if (!want.length) return text;
  const have = new Set(textMentions(text));
  const missing = want.filter((h) => !have.has(h.toLowerCase()));
  if (!missing.length) return text;
  const tail = ` ${missing.map((h) => `@${h}`).join(' ')}`;
  return taikLength(text + tail) <= maxChars ? text + tail : text;
}
