// Post & reply archetypes, distilled from research on X/Twitter conventions.
// Shared vocabulary between the generator prompts, the data model (`type`) and the renderer.

export const POST_ARCHETYPES = {
  aphorism: {
    label: 'Aphorism',
    vibe: 'calm',
    skeleton: '[A single claim with a twist].',
    guidance: 'One or two sentences, quotable, no elaboration, no hashtags. Original wording in the persona\'s voice — not a famous quote.',
  },
  hot_take: {
    label: 'Hot take',
    vibe: 'spicy',
    skeleton: '[Contrarian claim about today\'s world, stated flatly]. [Optional one-line why].',
    guidance: 'Bold, unhedged, provocative but grounded in the thinker\'s real position. Invite disagreement.',
  },
  teaching: {
    label: 'Lesson',
    vibe: 'smart',
    skeleton: '[Concept in plain words]. [Concrete modern example]. [Takeaway].',
    guidance: 'Teach ONE core idea of the thinker in plain modern language, with an everyday example. Name the concept.',
  },
  thread: {
    label: 'Thread',
    vibe: 'smart',
    skeleton: '[Hook] 🧵 1/n → 2/n [concept] → 3/n [example] → n/n [takeaway + question]',
    guidance: 'A self-thread of 2–4 parts — only when one taik really cannot hold it. Each part ≤ 280 chars and makes sense alone. Part 1 is the hook and ends with "🧵". Number parts like "2/4".',
  },
  listicle: {
    label: 'List',
    vibe: 'smart',
    skeleton: '[N] [things] about [topic]:\n1) …\n2) …\n3) …',
    guidance: '3–4 crisp numbered items on separate lines. Each item a few words.',
  },
  reminder: {
    label: 'Reminder',
    vibe: 'calm',
    skeleton: 'This is your reminder that [timeless truth, made concrete].',
    guidance: 'A gentle, didactic nudge. Warm or stern depending on persona.',
  },
  question: {
    label: 'Question',
    vibe: 'smart',
    skeleton: '[Provocative philosophical question]?',
    guidance: 'Ask the feed one sharp question that exposes a hidden assumption. Optionally a short setup line first.',
  },
  news_take: {
    label: 'News take',
    vibe: 'spicy',
    skeleton: '[Reference to the headline] — [persona\'s lens on it].',
    guidance: 'React to the supplied real headline through the thinker\'s core ideas. Be serious about suffering; critique ideas and institutions, not victims. Do not invent facts beyond the headline.',
  },
  unpopular_opinion: {
    label: 'Unpopular opinion',
    vibe: 'spicy',
    skeleton: 'Unpopular opinion: [claim].',
    guidance: 'Start with "Unpopular opinion:". A view the persona really held that cuts against today\'s common sense.',
  },
  meme: {
    label: 'Meme',
    vibe: 'funny',
    skeleton: 'nobody:\nabsolutely nobody:\nme: [persona-specific punchline]  — or —  How it started: … / How it\'s going: …',
    guidance: 'Plain-text meme format adapted to the thinker\'s ideas. The punchline must only make sense if you know the thinker — that is the whole point.',
  },
  news_wire: {
    label: 'News',
    skeleton: '[Real headline]\n\n[One neutral sentence of context.]',
    guidance: 'News-wire accounts only (kind=news): the real headline, then ONE neutral, factual summary line built only from the headline. No opinion, no jokes, no emoji, no invented facts. The source link is attached as a news card.',
    vibe: 'calm',
  },
  quote_post: {
    label: 'Quote post',
    vibe: 'smart',
    skeleton: '[Agreement or disagreement with the quoted post] — [reasoning]',
    guidance: 'Comment on another thinker\'s post (quoted). Stand-alone readable. Address the idea, sharp but fair.',
  },
  shitpost: {
    label: 'Shitpost',
    skeleton: '[absurd low-effort-looking line that is secretly the whole philosophy]',
    guidance: 'Chaotic, unserious-looking, often lowercase, zero setup. The joke only works if you know the thinker. No explaining the joke.',
    vibe: 'funny',
  },
  copypasta: {
    label: 'Pasta',
    skeleton: 'A famous internet copypasta/meme skeleton ("I\'m not saying X but I\'m not NOT saying X", "I am once again asking…", "they don\'t want you to know this but…", "Sir, this is a Wendy\'s", "It\'s [year] and people still…", "What did you just say about X, you little…") rewritten in the persona\'s doctrine.',
    guidance: 'Recognizable pasta rhythm, the persona\'s content. Keep it clean (no slurs, no real-person harassment). Under 280 chars — pastas are usually long, so compress.',
    vibe: 'funny',
  },
  poll: {
    label: 'Poll',
    skeleton: '[be honest / quick poll:] [question]\n\n○ [option]\n○ [option]\n○ [option]\n○ [joke option]',
    guidance: 'A text poll: one-line question, then 3–4 options each on its own line starting with "○". The last option is usually a joke ("see results", "I\'m in a jar").',
    vibe: 'funny',
  },
  subtweet: {
    label: 'Subtweet',
    skeleton: 'some of you [behavior] and it shows. / Funny how certain people [X]… anyway.',
    guidance: 'Allude to a rival (or a news figure\'s behaviour) WITHOUT naming or @-ing them. Passive-aggressive, legible to insiders.',
    vibe: 'spicy',
  },
  pov: {
    label: 'POV',
    skeleton: 'POV: [situation] / me when [situation] / the way that [X] / not [X] being [Y] / it\'s giving [X]',
    guidance: 'A relatable-meme framing (POV:, me when…, the way that…, not X being Y, it\'s giving…). Short, scene-setting, punchline at the end.',
    vibe: 'funny',
  },
  hear_me_out: {
    label: 'Hear me out',
    skeleton: 'hear me out: [wild-sounding claim that turns out to be the thinker\'s real position] / be honest: [loaded question]',
    guidance: 'Opens with "hear me out", "be honest" or "genuinely asking". Sounds unhinged, is actually doctrine.',
    vibe: 'spicy',
  },
  quote_take: {
    label: 'Quote',
    skeleton: '[Your take on the quoted taik — agree, add, or twist]',
    guidance: 'Quote-taik with your own take. Must stand alone above the quoted post. Do not restate the quoted post.',
    vibe: 'smart',
  },
  quote_dunk: {
    label: 'Quote dunk',
    skeleton: '[terse mocking line] — e.g. imagine posting this / this you? / the [X] to [Y] pipeline is real / he\'s so close',
    guidance: 'Quote-dunk: a short public dunk on the IDEA in the quoted taik (never identity). Funny first, but the jab must carry a real philosophical point.',
    vibe: 'spicy',
  },
};

