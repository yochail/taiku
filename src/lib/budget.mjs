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
 * @returns { models: [...], totals, content }
 */
export function planBudget({ config, used = {}, available = null, maxCalls = Infinity, maxTopics = 6 } = {}) {
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
    if (p.capUnit !== 'requests' && Number.isFinite(p.calls)) allowance = Math.min(allowance, p.calls - (u.calls ?? 0));
    return { name: p.name, model: p.model, role: p.role, capUnit: p.capUnit, cap: p.cap, perCall: Math.round(perCall * 10) / 10, usedToday: u, allowance: Math.max(0, allowance) };
  });
  // Global Neuron cap (shared pool) and the total-call target / GEN_MAX_CALLS.
  const neuronCap = (config.totalCap?.cap ?? Infinity) - models.reduce((s, m) => s + (m.usedToday.neurons ?? 0), 0);
  const maxTotal = Math.min(target.max ?? Infinity, maxCalls);
  const spend = () => models.reduce((s, m) => s + m.allowance * m.perCall, 0);
  const total = () => models.reduce((s, m) => s + m.allowance, 0);
  const order = ['micro', 'fallback', 'batch', 'voice'];
  for (let guard = 0; guard < 1000 && (spend() > neuronCap || total() > maxTotal); guard++) {
    const m = order.map((r) => models.filter((x) => x.role === r && x.allowance > 0).sort((a, b) => b.allowance - a.allowance)[0]).find(Boolean);
    if (!m) break;
    m.allowance--;
  }
  for (const m of models) {
    m.reserve = m.allowance > 0 ? Math.max(1, Math.ceil(m.allowance * reserveShare)) : 0;
    m.plan = Math.max(0, m.allowance - m.reserve);
    m.neuronsPlanned = Math.round(m.allowance * m.perCall);
  }
  const byRole = (r) => models.filter((m) => m.role === r).reduce((s, m) => s + m.plan, 0);
  const totals = { calls: total(), plan: models.reduce((s, m) => s + m.plan, 0), reserve: models.reduce((s, m) => s + m.reserve, 0), neurons: Math.round(spend()), neuronCap: Math.round(neuronCap), targetMin: target.min, targetMax: target.max };
  totals.degraded = totals.calls < (target.min ?? 0);
  return { models, totals, content: contentPlan({ voice: byRole('voice') + Math.floor(byRole('fallback') / 2), batch: byRole('batch'), micro: byRole('micro'), maxTopics }) };
}

/** Convert per-role call budgets into a content plan. */
export function contentPlan({ voice = 0, batch = 0, micro = 0, maxTopics = 6 }) {
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
