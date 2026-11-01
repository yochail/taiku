// One agentic turn = one taik/reply/quote. Pre-injected topic + thread context, ≤2 tool rounds
// (search_sources/get_quote mainly), a final round with tool_choice "none", then validation with
// targeted repair prompts: length (never truncate), quote verification against THIS turn's tool
// log (canonical comes from the log, never the model), and the policy gate.
import { MAX_TAIK_CHARS, normalizeQuoteText, quoteMatches, quotedSpans, safeUrl, taikLength } from './data.mjs';
import { materializeFor } from './gen-media.mjs';
import { houseStyleRepair, lintTaik, stripTells } from './house-style.mjs';
import { BudgetError, parseJsonLoose } from './llm.mjs';
import { checkPost, repairHint } from './policy.mjs';
import { formatRepair, quoteRepair, shortenRepair, systemMessage, targetCeiling, targetRepair, userMessage } from './prompts.mjs';
import { createToolbox } from './tools.mjs';
import { ensureMentions } from './tags.mjs';

export const MAX_TOOL_ROUNDS = 2;
export const MAX_REPAIRS = 3;
const MAX_CALLS_PER_ROUND = 3;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Extract tool calls from a message (native, or emulated {"tool_calls":[...]} JSON content). */
export function toolCallsOf(message, emulated) {
  if (!emulated && Array.isArray(message.tool_calls) && message.tool_calls.length) return message.tool_calls.map((c) => ({ id: c.id, name: c.function?.name, args: c.function?.arguments ?? '{}' }));
  if (emulated) {
    const j = parseJsonLoose(message.content);
    if (j && Array.isArray(j.tool_calls) && !j.text) return j.tool_calls.map((c, i) => ({ id: `emu_${i}`, name: c.name ?? c.function?.name, args: c.arguments ?? c.function?.arguments ?? {} }));
  }
  return [];
}

/**
 * Resolve the model's quoteRefs + auto-detect quoted spans against the tool log.
 * Returns { refs, bad: [span] }. Canonical text ALWAYS comes from the tool log.
 */
export function resolveQuotes(text, modelRefs, passages) {
  const refs = [];
  const norm = normalizeQuoteText;
  const addRef = (p, quoted) => {
    const m = quoteMatches(quoted, p.text, { translated: p.translated });
    if (!m.ok) return false;
    if (refs.some((r) => r.passageId === p.passageId && norm(r.text) === norm(quoted))) return true;
    refs.push({ text: norm(quoted), canonical: p.text, sourceId: p.sourceId, ...(p.bankId ? { bankId: p.bankId } : {}), passageId: p.passageId, work: p.work, section: p.section, ...(m.exact ? {} : { similarity: Math.round(m.similarity * 1000) / 1000 }) });
    return true;
  };
  for (const r of Array.isArray(modelRefs) ? modelRefs : []) {
    const p = passages.get(r?.passageId);
    if (p && r.text && norm(text).includes(norm(r.text))) addRef(p, r.text);
  }
  const bad = [];
  for (const span of quotedSpans(text)) {
    if (refs.some((r) => norm(r.text).includes(norm(span)))) continue;
    const hit = [...passages.values()].find((p) => quoteMatches(span, p.text, { translated: p.translated }).ok);
    if (!(hit && addRef(hit, span))) bad.push(span);
  }
  return { refs: refs.filter((r) => quotedSpans(text).some((s) => norm(r.text).includes(norm(s)))), bad };
}

/** Poll from model options (2–4, ≤25 chars, unique). */
export function buildPoll(p, postId) {
  const opts = [...new Set((Array.isArray(p?.options) ? p.options : []).map((o) => str(typeof o === 'object' ? o.text : o, 25)).filter(Boolean))].slice(0, 4);
  if (opts.length < 2) return null;
  return { id: `${postId}-poll`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80), options: opts.map((text, i) => ({ id: 'abcd'[i], text, personaVotes: [], crowdVoteBase: 0 })) };
}

