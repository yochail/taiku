// Offline mock provider: same interface as llm.createClient, no network, no key. It behaves like a
// tool-using model so the whole agentic path is exercised: round 1 calls search_sources (native
// tool_calls, or the {"tool_calls":[...]} JSON emulation), the final round writes a taik of the
// requested length/media that sometimes quotes a returned passage verbatim, sometimes a slightly
// varied translation (fuzzy path), and occasionally overshoots 280 chars (repair path).
import { MEME_FORMATS, REACTIONS, CHART_TYPES } from './archetypes.mjs';
import { quoteMatches, taikLength, MAX_TAIK_CHARS } from './data.mjs';
import { seededRng, sha256 } from './pipeline-util.mjs';

const tagContent = (s, tag) => s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;
const lastOf = (messages, role) => [...messages].reverse().find((m) => m.role === role);

function parseContext(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content ?? '';
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  let profile = {};
  try {
    profile = JSON.parse(sys.match(/PROFILE: (\{.*\})/)?.[1] ?? '{}');
  } catch {
    profile = {};
  }
  let spec = {};
  try {
    spec = JSON.parse(tagContent(firstUser, 'task_spec') ?? '{}');
  } catch {
    spec = {};
  }
  const untrusted = tagContent(firstUser, 'untrusted_source') ?? '';
  const title = untrusted.match(/title: (.*)/)?.[1]?.trim() ?? '';
  const thread = (tagContent(firstUser, 'thread_context') ?? '').trim().split('\n').filter(Boolean);
  const last = thread.at(-1) ?? '';
  const targetHandle = last.match(/@(\w+)/)?.[1] ?? null;
  const [min, max] = String(spec.length ?? '60-140').split(/[^\d]+/).map(Number);
  return { sys, profile, spec, title, targetHandle, min: min || 1, max: Math.min(max || 140, MAX_TAIK_CHARS), emulate: /TOOLS \(emulated\)/.test(sys) };
}

