// "For you" ranking: pure functions only, shared by the browser (globalThis.TaikuRank) and node tests.
(() => {
  const HALF_LIFE_H = 24;
  const SEEN_CAP = 5000;

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  // Deterministic jitter in [0, 1) per (seed, post id).
  function rand01(seed, id) {
    let t = (hashStr(id) ^ Math.imul(seed >>> 0, 2654435761)) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function engagement(it) {
    return 1 + Math.log10(1 + (it.l || 0) + 2 * (it.r || 0) + 1.5 * (it.rt || 0));
  }
  function recency(it, now) {
    const ageH = Math.max(0, (now - it.t) / 3600000);
    return Math.pow(0.5, ageH / HALF_LIFE_H);
  }
  function affinity(it, ctx) {
    const followed = ctx.follows && ctx.follows.has(it.a) ? 1 : 0;
    const a = (ctx.affinity && ctx.affinity[it.a]) || 0;
    const topical = ctx.topics && ctx.topics.size && it.g && it.g.some((k) => ctx.topics.has(k)) ? 0.6 : 0;
    return 1 + followed + topical + Math.min(1, a * 0.25);
  }
  // "Who to follow": score unfollowed people by closeness to the ones the user follows/likes
  // (declared allies/rivals, who they reply to, shared topics, followed topics), popularity as tie-break.
  function suggestPeople(people, ctx = {}) {
    const follows = ctx.follows || new Set();
    const topics = ctx.topics || new Set();
    const aff = ctx.affinity || {};
    const seeds = new Map();
    for (const id of follows) seeds.set(id, 3);
    for (const id in aff) if (aff[id] > 0) seeds.set(id, (seeds.get(id) || 0) + Math.min(3, aff[id]));
    const scores = [];
    for (const id in people) {
      if (follows.has(id)) continue;
      const p = people[id];
      let s = 0;
      for (const [sid, w] of seeds) {
        if (sid === id) continue;
        const q = people[sid];
        if (!q) continue;
        if ((q.rel || []).includes(id)) s += 2 * w;
        if ((q.co || []).includes(id)) s += 1.5 * w;
        if ((p.rel || []).includes(sid) || (p.co || []).includes(sid)) s += w;
        const shared = (p.tp || []).filter((k) => (q.tp || []).includes(k)).length;
        s += 0.3 * shared * w;
      }
      s += 0.6 * (p.tp || []).filter((k) => topics.has(k)).length;
      if (p.k && p.k !== 'thinker') s *= 0.5;
      scores.push([id, s + Math.log10(1 + (p.fr || 0)) * 0.01 + rand01(ctx.seed || 0, id) * 0.001]);
    }
    return scores.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id, s]) => ({ id, score: s }));
  }
  function seenCount(it, ctx) {
    const s = ctx.seen && ctx.seen[it.id];
    return s ? s[0] : 0;
  }
  function score(it, ctx) {
    const n = seenCount(it, ctx);
    const penalty = n ? 0.02 : 1;
    const jitter = 0.85 + 0.3 * rand01(ctx.seed || 0, it.id);
    return recency(it, ctx.now) * engagement(it) * affinity(it, ctx) * penalty * jitter;
  }

  // Greedy re-rank: never 3 in a row by one author; mix media and text when the next few candidates allow it.
  function diversify(list, opts = {}) {
    const maxRun = opts.maxRun ?? 2;
    const textRun = opts.textRun ?? 3;
    const window = opts.window ?? 10;
    const pool = list.slice();
    const out = [];
    while (pool.length) {
      const last = out.slice(-maxRun);
      const sameAuthorRun = last.length === maxRun && last.every((x) => x.a === last[0].a) ? last[0].a : null;
      const tail = out.slice(-textRun);
      const needMedia = tail.length === textRun && tail.every((x) => !x.m);
      const prevMedia = out.length > 0 && out[out.length - 1].m;
      const ok = (x) => x.a !== sameAuthorRun;
      const lim = Math.min(window, pool.length);
      let pick = -1;
      if (needMedia) for (let i = 0; i < lim; i++) if (pool[i].m && ok(pool[i])) { pick = i; break; }
      if (pick < 0 && prevMedia) for (let i = 0; i < lim; i++) if (!pool[i].m && ok(pool[i])) { pick = i; break; }
      if (pick < 0) pick = pool.findIndex(ok);
      if (pick < 0) pick = 0;
      out.push(pool.splice(pick, 1)[0]);
    }
    return out;
  }

  // Returns { fresh, seen }: unseen posts ranked, then posts seen once (shown after "You're all caught up"); 2+ views are dropped.
  function rankFeed(items, ctx) {
    const by = (a, b) => b.s - a.s || (a.it.id < b.it.id ? -1 : 1);
    // A retaik (k = original id) and its original are one story: keep the best-scored copy.
    const keys = new Set();
    const scored = items.map((it) => ({ it, s: score(it, ctx), n: seenCount(it, ctx) })).filter((x) => x.n < 2).sort(by).filter((x) => {
      const k = x.it.k || x.it.id;
      if (keys.has(k)) return false;
      keys.add(k);
      return true;
    });
    const fresh = scored.filter((x) => x.n === 0).sort(by).map((x) => x.it);
    const seen = scored.filter((x) => x.n === 1).sort(by).map((x) => x.it);
    return { fresh: diversify(fresh), seen: diversify(seen) };
  }

  // seen = { id: [count, lastSeenMs] }; keeps the newest SEEN_CAP entries.
  function markSeen(seen, id, now) {
    const prev = seen[id];
    seen[id] = [prev ? prev[0] + 1 : 1, now];
    return seen;
  }
  function pruneSeen(seen, cap = SEEN_CAP) {
    const keys = Object.keys(seen);
    if (keys.length <= cap) return seen;
    keys.sort((a, b) => seen[b][1] - seen[a][1]);
    const out = {};
    for (const k of keys.slice(0, cap)) out[k] = seen[k];
    return out;
  }

  globalThis.TaikuRank = { hashStr, rand01, engagement, recency, affinity, score, diversify, rankFeed, suggestPeople, markSeen, pruneSeen, SEEN_CAP };
})();
