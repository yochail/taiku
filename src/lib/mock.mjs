// Offline provider: deterministic, template-based X-style taiks built from persona profiles
// (tics, ideas, pet peeves, works) + x_behavior (casing, emoji, slang). No key, no network.
// It answers the same { messages, meta } requests as the real LLM (see prompts.mjs).
import { rng, pick } from './util.mjs';
import { MAX_TAIK_CHARS, taikLength } from './data.mjs';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "Wu wei: effortless action…" → "wu wei"; long sentence-ideas → null (caller falls back). */
function concept(idea) {
  const head = clean(idea).split(/[:(—;,]| - /)[0].trim().replace(/[.,]$/, '');
  if (head.split(' ').length > 4) return null;
  return head.replace(/^(the|a|an) /i, (m) => m.toLowerCase());
}

const SENSITIVE = /antisemit|racis|slave|genocid|nazi|nationalis|sexis|colonial|misogyn/i;
const art = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);

/** The gist of an idea: the part after the colon, first clause. */
function gist(idea) {
  const s = clean(idea);
  const after = s.includes(':') ? s.split(':').slice(1).join(':') : s;
  const g = after.split(/[;.]/)[0].trim();
  return /^[A-Z][a-z]/.test(g) ? g[0].toLowerCase() + g.slice(1) : g;
}

const shortTitle = (t, n = 70) => {
  const s = clean(t).replace(/\s+[-|–]\s+[^-|–]+$/, '');
  return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…';
};

