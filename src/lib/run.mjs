// DailyRun: one run per editorial date writes the whole day (drip-released via future createdAt).
//
//   topics (feeds → filter → score/MMR)  →  plan (wire posts, openers, standalone roots)
//   →  react.mjs cascade (who likes / retaiks / replies / quotes, no LLM)  →  one agentic turn per
//   authored post (turn.mjs)  →  engagement (react + crowd.mjs)  →  validate  →  atomic write.
//
// Idempotent + resumable: task ids derive from the topic and the reaction graph, which is fully
// determined by (seed, nonce, topics); the nonce and topics are reused from the previous manifest,
// finished turns are cached in content/runs/<date>.work.json, and the posts file is rewritten
// atomically. Content is only published when completeness thresholds are met.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_TAIK_CHARS, ROOT, loadPersonas, normalizeQuoteText, personaKind, safeUrl, taikLength, validate } from './data.mjs';
import { POST_ARCHETYPES, REPLY_ARCHETYPES } from './archetypes.mjs';
import { behaviorOf } from './behavior.mjs';
import { crowdFor, loadDistribution } from './crowd.mjs';
import { createSampler } from './realism.mjs';
import { calibrate, cascade, createReactor } from './react.mjs';
import { FEEDS, domainOf, fetchPool, fixtureFetch, sanitizeUntrusted } from './news.mjs';
import { selectTopics, topicCount } from './topics.mjs';
import { BudgetError, createClient, llmConfig, probeTools, toolCapsKey } from './llm.mjs';
import { createMockClient } from './mock.mjs';
import { PROMPT_VERSION } from './prompts.mjs';
import { policyContext } from './policy.mjs';
import { runTurn } from './turn.mjs';
import { clamp, editorialDay, hash8, readJson, round3, seededRng, sha256, weightedPick, writeJsonAtomic } from './pipeline-util.mjs';

export const DEFAULT_MAX_CALLS = 300;
export const DEFAULT_MIN_COMPLETE = 0.7;
export const MIN_TOPIC_SHARE = 0.6;
const CALLS_PER_TURN = 2.3;
const NOTE_RATE = 0.2;
const NATIVE_RATE = 0.06;
const QUOTE_RATE = { original: 0.35, reply: 0.15, quote: 0.25 };
const STANDALONE_TYPES = ['hot_take', 'aphorism', 'teaching', 'reminder', 'question', 'unpopular_opinion', 'shitpost', 'subtweet', 'pov', 'hear_me_out', 'listicle', 'meme'];
const NO_STANDALONE = new Set(['news_take', 'quote_post', 'thread', 'poll', 'wire', 'quote_take', 'quote_dunk', 'copypasta']);

