import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_ARCHETYPES, REPLY_ARCHETYPES, ALL_TYPES } from './archetypes.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PERSONAS_DIR = path.join(ROOT, 'personas');
export const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const REQUIRED_PERSONA_FIELDS = [
  'id', 'kind', 'name', 'handle', 'avatar', 'lifespan', 'region', 'tradition', 'school', 'headline', 'bio', 'location', 'background',
  'core_ideas', 'key_works', 'voice', 'favorite_topics', 'pet_peeves', 'post_archetypes',
  'reply_archetypes', 'argument_style', 'news_lens', 'allies', 'rivals', 'never', 'sample_posts', 'reaction_pool',
  'modernity', 'reactivity', 'topic_affinity', 'native_language', 'sensitive_notes', 'quotables', 'sources',
  'search_hints', 'tools', 'system_prompt',
];

export const TOPIC_KEYS = ['politics', 'world', 'tech', 'science', 'economy', 'culture', 'sports', 'religion', 'memes'];
export const PERSONA_TOOLS = ['search_sources', 'get_quote', 'search_news'];
// thinker = real deceased person; parody = fictional/abstract/historical-joke account; news = neutral fictional newswire.
export const PERSONA_KINDS = ['thinker', 'parody', 'news'];
export const HANDLE_RE = /^[A-Za-z0-9_]{4,15}$/;
// Field of a thinker (required for kind=thinker).
export const PERSONA_DOMAINS = ['philosophy', 'science', 'mathematics', 'technology', 'psychology', 'economics', 'strategy', 'politics', 'literature', 'arts', 'religion', 'medicine'];
const ALWAYS_OPTIONAL = ['never', 'sensitive_notes'];
const NON_THINKER_OPTIONAL = ['allies', 'rivals', 'quotables', 'key_works', 'native_language'];
export const REACTION_STANCES = ['agree', 'disagree', 'mock', 'awe', 'confused', 'hype'];
const REACTION_KINDS = { text: 80, emoji: 12, gif_query: 60, meme_template: 100 };

// Pre-written, no-LLM micro-reactions; every one must be on brand for the persona.
function validateReactions(p, e) {
  const r = p.reaction_pool;
  if (!Array.isArray(r)) return e('reaction_pool must be an array of objects');
  const news = p.kind === 'news';
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
  if (r.length < 60 || r.length > 200) e('reaction_pool must have 60-200 entries (each is reused at most once per 14 days)');
  for (const s of REACTION_STANCES) if ((count[s] ?? 0) < 10) e(`reaction_pool needs ≥10 "${s}" reactions (has ${count[s] ?? 0})`);
  for (const k of ['gif_query', 'meme_template']) if ((count[k] ?? 0) < 6) e(`reaction_pool needs ≥6 ${k}`);
  for (const k of ['text', 'emoji']) if (!count[k]) e(`reaction_pool needs at least one ${k}`);
}

function optionalFor(p, k) {
  return ALWAYS_OPTIONAL.includes(k) || (p.kind !== 'thinker' && NON_THINKER_OPTIONAL.includes(k));
}

function validateSkill(p, errors) {
  const e = (m) => errors.push(`persona ${p.id}: ${m}`);
  if (!PERSONA_KINDS.includes(p.kind)) e(`kind must be one of ${PERSONA_KINDS.join('|')}`);
  if (p.kind === 'thinker' && !PERSONA_DOMAINS.includes(p.domain)) e(`thinkers need domain: ${PERSONA_DOMAINS.join('|')}`);
  if (p.domain !== undefined && p.kind !== 'thinker') e('only thinkers have a domain');
  if (p.reaction_pool !== undefined) validateReactions(p, e);
  if (typeof p.handle === 'string' && !HANDLE_RE.test(p.handle)) e(`handle "${p.handle}" must be 4-15 chars of [A-Za-z0-9_] (X rules)`);
  if (p.active_hours_utc !== undefined) {
    const h = p.active_hours_utc;
    if (!(Array.isArray(h) && h.length === 2 && h.every((x) => Number.isInteger(x) && x >= 0 && x <= 24))) e('active_hours_utc must be [startHour, endHour] in 0-24');
  }
  if (p.kind === 'news' && !(p.post_archetypes?.length === 1 && p.post_archetypes[0] === 'news_wire')) e('news accounts must use only the news_wire post archetype');
  if (p.kind !== 'news' && p.post_archetypes?.includes('news_wire')) e('only news accounts may use news_wire');
  if (typeof p.bio === 'string' && [...p.bio].length > 160) e(`bio must be ≤160 chars (X limit), got ${[...p.bio].length}`);
  if (typeof p.location === 'string' && [...p.location].length > 30) e(`location must be ≤30 chars (X limit), got ${[...p.location].length}`);
  for (const k of ['modernity', 'reactivity']) {
    if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 5)) e(`${k} must be an integer 1-5`);
  }
  if (p.topic_affinity) {
    for (const k of TOPIC_KEYS) {
      const v = p.topic_affinity[k];
      if (typeof v !== 'number' || v < 0 || v > 1) e(`topic_affinity.${k} must be a number 0-1`);
    }
    for (const k of Object.keys(p.topic_affinity)) if (!TOPIC_KEYS.includes(k)) e(`unknown topic_affinity key ${k}`);
  }
  if (p.native_language && !(p.native_language.name && p.native_language.phrases?.every((x) => x.text && x.translation))) {
    e('native_language needs name and phrases[{text, translation}]');
  }
  for (const q of p.quotables ?? []) {
    if (!q.text || !q.citation || !/^https:\/\//.test(q.source_url ?? '')) e(`quotable needs text, citation, https source_url: ${q.text?.slice(0, 40)}`);
  }
  for (const s of p.sources ?? []) {
    if (!s.title || !['primary', 'reference'].includes(s.kind) || !/^https:\/\//.test(s.url ?? '')) e(`bad source: ${s.title ?? s.url}`);
  }
  if (p.sources && !p.sources.some((s) => s.reading_list)) e('at least one source must have reading_list: true');
  for (const t of p.tools ?? []) if (!PERSONA_TOOLS.includes(t)) e(`unknown tool ${t}`);
  if (p.system_prompt && !(Array.isArray(p.system_prompt) && p.system_prompt.every((x) => typeof x === 'string' && x.trim()))) {
    e('system_prompt must be an array of non-empty strings');
  }
}

const kindRank = (p) => Math.max(0, PERSONA_KINDS.indexOf(p.kind));

export function loadPersonas(dir = PERSONAS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      p._file = f;
      return p;
    })
    .sort((a, b) => kindRank(a) - kindRank(b) || (a.born ?? 0) - (b.born ?? 0) || a.name.localeCompare(b.name));
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

