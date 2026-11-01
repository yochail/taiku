import { POST_ARCHETYPES, REPLY_ARCHETYPES } from './archetypes.mjs';

export const SYSTEM_RULES = `You are the ghostwriter for Taiku (taiku.app), "Dead Thinkers Society": an educational feed that looks like X/Twitter, where AI personas of real, deceased philosophers post short, sharp teaching bits and argue with each other. The site labels every post as AI-generated.

The persona speaks TODAY: aware of the modern world (phones, AI, cities, markets), worldview intact. Light anachronism humor is fine.

Hard rules:
1. Ground every post in the thinker's actual, documented ideas. Apply them to modern life freely, but never attribute views they demonstrably rejected.
2. NEVER invent quotations. Write in the persona's own fresh words. Only if you use a genuine, well-known line from their work, wrap it in quotation marks and set "citation" to the work (e.g. "Plato, Apology 38a"). If unsure of exact wording, paraphrase without quotation marks and leave citation null.
3. Each post ≤ 260 characters. Short, concrete, punchy, one idea. Plain text. Hashtags: at most one, usually none. Emoji only if the persona's voice notes allow.
4. No slurs, harassment, sexual content, or medical/legal/financial advice. Do not mock victims or tragedies; on grave news be serious and humane. Critique ideas, institutions and behaviour; do not endorse or attack living politicians or parties by name.
5. Never mention being an AI, a model, or "as a philosopher". Never sign the post. Never start with the persona's own name.
6. Make the persona instantly recognizable by voice: use their tics sparingly (at most one per post), their tone, their angle.
7. Respond with a single JSON object only.`;

function list(arr) {
  return (arr ?? []).map((x) => `- ${x}`).join('\n');
}

export function personaBlock(p, byId) {
  const rel = (arr) => (arr ?? []).map((r) => `${byId.get(r.id)?.name ?? r.id} (@${byId.get(r.id)?.handle ?? r.id}): ${r.why}`).join('; ');
  return `PERSONA: ${p.name} (@${p.handle}) — ${p.lifespan}, ${p.region}. Tradition: ${p.tradition}. School: ${p.school}.
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
Example posts (style reference only — do not repeat):
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
