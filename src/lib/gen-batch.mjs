// Batched generation: one request → several outputs (3-6 items): a short self-thread, 2-3 first-wave
// takes on a wire topic from different personas, standalone originals, or a batch of replies.
// Every output goes through the same per-item validator as single turns (turn.validateItem: 280
// weighted chars, house-style lint, quotes verified against the tool log, policy gate) plus the
// batch repetition lint; only the failed items are regenerated (one repair request).
import { BudgetError, parseJsonArray } from './llm.mjs';
import { batchMessages, batchRepair } from './prompts.mjs';
import { lintBatch } from './house-style.mjs';
import { fingerprint } from './ideas.mjs';
import { NOVELTY_ATTEMPTS, validateItem } from './turn.mjs';

export const BATCH_MIN = 2;
export const BATCH_MAX = 6;

/**
 * Match parsed outputs to requested items: by id when the model echoes ids, else by position
 * (only when the counts line up). Unknown/duplicate ids are ignored.
 */
export function matchOutputs(items, outputs) {
  const byId = new Map();
  const ids = new Set(items.map((it) => String(it.id)));
  const withIds = outputs.filter((o) => o && ids.has(String(o.id)));
  if (withIds.length) {
    for (const o of withIds) if (!byId.has(String(o.id))) byId.set(String(o.id), o);
  } else if (outputs.length === items.length) items.forEach((it, i) => byId.set(String(it.id), outputs[i]));
  return byId;
}

/**
 * Run one batch. items: [{ id, persona, task, ctx, passages: Map }].
 * Returns { results: Map<id, { ok, fields?, error?, detail? }>, calls, repaired }.
 * Throws BudgetError only when the very first request cannot be made.
 */
export async function runBatch({ client, items, byId, kind = 'replies', policyCtx, tracker = null, rand = Math.random, giphy = null, maxRepairRounds = 1 }) {
  const results = new Map();
  if (!items.length) return { results, calls: 0, repaired: 0 };
  const start = client.calls;
  const promptItems = items.map((it) => ({ ...it, passages: it.passages ? [...it.passages.values()].slice(0, 4) : [] }));
  const messages = batchMessages(promptItems, byId, { kind });
  let pending = items;
  let repaired = 0;
  let content;
  try {
    content = (await client.chat({ messages })).message?.content;
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    for (const it of items) results.set(it.id, { ok: false, error: 'llm', detail: String(e.message).slice(0, 160) });
    return { results, calls: client.calls - start, repaired, capped: Boolean(e.capped) };
  }
  // Same-persona items in one batch must not repeat each other either (the run notes them only after the batch).
  const batchSeen = new Map();
  const noveltyIn = (ctx) => {
    const n = ctx?.novelty;
    if (!n || !batchSeen.get(n)?.length) return ctx ?? {};
    return { ...ctx, novelty: { ...n, prev: [...n.prev, ...batchSeen.get(n)] } };
  };
  for (let round = 0; ; round++) {
    const outs = matchOutputs(pending, parseJsonArray(content));
    const failures = [];
    const okTexts = [];
    for (const it of pending) {
      const out = outs.get(String(it.id));
      if (!out) {
        failures.push({ id: it.id, problem: 'missing from your array; write it', kind: 'missing' });
        continue;
      }
      const v = await validateItem(out, { task: it.task, persona: it.persona, passages: it.passages ?? new Map(), policyCtx, ctx: noveltyIn(it.ctx), tracker, rand, giphy, attempt: round >= maxRepairRounds ? NOVELTY_ATTEMPTS : round });
      if (v.problem) failures.push({ id: it.id, problem: v.problem.slice(0, 300), kind: v.kind, violations: v.violations });
      else {
        results.set(it.id, { ok: true, fields: v.fields });
        okTexts.push([it.id, v.fields.text]);
        const n = it.ctx?.novelty;
        const fp = n ? fingerprint(v.fields.text, n.cfg) : null;
        if (fp) (batchSeen.get(n) ?? batchSeen.set(n, []).get(n)).push({ id: `batch:${it.id}`, text: v.fields.text, fp });
      }
    }
    for (const [i, probs] of lintBatch(okTexts.map(([, t]) => t))) {
      const id = okTexts[i][0];
      results.delete(id);
      failures.push({ id, problem: `House style: ${probs.join('; ')}`, kind: 'style' });
    }
    for (const [id] of okTexts) if (results.get(id)?.ok) tracker?.add(results.get(id).fields.text);
    if (!failures.length) break;
    const fixable = failures.filter((f) => !(f.violations && round > 0));
    if (round >= maxRepairRounds || !fixable.length) {
      for (const f of failures) results.set(f.id, { ok: false, error: f.violations ? 'policy' : f.kind === 'style' ? 'style' : 'invalid', detail: f.problem.slice(0, 200), ...(f.violations ? { violations: f.violations } : {}) });
      break;
    }
    pending = items.filter((it) => fixable.some((f) => f.id === it.id));
    for (const f of failures) if (!fixable.includes(f)) results.set(f.id, { ok: false, error: 'policy', detail: f.problem.slice(0, 200), ...(f.violations ? { violations: f.violations } : {}) });
    repaired += pending.length;
    messages.push({ role: 'assistant', content: String(content ?? '') });
    messages.push({ role: 'user', content: batchRepair(fixable) });
    try {
      content = (await client.chat({ messages, _repair: true })).message?.content;
    } catch (e) {
      for (const it of pending) results.set(it.id, { ok: false, error: 'llm', detail: String(e.message).slice(0, 160) });
      break;
    }
  }
  return { results, calls: client.calls - start, repaired };
}