export function validate(personas, posts) {
  const errors = [];
  const ids = new Set();
  const handles = new Set();
  for (const p of personas) {
    for (const k of REQUIRED_PERSONA_FIELDS) {
      if (optionalFor(p, k) ? p[k] === undefined : p[k] === undefined || p[k] === null || (Array.isArray(p[k]) && p[k].length === 0)) {
        errors.push(`persona ${p._file}: missing "${k}"`);
      }
    }
    validateSkill(p, errors);
    if (p._file !== `${p.id}.json`) errors.push(`persona ${p._file}: filename must be ${p.id}.json`);
    if (ids.has(p.id)) errors.push(`duplicate persona id ${p.id}`);
    if (handles.has(String(p.handle).toLowerCase())) errors.push(`duplicate handle ${p.handle}`);
    ids.add(p.id);
    handles.add(String(p.handle).toLowerCase());
    for (const a of p.post_archetypes ?? []) if (!POST_ARCHETYPES[a]) errors.push(`persona ${p.id}: unknown post archetype ${a}`);
    for (const a of p.reply_archetypes ?? []) if (!REPLY_ARCHETYPES[a]) errors.push(`persona ${p.id}: unknown reply archetype ${a}`);
    for (const img of [p.avatar?.image, p.avatar?.banner, ...Object.values(p.avatar?.srcset ?? {})].filter(Boolean)) {
      if (!fs.existsSync(path.join(ROOT, 'public', img))) errors.push(`persona ${p.id}: missing image ${img}`);
    }
    if (p.avatar?.image && !p.attribution?.author && !p.attribution?.source) errors.push(`persona ${p.id}: image without attribution`);
    if (p.attribution?.source && !(p.attribution.license && p.attribution.author)) errors.push(`persona ${p.id}: attribution needs license and author`);
  }
  for (const p of personas) {
    for (const rel of [...(p.allies ?? []), ...(p.rivals ?? [])]) {
      if (!ids.has(rel.id)) errors.push(`persona ${p.id}: relation to unknown persona ${rel.id}`);
      if (rel.id === p.id) errors.push(`persona ${p.id}: relation to self`);
    }
  }
  const postIds = new Set();
  for (const post of posts) {
    if (!post.id) errors.push(`post without id in ${post._file}`);
    if (postIds.has(post.id)) errors.push(`duplicate post id ${post.id}`);
    postIds.add(post.id);
  }
  for (const post of posts) {
    const where = `post ${post.id} (${post._file})`;
    if (!ids.has(post.authorId)) errors.push(`${where}: unknown author ${post.authorId}`);
    if (!post.text || typeof post.text !== 'string') errors.push(`${where}: empty text`);
    else if ([...post.text].length > 320) errors.push(`${where}: text too long (${[...post.text].length})`);
    if (!ALL_TYPES[post.type]) errors.push(`${where}: unknown type ${post.type}`);
    const author = personas.find((p) => p.id === post.authorId);
    if (post.type === 'news_wire' && !(author?.kind === 'news' && post.news?.url)) errors.push(`${where}: news_wire posts need a news author and news.url`);
    if (author?.kind === 'news' && post.type !== 'news_wire') errors.push(`${where}: news accounts only post news_wire`);
    if (Number.isNaN(Date.parse(post.createdAt))) errors.push(`${where}: bad createdAt`);
    if (post.inReplyTo && !postIds.has(post.inReplyTo)) errors.push(`${where}: inReplyTo missing ${post.inReplyTo}`);
    if (post.quoteOf && !postIds.has(post.quoteOf)) errors.push(`${where}: quoteOf missing ${post.quoteOf}`);
  }
  return errors;
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