/** Community Note: canonical passage (or anchor) text, never the model's wording. */
export function buildNote(persona, { passage = null, rand = Math.random } = {}) {
  if (passage) {
    const url = safeUrl(passage.url ?? '') ?? safeUrl(persona.anchors?.find((a) => a.work === passage.work)?.url ?? '') ?? undefined;
    return { text: `Real passage: “${passage.text}” — ${passage.work}, ${passage.section}`.slice(0, 400), work: passage.work, section: passage.section, ...(url ? { url } : {}) };
  }
  const anchors = (persona.anchors ?? []).filter((a) => a.idea && a.work);
  if (!anchors.length) return null;
  const a = anchors[Math.floor(rand() * anchors.length)];
  const url = safeUrl(a.url ?? '');
  return { text: `Real idea: ${a.idea} — ${a.work}${a.section ? `, ${a.section}` : ''}`.slice(0, 400), work: a.work, ...(a.section ? { section: String(a.section) } : {}), ...(url ? { url } : {}) };
}

const tagsOf = (t) => [...new Set((Array.isArray(t) ? t : []).map((x) => String(x).toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)).filter(Boolean))].slice(0, 3);

/**
 * Per-output validator shared by single turns and batches (gen-batch.mjs):
 * JSON shape → 280 weighted chars (reject, never truncate) → house-style lint (+ repetition across
 * the run via tracker) → quotes verified against THIS turn's tool log → fields (media/poll/note)
 * → policy gate. Returns { problem: string|null, violations?, fields? }.
 */
export async function validateItem(out, { task, persona, passages, policyCtx, ctx = {}, tracker = null, rand = Math.random, giphy = null }) {
  if (!out || typeof out !== 'object' || typeof out.text !== 'string' || !out.text.trim()) return { problem: formatRepair(), kind: 'format' };
  const stripped = stripTells(out.text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), { hashtags: task.hashtags ?? (task.hashtag ? 1 : 0) });
  const text = stripped && task.mentions?.length ? ensureMentions(stripped, task.mentions, task.length && task.role !== 'wire' ? Math.min(MAX_TAIK_CHARS, targetCeiling(task.length)) : MAX_TAIK_CHARS) : stripped;
  if (!text) return { problem: formatRepair(), kind: 'format' };
  const len = taikLength(text);
  if (len > MAX_TAIK_CHARS) return { problem: shortenRepair(len, task.length.min, Math.min(task.length.max, MAX_TAIK_CHARS)), kind: 'length' };
  if (task.length && task.role !== 'wire' && len > targetCeiling(task.length)) return { problem: targetRepair(len, task.length.min, task.length.max), kind: 'length' };
  const style = [...lintTaik(text, persona), ...(tracker ? tracker.check(text) : [])];
  if (style.length) return { problem: houseStyleRepair(style), kind: 'style', style };
  const { refs, bad } = resolveQuotes(text, out.quoteRefs, passages);
  if (bad.length) return { problem: quoteRepair(bad), kind: 'quote' };
  const fields = await assembleFields({ out, text, refs, task, persona, passages, rand, giphy });
  const check = checkPost({ text: fields.text, ...fields }, policyCtx, { topic: ctx.topic, parentText: (ctx.thread ?? []).map((p) => p.text).join(' ') });
  if (!check.ok) return { problem: repairHint(check.violations), kind: 'policy', violations: check.violations };
  return { problem: null, fields };
}

/**
 * Run one turn. Returns { ok, fields?, error?, toolLog, calls, repairs, violations? }.
 * Throws BudgetError when the shared request budget runs out.
 */
