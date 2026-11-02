// Back-and-forth conversations (spec.sampling.conversation): A↔B reply chains, a third persona
// joining, and the "move" a reply makes (rebuttal, concession, sharp question, example, …).
// Generic defaults apply to any site whose spec has no conversation block.
import { weightedPick } from './pipeline-util.mjs';

export const DEFAULT_CONVERSATION = {
  continue_probability: 0.6,
  continue_decay: 0.7,
  max_turns: 4,
  relation_boost: { rival: 1.3, frenemy: 1.25, ally: 1, follows: 0.85, none: 0.7 },
  third_party_join: 0.18,
  third_party_relation_weight: { rival: 3, frenemy: 2.5, ally: 2 },
  moves: { rebuttal: 0.26, disagree: 0.13, concede_pivot: 0.14, sharp_question: 0.17, example: 0.15, extend: 0.09, joke: 0.06 },
  relation_moves: {
    ally: { extend: 2.5, concede_pivot: 1.4, disagree: 0.4, rebuttal: 0.7 },
    rival: { rebuttal: 1.3, disagree: 1.6, extend: 0.15 },
    frenemy: { rebuttal: 1.2, disagree: 1.3, extend: 0.4 },
  },
  late_turn_moves: { concede_pivot: 1.8, sharp_question: 1.3, joke: 1.3, extend: 0.6 },
};

/** Reply archetypes (archetypes.mjs) that realise each move. */
export const MOVE_ARCHETYPES = {
  rebuttal: ['steelman_rebut', 'source_challenge', 'well_actually'],
  disagree: ['dunk', 'ratio', 'this_you', 'clapback'],
  concede_pivot: ['concession'],
  sharp_question: ['question_back'],
  example: ['counterexample', 'context_note'],
  extend: ['agree_extend', 'hype'],
  joke: ['joke', 'thread_hijack', 'reply_guy'],
};

export const MOVE_HINT = {
  rebuttal: 'disagree and give one concrete reason (an argument, not a vibe)',
  disagree: 'push back, short and sharp, and still name what is wrong',
  concede_pivot: 'concede one real point, then pivot to what they are missing',
  sharp_question: 'ask one sharp question that exposes an assumption in their post',
  example: 'bring one concrete example or case that tests the claim',
  extend: 'agree only by adding something new they did not say',
  joke: 'land a joke that still makes a point about the idea',
};

export const NO_FILLER = 'no empty agreement or filler ("great point", "so true", "this", "well said"); make a move the thread can answer';

export function conversationOf(spec) {
  const c = spec?.sampling?.conversation ?? {};
  return { ...DEFAULT_CONVERSATION, ...c, relation_boost: { ...DEFAULT_CONVERSATION.relation_boost, ...(c.relation_boost ?? {}) } };
}

/**
 * Turn number of a reply by `authorId` to `parent` in an A↔B exchange: 1 for a first reply, n+1
 * when answering the person who just replied to you (parent is a reply aimed at authorId).
 */
export function turnOf(parent, authorId) {
  if (!parent || parent.role !== 'reply' || parent.authorId === authorId) return 1;
  return parent.pairAuthor === authorId ? (parent.turn ?? 1) + 1 : 1;
}

/** Probability that the replied-to persona answers back (continuing the exchange). */
export function continueProbability(conv, turn, rel) {
  if (!(turn >= 1) || turn >= conv.max_turns) return 0;
  return Math.min(0.95, conv.continue_probability * conv.continue_decay ** (turn - 1) * (conv.relation_boost[rel ?? 'none'] ?? conv.relation_boost.none ?? 1));
}

/** Sample the reply move, tilted by relation and by how deep into the exchange we are. */
export function pickMove(rand, conv, rel = null, turn = 1) {
  const r = conv.relation_moves?.[rel] ?? {};
  const late = turn >= 2 ? conv.late_turn_moves ?? {} : {};
  return weightedPick(rand, Object.entries(conv.moves).map(([m, w]) => [m, w * (r[m] ?? 1) * (late[m] ?? 1)])) ?? 'rebuttal';
}