/** Reaction-GIF keys for media {kind:"gif", render:{template:"reaction", reaction, caption}}. */
export const REACTIONS = ['slow-clap', 'mind-blown', 'side-eye', 'facepalm', 'popcorn', 'this-is-fine', 'shrug', 'nodding', 'laughing', 'crying-laughing'];
/** Meme templates for media {kind:"meme", render:{template:"meme", format, lines[]}}; value = number of lines. */
export const MEME_FORMATS = { drake: 2, distracted: 3, 'two-buttons': 2, 'expanding-brain': 4, 'top-bottom': 2, 'this-is-fine': 1, galaxy: 4 };
export const CHART_TYPES = ['bar', 'line', 'pie'];

export const REPLY_ARCHETYPES = {
  agree_extend: {
    label: 'Agree + extend',
    vibe: 'calm',
    skeleton: 'Yes — and [additional point from your own philosophy].',
    guidance: 'Affirm, then add something only YOU would add.',
    relation: 'ally',
  },
  steelman_rebut: {
    label: 'Steelman',
    vibe: 'smart',
    skeleton: 'The strongest version of your view is [X]. But [counter].',
    guidance: 'State their view charitably in one clause, then rebut from your philosophy.',
    relation: 'rival',
  },
  counterexample: {
    label: 'Counterexample',
    vibe: 'smart',
    skeleton: '[One specific case that breaks the general claim].',
    guidance: 'A single vivid concrete case that the claim cannot handle.',
    relation: 'rival',
  },
  dunk: {
    label: 'Dunk',
    vibe: 'spicy',
    skeleton: '[Terse, cutting line].',
    guidance: 'One short witty jab at the idea (never at identity). Must contain a real philosophical point.',
    relation: 'rival',
  },
  source_challenge: {
    label: 'Challenge',
    vibe: 'spicy',
    skeleton: 'By what method do you know that?',
    guidance: 'A skeptical demand for justification, specific to the claim.',
    relation: 'rival',
  },
  context_note: {
    label: 'Context',
    vibe: 'smart',
    skeleton: 'Context: [neutral clarification or correction].',
    guidance: 'Start with "Context:". A calm, factual clarification about the idea or the history of the idea.',
    relation: 'any',
  },
  joke: {
    label: 'Joke',
    vibe: 'funny',
    skeleton: '[Short quip].',
    guidance: 'A quip in character. Brief. Still recognizably about the topic.',
    relation: 'any',
  },
  question_back: {
    label: 'Question',
    vibe: 'smart',
    skeleton: '[A pointed question that exposes an assumption]?',
    guidance: 'Answer with a question that forces the other to clarify or contradict themselves.',
    relation: 'any',
  },
  concession: {
    label: 'Concession',
    vibe: 'calm',
    skeleton: 'Fair. [What you concede]. But [what you keep].',
    guidance: 'Concede a real point gracefully, then hold one line. De-escalates the thread.',
    relation: 'any',
  },
  thread_hijack: {
    label: 'Tangent',
    vibe: 'funny',
    skeleton: 'This is really about [your pet topic]. [Why].',
    guidance: 'Redirect the debate to your own obsession, in a way that is funny and illuminating.',
    relation: 'any',
  },
  ratio: {
    label: 'Ratio',
    skeleton: 'ratio + [one-line counter-take] / L + ratio + [your doctrine as an insult]',
    guidance: 'The "ratio" meme: open or close with "ratio" / "L + ratio" and add one sharp, philosophically correct counter-point.',
    relation: 'rival',
    vibe: 'spicy',
  },
  this_you: {
    label: 'This you?',
    skeleton: 'this you? [pointer to their own known doctrine/book that contradicts the post]',
    guidance: '"this you?" call-out: point to something the author really wrote/held (name the work, no invented quotes) that undercuts their post.',
    relation: 'rival',
    vibe: 'spicy',
  },
  emoji_reply: {
    label: 'Reaction',
    skeleton: '💀 / 😭😭 / 👀 / 🔥🔥 / 🤡',
    guidance: 'Emoji-only (or emoji + 1–3 words) reaction.',
    relation: 'any',
    vibe: 'funny',
  },
  well_actually: {
    label: 'Well, actually',
    skeleton: 'well actually, [pedantic but correct distinction]',
    guidance: 'Pedantic correction of a detail, delivered with total confidence. Smug, short.',
    relation: 'any',
    vibe: 'smart',
  },
  clapback: {
    label: 'Clapback',
    skeleton: '[quick comeback that flips their jab back on them]',
    guidance: 'You are replying to someone who replied to YOUR taik. Clap back: short, confident, funnier than their reply, still about the idea.',
    relation: 'any',
    vibe: 'spicy',
  },
  hype: {
    label: 'Hype',
    skeleton: 'W take / real / say it louder 🔥 / this. [+ one line only you would add]',
    guidance: 'Ally hype reply: one hype opener in your own register, plus a tiny addition from your own philosophy.',
    relation: 'ally',
    vibe: 'funny',
  },
  reply_guy: {
    label: 'Reply guy',
    skeleton: 'actually you should try [your pet practice]. works every time.',
    guidance: 'Unsolicited, overly familiar advice that pushes your own philosophy onto the post. Self-aware reply-guy energy.',
    relation: 'any',
    vibe: 'funny',
  },
};

// Plain retaik row ({retaikOf, text: ''}): a repost shown in the feed with a "↻ X retaiked" header. No LLM.
export const RETAIK_TYPE = { retaik: { label: 'Retaik', guide: 'Plain repost of another taik; no text.' } };
export const ALL_TYPES = { ...POST_ARCHETYPES, ...REPLY_ARCHETYPES, ...RETAIK_TYPE };

export function typeLabel(type) {
  return ALL_TYPES[type]?.label ?? 'Post';
}
