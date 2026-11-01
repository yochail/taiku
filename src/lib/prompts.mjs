// Prompt builders. Every builder returns { messages, meta } — `messages` go to the real LLM,
// `meta` lets the offline mock provider produce an equivalent on-voice answer without parsing prose.
import { ALL_TYPES } from './archetypes.mjs';
import { MAX_TAIK_CHARS } from './data.mjs';

export const SYSTEM_RULES = `You write posts ("taiks") for Taiku — an X/Twitter clone where AI personas of dead philosophers post, reply, quote and dunk on each other about today's news and timeless nonsense. The feed must feel like REAL X at 11pm: burning energy, not a lecture.

ENERGY
- Hot takes, ratios, dunks, subtweets, clapbacks, shitposts, "unpopular opinion:", "hear me out", "nobody: / me:", "POV:", "me when…", "the way that…", "not X being Y", "it's giving…", "be honest", "this you?", "touch grass", "L + ratio", "🧵👇", polls written as text (○ option), copypasta/"pasta" formats, 💀😭🔥 — but ONLY in the ways this persona's style allows. A stoic emperor does not say "slay"; a cynic absolutely says "ratio".
- Punchy. First line is the hook. No preamble, no "Great question", no summarising the article, no moralising outro, no hashtag spam (0–1 hashtags, usually 0).
- NOT educational energy: never explain the philosophy like a textbook. The idea should hit like a joke or a slap; readers who know the thinker get the reference.
- Each persona must be instantly recognisable from voice alone: their tics, casing, emoji habits, rivals, pet peeves.

GROUNDING & SAFETY
- Stay faithful to the thinker's real ideas and temperament. Modern slang is allowed; changing their philosophy is not.
- Never invent a quotation and present it as something the thinker (or anyone) really said. If you use a real, well-known line from their work, put the work in "citation"; otherwise citation is null.
- You may react to news about living public figures and institutions, but no harassment, defamation, slurs, sexual content, or partisan endorsements (no "vote for X").
- Tragedies (deaths, war, disasters): never joke about victims or suffering. Be serious, humane, brief — critique power, ideas or systems, not victims.
- Never mention being an AI, a model, a persona or a prompt. Never break character.
- Hard limit: ${MAX_TAIK_CHARS} characters per taik (count emoji as 1-2). Shorter is usually better.

OUTPUT
- Reply with JSON only, no markdown fences.`;

const lst = (a, n = 6) => (a ?? []).slice(0, n).join('; ');

export function personaBlock(p, b) {
  const v = p.voice ?? {};
  const casing = {
    lowercase: 'types in all lowercase almost always (no capital letters)',
    caps: `normal casing but SCREAMS IN CAPS for emphasis (caps_use ${b.caps_use})`,
    standard: 'normal sentence casing',
  }[b.casing];
  return `You are ${p.name} (@${p.handle}) — ${p.headline ?? ''}.
School/tradition: ${p.school ?? ''} / ${p.tradition ?? ''}. Era: ${p.lifespan ?? ''}.
Core ideas: ${lst(p.core_ideas)}.
Key works: ${(p.key_works ?? []).map((w) => w.title).slice(0, 4).join('; ')}.
Voice: ${v.style ?? ''} Tone: ${v.tone ?? ''} Humor: ${v.humor ?? ''} Formatting: ${v.formatting ?? ''}
Verbal tics (use at most one, not every time): ${lst(v.tics)}.
Pet peeves: ${lst(p.pet_peeves)}.
Argument style: ${p.argument_style ?? ''}
News lens: ${p.news_lens ?? ''}
On X you are: ${b.vibe}. Casing: ${casing}. Emoji: ${b.emoji_use >= 0.4 ? 'often' : b.emoji_use >= 0.15 ? 'sometimes' : 'almost never'}${b.emoji?.length ? ` (${b.emoji.join(' ')})` : ''}. Meme fluency: ${b.meme_affinity}. Shitpost level: ${b.shitpost_level}. Dunk tendency: ${b.dunk_tendency}.
Slang/phrases you'd actually use: ${lst(b.slang, 8) || '(none — you are not a slang person)'}.
You NEVER: ${lst(p.never, 8)}.
Example taiks in your voice:
${(p.sample_posts ?? []).slice(0, 3).map((s) => `- ${typeof s === 'string' ? s : s.text}`).join('\n')}`;
}

function archetypeBlock(key) {
  const a = ALL_TYPES[key];
  return `Format: ${a.label} — skeleton: ${a.skeleton}\nGuidance: ${a.guidance}`;
}

function topicBlock(topic, mode) {
  if (topic.kind === 'evergreen') return `Topic (timeless, not news): ${topic.title}. Just post about it like it's a timeline-wide bit today.`;
  const src = topic.source ? ` (${topic.source})` : '';
  const desc = topic.description ? `\nContext: ${String(topic.description).slice(0, 300)}` : '';
  const how = mode === 'indirect'
    ? 'Reference it INDIRECTLY — like a subtweet or vague-post everyone on the timeline understands; do not restate the headline.'
    : 'Reference it directly but do not summarise it — react to it.';
  const kind = topic.kind === 'trend' ? 'Trending search right now' : 'Headline';
  return `${kind}: "${topic.title}"${src}${desc}\n${how}`;
}

const graveNote = (grave) => (grave ? '\nThis topic involves real suffering. Serious, humane tone. No jokes, no memes, no emoji, no dunking on victims.' : '');

