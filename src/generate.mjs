#!/usr/bin/env node
// Daily content pipeline:
//   scan news/trends RSS → pick 3-5 topics → 1-2 personas post root taiks → every other persona
//   decides (seeded, x_behavior-driven) to reply / like / quote-taik / repost / ignore →
//   LLM writes the replies & quotes (call budget) → reply chains & clapbacks → simulated counts →
//   validate everything → content/posts/<stamp>-daily.json
//
//   node src/generate.mjs                     # live: real RSS + real LLM, writes -daily.json
//   node src/generate.mjs --mock              # offline fixtures + mock provider, writes -mock.json
//   node src/generate.mjs --dry-run           # offline (like --mock) but writes nothing
//   node src/generate.mjs --dry-run --live    # real RSS + real LLM, writes nothing
//   node src/generate.mjs --topics-only       # scan + select topics, print, exit (add --mock for fixtures)
//   options: --seed S  --topics N (3-5)  --max-calls N  --summary-only  --quiet
import fs from 'node:fs';
import path from 'node:path';
import { POSTS_DIR, MAX_TAIK_CHARS, taikLength, loadPersonas, loadPosts, validate } from './lib/data.mjs';
import { ALL_TYPES, POST_ARCHETYPES, REPLY_ARCHETYPES } from './lib/archetypes.mjs';
import { behaviorOf, postFormats, replyFormats, isAwake, isSerious } from './lib/behavior.mjs';
import { createLlmProvider, llmConfig, parseJson } from './lib/llm.mjs';
import { createMockProvider } from './lib/mock.mjs';
import { fetchTopics, FIXTURE_TOPICS } from './lib/news.mjs';
import { scoreCandidates, selectTopics, coveredTopics, personaBag, relevance, topicRef } from './lib/topics.mjs';
import { rootMessages, replyMessages, quoteMessages, shortenMessages, rankTopicsMessages } from './lib/prompts.mjs';
import { relationOf, interactionProbs, replyDelayMs, computeEngagement } from './lib/engagement.mjs';
import { rng, pick, weightedPick, newId, slugify } from './lib/util.mjs';

// ---------- config ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const envNum = (v, def) => (blank(v) || Number.isNaN(Number(v)) ? def : Number(v));

const DRY = flag('dry-run');
const LIVE = flag('live');
const MOCK = flag('mock') || (DRY && !LIVE);
const TOPICS_ONLY = flag('topics-only');
const SUMMARY_ONLY = flag('summary-only');
const QUIET = flag('quiet');
const N_TOPICS = Math.max(3, Math.min(5, Math.round(envNum(opt('topics'), envNum(process.env.GEN_TOPICS, 4)))));
const MAX_CALLS = Math.max(1, Math.round(envNum(opt('max-calls'), envNum(process.env.GEN_MAX_CALLS, 30))));
const SEED = opt('seed') ?? (blank(process.env.GEN_SEED) ? String(Date.now()) : process.env.GEN_SEED);
const EVERGREEN_RATE = envNum(process.env.GEN_EVERGREEN_RATE, 0.5);
const RANK_WITH_LLM = (process.env.GEN_LLM_RANK ?? 'true').trim().toLowerCase() !== 'false';
const rand = rng(SEED);
const log = (...a) => !QUIET && console.error(...a);

// Offline modes must never touch the network: hard-block fetch and count attempts.
let blockedFetches = 0;
if (MOCK) {
  globalThis.fetch = async (url) => {
    blockedFetches++;
    throw new Error(`network disabled in --mock/--dry-run (tried ${url})`);
  };
}

const cfg = llmConfig();
if (!MOCK && !TOPICS_ONLY && !cfg.apiKey) {
  console.error('No LLM key found (LLM_API_KEY / GITHUB_MODELS_TOKEN / GITHUB_TOKEN). Use --mock or --dry-run for offline runs.');
  process.exit(1);
}
const provider = MOCK ? createMockProvider(SEED) : createLlmProvider(cfg);

