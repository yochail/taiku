import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POST_ARCHETYPES, REPLY_ARCHETYPES, ALL_TYPES } from './archetypes.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PERSONAS_DIR = path.join(ROOT, 'personas');
export const POSTS_DIR = path.join(ROOT, 'content', 'posts');

const REQUIRED_PERSONA_FIELDS = [
  'id', 'name', 'handle', 'avatar', 'lifespan', 'region', 'tradition', 'school', 'headline', 'bio',
  'core_ideas', 'key_works', 'voice', 'favorite_topics', 'pet_peeves', 'post_archetypes',
  'reply_archetypes', 'argument_style', 'news_lens', 'allies', 'rivals', 'never', 'sample_posts',
  'modernity', 'reactivity', 'topic_affinity', 'native_language', 'sensitive_notes', 'quotables', 'sources',
  'search_hints', 'tools', 'system_prompt',
];

export const TOPIC_KEYS = ['politics', 'world', 'tech', 'science', 'economy', 'culture', 'sports', 'religion', 'memes'];
export const PERSONA_TOOLS = ['search_sources', 'get_quote', 'search_news'];

function validateSkill(p, errors) {
  const e = (m) => errors.push(`persona ${p.id}: ${m}`);
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

export function validate(personas, posts) {
  const errors = [];
  const ids = new Set();
  const handles = new Set();
  for (const p of personas) {
    for (const k of REQUIRED_PERSONA_FIELDS) {
      if (p[k] === undefined || p[k] === null || (Array.isArray(p[k]) && p[k].length === 0 && !['never', 'sensitive_notes'].includes(k))) {
        errors.push(`persona ${p._file}: missing "${k}"`);
      }
    }
    validateSkill(p, errors);
    if (p._file !== `${p.id}.json`) errors.push(`persona ${p._file}: filename must be ${p.id}.json`);
    if (ids.has(p.id)) errors.push(`duplicate persona id ${p.id}`);
    if (handles.has(p.handle)) errors.push(`duplicate handle ${p.handle}`);
    ids.add(p.id);
    handles.add(p.handle);
    for (const a of p.post_archetypes ?? []) if (!POST_ARCHETYPES[a]) errors.push(`persona ${p.id}: unknown post archetype ${a}`);
    for (const a of p.reply_archetypes ?? []) if (!REPLY_ARCHETYPES[a]) errors.push(`persona ${p.id}: unknown reply archetype ${a}`);
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
