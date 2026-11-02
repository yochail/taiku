// Visual-asset uniqueness across a corpus: an image, meme or chart may appear on at most one post
// (a meme template may repeat, but only with different captions); a reaction GIF (local reaction or
// GIPHY id) may repeat across days, but never twice in one day or one conversation.
const VISUAL = new Set(['image', 'meme', 'chart']);

export const mediaOf = (p) => (Array.isArray(p?.media) ? p.media : p?.media ? [p.media] : []);
/** Stable identity of a reaction GIF: the local reaction id, else the GIPHY id, else its src. */
export const gifIdentity = (m) => m?.render?.reaction ?? m?.giphy_id ?? m?.src ?? null;
const memeKey = (m) => (m.render?.template ? `${m.render.template}|${JSON.stringify(m.render.captions ?? {})}` : null);

/** Root post id of p's reply chain within byId (quotes start their own conversation). */
export function threadRoot(p, byId) {
  let cur = p;
  for (let k = 0; k < 50 && cur?.inReplyTo && byId.has(cur.inReplyTo); k++) cur = byId.get(cur.inReplyTo);
  return cur?.inReplyTo ?? cur?.id ?? p.id;
}

/**
 * Uniqueness keys of one media item on post p: [{ key, kind, src, scope }].
 * scope 'corpus' keys must be unique corpus-wide; 'day'/'thread' keys within that day / conversation.
 */
export function visualKeys(p, m, root) {
  if (!m) return [];
  const out = [];
  if (VISUAL.has(m.kind) && m.src) {
    out.push({ key: `asset ${m.src}`, kind: m.kind, src: m.src, scope: 'corpus' });
    if (m.kind === 'image' && m.render?.art) out.push({ key: `art ${m.render.art}`, kind: m.kind, src: m.render.art, scope: 'corpus' });
    if (m.kind === 'meme' && memeKey(m)) out.push({ key: `meme ${memeKey(m)}`, kind: m.kind, src: m.src, scope: 'corpus' });
  } else if (m.kind === 'gif') {
    const id = gifIdentity(m);
    if (id) {
      out.push({ key: `gif-day ${String(p.createdAt).slice(0, 10)} ${id}`, kind: 'gif', src: id, scope: 'day' });
      out.push({ key: `gif-thread ${root} ${id}`, kind: 'gif', src: id, scope: 'thread' });
    }
  }
  return out;
}

/** [{ kind, src, scope, posts: [postId...] }] for every asset used more than its scope allows. */
export function duplicateVisuals(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const groups = new Map();
  for (const p of posts) {
    const root = threadRoot(p, byId);
    for (const m of mediaOf(p)) {
      for (const { key, ...entry } of visualKeys(p, m, root)) {
        const g = groups.get(key) ?? groups.set(key, { ...entry, posts: [] }).get(key);
        if (!g.posts.includes(p.id)) g.posts.push(p.id);
      }
    }
  }
  const out = [];
  const seen = new Set();
  for (const g of groups.values()) {
    if (g.posts.length < 2) continue;
    const k = `${g.kind} ${g.scope} ${g.posts.join(',')}`;
    if (!seen.has(k)) { seen.add(k); out.push(g); }
  }
  return out;
}