// ---------- data ----------
const personas = loadPersonas();
const byId = new Map(personas.map((p) => [p.id, p]));
const behaviors = new Map(personas.map((p) => [p.id, behaviorOf(p)]));
const bags = new Map(personas.map((p) => [p.id, personaBag(p)]));
const existing = loadPosts().map(({ _file, ...p }) => p);
const existingErrs = validate(personas, existing);
if (existingErrs.length) {
  console.error('Existing content invalid:\n  ' + existingErrs.join('\n  '));
  process.exit(1);
}
const existingTexts = new Set(existing.map((p) => p.text.trim().toLowerCase()));
const NOW = Date.now();
const HOUR = 3600_000;
const MIN = 60_000;
const rel = (a, b) => relationOf(byId, a, b);

// ---------- LLM budget ----------
let calls = 0;
let llmDead = null;
let badStreak = 0;
const failures = [];
class BudgetError extends Error {}

async function ask(req) {
  if (llmDead) throw new BudgetError(`LLM disabled: ${llmDead}`);
  if (calls >= MAX_CALLS) throw new BudgetError('call budget exhausted');
  calls++;
  try {
    const out = parseJson(await provider.complete(req.messages, req.meta));
    badStreak = 0;
    return out;
  } catch (err) {
    if (/rate limit|HTTP 429|HTTP 401|HTTP 403|exhausted retries/i.test(err.message)) llmDead = err.message.slice(0, 160);
    else if (++badStreak >= 3) llmDead = `3 unusable responses in a row (${err.message.slice(0, 100)})`;
    throw err;
  }
}
const remaining = () => (llmDead ? 0 : MAX_CALLS - calls);

// ---------- text hygiene ----------
function smartTrim(t, limit = MAX_TAIK_CHARS) {
  const cps = [...t];
  if (cps.length <= limit) return t;
  const cut = cps.slice(0, limit).join('');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('\n'));
  if (end > limit * 0.5) return cut.slice(0, end + 1).trim();
  return cps.slice(0, limit - 1).join('').replace(/\s+\S*$/, '').trim() + '…';
}

