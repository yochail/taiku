// Offline mock provider: same interface as llm.createClient, no network, no key. It behaves like a
// tool-using model so every path is exercised:
// - single turns: round 1 calls search_sources (native tool_calls, or the {"tool_calls":[...]} JSON
//   emulation); the final round writes a taik of the requested length that sometimes quotes a
//   returned passage verbatim, sometimes a slightly varied translation (fuzzy path), and
//   occasionally overshoots 280 chars (repair path)
// - batches (<batch_spec>): a JSON array, one object per item, sometimes code-fenced or with a
//   missing item (partial-array path); repairs return just the failed ids
// - micro (<micro_spec>): tiny replies + new reaction-pool entries
// - media: fills whatever planMedia asked for (meme templates, gif reactions/queries, art, charts, polls)
import { quoteMatches, taikLength, MAX_TAIK_CHARS } from './data.mjs';
import { lintTaik } from './house-style.mjs';
import { seededRng, sha256 } from './pipeline-util.mjs';

const tagContent = (s, tag) => s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;
const lastOf = (messages, role) => [...messages].reverse().find((m) => m.role === role);
const tryJson = (s, d) => {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
const rangeOf = (s, dflt = '60-140') => {
  const [min, max] = String(s ?? dflt).split(/[^\d]+/).filter(Boolean).map(Number);
  return { min: min || 1, max: Math.min(max || 140, MAX_TAIK_CHARS) };
};

function parseContext(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content ?? '';
  const firstUser = String(messages.find((m) => m.role === 'user')?.content ?? '').replace(/^\/no_think\s*/, '');
  const profile = tryJson(sys.match(/PROFILE: (\{.*\})/)?.[1] ?? '{}', {});
  const profiles = new Map();
  for (const m of sys.matchAll(/PROFILE\[@([\w-]+)\]: (\{.*\})/g)) profiles.set(m[1], tryJson(m[2], {}));
  const spec = tryJson(tagContent(firstUser, 'task_spec') ?? '{}', {});
  const batch = tryJson(tagContent(firstUser, 'batch_spec') ?? 'null', null);
  const micro = tryJson(tagContent(firstUser, 'micro_spec') ?? 'null', null);
  const untrusted = tagContent(firstUser, 'untrusted_source') ?? '';
  const title = untrusted.match(/title: (.*)/)?.[1]?.trim() ?? '';
  const threads = new Map();
  for (const m of firstUser.matchAll(/<thread_context(?: id="([^"]+)")?>([\s\S]*?)<\/thread_context>/g)) threads.set(m[1] ?? '', m[2].trim().split('\n').filter(Boolean));
  const last = (threads.get('') ?? []).at(-1) ?? '';
  const { min, max } = rangeOf(spec.length);
  return { sys, profile, profiles, spec, batch, micro, title, threads, targetHandle: last.match(/@([\w-]+)/)?.[1] ?? null, min, max, emulate: /TOOLS \(emulated\)/.test(sys) };
}

/** Passages returned by tools so far (native tool messages or emulated TOOL_RESULTS). */
function returnedPassages(messages) {
  const out = [];
  for (const m of messages) {
    const raw = m.role === 'tool' ? m.content : m.role === 'user' && String(m.content).startsWith('TOOL_RESULTS') ? String(m.content).replace(/^TOOL_RESULTS\s*/, '') : null;
    if (!raw) continue;
    const j = tryJson(raw, null);
    if (!j) continue;
    for (const r of Array.isArray(j) ? j : [j]) {
      const res = r.result ?? r;
      for (const p of res.passages ?? (res.passage ? [res.passage] : [])) out.push(p);
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

const SHORT = ['mid.', 'ratio.', 'be so for real', 'no.', 'cope.', 'correct.', 'the agora is cooked', 'touch grass', 'he cooked', 'not the flex you think', 'read a book', 'oh no', 'we live in a society', 'facts', 'respectfully, no', 'log off', 'deeply unwell take', 'i am screaming', 'blocked. lovingly.', 'this is so embarrassing for you'];
const FEW = ['mid', 'ratio', 'cope', 'correct', 'oh no', 'log off', 'facts', 'no', 'he cooked', 'sit down'];
const EMOJI = ['💀', '🔥', '😭', '🤔', '👀', '🏛️', '📉', '🫠', '🙃', '🍿'];
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

function idea(profile, rand) {
  const ideas = (profile.core_ideas ?? []).map((s) => String(s).split(/[.;:—(]/)[0].trim().toLowerCase()).filter((s) => s.length > 3 && s.length < 60);
  return ideas.length ? pick(ideas, rand) : 'knowing yourself';
}

function subjectOf(title) {
  const t = String(title || 'this timeline').replace(/\s+-\s+[^-]+$/, '').toLowerCase();
  const words = t.split(/\s+/);
  return words.slice(0, Math.min(words.length, 7)).join(' ').replace(/[.,:;!?]+$/, '');
}

/** Candidate sentences for a role (lowercase-ish; no names, no stock AI phrasing). */
function sentences(ctx, rand) {
  const s = subjectOf(ctx.title);
  const i = idea(ctx.profile, rand);
  const tics = (ctx.profile.voice?.tics ?? []).filter((x) => !/["“”@—]/.test(x));
  const tic = tics.length ? pick(tics, rand) : null;
  const at = ctx.targetHandle && ctx.spec.mention ? `@${ctx.targetHandle} ` : '';
  const role = ctx.spec.role;
  const pools = {
    original: [`hot take: ${s} is just ${i} with better marketing.`, `everyone arguing about ${s} and nobody checking what it does to the soul.`, `${s}. we really did this to ourselves.`, `nobody:\nme, two thousand years early: ${i}.`, `unpopular opinion: ${s} is the most honest thing to happen this week.`, `${i} still applies to ${s}. i will not be taking questions.`, `i have thought about ${s} for ten minutes and i am already tired.`, `${s} is ${i} wearing a lanyard.`, `imagine reading about ${s} and not thinking about ${i}. couldn't be me.`, `ok so ${s}. lol. lmao even.`],
    reply: [`${at}respectfully, you skipped the part where ${i} ruins your whole point.`, `${at}counterpoint: no.`, `${at}this is what happens when you skip ${i}.`, `${at}decent take, shame about ${i}.`, `${at}you said this with your whole chest and it is still wrong.`, `${at}yes, and it gets worse once you factor in ${i}.`, `${at}be so for real.`, `${at}finally someone said it.`, `${at}i'm logging off. this is too stupid even for here.`],
    quote: [`this take on ${s} is why we can't have nice things.`, `quoting this so future historians know who to blame.`, `reading this and thinking about ${i} very hard.`, `the ratio this deserves is cosmic.`, `this is the whole argument against ${i}, live, in public.`, `half right, which is the most dangerous kind of right.`],
  };
  const list = [...(pools[role] ?? pools.original)].sort(() => rand() - 0.5);
  if (tic && rand() < 0.4) list.unshift(String(tic));
  return list;
}

const RAMBLE = ['and yes, i checked.', 'nobody asked, i know.', 'the scroll agrees with me.', 'twice, in fact.', 'i will not be taking questions.', 'this is the hill.', 'ok one more thing.', 'fine.'];

/** Fit sentences into [min,max] by greedy assembly; never exceeds MAX_TAIK_CHARS. */
function assemble(list, min, max, rand) {
  if (max <= 40) {
    // The "short" reply form (min >= 10) means 4+ words; tinier asks may be a word or two.
    const fits = (x) => taikLength(x) <= max && (min < 10 || x.trim().split(/\s+/).length >= 4);
    const short = list.filter(fits);
    const pool = SHORT.filter(fits);
    return short.length && rand() < 0.4 ? short[0] : pick(pool.length ? pool : ['no. absolutely not.'], rand);
  }
  let text = '';
  for (const s of list) {
    const next = text ? `${text}${s.startsWith('\n') ? '' : ' '}${s}` : s;
    if (taikLength(next) > max) continue;
    text = next;
    if (taikLength(text) >= min) break;
  }
  // Ran out of material below the target: pad with rambles, like a real poster on a roll.
  for (const s of RAMBLE) {
    if (!text || taikLength(text) >= min) break;
    const next = `${text} ${s}`;
    if (taikLength(next) <= max) text = next;
  }
  return text || SHORT[0];
}

/** Fill a media.mjs plan prompt (the text after `media:` in the spec). */
function mediaFill(media, ctx, rand, text) {
  const m = String(media ?? '');
  const json = (label) => tryJson(m.match(new RegExp(`${label}: (\\[[\\s\\S]*\\])`))?.[1] ?? '[]', []);
  if (/Make this post a poll/.test(m)) return { options: ['yes, obviously', 'no, never', 'ask a stoic', 'touch grass'].slice(0, 2 + Math.floor(rand() * 3)) };
  if (/Attach a meme/.test(m)) {
    const opts = json('Templates');
    if (!opts.length) return null;
    const t = pick(opts, rand);
    const lines = ['reading the news', idea(ctx.profile, rand), 'arguing in the replies', 'touching grass', 'one more scroll', 'the examined life', 'posting through it'];
    return { template: t.id, captions: Object.fromEntries(t.slots.map((s, k) => [s.name, lines[(k + Math.floor(rand() * lines.length)) % lines.length].slice(0, s.max ?? 40)])) };
  }
  if (/GIPHY search query/.test(m)) {
    const opts = json('Fallback options');
    return { query: pick(['slow clap', 'mind blown', 'side eye', 'facepalm', 'popcorn'], rand), reaction: opts.length ? pick(opts, rand).id : 'socrates-mic-drop' };
  }
  if (/Attach a reaction GIF/.test(m)) {
    const opts = json('Options');
    return opts.length ? { reaction: pick(opts, rand).id, ...(rand() < 0.4 ? { caption: 'me reading this' } : {}) } : null;
  }
  if (/painting/.test(m)) {
    const opts = json('Options');
    return opts.length ? { art: pick(opts, rand).id } : null;
  }
  if (/chart/i.test(m)) {
    const labels = ['me', 'my rivals', 'the agora', 'everyone else'].slice(0, 2 + Math.floor(rand() * 3));
    return { type: pick(['bar', 'hbar', 'line', 'pie'], rand), title: `how much i think about ${idea(ctx.profile, rand)}`.slice(0, 70), labels, values: labels.map(() => 5 + Math.floor(rand() * 95)), unit: '%' };
  }
  return text ? null : null;
}

function clipWords(text, max) {
  const words = String(text).split(/\s+/);
  while (words.length > 1 && taikLength(words.join(' ')) > max) words.pop();
  const out = words.join(' ').replace(/[,;:—-]+$/, '');
  return taikLength(out) <= max ? out : [...out].slice(0, max).join('');
}

/** On a repair round, a compliant model fixes what it was told: recompose until clean and in range. */
function composeOk(ctx, passages, rand, opts) {
  let out = compose(ctx, passages, rand, opts);
  for (let i = 0; opts.repairing && i < 8 && (lintTaik(out.text).length || taikLength(out.text) > ctx.max); i++) out = compose(ctx, passages, rand, opts);
  return out;
}

/** Build the final JSON object for one item (as the model would return it). */
function compose(ctx, passages, rand, { repairing }) {
  const out = {};
  const { spec, profile } = ctx;
  let { min, max } = ctx;
  let text;
  let quoteRefs;
  const quotable = passages.filter((p) => taikLength(p.text) <= Math.min(200, max - 4) && !/"/.test(p.text));
  if (spec.role !== 'wire' && quotable.length && rand() < (spec.quote ? 0.75 : 0.3)) {
    const p = pick(quotable, rand);
    let qtext = p.text;
    if (p.translated && rand() < 0.35) qtext = fuzzVariant(p.text, rand) ?? p.text;
    const lead = pick(['', 'me, years ago: ', 'said it then, saying it now: ', 'anyway. ', 'once again for the back row: '], rand);
    text = `${lead}"${qtext}"`;
    const need = min - taikLength(text) - 2;
    const tail = assemble(sentences(ctx, rand), Math.max(1, need), max - taikLength(text) - 2, rand);
    if (taikLength(`${text}\n\n${tail}`) <= max && (need > 0 || rand() < 0.7)) text = `${text}\n\n${tail}`;
    quoteRefs = [{ passageId: p.passageId, text: qtext }];
    if (rand() < 0.5) out.note = { passageId: p.passageId };
    min = 1;
  } else text = assemble(sentences(ctx, rand), min, max, rand);
  if (/emoji only/.test(spec.form ?? '')) text = pick(EMOJI, rand);
  else if (/1-3 words/.test(spec.form ?? '')) text = pick(FEW, rand);
  if (spec.native && (profile.native_phrases ?? []).length) {
    const [phrase, translation] = String(pick(profile.native_phrases, rand)).split(' = ');
    out.original = phrase.trim();
    text = `${phrase.trim()}. ${String(translation ?? '').split(/[;,(]/)[0].trim()}. that's the post.`;
    quoteRefs = undefined;
  }
  // A model asked for N chars cuts to fit; the overshoot path below exercises shorten-repair on purpose.
  if (taikLength(text) > max && !quoteRefs) text = clipWords(text, max);
  if (/use 1-2 emoji/.test(spec.emoji ?? '') && taikLength(text) + 3 <= Math.min(max, MAX_TAIK_CHARS) && !/emoji only/.test(spec.form ?? '')) text = `${text} ${pick(EMOJI, rand)}`;
  const tagged = String(spec.tag ?? '').match(/@[A-Za-z0-9_]+/g) ?? [];
  if (tagged.length && rand() < 0.85 && taikLength(text) + 2 + tagged.join(' ').length <= max) text = rand() < 0.5 ? `${text} ${tagged.join(' ')}` : `${pick(['ok', 'look', 'lol', 'see', 'hey'], rand)} ${tagged.join(' ')}, ${text}`;
  const nTags = Number(String(spec.hashtag ?? '').match(/add exactly (\d+)/)?.[1] ?? (/add one/i.test(spec.hashtag ?? '') ? 1 : 0));
  for (let i = 0; i < nTags && taikLength(text) + 14 <= Math.min(max, MAX_TAIK_CHARS); i++) text = `${text} #${pick(['discourse', 'touchgrass', 'agora', 'ratioed', 'barrelLife', 'notMyCategory'], rand)}`;
  if (!repairing && spec.role !== 'wire' && rand() < 0.04) text = `${text} ${'and another thing, '.repeat(16)}`; // overshoot → exercises shorten-repair
  out.text = text;
  if (quoteRefs) out.quoteRefs = quoteRefs;
  if (/poll/.test(spec.media ?? '') && /Make this post a poll/.test(spec.media)) out.text = assemble([`quick poll on ${subjectOf(ctx.title)}:`, 'be honest.', 'pick one.'], 1, Math.min(max, 140), rand);
  const fill = mediaFill(spec.media, ctx, rand, text);
  if (fill) out.media = fill;
  if (rand() < 0.5) out.tags = [subjectOf(ctx.title).split(' ').filter((w) => w.length > 3)[0]].filter(Boolean).map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean);
  return out;
}

/** Batch request → JSON array content (sometimes fenced, rarely missing an item). */
function composeBatch(ctx, messages, rand) {
  const repairMsg = messages.length > 2 ? String(lastOf(messages, 'user')?.content ?? '') : '';
  const want = repairMsg ? ctx.batch.filter((it) => repairMsg.includes(`${it.id}:`)) : ctx.batch;
  const items = want.map((it) => {
    const handle = String(it.author ?? '').replace(/^@/, '');
    const thread = ctx.threads.get(it.id) ?? [];
    const sub = {
      ...ctx,
      profile: ctx.profiles.get(handle) ?? {},
      spec: { ...it, role: it.role, mention: false },
      targetHandle: thread.at(-1)?.match(/@([\w-]+)/)?.[1] ?? null,
      ...rangeOf(it.length),
    };
    return { id: it.id, ...composeOk(sub, it.passages ?? [], rand, { repairing: Boolean(repairMsg) }) };
  });
  if (!repairMsg && items.length > 2 && rand() < 0.08) items.pop(); // partial array → regenerated
  const body = JSON.stringify(items);
  return rand() < 0.3 ? `\`\`\`json\n${body}\n\`\`\`` : body;
}

const MICRO_LINES = {
  agree: ['co-signed', 'say it louder', 'finally, sense', 'exactly this', 'yes. all of it', 'based and correct'],
  disagree: ['absolutely not', 'wrong again', 'hard no', 'that is not it', 'nope. try again', 'false, sadly'],
  mock: ['the audacity', 'oh you sweet summer child', 'tell me you skimmed it', 'bold of you', 'cringe, but historic', 'a choice was made'],
  awe: ['i need a minute', 'chills', 'genuinely stunning', 'whole body shiver', 'i am undone', 'stop, wow'],
  confused: ['wait what', 'explain like i am a scroll', 'lost me at hello', 'huh', 'sorry, which century', 'i reread it twice'],
  hype: ['LET HIM COOK', 'we are so back', 'banger', 'frame this', 'shout it', 'goat behavior'],
};
const MICRO_TAGS = ['banter', 'reaction', 'agora', 'discourse', 'timeline', 'drama'];

function composeMicro(ctx, rand) {
  const replies = (ctx.micro.replies ?? []).map((r) => ({ id: r.id, text: /emoji/.test(r.form ?? '') ? pick(EMOJI, rand) : pick(MICRO_LINES[r.stance] ?? MICRO_LINES.mock, rand) }));
  const pool = (ctx.micro.pool ?? []).map((r) => {
    const stances = r.stances?.length ? r.stances : ['agree', 'disagree', 'mock'];
    const n = Math.max(1, Math.min(10, r.n ?? 5));
    const seen = new Set();
    const entries = [];
    for (let k = 0; entries.length < n && k < n * 4; k++) {
      const stance = stances[k % stances.length];
      const roll = rand();
      const base = pick(MICRO_LINES[stance] ?? MICRO_LINES.mock, rand);
      const e = roll < 0.6 ? { text: `${base} ${pick(['lol', 'ngl', 'fr', 'honestly', 'again', 'today'], rand)}` } : roll < 0.8 ? { gif_query: `${stance} reaction ${pick(['classic', 'dramatic', 'slow'], rand)}` } : { emoji: pick(EMOJI, rand) + pick(EMOJI, rand) };
      const key = JSON.stringify(e);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...e, stance, tags: [pick(MICRO_TAGS, rand)], tone: pick(['petty', 'smug', 'gleeful', 'wounded', 'sulky'], rand) });
    }
    return { persona: r.author, entries };
  });
  return JSON.stringify({ replies, pool });
}

/** Mock client. `opts.tools`: 'on' (native tool_calls) | 'off' (JSON emulation). */
export function createMockClient({ maxCalls = 1000, tools = 'on', nonce = '', model = 'mock/taiku-mock-1', name = 'mock' } = {}) {
  let calls = 0;
  const stats = { calls: 0, retries: 0, errors: 0, rateLimited: 0 };
  const cfg = { baseUrl: 'mock://local', model, name, tools, host: 'mock' };
  const usageOf = (messages, content) => ({ prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4), completion_tokens: Math.ceil(String(content ?? '').length / 4) + 8 });
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
      const rand = seededRng('mock', nonce, model, sha256(JSON.stringify(messages)));
      const reply = (message) => ({ message: { role: 'assistant', ...message }, model: cfg.model, usage: usageOf(messages, message.content ?? JSON.stringify(message.tool_calls ?? '')) });
      if (ctx.micro) return reply({ content: composeMicro(ctx, rand) });
      if (Array.isArray(ctx.batch)) return reply({ content: composeBatch(ctx, messages, rand) });
      const toolTurns = messages.filter((m) => m.role === 'tool' || (m.role === 'user' && String(m.content).startsWith('TOOL_RESULTS'))).length;
      const wantsTools = ctx.spec.role !== 'wire' && toolTurns === 0 && body.tool_choice !== 'none' && (body.tools?.length || ctx.emulate);
      if (wantsTools) {
        const query = `${subjectOf(ctx.title)} ${idea(ctx.profile, rand)}`.slice(0, 80);
        if (ctx.emulate) return reply({ content: JSON.stringify({ tool_calls: [{ name: 'search_sources', arguments: { query } }] }) });
        return reply({ content: null, tool_calls: [{ id: `call_${calls}`, type: 'function', function: { name: 'search_sources', arguments: JSON.stringify({ query }) } }] });
      }
      const repairing = /Too long:|not verbatim|not a valid JSON|content policy|House style:/.test(lastOf(messages, 'user')?.content ?? '');
      return reply({ content: JSON.stringify(composeOk(ctx, returnedPassages(messages), rand, { repairing })) });
    },
  };
}
