// AI/LLM tells banned from every taik (docs/voice-guide.md §0).
export const BANNED_WORDS = /\b(delve[sd]?|delving|tapestry|testament to|navigat(e|es|ing) the|landscape of|in the realm of|multifaceted|embark(s|ed|ing)? on|resonates? (deeply|with)|underscores?|in today's (world|fast-paced)|let's unpack|great question)\b/i;
export const BANNED_OPENERS = /^(ah|indeed|well|interesting|certainly|absolutely|ah yes|oh,? indeed)[,.!]\s+/i;
export const NOT_X_BUT_Y = /\b(it'?s|this is|that'?s) not (just |merely |about )?[^.?!]{1,40}[,;.—-]+\s*(it'?s|this is|that'?s) (about )?/i;

export function findTells(text) {
  const t = String(text ?? '');
  const out = [];
  if (t.includes('—')) out.push('em dash');
  if (BANNED_OPENERS.test(t)) out.push('AI opener');
  const w = t.match(BANNED_WORDS);
  if (w) out.push(`"${w[0]}"`);
  if (NOT_X_BUT_Y.test(t)) out.push('"not X, it\'s Y"');
  return out;
}

// Deterministic cleanup of the cheap tells; returns text that may still have word-level tells.
export function scrubTells(text) {
  return String(text ?? '')
    .replace(BANNED_OPENERS, '')
    .replace(/\s*—\s*(?=[a-z])/g, ', ')
    .replace(/\s*—\s*/g, '. ')
    .replace(/^\s*[a-z]/, (c) => c)
    .trim();
}
