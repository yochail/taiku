// @handle vs plain name (spec.sampling.mentions.handle_vs_name). On X, direct address and dunks mostly
// use the clickable @handle; third-person talk often keeps the name. This module finds persona names in
// a taik, classifies each as "address" (vocative / aimed at the reply or quote target) or "about", and
// converts the first occurrence per persona to its @handle with the spec's probability. Deterministic:
// callers pass a seeded decide() so reruns reproduce the same text.
import { loadPersonas, taikLength } from './data.mjs';
import { seededRng } from './pipeline-util.mjs';

const fold = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L');
// Name parts that are ordinary words or places, never a reference on their own.
const STOP = new Set(['truth', 'daily', 'ratio', 'actually', 'arrow', 'cave', 'memes', 'minerva', 'bingen', 'alexandria', 'well', 'quote', 'stoic', 'philosophy', 'the', 'owl', 'tesla']);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name variants per persona (full name, parenthetical alias, "X of Y" → X, surname, chosen mononym), unambiguous only. */
export function nameIndex(personas) {
  const cand = new Map();
  for (const p of personas) {
    if (!p?.handle || p.kind === 'news') continue;
    const full = String(p.name ?? '').trim();
    const bare = full.replace(/\s*\(.*?\)\s*/g, ' ').trim();
    const v = new Set([full, bare]);
    for (const m of full.matchAll(/\(([^)]+)\)/g)) v.add(m[1].trim());
    if (/\sof\s/.test(bare)) v.add(bare.split(/\sof\s/)[0]);
    const toks = bare.split(/[\s]+/);
    if (p.kind !== 'parody' && toks.length > 1) {
      const last = toks.at(-1);
      v.add(last);
      if (last.includes('-') && !/^(al|ibn)-/i.test(last)) v.add(last.split('-').at(-1));
    }
    // A mononym the account itself goes by on X ("Galileo 🔭 | …", "Kant | …", "Pooh 🍯").
    const dn = String(p.x_profile?.display_name ?? p.display_name ?? '').match(/^([\p{L}][\p{L}'’-]*)(?:$|\s+[^\p{L}])/u)?.[1];
    if (dn && (dn === toks[0] || dn === toks.at(-1) || p.kind !== 'thinker')) v.add(dn);
    for (const x of [...v]) v.add(fold(x));
    for (const x of v) {
      if (x.length < 4 || STOP.has(x.toLowerCase()) || (p.kind === 'parody' && x !== full)) continue;
      if (p.kind === 'parody' && /\s/.test(x)) continue;
      const k = x.toLowerCase();
      cand.set(k, cand.has(k) && cand.get(k).id !== p.id ? { ambiguous: true } : { id: p.id, handle: p.handle, name: x });
    }
  }
  const byId = new Map();
  for (const e of cand.values()) if (!e.ambiguous) (byId.get(e.id) ?? byId.set(e.id, { id: e.id, handle: e.handle, names: [] }).get(e.id)).names.push(e.name);
  for (const e of byId.values()) {
    e.names.sort((a, b) => b.length - a.length);
    e.re = new RegExp(`(?<![\\p{L}\\p{N}_@/.#])(?:${e.names.map(escRe).join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  }
  return [...byId.values()];
}

let cached = null;
/** Index for the current site's personas (cached). */
export function siteNameIndex() {
  return (cached ??= nameIndex(loadPersonas()));
}

/** Character ranges inside double quotes (a quoted passage keeps its names verbatim). */
function quotedSpans(text) {
  const out = [];
  for (const m of text.matchAll(/"[^"\n]{2,}"|“[^”]{2,}”/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

const PRE_VOC = /(?:^|[\s(])(?:hey|hi|oh|ok|okay|dear|sorry|look|listen|yo|no|yes|nah|congrats|thanks|thank you|bro|sir|madam|dude|ahem|cc|paging|calling|attn:?|sure|nice try|come on|imagine|ratio(?:'d)?|lol|lmao|wow|ugh|bless you|right|cope|seethe)[,!.]?\s+$/i;
const POST_VOC = /^(?:'s)?\s*,?\s+(?:you|u|your|ur|you're|ur)\b/i;

/** "address" when the name is spoken to (vocative, or the persona is the reply/quote target), else "about". */
export function classifyRef(text, start, end, { isTarget = false } = {}) {
  if (isTarget) return 'address';
  const before = text.slice(0, start);
  const after = text.slice(end);
  if (PRE_VOC.test(before)) return 'address';
  if (POST_VOC.test(after)) return 'address';
  const sentenceStart = /(?:^|[.!?…]\s+|\n)\s*$/.test(before);
  if (sentenceStart && /^\s*[,:]\s/.test(after)) return 'address';
  if (/,\s*$/.test(before) && /^\s*[?!.]*\s*(?:[\p{Extended_Pictographic}\s]*)$/u.test(after)) return 'address';
  return 'about';
}

/**
 * Convert persona names to @handles. opts: { index, authorId, targetId, decide(personaId, kind) → bool,
 * maxChars, only: 'address' | null }. Returns { text, converted: [{ id, kind }] }.
 */
export function applyHandleStyle(text, { index = siteNameIndex(), authorId = null, targetId = null, decide, maxChars = 280, only = null } = {}) {
  let out = String(text ?? '');
  const converted = [];
  for (const e of index) {
    if (e.id === authorId) continue;
    if (new RegExp(`(^|[^\\w])@${escRe(e.handle)}\\b`, 'i').test(out)) continue;
    const spans = quotedSpans(out);
    e.re.lastIndex = 0;
    let hit = null;
    for (const m of out.matchAll(e.re)) {
      if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      hit = m;
      break;
    }
    if (!hit) continue;
    const kind = classifyRef(out, hit.index, hit.index + hit[0].length, { isTarget: e.id === targetId });
    if (only && kind !== only) continue;
    if (!decide(e.id, kind)) continue;
    const next = out.slice(0, hit.index) + '@' + e.handle + out.slice(hit.index + hit[0].length);
    if (taikLength(next) > maxChars) continue;
    out = next;
    converted.push({ id: e.id, kind });
  }
  return { text: out, converted };
}

/** Rates from the spec (address ~0.75, about ~0.35 by default). */
export function handleRates(spec) {
  const r = spec?.sampling?.mentions?.handle_vs_name ?? {};
  return { address: r.address ?? 0.75, about: r.about ?? 0.35 };
}

/** Seeded decide() for one post: the same (seed, post, persona, kind) always gives the same answer. */
export function seededDecide(rates, ...seed) {
  return (pid, kind) => seededRng('handle', ...seed, pid, kind)() < (rates[kind] ?? 0);
}

/** @handles in text that resolve to nobody (known: Set of lower-case handles). */
export function unresolvedHandles(text, known) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(^|[^\w/&.])@([A-Za-z0-9_]{2,30})\b/g)) if (!known.has(m[2].toLowerCase())) out.push(m[2]);
  return out;
}

/** Drop the "@" from handles that resolve to nobody (invented accounts never become links). */
export function unlinkUnknown(text, known) {
  return String(text ?? '').replace(/(^|[^\w/&.])@([A-Za-z0-9_]{2,30})\b/g, (all, pre, h) => (known.has(h.toLowerCase()) ? all : `${pre}${h}`));
}
