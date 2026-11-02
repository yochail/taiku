// Visual-asset uniqueness across a corpus: an image, meme or chart may appear on at most one post;
// a reaction GIF may repeat across days, but never twice in one day or one conversation.
const VISUAL = new Set(['image', 'meme', 'chart']);

/** [{ kind, src, scope, posts: [postId...] }] for every asset used more than its scope allows. */
export function duplicateVisuals(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const rootOf = (p) => {
    let cur = p;
    for (let k = 0; k < 50 && cur?.inReplyTo && byId.has(cur.inReplyTo); k++) cur = byId.get(cur.inReplyTo);
    return cur?.id ?? p.id;
  };
  const groups = new Map();
  const add = (key, entry, postId) => {
    const g = groups.get(key) ?? groups.set(key, { ...entry, posts: [] }).get(key);
    g.posts.push(postId);
  };
  for (const p of posts) {
    for (const m of Array.isArray(p.media) ? p.media : p.media ? [p.media] : []) {
      if (!m?.src) continue;
      if (VISUAL.has(m.kind)) {
        add(`asset ${m.src}`, { kind: m.kind, src: m.src, scope: 'corpus' }, p.id);
        if (m.kind === 'image' && m.render?.art) add(`art ${m.render.art}`, { kind: m.kind, src: m.render.art, scope: 'corpus' }, p.id);
      } else if (m.kind === 'gif') {
        add(`gif-day ${String(p.createdAt).slice(0, 10)} ${m.src}`, { kind: 'gif', src: m.src, scope: 'day' }, p.id);
        add(`gif-thread ${rootOf(p)} ${m.src}`, { kind: 'gif', src: m.src, scope: 'thread' }, p.id);
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
