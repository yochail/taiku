// Topic selection: score scanned headlines/trends, skip what the feed already covered,
// keep sections diverse, keep grave news rare and serious, and sprinkle in an evergreen
// shitpost topic so the feed isn't only news.
import { themesOf, isGrave } from './themes.mjs';
import { hash, slugify } from './util.mjs';

const STOP = new Set('the a an and or but of to in on at for with from by is are was were be been it its this that these those as about after before over into new says say said will would could should has have had not no you your our their his her they them we us who what why how when where which than then more most just also very can may might out up down off amid near says live update updates video watch'.split(' '));

export function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w))
      .map((w) => w.slice(0, 6)),
  );
}

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

export const EVERGREEN_TOPICS = [
  { title: 'people who clap when the plane lands', themes: ['cities', 'culture'] },
  { title: 'the 5am club', themes: ['wellness', 'labor'] },
  { title: 'LinkedIn thought leaders', themes: ['labor', 'status', 'media'] },
  { title: 'main character syndrome', themes: ['culture', 'wellness', 'status'] },
  { title: 'dating apps', themes: ['love', 'tech'] },
  { title: 'gym mirror selfies', themes: ['wellness', 'status', 'culture'] },
  { title: '"do your own research"', themes: ['science', 'media'] },
  { title: 'unread notifications', themes: ['tech', 'wellness'] },
  { title: 'the group chat at 2am', themes: ['love', 'tech', 'culture'] },
  { title: 'brunch', themes: ['food', 'status'] },
  { title: 'being "busy"', themes: ['labor', 'wellness', 'status'] },
  { title: 'Monday', themes: ['labor', 'wellness'] },
  { title: 'doomscrolling in bed', themes: ['tech', 'wellness', 'media'] },
  { title: 'reply guys', themes: ['media', 'culture'] },
  { title: 'pineapple on pizza', themes: ['food', 'culture'] },
  { title: 'astrology girlies vs. the rationalists', themes: ['science', 'religion', 'culture'] },
  { title: 'productivity apps that make you less productive', themes: ['tech', 'wellness', 'labor'] },
  { title: 'touching grass', themes: ['wellness', 'climate'] },
  { title: 'sourdough starters', themes: ['food', 'wellness'] },
  { title: 'philosophy bros who only read the Wikipedia summary', themes: ['education', 'media', 'culture'] },
];

export function topicId(t) {
  return `${slugify(t.title).slice(0, 40).replace(/-+$/, '')}-${hash(t.url || t.title).toString(36).slice(0, 5)}`;
}

/** Persona keyword bags (built once). */
export function personaBag(p) {
  return tokens([...(p.favorite_topics ?? []), p.news_lens, ...(p.pet_peeves ?? []), ...(p.core_ideas ?? []), p.school].join(' '));
}

/** 0..1: how much this persona would care about this topic. */
export function relevance(persona, behavior, bag, topic) {
  const themes = topic.themes ?? [];
  const beats = behavior.beats ?? [];
  const beatHits = themes.filter((t) => beats.includes(t)).length;
  const beat = themes.length ? Math.min(1, beatHits / Math.min(2, themes.length)) : 0;
  let kw = 0;
  for (const w of topic.tokens ?? tokens(`${topic.title} ${topic.description ?? ''}`)) if (bag.has(w)) kw++;
  return Math.min(1, 0.65 * beat + 0.35 * Math.min(1, kw / 2) + 0.05);
}

/** Titles/URLs the feed already covered recently (from existing posts). */
export function coveredTopics(posts, now, days = 7) {
  const urls = new Set();
  const titles = [];
  for (const p of posts) {
    if (now - Date.parse(p.createdAt) > days * 86400_000) continue;
    for (const t of [p.topic, p.news]) {
      if (!t) continue;
      if (t.url) urls.add(t.url);
      if (t.title) titles.push(tokens(t.title));
    }
  }
  return { urls, titles };
}

