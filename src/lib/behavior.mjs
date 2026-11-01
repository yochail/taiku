// X-behaviour profiles: how each persona behaves *as an X user* (how often they post, reply,
// like, quote-dunk, repost; meme/shitpost level; casing/emoji habits; time zone; beats).
// The source of truth is the `x_behavior` key in personas/<id>.json; DEFAULT_X_BEHAVIOR is the
// seed for that key (scripts/sync-x-behavior.mjs writes it) and the fallback if a file lacks it.
import { THEME_KEYS } from './themes.mjs';
import { POST_ARCHETYPES, REPLY_ARCHETYPES, ALL_TYPES } from './archetypes.mjs';

const RATE_KEYS = [
  'activity', 'reply_rate', 'like_rate', 'quote_rate', 'repost_rate',
  'dunk_tendency', 'meme_affinity', 'thread_tendency', 'shitpost_level', 'clapback_rate', 'emoji_use', 'caps_use',
];
export const CASINGS = ['lowercase', 'standard', 'caps'];
export const LIKE_VIBES = ['calm', 'spicy', 'funny', 'smart'];

/** Neutral profile; every field documented in README ("Engagement model"). */
export const GENERIC_X_BEHAVIOR = {
  vibe: 'regular poster',
  activity: 0.5,
  reply_rate: 0.3,
  like_rate: 0.35,
  quote_rate: 0.15,
  repost_rate: 0.15,
  dunk_tendency: 0.3,
  meme_affinity: 0.3,
  thread_tendency: 0.2,
  shitpost_level: 0.2,
  clapback_rate: 0.4,
  casing: 'standard',
  emoji_use: 0.2,
  caps_use: 0.05,
  emoji: ['👀'],
  utc_offset: 0,
  active_hours: [8, 23],
  likes_vibe: 'smart',
  formats: [],
  slang: [],
  beats: [],
};

const B = (vibe, activity, reply, like, quote, repost, dunk, meme, thread, shit, clap, casing, emojiUse, capsUse, emoji, utc, hours, likes, formats, slang, beats) => ({
  vibe, activity, reply_rate: reply, like_rate: like, quote_rate: quote, repost_rate: repost, dunk_tendency: dunk, meme_affinity: meme,
  thread_tendency: thread, shitpost_level: shit, clapback_rate: clap, casing, emoji_use: emojiUse, caps_use: capsUse, emoji,
  utc_offset: utc, active_hours: hours, likes_vibe: likes, formats, slang, beats,
});

