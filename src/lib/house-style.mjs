// House style: the prompt block every generation call carries (prompts/house-style.md) and the
// lint that rejects the checkable AI tells. Per-item problems come from lintTaik(); repetition
// across a batch / run ("everyone ends with a question", "everyone ends with a moral") from
// lintBatch() and createStyleTracker(). LLM items that fail are regenerated; pool items are dropped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const HOUSE_STYLE_FILE = path.join(ROOT, 'prompts', 'house-style.md');

let cached = null;
/** The house-style block for system prompts (everything from the "HOUSE STYLE" line on). */
export function houseStyle() {
  if (cached === null) {
    const md = fs.existsSync(HOUSE_STYLE_FILE) ? fs.readFileSync(HOUSE_STYLE_FILE, 'utf8').replace(/\r\n?/g, '\n') : ''; // CRLF checkouts must give the same prompt (and mock output) as LF
    const i = md.indexOf('HOUSE STYLE');
    cached = (i >= 0 ? md.slice(i) : md).trim();
  }
  return cached;
}

const A = "['’]"; // straight or curly apostrophe
/** Banned phrases (label → regex). Case-insensitive, matched on the visible text. */
export const BANNED = [
  ['opens with "Ah,"', /^\s*ah[,!.]/i],
  ['"Indeed"', /\bindeed\b/i],
  ['"Let\'s unpack"', new RegExp(`\\blet${A}?s unpack\\b`, 'i')],
  ['"It\'s not X, it\'s Y"', new RegExp(`\\b(?:it|this|that)${A}?s not (?:just |only |about )?[^.!?\\n]{1,50}?[,;:]\\s*(?:it|this|that)${A}?s\\b`, 'i')],
  ['"a testament to"', /\ba testament to\b/i],
  ['"delve"', /\bdelv(?:e|es|ed|ing)\b/i],
  ['"tapestry"', /\btapestr(?:y|ies)\b/i],
  ['"navigate"', /\bnavigat(?:e|es|ed|ing)\b/i],
  ['"in today\'s world"', new RegExp(`\\bin today${A}?s (?:world|society|age|fast[- ]paced)`, 'i')],
  ['"great question"', /\bgreat question\b/i],
  ['"food for thought"', /\bfood for thought\b/i],
  ['"at the end of the day"', /\bat the end of the day\b/i],
];

const MORAL = /(?:^|[.!?\n]\s*)(?:and\s+)?(?:that'?s|this is|here'?s)\s+(?:the|a|your)\s+(?:lesson|moral|point|takeaway)\b|\b(?:moral of the story|the lesson here|the real lesson|remember:|never forget|maybe the real\b|we must all|we should all|let us all|in the end,|the takeaway)\b/i;

const lastSentence = (t) => {
  const s = String(t ?? '').trim().replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D#\w-]*$/u, (m) => (/[.!?]/.test(m) ? m : m)).trim();
  const parts = s.split(/(?<=[.!?])\s+|\n+/).filter((x) => x.trim());
  return parts.at(-1) ?? s;
};