const isNews = (p) => personaKind(p) === 'news';
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Output locations for a date. Mock runs use `-mock` names; the kill switch routes everything to staging. */
export function outputPaths(root, date, { mock = false, publish = true } = {}) {
  const sfx = mock ? '-mock' : '';
  const staging = path.join(root, 'staging', `${date}${sfx}`);
  return {
    posts: path.join(root, 'content', 'posts', `${date}-daily${sfx}.json`),
    postsDir: path.join(root, 'content', 'posts'),
    run: publish ? path.join(root, 'content', 'runs', `${date}${sfx}.json`) : path.join(staging, 'run.json'),
    work: publish ? path.join(root, 'content', 'runs', `${date}${sfx}.work.json`) : path.join(staging, 'work.json'),
    topics: publish ? path.join(root, 'content', 'topics', `${date}${sfx}.json`) : path.join(staging, 'topics.json'),
    staging,
    staged: path.join(staging, 'posts.json'),
  };
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
  if (node.kind === 'wire') return 'wire';
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

/** Build the day plan: originals (wire, openers, topic roots, standalone), then the reaction cascade. */
export function planDay({ personas, spec, topics, date, seed, nonce, tz, maxCalls, originals: nOriginals }) {
  const day = editorialDay(date, tz);
  const rand = seededRng('plan', seed, nonce);
  const sampler = createSampler(spec, `plan:${seed}:${nonce}`);
  const active = personas.filter((p) => !isNews(p));
  const news = personas.filter(isNews);
  const at = (minHour = 0) => {
    const h = Math.max(minHour, sampler.localHour());
    return day.start + h * 3.6e6 + sampler.minute() * 6e4 + Math.floor(rand() * 6e4);
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
    const nOpen = 1 + (rand() < 0.5 ? 1 : 0);
    const used = new Set();
    if (news.length && t.url) {
      const wireAuthor = weightedPick(rand, news.map((p) => [p.id, 0.2 + topicAffinity(p, t.keys)]));
      const wire = node({ id: `${t.id}-wire`, authorId: wireAuthor, createdAt: T, vector: t.keys, role: 'original', kind: 'wire', topicId: t.id });
      nodes.push(wire);
      for (let j = 1; j <= nOpen; j++) {
        const pid = pickFan(used);
        if (!pid) break;
        used.add(pid);
        const role = j === 1 || rand() < 0.5 ? 'quote' : 'reply';
        const o = node({ id: `${t.id}-o${j}`, authorId: pid, createdAt: T + delay(), vector: t.keys, role, kind: 'opener', topicId: t.id, depth: 1, parent: role === 'reply' ? wire.id : null, quoteOf: role === 'quote' ? wire.id : null, mentions: new Set([wireAuthor]) });
        nodes.push(o);
        opens.push([wire, o]);
      }
    } else {
      for (let j = 1; j <= nOpen; j++) {
        const pid = pickFan(used);
        if (!pid) break;
        used.add(pid);
        nodes.push(node({ id: `${t.id}-root${j}`, authorId: pid, createdAt: j === 1 ? T : T + delay(240), vector: t.keys, role: 'original', kind: 'topic-root', topicId: t.id }));
      }
    }
  }
  const topicOriginals = nodes.filter((n) => n.role === 'original').length;
  const nStandalone = Math.max(3, nOriginals - topicOriginals);
  for (let i = 1; i <= nStandalone; i++) {
    const pid = weightedPick(rand, active.map((p) => [p.id, (behaviorOf(p).activity ?? 0.5) * (p.popularity ?? 5)]));
    const p = personas.find((x) => x.id === pid);
    const key = weightedPick(rand, Object.entries(p.topic_affinity ?? { philosophy: 1 }).map(([k, v]) => [k, Number(v) || 0.01]));
    nodes.push(node({ id: `s${i}`, authorId: pid, createdAt: at(), vector: { [key]: 1 }, role: 'original', kind: 'standalone', theme: key }));
  }
  const authoredOriginals = nodes.filter((n) => n.role === 'original').length;
  const cal = calibrate({ personas, spec, originalsPerDay: authoredOriginals });
  const turnsFixed = nodes.filter((n) => n.kind !== 'wire').length * CALLS_PER_TURN + nodes.filter((n) => n.kind === 'wire').length * 1.2;
  const llmCap = Math.max(0, Math.floor((maxCalls - turnsFixed) / CALLS_PER_TURN));
  const reactor = createReactor({ personas, spec, seed: `${date}:${seed}`, nonce, calibration: cal, llmCap });
  for (const n of nodes) if (n.kind !== 'wire') reactor.spend(n.authorId);
  for (const [wire, o] of opens) reactor.force(wire, o.authorId, o.role, 'topic-opener', o.createdAt);
  const all = cascade(reactor, nodes, { horizon: day.end + 2 * 3.6e6, personas });
  return { day, nodes: all.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), reactor, calibration: cal, llmCap, sampler, rand };
}

