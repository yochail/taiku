/**
 * Voice distinctness: personas that carry a register/idiolect fingerprint must stay
 * distinguishable from each other. Character trigrams work for any script (Hebrew included)
 * and need no tokenizer or model.
 */

const norm = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[\u0591-\u05C7]/g, '') // niqqud and cantillation
  .replace(/https?:\/\/\S+|@\w+/g, ' ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function trigrams(text) {
  const v = new Map();
  for (const w of norm(text).split(' ')) {
    if (!w) continue;
    const t = ` ${w} `;
    for (let i = 0; i + 3 <= t.length; i++) {
      const g = t.slice(i, i + 3);
      v.set(g, (v.get(g) ?? 0) + 1);
    }
  }
  return v;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of a) { na += x * x; const y = b.get(k); if (y) dot += x * y; }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The text that fingerprints a persona's voice: idiolect + sample phrases (not the shared period register). */
export function fingerprintText(p) {
  const v = p.voice ?? {};
  const i = v.idiolect ?? {};
  return [...(i.signature_words ?? []), ...(v.sample_phrases ?? [])].join(' \n ');
}

export function voiceProblems(p) {
  const v = p.voice ?? {};
  const errs = [];
  if (!v.register) errs.push('voice.register missing');
  const n = v.sample_phrases?.length ?? 0;
  if (n < 3 || n > 5) errs.push(`voice.sample_phrases has ${n} items (want 3–5)`);
  const i = v.idiolect ?? {};
  for (const k of ['signature_words', 'sentence_shapes', 'rhetorical_habits']) if (!i[k]?.length) errs.push(`voice.idiolect.${k} missing`);
  return errs;
}

/** All persona pairs ranked by fingerprint similarity (highest first). */
export function closestVoices(personas) {
  const fp = personas.map((p) => [p.id, trigrams(fingerprintText(p))]);
  const pairs = [];
  for (let i = 0; i < fp.length; i++) for (let j = i + 1; j < fp.length; j++) {
    pairs.push({ a: fp[i][0], b: fp[j][0], cos: cosine(fp[i][1], fp[j][1]) });
  }
  return pairs.sort((x, y) => y.cos - x.cos);
}

// ---- Style features for post attribution -------------------------------------------------------
// Hebrew-aware: niqqud/cantillation dropped, final letters folded (ם→מ …), geresh/gershayim unified,
// and a word with clitic prefixes (ו/ה/ב/כ/ל/מ/ש) also counts as its bare stem plus the prefix, so
// "ובשבת"/"שבת" share a feature. Punctuation and emoji are kept as tokens: they are style
// ("📐 תוצאה:", "ודו״ק", "!!!").
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
// Prefix order: ו, then ש/כש, then ב/כ/ל/מ, then ה.
const HE_PREFIX = /^ו?(?:כש|ש)?[בכלמ]?ה?(?=[\u05D0-\u05EA]{2,})/;
const TOKEN = /[\p{L}\p{N}'"]+|\p{Extended_Pictographic}|[^\s\p{L}\p{N}\p{M}\u200d\ufe0f]/gu;

export function normalizeHebrew(text) {
  return String(text ?? '').normalize('NFC').toLowerCase()
    .replace(/https?:\/\/\S+|@\w+/g, ' ')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[״"”“]/g, '"').replace(/[׳'’‘]/g, "'");
}

/** Sparse style vector: char trigrams of words, words, Hebrew stems/prefixes, symbols; sublinear tf, L2-normalised. */
export function styleFeatures(text) {
  const v = new Map();
  const add = (k) => v.set(k, (v.get(k) ?? 0) + 1);
  for (const w of normalizeHebrew(text).match(TOKEN) ?? []) {
    if (!/[\p{L}\p{N}]/u.test(w)) { add(`s${w}`); continue; }
    const t = ` ${w} `;
    for (let i = 0; i + 3 <= t.length; i++) add(`c${t.slice(i, i + 3)}`);
    add(`w${w}`);
    const stem = w.replace(HE_PREFIX, '');
    if (stem !== w) { add(`w${stem}`); add(`p${w.slice(0, w.length - stem.length)}`); }
  }
  let norm = 0;
  for (const [k, x] of v) { const y = 1 + Math.log(x); v.set(k, y); norm += y * y; }
  norm = Math.sqrt(norm);
  if (norm) for (const [k, x] of v) v.set(k, x / norm);
  return v;
}

