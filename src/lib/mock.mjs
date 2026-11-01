// Offline provider: builds plausible, clearly-marked placeholder posts from persona
// profiles so the whole pipeline can run without an API key.
import { rng, pick } from './util.mjs';

function clip(s, n = 250) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

export function createMockProvider(seed = 'taiku') {
  const rand = rng(seed);
  return {
    name: 'mock',
    async complete(_messages, meta) {
      const { persona: p, archetype, target, targetAuthor, news } = meta;
      const idea = pick(rand, p.core_ideas);
      const tic = pick(rand, p.voice.tics);
      const topic = pick(rand, p.favorite_topics);
      const tags = [topic.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '')].filter(Boolean);
      if (meta.kind === 'reply') {
        const lead = {
          agree_extend: 'Yes — and',
          steelman_rebut: `The strongest version of your view is fair. But`,
          counterexample: 'Counterexample:',
          dunk: 'Bold of you.',
          source_challenge: 'By what method do you know that?',
          context_note: 'Context:',
          joke: '😏',
          question_back: 'And who decides that?',
          concession: 'Fair. But',
          thread_hijack: `This is really about ${topic}.`,
        }[archetype] ?? '';
        return JSON.stringify({ text: clip(`[mock] @${targetAuthor.handle} ${lead} ${tic} ${idea}`, 220), tags, citation: null });
      }
      if (archetype === 'thread') {
        const ideas = p.core_ideas.slice(0, 3);
        return JSON.stringify({
          parts: [
            clip(`[mock] ${tic} Let me explain ${topic}. 🧵 1/${ideas.length + 1}`),
            ...ideas.map((x, i) => clip(`${i + 2}/${ideas.length + 1} ${x}`)),
          ],
          tags,
          citation: null,
        });
      }
      if (archetype === 'news_take' && news) {
        return JSON.stringify({ text: clip(`[mock] "${news.title}" — ${tic} ${idea}`), tags, citation: null });
      }
      if (archetype === 'quote_post' && target) {
        return JSON.stringify({ text: clip(`[mock] ${tic} Not quite. ${idea}`), tags, citation: null });
      }
      return JSON.stringify({ text: clip(`[mock] ${tic} ${idea}`), tags, citation: null });
    },
  };
}