/** Per-task generation spec (length, media, emoji, …) drawn from the realism sampler. */
function taskSpec({ node, persona, topic, sampler, rand, postId, hasPassages }) {
  const role = node.kind === 'wire' ? 'wire' : node.role;
  let media = role === 'wire' ? 'link_card' : sampler.mediaKind(role === 'original' ? 'original' : role);
  if (media === 'none' || media === 'video') media = null;
  // Standalone originals have no URL, so their link_card draws are lost; topic roots re-draw to make up the spec share.
  if (role === 'original' && !media && safeUrl(topic?.url ?? '')) {
    for (let i = 0; i < 2 && media !== 'link_card'; i++) if (sampler.mediaKind('original') === 'link_card') media = 'link_card';
  }
  if (media === 'link_card' && !safeUrl(topic?.url ?? '')) media = null;
  if (media === 'poll' && role !== 'original') media = null;
  let length = role === 'wire' ? { min: 60, max: 240 } : sampler.lengthRange();
  if (media === 'gif') length = { min: 1, max: Math.min(length.max, 80) };
  if (media === 'poll') length = { min: Math.max(20, length.min), max: Math.max(60, Math.min(length.max, 140)) };
  const modern = clamp(persona.modernity ?? 3, 1, 5);
  const emoji = role !== 'wire' && (sampler.wantsEmoji() || (modern >= 4 && sampler.wantsEmoji())) && !(modern <= 2 && rand() < 0.5);
  const type = pickType(rand, persona, node, media);
  return {
    taskId: node.id,
    postId,
    role,
    archetype: type,
    length,
    emoji,
    hashtag: role !== 'wire' && sampler.wantsHashtag(),
    native: role !== 'wire' && Boolean(persona.native_language?.phrases?.length) && rand() < NATIVE_RATE,
    wantQuote: role !== 'wire' && hasPassages && rand() < (QUOTE_RATE[role] ?? 0.2),
    media,
    mention: null,
    wantNote: role !== 'wire' && rand() < NOTE_RATE,
  };
}

const sig = (t) => sha256(JSON.stringify([t.taskId, t.personaId, t.role, t.parentTaskId ?? null, t.topicId ?? null, t.archetype, t.media ?? null])).slice(0, 16);

/**
 * Run (or resume) the daily generation. Never throws for content problems; returns a result with
 * `exitCode` (0 complete, 1 invalid/error, 2 partial).
 */