/** Enrich + score candidates. */
export function scoreCandidates(items, { personas, behaviors, bags, covered, now }) {
  const out = [];
  const seen = [];
  for (const it of items) {
    if (!it.title || it.title.length < 4) continue;
    const tk = tokens(`${it.title} ${it.description ?? ''}`);
    const titleTk = tokens(it.title);
    if (covered.urls.has(it.url) || covered.titles.some((t) => jaccard(t, titleTk) >= 0.45)) continue;
    if (seen.some((t) => jaccard(t, titleTk) >= 0.5)) continue; // same story from two outlets
    seen.push(titleTk);
    const text = `${it.title} ${it.description ?? ''}`;
    const themes = themesOf(text);
    const grave = isGrave(text);
    const t = { ...it, themes, grave, tokens: tk };
    const rels = personas.map((p) => relevance(p, behaviors.get(p.id), bags.get(p.id), t)).sort((a, b) => b - a);
    const fit = (rels[0] + rels[1] + rels[2]) / 3;
    const ripeness = Math.min(1, themes.length * 0.28);
    const ageH = it.publishedAt ? (now - Date.parse(it.publishedAt)) / 3600_000 : 12;
    const fresh = ageH < 0 ? 1 : Math.max(0.2, 1 - ageH / 72);
    let score = 0.4 * ripeness + 0.45 * fit + 0.15 * fresh;
    if (it.kind === 'trend') score += 0.08 + (parseInt(String(it.traffic ?? '').replace(/\D/g, ''), 10) >= 100 ? 0.05 : 0);
    if (/\blive\b|as it happened|\/videos?\//i.test(`${it.title} ${it.url}`)) score -= 0.12;
    if (/\b(quiz|crossword|horoscope|deal of the day|coupon)\b/i.test(it.title)) score -= 0.3;
    if (grave) score *= 0.55;
    out.push({ ...t, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Pick n topics: greedy by score with diversity penalties (section/source/theme), max one grave
 * topic, and (with probability evergreenRate) one evergreen shitpost topic.
 */
export function selectTopics(cands, n, rand, { evergreenRate = 0.5, preferred = null } = {}) {
  const picked = [];
  const wantEvergreen = rand() < evergreenRate ? 1 : 0;
  const pool = [...cands];
  if (preferred?.length) {
    for (const p of preferred) {
      if (picked.length >= n - wantEvergreen) break;
      const i = pool.indexOf(p);
      if (i >= 0 && !(p.grave && picked.some((x) => x.grave))) picked.push(...pool.splice(i, 1));
    }
  }
  while (picked.length < n - wantEvergreen && pool.length) {
    let best = null;
    let bestScore = -Infinity;
    for (const c of pool.slice(0, 40)) {
      if (c.grave && picked.some((x) => x.grave)) continue;
      let s = c.score * (0.7 + 0.6 * rand());
      for (const p of picked) {
        if (p.section === c.section) s *= 0.55;
        if (p.source === c.source) s *= 0.8;
        const overlap = c.themes.filter((x) => p.themes.includes(x)).length;
        s *= 1 - Math.min(0.6, 0.2 * overlap);
      }
      if (s > bestScore) [best, bestScore] = [c, s];
    }
    if (!best) break;
    picked.push(best);
    pool.splice(pool.indexOf(best), 1);
  }
  const evergreen = [...EVERGREEN_TOPICS];
  while (picked.length < n && evergreen.length) {
    const e = evergreen.splice(Math.floor(rand() * evergreen.length), 1)[0];
    picked.push({ title: e.title, url: null, source: null, description: '', section: 'evergreen', kind: 'evergreen', themes: e.themes, grave: false, tokens: tokens(e.title), score: 0.5 });
  }
  return picked.map((t) => ({ ...t, id: topicId(t) }));
}

/** Public, storable shape of a topic (post.topic). */
export function topicRef(t) {
  return { id: t.id, title: t.title, url: t.url ?? null, source: t.source ?? null, kind: t.kind };
}