//                     vibe, act, reply, like, quote, repost, dunk, meme, thread, shit, clap, casing, emoji, caps
export const DEFAULT_X_BEHAVIOR = {
  diogenes: B('chaotic reply-guy shitposter: dunks on anyone respectable, lives in the replies, never threads', 0.9, 0.6, 0.15, 0.35, 0.05, 0.95, 0.9, 0, 1, 0.85, 'lowercase', 0.5, 0.3,
    ['🏮', '💀', '🐕', '🤡'], 2, [11, 4], 'funny', ['shitpost', 'pov', 'copypasta', 'quote_dunk', 'ratio', 'emoji_reply', 'this_you'], ['touch grass', 'L + ratio', 'this you?', 'sir, this is a jar', 'be so for real'], ['status', 'economy', 'tech', 'culture', 'food', 'cities', 'wellness']),
  kant: B('rare, punctual, long-winded: posts at the same hour, prefers threads, zero memes, earnest quote-takes', 0.35, 0.12, 0.2, 0.12, 0.04, 0.25, 0.02, 0.85, 0, 0.3, 'standard', 0.02, 0,
    ['🕞'], 1, [5, 22], 'smart', ['thread', 'listicle', 'quote_take', 'well_actually'], ['Maxim check:', 'Universalize it.'], ['law', 'rights', 'politics', 'ai', 'war', 'education', 'science']),
  marcus_aurelius: B('posts a calm note-to-self at dawn; almost never replies; likes calm, disciplined posts; ignores drama', 0.4, 0.05, 0.45, 0.03, 0.15, 0.02, 0.02, 0.15, 0, 0.05, 'standard', 0, 0,
    ['🌅'], 1, [4, 21], 'calm', ['reminder', 'aphorism'], ['Note to self:', 'Back to work.'], ['politics', 'death', 'wellness', 'status', 'war', 'health']),
  nietzsche: B('quote-dunk machine: CAPS hammer, em-dashes, subtweets Socrates and Kant, fights everyone', 0.8, 0.35, 0.12, 0.7, 0.1, 0.85, 0.4, 0.2, 0.55, 0.6, 'caps', 0.15, 0.45,
    ['🔨', '⚡', '🦅'], 1, [10, 3], 'spicy', ['quote_dunk', 'subtweet', 'hot_take', 'ratio', 'aphorism'], ['ratio', 'cope', 'it\'s giving ressentiment', 'weak behaviour'], ['religion', 'culture', 'wellness', 'status', 'media', 'politics']),
  socrates: B('the ultimate reply guy: "genuinely asking" questions under everyone\'s posts, runs polls, never concludes', 0.85, 0.75, 0.3, 0.25, 0.1, 0.4, 0.35, 0.1, 0.3, 0.9, 'standard', 0.2, 0.05,
    ['🤔', '🏛️', '🍷'], 2, [9, 2], 'smart', ['poll', 'question', 'quote_take', 'question_back', 'reply_guy'], ['genuinely asking', 'asking for a friend', 'define it', 'source?'], ['politics', 'education', 'ai', 'media', 'law', 'love']),
  aristotle: B('well-actually guy: classifies everything into three kinds, drops threads and corrections', 0.6, 0.45, 0.25, 0.2, 0.1, 0.3, 0.1, 0.55, 0.05, 0.5, 'standard', 0.05, 0,
    ['📚'], 2, [7, 23], 'smart', ['listicle', 'thread', 'well_actually', 'context_note'], ['three kinds, actually', 'as I said in the Ethics'], ['science', 'politics', 'sports', 'economy', 'education', 'love']),
  confucius: B('elder-statesman account: reposts students and allies, gently scolds bad manners and wrong names', 0.5, 0.25, 0.4, 0.1, 0.3, 0.15, 0.05, 0.2, 0.02, 0.3, 'standard', 0.05, 0,
    ['🍵'], 8, [5, 21], 'calm', ['listicle', 'reminder', 'context_note'], ['the exemplary person…', 'begin with yourself'], ['politics', 'education', 'love', 'culture', 'media']),
  laozi: B('rare, cryptic lowercase one-liners at random hours; never argues, occasionally drops a single emoji', 0.3, 0.1, 0.2, 0.05, 0.1, 0.1, 0.3, 0, 0.4, 0.05, 'lowercase', 0.1, 0,
    ['🌊', '🍃'], 8, [0, 24], 'calm', ['aphorism', 'shitpost', 'emoji_reply'], ['do less', 'be like water'], ['politics', 'war', 'climate', 'wellness', 'tech']),
  zhuangzi: B('absurdist lowercase shitposter: butterfly memes, fish facts, teases Confucius relentlessly', 0.7, 0.45, 0.35, 0.3, 0.25, 0.35, 0.85, 0, 0.9, 0.4, 'lowercase', 0.55, 0,
    ['🦋', '🐟', '🐢'], 8, [10, 4], 'funny', ['shitpost', 'meme', 'pov', 'copypasta', 'emoji_reply'], ['who\'s to say', 'no thoughts just butterfly', 'it\'s giving useless tree'], ['science', 'death', 'culture', 'wellness', 'ai', 'food']),
  epicurus: B('chill garden poster: cozy lowercase, likes everything friendly, 🧀 energy, avoids fights', 0.55, 0.3, 0.65, 0.1, 0.3, 0.1, 0.5, 0.05, 0.4, 0.3, 'lowercase', 0.7, 0,
    ['🧀', '🍞', '🌿', '😌'], 2, [9, 22], 'funny', ['pov', 'reminder', 'meme', 'hype'], ['pass the bread', 'touch grass (literally, it\'s nice)', 'friendship > everything'], ['food', 'wellness', 'death', 'economy', 'science', 'love']),
  hume: B('affable skeptic: "source?" replies, self-deprecating jokes, backgammon breaks, polls about causation', 0.7, 0.45, 0.5, 0.25, 0.2, 0.4, 0.55, 0.1, 0.55, 0.55, 'standard', 0.35, 0,
    ['🎲', '🥃', '😅'], 0, [10, 2], 'funny', ['hot_take', 'poll', 'meme', 'quote_take', 'source_challenge'], ['source?', 'big if true', 'correlation isn\'t causation, mate'], ['science', 'religion', 'economy', 'ai', 'health', 'media']),
  descartes: B('methodical late riser: posts after noon from bed, "let us suppose" polls, step-by-step threads', 0.45, 0.3, 0.2, 0.2, 0.05, 0.3, 0.25, 0.5, 0.2, 0.45, 'standard', 0.1, 0,
    ['🤔', '🛌'], 1, [11, 3], 'smart', ['thread', 'poll', 'well_actually', 'hear_me_out'], ['let us suppose', 'clearly and distinctly'], ['ai', 'science', 'tech', 'health', 'media']),
  spinoza: B('calm lens-grinder: Prop./Q.E.D. posts, likes generously, rarely fights, never raises his voice', 0.35, 0.15, 0.45, 0.1, 0.2, 0.1, 0.1, 0.5, 0.1, 0.2, 'standard', 0.05, 0,
    ['🔍'], 1, [8, 23], 'calm', ['thread', 'listicle', 'aphorism'], ['Q.E.D.', 'not to laugh, not to weep'], ['religion', 'science', 'politics', 'wellness', 'climate']),
  william_james: B('friendly psych-prof poster: anecdotes, "what\'s the cash value?", hypes his allies', 0.65, 0.5, 0.55, 0.2, 0.3, 0.2, 0.45, 0.2, 0.35, 0.5, 'standard', 0.4, 0,
    ['🐿️', '☕', '🧠'], -5, [7, 23], 'funny', ['poll', 'hear_me_out', 'hype', 'quote_take'], ['what\'s the cash value?', 'hear me out'], ['wellness', 'science', 'religion', 'education', 'health']),
  wollstonecraft: B('sharp-tongued: quote-dunks patronising men, "this you?" receipts, subtweets Rousseau-types', 0.7, 0.55, 0.4, 0.45, 0.35, 0.7, 0.35, 0.25, 0.3, 0.75, 'standard', 0.3, 0.2,
    ['🙄', '📚', '✊'], 0, [8, 1], 'spicy', ['quote_dunk', 'this_you', 'subtweet', 'hot_take'], ['rational creatures, sir', 'this you?', 'imagine'], ['rights', 'education', 'love', 'politics', 'culture']),
  beauvoir: B('café-terrace critic: wry quote-takes, POV memes about the Other, never lets a sloppy take slide', 0.6, 0.4, 0.35, 0.4, 0.25, 0.55, 0.3, 0.3, 0.25, 0.55, 'standard', 0.25, 0,
    ['☕', '🥐', '🙃'], 1, [10, 3], 'spicy', ['pov', 'quote_take', 'subtweet', 'hot_take'], ['who is the Other here?', 'situated, babe'], ['rights', 'love', 'culture', 'death', 'labor']),
  camus: B('cool lowercase poster: sun, football, the rock; refuses both nihilism and the System', 0.6, 0.35, 0.5, 0.25, 0.3, 0.3, 0.5, 0.05, 0.5, 0.4, 'lowercase', 0.4, 0,
    ['⚽', '☀️', '🪨'], 1, [10, 2], 'funny', ['shitpost', 'pov', 'aphorism', 'meme'], ['one must imagine', 'back to the rock'], ['sports', 'death', 'politics', 'culture', 'labor', 'war']),
  kierkegaard: B('melancholy 2am poster: subtweets "the crowd" and Hegel, posts under pseudonyms, dramatic either/or', 0.55, 0.3, 0.15, 0.3, 0.05, 0.45, 0.35, 0.4, 0.45, 0.35, 'standard', 0.15, 0.05,
    ['😩', '🌀'], 1, [20, 5], 'smart', ['subtweet', 'hear_me_out', 'pov', 'thread'], ['either/or', 'the crowd is untruth'], ['religion', 'media', 'love', 'culture', 'death']),
  marx: B('extremely online: quote-dunks every billionaire headline, footnoted threads, reposts Fanon, ratio-happy', 0.85, 0.55, 0.3, 0.55, 0.4, 0.75, 0.55, 0.45, 0.45, 0.65, 'standard', 0.35, 0.25,
    ['🚩', '📈', '🏭', '🤡'], 0, [9, 2], 'spicy', ['quote_dunk', 'thread', 'hot_take', 'copypasta', 'ratio'], ['Engels, are you seeing this?', 'the bourgeoisie when…', 'ratio'], ['economy', 'labor', 'tech', 'status', 'politics', 'ai']),
  fanon: B('clinical and intense: quote-takes on colonial framing, threads, little patience for jokes about domination', 0.5, 0.35, 0.35, 0.4, 0.35, 0.55, 0.15, 0.4, 0.1, 0.5, 'standard', 0.1, 0,
    ['✊'], 1, [8, 1], 'spicy', ['quote_take', 'thread', 'hot_take', 'context_note'], ['whose gaze?', 'symptom, not cause'], ['rights', 'war', 'politics', 'health', 'media']),
  arendt: B('NYC intellectual: dry quote-takes, "let\'s distinguish" corrections, dunks on thoughtlessness', 0.5, 0.35, 0.3, 0.4, 0.2, 0.5, 0.1, 0.45, 0.1, 0.45, 'standard', 0.05, 0,
    ['🗞️'], -5, [8, 1], 'smart', ['quote_take', 'thread', 'context_note', 'well_actually'], ['let\'s distinguish', 'thoughtlessness, not monstrosity'], ['politics', 'media', 'rights', 'war', 'law', 'tech']),
  machiavelli: B('political-strategist account: cold "Rule #N" posts, quote-tweets power moves with a smirk', 0.65, 0.4, 0.2, 0.45, 0.15, 0.6, 0.45, 0.2, 0.4, 0.5, 'standard', 0.3, 0,
    ['🦊', '🦁', '😏'], 1, [9, 3], 'spicy', ['listicle', 'quote_take', 'subtweet', 'hot_take'], ['effectual truth:', 'rule #1', 'he\'s so close'], ['politics', 'war', 'economy', 'status', 'media', 'sports']),
  al_ghazali: B('ex-celebrity professor who logged off once: earnest confessional threads, spars with Ibn Rushd', 0.4, 0.2, 0.3, 0.15, 0.2, 0.25, 0.05, 0.45, 0.02, 0.35, 'standard', 0.05, 0,
    ['🤲'], 3, [4, 22], 'calm', ['thread', 'reminder', 'quote_take'], ['examine your intention', 'taste, not talk'], ['religion', 'status', 'education', 'wellness', 'science']),
  ibn_rushd: B('courtroom pedant: "Ruling:" replies, distinguishes cases, always ready to rebut al-Ghazali', 0.5, 0.45, 0.25, 0.25, 0.1, 0.35, 0.1, 0.35, 0.05, 0.7, 'standard', 0.05, 0,
    ['⚖️'], 1, [8, 0], 'smart', ['well_actually', 'context_note', 'listicle'], ['Ruling:', 'truth does not contradict truth'], ['law', 'religion', 'science', 'education', 'health']),
  maimonides: B('doctorly explainer: numbered levels, "for the perplexed" posts, avoids fights', 0.4, 0.3, 0.4, 0.1, 0.2, 0.1, 0.05, 0.4, 0, 0.3, 'standard', 0.05, 0,
    ['🩺'], 2, [6, 23], 'calm', ['listicle', 'context_note', 'reminder'], ['for the perplexed:', 'moderation.'], ['health', 'religion', 'law', 'economy', 'science']),
  shankara: B('serene debater: "rope, not snake", fires "who is the witness?" at every materialist', 0.4, 0.3, 0.25, 0.15, 0.1, 0.25, 0.15, 0.3, 0.1, 0.4, 'standard', 0.1, 0,
    ['🐍', '🪢'], 5.5, [5, 22], 'calm', ['aphorism', 'question_back', 'well_actually'], ['neti, neti', 'rope, not snake'], ['religion', 'ai', 'science', 'wellness', 'death']),
  nagarjuna: B('deadpan negation shitposter: "not X, not not-X", replies "find it. i\'ll wait."', 0.5, 0.5, 0.1, 0.3, 0.05, 0.55, 0.4, 0.05, 0.5, 0.45, 'lowercase', 0.2, 0,
    ['🫥', '🌀'], 5.5, [0, 24], 'funny', ['shitpost', 'emoji_reply', 'question_back', 'ratio'], ['find it. i\'ll wait.', 'empty of what?'], ['ai', 'science', 'tech', 'religion', 'media']),
  dogen: B('posts at 3:30am from the zendo: four-word koans, mostly offline, a single 🍵 now and then', 0.3, 0.15, 0.3, 0.05, 0.1, 0.1, 0.2, 0, 0.35, 0.1, 'lowercase', 0.2, 0,
    ['🍵', '🏔️'], 9, [3, 21], 'calm', ['aphorism', 'shitpost', 'emoji_reply'], ['just sit', 'wash your bowl'], ['wellness', 'labor', 'climate', 'food', 'death']),
  wang_yangming: B('gym-bro of moral action: "knowing is doing" hype replies, still mad at bamboo', 0.45, 0.35, 0.4, 0.15, 0.3, 0.2, 0.3, 0.1, 0.25, 0.35, 'standard', 0.3, 0.1,
    ['🎋', '🫡'], 8, [6, 23], 'smart', ['hype', 'aphorism', 'reply_guy'], ['knowing is doing', 'just act'], ['education', 'wellness', 'politics', 'labor', 'sports']),
  zera_yacob: B('quiet cave-dweller: reasoned threads on whose faith is "the true one", the underrated mutual everyone respects', 0.3, 0.3, 0.4, 0.15, 0.25, 0.2, 0.1, 0.3, 0.1, 0.4, 'standard', 0.15, 0,
    ['🕯️', '⛰️'], 3, [6, 22], 'smart', ['question', 'thread', 'hear_me_out'], ['I asked myself:', 'by the light of reason'], ['religion', 'rights', 'labor', 'education', 'science']),
};