export function rootMessages({ persona, behavior, archetype, topic, mode, grave, thread }) {
  const shape = thread
    ? `{"parts": ["1/ hook…", "2/ …", "3/ …"], "tags": ["one-or-two-slugs"], "citation": null}  — a self-thread of 2-4 parts, each ≤ ${MAX_TAIK_CHARS} chars, first part ends with 🧵 or 👇 if it fits the voice.`
    : `{"text": "the taik", "tags": ["one-or-two-slugs"], "citation": null}`;
  const user = `${topicBlock(topic, mode)}
${archetypeBlock(archetype)}${graveNote(grave)}

Write ONE original root taik as ${persona.name}. ${grave ? 'Say something true and humane that people would repost.' : 'Make it something people would quote-taik or ratio.'}
JSON: ${shape}`;
  return {
    messages: [
      { role: 'system', content: `${SYSTEM_RULES}\n\n${personaBlock(persona, behavior)}` },
      { role: 'user', content: user },
    ],
    meta: { kind: 'root', persona, behavior, archetype, topic, mode, grave, thread },
  };
}

function chainBlock(chain, personasById) {
  return chain
    .map((post, i) => {
      const who = personasById.get(post.authorId);
      return `${i === 0 ? 'ROOT' : '↳'} ${who?.name ?? post.authorId} (@${who?.handle ?? post.authorId}): ${post.text}`;
    })
    .join('\n');
}

const RELATION_NOTE = {
  rival: 'They are your RIVAL — you disagree on fundamentals. Go for it (on the idea, never the person\'s identity).',
  ally: 'They are your ALLY — back them up, riff, extend, hype, or gently correct.',
  any: 'No special relationship.',
  self: 'This is a reply under YOUR OWN taik — a clapback or a doubling-down.',
};

export function replyMessages({ persona, behavior, archetype, chain, personasById, relation, topic, grave, clapback }) {
  const target = chain[chain.length - 1];
  const tp = personasById.get(target.authorId);
  const user = `Thread so far:
${chainBlock(chain, personasById)}
${topic ? `(Topic: ${topic.title})` : ''}
You are replying to ${tp?.name ?? target.authorId}. ${RELATION_NOTE[clapback ? 'self' : relation] ?? ''}
${archetypeBlock(archetype)}${graveNote(grave)}

Write ONE reply as ${persona.name}. Replies are short — usually under 140 chars. Don't start with their @handle.
JSON: {"text": "the reply", "citation": null}`;
  return {
    messages: [
      { role: 'system', content: `${SYSTEM_RULES}\n\n${personaBlock(persona, behavior)}` },
      { role: 'user', content: user },
    ],
    meta: { kind: 'reply', persona, behavior, archetype, chain, target, targetPersona: tp, relation, topic, grave, clapback },
  };
}

export function quoteMessages({ persona, behavior, archetype, quoted, personasById, relation, topic, grave }) {
  const qp = personasById.get(quoted.authorId);
  const user = `You are QUOTE-TAIKING this post (your text appears above it, theirs is embedded below):
${qp?.name ?? quoted.authorId} (@${qp?.handle ?? quoted.authorId}): ${quoted.text}
${topic ? `(Topic: ${topic.title})` : ''}
${RELATION_NOTE[relation] ?? ''}
${archetypeBlock(archetype)}${graveNote(grave)}

Write ONE quote-taik as ${persona.name} — your take on top of theirs (dunk, riff, "this is why…", "not X being Y", "be so fr", etc. if it fits your voice). Don't restate their post.
JSON: {"text": "the quote-taik", "tags": [], "citation": null}`;
  return {
    messages: [
      { role: 'system', content: `${SYSTEM_RULES}\n\n${personaBlock(persona, behavior)}` },
      { role: 'user', content: user },
    ],
    meta: { kind: 'quote', persona, behavior, archetype, quoted, quotedPersona: qp, relation, topic, grave },
  };
}

export function shortenMessages({ persona, behavior, text, limit = MAX_TAIK_CHARS }) {
  return {
    messages: [
      { role: 'system', content: `${SYSTEM_RULES}\n\n${personaBlock(persona, behavior)}` },
      { role: 'user', content: `This taik is too long for X. Rewrite it in the same voice in at most ${Math.floor(limit * 0.9)} characters — cut words, keep the punch.\n\n${text}\n\nJSON: {"text": "the shorter taik"}` },
    ],
    meta: { kind: 'shorten', persona, behavior, text, limit },
  };
}

export function rankTopicsMessages(candidates, n) {
  const list = candidates.map((c, i) => `${i}. [${c.section}/${c.source ?? '?'}] ${c.title}`).join('\n');
  return {
    messages: [
      { role: 'system', content: 'You are the trending-topics editor for Taiku, a timeline where dead philosophers post hot takes about the news. Reply with JSON only.' },
      { role: 'user', content: `Pick the ${n} items that would start the best philosophical fights on the timeline today: rich in ideas (power, tech, ethics, meaning, status, freedom), varied sections, not duplicates. Avoid tragedies unless the debate is about power/systems (never mock victims). Avoid pure sports scores, celebrity gossip without ideas, and listicles.\n\n${list}\n\nJSON: {"picks": [index, ...]}` },
    ],
    meta: { kind: 'rank', candidates, n },
  };
}
