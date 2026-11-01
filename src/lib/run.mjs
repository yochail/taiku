// DailyRun: one run per editorial date writes the whole day (drip-released via future createdAt).
//
//   budget plan (Neurons per model)  →  topics (feeds → filter → score/MMR)  →  plan (wire posts,
//   openers, topic roots, standalones, one self-thread)  →  react.mjs cascade (who likes / retaiks /
//   replies / quotes and in which reply form; no LLM)  →  execution by depth level: deterministic
//   wire posts, agentic single turns (voice), batched openers / originals / replies (batch), short
//   replies (micro), cheap forms from reaction pools with a 14-day cooldown, one micro call
//   →  engagement (react + crowd.mjs) + plain retaik rows  →  validate  →  atomic write.
//
// Idempotent + resumable: task ids derive from the topic and the reaction graph, which is fully
// determined by (seed, nonce, topics, content plan); all four are reused from the previous manifest,
// the default nonce is derived from (date, seed) so a fresh rerun reproduces the same day,
// finished items are cached in content/runs/<date>.work.json, and the posts file is rewritten
// atomically. Content is only published when completeness thresholds are met.
import fs from 'node:fs';
import path from 'node:path';
import { SITE_DIR, loadPersonas, personaKind, safeUrl, validate } from './data.mjs';
import { POST_ARCHETYPES, REPLY_ARCHETYPES } from './archetypes.mjs';
import { behaviorOf } from './behavior.mjs';
import { crowdFor, loadDistribution } from './crowd.mjs';
import { createSampler, replyFormOf } from './realism.mjs';
import { planMedia } from './media.mjs';
import { createGiphyClient } from './giphy.mjs';
import { MAX_DEPTH, calibrate, cascade, createReactor, relationOf } from './react.mjs';
import { mentionDebts, mentionDecision } from './followon.mjs';
import { mentionTargets } from './tags.mjs';
import { FEEDS, domainOf, fetchPool, fixtureFetch, sanitizeUntrusted } from './news.mjs';
import { selectTopics, topicCount } from './topics.mjs';
import { BudgetError, llmConfig, loadLlmConfig } from './llm.mjs';
import { createMockClient } from './mock.mjs';
import { createRotation, discoverModels, singleClientRotation } from './rotation.mjs';
import { OPENERS_PER_BATCH, ORIGINALS_PER_BATCH, REPLIES_PER_BATCH, SHORTS_PER_BATCH, THREAD_PARTS, budgetFile, loadUsage, planBudget, saveUsage } from './budget.mjs';
import { cosineVec, createEmbedder, personaVectors, stanceAnchors, stanceHint, tokens } from './embed.mjs';
import { MICRO_REFILL_MAX, MICRO_REFILL_PERSONAS, MICRO_REPLIES, runMicro } from './micro.mjs';
import { chooseStance, createPoolPicker, entryMedia, loadPools, loadReactionUsage, reactionId, saveReactionUsage, usageFile } from './pools.mjs';
import { defaultFill, materializeFor, planFor, schemaAllowsGiphy } from './gen-media.mjs';
import { runBatch } from './gen-batch.mjs';
import { createStyleTracker } from './house-style.mjs';
import { createToolbox } from './tools.mjs';
import { PROMPT_VERSION } from './prompts.mjs';
import { checkPost, policyContext } from './policy.mjs';
import { runTurn } from './turn.mjs';
import { clamp, editorialDay, hash8, readJson, round3, seededRng, sha256, weightedPick, writeJsonAtomic } from './pipeline-util.mjs';

export const DEFAULT_MAX_CALLS = 90;
export const DEFAULT_MIN_COMPLETE = 0.7;
export const MIN_TOPIC_SHARE = 0.6;
const NOTE_RATE = 0.2;
const NATIVE_RATE = 0.06;
const QUOTE_RATE = { original: 0.35, reply: 0.15, quote: 0.25 };
const STANDALONE_TYPES = ['hot_take', 'aphorism', 'teaching', 'reminder', 'question', 'unpopular_opinion', 'shitpost', 'subtweet', 'pov', 'hear_me_out', 'listicle', 'meme'];
const NO_STANDALONE = new Set(['news_take', 'news_wire', 'quote_post', 'thread', 'poll', 'quote_take', 'quote_dunk', 'copypasta']);
/** Reply forms served without the LLM (reaction pools / art library). */
export const CHEAP_FORMS = new Set(['emoji_only', 'few_words', 'gif_only', 'meme_only', 'image_only']);
const CHEAP_ARCHETYPE = { agree: 'agree_extend', hype: 'hype', mock: 'ratio', disagree: 'clapback', awe: 'hype', confused: 'question_back', neutral: 'emoji_reply' };
const WIRE_LINES = ['Developing story; details at the link.', 'More at the link below.', 'Full report at the link.', 'Story developing. Link below.', 'Details in the report below.'];

const isNews = (p) => personaKind(p) === 'news';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/**
 * Output locations for a date. The daily file is content/posts/daily-<date>.json (the SAME name the
 * local generation script writes). Mock runs use `-mock`; a forced cloud run next to a local file
 * uses `suffix` ('-cf'). The kill switch routes everything to staging.
 */
export function outputPaths(root, date, { mock = false, publish = true, suffix = null } = {}) {
  const sfx = suffix ?? (mock ? '-mock' : '');
  const staging = path.join(root, 'staging', `${date}${sfx}`);
  return {
    posts: path.join(root, 'content', 'posts', `daily-${date}${sfx}.json`),
    postsDir: path.join(root, 'content', 'posts'),
    run: publish ? path.join(root, 'content', 'runs', `${date}${sfx}.json`) : path.join(staging, 'run.json'),
    work: publish ? path.join(root, 'content', 'runs', `${date}${sfx}.work.json`) : path.join(staging, 'work.json'),
    topics: publish ? path.join(root, 'content', 'topics', `${date}${sfx}.json`) : path.join(staging, 'topics.json'),
    staging,
    staged: path.join(staging, 'posts.json'),
    suffix: sfx,
  };
}

/** The local-first daily file for a date, if present: { file, origin, posts } | null. */
export function localDailyFile(root, date) {
  const file = path.join(root, 'content', 'posts', `daily-${date}.json`);
  const doc = readJson(file);
  if (!doc) return null;
  return { file, origin: doc.origin ?? doc.posts?.[0]?.origin ?? null, provider: doc.provider ?? null, posts: (doc.posts ?? []).length };
}

/** Every post file except the ones this run owns (so a rerun replaces, never duplicates). */
export function loadOtherPosts(dir, exclude = []) {
  const skip = new Set(exclude.map((f) => path.resolve(f)));
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const file = path.join(dir, f);
    if (skip.has(path.resolve(file))) continue;
    const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of batch.posts ?? batch) out.push({ ...p, _file: f });
  }
  return out;
}

const relationEntry = (persona, otherId) => {
  for (const [list, kind] of [['rivals', 'rival'], ['frenemies', 'frenemy'], ['allies', 'ally']]) {
    const r = (persona[list] ?? []).find((x) => x.id === otherId);
    if (r) return { kind, why: r.why };
  }
  return null;
};

function topicAffinity(persona, keys = {}) {
  let s = 0;
  for (const [k, v] of Object.entries(keys ?? {})) s += (persona.topic_affinity?.[k] ?? 0) * v;
  return s;
}

/** Type (archetype) for a planned node. */
function pickType(rand, persona, node, media) {
  if (node.kind === 'wire') return 'news_wire';
  if (node.kind === 'thread' || node.kind === 'thread-part') return 'thread';
  if (node.role === 'quote') return node.rel === 'rival' || node.rel === 'frenemy' ? 'quote_dunk' : 'quote_take';
  if (node.role === 'reply') {
    const ok = (k) => {
      const r = REPLY_ARCHETYPES[k].relation ?? 'any';
      return r === 'any' || (r === 'rival' && (node.rel === 'rival' || node.rel === 'frenemy')) || (r === 'ally' && (node.rel === 'ally' || node.rel === 'follows'));
    };
    const own = new Set(persona.reply_archetypes ?? []);
    return weightedPick(rand, Object.keys(REPLY_ARCHETYPES).filter(ok).map((k) => [k, own.has(k) ? 4 : 1])) ?? 'joke';
  }
  if (media === 'poll') return 'poll';
  if (node.kind === 'topic-root') return rand() < 0.65 ? 'news_take' : 'hot_take';
  if (media === 'meme' && rand() < 0.5) return 'meme';
  const own = new Set((persona.post_archetypes ?? []).filter((k) => POST_ARCHETYPES[k] && !NO_STANDALONE.has(k)));
  return weightedPick(rand, [...new Set([...own, ...STANDALONE_TYPES])].map((k) => [k, own.has(k) ? 3 : 1])) ?? 'hot_take';
}

