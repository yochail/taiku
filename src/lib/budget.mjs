// Budget planner (Neurons). Before generating, turn the remaining Workers AI quota into a day plan
// (topics, single voice turns, batch calls, micro calls, LLM reply capacity) so a short quota
// degrades the day gracefully instead of failing half-way. Non-LLM filler (likes, plain retaiks,
// pool micro-reactions) makes up the rest of the volume.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './pipeline-util.mjs';

export const CALLS_PER_TURN = 2.3; // single agentic turn: tool round + final (+ occasional repair)
export const OPENERS_PER_BATCH = 3;
export const REPLIES_PER_BATCH = 5;
export const SHORTS_PER_BATCH = 6;
export const ORIGINALS_PER_BATCH = 4;
export const THREAD_PARTS = 3;

export const neuronsFor = (p, input, output) => ((Number(input) || 0) * (p.neuronRate?.input ?? 0) + (Number(output) || 0) * (p.neuronRate?.output ?? 0)) / 1e6;
export const neuronsPerCall = (p) => neuronsFor(p, p.est?.input ?? 2000, p.est?.output ?? 150);

/** Usage already spent today (UTC) per provider name, from content/state/llm-usage.json. */
export function loadUsage(file, day) {
  const doc = readJson(file);
  return doc?.day === day ? doc.models ?? {} : {};
}

export function saveUsage(file, day, models) {
  writeJsonAtomic(file, { day, updatedAt: new Date().toISOString(), models });
}

/**
 * Plan one day's calls per provider.
 * @param o.config   config/llm.json
 * @param o.used     { [name]: { calls, neurons } } already spent today
 * @param o.available Set of usable provider names (discovery), or null for all
 * @param o.maxCalls hard cap on total HTTP calls (GEN_MAX_CALLS)
 * @returns { models: [...], roles: {voice|batch|micro|fallback: {calls, plan, reserve}}, totals, content }
 */
export function planBudget({ config, used = {}, available = null, maxCalls = Infinity, maxTopics = 6, threadPolicy = null, shares = 1 } = {}) {
  const planShare = config.planShare ?? 0.8;
  const reserveShare = config.reserveShare ?? 0.1;
  const target = config.targetCalls ?? { min: 50, max: 90 };
  const models = config.providers.map((p) => {
    const u = used[p.name] ?? { calls: 0, neurons: 0 };
    const perCall = neuronsPerCall(p);
    let allowance;
    if (available && !available.has(p.name)) allowance = 0;
    else if (p.capUnit === 'requests') allowance = Math.floor(p.cap * planShare) - (u.calls ?? 0);
    else allowance = Math.min(p.calls ?? Infinity, Math.floor((p.cap * planShare - (u.neurons ?? 0)) / Math.max(perCall, 1e-9)) - 0);
    if (Number.isFinite(p.calls)) allowance = Math.min(allowance, p.calls - (u.calls ?? 0));
    return { name: p.name, model: p.model, role: p.role, capUnit: p.capUnit, cap: p.cap, perCall: Math.round(perCall * 10) / 10, usedToday: u, allowance: Math.max(0, allowance) };
  });
  if (threadPolicy) for (const m of models) m.capacity = m.allowance;
  // Global Neuron cap (shared pool) and the total-call target / GEN_MAX_CALLS.
  const neuronCap = Math.max(0, ((config.totalCap?.cap ?? Infinity) - models.reduce((s, m) => s + (m.usedToday.neurons ?? 0), 0)) / shares);
  for (const [key, quota] of Object.entries(config.freePools ?? {})) {
    const group = models.filter((m) => config.providers.find((p) => p.name === m.name).keyEnv === key);
    const remaining = Math.max(0, (quota.calls - group.reduce((s, m) => s + (m.usedToday.calls ?? 0), 0)) / shares);
    const total = group.reduce((s, m) => s + m.allowance, 0);
    if (total > remaining) for (const m of group) m.allowance = Math.floor(m.allowance * remaining / total);
  }
  const maxTotal = Math.min(target.max ?? Infinity, maxCalls);
  const spend = () => models.reduce((s, m) => s + m.allowance * m.perCall, 0);
  if (spend() > neuronCap) {
    const scale = neuronCap / spend();
    for (const m of models) if (m.perCall > 0) m.allowance = Math.floor(m.allowance * scale);
  }
  // 1) Neuron cap (Workers AI only): trim micro first, voice last.
  const order = ['micro', 'fallback', 'batch', 'voice'];
  for (let guard = 0; guard < 5000 && spend() > neuronCap; guard++) {
    const m = models.filter((x) => x.allowance > 0 && x.perCall > 0).sort((x, y) => order.indexOf(x.role) - order.indexOf(y.role) || y.allowance - x.allowance)[0];
    if (!m) break;
    m.allowance--;
  }
  // Each model keeps its whole allowance as a ceiling, so a role can fall through its chain
  // (config.chains) when a model 429s. Per-model plan/reserve split.
  for (const m of models) {
    m.reserve = m.allowance > 0 ? Math.max(1, Math.ceil(m.allowance * reserveShare)) : 0;
    m.plan = Math.max(0, m.allowance - m.reserve);
    m.neuronsPlanned = Math.round(m.allowance * m.perCall);
  }
  // 2) Day size: split the call target / GEN_MAX_CALLS across roles by config.roleShare (capped by
  // each role's capacity; spare goes to voice, then batch, micro, fallback). The rotation enforces
  // this total as a hard cap across all models.
  const share = config.roleShare ?? { voice: 0.39, batch: 0.33, micro: 0.17, fallback: 0.11 };
  const cap = Object.fromEntries(order.map((r) => [r, models.filter((m) => m.role === r).reduce((t, m) => t + m.allowance, 0)]));
  const capTotal = order.reduce((t, r) => t + cap[r], 0);
  const roles = Object.fromEntries(order.map((r) => [r, { calls: capTotal <= maxTotal ? cap[r] : Math.min(cap[r], Math.floor(maxTotal * (share[r] ?? 0))) }]));
  let spare = Math.min(maxTotal, capTotal) - order.reduce((t, r) => t + roles[r].calls, 0);
  for (const r of ['voice', 'batch', 'micro', 'fallback']) {
    const add = Math.max(0, Math.min(spare, cap[r] - roles[r].calls));
    roles[r].calls += add;
    spare -= add;
  }
  for (const r of order) {
    const c = roles[r].calls;
    roles[r].reserve = c > 0 ? Math.max(1, Math.ceil(c * reserveShare)) : 0;
    roles[r].plan = Math.max(0, c - roles[r].reserve);
  }
  const sum = (k) => order.reduce((t, r) => t + roles[r][k], 0);
  const totals = { calls: sum('calls'), plan: sum('plan'), reserve: sum('reserve'), neurons: Math.round(spend()), neuronCap: Math.round(neuronCap), targetMin: target.min, targetMax: target.max };
  totals.degraded = totals.calls < (target.min ?? 0);
  return { models, roles, totals, content: contentPlan({ voice: roles.voice.plan + Math.floor(roles.fallback.plan / 2), batch: roles.batch.plan, micro: roles.micro.plan, maxTopics, threadPolicy }) };
}

