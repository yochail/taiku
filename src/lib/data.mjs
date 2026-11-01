import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_ARCHETYPES, REPLY_ARCHETYPES, ALL_TYPES } from './archetypes.mjs';
import { validateSchema, loadSchema } from './schema.mjs';

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
function validatePersonas(personas, errors) {
  const schema = loadSchema(ROOT, 'persona');
  const ids = new Set();
  const handles = new Set();
  for (const p of personas) {
    for (const e of validateSchema(p, schema)) errors.push(`persona ${p._file}: ${e}`);
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

    // Structure by type.
    const isReplyType = Boolean(REPLY_ARCHETYPES[post.type]);
    if (post.inReplyTo === post.id || post.quoteOf === post.id) errors.push(`${where}: self-link`);
    if (post.inReplyTo && !byId.has(post.inReplyTo)) errors.push(`${where}: inReplyTo missing ${post.inReplyTo}`);
    if (post.quoteOf && !byId.has(post.quoteOf)) errors.push(`${where}: quoteOf missing ${post.quoteOf}`);
    if (isReplyType && !post.inReplyTo) errors.push(`${where}: reply type ${post.type} needs inReplyTo`);
    if (post.type === 'thread' && post.inReplyTo) {
      const parent = byId.get(post.inReplyTo);
      if (parent && parent.authorId !== post.authorId) errors.push(`${where}: thread part must continue the same author`);
    } else if (!isReplyType && post.type !== 'thread' && post.inReplyTo) errors.push(`${where}: post type ${post.type} cannot be a reply`);
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
    if (post.citation) errors.push(`${where}: legacy "citation" is not allowed; use quoteRefs (verbatim) or a Community Note`);

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
      const src = owner?.sources?.find((s) => s.id === ref.sourceId);
      if (!owner) errors.push(`${where}: quoteRef owner unknown`);
      else if (!src) errors.push(`${where}: quoteRef source ${ref.sourceId} unknown for ${owner.id}`);
      else if (!verifyQuote(owner, ref.canonical, ref.sourceId)) errors.push(`${where}: quoteRef canonical is not a verbatim span of ${src.local ?? src.id}: "${String(ref.canonical).slice(0, 60)}"`);
      else {
        const m = quoteMatches(ref.text, ref.canonical, { translated: isTranslatedSource(src) });
        if (!m.ok) errors.push(`${where}: quoteRef text does not match its passage (${m.reason})`);
      }
    }
    for (const span of quotedSpans(post.text ?? '')) {
      const ok = (post.quoteRefs ?? []).some((r) => normWs(r.text).includes(normWs(span)));
      if (!ok) errors.push(`${where}: quoted span not backed by a verified quoteRef${author?.quote_policy === 'paraphrase_only' ? ' (author is paraphrase_only)' : ''}: "${span.slice(0, 60)}"`);
    }
  }

  // Graph: chronology, DAG, depth caps.
  for (const post of posts) {
    const where = `post ${post.id} (${post._file})`;
    for (const k of ['inReplyTo', 'quoteOf']) {
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
    for (const k of ['inReplyTo', 'quoteOf']) {
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
