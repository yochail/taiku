// Per-persona format rotation: an account shouldn't post the same kind of thing over and over.
//
// A "format" is what an item is, at the level a reader notices: a meme, a chart, a poll, a link/ref
// card, a self-thread, a quote-taik, a plain retaik, a reply, or for text originals the archetype
// (hot take, aphorism, daily-life bit, teaching, …). The generator samples format from the spec ×
// persona as before, then multiplies each candidate by penalty^k, where k counts that format among
// the persona's last `lookback` items across days (spec.sampling.format_rotation). Media kinds are
// renormalised among themselves, so rotation changes WHICH media a persona uses, not how often the
// day carries media (the spec's media shares stay intact).

const REF_KINDS = new Set(['link_card', 'x_post', 'bsky_post']);
const mediaList = (p) => (Array.isArray(p?.media) ? p.media : p?.media ? [p.media] : []);

/** Format of a media kind ('none' → null). */
export const mediaFormat = (kind) => (!kind || kind === 'none' ? null : REF_KINDS.has(kind) ? 'ref' : kind);

/** Format of a stored post (or retaik row). */
export function formatOf(p) {
  if (!p) return null;
  if (p.retaikOf) return 'retaik';
  if (p.poll) return 'poll';
  const m = mediaList(p).map((x) => mediaFormat(x?.kind)).find(Boolean);
  if (p.quoteOf) return m && m !== 'ref' ? `quote:${m}` : 'quote';
  if (p.type === 'thread') return 'thread';
  if (p.inReplyTo) return 'reply';
  if (m) return m;
  return p.type ?? 'take';
}

/** Format of a planned task spec (role + media + archetype). */
export function formatOfTask({ role, media, archetype, kind }) {
  if (role === 'retaik') return 'retaik';
  const m = mediaFormat(media);
  if (role === 'quote') return m && m !== 'ref' ? `quote:${m}` : 'quote';
  if (archetype === 'thread' || kind === 'thread' || kind === 'thread-part') return 'thread';
  if (role === 'reply') return 'reply';
  return m ?? archetype ?? 'take';
}

/** Formats that count for rotation (replies are conversation-driven, plain retaiks one-tap; thread parts belong to their root). */
export const rotates = (f) => Boolean(f) && f !== 'reply' && f !== 'retaik';

/**
 * Rotation state: per persona, its last `lookback` rotating formats (oldest first).
 * prior: earlier posts (any days); only items before `before` (ms) count.
 */
export function createRotation(prior = [], cfg = {}) {
  const lookback = cfg.lookback ?? 5;
  const penalty = cfg.penalty ?? 0.3;
  const hist = new Map();
  const items = prior
    .filter((p) => p?.authorId && !(p.type === 'thread' && p.inReplyTo))
    .map((p) => ({ pid: p.authorId, t: Date.parse(p.createdAt) || 0, id: String(p.id), f: formatOf(p) }))
    .filter((x) => rotates(x.f))
    .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  const push = (pid, f) => {
    if (!rotates(f)) return;
    const h = hist.get(pid) ?? hist.set(pid, []).get(pid);
    h.push(f);
    if (h.length > lookback) h.shift();
  };
  for (const x of items) push(x.pid, x.f);
  const count = (pid, f) => (hist.get(pid) ?? []).filter((x) => x === f).length;
  return {
    penalty,
    lookback,
    history: (pid) => [...(hist.get(pid) ?? [])],
    /** penalty^k for k recent uses of this format by the persona */
    factor: (pid, f) => (rotates(f) ? penalty ** count(pid, f) : 1),
    push,
  };
}

/**
 * Apply rotation to a media-kind weight table [[kind, w]...]: visual/ref kinds get penalty^k and are
 * rescaled so their total mass (the day's media share) is unchanged; 'none' keeps its weight.
 */
export function rotateMediaWeights(entries, rot, pid, prefix = '') {
  if (!rot || !pid) return entries;
  const isMedia = ([k, w]) => k !== 'none' && typeof w === 'number' && w > 0;
  const before = entries.filter(isMedia).reduce((s, [, w]) => s + w, 0);
  const scaled = entries.map(([k, w]) => (isMedia([k, w]) ? [k, w * rot.factor(pid, prefix + mediaFormat(k))] : [k, w]));
  const after = scaled.filter(isMedia).reduce((s, [, w]) => s + w, 0);
  if (!before || !after) return entries;
  return scaled.map(([k, w]) => (isMedia([k, w]) ? [k, (w * before) / after] : [k, w]));
}

/** Longest run of one format in a sequence. */
export function maxRun(formats) {
  let best = 0;
  let run = 0;
  let prev = null;
  for (const f of formats) {
    run = f === prev ? run + 1 : 1;
    prev = f;
    if (run > best) best = run;
  }
  return best;
}

/** Shannon entropy (bits) of a format list. */
export function entropy(formats) {
  const n = formats.length;
  if (!n) return 0;
  const c = new Map();
  for (const f of formats) c.set(f, (c.get(f) ?? 0) + 1);
  let h = 0;
  for (const k of c.values()) h -= (k / n) * Math.log2(k / n);
  return h;
}

/**
 * Per-persona rotation stats over a window: [{ personaId, n, maxRun, run, entropy, formats }].
 * posts: the window's posts (e.g. today + previous 6 days), sorted internally by time.
 */
export function rotationStats(posts) {
  const by = new Map();
  const items = posts
    .filter((p) => p?.authorId && !(p.type === 'thread' && p.inReplyTo))
    .map((p) => ({ p, f: formatOf(p), t: Date.parse(p.createdAt) || 0 }))
    .filter((x) => rotates(x.f))
    .sort((a, b) => a.t - b.t || String(a.p.id).localeCompare(String(b.p.id)));
  for (const x of items) (by.get(x.p.authorId) ?? by.set(x.p.authorId, []).get(x.p.authorId)).push(x);
  return [...by].map(([personaId, xs]) => {
    const formats = xs.map((x) => x.f);
    let best = { len: 0, f: null, ids: [] };
    let cur = { len: 0, f: null, ids: [] };
    for (const x of xs) {
      cur = x.f === cur.f ? { len: cur.len + 1, f: x.f, ids: [...cur.ids, x.p.id] } : { len: 1, f: x.f, ids: [x.p.id] };
      if (cur.len > best.len) best = cur;
    }
    return { personaId, n: formats.length, maxRun: best.len, run: best, entropy: entropy(formats), formats };
  });
}