function scrub(text, persona) {
  let t = String(text ?? '').trim();
  t = t.replace(/^["“](.*)["”]$/s, '$1').trim();
  t = t.replace(new RegExp(`^(${persona.name}|@${persona.handle})\\s*[:—-]\\s*`, 'i'), '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (/\bas an ai\b|language model|\bpersona\b.*\bprompt\b/i.test(t)) throw new Error('model broke character');
  return t;
}

async function finalize(text, persona, behavior, { min = 8 } = {}) {
  let t = scrub(text, persona);
  for (let i = 0; i < 2 && taikLength(t) > MAX_TAIK_CHARS && remaining() > 0; i++) {
    try {
      const out = await ask(shortenMessages({ persona, behavior, text: t }));
      if (out?.text) t = scrub(out.text, persona);
    } catch (err) {
      if (!(err instanceof BudgetError)) failures.push(`shorten: ${err.message.slice(0, 120)}`);
      break;
    }
  }
  t = smartTrim(t);
  if (behavior.casing === 'lowercase' && rand() < 0.85) t = t.replace(/(^|[^@#\w/])([A-Z][a-z'’]*)/g, (m, a, w) => a + w.toLowerCase());
  if (taikLength(t) < min && !/\p{Extended_Pictographic}/u.test(t)) throw new Error('empty taik');
  if (existingTexts.has(t.toLowerCase())) throw new Error('duplicate taik');
  existingTexts.add(t.toLowerCase());
  return t;
}

const cleanTags = (tags) => [...new Set((Array.isArray(tags) ? tags : []).map((t) => slugify(String(t))).filter((t) => t && t.length <= 30))].slice(0, 2);
function cleanCitation(c) {
  if (!c) return null;
  if (typeof c === 'object') c = [c.work, c.source, c.title, c.location].filter(Boolean).join(', ');
  c = String(c).trim();
  return c && !/^(null|none|n\/a)$/i.test(c) ? c.slice(0, 160) : null;
}

// ---------- time ----------
const iso = (ms) => new Date(Math.min(ms, NOW - MIN)).toISOString();
function awakeTime(b, lo, hi) {
  for (let i = 0; i < 12; i++) {
    const t = lo + rand() * (hi - lo);
    if (isAwake(b, new Date(t))) return t;
  }
  return lo + rand() * (hi - lo);
}
function replyTime(b, parentMs) {
  const ceiling = NOW - MIN;
  for (let i = 0; i < 8; i++) {
    const t = parentMs + 2 * MIN + replyDelayMs(rand);
    if (t < ceiling && isAwake(b, new Date(t))) return t;
  }
  return Math.min(ceiling, parentMs + 2 * MIN + rand() * Math.max(MIN, Math.min(3 * HOUR, ceiling - parentMs - 2 * MIN)));
}

// ---------- topics ----------
async function gatherTopics() {
  let items;
  let report = [];
  if (MOCK) items = FIXTURE_TOPICS.map((t, i) => ({ ...t, publishedAt: new Date(NOW - (i + 1) * 2 * HOUR).toISOString() }));
  else ({ items, report } = await fetchTopics(process.env, log));
  const covered = coveredTopics(existing, NOW);
  const cands = scoreCandidates(items, { personas, behaviors, bags, covered, now: NOW });
  let preferred = null;
  let ranked = 'heuristic';
  if (!MOCK && !TOPICS_ONLY && RANK_WITH_LLM && cands.length > N_TOPICS + 2) {
    const shortlist = cands.slice(0, 18);
    try {
      const out = await ask(rankTopicsMessages(shortlist, N_TOPICS));
      const picks = (out.picks ?? []).map(Number).filter((i) => Number.isInteger(i) && shortlist[i]);
      if (picks.length) {
        preferred = [...new Set(picks)].map((i) => shortlist[i]);
        ranked = 'llm';
      }
    } catch (err) {
      failures.push(`rank: ${err.message.slice(0, 120)}`);
    }
  }
  const topics = selectTopics(cands, N_TOPICS, rand, { evergreenRate: EVERGREEN_RATE, preferred });
  return { topics, report, candidates: cands.length, scanned: items.length, ranked };
}

// ---------- archetype choice ----------
const MEMEY = new Set(['meme', 'pov', 'copypasta', 'shitpost', 'hear_me_out', 'subtweet', 'poll']);
const GRAVE_POST = ['news_take', 'reminder', 'question', 'aphorism'];
const GRAVE_REPLY = ['agree_extend', 'context_note', 'question_back', 'concession', 'steelman_rebut', 'counterexample'];
const NEEDS_QUOTE = new Set(['quote_post', 'quote_take', 'quote_dunk']);

function rootArchetype(p, b, topic, threadAllowed) {
  if (topic.grave) return pick(rand, GRAVE_POST);
  const pool = [...new Set([...p.post_archetypes, ...postFormats(b), 'hot_take'])].filter((a) => POST_ARCHETYPES[a] && !NEEDS_QUOTE.has(a));
  return weightedPick(rand, pool, (a) => {
    let w = 1;
    if (b.formats.includes(a)) w *= 2.2;
    if (a === 'thread') w = threadAllowed ? 4 * b.thread_tendency : 0;
    if (a === 'shitpost' || a === 'copypasta') w *= 0.1 + 2.2 * b.shitpost_level;
    else if (MEMEY.has(a)) w *= 0.15 + 2 * b.meme_affinity;
    if (a === 'news_take') w *= topic.kind === 'evergreen' ? 0 : 1.6;
    if (a === 'hot_take' || a === 'unpopular_opinion') w *= 0.6 + b.dunk_tendency;
    if (a === 'teaching' || a === 'listicle') w *= 0.5;
    return w;
  });
}

function replyArchetype(actor, b, relation, grave, clapback) {
  if (clapback) return grave ? pick(rand, ['concession', 'steelman_rebut']) : rand() < 0.65 ? 'clapback' : pick(rand, ['steelman_rebut', 'question_back', 'dunk']);
  if (grave) return pick(rand, GRAVE_REPLY);
  const pool = [...new Set([...actor.reply_archetypes, ...replyFormats(b), 'agree_extend', 'joke'])].filter((a) => {
    const r = REPLY_ARCHETYPES[a];
    if (!r || a === 'clapback') return false;
    if (r.relation === 'rival') return relation === 'rival' || (relation === 'any' && b.dunk_tendency > 0.6);
    if (r.relation === 'ally') return relation === 'ally';
    return true;
  });
  return weightedPick(rand, pool, (a) => {
    const v = REPLY_ARCHETYPES[a].vibe;
    let w = b.formats.includes(a) ? 2.5 : 1;
    if (v === 'spicy') w *= (relation === 'ally' ? 0.2 : 0.3) + 1.5 * b.dunk_tendency;
    if (v === 'funny') w *= 0.2 + 1.5 * b.meme_affinity;
    if (v === 'smart') w *= 1.2 - 0.6 * b.shitpost_level;
    if (v === 'calm') w *= 1.2 - b.dunk_tendency;
    if (a === 'emoji_reply') w *= 2 * b.meme_affinity;
    if (relation === 'ally' && (a === 'agree_extend' || a === 'hype')) w *= 2;
    return w;
  });
}

// ---------- author choice ----------
function chooseAuthors(topic, used) {
  const eligible = personas.filter((p) => !topic.grave || isSerious(behaviors.get(p.id)));
  const w = (p, boostRival) => {
    const b = behaviors.get(p.id);
    const r = relevance(p, b, bags.get(p.id), topic);
    let x = (0.12 + r) ** 2 * (0.3 + b.activity) * (0.6 + (p.popularity ?? 5) / 10);
    if (topic.kind === 'evergreen') x *= 0.4 + b.shitpost_level + b.meme_affinity;
    if (used.has(p.id)) x *= 0.12;
    if (boostRival && rel(p.id, boostRival) === 'rival') x *= 3;
    return x;
  };
  const first = weightedPick(rand, eligible, (p) => w(p));
  const authors = [first];
  if (rand() < 0.45) {
    const second = weightedPick(rand, eligible.filter((p) => p.id !== first.id), (p) => w(p, first.id));
    if (second) authors.push(second);
  }
  return authors;
}

// ---------- build ----------
const created = [];
const createdById = new Map();
const stats = { roots: 0, threads: 0, threadParts: 0, replies: 0, clapbacks: 0, quotes: 0, likes: 0, reposts: 0, freeEmoji: 0, skipped: 0 };
const origin = provider.name;

function add(post) {
  created.push(post);
  createdById.set(post.id, post);
  return post;
}
function mkPost(fields) {
  const t = Date.parse(fields.createdAt);
  return {
    id: newId(new Date(t), rand),
    authorId: fields.authorId,
    type: fields.type,
    text: fields.text,
    createdAt: fields.createdAt,
    inReplyTo: fields.inReplyTo ?? null,
    quoteOf: fields.quoteOf ?? null,
    tags: fields.tags ?? [],
    news: fields.news ?? null,
    citation: fields.citation ?? null,
    topic: fields.topic ?? null,
    likedBy: [],
    repostedBy: [],
    origin,
  };
}
const chainOf = (post) => {
  const chain = [post];
  let cur = post;
  while (cur.inReplyTo && createdById.get(cur.inReplyTo)) chain.unshift((cur = createdById.get(cur.inReplyTo)));
  return chain;
};
const rootOf = (post) => chainOf(post)[0];

async function makeRoot(topic, persona, timeMs, threadAllowed) {
  const b = behaviors.get(persona.id);
  const archetype = rootArchetype(persona, b, topic, threadAllowed);
  const mode = archetype === 'subtweet' || (topic.kind !== 'evergreen' && rand() < 0.3) ? 'indirect' : 'direct';
  const thread = archetype === 'thread';
  const out = await ask(rootMessages({ persona, behavior: b, archetype, topic, mode, grave: topic.grave, thread }));
  const news = topic.kind === 'evergreen' ? null : { title: topic.title, url: topic.url, source: topic.source };
  const common = { authorId: persona.id, topic: topicRef(topic), news, tags: cleanTags(out.tags), citation: cleanCitation(out.citation) };
  if (thread) {
    let parts = (Array.isArray(out.parts) ? out.parts : [out.text]).filter(Boolean).slice(0, 4);
    const texts = [];
    for (const part of parts) texts.push(await finalize(part, persona, b));
    if (!texts.length) throw new Error('empty thread');
    let prev = null;
    let first = null;
    let t = timeMs;
    for (const [i, text] of texts.entries()) {
      const post = mkPost({ ...common, type: i === 0 ? archetype : 'thread', text, createdAt: iso(t), inReplyTo: prev?.id, tags: i ? [] : common.tags, citation: i ? null : common.citation, topic: i ? null : common.topic, news: i ? null : common.news });
      add(post);
      first ??= post;
      if (i) stats.threadParts++;
      prev = post;
      t += (1 + rand() * 2) * MIN;
    }
    stats.threads++;
    return first;
  }
  const text = await finalize(out.text, persona, b);
  return add(mkPost({ ...common, type: archetype, text, createdAt: iso(timeMs) }));
}

async function makeReply(actor, target, { clapback = false, topic, grave }) {
  const b = behaviors.get(actor.id);
  const relation = rel(actor.id, target.authorId);
  const archetype = replyArchetype(actor, b, relation === 'self' ? 'any' : relation, grave, clapback);
  const chain = chainOf(target);
  const out = await ask(replyMessages({ persona: actor, behavior: b, archetype, chain, personasById: byId, relation, topic, grave, clapback }));
  const text = await finalize(out.text, actor, b, { min: archetype === 'emoji_reply' ? 1 : 8 });
  const t = replyTime(b, Date.parse(target.createdAt));
  return add(mkPost({ authorId: actor.id, type: archetype, text, createdAt: iso(t), inReplyTo: target.id, citation: cleanCitation(out.citation) }));
}

async function makeQuote(actor, quoted, { topic, grave }) {
  const b = behaviors.get(actor.id);
  const relation = rel(actor.id, quoted.authorId);
  const archetype = grave ? 'quote_take' : relation === 'rival' || (relation === 'any' && rand() < b.dunk_tendency * 0.6) ? 'quote_dunk' : relation === 'ally' && rand() < 0.3 ? 'hype' : 'quote_take';
  const out = await ask(quoteMessages({ persona: actor, behavior: b, archetype, quoted, personasById: byId, relation, topic, grave }));
  const text = await finalize(out.text, actor, b);
  const t = replyTime(b, Date.parse(quoted.createdAt));
  return add(mkPost({ authorId: actor.id, type: archetype, text, createdAt: iso(t), quoteOf: quoted.id, topic: topicRef(topic), tags: cleanTags(out.tags), citation: cleanCitation(out.citation) }));
}

function freeEmojiReply(actor, target) {
  const b = behaviors.get(actor.id);
  const pool = [...(b.emoji ?? []), '💀', '😭'];
  let text = pick(rand, pool);
  if (rand() < 0.4) text = text.repeat(1 + Math.floor(rand() * 3));
  const t = replyTime(b, Date.parse(target.createdAt));
  return add(mkPost({ authorId: actor.id, type: 'emoji_reply', text, createdAt: iso(t), inReplyTo: target.id }));
}

function like(post, actorId) {
  if (post.authorId === actorId || post.likedBy.includes(actorId)) return;
  post.likedBy.push(actorId);
  stats.likes++;
}
function repost(post, actorId) {
  if (post.authorId === actorId || post.repostedBy.includes(actorId)) return;
  post.repostedBy.push(actorId);
  stats.reposts++;
}

async function main() {
  const t0 = Date.now();
  const scan = await gatherTopics();
  const { topics } = scan;
  if (TOPICS_ONLY) return printTopics(scan);
  if (!topics.length) throw new Error('no topics selected');

  // 1) roots — spread over the past ~22h, earliest first
  const slots = [];
  const used = new Set();
  for (const topic of topics) for (const a of chooseAuthors(topic, used)) {
    used.add(a.id);
    slots.push({ topic, persona: a });
  }
  const span = [NOW - 22 * HOUR, NOW - 2 * HOUR];
  const maxThreads = Math.max(1, Math.floor(slots.length * 0.1));
  const roots = [];
  for (const slot of slots) {
    if (remaining() <= 0) break;
    const b = behaviors.get(slot.persona.id);
    const time = awakeTime(b, span[0], span[1]);
    try {
      const root = await makeRoot(slot.topic, slot.persona, time, stats.threads < maxThreads && rand() < 0.35);
      roots.push({ root, topic: slot.topic });
      stats.roots++;
    } catch (err) {
      stats.skipped++;
      if (!(err instanceof BudgetError)) failures.push(`root ${slot.persona.id}: ${err.message.slice(0, 120)}`);
    }
  }

  // 2) sample every other persona's reaction to each root
  const queue = [];
  for (const { root, topic } of roots) {
    const author = byId.get(root.authorId);
    for (const actor of personas) {
      if (actor.id === root.authorId) continue;
      const b = behaviors.get(actor.id);
      const relation = rel(actor.id, root.authorId);
      const r = relevance(actor, b, bags.get(actor.id), topic);
      const p = interactionProbs({ actorB: b, author, rel: relation, relevance: r, archetype: root.type, grave: topic.grave });
      if (rand() < p.like) like(root, actor.id);
      if (rand() < p.repost) repost(root, actor.id);
      if (rand() < p.reply) queue.push({ kind: 'reply', actor, target: root, root, topic, p: p.reply, relation });
      else if (rand() < p.quote) queue.push({ kind: 'quote', actor, target: root, root, topic, p: p.quote, relation });
    }
  }

  // 3) spend the LLM budget on the most likely interactions, round-robin across roots
  const served = new Map();
  const actorServed = new Map();
  const seenPairs = new Set();
  while (queue.length) {
    let bi = 0;
    let bs = -Infinity;
    for (const [i, it] of queue.entries()) {
      const s = it.p + (it.bonus ?? 0) - 0.12 * (served.get(it.root.id) ?? 0) - (it.clapback || it.counter ? 0 : 0.07 * (actorServed.get(it.actor.id) ?? 0));
      if (s > bs) [bi, bs] = [i, s];
    }
    const it = queue.splice(bi, 1)[0];
    const key = `${it.kind}:${it.actor.id}:${it.target.id}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const b = behaviors.get(it.actor.id);
    const grave = it.topic.grave;
    if (remaining() <= 0) {
      // over budget: meme-brained personas still drop a free emoji reply; allies' quotes become reposts
      if (it.kind === 'reply' && !it.clapback && !grave && b.meme_affinity >= 0.5 && rand() < b.meme_affinity) {
        freeEmojiReply(it.actor, it.target);
        stats.freeEmoji++;
        stats.replies++;
      } else if (it.kind === 'quote' && it.relation !== 'rival') repost(it.target, it.actor.id);
      continue;
    }
    let post;
    try {
      post = it.kind === 'quote' ? await makeQuote(it.actor, it.target, { topic: it.topic, grave }) : await makeReply(it.actor, it.target, { clapback: it.clapback, topic: it.topic, grave });
    } catch (err) {
      stats.skipped++;
      if (!(err instanceof BudgetError)) failures.push(`${it.kind} ${it.actor.id}: ${err.message.slice(0, 120)}`);
      continue;
    }
    served.set(it.root.id, (served.get(it.root.id) ?? 0) + 1);
    actorServed.set(it.actor.id, (actorServed.get(it.actor.id) ?? 0) + 1);
    if (it.kind === 'quote') stats.quotes++;
    else if (it.clapback) stats.clapbacks++;
    else stats.replies++;

    // social graph reacts to the new post
    const targetAuthor = it.target.authorId;
    for (const other of personas) {
      if (other.id === post.authorId) continue;
      const ob = behaviors.get(other.id);
      const rToReplier = rel(other.id, post.authorId);
      const rToTarget = rel(other.id, targetAuthor);
      let pl = ob.like_rate * ob.activity * 0.08;
      if (rToReplier === 'ally') pl = ob.like_rate * ob.activity * 0.9;
      if (rToTarget === 'rival' && rToReplier !== 'rival') pl = Math.max(pl, ob.like_rate * ob.activity * 0.5);
      if (other.id === it.root.authorId && rToReplier !== 'rival') pl = Math.max(pl, ob.like_rate * 0.4);
      if (rand() < pl) like(post, other.id);
      if (it.kind === 'quote' && rToReplier === 'ally' && rand() < ob.repost_rate * 0.5) repost(post, other.id);
    }

    const depth = chainOf(post).length - 1;
    const spicy = ['spicy'].includes(ALL_TYPES[post.type]?.vibe) || post.type === 'quote_dunk';
    const r = rel(post.authorId, targetAuthor);
    if (!it.clapback && !it.counter && depth < 3 && !grave) {
      // the dunked-on author claps back (under the reply, or under the quote-taik)
      const ab = behaviors.get(targetAuthor);
      const pc = ab.clapback_rate * (r === 'rival' ? 0.8 : spicy ? 0.5 : 0.12);
      if (rand() < pc) queue.push({ kind: 'reply', actor: byId.get(targetAuthor), target: post, root: it.root, topic: it.topic, p: pc, bonus: 0.3, clapback: true, relation: r });
    } else if (it.clapback && depth < 3) {
      // ...and the replier may fire back once more (rivals go 2-3 deep)
      const pb = behaviors.get(targetAuthor);
      const pr = pb.dunk_tendency * (r === 'rival' ? 0.6 : 0.2);
      if (rand() < pr) queue.push({ kind: 'reply', actor: byId.get(targetAuthor), target: post, root: it.root, topic: it.topic, p: pr, bonus: 0.2, counter: true, relation: r });
    }
    // an ally of the dunked-on author jumps in
    if (spicy && r === 'rival' && depth < 3 && !it.clapback && !it.counter) {
      const allies = (byId.get(targetAuthor).allies ?? []).map((a) => byId.get(a.id)).filter((a) => a && a.id !== post.authorId);
      if (allies.length) {
        const ally = pick(rand, allies);
        const pa = behaviors.get(ally.id).reply_rate * 0.5;
        if (rand() < pa) queue.push({ kind: 'reply', actor: ally, target: post, root: it.root, topic: it.topic, p: pa, bonus: 0.1, relation: rel(ally.id, post.authorId) });
      }
    }
  }

  // 4) simulated public counts
  created.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const { ratios } = computeEngagement(created, { byId, now: NOW, rand, rel });
  for (const p of created) {
    if (!p.likedBy.length) delete p.likedBy;
    if (!p.repostedBy.length) delete p.repostedBy;
    if (!p.topic) delete p.topic;
  }

  // 5) validate the merged set; never write an invalid batch
  const errs = validate(personas, [...existing, ...created]);
  if (errs.length) {
    console.error('Generated content failed validation — nothing written:\n  ' + errs.slice(0, 30).join('\n  '));
    process.exit(1);
  }

  const stamp = new Date(NOW).toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  const file = path.join(POSTS_DIR, `${stamp}-${MOCK ? 'mock' : 'daily'}.json`);
  const run = {
    seed: SEED,
    mode: MOCK ? 'mock' : 'live',
    topics: topics.map((t) => ({ ...topicRef(t), section: t.section, grave: t.grave, score: t.score })),
    stats: { ...stats, ratios: ratios.length, llmCalls: calls, maxCalls: MAX_CALLS, posts: created.length },
  };
  const batch = { generatedAt: new Date(NOW).toISOString(), provider: provider.name, run, posts: created };
  printSummary(scan, roots, ratios, Date.now() - t0);
  if (DRY) {
    if (!SUMMARY_ONLY) console.log(JSON.stringify(batch, null, 2));
    console.error(`\n(dry run — nothing written; would write ${path.relative(process.cwd(), file)})`);
    return;
  }
  if (!created.length) {
    console.error('Nothing generated — no file written.');
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(file, JSON.stringify(batch, null, 2) + '\n');
  console.error(`\nWrote ${created.length} posts → ${path.relative(process.cwd(), file)}`);
}

// ---------- output ----------
function printTopics(scan) {
  console.log(`Topic scan (${MOCK ? 'offline fixtures' : 'live RSS'}): ${scan.scanned} items, ${scan.candidates} fresh candidates, ranking: ${scan.ranked}`);
  for (const r of scan.report) console.log(`  feed ${r.ok ? 'ok ' : 'ERR'} ${String(r.kept ?? 0).padStart(3)}/${String(r.items ?? 0).padEnd(3)} ${r.feed}${r.error ? `  (${r.error})` : ''}`);
  console.log('Selected topics:');
  for (const t of scan.topics) console.log(`  • [${t.kind}/${t.section}${t.grave ? '/GRAVE' : ''}] ${t.title}${t.url ? `\n      ${t.source ?? ''} ${t.url}` : ''}  (score ${t.score}; themes: ${t.themes.join(', ') || '-'})`);
  if (MOCK) console.log(`Network: blocked (${blockedFetches} fetch attempts)`);
}

function printSummary(scan, roots, ratios, ms) {
  const name = (id) => `@${byId.get(id)?.handle ?? id}`;
  const L = [];
  L.push(`Taiku daily run — ${MOCK ? 'MOCK (offline)' : `LIVE (${provider.name})`} — seed ${SEED}${DRY ? ' — DRY RUN' : ''}`);
  L.push(`Topics: ${scan.topics.length} (scanned ${scan.scanned}, ${scan.candidates} candidates, ranking ${scan.ranked})${MOCK ? ` — network blocked, ${blockedFetches} fetch attempts` : ''}`);
  for (const t of scan.topics) L.push(`  • [${t.kind}${t.grave ? '/grave' : ''}] ${t.title}${t.url ? ` — ${t.source ?? ''} ${t.url}` : ''}`);
  L.push('');
  for (const { root, topic } of roots) {
    L.push(`${name(root.authorId)} [${root.type}] on "${topic.title.slice(0, 60)}"  ♥${root.engagement.likes} ⟲${root.engagement.reposts} 👁${root.engagement.views}`);
    L.push(`   ${root.text.replace(/\n/g, ' ⏎ ')}`);
    const walk = (parent, indent) => {
      for (const c of created.filter((p) => p.inReplyTo === parent.id || p.quoteOf === parent.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const kind = c.quoteOf ? 'QT' : c.type === 'thread' ? '🧵' : '↳';
        L.push(`${indent}${kind} ${name(c.authorId)} [${c.type}]${ratios.includes(c.id) ? ' (RATIO)' : ''} ♥${c.engagement.likes}: ${c.text.replace(/\n/g, ' ⏎ ')}`);
        walk(c, indent + '   ');
      }
    };
    walk(root, '     ');
    if (root.likedBy?.length || root.repostedBy?.length) L.push(`     liked by ${(root.likedBy ?? []).map(name).join(' ') || '-'}; reposted by ${(root.repostedBy ?? []).map(name).join(' ') || '-'}`);
    L.push('');
  }
  L.push(`Totals: ${created.length} posts — roots ${stats.roots} (threads ${stats.threads}, +${stats.threadParts} parts), replies ${stats.replies} (free emoji ${stats.freeEmoji}), clapbacks ${stats.clapbacks}, quotes ${stats.quotes}, likes ${stats.likes}, reposts ${stats.reposts}, ratios ${ratios.length}, skipped ${stats.skipped}`);
  L.push(`LLM calls: ${calls}/${MAX_CALLS}${llmDead ? ` (stopped: ${llmDead})` : ''} — ${(ms / 1000).toFixed(1)}s`);
  if (failures.length) L.push(`Failures (${failures.length}):\n  ${failures.slice(0, 10).join('\n  ')}`);
  console.error(L.join('\n'));
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});
