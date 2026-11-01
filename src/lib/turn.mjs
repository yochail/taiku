// One agentic turn = one taik/reply/quote. Pre-injected topic + thread context, ≤2 tool rounds
// (search_sources/get_quote mainly), a final round with tool_choice "none", then validation with
// targeted repair prompts: length (never truncate), quote verification against THIS turn's tool
// log (canonical comes from the log, never the model), and the policy gate.
import { MAX_TAIK_CHARS, normalizeQuoteText, quoteMatches, quotedSpans, safeUrl, taikLength } from './data.mjs';
import { CHART_TYPES, MEME_FORMATS, REACTIONS } from './archetypes.mjs';
import { BudgetError, parseJsonLoose } from './llm.mjs';
import { checkPost, repairHint } from './policy.mjs';
import { formatRepair, quoteRepair, shortenRepair, systemMessage, userMessage } from './prompts.mjs';
import { createToolbox } from './tools.mjs';

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

/** Local-render media item from the model's fill-in (validated against fixed vocabularies). */
export function buildMedia(kind, m, { postId, n = 1, persona, fallbackText = '' } = {}) {
  const src = `/media/${postId}-${n}.svg`;
  const base = { kind, src, rating: 'pg', origin: 'local-render' };
  m = m && typeof m === 'object' ? m : {};
  if (kind === 'chart') {
    const labels = (Array.isArray(m.labels) ? m.labels : []).map((l) => str(l, 24)).filter(Boolean).slice(0, 5);
    const values = (Array.isArray(m.values) ? m.values : []).map(Number).slice(0, labels.length);
    const ok = labels.length >= 2 && values.length === labels.length && values.every((v) => Number.isFinite(v) && v >= 0 && v <= 1e6);
    const L = ok ? labels : ['before thinking', 'after thinking'];
    const V = ok ? values : [80, 20];
    const title = str(m.title, 60) || 'a completely scientific chart';
    const render = { template: 'chart', chartType: CHART_TYPES.includes(m.chartType) ? m.chartType : 'bar', title, labels: L, values: V, unit: str(m.unit, 12) || '%' };
    return { ...base, alt: `Joke ${render.chartType} chart titled "${title}" (illustrative, not real data): ${L.map((l, i) => `${l} ${V[i]}${render.unit}`).join(', ')}`.slice(0, 1000), render };
  }
  if (kind === 'meme') {
    const format = MEME_FORMATS[m.format] ? m.format : 'drake';
    const need = MEME_FORMATS[format];
    let lines = (Array.isArray(m.lines) ? m.lines : []).map((l) => str(l, 60)).filter(Boolean).slice(0, need);
    while (lines.length < need) lines.push(['thinking', 'posting', 'touching grass', 'the examined life'][lines.length]);
    lines = lines.slice(0, need);
    return { ...base, alt: `${format} meme: ${lines.join(' / ')}`.slice(0, 1000), render: { template: 'meme', format, lines } };
  }
  if (kind === 'gif') {
    const reaction = REACTIONS.includes(m.reaction) ? m.reaction : 'shrug';
    const caption = str(m.caption, 40);
    return { ...base, alt: `Reaction GIF: ${reaction.replace(/-/g, ' ')}${caption ? ` — ${caption}` : ''}`, render: { template: 'reaction', reaction, caption } };
  }
  if (kind === 'image') {
    const text = str(m.text, 140) || str(fallbackText, 140);
    return { ...base, alt: `Quote card: ${text} — ${persona?.name ?? ''}`.slice(0, 1000), render: { template: 'card', text, attribution: persona?.name ?? '' } };
  }
  return null;
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
 * Run one turn. Returns { ok, fields?, error?, toolLog, calls, repairs, violations? }.
 * Throws BudgetError when the shared request budget runs out.
 */
export async function runTurn({ client, persona, byId, task, ctx, nativeTools = true, policyCtx, rand = Math.random }) {
  const emulated = !nativeTools;
  const toolbox = createToolbox({ persona, pool: ctx.pool ?? [], thread: ctx.threadFn });
  const messages = [
    { role: 'system', content: systemMessage(persona, byId, { emulateTools: emulated && task.role !== 'wire' }) },
    { role: 'user', content: userMessage(task, ctx) },
  ];
  const useTools = task.role !== 'wire';
  const start = client.calls;
  const callModel = (final) =>
    client.chat({
      messages,
      ...(useTools && !emulated ? { tools: toolbox.schemas, tool_choice: final ? 'none' : 'auto' } : {}),
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
      const out = parseJsonLoose(msg.content);
      let problem = null;
      let fields = null;
      let violations = null;
      if (!out || typeof out !== 'object' || typeof out.text !== 'string' || !out.text.trim()) problem = formatRepair();
      else {
        const text = out.text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        const len = taikLength(text);
        if (len > MAX_TAIK_CHARS) problem = shortenRepair(len, task.length.min, Math.min(task.length.max, MAX_TAIK_CHARS));
        else {
          const { refs, bad } = resolveQuotes(text, out.quoteRefs, toolbox.passages);
          if (bad.length) problem = quoteRepair(bad);
          else {
            fields = assembleFields({ out, text, refs, task, persona, toolbox, rand });
            const check = checkPost({ text: fields.text, ...fields }, policyCtx, { topic: ctx.topic, parentText: (ctx.thread ?? []).map((p) => p.text).join(' ') });
            if (!check.ok) {
              violations = check.violations;
              problem = repairHint(check.violations);
            }
          }
        }
      }
      if (!problem) return { ok: true, fields, toolLog: toolbox.log, calls: client.calls - start, repairs };
      if (repairs >= MAX_REPAIRS || (violations && policyRepairs >= 1)) {
        return { ok: false, error: violations ? 'policy' : 'invalid', violations, detail: problem.slice(0, 200), toolLog: toolbox.log, calls: client.calls - start, repairs };
      }
      repairs++;
      if (violations) policyRepairs++;
      messages.push({ role: 'assistant', content: String(msg.content ?? '') });
      messages.push({ role: 'user', content: problem });
      msg = (await callModel(true)).message;
    }
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return { ok: false, error: 'llm', detail: String(e.message).slice(0, 200), toolLog: toolbox.log, calls: client.calls - start, repairs: 0 };
  }
}

function assembleFields({ out, text, refs, task, persona, toolbox, rand }) {
  const fields = { text };
  if (refs.length) fields.quoteRefs = refs;
  if (task.native && typeof out.original === 'string') {
    const phrase = (persona.native_language?.phrases ?? []).find((p) => normalizeQuoteText(p.text) === normalizeQuoteText(out.original));
    if (phrase && persona.native_language?.code) fields.original = { lang: String(persona.native_language.code).toLowerCase(), text: phrase.text };
  }
  if (task.media && task.media !== 'poll' && task.media !== 'link_card') {
    const m = buildMedia(task.media, out.media, { postId: task.postId, n: 1, persona, fallbackText: refs[0]?.canonical ?? text });
    if (m) fields.media = [m];
  }
  if (task.media === 'poll') {
    const poll = buildPoll(out.poll, task.postId);
    if (poll) fields.poll = poll;
  }
  if (task.wantNote) {
    const chosen = toolbox.passages.get(out.note?.passageId) ?? (refs[0] ? toolbox.passages.get(refs[0].passageId) : null) ?? [...toolbox.passages.values()].find((p) => p.kind !== 'local') ?? null;
    const note = buildNote(persona, { passage: chosen, rand });
    if (note) fields.note = note;
  }
  const tags = tagsOf(out.tags);
  if (tags.length) fields.tags = tags;
  return fields;
}
