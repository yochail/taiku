import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_ARCHETYPES, REPLY_ARCHETYPES, ALL_TYPES } from './archetypes.mjs';
import { validateSchema, loadSchema } from './schema.mjs';
import { findTells } from './tells.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PERSONAS_DIR = path.join(ROOT, 'personas');
export const POSTS_DIR = path.join(ROOT, 'content', 'posts');

// ---------------------------------------------------------------------------
// Length: X's weighted count (twitter-text v3): most Latin/Greek/Cyrillic/Hebrew/Arabic
// code points weigh 1; CJK, emoji and everything else weigh 2. NFC-normalised first.
// Hard limit; overlong taiks are rejected and regenerated, never truncated.
export const MAX_TAIK_CHARS = 280;
const LIGHT_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
export function taikLength(text) {
  let n = 0;
  for (const ch of String(text ?? '').normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / ZWJ glue of emoji sequences
    n += LIGHT_RANGES.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
  }
  return n;
}

// Types with structural rules.
export const QUOTE_TYPES = new Set(['quote_take', 'quote_dunk']);
/** Archetypes are internal style labels: any type may be a reply except these structural ones. */
export const NEVER_REPLY_TYPES = new Set(['poll', 'retaik']);
export const MAX_THREAD_PARTS = 5; // root + 4 continuations
export const MAX_REPLY_DEPTH = 12;
/** Quotation-marked spans with at least this many words must be backed by quoteRefs. */
export const QUOTE_MIN_WORDS = 6;

// ---------------------------------------------------------------------------
export function loadPersonas(dir = PERSONAS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      p._file = f;
      return p;
    })
    .sort((a, b) => (a.born ?? 0) - (b.born ?? 0) || a.name.localeCompare(b.name));
}

export function listPostFiles(dir = POSTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
}

