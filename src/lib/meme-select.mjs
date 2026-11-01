// Meme template selector: matches a post (text, news headline, mood, persona, dunk target) to the
// template library's usage notes / keywords / tone, so planMedia can offer the LLM a short, fitting
// list (it picks one and writes the captions) and fallbacks can pick + fill one without the LLM.
import { loadTemplates } from './meme-render.mjs';

const STOP = new Set('a an and are as at be but by for from has have i in is it its me my of on or so that the this to was we what when with you your'.split(' '));
const words = (s) => String(s ?? '').toLowerCase().match(/[a-z\u00c0-\u024f']+/g) ?? [];

/** Relevance of template t to free text (+ optional mood). Higher is better; 0 = no signal. */
export function scoreTemplate(t, text, mood = '') {
  const low = ` ${String(text ?? '').toLowerCase()} `;
  const ws = new Set(words(text).filter((w) => !STOP.has(w)));
  let score = 0;
  for (const k of t.keywords ?? []) {
    if (k.includes(' ') ? low.includes(k) : [...ws].some((w) => w === k || (k.length >= 5 && w.startsWith(k)))) score += 2;
  }
  for (const w of words(t.usage)) if (w.length > 3 && !STOP.has(w) && ws.has(w)) score += 0.5;
  const m = String(mood ?? '').toLowerCase();
  if (m && (t.tone ?? []).some((x) => x.includes(m) || m.includes(x))) score += 1.5;
  return score;
}

const contextText = (ctx) => [ctx.text, ctx.news?.title, ctx.news?.summary, ctx.topic, ctx.quote?.text, ctx.persona?.name].filter(Boolean).join(' ');

/**
 * A short, diverse list of fitting templates for a post about to be written.
 * ctx: { text?, news?, mood?, topic?, persona?, quote? (dunk target {name, handle, text, persona}) }
 * opts: { n = 5, rand, exclude: Iterable<templateId> (e.g. recently used ones) }
 * The tweet-screenshot dunk is only offered when ctx.quote is set.
 */
export function shortlistTemplates(ctx = {}, { n = 5, rand = Math.random, exclude = [] } = {}) {
  const skip = new Set(exclude);
  const text = contextText(ctx);
  const pool = [...loadTemplates().templates.values()].filter((t) => !skip.has(t.id) && t.layout !== 'tweet');
  const scored = pool.map((t) => ({ t, s: scoreTemplate(t, text, ctx.mood) + rand() * 1.5 })).sort((a, b) => b.s - a.s);
  const out = scored.slice(0, Math.max(1, n - 2)).map((x) => x.t);
  const rest = scored.slice(out.length);
  while (out.length < n && rest.length) out.push(rest.splice(Math.floor(rand() * rest.length), 1)[0].t);
  if (ctx.quote?.text && !skip.has('tweet-dunk')) out.unshift(loadTemplates().templates.get('tweet-dunk'));
  return out.slice(0, n);
}

/** Reaction image for a tweet-screenshot dunk (a reaction-capable template fitting the mood/text). */
export function pickReaction(ctx = {}, rand = Math.random) {
  const all = [...loadTemplates().templates.values()].filter((t) => t.reaction);
  const text = contextText(ctx);
  const scored = all.map((t) => ({ t, s: scoreTemplate(t, text, ctx.mood ?? 'mocking') + rand() * 2 })).sort((a, b) => b.s - a.s);
  return scored[0].t.id;
}

/** Best single template for finished text (after-the-fact selection, e.g. pool memes). */
export function pickTemplate(text, ctx = {}, { rand = Math.random, exclude = [] } = {}) {
  return shortlistTemplates({ ...ctx, text }, { n: 1, rand, exclude })[0];
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n + 1).replace(/\s+\S*$/, '');
  return cut.length >= 3 ? cut : t.slice(0, n);
};

/** Split text across a template's caption slots (fallback when no LLM fill is available). */
export function autoCaptions(t, text) {
  const req = t.slots.filter((s) => !s.optional);
  const parts = String(text ?? '').replace(/https?:\S+/g, '')
    .split(/(?<=[.!?;])\s+|\s+(?:vs\.?|versus|\/|—|-)\s+|\n+/i).map((x) => x.trim()).filter(Boolean);
  while (parts.length < req.length && parts.some((p) => p.includes(', '))) {
    const i = parts.findIndex((p) => p.includes(', '));
    const [a, ...b] = parts[i].split(', ');
    parts.splice(i, 1, a, b.join(', '));
  }
  const captions = {};
  req.forEach((s, i) => { captions[s.name] = clip(parts[i] ?? parts[parts.length - 1] ?? 'me', s.max) || 'me'; });
  return captions;
}