/** Convert per-role call budgets into a content plan. */
export function contentPlan({ voice = 0, batch = 0, micro = 0, maxTopics = 6, threadPolicy = null }) {
  if (threadPolicy) {
    const singleTurns = Math.floor(voice / CALLS_PER_TURN);
    // Two reply levels, each potentially split into full/short batches; reserve for the upper draw.
    const replyCalls = 2 * Math.ceil(threadPolicy.max / REPLIES_PER_BATCH);
    const roots = Math.min(Math.floor((singleTurns + batch) / (1 + replyCalls)), Math.floor(batch / replyCalls));
    return { topics: Math.min(maxTopics, roots), originals: roots, singleTurns: Math.min(singleTurns, roots),
      llmReplies: roots * threadPolicy.max, llmItems: roots * (1 + threadPolicy.max),
      threadPolicy, microPool: 0, selfThreads: 0, openerBatches: 0, standaloneBatches: 0,
      replyBatches: roots * replyCalls, shortBatches: 0 };
  }
  const singleTurns = Math.floor(voice / CALLS_PER_TURN);
  const microPool = micro >= 3 ? 1 : 0;
  const topics = batch > 0 ? Math.max(1, Math.min(maxTopics, Math.round(batch / 4))) : Math.max(singleTurns > 0 ? 1 : 0, Math.min(maxTopics, Math.floor(singleTurns / 3)));
  const openerBatches = Math.min(topics, batch);
  let rest = batch - openerBatches;
  const selfThreads = rest >= 8 ? 1 : 0;
  rest -= selfThreads;
  const standaloneBatches = Math.min(rest, Math.max(0, Math.floor(batch * 0.2)));
  rest -= standaloneBatches;
  const replyBatches = Math.max(0, rest);
  const shortBatches = Math.max(0, micro - microPool);
  const fullReplies = replyBatches * REPLIES_PER_BATCH;
  const shortReplies = Math.min(shortBatches * SHORTS_PER_BATCH, Math.ceil(fullReplies * 0.45) + SHORTS_PER_BATCH);
  const originals = singleTurns + standaloneBatches * ORIGINALS_PER_BATCH + selfThreads;
  return {
    topics,
    singleTurns,
    openerBatches,
    selfThreads,
    standaloneBatches,
    replyBatches,
    shortBatches,
    microPool,
    originals,
    llmReplies: fullReplies + shortReplies,
    llmItems: originals + selfThreads * (THREAD_PARTS - 1) + openerBatches * OPENERS_PER_BATCH + fullReplies + shortReplies,
  };
}

export function budgetFile(root, mock) {
  return path.join(root, 'content', 'state', mock ? 'llm-usage-mock.json' : 'llm-usage.json');
}

export const fileExists = (f) => fs.existsSync(f);