/**
 * Build the day plan: originals (wire, openers, topic roots, standalones, one self-thread) sized by
 * the budget's content plan, then the reaction cascade (with reply forms). `exec` says how each
 * node is generated: wire | single | thread | openers | originals | full | short | pool.
 */
export function planDay({ personas, spec, topics, date, seed, nonce, tz, content, formFn = null, affinityFn = null, calibrationFile = null, writeCalibration = false, past = [], postIdOf = (id) => id }) {
  const day = editorialDay(date, tz);
  const rand = seededRng('plan', seed, nonce);
  const sampler = createSampler(spec, `plan:${seed}:${nonce}`);
  const active = personas.filter((p) => !isNews(p));
  const news = personas.filter(isNews);
  const at = (minHour = 0) => {
    const h = Math.max(minHour, sampler.localHour());
    return day.start + h * 3.6e6 + sampler.minute() * 6e4 + Math.floor(rand() * 6e4);
  };
  // People post in sessions: each author gets 1-2 sittings a day and their originals cluster there (bursty, B > 0).
  const sittings = new Map();
  const sessionAt = (pid, minHour = 0) => {
    if (!sittings.has(pid)) sittings.set(pid, Array.from({ length: rand() < 0.5 ? 1 : 2 }, () => at(minHour)));
    const c = sittings.get(pid);
    return c[Math.floor(rand() * c.length)] + Math.floor(rand() * 25 * 6e4);
  };
  const delay = (maxMin = 180) => Math.min(maxMin, sampler.replyDelayMinutes()) * 6e4 + Math.floor(rand() * 6e4);
  const node = (o) => ({ depth: 0, mentions: new Set(), likes: [], reposts: [], rel: null, parent: null, quoteOf: null, topicId: null, ...o });
  const nodes = [];
  const opens = [];
  for (const t of topics) {
    const T = at(6);
    const fans = active
      .map((p) => [p, (clamp(p.reactivity ?? 3, 1, 5) / 3) * (0.2 + topicAffinity(p, t.keys)) * Math.sqrt(p.popularity ?? 5)])
      .sort((a, b) => b[1] - a[1]);
    const pickFan = (exclude) => weightedPick(rand, fans.filter(([p]) => !exclude.has(p.id)).slice(0, 10).map(([p, w]) => [p.id, w]));
    const used = new Set();
    if (news.length && t.url) {
      const wireAuthor = weightedPick(rand, news.map((p) => [p.id, 0.2 + topicAffinity(p, t.keys)]));
      const wire = node({ id: `${t.id}-wire`, authorId: wireAuthor, createdAt: T, vector: t.keys, role: 'original', kind: 'wire', exec: 'wire', topicId: t.id });
      nodes.push(wire);
      const nOpen = Math.min(OPENERS_PER_BATCH, 2 + (rand() < 0.4 ? 1 : 0));
      for (let j = 1; j <= nOpen; j++) {
        const pid = pickFan(used);
        if (!pid) break;
        used.add(pid);
        const role = j === 1 || rand() < 0.5 ? 'quote' : 'reply';
        const o = node({ id: `${t.id}-o${j}`, authorId: pid, createdAt: T + delay(), vector: t.keys, role, kind: 'opener', exec: 'openers', form: 'full', topicId: t.id, depth: 1, parent: role === 'reply' ? wire.id : null, quoteOf: role === 'quote' ? wire.id : null, mentions: new Set([wireAuthor]) });
        nodes.push(o);
        opens.push([wire, o]);
      }
    } else {
      const nOpen = 1 + (rand() < 0.5 ? 1 : 0);
      for (let j = 1; j <= nOpen; j++) {
        const pid = pickFan(used);
        if (!pid) break;
        used.add(pid);
        nodes.push(node({ id: `${t.id}-root${j}`, authorId: pid, createdAt: j === 1 ? T : Math.max(T + 6e4, sessionAt(pid, 6)), vector: t.keys, role: 'original', kind: 'topic-root', exec: 'single', topicId: t.id }));
      }
    }
  }
  const topicRoots = nodes.filter((n) => n.kind === 'topic-root').length;
  const nStandalone = Math.max(2, (content.originals ?? 20) - topicRoots);
  const singles = Math.max(0, (content.singleTurns ?? 0) - topicRoots);
  const threadAt = content.selfThreads ? singles + 1 : -1;
  for (let i = 1; i <= nStandalone; i++) {
    const pid = weightedPick(rand, active.map((p) => [p.id, (behaviorOf(p).activity ?? 0.5) * (p.popularity ?? 5)]));
    const p = personas.find((x) => x.id === pid);
    const key = weightedPick(rand, Object.entries(p.topic_affinity ?? { philosophy: 1 }).map(([k, v]) => [k, Number(v) || 0.01]));
    const exec = i <= singles ? 'single' : i === threadAt ? 'thread' : 'originals';
    nodes.push(node({ id: `s${i}`, authorId: pid, createdAt: sessionAt(pid), vector: { [key]: 1 }, role: 'original', kind: exec === 'thread' ? 'thread' : 'standalone', exec, theme: key }));
  }
  // In-text @mentions (spec.sampling.mentions): originals are tagged before the cascade so the
  // tagged personas get the reactor's mention boost; LLM replies/quotes are tagged after it.
  const pById = new Map(personas.map((p) => [p.id, p]));
  const tagNode = (n, role, cap = 3) => {
    const author = pById.get(n.authorId);
    const k = Math.min(cap, sampler.mentionCount(role, author));
    if (!k) return;
    const ids = mentionTargets({ author, personas, n: k, spec, rand, exclude: [...n.mentions] });
    if (!ids.length) return;
    n.textMentions = ids;
    for (const id of ids) n.mentions.add(id);
  };
  for (const n of nodes) if (n.role === 'original' && n.kind !== 'wire') tagNode(n, 'original');
  const authoredOriginals = nodes.filter((n) => n.role === 'original' && n.kind !== 'wire').length;
  const cal = calibrate({ personas, spec, originalsPerDay: authoredOriginals, cacheFile: calibrationFile, writeCache: writeCalibration });
  const llmCap = Math.max(0, (content.llmReplies ?? 0) + opens.length);
  const reactor = createReactor({ personas, spec, seed: `${date}:${seed}`, nonce, calibration: cal, llmCap, formFn, affinityFn });
  for (const n of nodes) if (n.kind !== 'wire') reactor.spend(n.authorId);
  for (const [wire, o] of opens) reactor.force(wire, o.authorId, o.role, 'topic-opener', o.createdAt);
  const horizon = day.end + 2 * 3.6e6;
  // Past posts that get a reaction today enter the plan as 'external' nodes (already written, never re-emitted).
  const externals = new Map();
  const extNode = (post) => {
    if (!externals.has(post.id)) {
      const a = pById.get(post.authorId);
      const key = Object.entries(a?.topic_affinity ?? { philosophy: 1 }).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'philosophy';
      externals.set(post.id, node({ id: `x-${post.id}`, authorId: post.authorId, createdAt: Date.parse(post.createdAt), vector: { [key]: 1 }, role: 'original', kind: 'external', exec: 'external', external: post }));
    }
    return externals.get(post.id);
  };
  const reactionNode = (parent, pid, action, at, reason) => {
    const persona = pById.get(pid);
    const f = formFn ? formFn(persona, action, parent) : { form: 'full', cheap: false };
    reactor.force(parent, pid, action, reason, at);
    const n = node({
      id: `${parent.id}.${reason === 'mention' ? 'm' : 'f'}-${pid}`,
      authorId: pid,
      createdAt: at,
      vector: parent.vector,
      topicId: parent.kind === 'external' ? null : parent.topicId,
      depth: (parent.depth ?? 0) + 1,
      role: action,
      parent: action === 'reply' ? parent.id : null,
      quoteOf: action === 'quote' ? parent.id : null,
      rel: relationOf(persona, pById.get(parent.authorId)),
      form: f.form,
      cheap: f.cheap,
      exec: f.cheap ? 'pool' : f.form === 'short' ? 'short' : 'full',
      followOn: reason,
    });
    n.mentions.add(parent.authorId);
    return n;
  };
  // Mention reactions owed by earlier days (stateless: same seeded draw as on the day of the post).
  const carried = mentionDebts({ past, personas, spec, start: day.start, end: day.end }).map((e) => reactionNode(extNode(e.post), e.personaId, e.action, e.at, e.reason));
  const all = cascade(reactor, [...nodes, ...carried], { horizon, personas });
  for (const n of all) {
    if (n.exec) continue;
    n.exec = n.cheap ? 'pool' : n.form === 'short' ? 'short' : 'full';
    n.form ??= 'full';
  }
  for (const n of all) if ((n.role === 'reply' || n.role === 'quote') && n.exec !== 'pool' && !n.textMentions) tagNode(n, n.role, n.form === 'short' ? 1 : 3);
  // Mention → reaction (spec.sampling.mention_response): every @mentioned persona gets one seeded
  // outcome. Replies/quotes landing before the horizon run today; later ones are carried by tomorrow's run.
  const answered = new Set(all.filter((x) => x.parent || x.quoteOf).map((x) => `${x.parent ?? x.quoteOf}:${x.authorId}`));
  for (const n of [...all]) {
    if (!n.textMentions?.length || (n.depth ?? 0) >= MAX_DEPTH) continue;
    for (const mid of n.textMentions) {
      const persona = pById.get(mid);
      if (!persona || isNews(persona) || mid === n.authorId || answered.has(`${n.id}:${mid}`)) continue;
      const d = mentionDecision(spec, persona, postIdOf(n.id), pById.get(n.authorId));
      if (d.action === 'like' && !n.likes.includes(mid)) n.likes.push(mid);
      const at = n.createdAt + d.delayMin * 6e4;
      if ((d.action !== 'reply' && d.action !== 'quote') || at > horizon) continue;
      answered.add(`${n.id}:${mid}`);
      all.push(reactionNode(n, mid, d.action, at, 'mention'));
    }
  }
  all.push(...externals.values());
  // Self-thread: continuation parts by the same author, a minute or two apart (same depth level).
  for (const n of all.filter((x) => x.exec === 'thread' && x.kind === 'thread')) {
    let prev = n;
    for (let k = 2; k <= THREAD_PARTS; k++) {
      const part = node({ id: `${n.id}.t${k}`, authorId: n.authorId, createdAt: prev.createdAt + 60000 + Math.floor(rand() * 90000), vector: n.vector, role: 'original', kind: 'thread-part', exec: 'thread', parent: prev.id, theme: n.theme, threadRoot: n.id, threadPart: k });
      all.push(part);
      prev = part;
    }
  }
  return { day, nodes: all.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), reactor, calibration: cal, llmCap, sampler, rand };
}

