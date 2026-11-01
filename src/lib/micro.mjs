// The one optional "micro" LLM call per run (cheap model, low budget): ~20 tiny reactions riffed on
// the personas' reaction pools, plus 5-10 new validated pool entries for personas running low on
// fresh (out-of-cooldown) entries, appended to content/pools/<id>.json.
import { BudgetError, parseJsonLoose } from './llm.mjs';
import { microMessages } from './prompts.mjs';
import { lintTaik, stripTells } from './house-style.mjs';
import { checkPost } from './policy.mjs';
import { taikLength } from './data.mjs';
import { appendPoolEntries, entryProblems, reactionId } from './pools.mjs';

export const MICRO_REPLIES = 20;
export const MICRO_REFILL_PERSONAS = 2;
export const MICRO_REFILL_MIN = 5;
export const MICRO_REFILL_MAX = 10;

const FORM_MAX = { emoji_only: 12, few_words: 25, short: 40 };
const KINDS = ['text', 'emoji', 'gif_query', 'meme_template'];

/** Validate a micro reply against its requested form + house style + policy. */
export function microReplyProblems(text, { form = 'short', persona, policyCtx }) {
  const t = String(text ?? '').trim();
  if (!t) return ['empty'];
  const out = [];
  if (taikLength(t) > (FORM_MAX[form] ?? 40)) out.push('too long for its form');
  if (form === 'few_words' && t.split(/\s+/).length > 3) out.push('more than 3 words');
  if (form === 'emoji_only' && /[\p{L}\p{N}]/u.test(t)) out.push('not emoji-only');
  if (/https?:/.test(t)) out.push('no links');
  out.push(...lintTaik(t, persona));
  if (policyCtx && !checkPost({ text: t }, policyCtx, {}).ok) out.push('policy');
  return out;
}

/**
 * @param o.requests [{ id, persona, stance, form, target, examples }]
 * @param o.refills  [{ persona, stances, n, examples, existing }]   (existing = current pool entries with rid)
 * @returns { replies: Map<id, text>, added: [{ personaId, entries }], rejected, calls }
 */
export async function runMicro({ client, requests = [], refills = [], byId, policyCtx, root = null, date, write = true, log = () => {} }) {
  const res = { replies: new Map(), added: [], rejected: 0, calls: 0 };
  if (!requests.length && !refills.length) return res;
  const start = client.calls;
  let out;
  try {
    out = parseJsonLoose((await client.chat({ messages: microMessages({ requests, refills }, byId) })).message?.content);
  } catch (e) {
    if (e instanceof BudgetError) return res;
    log(`micro call failed: ${String(e.message).slice(0, 100)}`);
    res.calls = client.calls - start;
    return res;
  }
  res.calls = client.calls - start;
  const reqById = new Map(requests.map((r) => [String(r.id), r]));
  for (const r of Array.isArray(out?.replies) ? out.replies : []) {
    const req = reqById.get(String(r?.id));
    if (!req || res.replies.has(req.id)) continue;
    const text = stripTells(String(r.text ?? '').replace(/\s+/g, ' ').trim());
    if (microReplyProblems(text, { form: req.form, persona: req.persona, policyCtx }).length) res.rejected++;
    else res.replies.set(req.id, text);
  }
  const byHandle = new Map(refills.map((r) => [`@${r.persona.handle}`, r]));
  for (const block of Array.isArray(out?.pool) ? out.pool : []) {
    const ref = byHandle.get(String(block?.persona ?? '').startsWith('@') ? block.persona : `@${block?.persona}`);
    if (!ref) continue;
    const seen = new Set((ref.existing ?? []).map((e) => e.rid ?? reactionId(e)));
    const valid = [];
    for (const raw of Array.isArray(block.entries) ? block.entries : []) {
      const kind = KINDS.find((k) => typeof raw?.[k] === 'string');
      if (!kind) { res.rejected++; continue; }
      const e = { [kind]: kind === 'text' ? stripTells(raw[kind]) : raw[kind].trim(), stance: raw.stance, tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).toLowerCase()) : [], tone: String(raw.tone ?? '').toLowerCase() };
      const rid = reactionId(e);
      if (seen.has(rid) || entryProblems(e, ref.persona).length) { res.rejected++; continue; }
      seen.add(rid);
      valid.push(e);
      if (valid.length >= MICRO_REFILL_MAX) break;
    }
    if (!valid.length) continue;
    const added = write ? appendPoolEntries(root, ref.persona, valid, { date, existing: ref.existing ?? [] }) : valid;
    if (added.length) res.added.push({ personaId: ref.persona.id, entries: added });
  }
  return res;
}