/** Passages returned by tools so far (native tool messages or emulated TOOL_RESULTS). */
function returnedPassages(messages) {
  const out = [];
  for (const m of messages) {
    const raw = m.role === 'tool' ? m.content : m.role === 'user' && String(m.content).startsWith('TOOL_RESULTS') ? String(m.content).replace(/^TOOL_RESULTS\s*/, '') : null;
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      for (const r of Array.isArray(j) ? j : [j]) {
        const res = r.result ?? r;
        for (const p of res.passages ?? (res.passage ? [res.passage] : [])) out.push(p);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

const SWAPS = [
  [/\bthe\b/, 'a'],
  [/\bis\b/, "'s"],
  [/\bthat\b/, 'which'],
  [/\bhe\b/, 'one'],
  [/\bto be\b/, 'being'],
  [/,/, ''],
];
/** A slightly different "translation" that still passes the fuzzy threshold + guard. */
export function fuzzVariant(text, rand) {
  for (const [re, rep] of [...SWAPS].sort(() => rand() - 0.5)) {
    if (!re.test(text)) continue;
    const v = text.replace(re, rep).replace(/\s+/g, ' ').trim();
    if (v !== text && quoteMatches(v, text, { translated: true }).ok) return v;
  }
  return null;
}

const SHORT = ['mid.', 'ratio.', 'this you?', 'be so for real', 'source?', 'no.', 'cope.', 'correct.', 'the agora is cooked', 'touch grass', 'he cooked', 'not the flex you think', 'read a book', 'oh no', 'we live in a society', 'facts', 'respectfully, no'];
const EMOJI = ['💀', '🔥', '😭', '🤔', '👀', '🏛️', '📉', '🫠', '🙃', '🍿'];

function idea(profile, rand) {
  const ideas = (profile.core_ideas ?? []).map((s) => String(s).split(/[.;:—(]/)[0].trim().toLowerCase()).filter((s) => s.length > 3 && s.length < 60);
  return ideas.length ? ideas[Math.floor(rand() * ideas.length)] : 'knowing yourself';
}

function subjectOf(title) {
  const t = String(title || 'this timeline').replace(/\s+-\s+[^-]+$/, '').toLowerCase();
  const words = t.split(/\s+/);
  return words.slice(0, Math.min(words.length, 7)).join(' ').replace(/[.,:;!?]+$/, '');
}

/** Candidate sentences for a role/archetype (all lowercase-ish to keep names out). */
function sentences(ctx, rand) {
  const s = subjectOf(ctx.title);
  const i = idea(ctx.profile, rand);
  const tics = (ctx.profile.voice?.tics ?? []).filter((x) => !/["“”@]/.test(x));
  const tic = tics[Math.floor(rand() * Math.max(1, tics.length))];
  const at = ctx.targetHandle && ctx.spec.mention ? `@${ctx.targetHandle} ` : '';
  const role = ctx.spec.role;
  if (role === 'wire') return [`${ctx.title || 'Developing story'}`, '\n\nThe report is developing; key details are in the linked story.'];
  const pools = {
    original: [`hot take: ${s} is just ${i} with better marketing.`, `everyone arguing about ${s} and nobody asking what it does to the soul.`, `${s}. we really did this to ourselves.`, `nobody:\nme, two thousand years early: ${i}.`, `unpopular opinion: ${s} is the most honest thing to happen this week.`, `this is your reminder that ${i} still applies to ${s}.`, `i have thought about ${s} for ten minutes and i am already tired.`, `the real story here is ${i}. the rest is noise.`, `imagine reading about ${s} and not thinking about ${i}.`],
    reply: [`${at}respectfully, you skipped the part where ${i} ruins your whole point.`, `${at}counterpoint: no.`, `${at}this is what happens when you skip ${i}.`, `${at}the strongest version of your take is decent. but ${i}.`, `${at}you said this with your whole chest and it is still wrong.`, `${at}yes, and it gets worse once you factor in ${i}.`, `${at}be so for real.`, `${at}finally someone said it.`],
    quote: [`this take on ${s} is why we can't have nice things.`, `quoting this so future historians know who to blame.`, `reading this and thinking about ${i} very hard.`, `the ratio this deserves is cosmic.`, `this is it. this is the whole argument against ${i}.`, `half right, which is the most dangerous kind of right.`],
  };
  const list = [...(pools[role] ?? pools.original)].sort(() => rand() - 0.5);
  if (tic && rand() < 0.4) list.unshift(String(tic));
  return list;
}

/** Fit sentences into [min,max] by greedy assembly; never exceeds MAX_TAIK_CHARS unless `overlong`. */
function assemble(list, min, max, rand) {
  if (max <= 40) {
    const short = list.filter((x) => taikLength(x) <= max);
    return short.length && rand() < 0.4 ? short[0] : SHORT[Math.floor(rand() * SHORT.length)];
  }
  let text = '';
  for (const s of list) {
    const next = text ? `${text}${s.startsWith('\n') ? '' : ' '}${s}` : s;
    if (taikLength(next) > max) continue;
    text = next;
    if (taikLength(text) >= min) break;
  }
  return text || SHORT[0];
}

/** Build the final JSON object (as the model would return it). */
function compose(ctx, passages, rand, { repairing }) {
  const out = {};
  const { spec, profile } = ctx;
  let min = ctx.min;
  let max = ctx.max;
  let text;
  let quoteRefs;
  const quotable = passages.filter((p) => taikLength(p.text) <= Math.min(200, max - 4) && !/"/.test(p.text));
  if (spec.role !== 'wire' && quotable.length && rand() < (spec.quote ? 0.75 : 0.3)) {
    const p = quotable[Math.floor(rand() * quotable.length)];
    let qtext = p.text;
    if (p.translated && rand() < 0.35) qtext = fuzzVariant(p.text, rand) ?? p.text;
    const lead = ['', 'reminder: ', 'me, years ago: ', 'said it then, saying it now: ', 'anyway. '][Math.floor(rand() * 5)];
    text = `${lead}"${qtext}"`;
    const tail = assemble(sentences(ctx, rand), 1, max - taikLength(text) - 1, rand);
    if (taikLength(`${text}\n\n${tail}`) <= max && rand() < 0.7) text = `${text}\n\n${tail}`;
    quoteRefs = [{ passageId: p.passageId, text: qtext }];
    if (rand() < 0.5) out.note = { passageId: p.passageId };
    min = 1;
  } else text = assemble(sentences(ctx, rand), min, max, rand);
  if (spec.native && (profile.native_phrases ?? []).length) {
    const [phrase, translation] = String(profile.native_phrases[Math.floor(rand() * profile.native_phrases.length)]).split(' = ');
    out.original = phrase.trim();
    text = `${phrase.trim()}. ${String(translation ?? '').split(/[;,(]/)[0].trim()}. that's the post.`;
    quoteRefs = undefined;
  }
  if (/use 1-2 emoji/.test(spec.emoji ?? '') && taikLength(text) + 3 <= MAX_TAIK_CHARS) text = `${text} ${EMOJI[Math.floor(rand() * EMOJI.length)]}`;
  if (/hashtag/.test(spec.hashtag ?? '') && !/no hashtags/.test(spec.hashtag) && taikLength(text) + 14 <= MAX_TAIK_CHARS) text = `${text} #${['discourse', 'philosophy', 'touchgrass', 'agora'][Math.floor(rand() * 4)]}`;
  if (!repairing && spec.role !== 'wire' && rand() < 0.04) text = `${text} ${'and another thing, '.repeat(16)}`; // overshoot → exercises shorten-repair
  out.text = text;
  if (quoteRefs) out.quoteRefs = quoteRefs;
  const media = String(spec.media ?? '');
  if (/JOKE chart/.test(media)) {
    const labels = ['me', 'my rivals', 'the agora', 'everyone else'].slice(0, 2 + Math.floor(rand() * 3));
    out.media = { chartType: CHART_TYPES[Math.floor(rand() * CHART_TYPES.length)], title: `how much i think about ${idea(profile, rand)}`.slice(0, 60), labels, values: labels.map(() => 5 + Math.floor(rand() * 95)), unit: '%' };
  } else if (/Attach a meme/.test(media)) {
    const fmts = Object.keys(MEME_FORMATS);
    const format = fmts[Math.floor(rand() * fmts.length)];
    const pool = [`reading the news`, idea(profile, rand), 'arguing in the replies', 'touching grass', 'one more scroll', 'the examined life', 'posting through it'];
    out.media = { format, lines: Array.from({ length: MEME_FORMATS[format] }, (_, k) => pool[(k + Math.floor(rand() * pool.length)) % pool.length]) };
  } else if (/reaction GIF/.test(media)) out.media = { reaction: REACTIONS[Math.floor(rand() * REACTIONS.length)], caption: rand() < 0.5 ? 'me reading this' : '' };
  else if (/quote card/.test(media)) out.media = { text: quoteRefs ? quoteRefs[0].text : text.slice(0, 120) };
  else if (/POLL/.test(media)) {
    out.text = assemble([`quick poll on ${subjectOf(ctx.title)}:`, 'be honest.', 'which is it?'], 1, Math.min(max, 140), rand);
    out.poll = { options: ['yes, obviously', 'no, never', 'ask a stoic', 'show results'].slice(0, 2 + Math.floor(rand() * 3)) };
  }
  if (rand() < 0.5) out.tags = [subjectOf(ctx.title).split(' ').filter((w) => w.length > 3)[0]].filter(Boolean).map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean);
  return out;
}

/** Mock client. `opts.tools`: 'on' (native tool_calls) | 'off' (JSON emulation). */
export function createMockClient({ maxCalls = 1000, tools = 'on', nonce = '' } = {}) {
  let calls = 0;
  const stats = { calls: 0, retries: 0, errors: 0, rateLimited: 0 };
  const cfg = { baseUrl: 'mock://local', model: 'mock/taiku-mock-1', tools, host: 'mock' };
  return {
    isMock: true,
    cfg,
    stats,
    get calls() {
      return calls;
    },
    get remaining() {
      return Math.max(0, maxCalls - calls);
    },
    async chat(body) {
      if (calls >= maxCalls) {
        const { BudgetError } = await import('./llm.mjs');
        throw new BudgetError();
      }
      calls++;
      stats.calls = calls;
      const messages = body.messages ?? [];
      const ctx = parseContext(messages);
      const rand = seededRng('mock', nonce, sha256(JSON.stringify(messages)));
      const toolTurns = messages.filter((m) => m.role === 'tool' || (m.role === 'user' && String(m.content).startsWith('TOOL_RESULTS'))).length;
      const wantsTools = ctx.spec.role !== 'wire' && toolTurns === 0 && body.tool_choice !== 'none' && (body.tools?.length || ctx.emulate);
      if (wantsTools) {
        const query = `${subjectOf(ctx.title)} ${idea(ctx.profile, rand)}`.slice(0, 80);
        if (ctx.emulate) return { message: { role: 'assistant', content: JSON.stringify({ tool_calls: [{ name: 'search_sources', arguments: { query } }] }) }, model: cfg.model };
        return { message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name: 'search_sources', arguments: JSON.stringify({ query }) } }] }, model: cfg.model };
      }
      const repairing = /Too long:|not verbatim|not a valid JSON|content policy/.test(lastOf(messages, 'user')?.content ?? '');
      const out = compose(ctx, returnedPassages(messages), rand, { repairing });
      return { message: { role: 'assistant', content: JSON.stringify(out) }, model: cfg.model };
    },
  };
}