/** Does the taik end with a question (ignoring trailing emoji/hashtags)? */
export function endsWithQuestion(text) {
  const t = String(text ?? '').replace(/(?:\s*(?:#[\w-]+|\p{Extended_Pictographic}|\uFE0F|\u200D))+\s*$/u, '').trim();
  return /\?\s*["”’')]*$/.test(t);
}

/** Does the taik close on a moral / lesson? */
export const endsWithMoral = (text) => MORAL.test(lastSentence(text));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nameStarts(persona) {
  const out = new Set();
  const name = String(persona?.name ?? '').trim();
  const thinker = (persona?.kind ?? 'thinker') === 'thinker';
  if (name && !thinker) {
    // Parody/news names are often plain words ("The Ratio"); only the full multi-word name counts.
    if (/\s/.test(name)) out.add(name.toLowerCase());
  } else if (name) {
    out.add(name.toLowerCase());
    const last = name.split(/\s+/).at(-1);
    if (last && last.length >= 4) out.add(last.toLowerCase());
    const first = name.split(/\s+/)[0];
    if (first && first.length >= 4 && !/^(the|saint|st\.?)$/i.test(first)) out.add(first.toLowerCase());
  }
  if (persona?.handle) out.add(`@${String(persona.handle).toLowerCase()}`);
  return [...out];
}

/** Rule of three: "a, b, and c" with short parallel items, or three one-word sentences in a row. */
export function ruleOfThree(text) {
  const t = String(text ?? '');
  const item = "[\\p{L}'’-]+(?:\\s[\\p{L}'’-]+){0,2}";
  const list = new RegExp(`(?:^|[.!?:\\n]\\s*)(?:${item}\\s)?(${item}),\\s(${item}),?\\s(?:and|or)\\s(${item})[.!]?\\s*(?:$|[.!\\n])`, 'iu');
  if (list.test(t)) return true;
  const short = "[\\p{L}'’-]+(?:\\s[\\p{L}'’-]+)?";
  if (new RegExp(`(?:^|[.!?:\\n]\\s*)${short},\\s${short},\\s${short}[.!]?\\s*(?:$|[.!\\n])`, 'iu').test(t)) return true;
  return /(?:^|[\s.!?])(\p{Lu}[\p{L}'’-]*)\.\s+(\p{Lu}[\p{L}'’-]*)\.\s+(\p{Lu}[\p{L}'’-]*)\.(?:\s|$)/u.test(t);
}

/**
 * Lint one taik. Returns a list of problems (empty = clean). Media-only / empty text is clean.
 * persona: { name, handle } for the "starts with own name" rule.
 */
export function lintTaik(text, persona = null) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  const out = [];
  for (const [label, re] of BANNED) if (re.test(t)) out.push(`banned phrase ${label}`);
  const dashes = (t.match(/—/g) ?? []).length;
  if (dashes > 1) out.push(`em dash count ${dashes} > 1`);
  const low = t.toLowerCase().replace(/^["“'‘(]+/, '');
  for (const n of nameStarts(persona)) {
    if (low.startsWith(n) && !/[\p{L}\p{N}]/u.test(low.charAt(n.length))) {
      out.push('starts with own name');
      break;
    }
  }
  if (ruleOfThree(t)) out.push('rule of three');
  return out;
}

export const BATCH_LIMITS = { question: 0.4, moral: 0.4, minBatch: 3 };

/**
 * Repetition across a batch: returns Map<index, problems[]> for the items that push the batch over
 * a limit (e.g. >40% ending in "?"). The first items up to the limit are allowed; later ones are flagged.
 */
export function lintBatch(texts, limits = BATCH_LIMITS) {
  const flagged = new Map();
  const list = texts.map((t) => String(t ?? '').trim());
  const nonEmpty = list.filter(Boolean).length;
  if (nonEmpty < limits.minBatch) return flagged;
  const flag = (pred, max, label) => {
    let allowed = Math.floor(max * nonEmpty);
    list.forEach((t, i) => {
      if (!t || !pred(t)) return;
      if (allowed > 0) allowed--;
      else flagged.set(i, [...(flagged.get(i) ?? []), label]);
    });
  };
  flag(endsWithQuestion, limits.question, `too many posts in this batch end with a question (max ${Math.round(limits.question * 100)}%)`);
  flag(endsWithMoral, limits.moral, `too many posts in this batch end with a moral (max ${Math.round(limits.moral * 100)}%)`);
  return flagged;
}

/** Run-level tracker for single turns: flags a new taik that would push the run over a batch limit. */
export function createStyleTracker(limits = BATCH_LIMITS, window = 30) {
  const recent = [];
  const share = (pred, extra) => {
    const all = [...recent, extra].filter(Boolean);
    return all.filter(pred).length / all.length;
  };
  return {
    check(text) {
      const t = String(text ?? '').trim();
      if (!t || recent.length + 1 < Math.max(limits.minBatch, 5)) return [];
      const out = [];
      if (endsWithQuestion(t) && share(endsWithQuestion, t) > limits.question) out.push('too many posts today end with a question; end this one differently');
      if (endsWithMoral(t) && share(endsWithMoral, t) > limits.moral) out.push('too many posts today end with a moral; just stop instead');
      return out;
    },
    add(text) {
      const t = String(text ?? '').trim();
      if (!t) return;
      recent.push(t);
      if (recent.length > window) recent.shift();
    },
    get size() { return recent.length; },
  };
}

/** Repair prompt for house-style problems. */
export const houseStyleRepair = (problems) => `House style: ${problems.slice(0, 4).join('; ')}. Rewrite it in your own voice without these tells (no em-dash habit, no stock AI phrases, don't open with your name, don't moralise). Return the JSON only.`;
