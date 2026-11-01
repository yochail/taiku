#!/usr/bin/env node
// Batch content generator: writes new posts + reply/debate threads to content/posts/<stamp>.json.
//
//   node src/generate.mjs                 # live (needs LLM_API_KEY or GITHUB_TOKEN)
//   node src/generate.mjs --mock          # offline placeholder content, written to disk
//   node src/generate.mjs --dry-run       # offline, prints what would be written, writes nothing
//   options: --posts N  --replies N  --wire N (newswire headline posts)  --seed S  --live (use real LLM even with --dry-run)
import fs from 'node:fs';
import path from 'node:path';
import { POSTS_DIR, loadPersonas, loadPosts, validate, indexPosts } from './lib/data.mjs';
import { POST_ARCHETYPES, REPLY_ARCHETYPES } from './lib/archetypes.mjs';
import { createLlmProvider, llmConfig, parseJson } from './lib/llm.mjs';
import { createMockProvider } from './lib/mock.mjs';
import { fetchHeadlines, MOCK_HEADLINES } from './lib/news.mjs';
import { postMessages, replyMessages } from './lib/prompts.mjs';
import { findTells, scrubTells } from './lib/tells.mjs';
import { rng, pick, weightedPick, newId, slugify } from './lib/util.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const DRY = flag('dry-run');
const cfg = llmConfig();
const MOCK = flag('mock') || (DRY && !flag('live'));
const N_POSTS = Number(opt('posts', process.env.GEN_POSTS ?? 3));
const N_REPLIES = Number(opt('replies', process.env.GEN_REPLIES ?? 7));
const N_WIRE = Number(opt('wire', process.env.GEN_WIRE ?? 3));
const SEED = opt('seed', process.env.GEN_SEED ?? String(Date.now()));
const rand = rng(SEED);

if (!MOCK && !cfg.apiKey) {
  console.error('No LLM key found (LLM_API_KEY or GITHUB_TOKEN). Use --mock or --dry-run for offline runs.');
  process.exit(1);
}
const provider = MOCK ? createMockProvider(SEED) : createLlmProvider(cfg);

const personas = loadPersonas();
const byId = new Map(personas.map((p) => [p.id, p]));
const existing = loadPosts();
const errs = validate(personas, existing);
if (errs.length) {
  console.error('Existing content invalid:\n  ' + errs.join('\n  '));
  process.exit(1);
}
const all = existing.map(({ _file, ...p }) => p);
const created = [];
const now = Date.now();
const HOUR = 3600_000;

// ---------- selection helpers ----------

function relation(a, b) {
  const pa = byId.get(a);
  const pb = byId.get(b);
  if (pa.rivals.some((r) => r.id === b) || pb.rivals.some((r) => r.id === a)) return 'rival';
  if (pa.allies.some((r) => r.id === b) || pb.allies.some((r) => r.id === a)) return 'ally';
  return 'any';
}

function lastPostedAt(personaId) {
  let t = 0;
  for (const p of all) if (p.authorId === personaId) t = Math.max(t, Date.parse(p.createdAt));
  return t;
}

function isActive(p) {
  if (!p.active_hours_utc) return true;
  const [start, end] = p.active_hours_utc;
  const h = new Date(now).getUTCHours();
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

// Opinion accounts: thinkers + parody (news wires never post opinions or reply).
const voices = personas.filter((p) => p.kind !== 'news');
const wires = personas.filter((p) => p.kind === 'news');

function chooseAuthor(exclude) {
  return weightedPick(
    rand,
    voices.filter((p) => !exclude.has(p.id) && isActive(p)),
    (p) => (p.popularity ?? 5) * (p.kind === 'parody' ? 0.5 : p.kind === 'fictional' ? 0.7 : 1) * Math.min(6, 1 + (now - lastPostedAt(p.id)) / (12 * HOUR)),
  );
}

const idxOf = () => indexPosts(all);

function depth(p, idx) {
  return idx.ancestors(p).length;
}

function recentOwn(personaId, n = 6) {
  return all
    .filter((p) => p.authorId === personaId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, n);
}

let clock = now - (N_POSTS * 3 + N_REPLIES) * 6 * 60_000;
function nextTime(after) {
  clock += (3 + Math.floor(rand() * 8)) * 60_000;
  if (after) clock = Math.max(clock, Date.parse(after) + 5 * 60_000);
  clock = Math.min(clock, now);
  return new Date(clock).toISOString();
}

// ---------- output normalization ----------

function cleanText(text, persona) {
  let t = String(text ?? '').trim();
  t = t.replace(/^["“](.*)["”]$/s, '$1').trim();
  t = t.replace(new RegExp(`^(${persona.name}|@${persona.handle})\\s*[:—-]\\s*`, 'i'), '');
  if (/\bas an ai\b|language model/i.test(t)) throw new Error('model broke character');
  t = scrubTells(t);
  const tells = findTells(t);
  if (tells.length) throw new Error(`AI tell (${tells.join(', ')})`);
  if ([...t].length > 280) {
    const cut = t.slice(0, 280);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    t = end > 120 ? cut.slice(0, end + 1) : cut.slice(0, 279).replace(/\s+\S*$/, '') + '…';
  }
  if (t.length < 8) throw new Error('empty post');
  return t;
}

function cleanTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : []).map((t) => slugify(String(t))).filter((t) => t && t.length <= 30))].slice(0, 2);
}