/** Per-task generation spec (length, media plan, emoji, …) drawn from the realism sampler. */
function taskSpec({ node, persona, topic, sampler, rand, postId, hasPassages, giphy }) {
  const role = node.kind === 'wire' ? 'wire' : node.role;
  const form = node.form ?? null;
  const cheap = node.exec === 'pool';
  const short = form === 'short';
  let mediaPlan = null;
  if (role !== 'wire' && !cheap && !short) {
    const news = safeUrl(topic?.url ?? '') ? { url: topic.url, title: topic.title } : null;
    mediaPlan = planFor(sampler, role === 'original' ? 'original' : role, { news, giphy, persona, topic });
    // Topic roots re-draw so link cards keep their spec share despite URL-less standalones.
    if (role === 'original' && !mediaPlan && news) for (let i = 0; i < 2 && mediaPlan?.kind !== 'link_card'; i++) mediaPlan = planFor(sampler, 'original', { news, giphy, persona }) ?? mediaPlan;
    if (mediaPlan?.kind === 'poll' && (role !== 'original' || node.kind === 'thread' || node.kind === 'thread-part')) mediaPlan = null;
    if (mediaPlan?.kind === 'link_card' && !news) mediaPlan = null;
  }
  const media = role === 'wire' ? 'link_card' : mediaPlan?.kind ?? null;
  let length;
  if (role === 'wire') length = { min: 60, max: 240 };
  else if (short) length = { min: 10, max: 40 };
  else {
    length = sampler.lengthRange(persona);
    // A full-form reply/quote is > 40 chars by definition: draw from the persona's buckets above 40
    // (conditional distribution), not a fixed fallback, so long replies keep their spec share.
    for (let i = 0; i < 12 && role !== 'original' && form === 'full' && length.max <= 40; i++) length = sampler.lengthRange(persona);
    if (role !== 'original' && form === 'full' && length.max <= 40) length = { min: 41, max: 120 };
  }
  if (media === 'gif') length = { min: 1, max: Math.min(length.max, 80) };
  if (media === 'poll') length = { min: Math.max(20, length.min), max: Math.max(60, Math.min(length.max, 140)) };
  const modern = clamp(persona.modernity ?? 3, 1, 5);
  const emoji = role !== 'wire' && (sampler.wantsEmoji() || (modern >= 4 && sampler.wantsEmoji())) && !(modern <= 2 && rand() < 0.5);
  const type = pickType(rand, persona, node, media);
  const llm = role !== 'wire' && !cheap;
  const hashtags = llm && !short ? sampler.hashtagCount(role, persona) : 0;
  return {
    taskId: node.id,
    postId,
    role: node.kind === 'thread-part' ? 'original' : role,
    archetype: type,
    length,
    emoji: llm && emoji,
    hashtag: hashtags > 0,
    hashtags,
    native: llm && !short && Boolean(persona.native_language?.phrases?.length) && rand() < NATIVE_RATE,
    wantQuote: llm && !short && hasPassages && rand() < (QUOTE_RATE[role] ?? 0.2),
    media,
    mediaPlan,
    form,
    mention: null,
    wantNote: llm && !short && node.kind !== 'thread-part' && rand() < NOTE_RATE,
    ...(node.threadPart ? { threadPart: `${node.threadPart}/${THREAD_PARTS}` } : node.kind === 'thread' ? { threadPart: `1/${THREAD_PARTS}` } : {}),
  };
}

const sig = (t) => sha256(JSON.stringify([t.taskId, t.personaId, t.role, t.exec, t.form ?? null, t.parentTaskId ?? null, t.topicId ?? null, t.archetype, t.media ?? null])).slice(0, 16);

/** Deterministic wire text: the real (sanitized) headline + one neutral line. No LLM. */
export function wireText(topic, persona, rand = Math.random) {
  const title = sanitizeUntrusted(topic?.title ?? '', 200).replace(/\s+/g, ' ').trim();
  const line = WIRE_LINES[Math.floor(rand() * WIRE_LINES.length)];
  const text = `${title}\n\n${line}`;
  return [...text].length <= 270 ? text : title;
}

/**
 * Run (or resume) the daily generation. Never throws for content problems; returns a result with
 * `exitCode` (0 complete, 1 invalid/error, 2 partial).
 */