/** Letters in the text (URLs, emoji, digits and punctuation excluded): the style signal a post carries. */
export const letterCount = (text) => (String(text ?? '').replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? []).length;

export const VOICE_ATTRIBUTION_DEFAULTS = { min_lift: 10, window_days: 30, min_letters: 20, min_context_items: 6, min_items: 20, recent_days: 7, blocking: true };

/** spec.voice_attribution (absent → the site does not gate on attribution). */
export function voiceAttributionConfig(spec) {
  const c = spec?.voice_attribution;
  return c ? { ...VOICE_ATTRIBUTION_DEFAULTS, ...c } : null;
}

/** Items that can carry a voice: authored text with at least min_letters letters (emoji/one-word replies have no style to attribute). */
export const attributable = (p, cfg = VOICE_ATTRIBUTION_DEFAULTS) => Boolean(p?.text && p.authorId && !p.retaikOf && letterCount(p.text) >= cfg.min_letters);

/**
 * Voice attribution of one day: per-author centroids from the previous window_days of posts
 * (context, strictly before the day's first post), then each of the day's attributable posts is
 * assigned to its nearest centroid. Features are IDF-weighted across authors so morphology every
 * author shares (Hebrew prefixes, common trigrams) doesn't swamp the idiolect.
 *
 * Reported as lift over chance: accuracy × candidate authors (chance = 1/N, so lift 1 = guessing).
 * A day where everyone writes in one voice scores ~1–5; distinct voices score ~15–35.
 * The day gate and the CI test both call this, with the same inputs, so they agree.
 */
export function dayAttribution(dayPosts, context, cfg = VOICE_ATTRIBUTION_DEFAULTS) {
  const c = { ...VOICE_ATTRIBUTION_DEFAULTS, ...cfg };
  const times = dayPosts.map((p) => Date.parse(p.createdAt)).filter((t) => !Number.isNaN(t));
  const start = times.length ? Math.min(...times) : NaN;
  const dayIds = new Set(dayPosts.map((p) => p.id));
  const train = context.filter((p) => !dayIds.has(p.id) && attributable(p, c) && Date.parse(p.createdAt) < start && Date.parse(p.createdAt) >= start - c.window_days * 864e5);
  const sums = new Map();
  const counts = new Map();
  for (const p of train) {
    if (!sums.has(p.authorId)) sums.set(p.authorId, new Map());
    const m = sums.get(p.authorId);
    for (const [k, x] of styleFeatures(p.text)) m.set(k, (m.get(k) ?? 0) + x);
    counts.set(p.authorId, (counts.get(p.authorId) ?? 0) + 1);
  }
  const authors = [...sums.keys()].filter((a) => counts.get(a) >= c.min_context_items);
  const df = new Map();
  for (const a of authors) for (const k of sums.get(a).keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const idf = (k) => Math.log((1 + authors.length) / (1 + (df.get(k) ?? 0))) + 1;
  const weigh = (m) => { const r = new Map(); for (const [k, x] of m) r.set(k, x * idf(k)); return r; };
  const centroids = authors.map((a) => { const m = weigh(sums.get(a)); let s = 0; for (const x of m.values()) s += x * x; return [a, m, Math.sqrt(s)]; });
  const known = new Set(authors);
  let hit = 0;
  const misses = [];
  const test = dayPosts.filter((p) => attributable(p, c) && known.has(p.authorId));
  for (const p of test) {
    const v = weigh(styleFeatures(p.text));
    let best = null, bestCos = -1;
    for (const [a, cv, cn] of centroids) {
      let dot = 0;
      for (const [k, x] of v) { const y = cv.get(k); if (y) dot += x * y; }
      const s = cn ? dot / cn : 0; // |v| is the same for every candidate, so it doesn't change the ranking
      if (s > bestCos) { bestCos = s; best = a; }
    }
    if (best === p.authorId) hit++;
    else misses.push({ postId: p.id, personaId: p.authorId, taskId: p.taskId ?? null, guessed: best });
  }
  const n = test.length;
  const accuracy = n ? hit / n : 0;
  return { accuracy, lift: accuracy * authors.length, chance: authors.length ? 1 / authors.length : 0, n, authors: authors.length, misses };
}