function cleanCitation(c) {
  if (!c) return null;
  if (typeof c === 'object') c = [c.work, c.source, c.title, c.location].filter(Boolean).join(', ');
  c = String(c).trim();
  return c && !/^null$/i.test(c) ? c.slice(0, 120) : null;
}

const origin = provider.name;

async function ask(messages, meta) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      return parseJson(await provider.complete(messages, meta));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function isDuplicate(text) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const n = norm(text);
  return all.some((p) => norm(p.text) === n);
}

function add(post) {
  all.push(post);
  created.push(post);
  return post;
}

// ---------- actions ----------

async function makePost(headlines, usedNews, usedAuthors) {
  const persona = chooseAuthor(usedAuthors);
  usedAuthors.add(persona.id);
  let archetype = pick(rand, persona.post_archetypes);
  const freshNews = headlines.filter((h) => !usedNews.has(h.url));
  if (freshNews.length && rand() < 0.35) archetype = 'news_take';
  let news = null;
  let quoted = null;
  // Prefer quote-taiking today's wire posts so news threads cluster around the newswire.
  const freshWires = created.filter((p) => p.type === 'news_wire' && !all.some((q) => q.quoteOf === p.id && q.authorId === persona.id));
  if (freshWires.length && rand() < 0.6) {
    quoted = pick(rand, freshWires);
    news = quoted.news;
    archetype = 'news_take';
  } else if (archetype === 'news_take') {
    if (!freshNews.length) archetype = pick(rand, persona.post_archetypes.filter((a) => a !== 'news_take' && a !== 'quote_post'));
    else {
      news = pick(rand, freshNews.slice(0, 12));
      usedNews.add(news.url);
    }
  }
  if (archetype === 'quote_post') {
    const pool = all.filter((p) => !p.inReplyTo && p.authorId !== persona.id && now - Date.parse(p.createdAt) < 5 * 24 * HOUR);
    if (pool.length) quoted = weightedPick(rand, pool, (p) => (relation(persona.id, p.authorId) === 'any' ? 1 : 4));
    else archetype = 'aphorism';
  }
  const topicHint = rand() < 0.5 ? pick(rand, persona.favorite_topics) : null;
  const messages = postMessages({ persona, archetype, byId, news, quoted, recent: recentOwn(persona.id), topicHint });
  const out = await ask(messages, { kind: 'post', persona, archetype, news, target: quoted, targetAuthor: quoted && byId.get(quoted.authorId) });
  const tags = cleanTags(out.tags);
  const citation = cleanCitation(out.citation);
  if (archetype === 'thread') {
    const parts = (Array.isArray(out.parts) ? out.parts : [out.text]).filter(Boolean).slice(0, 6);
    if (!parts.length) throw new Error('empty thread');
    let prev = null;
    for (const [i, part] of parts.entries()) {
      const text = cleanText(part, persona);
      prev = add({
        id: newId(new Date(), rand),
        authorId: persona.id,
        type: 'thread',
        text,
        createdAt: nextTime(prev?.createdAt),
        inReplyTo: prev?.id ?? null,
        quoteOf: null,
        tags: i === 0 ? tags : [],
        news: null,
        citation: i === 0 ? citation : null,
        origin,
      });
    }
    return `${persona.name} 🧵 ${parts.length} parts`;
  }
  const text = cleanText(out.text, persona);
  if (isDuplicate(text)) throw new Error('duplicate text');
  add({
    id: newId(new Date(), rand),
    authorId: persona.id,
    type: archetype,
    text,
    createdAt: nextTime(quoted?.createdAt),
    inReplyTo: null,
    quoteOf: quoted?.id ?? null,
    tags,
    news: news ? { title: news.title, url: news.url, source: news.source } : null,
    citation,
    origin,
  });
  return `${persona.name} [${archetype}] ${text.slice(0, 70)}…`;
}