export async function runDaily(opts = {}) {
  const t0 = Date.now();
  const env = opts.env ?? process.env;
  const root = opts.root ?? SITE_DIR;
  const log = opts.quiet ? () => {} : (opts.log ?? ((m) => console.error(m)));
  const mock = Boolean(opts.mock);
  const dryRun = Boolean(opts.dryRun);
  const offline = mock || (dryRun && !opts.live);
  const spec = opts.spec ?? loadDistribution();
  const tz = spec.reference_timezone ?? 'UTC';
  const personas = opts.personas ?? loadPersonas();
  const byId = new Map(personas.map((p) => [p.id, p]));
  const date = opts.date;
  const publish = String(env.PUBLISH_ENABLED ?? 'true').toLowerCase() !== 'false';
  const paths = outputPaths(root, date, { mock, publish, suffix: opts.suffix ?? null });
  const runPath = mock ? 'mock' : dryRun && offline ? 'dry-run' : 'cloudflare';
  const prev = opts.fresh ? null : readJson(paths.run);
  const seed = String(opts.seed ?? env.GEN_SEED ?? prev?.seed ?? date);
  // Deterministic from (date, seed) unless a nonce is given (replay / deliberate re-roll).
  const nonce = opts.nonce ?? prev?.nonce ?? hash8(`nonce:${date}:${seed}`);
  const maxCalls = Number(opts.maxCalls ?? env.GEN_MAX_CALLS) || DEFAULT_MAX_CALLS;
  const minComplete = clamp(Number(env.GEN_MIN_COMPLETE) || DEFAULT_MIN_COMPLETE, 0, 1);
  const runId = `daily-${date}${paths.suffix}`;
  const write = (file, data) => {
    if (!dryRun) writeJsonAtomic(file, data);
  };
  const config = opts.llmConfig ?? loadLlmConfig();
  const wallMs = Number(opts.wallClockMs ?? env.GEN_WALL_CLOCK_MS) || (config.wallClockMinutes ?? 25) * 60000;
  const deadline = t0 + wallMs;

  if (!offline && !opts.client && (!env.CF_ACCOUNT_ID || !env.CF_AI_TOKEN)) {
    log('no Workers AI credentials: set CF_ACCOUNT_ID and CF_AI_TOKEN (Cloudflare Workers AI). Use --mock for offline runs.');
    return { status: 'error', exitCode: 1, error: 'no-key', paths, path: runPath };
  }

  // 1) Budget plan (Neurons per model, from today's remaining quota). Reused on resume so every task id is stable.
  const usageDay = utcDay();
  const usageFileLlm = budgetFile(root, false);
  const usedToday = offline ? {} : loadUsage(usageFileLlm, usageDay);
  const discovery = offline || opts.client ? { available: null, skipped: [] } : await discoverModels({ config, env, fetchImpl: opts.fetchImpl, log });
  for (const s of discovery.skipped ?? []) log(`model ${s.name} (${s.model}) skipped: ${s.reason}`);
  if (!offline && !opts.client) {
    // Providers whose secret isn't set get no allowance, so the plan only counts usable models.
    const keyed = config.providers.filter((p) => llmConfig(env, p).apiKey).map((p) => p.name);
    for (const p of config.providers) if (!keyed.includes(p.name)) log(`model ${p.name} skipped: no ${p.keyEnv}`);
    discovery.available = new Set(keyed.filter((n) => !discovery.available || discovery.available.has(n)));
  }
  const budget = planBudget({ config, used: usedToday, available: discovery.available, maxCalls });
  const content = prev?.nonce === nonce && prev?.budgetPlan?.content ? prev.budgetPlan.content : budget.content;
  log(`budget: ${budget.models.map((m) => `${m.name} ${m.plan}+${m.reserve}`).join(', ')} → ~${budget.totals.neurons} Neurons; plan ${JSON.stringify(content)}`);

  // 2) Topics (reused on resume).
  let topicsDoc = opts.fresh || opts.refetch ? null : readJson(paths.topics);
  if (!topicsDoc) {
    const fetchImpl = opts.fetchImpl ?? (offline ? fixtureFetch(FEEDS) : globalThis.fetch);
    const pool = await fetchPool({ env: offline ? { ...env, NEWS_FEEDS: '' } : env, fetchImpl, feeds: offline ? FEEDS : undefined, log });
    const n = topicCount(opts.topics ?? env.GEN_TOPICS ?? content.topics);
    const sel = selectTopics(pool.items, personas.filter((p) => !isNews(p)), { n, date, rand: seededRng('topics', seed, date) });
    topicsDoc = {
      date,
      generatedAt: new Date().toISOString(),
      sourceSnapshotHash: sel.poolHash,
      feeds: pool.report,
      picks: sel.picks.map((t) => ({ ...t, score: round3(t.score) })),
      dropped: sel.dropped,
      pool: sel.kept.slice(0, 30).map((s) => ({ id: s.id, title: s.title, domain: s.domain ?? domainOf(s.url) })),
    };
    write(paths.topics, topicsDoc);
  }
  const topics = topicsDoc.picks;
  const topicById = new Map(topics.map((t) => [t.id, t]));
  log(`topics: ${topics.map((t) => `${t.tier}:${t.title.slice(0, 50)}`).join(' | ')}`);
  if (opts.topicsOnly) return { status: 'topics', exitCode: 0, topics: topicsDoc, paths, path: runPath };

  // 3) Rotation + capabilities.
  const caps = { ...(prev?.modelCaps ?? {}) };
  let rotation;
  if (opts.client) rotation = singleClientRotation(opts.client);
  else {
    const cap = Number(opts.mockCallCap ?? Infinity);
    rotation = createRotation({
      config,
      plan: budget,
      env,
      log,
      caps,
      makeClient: offline
        ? (p, cfg, allowance) => createMockClient({ maxCalls: Math.max(0, Math.min(allowance, cap)), tools: p.tools === 'off' || env.LLM_TOOLS === 'off' ? 'off' : 'on', nonce, model: `mock/${p.model.replace(/^@cf\//, '')}`, name: p.name })
        : null,
      fetchImpl: opts.fetchImpl,
    });
  }
  Object.assign(caps, await rotation.probe(caps));

  // 4) Embeddings (optional MiniLM; hash vectors offline; tag overlap fallback marks the run degraded).
  const embedder = opts.embedder ?? (await createEmbedder({ mode: offline ? 'hash' : env.GEN_EMBEDDINGS === 'off' ? 'none' : 'auto', log, cacheDir: env.TRANSFORMERS_CACHE || null }));
  const tEmbed = Date.now();
  const personaVecs = await personaVectors(personas, embedder, { file: path.join(root, 'content', 'embeddings', 'personas.json'), write: !dryRun && !offline });
  const anchors = await stanceAnchors(embedder);
  const vecCache = new Map();
  const embedMany = async (pairs) => {
    const miss = pairs.filter(([k, txt]) => txt && !vecCache.has(k));
    if (!miss.length || embedder.kind === 'none') return;
    const vecs = await embedder.embed(miss.map(([, txt]) => String(txt).slice(0, 600)));
    if (vecs) miss.forEach(([k], i) => vecCache.set(k, vecs[i]));
  };
  await embedMany([...topics.map((t) => [`topic:${t.id}`, t.title]), ...[...new Set(personas.flatMap((p) => Object.keys(p.topic_affinity ?? {})))].map((k) => [`theme:${k}`, k.replace(/_/g, ' ')])]);
  const nodeVec = (post) => vecCache.get(`topic:${post.topicId}`) ?? vecCache.get(`theme:${Object.keys(post.vector ?? {})[0]}`) ?? null;
  // Per persona, cosine to each topic/theme is z-scored → mean-1 multiplier on react.mjs affinity.
  const refVecs = [...vecCache.entries()].filter(([k]) => k.startsWith('topic:') || k.startsWith('theme:')).map(([, v]) => v);
  const affStats = new Map();
  for (const [pid, pv] of personaVecs) {
    const cs = refVecs.map((v) => cosineVec(pv, v));
    const mean = cs.reduce((a, b) => a + b, 0) / Math.max(1, cs.length);
    const sd = Math.sqrt(cs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, cs.length)) || 1e-3;
    affStats.set(pid, { mean, sd });
  }
  const affinityFn = embedder.kind === 'none' || !refVecs.length ? null : (persona, post) => {
    const pv = personaVecs.get(persona.id);
    const v = nodeVec(post);
    const s = affStats.get(persona.id);
    return pv && v && s ? clamp(1 + 0.25 * ((cosineVec(pv, v) - s.mean) / s.sd), 0.5, 1.5) : null;
  };
  const embedMs = Date.now() - tEmbed;

  // 5) Plan + reactions (no LLM). Reply forms are sampled per reaction; cheap forms skip the LLM cap.
  const formSampler = createSampler(spec, `form:${seed}:${nonce}`);
  const formFn = (persona, action) => {
    const f = formSampler.replyForm(action === 'quote' ? 'quote' : 'reply', persona);
    return { form: f.form, cheap: CHEAP_FORMS.has(f.form) };
  };
  const prefix = `${mock ? 'm' : paths.suffix === '-cf' ? 'c' : 'd'}${date.replace(/-/g, '')}`;
  const postIdOf = (taskId) => `${prefix}-${hash8(`${date}:${taskId}`)}`;
  const others = loadOtherPosts(paths.postsDir, [paths.posts]);
  const plan = planDay({ personas, spec, topics, date, seed, nonce, tz, content, formFn, affinityFn, calibrationFile: path.join(root, 'content', 'state', 'calibration.json'), writeCalibration: !dryRun && !mock, past: others, postIdOf });
  const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
  const hasPassages = (p) => (p.quotables ?? []).length + (p.quote_bank ?? []).length + (p.sources ?? []).filter((s) => s.local).length > 0;
  const gClient = !offline && schemaAllowsGiphy() ? createGiphyClient({ apiKey: env.GIPHY_API_KEY, maxCalls: Number(env.GIPHY_MAX_CALLS || 10) }) : null;
  const giphy = gClient?.enabled ? gClient : null;
  const externalTasks = plan.nodes.filter((n) => n.kind === 'external').map((n) => ({ taskId: n.id, kind: 'external', role: 'original', exec: 'external', level: -1, personaId: n.authorId, postId: n.external.id, parentTaskId: null, topicId: null, at: n.external.createdAt, status: 'done', fields: { text: n.external.text ?? '' }, stance: n.external.stance ?? null, source: 'corpus' }));
  const tasks = plan.nodes.filter((n) => n.kind !== 'external').map((n) => {
    const persona = byId.get(n.authorId);
    const spec1 = taskSpec({ node: n, persona, topic: topicById.get(n.topicId), sampler: plan.sampler, rand: plan.rand, postId: postIdOf(n.id), hasPassages: hasPassages(persona), giphy });
    if (n.role === 'reply' && n.exec !== 'pool' && plan.rand() < 0.3) spec1.mention = byId.get(nodeById.get(n.parent)?.authorId)?.handle ?? null;
    if (n.textMentions?.length) spec1.mentions = n.textMentions.map((id) => byId.get(id)?.handle).filter(Boolean);
    const t = { taskId: n.id, kind: n.kind ?? n.role, role: spec1.role, exec: n.exec, form: n.form ?? null, level: n.kind === 'thread-part' ? 0 : n.depth ?? 0, personaId: n.authorId, postId: spec1.postId, parentTaskId: n.parent ?? n.quoteOf ?? null, topicId: n.topicId, at: iso(n.createdAt), archetype: spec1.archetype, media: spec1.media, status: 'pending', spec: spec1 };
    t.sig = sig(t);
    return t;
  });
  // The day's guaranteed polls (spec.sampling.media.polls_per_day_min): a poll is ~1% of originals,
  // so a ~60-original day often samples none. Convert a plain standalone original.
  const pollMin = spec.sampling.media?.polls_per_day_min ?? 0;
  const pollable = tasks.filter((t) => t.role === 'original' && !t.media && (t.exec === 'originals' || t.exec === 'single') && t.kind !== 'thread' && t.kind !== 'thread-part');
  for (let have = tasks.filter((t) => t.media === 'poll').length; have < pollMin && pollable.length; have++) {
    const t = pollable.splice(Math.floor(plan.rand() * pollable.length), 1)[0];
    const mp = planFor(plan.sampler, 'original', { persona: byId.get(t.personaId), kind: 'poll' });
    Object.assign(t.spec, { media: 'poll', mediaPlan: mp, length: { min: Math.max(20, t.spec.length.min), max: Math.max(60, Math.min(t.spec.length.max, 140)) }, archetype: pickType(plan.rand, byId.get(t.personaId), nodeById.get(t.taskId), 'poll') });
    Object.assign(t, { media: 'poll', archetype: t.spec.archetype });
    t.sig = sig(t);
  }
  // Gate repair (generate --repair): regenerate the items the distribution gate flagged, once, with
  // the fix applied to their spec (shorter length bucket / persona-typical length). Everything else resumes.
  const repair = new Map((opts.repair ?? []).map((r) => [r.taskId, r]));
  for (const t of tasks) {
    const r = repair.get(t.taskId);
    if (!r || t.exec === 'pool' || t.exec === 'wire') continue;
    if (r.length) t.spec.length = { ...r.length };
    t.repair = r.reason ?? 'gate';
  }

  // 6) Execute by depth level (a parent's text exists before its children), resuming finished work.
  const workDoc = opts.fresh ? null : readJson(paths.work);
  const work = workDoc && workDoc.nonce === nonce ? workDoc.results ?? {} : {};
  const policyCtx = policyContext(personas, { allowNames: String(env.POLICY_ALLOW_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
  const newsPool = (topicsDoc.pool ?? []).length ? topicsDoc.pool : topics.map((t) => ({ id: t.id, title: t.title, domain: t.domain }));
  const taskById = new Map([...externalTasks, ...tasks].map((t) => [t.taskId, t]));
  const textOf = new Map(externalTasks.map((t) => [t.taskId, t.fields.text]));
  const blockedTopics = new Map();
  const turnRand = seededRng('turn', seed, nonce);
  const tracker = createStyleTracker();
  const pools = loadPools(personas, { root, log });
  const reactionUsage = loadReactionUsage({ stateFile: usageFile(root, mock), postsDir: paths.postsDir, exclude: [path.basename(paths.posts)] });
  const picker = createPoolPicker({ pools, used: reactionUsage.used, date, rand: seededRng('pool', seed, nonce), embedder, log });
  const microLog = { calls: 0, requests: 0, replies: 0, rejected: 0, added: [] };
  let microDone = Boolean(prev?.nonce === nonce && prev?.micro?.ran);
  let budgetHit = false;
  let timeUp = false;
  const stopped = () => budgetHit || timeUp;
  const checkClock = () => {
    if (!timeUp && Date.now() > deadline) {
      timeUp = true;
      log(`wall clock (${Math.round(wallMs / 60000)} min) reached; remaining LLM tasks stay pending`);
    }
    return timeUp;
  };
  const chain = (taskId, max = 4) => {
    const out = [];
    let t = taskById.get(taskId);
    while (t && out.length < max) {
      if (textOf.has(t.taskId)) out.unshift({ id: t.postId, authorId: t.personaId, handle: byId.get(t.personaId)?.handle ?? t.personaId, text: textOf.get(t.taskId) });
      t = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    }
    return out;
  };
  const postToTask = new Map([...externalTasks, ...tasks].map((t) => [t.postId, t.taskId]));
  const threadFn = (postId) => chain(postToTask.get(postId) ?? '', 6);
  const topicCtx = (topic) => (topic ? { id: topic.id, title: topic.title, domain: topic.domain || domainOf(topic.url ?? '') || topic.source } : null);
  const ctxFor = (t) => {
    const persona = byId.get(t.personaId);
    const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    const target = parent && parent.personaId !== t.personaId ? byId.get(parent.personaId) : null;
    const node = nodeById.get(t.taskId);
    return {
      topic: topicCtx(topicById.get(t.topicId)),
      thread: parent ? chain(parent.taskId) : [],
      target: target ? { handle: target.handle } : null,
      relation: target ? relationEntry(persona, target.id) : null,
      theme: node?.theme ? themeLine(persona, node.theme, turnRand) : null,
      pool: newsPool,
      threadFn,
    };
  };
  const stanceFor = (t) => {
    const persona = byId.get(t.personaId);
    const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    const rand = seededRng('stance', t.taskId, nonce);
    if (isNews(persona)) return 'neutral';
    const pvec = parent ? vecCache.get(`post:${parent.taskId}`) : null;
    const node = nodeById.get(t.taskId);
    const relation = parent && parent.personaId !== t.personaId ? (node?.rel === 'follows' ? null : node?.rel ?? undefined) : null;
    return chooseStance({ persona, targetAuthorId: parent?.personaId ?? null, targetStance: parent?.stance ?? null, hint: stanceHint(pvec, anchors), relation, rand });
  };
  const passagesFor = (t) => {
    if (!t.spec.wantQuote) return new Map();
    const persona = byId.get(t.personaId);
    const toolbox = createToolbox({ persona, pool: newsPool, thread: threadFn });
    const parent = t.parentTaskId ? textOf.get(t.parentTaskId) : '';
    toolbox.call('search_sources', { query: [topicById.get(t.topicId)?.title, nodeById.get(t.taskId)?.theme, parent].filter(Boolean).join(' ').slice(0, 200) || persona.name });
    return toolbox.passages;
  };
  const markDone = (t, { fields, model, source, reactionId: rid = null }) => {
    t.status = 'done';
    t.fields = fields;
    t.model = model;
    t.source = source;
    if (rid) t.reactionId = rid;
    textOf.set(t.taskId, fields.text);
    work[t.taskId] = { sig: t.sig, fields, model, source, stance: t.stance, ...(rid ? { reactionId: rid } : {}) };
  };
  const markFailed = (t, r) => {
    t.status = r.error === 'policy' ? 'blocked' : 'failed';
    t.error = `${r.error}: ${r.violations?.length ? r.violations.map((v) => (typeof v === 'string' ? v : `${v.rule}:${v.detail}`)).join('; ') : r.detail ?? ''}`.slice(0, 200);
    if (r.violations) t.violations = r.violations.slice(0, 5);
    if (r.error === 'policy' && t.topicId) blockedTopics.set(t.topicId, t.taskId);
    // Policy blocks are sticky: a resume must not re-roll a topic the gate already failed.
    if (r.error === 'policy') work[t.taskId] = { sig: t.sig, blocked: t.error, violations: t.violations };
    log(`✗ ${t.taskId} @${byId.get(t.personaId)?.handle}: ${t.error}`);
  };
  const markLiked = (t, why) => {
    t.status = 'liked';
    t.error = why;
    work[t.taskId] = { sig: t.sig, liked: why };
  };
  const logDone = (t) => log(`✓ ${t.taskId} @${byId.get(t.personaId)?.handle} [${t.exec}:${t.archetype}${t.media ? `+${t.media}` : ''}${t.stance ? ` ${t.stance}` : ''}] ${String(t.fields.text).replace(/\s+/g, ' ').slice(0, 70)}`);

  /** Gate: parent finished, topic not blocked, cached result reuse. Returns true when the task must run. */
  const gate = (t) => {
    const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    if (parent && parent.status !== 'done' && t.kind !== 'thread-part') {
      t.status = parent.status === 'pending' ? 'pending' : 'dropped';
      t.error = `parent ${parent.status}`;
      return false;
    }
    if (t.topicId && blockedTopics.has(t.topicId)) {
      t.status = 'dropped';
      t.error = 'topic blocked';
      return false;
    }
    const cached = t.repair ? null : work[t.taskId];
    if (cached && cached.sig === t.sig) {
      t.resumed = true;
      t.calls = 0;
      if (cached.blocked) {
        Object.assign(t, { status: 'blocked', error: cached.blocked, violations: cached.violations });
        if (t.topicId) blockedTopics.set(t.topicId, t.taskId);
      } else if (cached.liked) Object.assign(t, { status: 'liked', error: cached.liked });
      else {
        Object.assign(t, { status: 'done', fields: cached.fields, model: cached.model, source: cached.source ?? 'llm', stance: cached.stance ?? null, ...(cached.reactionId ? { reactionId: cached.reactionId } : {}) });
        textOf.set(t.taskId, cached.fields.text);
      }
      return false;
    }
    return true;
  };

  const runGroup = async (group, { role, kind }) => {
    if (!group.length) return;
    if (stopped() || checkClock()) return;
    const client = rotation.clientFor(role, group[0].personaId);
    for (const t of group) {
      t.stance = stanceFor(t);
      t.spec.stance = t.stance;
    }
    const items = group.map((t) => ({ id: t.taskId, persona: byId.get(t.personaId), task: t.spec, ctx: ctxFor(t), passages: passagesFor(t) }));
    let res;
    try {
      res = await runBatch({ client, items, byId, kind, policyCtx, tracker, rand: turnRand, giphy });
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
      budgetHit = true;
      log(`budget exhausted (${role}) at ${rotation.calls} calls; remaining LLM tasks stay pending (rerun to resume)`);
      return;
    }
    let ok = 0;
    const share = Math.round((res.calls / group.length) * 100) / 100;
    for (const t of group) {
      const r = res.results.get(t.taskId) ?? { ok: false, error: 'invalid', detail: 'no result' };
      t.calls = share;
      if (r.ok) {
        markDone(t, { fields: r.fields, model: client.model ?? 'unknown', source: 'llm' });
        ok++;
        logDone(t);
      } else markFailed(t, r);
    }
    client.noteItems(ok);
  };

  const runSingle = async (t) => {
    if (stopped() || checkClock()) return;
    const persona = byId.get(t.personaId);
    t.stance = stanceFor(t);
    t.spec.stance = t.stance;
    const client = rotation.clientFor('voice', t.personaId, { needTools: true });
    let r;
    try {
      r = await runTurn({ client, persona, byId, task: t.spec, ctx: ctxFor(t), nativeTools: client.nativeTools, policyCtx, rand: turnRand, tracker, giphy });
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
      budgetHit = true;
      log(`budget exhausted (voice) at ${rotation.calls} calls; remaining LLM tasks stay pending (rerun to resume)`);
      return;
    }
    t.calls = r.calls;
    t.repairs = r.repairs;
    t.tools = r.toolLog?.map((x) => x.name);
    if (!r.ok) {
      if (r.capped && r.error === 'llm') {
        budgetHit = !rotation.hasCapacity('voice');
        t.error = `llm: ${r.detail ?? ''}`.slice(0, 200);
        return;
      }
      markFailed(t, r);
      return;
    }
    markDone(t, { fields: r.fields, model: client.model ?? 'unknown', source: 'llm' });
    client.noteItems(1);
    logDone(t);
  };

  const runWire = (t) => {
    const topic = topicById.get(t.topicId);
    const text = wireText(topic, byId.get(t.personaId), seededRng('wire', t.taskId, nonce));
    const check = checkPost({ text }, policyCtx, { topic: topicCtx(topic) });
    t.stance = 'neutral';
    if (!check.ok) return markFailed(t, { error: 'policy', detail: check.violations.map((v) => `${v.rule}:${v.detail}`).join('; '), violations: check.violations });
    markDone(t, { fields: { text }, model: 'none', source: 'wire' });
    logDone(t);
  };

  /** Cheap reaction from the persona's pool (or the art library for image-only). null → LLM fallback. */
  const runPool = async (t) => {
    const persona = byId.get(t.personaId);
    t.stance = stanceFor(t);
    const parent = taskById.get(t.parentTaskId);
    const rand = seededRng('poolmedia', t.taskId, nonce);
    if (t.form === 'image_only') {
      const plan = planMedia({ ...plan0Sampler, rand, mediaKind: () => 'image' }, 'reply', {});
      const f = plan ? await materializeFor(plan, defaultFill(plan, { rand }), { rand, postId: t.postId }) : {};
      if (f.media?.length) {
        markDone(t, { fields: { text: '', ...f }, model: 'none', source: 'library' });
        return true;
      }
      return false;
    }
    const topic = topicById.get(t.topicId);
    const postTags = [...tokens(topic?.title ?? ''), ...Object.keys(nodeById.get(t.taskId)?.vector ?? {}), ...tokens(textOf.get(parent?.taskId) ?? '').slice(0, 8)];
    const entry = await picker.pick({ persona, form: t.form, stance: t.stance, postVec: vecCache.get(`post:${parent?.taskId}`) ?? null, postTags });
    if (!entry) return false;
    const rid = entry.rid ?? reactionId(entry);
    let fields;
    if (entry.text !== undefined || entry.emoji !== undefined) fields = { text: String(entry.text ?? entry.emoji) };
    else {
      const em = entryMedia(entry, { stance: t.stance, giphyEnabled: Boolean(giphy), rand });
      const f = em ? await materializeFor(em.plan, em.fill, { giphy, rand, postId: t.postId }) : {};
      if (!f.media?.length) return false;
      fields = { text: '', media: f.media };
    }
    if (fields.text && !checkPost({ text: fields.text }, policyCtx, { topic: topicCtx(topic) }).ok) return false;
    markDone(t, { fields, model: 'none', source: 'pool', reactionId: rid });
    return true;
  };
  const plan0Sampler = createSampler(spec, `library:${seed}:${nonce}`);

  /** One micro call per run: riffs on the pools for up to ~20 cheap text reactions + pool refills. */
  const runMicroOnce = async (cands) => {
    if (microDone || !content.microPool || stopped() || checkClock() || !rotation.hasCapacity('micro')) return new Set();
    microDone = true;
    const reqs = cands.filter((t) => t.form === 'few_words' || t.form === 'emoji_only').slice(0, MICRO_REPLIES);
    for (const t of reqs) t.stance = stanceFor(t);
    const requests = reqs.map((t) => {
      const persona = byId.get(t.personaId);
      const examples = (pools.get(persona.id) ?? []).filter((e) => e.stance === t.stance && (e.text ?? e.emoji)).slice(0, 4).map((e) => e.text ?? e.emoji);
      return { id: t.taskId, persona, stance: t.stance, form: t.form, target: textOf.get(t.parentTaskId) ?? '', examples };
    });
    const low = picker.lowPersonas(personas.filter((p) => !isNews(p))).slice(0, MICRO_REFILL_PERSONAS);
    const refills = low.map(({ persona }) => {
      const list = pools.get(persona.id) ?? [];
      const counts = Object.fromEntries(['agree', 'disagree', 'mock', 'awe', 'confused', 'hype'].map((s) => [s, picker.fresh(persona.id, 'few_words', s) + picker.fresh(persona.id, 'short', s)]));
      const stances = Object.entries(counts).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([s]) => s);
      return { persona, stances, n: MICRO_REFILL_MAX, examples: list.filter((e) => e.text).slice(0, 5).map((e) => e.text), existing: list };
    });
    const client = rotation.clientFor('micro', null);
    const res = await runMicro({ client, requests, refills, byId, policyCtx, root, date, write: !offline && !dryRun, log });
    Object.assign(microLog, { ran: true, calls: res.calls, requests: requests.length, replies: res.replies.size, rejected: res.rejected, model: client.model ?? null });
    for (const a of res.added) {
      const list = pools.get(a.personaId) ?? [];
      for (const e of a.entries) list.push({ ...e, rid: e.rid ?? reactionId(e), kind: e.kind ?? ['text', 'emoji', 'gif_query', 'meme_template'].find((k) => typeof e[k] === 'string') });
      pools.set(a.personaId, list);
      microLog.added.push({ personaId: a.personaId, n: a.entries.length });
    }
    const done = new Set();
    for (const t of reqs) {
      const text = res.replies.get(t.taskId);
      if (!text) continue;
      markDone(t, { fields: { text }, model: client.model ?? 'unknown', source: 'micro' });
      logDone(t);
      done.add(t.taskId);
    }
    client.noteItems(done.size);
    return done;
  };

  const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  const levels = [...new Set(tasks.map((t) => t.level))].sort((a, b) => a - b);
  for (const L of levels) {
    const todo = tasks.filter((t) => t.level === L && gate(t));
    // Parent texts → vectors (stance hint, pool ranking).
    await embedMany(todo.map((t) => taskById.get(t.parentTaskId)).filter((p) => p?.status === 'done').map((p) => [`post:${p.taskId}`, p.fields.text]));
    for (const t of todo.filter((x) => x.exec === 'wire')) runWire(t);
    for (const t of todo.filter((x) => x.exec === 'single')) await runSingle(t);
    // Self-thread (root + parts in one request).
    for (const root0 of todo.filter((x) => x.exec === 'thread' && x.kind === 'thread')) {
      const parts = [root0, ...todo.filter((x) => nodeById.get(x.taskId)?.threadRoot === root0.taskId)];
      await runGroup(parts, { role: 'batch', kind: 'thread' });
      let broken = false;
      for (const p of parts) {
        if (broken && p.status === 'done') Object.assign(p, { status: 'dropped', error: 'earlier thread part failed' });
        if (p.status !== 'done') broken = true;
      }
    }
    // Cheap forms: one micro call riffs on the pools, the rest come straight from the pools.
    const cheap = todo.filter((x) => x.exec === 'pool');
    const viaMicro = cheap.length ? await runMicroOnce(cheap) : new Set();
    const fallback = [];
    for (const t of cheap) {
      if (viaMicro.has(t.taskId)) continue;
      if (!(await runPool(t))) fallback.push(t);
    }
    for (const t of fallback) {
      t.spec = { ...t.spec, form: 'short', length: { min: 10, max: 40 }, archetype: t.role === 'quote' ? t.spec.archetype : t.spec.archetype };
      t.fallback = 'pool exhausted → LLM short';
    }
    // Batches (openers per topic, originals ×4, full replies ×5, short replies ×6).
    const byTopic = new Map();
    for (const t of todo.filter((x) => x.exec === 'openers')) byTopic.set(t.topicId, [...(byTopic.get(t.topicId) ?? []), t]);
    for (const g of byTopic.values()) await runGroup(g, { role: 'batch', kind: 'openers' });
    for (const g of chunk(todo.filter((x) => x.exec === 'originals'), ORIGINALS_PER_BATCH)) await runGroup(g, { role: 'batch', kind: 'originals' });
    for (const g of chunk(todo.filter((x) => x.exec === 'full' && x.status === 'pending'), REPLIES_PER_BATCH)) await runGroup(g, { role: 'batch', kind: 'replies' });
    const shorts = [...todo.filter((x) => x.exec === 'short' && x.status === 'pending'), ...fallback];
    for (const g of chunk(shorts, SHORTS_PER_BATCH)) {
      if (!stopped() && !checkClock() && !rotation.hasCapacity('micro')) {
        for (const t of g.filter((x) => x.fallback)) markLiked(t, 'pool exhausted, no LLM capacity');
        continue;
      }
      await runGroup(g, { role: 'micro', kind: 'replies' });
    }
    for (const t of fallback) if (t.status === 'pending' && stopped()) markLiked(t, 'pool exhausted, no LLM capacity');
    for (const t of todo) {
      if (t.status === 'pending' && !stopped()) Object.assign(t, { status: 'failed', error: t.error ?? 'not generated' });
      if (t.status === 'done' && t.stance == null) t.stance = stanceFor(t);
    }
  }
  // A policy failure fails the whole topic (when unsure, fail the topic).
  for (const t of tasks) if (t.topicId && blockedTopics.has(t.topicId) && t.status === 'done') {
    t.status = 'dropped';
    t.error = 'topic blocked';
  }
  if (!dryRun) writeJsonAtomic(paths.work, { runId, date, nonce, results: work });

  // 7) Assemble posts (liked conversions become persona likes on the parent).
  for (const t of tasks.filter((x) => x.status === 'liked')) {
    const parent = nodeById.get(t.parentTaskId);
    if (parent && !parent.likes.includes(t.personaId) && parent.authorId !== t.personaId) parent.likes.push(t.personaId);
  }
  const origin = mock ? 'mock' : 'cloudflare';
  const done = tasks.filter((t) => t.status === 'done');
  const posts = done.map((t) => assemblePost({ t, node: nodeById.get(t.taskId), taskById, byId, topic: topicById.get(t.topicId), runId, origin, rand: seededRng('votes', t.taskId, nonce) }));
  const retaiks = retaikRows({ posts, byId, sampler: createSampler(spec, `retaik:${seed}:${nonce}`), pairSampler: (k) => createSampler(spec, `retaik:${seed}:${nonce}:${k}`), key: `${seed}:${nonce}`, prefix, date, runId, origin });
  const allPosts = [...posts, ...retaiks];

  // 8) Completeness.
  const topicStatus = topics.map((tp) => {
    const own = tasks.filter((t) => t.topicId === tp.id);
    const ok = !blockedTopics.has(tp.id) && own.some((t) => t.status === 'done' && (t.kind === 'wire' || t.kind === 'topic-root' || t.kind === 'opener'));
    return { ...tp, status: blockedTopics.has(tp.id) ? 'blocked' : ok ? 'ok' : 'failed', tasks: own.length };
  });
  const topicsOk = topicStatus.filter((x) => x.status === 'ok').length;
  // Tasks of policy-blocked topics are intentional removals and like-conversions are not content; the topic floor still guards volume.
  const counted = tasks.filter((t) => !(t.topicId && blockedTopics.has(t.topicId)) && t.status !== 'liked');
  const ratio = counted.length ? done.length / counted.length : 0;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const complete = ratio >= minComplete && topicsOk >= Math.ceil(MIN_TOPIC_SHARE * topics.length) && !(stopped() && pending > counted.length * (1 - minComplete));

  // 9) Split published vs staged, then validate the whole corpus.
  const stagedTopic = (id) => !publish || topicById.get(id)?.tier === 'community';
  const otherIds = new Set(others.map((p) => p.id));
  const fresh = allPosts.filter((p) => !otherIds.has(p.id)); // already promoted elsewhere → never duplicate
  // Staging is closed downward: anything replying to / quoting / retaiking a staged post is staged too.
  const stagedIds = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const p of fresh) {
      if (stagedIds.has(p.id)) continue;
      if (!publish || stagedTopic(p.topic?.id ?? taskById.get(p.taskId)?.topicId) || stagedIds.has(p.inReplyTo) || stagedIds.has(p.quoteOf) || stagedIds.has(p.retaikOf)) {
        stagedIds.add(p.id);
        changed = true;
      }
    }
  }
  const published = fresh.filter((p) => !stagedIds.has(p.id));
  const staged = fresh.filter((p) => stagedIds.has(p.id));
  const errors = validate(personas, [...others, ...published.map((p) => ({ ...p, _file: path.basename(paths.posts) })), ...staged.map((p) => ({ ...p, _file: 'staging' }))])
    .filter((e) => !/^(persona |duplicate persona|duplicate handle)/.test(e));
  const status = errors.length ? 'invalid' : complete ? 'complete' : 'partial';

  const bySource = (s) => done.filter((t) => (t.source ?? 'llm') === s).length;
  const items = {
    llm: bySource('llm') + bySource('micro'),
    llmSingle: done.filter((t) => t.exec === 'single').length,
    llmBatched: done.filter((t) => t.source === 'llm' && t.exec !== 'single').length,
    micro: bySource('micro'),
    pool: bySource('pool'),
    library: bySource('library'),
    wire: bySource('wire'),
    retaikRows: retaiks.length,
    personaLikes: posts.reduce((s, p) => s + (p.personaLikes?.length ?? 0), 0),
    personaReposts: posts.reduce((s, p) => s + (p.personaReposts?.length ?? 0), 0),
    likeConversions: tasks.filter((t) => t.status === 'liked').length,
  };
  items.total = allPosts.length;
  items.nonLlm = items.pool + items.library + items.wire + items.retaikRows + items.personaLikes + items.personaReposts;
  const models = rotation.report();
  const manifest = {
    runId,
    date,
    tz,
    seed,
    nonce,
    mode: mock ? 'mock' : dryRun && offline ? 'dry-run' : 'live',
    path: runPath,
    origin,
    degraded: Boolean(embedder.degraded || budget.totals.degraded),
    promptVersion: PROMPT_VERSION,
    provider: mock || offline ? 'mock' : 'cloudflare-workers-ai',
    publishEnabled: publish,
    sourceSnapshotHash: topicsDoc.sourceSnapshotHash,
    startedAt: prev?.startedAt ?? new Date(t0).toISOString(),
    updatedAt: new Date().toISOString(),
    wallClockSec: Math.round((Date.now() - t0) / 1000),
    status,
    completeness: { done: done.length, tasks: tasks.length, counted: counted.length, pending, ratio: round3(ratio), minRatio: minComplete, topicsOk, topics: topics.length, minTopics: Math.ceil(MIN_TOPIC_SHARE * topics.length) },
    budget: { maxCalls, used: rotation.calls, neurons_est: Math.round(rotation.neurons), llmCap: plan.llmCap, llmTasks: tasks.filter((t) => !['wire', 'pool'].includes(t.exec)).length, budgetHit, timeUp, usageDay },
    budgetPlan: { models: budget.models.map(({ name, model, role, allowance, plan: p, reserve, perCall, neuronsPlanned }) => ({ name, model, role, allowance, plan: p, reserve, perCall, neuronsPlanned })), totals: budget.totals, content },
    discovery: { skipped: discovery.skipped ?? [], ...(discovery.error ? { error: discovery.error } : {}) },
    models: models.map((m) => ({ model: m.model, name: m.name, role: m.role, calls: m.calls, cap: m.cap, capUnit: m.capUnit, plan: m.plan, reserve: m.reserve, neurons_est: m.neurons_est, '429s': m['429s'], items: m.items, tools: m.tools, ...(m.capped ? { capped: m.capped } : {}) })),
    embeddings: { kind: embedder.kind, degraded: Boolean(embedder.degraded), ...(embedder.reason ? { reason: embedder.reason } : {}), ms: embedMs },
    pools: { picked: picker.stats.picked, exhausted: picker.stats.exhausted, byKind: picker.stats.byKind, lintDropped: pools.lintDropped?.length ?? 0, usageScanned: reactionUsage.scanned ?? null },
    micro: microLog,
    items,
    calibration: plan.calibration,
    modelCaps: caps,
    topics: topicStatus.map(({ id, title, url, tier, kind, score, status: s, tasks: n }) => ({ id, title, url, tier, kind, score, status: s, tasks: n })),
    tasks: tasks.map(({ spec: _s, fields: _f, sig: _g, ...rest }) => rest),
    outputs: { published: published.length, staged: staged.length, errors: errors.slice(0, 30) },
    reactions: plan.reactor.reactions.map(({ postId, ...r }) => ({ taskId: postId, ...r })),
  };

  if (!dryRun) {
    writeJsonAtomic(paths.run, manifest);
    if (!offline) {
      const merged = { ...usedToday };
      for (const [name, u] of Object.entries(rotation.usageByName())) merged[name] = { calls: (usedToday[name]?.calls ?? 0) + u.calls, neurons: (usedToday[name]?.neurons ?? 0) + u.neurons };
      saveUsage(usageFileLlm, usageDay, merged);
    }
    if (status === 'complete') {
      if (publish) {
        // staged posts count later via the content/posts scan once promoted
        saveReactionUsage(usageFile(root, mock), picker.used, date);
        if (published.length) writeJsonAtomic(paths.posts, { runId, generatedAt: new Date().toISOString(), origin, provider: manifest.provider, path: runPath, models: models.filter((m) => m.calls > 0).map((m) => m.model), promptVersion: PROMPT_VERSION, posts: published });
        else if (fs.existsSync(paths.posts)) fs.rmSync(paths.posts);
      }
      if (staged.length) {
        const taskOfPost = new Map(tasks.map((t) => [t.postId, t]));
        const topicOfPost = (p) => (p.retaikOf ? taskOfPost.get(p.retaikOf)?.topicId : taskById.get(p.taskId)?.topicId) ?? null;
        const groups = groupStaged(staged, topicById, topicOfPost);
        writeJsonAtomic(paths.staged, { runId, date, generatedAt: new Date().toISOString(), reason: publish ? 'community-tier topics need human review (npm run promote)' : 'PUBLISH_ENABLED=false (kill switch)', groups, posts: staged });
      } else if (fs.existsSync(paths.staged)) fs.rmSync(paths.staged);
    }
  }
  return { status, exitCode: status === 'complete' ? 0 : status === 'partial' ? 2 : 1, manifest, published, staged, errors, paths, tasks, topics: topicsDoc, path: runPath };
}

