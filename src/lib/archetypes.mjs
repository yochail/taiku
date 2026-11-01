// Post & reply archetypes, distilled from research on X/Twitter conventions.
// Shared vocabulary between the generator prompts, the data model (`type`) and the renderer.

export const POST_ARCHETYPES = {
  aphorism: {
    label: 'Aphorism',
    skeleton: '[A single claim with a twist].',
    guidance: 'One or two sentences, quotable, no elaboration, no hashtags. Original wording in the persona\'s voice — not a famous quote.',
  },
  hot_take: {
    label: 'Hot take',
    skeleton: '[Contrarian claim about today\'s world, stated flatly]. [Optional one-line why].',
    guidance: 'Bold, unhedged, provocative but grounded in the thinker\'s real position. Invite disagreement.',
  },
  teaching: {
    label: 'Lesson',
    skeleton: '[Concept in plain words]. [Concrete modern example]. [Takeaway].',
    guidance: 'Teach ONE core idea of the thinker in plain modern language, with an everyday example. Name the concept.',
  },
  thread: {
    label: 'Thread',
    skeleton: '[Hook] 🧵 1/n → 2/n [concept] → 3/n [example] → n/n [takeaway + question]',
    guidance: 'An explainer thread of 3–5 parts. Each part ≤ 280 chars and makes sense alone. Part 1 is the hook and ends with "🧵". Number parts like "2/4".',
  },
  listicle: {
    label: 'List',
    skeleton: '[N] [things] about [topic]:\n1) …\n2) …\n3) …',
    guidance: '3–4 crisp numbered items on separate lines. Each item a few words.',
  },
  reminder: {
    label: 'Reminder',
    skeleton: 'This is your reminder that [timeless truth, made concrete].',
    guidance: 'A gentle, didactic nudge. Warm or stern depending on persona.',
  },
  question: {
    label: 'Question',
    skeleton: '[Provocative philosophical question]?',
    guidance: 'Ask the feed one sharp question that exposes a hidden assumption. Optionally a short setup line first.',
  },
  news_take: {
    label: 'News take',
    skeleton: '[Reference to the headline] — [persona\'s lens on it].',
    guidance: 'React to the supplied real headline through the thinker\'s core ideas. Be serious about suffering; critique ideas and institutions, not victims. Do not invent facts beyond the headline.',
  },
  unpopular_opinion: {
    label: 'Unpopular opinion',
    skeleton: 'Unpopular opinion: [claim].',
    guidance: 'Start with "Unpopular opinion:". A view the persona really held that cuts against today\'s common sense.',
  },
  meme: {
    label: 'Meme',
    skeleton: 'nobody:\nabsolutely nobody:\nme: [persona-specific punchline]  — or —  How it started: … / How it\'s going: …',
    guidance: 'Plain-text meme format adapted to the thinker\'s ideas. Must still teach something.',
  },
  quote_post: {
    label: 'Quote post',
    skeleton: '[Agreement or disagreement with the quoted post] — [reasoning]',
    guidance: 'Comment on another thinker\'s post (quoted). Stand-alone readable. Address the idea, sharp but fair.',
  },
};

export const REPLY_ARCHETYPES = {
  agree_extend: {
    label: 'Agree + extend',
    skeleton: 'Yes — and [additional point from your own philosophy].',
    guidance: 'Affirm, then add something only YOU would add.',
    relation: 'ally',
  },
  steelman_rebut: {
    label: 'Steelman',
    skeleton: 'The strongest version of your view is [X]. But [counter].',
    guidance: 'State their view charitably in one clause, then rebut from your philosophy.',
    relation: 'rival',
  },
  counterexample: {
    label: 'Counterexample',
    skeleton: '[One specific case that breaks the general claim].',
    guidance: 'A single vivid concrete case that the claim cannot handle.',
    relation: 'rival',
  },
  dunk: {
    label: 'Dunk',
    skeleton: '[Terse, cutting line].',
    guidance: 'One short witty jab at the idea (never at identity). Must contain a real philosophical point.',
    relation: 'rival',
  },
  source_challenge: {
    label: 'Challenge',
    skeleton: 'By what method do you know that?',
    guidance: 'A skeptical demand for justification, specific to the claim.',
    relation: 'rival',
  },
  context_note: {
    label: 'Context',
    skeleton: 'Context: [neutral clarification or correction].',
    guidance: 'Start with "Context:". A calm, factual clarification about the idea or the history of the idea.',
    relation: 'any',
  },
  joke: {
    label: 'Joke',
    skeleton: '[Short quip].',
    guidance: 'A quip in character. Brief. Still recognizably about the topic.',
    relation: 'any',
  },
  question_back: {
    label: 'Question',
    skeleton: '[A pointed question that exposes an assumption]?',
    guidance: 'Answer with a question that forces the other to clarify or contradict themselves.',
    relation: 'any',
  },
  concession: {
    label: 'Concession',
    skeleton: 'Fair. [What you concede]. But [what you keep].',
    guidance: 'Concede a real point gracefully, then hold one line. De-escalates the thread.',
    relation: 'any',
  },
  thread_hijack: {
    label: 'Tangent',
    skeleton: 'This is really about [your pet topic]. [Why].',
    guidance: 'Redirect the debate to your own obsession, in a way that is funny and illuminating.',
    relation: 'any',
  },
};

export const ALL_TYPES = { ...POST_ARCHETYPES, ...REPLY_ARCHETYPES };

export function typeLabel(type) {
  return ALL_TYPES[type]?.label ?? 'Post';
}