async function makeReply() {
  const idx = idxOf();
  const windowStart = now - 4 * 24 * HOUR;
  let candidates = all.filter((p) => Date.parse(p.createdAt) >= windowStart && depth(p, idx) < 7);
  if (candidates.length < 5) candidates = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40).filter((p) => depth(p, idx) < 7);
  if (!candidates.length) throw new Error('no recent posts to reply to');
  const createdIds = new Set(created.map((c) => c.id));
  const target = weightedPick(rand, candidates, (p) => {
    const kids = idx.children.get(p.id)?.length ?? 0;
    const ageH = (now - Date.parse(p.createdAt)) / HOUR;
    return (createdIds.has(p.id) ? 2.5 : 1) * (1 / (1 + kids)) * (1 / (1 + ageH / 24)) * (p.inReplyTo ? 1.2 : 1);
  });
  const chain = [...idx.ancestors(target), target];
  const inConvo = new Set(chain.map((c) => c.authorId));
  const replier = weightedPick(
    rand,
    voices.filter((p) => p.id !== target.authorId),
    (p) => {
      const rel = relation(p.id, target.authorId);
      const w = rel === 'rival' ? 5 : rel === 'ally' ? 3.5 : 0.5;
      return w * (inConvo.has(p.id) ? 1.6 : 1);
    },
  );
  const rel = relation(replier.id, target.authorId);
  const fits = replier.reply_archetypes.filter((a) => REPLY_ARCHETYPES[a].relation === rel || REPLY_ARCHETYPES[a].relation === 'any');
  let archetype = pick(rand, fits.length ? fits : replier.reply_archetypes);
  if (rel === 'ally' && replier.reply_archetypes.includes('agree_extend') && rand() < 0.5) archetype = 'agree_extend';
  if (chain.length >= 5 && rand() < 0.35) archetype = pick(rand, ['concession', 'joke'].filter((a) => replier.reply_archetypes.includes(a)).concat(archetype));
  const messages = replyMessages({ persona: replier, archetype, byId, chain: chain.slice(-6), relation: rel });
  const out = await ask(messages, { kind: 'reply', persona: replier, archetype, target, targetAuthor: byId.get(target.authorId) });
  const text = cleanText(out.text, replier);
  if (isDuplicate(text)) throw new Error('duplicate text');
  add({
    id: newId(new Date(), rand),
    authorId: replier.id,
    type: archetype,
    text,
    createdAt: nextTime(target.createdAt),
    inReplyTo: target.id,
    quoteOf: null,
    tags: cleanTags(out.tags),
    news: null,
    citation: cleanCitation(out.citation),
    origin,
  });
  return `${replier.name} → ${byId.get(target.authorId).name} [${archetype}] ${text.slice(0, 60)}…`;
}

// Neutral newswire post built straight from the headline: no LLM, so no added facts or opinions.
function makeWire(headlines, usedNews, i) {
  const fresh = headlines.filter((h) => !usedNews.has(h.url));
  if (!fresh.length || !wires.length) throw new Error('no fresh headlines for the wire');
  const h = fresh[0];
  usedNews.add(h.url);
  const wire = wires[i % wires.length];
  const marker = wire.voice.tics[0] ?? '📰';
  const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');
  const title = clip(h.title.replace(/\s+/g, ' ').trim(), 150);
  const summary = (h.description ?? '').replace(/\s+/g, ' ').trim();
  const text = `${marker} ${title}${summary && summary !== h.title ? `\n${clip(summary, 270 - marker.length - title.length - 2)}` : ''}`;
  add({
    id: newId(new Date(), rand),
    authorId: wire.id,
    type: 'news_wire',
    text,
    createdAt: nextTime(),
    inReplyTo: null,
    quoteOf: null,
    tags: [],
    news: { title: h.title, url: h.url, source: h.source },
    citation: null,
    origin: 'wire',
  });
  return `${wire.name} [news_wire] ${title.slice(0, 70)}`;
}

// ---------- run ----------

const headlines = MOCK ? MOCK_HEADLINES : await fetchHeadlines();
const usedNews = new Set(all.filter((p) => p.news?.url).map((p) => p.news.url));
const usedAuthors = new Set();
console.log(`Generator: provider=${provider.name} posts=${N_POSTS} replies=${N_REPLIES} headlines=${headlines.length} seed=${SEED}${DRY ? ' (dry-run)' : ''}`);

let failures = 0;
const steps = [...Array(N_WIRE).fill('wire'), ...Array(N_POSTS).fill('post'), ...Array(N_REPLIES).fill('reply')];
// wires first (the day's topics), then posts so replies can target fresh posts
let wireN = 0;
for (const step of steps) {
  try {
    const msg = step === 'wire' ? makeWire(headlines, usedNews, wireN++) : step === 'post' ? await makePost(headlines, usedNews, usedAuthors) : await makeReply();
    console.log('  + ' + msg);
  } catch (e) {
    failures++;
    console.warn(`  ! ${step} failed: ${e.message}`);
  }
}

if (!created.length) {
  console.error('Nothing generated.');
  process.exit(failures ? 1 : 0);
}

const check = validate(personas, all.map((p) => ({ ...p, _file: 'new' })));
if (check.length) {
  console.error('Generated content failed validation:\n  ' + check.join('\n  '));
  process.exit(1);
}

created.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const batch = { generatedAt: new Date(now).toISOString(), provider: provider.name, posts: created };
if (DRY) {
  console.log(JSON.stringify(batch, null, 2));
  console.log(`Dry run: ${created.length} posts NOT written.`);
} else {
  fs.mkdirSync(POSTS_DIR, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const file = path.join(POSTS_DIR, `${stamp}Z-${MOCK ? 'mock' : 'gen'}.json`);
  fs.writeFileSync(file, JSON.stringify(batch, null, 2) + '\n');
  console.log(`Wrote ${created.length} posts → ${path.relative(process.cwd(), file)}`);
}