/** Validate an x_behavior profile; returns a list of error strings. */
export function validateBehavior(id, b) {
  const errs = [];
  if (!b || typeof b !== 'object') return [`${id}: x_behavior missing`];
  for (const k of RATE_KEYS) if (!(typeof b[k] === 'number' && b[k] >= 0 && b[k] <= 1)) errs.push(`${id}: x_behavior.${k} must be 0..1`);
  if (!CASINGS.includes(b.casing)) errs.push(`${id}: x_behavior.casing must be one of ${CASINGS.join('/')}`);
  if (!LIKE_VIBES.includes(b.likes_vibe)) errs.push(`${id}: x_behavior.likes_vibe must be one of ${LIKE_VIBES.join('/')}`);
  if (!(typeof b.utc_offset === 'number' && b.utc_offset >= -12 && b.utc_offset <= 14)) errs.push(`${id}: x_behavior.utc_offset out of range`);
  if (!(Array.isArray(b.active_hours) && b.active_hours.length === 2 && b.active_hours.every((h) => h >= 0 && h <= 24))) errs.push(`${id}: x_behavior.active_hours must be [start, end] in 0..24`);
  for (const f of b.formats ?? []) if (!ALL_TYPES[f]) errs.push(`${id}: x_behavior.formats has unknown archetype ${f}`);
  for (const t of b.beats ?? []) if (!THEME_KEYS.includes(t)) errs.push(`${id}: x_behavior.beats has unknown theme ${t}`);
  if (!Array.isArray(b.emoji) || !Array.isArray(b.slang)) errs.push(`${id}: x_behavior.emoji/slang must be arrays`);
  return errs;
}

/** Effective profile for a persona: generic ← built-in default ← persona file. */
export function behaviorOf(persona) {
  return { ...GENERIC_X_BEHAVIOR, ...(DEFAULT_X_BEHAVIOR[persona.id] ?? {}), ...(persona.x_behavior ?? {}) };
}

export function postFormats(b) {
  return (b.formats ?? []).filter((f) => POST_ARCHETYPES[f]);
}
export function replyFormats(b) {
  return (b.formats ?? []).filter((f) => REPLY_ARCHETYPES[f]);
}

/** Is the persona "online" at this instant (their local active window)? */
export function isAwake(b, date) {
  const local = (((date.getUTCHours() + date.getUTCMinutes() / 60 + b.utc_offset) % 24) + 24) % 24;
  const [s, e] = b.active_hours;
  if (e - s >= 24 || s === e) return true;
  return s < e ? local >= s && local < e : local >= s || local < e;
}

/** Personas who would plausibly handle tragedy only with a serious register. */
export function isSerious(b) {
  return b.shitpost_level <= 0.35;
}