const work = (p, rand) => {
  const ws = (p.key_works ?? []).map((w) => w.title).filter((t) => t && !/^\(|no surviving/i.test(t) && t.length < 50);
  return ws.length ? pick(rand, ws) : null;
};

function fit(s) {
  s = String(s).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
  if (taikLength(s) <= MAX_TAIK_CHARS) return s;
  const cps = [...s].slice(0, MAX_TAIK_CHARS - 1).join('');
  return cps.replace(/\s+\S*$/, '') + '…';
}

function styleText(s, b, rand, { grave = false } = {}) {
  if (b.casing === 'lowercase' && rand() < 0.9) s = s.toLowerCase();
  if (b.casing === 'caps' && !grave && rand() < b.caps_use * 1.5) {
    const words = s.split(' ');
    const i = Math.floor(rand() * words.length);
    if (words[i]?.length > 3) words[i] = words[i].toUpperCase();
    s = words.join(' ');
  }
  if (!grave && b.emoji?.length && rand() < b.emoji_use && !/\p{Extended_Pictographic}\s*$/u.test(s)) s += ` ${pick(rand, b.emoji)}`;
  return fit(s);
}

function ctx(meta, rand) {
  const p = meta.persona;
  const b = meta.behavior;
  const ideas = p.core_ideas ?? ['know thyself'];
  const idea = pick(rand, ideas);
  const named = ideas.map(concept).filter(Boolean);
  const peeves = (p.pet_peeves ?? []).filter((x) => !SENSITIVE.test(x));
  return {
    p,
    b,
    idea,
    c: concept(idea) ?? (named.length ? pick(rand, named) : pick(rand, p.favorite_topics ?? ['wisdom'])),
    g: gist(idea),
    tic: pick(rand, (p.voice?.tics ?? []).filter((t) => !/:\s*$/.test(t)).concat((p.voice?.tics ?? []).every((t) => /:\s*$/.test(t)) ? ['…'] : [])),
    peeve: clean(peeves.length ? pick(rand, peeves) : 'nonsense').replace(/\.$/, ''),
    fav: pick(rand, p.favorite_topics ?? ['wisdom']),
    slang: b.slang?.filter((t) => !/:\s*$/.test(t)).length ? pick(rand, b.slang.filter((t) => !/:\s*$/.test(t))) : null,
    emo: b.emoji?.length ? pick(rand, b.emoji) : '',
    work: work(p, rand),
    t: meta.topic ? shortTitle(meta.topic.title) : pick(rand, p.favorite_topics ?? ['this']),
  };
}

const ROOT = {
  aphorism: (x) => [`${x.g}. ${x.t} is just the latest proof.`, `${x.tic} ${x.g}.`],
  hot_take: (x) => [`hot take: ${x.t} is actually about ${x.c} and nobody wants to say it.`, `${x.t}? Everyone is wrong about this, and it's because of ${x.peeve}.`],
  teaching: (x) => [`Quick one on ${x.t}: ${x.g}. That's the whole lesson.`],
  thread: (x) => [`${x.t} — what it really means 🧵`],
  listicle: (x, r) => [`${x.t}, ranked by ${x.c}:\n1. ${x.g}\n2. ${x.peeve}\n3. whatever this is`],
  reminder: (x) => [`Reminder: ${x.g}. Yes, even today. Even with ${x.t}.`],
  question: (x) => [`Genuine question about ${x.t}: who decided this was good, and by what measure?`, `If ${x.g}, then what exactly is ${x.t}?`],
  news_take: (x) => [`${x.t}.\n\nThis is ${x.c} playing out in real time. ${x.tic}`, `Reading "${x.t}" and all I see is ${x.peeve}.`],
  unpopular_opinion: (x) => [`unpopular opinion: ${x.t} is fine. ${x.peeve} is the actual problem.`, `unpopular opinion: ${x.g}. yes, this applies to ${x.t}.`],
  meme: (x) => [`nobody:\nabsolutely nobody:\n${x.t}: *${x.peeve}*\nme: ${x.c}`, `${x.t}: exists\nme, ${art(x.p.school ?? 'philosopher')} enjoyer: ${x.tic}`],
  quote_post: (x) => [`${x.tic} — and today ${x.t} proves it.`],
  shitpost: (x) => [`${x.t} is just ${x.c} for people who ${x.peeve.toLowerCase()}`, `woke up. ${x.c}. read about ${x.t}. went back to sleep.`, `*${x.tic.replace(/\*/g, '')}* anyway ${x.t}`],
  copypasta: (x) => [`you ever just ${x.c}? like not in a ${x.t} way. in a real way. no ${x.peeve}. no applause. just ${x.c}. anyway that's why i'm not invited to things`, `I'm not saying ${x.t} is ${x.peeve}. I'm saying if ${x.peeve} made a ${x.t}, it would look exactly like this. Just saying. Just asking questions. Just ${x.c}.`],
  poll: (x) => [`${x.t} — be honest:\n\n○ ${x.c}\n○ ${x.peeve}\n○ both, sadly\n○ i just want to see results`],
  subtweet: (x) => [`some of you saw "${x.t}" and immediately chose ${x.peeve}. not naming names. you know who you are.`, `funny how the loudest people on ${x.t} have never once considered ${x.c}`],
  pov: (x) => [`POV: you understand ${x.c} and have to watch everyone react to ${x.t}`, `me when ${x.t}: ${x.tic}`],
  hear_me_out: (x) => [`hear me out: ${x.t} but make it ${x.c}.`, `ok hear me out — what if the answer to ${x.t} is just ${x.g}`],
  quote_take: (x) => [`${x.g}. This is that.`],
  quote_dunk: (x) => [`not this being the take 💀`],
};

const GRAVE_ROOT = (x) => [
  `${x.t}. Before the takes start: these are real people. ${x.g}.`,
  `${x.t}. Grief first. Then ask who had the power to prevent it, and why they didn't.`,
];

const REPLY = {
  agree_extend: (x) => [`yes — and it goes further: ${x.g}.`, `This. And it's ${x.c} all the way down.`],
  steelman_rebut: (x) => [`Best version of your point: ${x.tt} is reasonable. Still wrong, because ${x.g}.`],
  counterexample: (x) => [`Counterexample: ${x.fav}. Your rule breaks immediately.`],
  dunk: (x) => [`imagine saying this with your whole chest`, `${x.tic} this is ${x.peeve} with extra steps`],
  source_challenge: (x) => [`source: trust me bro? how do you KNOW this?`, `By what method did you arrive at this, exactly?`],
  context_note: (x) => [`Context the timeline is missing: ${x.g}.`],
  joke: (x) => [`${x.tic} ${x.emo}`, `ok but this is literally just ${x.c} with a ring light`],
  question_back: (x) => [`And who decides that?`, `Define "${x.c}" first. I'll wait.`],
  concession: (x) => [`Fair. I'll give you that one. But ${x.g}.`],
  thread_hijack: (x) => [`This is really about ${x.fav}, and nobody here is ready for that conversation.`],
  ratio: (x) => [`ratio + ${x.g}`, `L + ratio + ${x.c} + touch grass`],
  this_you: (x) => [x.twork ? `this you? 👇 ${x.twork}` : `this you?`, `"${x.tc}" this you? 💀`],
  emoji_reply: (x) => [`💀`, `😭😭😭`, `${x.emo || '👀'}`],
  well_actually: (x) => [`well actually, ${x.g}. small detail. changes everything.`],
  clapback: (x) => [`read it again. slower this time.`, `you replied fast for someone who didn't read it`, `${x.tic} I stand by every word.`],
  hype: (x) => [`HE'S SO RIGHT FOR THIS`, `this is it. this is the post. ${x.emo}`, `say it louder for ${x.peeve}`],
  reply_guy: (x) => [`actually, as someone who has thought about ${x.c} a lot,`, `interesting. but have you considered ${x.c}?`],
};

const GRAVE_REPLY = (x) => [`Agreed. And the question that matters is who had power here — ${x.g}.`, `Yes. Grief first, then responsibility.`];

const QUOTE = {
  quote_dunk: (x) => [`not ${x.tname} discovering ${x.peeve} and calling it philosophy 💀`, `this is what happens when you skip ${x.c}`, `be so fr. ${x.g}.`, `@${x.thandle} the ${x.work ?? x.c} reading club is open whenever you're ready`],
  quote_take: (x) => [`${x.tname} is close, but the real point is: ${x.g}.`, `this but ${x.c}`, `${x.tic} — this is exactly why.`],
  hype: (x) => [`READ THIS. ${x.tname} gets it.`],
};

const THREAD_PARTS = (x, ideas) => [
  `${x.t} — let's actually think about it. 🧵👇`,
  ...ideas.slice(0, 2).map((i, k) => `${k + 2}/ ${gist(i)}.`),
  `So: ${x.g}. That's it. That's the thread.`,
];

export function createMockProvider(seed = 'taiku') {
  const rand = rng(`mock:${seed}`);
  return {
    name: 'mock',
    async complete(_messages, meta) {
      if (!meta) throw new Error('mock provider needs meta');
      if (meta.kind === 'rank') {
        const n = meta.n;
        return JSON.stringify({ picks: meta.candidates.map((_, i) => i).slice(0, n) });
      }
      if (meta.kind === 'shorten') {
        const s = clean(meta.text);
        const cut = [...s].slice(0, Math.floor(meta.limit * 0.85)).join('').replace(/\s+\S*$/, '');
        return JSON.stringify({ text: cut });
      }
      const x = ctx(meta, rand);
      if (meta.kind === 'root') {
        if (meta.thread) {
          const parts = THREAD_PARTS(x, x.p.core_ideas ?? []).map((s) => styleText(s, x.b, rand, meta));
          return JSON.stringify({ parts, tags: [], citation: null });
        }
        const gen = meta.grave ? GRAVE_ROOT : ROOT[meta.archetype] ?? ROOT.hot_take;
        let text = pick(rand, gen(x, rand));
        if (!meta.grave && x.slang && rand() < 0.35 && !text.toLowerCase().includes(x.slang.toLowerCase())) text = `${text} ${x.slang}`;
        return JSON.stringify({ text: styleText(text, x.b, rand, meta), tags: [], citation: null });
      }
      const tp = meta.kind === 'quote' ? meta.quotedPersona : meta.targetPersona;
      const tIdea = tp ? pick(rand, tp.core_ideas ?? ['']) : '';
      Object.assign(x, {
        tname: tp?.name ?? 'this guy',
        thandle: tp?.handle ?? 'someone',
        tc: concept(tIdea) ?? (tp?.core_ideas ?? []).map(concept).find(Boolean) ?? 'this',
        tt: gist(tIdea),
        twork: tp ? work(tp, rand) : null,
      });
      if (meta.kind === 'quote') {
        const gen = meta.grave ? GRAVE_REPLY : QUOTE[meta.archetype] ?? QUOTE.quote_take;
        return JSON.stringify({ text: styleText(pick(rand, gen(x)), x.b, rand, meta), tags: [], citation: null });
      }
      const gen = meta.grave ? GRAVE_REPLY : REPLY[meta.archetype] ?? REPLY.agree_extend;
      let text = pick(rand, gen(x));
      if (!meta.grave && x.slang && rand() < 0.25 && meta.archetype !== 'emoji_reply' && !text.toLowerCase().includes(x.slang.toLowerCase())) text = `${text} ${x.slang}`;
      return JSON.stringify({ text: styleText(text, x.b, rand, meta), citation: null });
    },
  };
}