export function loadPosts(dir = POSTS_DIR) {
  const posts = [];
  for (const f of listPostFiles(dir)) {
    const batch = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const p of batch.posts ?? batch) {
      posts.push({ ...p, _file: f });
    }
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Local public-domain sources (sources/<personaId>/<file>.txt), whitespace-normalised.
const normWs = (s) => String(s).normalize('NFC').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
export { normWs as normalizeQuoteText };
const sourceCache = new Map();
export function readSourceText(relPath) {
  if (!relPath) return null;
  if (!sourceCache.has(relPath)) {
    const abs = path.join(ROOT, relPath);
    sourceCache.set(relPath, fs.existsSync(abs) ? normWs(fs.readFileSync(abs, 'utf8')) : null);
  }
  return sourceCache.get(relPath);
}

/** Is `text` a verbatim span of a quotable local source of persona `p` (optionally a specific sourceId)? */
export function verifyQuote(p, text, sourceId = null) {
  if (!p || p.quote_policy !== 'quote_bank') return false;
  const needle = normWs(text);
  if (needle.length < 10) return false;
  return (p.sources ?? []).some((s) => s.quotable && s.local && (!sourceId || s.id === sourceId) && (readSourceText(s.local) ?? '').includes(needle));
}

// ---------------------------------------------------------------------------
// Fuzzy quote matching for TRANSLATED sources (translations vary slightly). Original-language
// sources must match exactly. Guard: negations and numbers must match the passage exactly
// before similarity is even considered (so "not" can't be dropped and numbers can't change).
export const QUOTE_FUZZY_THRESHOLD = Number(process.env.QUOTE_FUZZY_THRESHOLD || 0.85);
const NEGATIONS = new Set(['not', 'no', 'never', 'nor', 'neither', 'none', 'nothing', 'nobody', 'nowhere', 'without', 'cannot', "can't", "don't", "doesn't", "isn't", "aren't", "wasn't", "weren't", "won't", "wouldn't", "shouldn't", "couldn't", "mustn't", "hasn't", "haven't", "hadn't", "didn't", "ain't", 'nay', 'nought', 'naught']);
const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand', 'million', 'first', 'second', 'third', 'half', 'once', 'twice']);
export function quoteNormalize(s) {
  return normWs(s).toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').replace(/'(?![a-z])|(?<![a-z])'/g, ' ').replace(/\s+/g, ' ').trim();
}
const guardTokens = (s) => quoteNormalize(s).split(' ').filter((w) => NEGATIONS.has(w) || w.endsWith("n't") || NUMBER_WORDS.has(w) || /\d/.test(w)).sort().join('|');
function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function quoteSimilarity(a, b) {
  const x = quoteNormalize(a);
  const y = quoteNormalize(b);
  if (!x.length && !y.length) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}
/**
 * Does the quoted `span` faithfully reproduce `canonical` (an exact passage text)?
 * Exact (whitespace/quote-normalised) always passes; fuzzy only when `translated`, with the
 * negation/number guard and the similarity threshold.
 */
export function quoteMatches(span, canonical, { translated = false, threshold = QUOTE_FUZZY_THRESHOLD } = {}) {
  if (normWs(span) === normWs(canonical)) return { ok: true, similarity: 1, exact: true };
  if (!translated) return { ok: false, similarity: quoteSimilarity(span, canonical), reason: 'original-language source requires an exact quote' };
  if (guardTokens(span) !== guardTokens(canonical)) return { ok: false, similarity: quoteSimilarity(span, canonical), reason: 'negations/numbers differ from the passage' };
  const similarity = quoteSimilarity(span, canonical);
  return similarity >= threshold ? { ok: true, similarity, exact: false } : { ok: false, similarity, reason: `similarity ${similarity.toFixed(2)} < ${threshold}` };
}
export function isTranslatedSource(src) {
  return Boolean(src?.translator);
}

/** Quotation-marked spans of ≥ QUOTE_MIN_WORDS words (straight or curly double quotes). */
export function quotedSpans(text) {
  const out = [];
  const re = /"([^"]+)"|\u201c([^\u201d]+)\u201d/g;
  for (const m of String(text).matchAll(re)) {
    const span = (m[1] ?? m[2]).trim();
    if (span.split(/\s+/).filter(Boolean).length >= QUOTE_MIN_WORDS) out.push(span);
  }
  return out;
}

