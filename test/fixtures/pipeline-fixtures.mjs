// Shared fixtures for the pipeline tests: fake news / parody personas (cloned in code, never in
// personas/) and synthetic persona sets of arbitrary size.
import { TOPIC_KEYS, loadPersonas } from '../../src/lib/data.mjs';
import { seededRng } from '../../src/lib/pipeline-util.mjs';

export const realPersonas = () => loadPersonas();

/** Clone a real persona into a fake one (persona-level validation errors are tolerated by the pipeline). */
export function fakePersona(base, over) {
  const p = structuredClone(base);
  return { ...p, allies: [], rivals: [], frenemies: [], ...over };
}

export function newsPersona(base, id = 'agora_wire') {
  return fakePersona(base, {
    id,
    handle: id,
    name: 'Agora Daily',
    kind: 'news',
    system_prompt: ['You are Agora Daily, a neutral wire account. Post the headline and one neutral line. No opinions.'],
    quotables: [],
    quote_bank: [],
    native_language: undefined,
    reactivity: 1,
    popularity: 7,
  });
}

export function parodyPersona(base, id = 'zenos_arrow') {
  return fakePersona(base, {
    id,
    handle: id,
    name: "Zeno's Arrow",
    kind: 'parody',
    system_prompt: ["You are Zeno's Arrow, a parody account that never quite arrives anywhere. Short, absurd, meme-literate."],
    reactivity: 5,
    popularity: 6,
    modernity: 5,
  });
}

/** n synthetic personas with random affinities, relations and behaviour (for react.mjs scale tests). */
export function syntheticPersonas(n, seed = 'synthetic') {
  const rand = seededRng('personas', seed);
  const ids = Array.from({ length: n }, (_, i) => `synth_${String(i).padStart(3, '0')}`);
  return ids.map((id, i) => {
    const pick = (k) => Array.from({ length: k }, () => ids[Math.floor(rand() * n)]).filter((x) => x !== id).map((x) => ({ id: x, why: 'synthetic' }));
    return {
      id,
      handle: `h_${id}`,
      name: id,
      kind: i % 20 === 19 ? 'parody' : 'thinker',
      reactivity: 1 + Math.floor(rand() * 5),
      popularity: 1 + Math.floor(rand() * 10),
      modernity: 1 + Math.floor(rand() * 5),
      topic_affinity: Object.fromEntries(TOPIC_KEYS.map((k) => [k, Math.round(rand() * 5)])),
      x_behavior: { activity: 0.2 + rand() * 0.7, reply_rate: 0.2 + rand() * 0.5, like_rate: 0.3 + rand() * 0.5, repost_rate: 0.05 + rand() * 0.2, quote_rate: 0.05 + rand() * 0.2 },
      x_profile: { followers: Math.round(1e3 * 10 ** (rand() * 3)) },
      rivals: pick(2),
      allies: pick(2),
      frenemies: pick(1),
    };
  });
}
