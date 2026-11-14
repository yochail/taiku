/** Only actual replies count: neither likes, retaiks, quotes nor self-thread parts. */
export function threadCoverage(posts) {
  const byId = new Map(posts.map((p) => [p.id, p]));
  const roots = posts.filter((p) => !p.inReplyTo && !p.quoteOf && !p.retaikOf);
  const counts = new Map(roots.map((p) => [p.id, 0]));
  const rootOf = (p) => {
    const seen = new Set();
    while (p?.inReplyTo || p?.quoteOf || p?.retaikOf) {
      if (seen.has(p.id)) return null;
      seen.add(p.id);
      p = byId.get(p.inReplyTo ?? p.quoteOf ?? p.retaikOf);
    }
    return p?.id ?? null;
  };
  for (const p of posts) if (p.inReplyTo && p.type !== 'thread_part' && !p.retaikOf &&
    !(p.authorId && p.authorId === byId.get(p.inReplyTo)?.authorId)) {
    const id = rootOf(p);
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
  }
  return { roots, counts, rootOf };
}

export function completeThreads(posts, min, max = Infinity) {
  const coverage = threadCoverage(posts);
  const keep = new Set(coverage.roots.filter((p) => coverage.counts.get(p.id) >= min &&
    coverage.counts.get(p.id) <= max).map((p) => p.id));
  return { posts: posts.filter((p) => keep.has(coverage.rootOf(p))), roots: keep.size,
    droppedRoots: coverage.roots.length - keep.size };
}