// ---------------------------------------------------------------------------
/** Allowed https URL (or null). Rejects other protocols, credentials and odd ports. */
export function safeUrl(u, { hosts = null } = {}) {
  if (typeof u !== 'string' || !u) return null;
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  if (hosts && !hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return null;
  return url.toString();
}

// ---------------------------------------------------------------------------
export const TOPIC_KEYS = ['politics', 'world', 'tech', 'science', 'economy', 'culture', 'sports', 'religion', 'memes'];
/** Final agentic tool names (persona `tools`). */
export const PERSONA_TOOLS = ['search_sources', 'get_quote', 'search_news', 'get_thread'];
export const personaKind = (p) => p?.kind ?? 'thinker';
const THINKER_FIELDS = ['lifespan', 'region', 'school', 'core_ideas', 'key_works', 'voice', 'allies', 'rivals', 'never', 'sample_posts', 'modernity', 'native_language', 'quotables', 'sources', 'post_archetypes', 'reply_archetypes'];


// thinker = real deceased person; parody = fictional/joke account; news = neutral fictional newswire.
// fictional = public-domain literary character as a philosopher (e.g. Milne's Pooh); shown with the Parody label.
export const PERSONA_KINDS = ['thinker', 'fictional', 'parody', 'news'];
export const HANDLE_RE = /^[A-Za-z0-9_]{4,15}$/;
export const PERSONA_DOMAINS = ['philosophy', 'science', 'mathematics', 'technology', 'psychology', 'economics', 'strategy', 'politics', 'literature', 'arts', 'religion', 'medicine'];
export const REACTION_STANCES = ['agree', 'disagree', 'mock', 'awe', 'confused', 'hype'];
export const REACTION_KINDS = { text: 80, emoji: 12, gif_query: 60, meme_template: 100 };
/** The single content key of a reaction_pool entry: text|emoji|gif_query|meme_template. */
export const reactionKind = (x) => Object.keys(REACTION_KINDS).find((k) => x?.[k] !== undefined);

// Pre-written, no-LLM micro-reactions (content-lead contract); each reused at most once per 14 days.
function validateReactions(p, e) {
  const r = p.reaction_pool;
  if (!Array.isArray(r)) return e('reaction_pool must be an array of objects');
  const news = personaKind(p) === 'news';
  const seen = new Set();
  const count = {};
  r.forEach((x, i) => {
    const w = `reaction_pool[${i}]`;
    if (!x || typeof x !== 'object') return e(`${w} must be an object`);
    const kinds = Object.keys(REACTION_KINDS).filter((k) => x[k] !== undefined);
    if (kinds.length !== 1) return e(`${w} needs exactly one of ${Object.keys(REACTION_KINDS).join('|')}`);
    const v = x[kinds[0]];
    if (typeof v !== 'string' || !v.trim() || [...v].length > REACTION_KINDS[kinds[0]]) e(`${w}.${kinds[0]} must be a non-empty string ≤${REACTION_KINDS[kinds[0]]} chars`);
    if (kinds[0] === 'meme_template' && !/^[^:]+: .+/.test(v)) e(`${w}.meme_template must look like "<Template>: <caption>"`);
    const key = `${kinds[0]}:${v}`;
    if (seen.has(key)) e(`${w} duplicate`);
    seen.add(key);
    const okStance = news ? x.stance === 'neutral' : REACTION_STANCES.includes(x.stance);
    if (!okStance) e(`${w}.stance must be ${news ? 'neutral (news)' : REACTION_STANCES.join('|')}`);
    if (!(Array.isArray(x.tags) && x.tags.length >= 1 && x.tags.length <= 4 && x.tags.every((t) => typeof t === 'string' && /^[a-z0-9_-]+$/.test(t)))) e(`${w}.tags must be 1-4 lowercase tags`);
    if (typeof x.tone !== 'string' || !x.tone.trim()) e(`${w}.tone required`);
    count[kinds[0]] = (count[kinds[0]] ?? 0) + 1;
    count[x.stance] = (count[x.stance] ?? 0) + 1;
  });
  if (news) {
    if (r.length < 20 || r.length > 200) e('news reaction_pool must have 20-200 entries');
    return;
  }
  if (r.length < 60 || r.length > 200) e('reaction_pool must have 60-200 entries');
  for (const s of REACTION_STANCES) if ((count[s] ?? 0) < 10) e(`reaction_pool needs ≥10 "${s}" reactions (has ${count[s] ?? 0})`);
  for (const k of ['gif_query', 'meme_template']) if ((count[k] ?? 0) < 6) e(`reaction_pool needs ≥6 ${k}`);
  for (const k of ['text', 'emoji']) if (!count[k]) e(`reaction_pool needs at least one ${k}`);
}

function validatePersonaKind(p, errors) {
  const e = (m) => errors.push(`persona ${p.id}: ${m}`);
  const kind = personaKind(p);
  if (!PERSONA_KINDS.includes(kind)) e(`kind must be one of ${PERSONA_KINDS.join('|')}`);
  if (kind === 'thinker' && p.domain !== undefined && !PERSONA_DOMAINS.includes(p.domain)) e(`domain must be one of ${PERSONA_DOMAINS.join('|')}`);
  if (p.domain !== undefined && kind !== 'thinker') e('only thinkers have a domain');
  if (p.reaction_pool !== undefined) validateReactions(p, e);
  if (typeof p.handle === 'string' && !HANDLE_RE.test(p.handle)) e(`handle "${p.handle}" must be 4-15 chars of [A-Za-z0-9_] (X rules)`);
  if (kind === 'news' && p.post_archetypes && !(p.post_archetypes.length === 1 && p.post_archetypes[0] === 'news_wire')) e('news accounts must use only the news_wire post archetype');
  if (kind !== 'news' && p.post_archetypes?.includes('news_wire')) e('only news accounts may use news_wire');
  if (p.sources && !p.sources.some((s) => s.reading_list)) e('at least one source must have reading_list: true');
  if (kind === 'thinker' && p.temperament === undefined) e('thinker missing "temperament"');
  if (p.temperament !== undefined) {
    const t = p.temperament;
    if (!(Number.isInteger(t?.heat) && t.heat >= 1 && t.heat <= 5)) e('temperament.heat must be 1-5');
    for (const k of ['baseline', 'when_triggered', 'when_losing']) if (typeof t?.[k] !== 'string' || !t[k].trim()) e(`temperament.${k} required`);
    if (!(Array.isArray(t?.triggers) && t.triggers.length >= 3)) e('temperament.triggers needs ≥3');
    if (!(Array.isArray(t?.emotional_range) && t.emotional_range.length >= 4)) e('temperament.emotional_range needs ≥4 emotions');
  }
  if (kind !== 'news') {
    (p.sample_posts ?? []).forEach((s, i) => { const t = findTells(s); if (t.length) e(`sample_posts[${i}] has AI tells: ${t.join(', ')}`); });
    (Array.isArray(p.reaction_pool) ? p.reaction_pool : []).forEach((x, i) => { const t = findTells(x?.text ?? x?.meme_template ?? ''); if (t.length) e(`reaction_pool[${i}] has AI tells: ${t.join(', ')}`); });
  }
}

/** Public-domain/verified quotable passage lookup: quote_bank (local source spans) + quotables (content-lead verified lines). */
export function findQuotable(p, id) {
  return (p?.quotables ?? []).find((q) => q.id === id) ?? null;
}

function validatePersonas(personas, errors) {
  const schema = loadSchema(ROOT, 'persona');
  const ids = new Set();
  const handles = new Set();
  for (const p of personas) {
    for (const e of validateSchema(p, schema)) errors.push(`persona ${p._file}: ${e}`);
    if (personaKind(p) === 'thinker') for (const k of THINKER_FIELDS) if (p[k] === undefined) errors.push(`persona ${p.id}: thinker missing "${k}"`);
    validatePersonaKind(p, errors);
    for (const t of p.tools ?? []) if (!PERSONA_TOOLS.includes(t)) errors.push(`persona ${p.id}: unknown tool ${t}`);
    for (const img of [p.avatar?.image, p.avatar?.banner, ...Object.values(p.avatar?.srcset ?? {})].filter(Boolean)) {
      if (!fs.existsSync(path.join(ROOT, 'public', img))) errors.push(`persona ${p.id}: missing image public${img}`);
    }
    if (p.avatar?.image && !(p.attribution?.author || p.attribution?.source)) errors.push(`persona ${p.id}: image without attribution`);
    if (p.attribution?.source && !(p.attribution.license && p.attribution.author)) errors.push(`persona ${p.id}: attribution needs license and author`);
    const qids = new Set();
    for (const q of p.quotables ?? []) {
      if (qids.has(q.id)) errors.push(`persona ${p.id}: duplicate quotable id ${q.id}`);
      qids.add(q.id);
    }
    if (p._file && p._file !== `${p.id}.json`) errors.push(`persona ${p._file}: filename must be ${p.id}.json`);
    if (ids.has(p.id)) errors.push(`duplicate persona id ${p.id}`);
    if (handles.has(String(p.handle).toLowerCase())) errors.push(`duplicate handle ${p.handle}`);
    ids.add(p.id);
    handles.add(String(p.handle).toLowerCase());
    for (const a of p.post_archetypes ?? []) if (!POST_ARCHETYPES[a]) errors.push(`persona ${p.id}: unknown post archetype ${a}`);
    for (const a of p.reply_archetypes ?? []) if (!REPLY_ARCHETYPES[a]) errors.push(`persona ${p.id}: unknown reply archetype ${a}`);
    const srcIds = new Set((p.sources ?? []).map((s) => s.id));
    for (const s of p.sources ?? []) {
      if (s.local && !s.local.startsWith(`sources/${p.id}/`)) errors.push(`persona ${p.id}: source ${s.id} local path must be under sources/${p.id}/`);
      if (s.local && !fs.existsSync(path.join(ROOT, s.local))) errors.push(`persona ${p.id}: source ${s.id} file missing: ${s.local} (run npm run sources:fetch)`);
    }
    if (p.quote_policy === 'paraphrase_only' && (p.quote_bank ?? []).length) errors.push(`persona ${p.id}: paraphrase_only persona must have an empty quote_bank`);
    const bankIds = new Set();
    for (const q of p.quote_bank ?? []) {
      if (bankIds.has(q.id)) errors.push(`persona ${p.id}: duplicate quote_bank id ${q.id}`);
      bankIds.add(q.id);
      const src = (p.sources ?? []).find((s) => s.id === q.sourceId);
      if (!src) errors.push(`persona ${p.id}: quote ${q.id} references unknown source ${q.sourceId}`);
      else if (!src.quotable || !src.local) errors.push(`persona ${p.id}: quote ${q.id} source ${q.sourceId} is not quotable/local`);
      else if (readSourceText(src.local) != null && !verifyQuote(p, q.text, q.sourceId))
        errors.push(`persona ${p.id}: quote ${q.id} is not a verbatim span of ${src.local}`);
    }
    if (!srcIds.size && p.quote_policy === 'quote_bank') errors.push(`persona ${p.id}: quote_bank policy needs at least one source`);
    if (p.died != null && p.born != null && p.died <= p.born) errors.push(`persona ${p.id}: died must be after born`);
  }
  for (const p of personas) {
    for (const rel of [...(p.allies ?? []), ...(p.rivals ?? []), ...(p.frenemies ?? [])]) {
      if (!ids.has(rel.id)) errors.push(`persona ${p.id}: relation to unknown persona ${rel.id}`);
      if (rel.id === p.id) errors.push(`persona ${p.id}: relation to self`);
    }
  }
  return ids;
}

/**
 * Validate personas + the whole post graph. Returns a list of error strings (empty = valid).
 * Rules: JSON Schema per post; ≤280 weighted chars; known author/type; type ↔ structure
 * (replies need a parent, thread parts continue the same author, quote types need quoteOf/embed,
 * polls carry a poll); graph is a DAG (no self-links, no cycles across inReplyTo/quoteOf,
 * children strictly after parents), thread/reply depth caps; quotation-marked spans must be
 * verified verbatim against the author's quotable local sources; persona refs exist.
 */
export function validate(personas, posts) {
  const errors = [];
  const ids = validatePersonas(personas, errors);
  const byPersona = new Map(personas.map((p) => [p.id, p]));
  const schema = loadSchema(ROOT, 'post');
  const byId = new Map();
  const pollIds = new Set();
  for (const post of posts) {
    if (!post.id) errors.push(`post without id in ${post._file}`);
    if (byId.has(post.id)) errors.push(`duplicate post id ${post.id}`);
    byId.set(post.id, post);
  }
  for (const post of posts) {
    const where = `post ${post.id} (${post._file})`;
    for (const e of validateSchema(post, schema)) errors.push(`${where}: ${e}`);
    if (!ids.has(post.authorId)) errors.push(`${where}: unknown author ${post.authorId}`);
    if (typeof post.text === 'string' && taikLength(post.text) > MAX_TAIK_CHARS)
      errors.push(`${where}: text too long (${taikLength(post.text)} > ${MAX_TAIK_CHARS} weighted chars)`);
    if (post.original?.text && taikLength(post.original.text) > MAX_TAIK_CHARS) errors.push(`${where}: original text too long`);
    if (!ALL_TYPES[post.type]) errors.push(`${where}: unknown type ${post.type}`);
    const mediaOnly = Array.isArray(post.media) && post.media.length > 0;
    if (post.text === '' && !mediaOnly && post.type !== 'retaik') errors.push(`${where}: empty text (allowed only for media-only replies and plain retaiks)`);
    if ((post.type === 'retaik') !== Boolean(post.retaikOf)) errors.push(`${where}: retaik type and retaikOf go together`);
    if (post.retaikOf) {
      const t = byId.get(post.retaikOf);
      if (!t) errors.push(`${where}: retaikOf missing ${post.retaikOf}`);
      else if (t.retaikOf) errors.push(`${where}: cannot retaik a retaik`);
      if (post.retaikOf === post.id) errors.push(`${where}: self-link`);
      if (post.text !== '' || post.inReplyTo || post.quoteOf || post.media?.length || post.poll) errors.push(`${where}: plain retaik must have empty text and no reply/quote/media/poll`);
    }

    // Structure by type.
    const isReplyType = Boolean(REPLY_ARCHETYPES[post.type]);
    if (post.inReplyTo === post.id || post.quoteOf === post.id) errors.push(`${where}: self-link`);
    if (post.inReplyTo && !byId.has(post.inReplyTo)) errors.push(`${where}: inReplyTo missing ${post.inReplyTo}`);
    if (post.quoteOf && !byId.has(post.quoteOf)) errors.push(`${where}: quoteOf missing ${post.quoteOf}`);
    if (post.type === 'thread' && post.inReplyTo) {
      const parent = byId.get(post.inReplyTo);
      if (parent && parent.authorId !== post.authorId) errors.push(`${where}: thread part must continue the same author`);
    } else if (NEVER_REPLY_TYPES.has(post.type) && post.inReplyTo) errors.push(`${where}: post type ${post.type} cannot be a reply`);
    if (QUOTE_TYPES.has(post.type) && !post.quoteOf && !post.embed) errors.push(`${where}: ${post.type} needs quoteOf or embed`);
    if (post.quoteOf && post.embed) errors.push(`${where}: quoteOf and embed are exclusive`);
    if ((post.type === 'poll') !== Boolean(post.poll)) errors.push(`${where}: poll type and poll object go together`);
    if (post.poll) {
      if (pollIds.has(post.poll.id)) errors.push(`${where}: duplicate poll id ${post.poll.id}`);
      pollIds.add(post.poll.id);
      const optIds = new Set();
      for (const o of post.poll.options ?? []) {
        if (optIds.has(o.id)) errors.push(`${where}: duplicate poll option id ${o.id}`);
        optIds.add(o.id);
        for (const v of o.personaVotes ?? []) if (!ids.has(v)) errors.push(`${where}: poll vote by unknown persona ${v}`);
      }
    }
    const pAuthor = byPersona.get(post.authorId);
    if (post.type === 'news_wire' && !(personaKind(pAuthor) === 'news' && (post.topic?.url || post.news?.url || post.media?.some?.((m) => m.kind === 'link_card' && m.url))))
      errors.push(`${where}: news_wire posts need a news author and a topic.url or link_card`);
    if (pAuthor && personaKind(pAuthor) === 'news' && !['news_wire', 'retaik'].includes(post.type)) errors.push(`${where}: news accounts only post news_wire (or plain retaiks)`);
    if (post.citation != null && !(typeof post.citation === 'string' && post.citation.trim().length >= 8))
      errors.push(`${where}: citation must be a source line "<quote or idea> — <author>, <work>, <section>" (rendered as a Community Note)`);

    // Persona engagement refs.
    for (const k of ['personaLikes', 'personaReposts']) {
      const seen = new Set();
      for (const pid of post[k] ?? []) {
        if (!ids.has(pid)) errors.push(`${where}: ${k} has unknown persona ${pid}`);
        if (pid === post.authorId) errors.push(`${where}: ${k} includes the author`);
        if (seen.has(pid)) errors.push(`${where}: ${k} duplicate ${pid}`);
        seen.add(pid);
      }
    }

    // Quotes: every long quoted span must be backed by a quoteRef whose `canonical` is an exact
    // span of the owner's quotable local source; `text` (as quoted) must match it exactly, or
    // fuzzily for translated sources (negation/number guard + threshold). Work + section required.
    const author = byPersona.get(post.authorId);
    for (const ref of post.quoteRefs ?? []) {
      const owner = byPersona.get(ref.personaId ?? post.authorId);
      const qt = ref.bankId ? findQuotable(owner, ref.bankId) : null;
      const src = qt ? null : owner?.sources?.find((s) => s.id === ref.sourceId);
      if (!owner) errors.push(`${where}: quoteRef owner unknown`);
      else if (qt) {
        if (normWs(qt.text) !== normWs(ref.canonical)) errors.push(`${where}: quoteRef canonical differs from quotable ${qt.id}`);
        else {
          const m = quoteMatches(ref.text, ref.canonical, { translated: !qt.lang || qt.lang === 'en' });
          if (!m.ok) errors.push(`${where}: quoteRef text does not match quotable ${qt.id} (${m.reason})`);
        }
      } else if (!src) errors.push(`${where}: quoteRef source ${ref.sourceId} unknown for ${owner.id}`);
      else if (!verifyQuote(owner, ref.canonical, ref.sourceId)) errors.push(`${where}: quoteRef canonical is not a verbatim span of ${src.local ?? src.id}: "${String(ref.canonical).slice(0, 60)}"`);
      else {
        const m = quoteMatches(ref.text, ref.canonical, { translated: isTranslatedSource(src) });
        if (!m.ok) errors.push(`${where}: quoteRef text does not match its passage (${m.reason})`);
      }
    }
    // Hand-written origins (seed/backfill/local) use quotes for dialogue and scare quotes; strict for pipeline output.
    const handWritten = ['seed', 'backfill', 'local'].includes(post.origin);
    for (const span of handWritten ? [] : quotedSpans(post.text ?? '')) {
      // Backed by a verified quoteRef, or (hand-written content) by an explicit citation line naming the work.
      const ok = (post.quoteRefs ?? []).some((r) => normWs(r.text).includes(normWs(span))) || (typeof post.citation === 'string' && quoteNormalize(post.citation).includes(quoteNormalize(span)));
      if (!ok) errors.push(`${where}: quoted span not backed by a verified quoteRef${author?.quote_policy === 'paraphrase_only' ? ' (author is paraphrase_only)' : ''}: "${span.slice(0, 60)}"`);
    }
  }

  // Graph: chronology, DAG, depth caps.
  for (const post of posts) {
    const where = `post ${post.id} (${post._file})`;
    for (const k of ['inReplyTo', 'quoteOf', 'retaikOf']) {
      const target = byId.get(post[k]);
      if (target && Date.parse(post.createdAt) <= Date.parse(target.createdAt)) errors.push(`${where}: must be created after its ${k} target ${target.id}`);
    }
    const seen = new Set([post.id]);
    const stack = [post.inReplyTo, post.quoteOf].filter(Boolean);
    let cyc = false;
    while (stack.length && !cyc) {
      const id = stack.pop();
      if (id === post.id) cyc = true;
      else if (!seen.has(id) && byId.has(id)) {
        seen.add(id);
        const t = byId.get(id);
        stack.push(...[t.inReplyTo, t.quoteOf].filter(Boolean));
      }
    }
    if (cyc) errors.push(`${where}: cycle in reply/quote graph`);
    let depth = 0;
    let threadParts = 1;
    let cur = post;
    const visited = new Set();
    while (cur?.inReplyTo && !visited.has(cur.id) && depth <= MAX_REPLY_DEPTH + 1) {
      visited.add(cur.id);
      if (cur.type === 'thread') threadParts++;
      cur = byId.get(cur.inReplyTo);
      depth++;
    }
    if (depth > MAX_REPLY_DEPTH) errors.push(`${where}: reply depth > ${MAX_REPLY_DEPTH}`);
    if (post.type === 'thread' && threadParts > MAX_THREAD_PARTS) errors.push(`${where}: thread longer than ${MAX_THREAD_PARTS} parts`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
/** Build clock: BUILD_NOW env (ISO) for tests/deploys, else real now. */
export function buildNow(env = process.env) {
  const v = env.BUILD_NOW;
  const t = v ? Date.parse(v) : Date.now();
  if (Number.isNaN(t)) throw new Error(`Invalid BUILD_NOW: ${v}`);
  return new Date(t);
}

/**
 * Drip release: posts dated after `now` are hidden, and so is anything hanging off a hidden post
 * (replies to it, quotes of it). Persona likes/reposts and poll votes by hidden-time activity stay
 * (they are counts, not content). Use this single list for EVERY surface (HTML, JSON-LD, RSS, sitemap).
 */
export function visiblePosts(posts, now = buildNow()) {
  const t = now.getTime();
  const byId = new Map(posts.map((p) => [p.id, p]));
  const memo = new Map();
  const visible = (p, guard = new Set()) => {
    if (memo.has(p.id)) return memo.get(p.id);
    if (guard.has(p.id)) return false;
    guard.add(p.id);
    let ok = Date.parse(p.createdAt) <= t;
    for (const k of ['inReplyTo', 'quoteOf', 'retaikOf']) {
      if (ok && p[k]) {
        const target = byId.get(p[k]);
        ok = Boolean(target) && visible(target, guard);
      }
    }
    memo.set(p.id, ok);
    return ok;
  };
  return posts.filter((p) => visible(p));
}

export function indexPosts(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const children = new Map();
  const quotes = new Map();
  for (const p of posts) {
    if (p.inReplyTo) {
      if (!children.has(p.inReplyTo)) children.set(p.inReplyTo, []);
      children.get(p.inReplyTo).push(p);
    }
    if (p.quoteOf) {
      if (!quotes.has(p.quoteOf)) quotes.set(p.quoteOf, []);
      quotes.get(p.quoteOf).push(p);
    }
  }
  const byTime = (a, b) => a.createdAt.localeCompare(b.createdAt);
  for (const list of children.values()) list.sort(byTime);
  const rootOf = (p) => {
    let cur = p;
    const seen = new Set();
    while (cur.inReplyTo && byId.has(cur.inReplyTo) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.inReplyTo);
    }
    return cur;
  };
  const ancestors = (p) => {
    const chain = [];
    let cur = p;
    while (cur.inReplyTo && byId.has(cur.inReplyTo)) {
      cur = byId.get(cur.inReplyTo);
      chain.unshift(cur);
    }
    return chain;
  };
  const descendants = (p) => {
    const out = [];
    const walk = (x) => {
      for (const c of children.get(x.id) ?? []) {
        out.push(c);
        walk(c);
      }
    };
    walk(p);
    return out;
  };
  /** Continuation parts of a self-thread (🧵) by the same author. */
  const selfThread = (p) => {
    const parts = [];
    let cur = p;
    for (;;) {
      const next = (children.get(cur.id) ?? []).find((c) => c.authorId === p.authorId && c.type === 'thread');
      if (!next) break;
      parts.push(next);
      cur = next;
    }
    return parts;
  };
  return { byId, children, quotes, rootOf, ancestors, descendants, selfThread };
}

// pipeline helpers (appended by the generate pipeline; validates one reaction_pool entry with the same rules)
export function reactionEntryProblems(entry, persona = {}) {
  const errs = [];
  validateReactions({ kind: personaKind(persona), reaction_pool: [entry] }, (m) => errs.push(m));
  return errs.filter((m) => !/must have \d|needs ≥|needs at least/.test(m));
}
