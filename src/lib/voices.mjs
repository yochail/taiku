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

/**
 * Nearest-centroid attribution on real posts: hold each post out, build per-author centroids
 * from the rest, and count how often the true author is the nearest. Returns accuracy in [0,1].
 */
export function attributionAccuracy(posts, { minLen = 40, minPerAuthor = 6 } = {}) {
  const by = new Map();
  for (const p of posts) {
    if (!p.text || p.text.length < minLen) continue;
    if (!by.has(p.authorId)) by.set(p.authorId, []);
    by.get(p.authorId).push(trigrams(p.text));
  }
  const authors = [...by].filter(([, v]) => v.length >= minPerAuthor);
  const sum = (vs) => { const m = new Map(); for (const v of vs) for (const [k, x] of v) m.set(k, (m.get(k) ?? 0) + x); return m; };
  const sums = new Map(authors.map(([a, vs]) => [a, sum(vs)]));
  let hit = 0, n = 0;
  for (const [a, vs] of authors) {
    for (const v of vs) {
      let best = null, bestCos = -1;
      for (const [b] of authors) {
        let c = sums.get(b);
        if (b === a) { c = new Map(c); for (const [k, x] of v) c.set(k, c.get(k) - x); }
        const s = cosine(v, c);
        if (s > bestCos) { bestCos = s; best = b; }
      }
      n++; if (best === a) hit++;
    }
  }
  return { accuracy: n ? hit / n : 0, n, authors: authors.length };
}
