import { POST_ARCHETYPES, REPLY_ARCHETYPES } from './archetypes.mjs';

export const SYSTEM_RULES = `You are writing for Taiku (taiku.app), "Dead Thinkers Society": a feed that looks and feels exactly like X/Twitter, where AI personas of real, deceased thinkers post, reply, quote-dunk and argue about today's news, tech, pop culture, sports and memes. It must have the burning energy of a real timeline (hot takes, dunks, ratios, memes, copypastas, subtweets), NOT the energy of a lecture. The site labels every post as AI-generated.

The persona speaks TODAY, aware of the modern world, worldview intact. Voice is mostly their own era's idiom applied to modern events, with online slang and memes sprinkled in according to their modernity level (1 = never, 5 = terminally online).

Hard rules:
1. Ground every post in the thinker's actual, documented ideas. Apply them to modern life freely, but never attribute views they demonstrably rejected.
2. NEVER invent quotations. Write in the persona's own fresh words. Only use a genuine line from their work if it is listed under "Verified quotables" (or verified with a tool); then wrap it in quotation marks and set "citation" to the listed citation. Otherwise paraphrase without quotation marks and leave citation null.
3. Each post ≤ 270 characters. One idea, concrete, punchy. Hashtags rare and ironic. Emoji, lowercase, line breaks only if the persona's voice allows.
4. Edge: spicy PG-13. Mild profanity, dark humor and real political takes are fine. No slurs, sexual content, gore, threats, or medical/legal/financial advice. Never joke about victims of tragedies; on grave news be serious and humane.
5. Living people: only public figures, and only their PUBLIC actions and statements. No insults about personal traits, no invented facts or quotes, never private individuals.
6. A native-language word or short phrase is welcome occasionally (at most one per post); keep the post understandable in English.
7. Never mention being an AI, a model, or "as a philosopher". Never sign the post. Never start with the persona's own name. Never explain the joke.
8. Make the persona instantly recognizable by voice: use their tics sparingly (at most one per post), their tone, their angle.
9. Respond with a single JSON object only.`;

function list(arr) {
  return (arr ?? []).map((x) => `- ${x}`).join('\n');
}

export function personaBlock(p, byId) {
  const rel = (arr) => (arr ?? []).map((r) => `${byId.get(r.id)?.name ?? r.id} (@${byId.get(r.id)?.handle ?? r.id}): ${r.why}`).join('; ');
  const skill = Array.isArray(p.system_prompt) ? `${p.system_prompt.join('\n\n')}\n\n` : '';
  const extras = [
    p.modernity ? `Modernity: ${p.modernity}/5` : '',
    p.native_language?.phrases?.length
      ? `Native language (${p.native_language.name}) flourishes: ${p.native_language.phrases.map((x) => `${x.text} = "${x.translation}"`).join('; ')}`
      : '',
    p.quotables?.length ? `Verified quotables (the ONLY lines you may quote):\n${list(p.quotables.map((q) => `"${q.text}" (${q.citation})`))}` : '',
    p.sensitive_notes?.length ? `Sensitive notes:\n${list(p.sensitive_notes)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return `${skill}PERSONA: ${p.name} (@${p.handle}) — ${p.lifespan}, ${p.region}. Tradition: ${p.tradition}. School: ${p.school}.
Bio: ${p.bio}
Core ideas:
${list(p.core_ideas)}
Key works: ${p.key_works.map((w) => w.title).join('; ')}
Voice/style: ${p.voice.style}
Tone: ${p.voice.tone}
Humor: ${p.voice.humor}
Formatting habits: ${p.voice.formatting}
Verbal tics (use at most one): ${p.voice.tics.join(' | ')}
Favorite topics: ${p.favorite_topics.join(', ')}
Pet peeves: ${p.pet_peeves.join('; ')}
How they argue: ${p.argument_style}
How they read the news: ${p.news_lens}
Allies: ${rel(p.allies)}
Rivals: ${rel(p.rivals)}
Never: ${p.never.join('; ')}
${extras ? `${extras}\n` : ''}Example posts (style reference only — do not repeat):
${list(p.sample_posts)}`;
}

function recentBlock(recent) {
  if (!recent?.length) return '';
  return `\nThis persona's recent posts (do NOT repeat these ideas or openings):\n${list(recent.map((r) => r.text.replace(/\s+/g, ' ').slice(0, 200)))}`;
}

const SINGLE_FORMAT = '{"text": "<the post>", "tags": ["<1-2 lowercase topic words>"], "citation": null}';
const THREAD_FORMAT = '{"parts": ["<1/n hook ending with 🧵>", "<2/n>", "..."], "tags": ["<1-2 lowercase topic words>"], "citation": null}';

export function postMessages({ persona, archetype, byId, news, quoted, recent, topicHint }) {
  const a = POST_ARCHETYPES[archetype];
  let task = `Write ONE new top-level post as ${persona.name}.
Archetype: ${a.label} — skeleton: ${a.skeleton}
Guidance: ${a.guidance}`;
  if (topicHint) task += `\nSuggested angle (optional): ${topicHint}`;
  if (news) task += `\nReal headline to react to (from ${news.source}): "${news.title}"${news.description ? `\nSummary: ${news.description.slice(0, 300)}` : ''}\nDo not add facts beyond this.`;
  if (quoted) task += `\nYou are quote-posting this post by ${byId.get(quoted.authorId).name} (@${byId.get(quoted.authorId).handle}):\n"""${quoted.text}"""`;
  task += recentBlock(recent);
  task += `\n\nReturn JSON exactly like: ${archetype === 'thread' ? THREAD_FORMAT : SINGLE_FORMAT}`;
  return [
    { role: 'system', content: `${SYSTEM_RULES}\n\n${personaBlock(persona, byId)}` },
    { role: 'user', content: task },
  ];
}

export function replyMessages({ persona, archetype, byId, chain, relation }) {
  const a = REPLY_ARCHETYPES[archetype];
  const target = chain[chain.length - 1];
  const targetAuthor = byId.get(target.authorId);
  const convo = chain
    .map((p) => {
      const au = byId.get(p.authorId);
      return `${au.name} (@${au.handle}): ${p.text.replace(/\s+/g, ' ')}`;
    })
    .join('\n');
  const relText =
    relation === 'ally' ? `${targetAuthor.name} is one of your allies.` : relation === 'rival' ? `${targetAuthor.name} is one of your rivals.` : `You have no fixed alliance with ${targetAuthor.name}.`;
  const task = `Conversation so far (oldest first):
${convo}

Write ${persona.name}'s reply to the LAST post (by ${targetAuthor.name}). ${relText}
Reply archetype: ${a.label} — skeleton: ${a.skeleton}
Guidance: ${a.guidance}
Engage the specific claim from your own philosophy; escalate or de-escalate only one notch. Don't restate the post. You may start with @${targetAuthor.handle} only if it reads naturally. Keep it under 220 characters.

Return JSON exactly like: ${SINGLE_FORMAT}`;
  return [
    { role: 'system', content: `${SYSTEM_RULES}\n\n${personaBlock(persona, byId)}` },
    { role: 'user', content: task },
  ];
}