export async function runDaily(opts = {}) {
  const env = opts.env ?? process.env;
  const root = opts.root ?? ROOT;
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
  const paths = outputPaths(root, date, { mock, publish });
  const prev = opts.fresh ? null : readJson(paths.run);
  const nonce = opts.nonce ?? prev?.nonce ?? crypto.randomBytes(6).toString('hex');
  const seed = String(opts.seed ?? env.GEN_SEED ?? prev?.seed ?? date);
  const maxCalls = Number(opts.maxCalls ?? env.GEN_MAX_CALLS) || DEFAULT_MAX_CALLS;
  const minComplete = clamp(Number(env.GEN_MIN_COMPLETE) || DEFAULT_MIN_COMPLETE, 0, 1);
  const runId = `daily-${date}${mock ? '-mock' : ''}`;
  const write = (file, data) => {
    if (!dryRun) writeJsonAtomic(file, data);
  };

  // 1) Topics (reused on resume so the plan — and therefore every task id — is stable).
  let topicsDoc = opts.fresh || opts.refetch ? null : readJson(paths.topics);
  if (!topicsDoc) {
    let pool;
    const fetchImpl = opts.fetchImpl ?? (offline ? fixtureFetch(FEEDS) : globalThis.fetch);
    pool = await fetchPool({ env: offline ? { ...env, NEWS_FEEDS: '' } : env, fetchImpl, feeds: offline ? FEEDS : undefined, log });
    const n = topicCount(opts.topics ?? env.GEN_TOPICS);
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
  if (opts.topicsOnly) return { status: 'topics', exitCode: 0, topics: topicsDoc, paths };

  // 2) Client + capabilities.
  let client = opts.client;
  if (!client) {
    if (offline) client = createMockClient({ maxCalls, tools: env.LLM_TOOLS === 'off' ? 'off' : 'on', nonce });
    else {
      const cfg = llmConfig(env);
      if (!cfg.apiKey) {
        log('no LLM key: set LLM_API_KEY (or GITHUB_TOKEN with models:read for https://models.github.ai). Use --mock for offline runs.');
        return { status: 'error', exitCode: 1, error: 'no-key', paths };
      }
      client = createClient({ cfg, maxCalls, log });
    }
  }
  const caps = { ...(prev?.modelCaps ?? {}) };
  let nativeTools = true;
  try {
    nativeTools = await probeTools(client, caps);
    caps[toolCapsKey(client)] = nativeTools;
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e;
  }

  // 3) Plan + reactions (no LLM).
  const nOriginals = Number(env.GEN_ORIGINALS) || Math.round(clamp(personas.filter((p) => !isNews(p)).length * 0.6, 10, 40));
  const plan = planDay({ personas, spec, topics, date, seed, nonce, tz, maxCalls, originals: nOriginals });
  const prefix = `${mock ? 'm' : 'd'}${date.replace(/-/g, '')}`;
  const postIdOf = (taskId) => `${prefix}-${hash8(`${date}:${taskId}`)}`;
  const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));
  const hasPassages = (p) => (p.quotables ?? []).length + (p.quote_bank ?? []).length + (p.sources ?? []).filter((s) => s.local).length > 0;
  const tasks = plan.nodes.map((n) => {
    const persona = byId.get(n.authorId);
    const spec1 = taskSpec({ node: n, persona, topic: topicById.get(n.topicId), sampler: plan.sampler, rand: plan.rand, postId: postIdOf(n.id), hasPassages: hasPassages(persona) });
    if (n.role === 'reply' && plan.rand() < 0.3) spec1.mention = byId.get(nodeById.get(n.parent)?.authorId)?.handle ?? null;
    const t = { taskId: n.id, kind: n.kind ?? n.role, role: spec1.role, personaId: n.authorId, postId: spec1.postId, parentTaskId: n.parent ?? n.quoteOf ?? null, topicId: n.topicId, at: iso(n.createdAt), archetype: spec1.archetype, media: spec1.media, status: 'pending', spec: spec1 };
    t.sig = sig(t);
    return t;
  });

  // 4) Execute turns (topological = chronological order), resuming finished work.
  const workDoc = opts.fresh ? null : readJson(paths.work);
  const work = workDoc && workDoc.nonce === nonce ? workDoc.results ?? {} : {};
  const policyCtx = policyContext(personas, { allowNames: String(env.POLICY_ALLOW_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean) });
  const pool = (topicsDoc.pool ?? []).length ? topicsDoc.pool : topics.map((t) => ({ id: t.id, title: t.title, domain: t.domain }));
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const textOf = new Map();
  const blockedTopics = new Map();
  const turnRand = seededRng('turn', seed, nonce);
  let budgetHit = false;
  const chain = (taskId, max = 4) => {
    const out = [];
    let t = taskById.get(taskId);
    while (t && out.length < max) {
      if (textOf.has(t.taskId)) out.unshift({ id: t.postId, authorId: t.personaId, handle: byId.get(t.personaId)?.handle ?? t.personaId, text: textOf.get(t.taskId) });
      t = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    }
    return out;
  };
  const postToTask = new Map(tasks.map((t) => [t.postId, t.taskId]));
  const threadFn = (postId) => chain(postToTask.get(postId) ?? '', 6);
  for (const t of tasks) {
    const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
    if (parent && parent.status !== 'done') {
      t.status = 'dropped';
      t.error = `parent ${parent.status}`;
      continue;
    }
    if (t.topicId && blockedTopics.has(t.topicId)) {
      t.status = 'dropped';
      t.error = 'topic blocked';
      continue;
    }
    const cached = work[t.taskId];
    if (cached && cached.sig === t.sig && cached.blocked) {
      Object.assign(t, { status: 'blocked', error: cached.blocked, violations: cached.violations, calls: 0, resumed: true });
      if (t.topicId) blockedTopics.set(t.topicId, t.taskId);
      continue;
    }
    if (cached && cached.sig === t.sig) {
      Object.assign(t, { status: 'done', fields: cached.fields, model: cached.model, calls: 0, resumed: true });
      textOf.set(t.taskId, cached.fields.text);
      continue;
    }
    if (budgetHit) continue;
    const persona = byId.get(t.personaId);
    const topic = topicById.get(t.topicId);
    const target = parent ? byId.get(parent.personaId) : null;
    const node = nodeById.get(t.taskId);
    const ctx = {
      topic: topic ? { id: topic.id, title: topic.title, domain: topic.domain || domainOf(topic.url ?? '') || topic.source } : null,
      thread: parent ? chain(parent.taskId) : [],
      target: target ? { handle: target.handle } : null,
      relation: target ? relationEntry(persona, target.id) : null,
      theme: node?.theme ? themeLine(persona, node.theme, turnRand) : null,
      pool,
      threadFn,
    };
    let r;
    try {
      r = await runTurn({ client, persona, byId, task: t.spec, ctx, nativeTools, policyCtx, rand: turnRand });
    } catch (e) {
      if (!(e instanceof BudgetError)) throw e;
      budgetHit = true;
      log(`budget exhausted at ${client.calls} calls; remaining tasks stay pending (rerun to resume)`);
      continue;
    }
    t.calls = r.calls;
    t.repairs = r.repairs;
    t.tools = r.toolLog?.map((x) => x.name);
    if (!r.ok) {
      t.status = r.error === 'policy' ? 'blocked' : 'failed';
      t.error = `${r.error}: ${r.detail ?? ''}`.slice(0, 200);
      if (r.violations) t.violations = r.violations.slice(0, 5);
      if (r.error === 'policy' && t.topicId) blockedTopics.set(t.topicId, t.taskId);
      // Policy blocks are sticky: a resume must not re-roll a topic the gate already failed.
      if (r.error === 'policy') work[t.taskId] = { sig: t.sig, blocked: t.error, violations: t.violations };
      log(`✗ ${t.taskId} @${persona.handle}: ${t.error}`);
      continue;
    }
    if (t.role === 'wire') r.fields = wireFields(r.fields, topic);
    t.status = 'done';
    t.fields = r.fields;
    t.model = client.cfg?.model;
    textOf.set(t.taskId, r.fields.text);
    work[t.taskId] = { sig: t.sig, fields: r.fields, model: t.model };
    log(`✓ ${t.taskId} @${persona.handle} [${t.archetype}${t.media ? `+${t.media}` : ''}] ${r.fields.text.replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  // A policy failure fails the whole topic (when unsure, fail the topic).
  for (const t of tasks) if (t.topicId && blockedTopics.has(t.topicId) && t.status === 'done') {
    t.status = 'dropped';
    t.error = 'topic blocked';
  }
  if (!dryRun) writeJsonAtomic(paths.work, { runId, date, nonce, results: work });

  // 5) Assemble posts.
  const done = tasks.filter((t) => t.status === 'done');
  const posts = done.map((t) => assemblePost({ t, node: nodeById.get(t.taskId), taskById, byId, topic: topicById.get(t.topicId), runId, mock, rand: seededRng('votes', t.taskId, nonce) }));

  // 6) Completeness.
  const topicStatus = topics.map((tp) => {
    const own = tasks.filter((t) => t.topicId === tp.id);
    const ok = !blockedTopics.has(tp.id) && own.some((t) => t.status === 'done' && (t.kind === 'wire' || t.kind === 'topic-root' || t.kind === 'opener'));
    return { ...tp, status: blockedTopics.has(tp.id) ? 'blocked' : ok ? 'ok' : 'failed', tasks: own.length };
  });
  const topicsOk = topicStatus.filter((x) => x.status === 'ok').length;
  // Tasks of policy-blocked topics are intentional removals; the topic floor below still guards volume.
  const counted = tasks.filter((t) => !(t.topicId && blockedTopics.has(t.topicId)));
  const ratio = counted.length ? done.length / counted.length : 0;
  const complete = ratio >= minComplete && topicsOk >= Math.ceil(MIN_TOPIC_SHARE * topics.length);

  // 7) Split published vs staged, then validate the whole corpus.
  const stagedTopic = (id) => !publish || topicById.get(id)?.tier === 'community';
  const others = loadOtherPosts(paths.postsDir, [paths.posts]);
  const otherIds = new Set(others.map((p) => p.id));
  const fresh = posts.filter((p) => !otherIds.has(p.id)); // already promoted elsewhere → never duplicate
  // Staging is closed downward: anything replying to / quoting a staged post is staged too.
  const stagedIds = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const p of fresh) {
      if (stagedIds.has(p.id)) continue;
      if (!publish || stagedTopic(p.topic?.id ?? taskById.get(p.taskId)?.topicId) || stagedIds.has(p.inReplyTo) || stagedIds.has(p.quoteOf)) { stagedIds.add(p.id); changed = true; }
    }
  }
  const published = fresh.filter((p) => !stagedIds.has(p.id));
  const staged = fresh.filter((p) => stagedIds.has(p.id));
  const errors = validate(personas, [...others, ...published.map((p) => ({ ...p, _file: path.basename(paths.posts) })), ...staged.map((p) => ({ ...p, _file: 'staging' }))])
    .filter((e) => !/^(persona |duplicate persona|duplicate handle)/.test(e));
  const status = errors.length ? 'invalid' : complete ? 'complete' : 'partial';

  const manifest = {
    runId,
    date,
    tz,
    seed,
    nonce,
    mode: mock ? 'mock' : dryRun && offline ? 'dry-run' : 'live',
    promptVersion: PROMPT_VERSION,
    model: client.cfg?.model,
    provider: client.cfg?.host ?? null,
    publishEnabled: publish,
    sourceSnapshotHash: topicsDoc.sourceSnapshotHash,
    startedAt: prev?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
    completeness: { done: done.length, tasks: tasks.length, counted: counted.length, ratio: round3(ratio), minRatio: minComplete, topicsOk, topics: topics.length, minTopics: Math.ceil(MIN_TOPIC_SHARE * topics.length) },
    budget: { maxCalls, used: client.calls, llmCap: plan.llmCap, llmTasks: tasks.filter((t) => t.role !== 'wire').length, budgetHit, retries: client.stats?.retries ?? 0, rateLimited: client.stats?.rateLimited ?? 0 },
    calibration: plan.calibration,
    modelCaps: caps,
    topics: topicStatus.map(({ id, title, url, tier, kind, score, status: s, tasks: n }) => ({ id, title, url, tier, kind, score, status: s, tasks: n })),
    tasks: tasks.map(({ spec: _s, fields: _f, sig: _g, ...rest }) => rest),
    outputs: { published: published.length, staged: staged.length, errors: errors.slice(0, 30) },
    reactions: plan.reactor.reactions.map(({ postId, ...r }) => ({ taskId: postId, ...r })),
  };

  if (!dryRun) {
    writeJsonAtomic(paths.run, manifest);
    if (status === 'complete') {
      if (publish) {
        if (published.length) writeJsonAtomic(paths.posts, { runId, generatedAt: new Date().toISOString(), provider: client.isMock ? 'mock' : client.cfg?.host, model: client.cfg?.model, promptVersion: PROMPT_VERSION, posts: published });
        else if (fs.existsSync(paths.posts)) fs.rmSync(paths.posts);
      }
      if (staged.length) {
        const groups = groupStaged(staged, topicById, (p) => taskById.get(p.taskId)?.topicId ?? null);
        writeJsonAtomic(paths.staged, { runId, date, generatedAt: new Date().toISOString(), reason: publish ? 'community-tier topics need human review (npm run promote)' : 'PUBLISH_ENABLED=false (kill switch)', groups, posts: staged });
      } else if (fs.existsSync(paths.staged)) fs.rmSync(paths.staged);
    }
  }
  return { status, exitCode: status === 'complete' ? 0 : status === 'partial' ? 2 : 1, manifest, published, staged, errors, paths, tasks, topics: topicsDoc };
}

function themeLine(persona, key, rand) {
  const ideas = [...(persona.core_ideas ?? []), ...(persona.signature_moves ?? [])].map(String).filter((s) => s.length > 3);
  const idea = ideas.length ? ideas[Math.floor(rand() * ideas.length)] : '';
  return `${key.replace(/_/g, ' ')}${idea ? ` — e.g. ${idea}` : ''}`;
}

/** Wire post: the real (sanitized) headline + the model's neutral line; link card from the feed item. */
function wireFields(fields, topic) {
  const title = sanitizeUntrusted(topic?.title ?? '', 200);
  let text = fields.text;
  if (title && !normalizeQuoteText(text).toLowerCase().startsWith(normalizeQuoteText(title).toLowerCase().slice(0, 30))) {
    const rest = text.replace(/\s+/g, ' ').trim();
    const combined = `${title}\n\n${rest}`;
    text = taikLength(combined) <= MAX_TAIK_CHARS ? combined : title;
  }
  const out = { text };
  if (fields.tags) out.tags = fields.tags;
  return out;
}

function linkCard(topic) {
  const url = safeUrl(topic?.url ?? '');
  if (!url) return null;
  return { kind: 'link_card', url, title: sanitizeUntrusted(topic.title, 200), domain: topic.domain || domainOf(url) };
}

function assemblePost({ t, node, taskById, byId, topic, runId, mock, rand }) {
  const f = t.fields;
  const parent = t.parentTaskId ? taskById.get(t.parentTaskId) : null;
  let type = t.archetype;
  if (type === 'poll' && !f.poll) type = 'question';
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
  post.runId = runId;
  post.taskId = t.taskId;
  post.origin = mock ? 'mock' : 'llm';
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