export async function runTurn({ client, persona, byId, task, ctx, nativeTools = true, policyCtx, rand = Math.random, tracker = null, giphy = null }) {
  const emulated = !nativeTools;
  const toolbox = createToolbox({ persona, pool: ctx.pool ?? [], thread: ctx.threadFn });
  const useTools = task.role !== 'wire' && task.tools !== false;
  const messages = [
    { role: 'system', content: systemMessage(persona, byId, { emulateTools: emulated && useTools }) },
    { role: 'user', content: userMessage(task, ctx) },
  ];
  const start = client.calls;
  const callModel = (final, repair = false) =>
    client.chat({
      messages,
      ...(useTools && !emulated ? { tools: toolbox.schemas, tool_choice: final ? 'none' : 'auto' } : {}),
      ...(repair ? { _repair: true } : {}),
    });
  let msg;
  try {
    let rounds = 0;
    for (;;) {
      const final = !useTools || rounds >= MAX_TOOL_ROUNDS;
      if (final && emulated && useTools && rounds > 0) messages.push({ role: 'user', content: 'No more tool calls. Return the final JSON object now.' });
      const r = await callModel(final);
      msg = r.message;
      const calls = final ? [] : toolCallsOf(msg, emulated);
      if (!calls.length) break;
      rounds++;
      const results = calls.slice(0, MAX_CALLS_PER_ROUND).map((c) => ({ id: c.id, name: c.name, result: toolbox.call(c.name, c.args) }));
      if (emulated) {
        messages.push({ role: 'assistant', content: String(msg.content ?? '') });
        messages.push({ role: 'user', content: `TOOL_RESULTS ${JSON.stringify(results.map(({ name, result }) => ({ name, result })))}` });
      } else {
        messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls.slice(0, MAX_CALLS_PER_ROUND) });
        for (const r2 of results) messages.push({ role: 'tool', tool_call_id: r2.id, content: JSON.stringify(r2.result) });
      }
    }

    let repairs = 0;
    let policyRepairs = 0;
    for (;;) {
      const v = await validateItem(parseJsonLoose(msg.content), { task, persona, passages: toolbox.passages, policyCtx, ctx, tracker, rand, giphy });
      if (!v.problem) {
        tracker?.add(v.fields.text);
        return { ok: true, fields: v.fields, toolLog: toolbox.log, calls: client.calls - start, repairs };
      }
      if (repairs >= MAX_REPAIRS || (v.violations && policyRepairs >= 1)) {
        return { ok: false, error: v.violations ? 'policy' : v.kind === 'style' ? 'style' : 'invalid', violations: v.violations, detail: v.problem.slice(0, 200), toolLog: toolbox.log, calls: client.calls - start, repairs };
      }
      repairs++;
      if (v.violations) policyRepairs++;
      messages.push({ role: 'assistant', content: String(msg.content ?? '') });
      messages.push({ role: 'user', content: v.problem });
      msg = (await callModel(true, true)).message;
    }
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return { ok: false, error: 'llm', detail: String(e.message).slice(0, 200), toolLog: toolbox.log, calls: client.calls - start, repairs: 0, capped: Boolean(e.capped) };
  }
}

export async function assembleFields({ out, text, refs, task, persona, passages, rand, giphy = null }) {
  const fields = { text };
  if (refs.length) fields.quoteRefs = refs;
  if (task.native && typeof out.original === 'string') {
    const phrase = (persona.native_language?.phrases ?? []).find((p) => normalizeQuoteText(p.text) === normalizeQuoteText(out.original));
    if (phrase && persona.native_language?.code) fields.original = { lang: String(persona.native_language.code).toLowerCase(), text: phrase.text };
  }
  if (task.mediaPlan && task.mediaPlan.kind !== 'link_card') {
    const fill = task.mediaPlan.kind === 'poll' ? (out.media?.options ? out.media : out.poll) : out.media;
    Object.assign(fields, await materializeFor(task.mediaPlan, fill, { giphy, rand, text: refs[0]?.canonical ?? text, postId: task.postId }));
  }
  if (task.wantNote) {
    const chosen = passages.get(out.note?.passageId) ?? (refs[0] ? passages.get(refs[0].passageId) : null) ?? [...passages.values()].find((p) => p.kind !== 'local') ?? null;
    const note = buildNote(persona, { passage: chosen, rand });
    if (note) fields.note = note;
  }
  // Text #hashtags come first so every rendered #tag link has a tag page.
  const textTags = [...String(fields.text ?? text).matchAll(/(^|[^\p{L}\p{M}\p{N}_&/])#(\p{L}[\p{L}\p{M}\p{N}_]{1,40})/gu)].map((m) => m[2]);
  const tags = tagsOf([...textTags, ...(Array.isArray(out.tags) ? out.tags : [])]);
  if (tags.length) fields.tags = tags;
  return fields;
}