function themeLine(persona, key, rand) {
  const ideas = [...(persona.core_ideas ?? []), ...(persona.signature_moves ?? [])].map(String).filter((s) => s.length > 3);
  const idea = ideas.length ? ideas[Math.floor(rand() * ideas.length)] : '';
  return `${key.replace(/_/g, ' ')}${idea ? `, e.g. ${idea}` : ''}`;
}

function linkCard(topic) {
  const url = safeUrl(topic?.url ?? '');
  if (!url) return null;
  return { kind: 'link_card', url, title: sanitizeUntrusted(topic.title, 200), domain: topic.domain || domainOf(url) };
}

/**
 * Plain retaik rows ({type:'retaik', retaikOf, text:''}) from persona reposts, sized by the realism
 * spec (sampler.retaikCount). Never of a retaik; always strictly after the original.
 * Each (post, reposter) pair is ranked and timed from its own hash, so a rerun that adds a retried
 * post only adds candidates; it never reshuffles the retaiks of posts that were already there.
 */
export function retaikRows({ posts, byId, sampler, pairSampler = () => sampler, key = '', prefix, date, runId, origin }) {
  const rank = ([p, pid]) => hash8(`${key}:${date}:rt-rank:${p.id}:${pid}`);
  const byRank = (a, b) => rank(a).localeCompare(rank(b));
  const pairs = [];
  for (const p of posts) for (const pid of p.personaReposts ?? []) if (pid !== p.authorId && byId.has(pid)) pairs.push([p, pid]);
  const want = sampler.retaikCount(posts.length);
  // Not enough persona reposts for the spec's retaik rate: some likers also retaik (and become reposters).
  if (pairs.length < want) {
    const extra = (posts.filter((p) => p.type !== 'retaik').flatMap((p) => (p.personaLikes ?? []).filter((pid) => pid !== p.authorId && byId.has(pid) && !(p.personaReposts ?? []).includes(pid)).map((pid) => [p, pid]))).sort(byRank);
    for (const [p, pid] of extra.slice(0, want - pairs.length)) {
      p.personaReposts = [...(p.personaReposts ?? []), pid];
      pairs.push([p, pid]);
    }
  }
  const n = Math.min(pairs.length, want);
  return [...pairs]
    .sort(byRank)
    .slice(0, n)
    .map(([p, pid]) => [p, pid, pairSampler(`${p.id}:${pid}`), seededRng('retaik', key, p.id, pid)])
    .map(([p, pid, ps, rand]) => ({
      id: `${prefix}-${hash8(`${date}:rt:${p.id}:${pid}`)}`,
      authorId: pid,
      type: 'retaik',
      retaikOf: p.id,
      text: '',
      createdAt: iso(Date.parse(p.createdAt) + (Math.min(240, ps.replyDelayMinutes()) + 1) * 60000 + Math.floor(rand() * 60000)),
      runId,
      taskId: `rt:${p.taskId}:${pid}`,
      origin,
      promptVersion: PROMPT_VERSION,
      model: 'none',
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function assemblePost({ t, node, taskById, byId, topic, runId, origin, rand }) {
  const f = t.fields;
  const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
  let type = t.archetype;
  if (type === 'poll' && !f.poll) type = 'question';
  if (t.exec === 'pool' || t.source === 'micro') type = t.role === 'quote' ? t.archetype : (!f.text || /^[\p{Extended_Pictographic}\s\u200d\ufe0f]+$/u.test(f.text) ? 'emoji_reply' : CHEAP_ARCHETYPE[t.stance] ?? 'joke');
  const post = { id: t.postId, authorId: t.personaId, type, text: f.text, createdAt: t.at };
  if (node.parent) post.inReplyTo = parent.postId;
  if (node.quoteOf) post.quoteOf = parent.postId;
  if (topic && (t.kind === 'wire' || t.kind === 'topic-root' || t.kind === 'opener')) post.topic = { id: topic.id, title: topic.title, url: safeUrl(topic.url ?? '') ?? null, source: topic.source, kind: topic.kind, tier: topic.tier };
  if (f.original) post.original = f.original;
  if (f.quoteRefs?.length) post.quoteRefs = f.quoteRefs;
  const media = [...(f.media ?? [])];
  if (t.media === 'link_card') {
    const card = linkCard(topic);
    if (card) media.push(card);
  }
  if (media.length) post.media = media.slice(0, 4);
  if (f.note) post.note = f.note;
  if (f.tags?.length) post.tags = f.tags;
  const clean = (list) => [...new Set(list)].filter((id) => id !== t.personaId && byId.has(id));
  post.personaLikes = clean(node.likes);
  post.personaReposts = clean(node.reposts);
  const c = crowdFor(post, byId.get(t.personaId));
  post.crowdLikeBase = c.likes;
  post.crowdRepostBase = c.reposts;
  post.views = c.views;
  post.bookmarks = c.bookmarks;
  if (type === 'poll' && f.poll) {
    const voters = clean([...node.likes, ...node.reposts]);
    const opts = f.poll.options.map((o) => ({ ...o, personaVotes: [], crowdVoteBase: 0 }));
    const w = opts.map(() => 0.3 + rand());
    const ws = w.reduce((a, b) => a + b, 0);
    for (const v of voters) opts[Math.min(opts.length - 1, Math.floor(rand() * opts.length))].personaVotes.push(v);
    const crowdVotes = Math.max(5, Math.round(c.likes * (0.8 + rand())));
    opts.forEach((o, i) => { o.crowdVoteBase = Math.round((crowdVotes * w[i]) / ws); });
    post.poll = { ...f.poll, options: opts };
  }
  if (t.stance) post.stance = t.stance;
  if (t.role === 'reply' || t.role === 'quote') post.replyForm = replyFormOf(post);
  if (t.reactionId) post.reactionId = t.reactionId;
  post.runId = runId;
  post.taskId = t.taskId;
  post.origin = origin;
  post.promptVersion = PROMPT_VERSION;
  post.model = t.model ?? 'unknown';
  return post;
}

function groupStaged(staged, topicById, topicOf) {
  const groups = new Map();
  for (const p of staged) {
    const id = topicOf(p);
    const key = id ?? 'standalone';
    if (!groups.has(key)) groups.set(key, { topicId: key, title: topicById.get(id)?.title ?? 'standalone taiks', tier: topicById.get(id)?.tier ?? 'standalone', url: topicById.get(id)?.url ?? null, postIds: [] });
    groups.get(key).postIds.push(p.id);
  }
  return [...groups.values()];
}
