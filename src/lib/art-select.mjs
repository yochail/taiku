// Art selector for `image` media: matches a post (text, topic/news, mood, persona) to the
// public-domain art library (media/art-library.json + the legacy media/library.json art) by tags,
// title and alt text, and never offers a picture the corpus already uses — every image is unique.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sitePath } from './site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STOP = new Set('a an and are as at be but by for from has have i in is it its me my of on or so that the this to was we what when with you your not just like all about out up one can will do how why who more than then them they our us his her he she been were had there their into over only very also any some no yes'.split(' '));
const words = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]{3,}/g) ?? [];
const stem = (w) => w.replace(/(ies|es|s|ing|ed|ly)$/, '').slice(0, 7);

// Post words -> library themes/moods they should pull in.
const SYN = {
  ai: ['technology', 'inventions', 'computing', 'science'], computer: ['computing', 'technology'], code: ['computing', 'technology'],
  tech: ['technology', 'inventions'], robot: ['technology', 'inventions'], data: ['computing', 'maps'], internet: ['technology', 'crowd'],
  market: ['market', 'work'], money: ['market', 'work'], econom: ['market', 'work', 'city'], price: ['market'], stock: ['market', 'crowd'],
  inflation: ['market'], job: ['work'], work: ['work', 'labor'], tired: ['sleep', 'tired'], sleep: ['sleep', 'tired'], monday: ['tired', 'work'],
  space: ['cosmos', 'astronomy'], star: ['astronomy', 'night'], moon: ['moon', 'night'], planet: ['astronomy', 'cosmos'], nasa: ['cosmos', 'astronomy'],
  rocket: ['flight', 'cosmos'], universe: ['cosmos'], physic: ['science', 'cosmos'], quantum: ['science', 'cosmos'], math: ['geometry', 'mathematics'],
  proof: ['geometry', 'mathematics'], climate: ['weather', 'storm', 'landscape'], heat: ['sunset', 'landscape'], storm: ['storm', 'weather'],
  rain: ['rain', 'weather'], weather: ['weather'], ocean: ['sea'], sea: ['sea'], war: ['battle', 'soldiers', 'conflict'], elect: ['crowd', 'satire'],
  vote: ['crowd', 'satire'], politic: ['satire', 'crowd', 'caricature'], senat: ['satire', 'rome'], court: ['satire', 'caricature'], law: ['caricature', 'satire'],
  lawyer: ['caricature'], judge: ['caricature'], protest: ['crowd'], crowd: ['crowd'], party: ['feast', 'festive', 'dance'], dinner: ['feast', 'food'],
  food: ['feast', 'food', 'kitchen'], coffee: ['cafe'], wine: ['feast', 'cafe'], book: ['reading', 'books', 'library'], read: ['reading', 'books'],
  write: ['writing', 'letters'], letter: ['letters', 'writing'], poem: ['poetry', 'reading'], poet: ['poetry'], novel: ['reading', 'books'],
  school: ['school', 'education', 'children'], student: ['school', 'scholar'], teach: ['school', 'scholar'], universit: ['scholar', 'academy'],
  cat: ['cats'], dog: ['dogs'], bird: ['birds'], owl: ['owls'], horse: ['horses'], animal: ['animals'], nature: ['nature', 'landscape'],
  garden: ['garden', 'flowers'], flower: ['flowers'], spring: ['garden', 'flowers'], winter: ['winter', 'snow'], snow: ['winter'], summer: ['beach', 'sea'],
  city: ['city', 'street'], travel: ['travel', 'ships', 'trains'], train: ['trains'], ship: ['ships'], flight: ['flight'], plane: ['flight'],
  history: ['ruins', 'history', 'ancient'], ancient: ['ancient', 'ruins'], rome: ['rome', 'ruins'], greek: ['greece', 'ancient'], empire: ['ruins', 'rome'],
  ruin: ['ruins'], collapse: ['ruins', 'impermanence'], fall: ['ruins', 'impermanence'], time: ['time', 'clock'], death: ['melancholy', 'impermanence'],
  sad: ['melancholy', 'thinking'], lonely: ['melancholy', 'night'], anxiety: ['turmoil', 'storm'], chaos: ['chaotic', 'crowd', 'storm'],
  calm: ['calm', 'peaceful'], peace: ['calm', 'peaceful'], meditat: ['thinking', 'calm'], think: ['thinking', 'philosophy', 'scholar'],
  philosoph: ['philosophy', 'scholar'], ethic: ['philosophy'], truth: ['philosophy'], god: ['philosophy', 'cosmos'], soul: ['philosophy', 'contemplative'],
  mind: ['thinking', 'philosophy'], dream: ['dreamy', 'night'], laugh: ['joy', 'laughing', 'lol'], lol: ['laughing', 'joy', 'absurd'],
  funny: ['laughing', 'absurd', 'satire'], absurd: ['absurd', 'satire'], debate: ['argument', 'crowd', 'satire'], argu: ['argument', 'satire'],
  fight: ['conflict', 'battle'], music: ['music'], song: ['music'], concert: ['music'], dance: ['dance'], game: ['games'], sport: ['games', 'crowd'],
  football: ['crowd', 'games'], child: ['children'], kid: ['children'], family: ['family'], love: ['family', 'garden'], friend: ['family', 'cafe'],
  health: ['science'], medic: ['science'], doctor: ['science'], disease: ['science'], evolut: ['animals', 'nature', 'science', 'biology'],
  species: ['animals', 'biology'], insect: ['insects'], map: ['maps'], explor: ['exploration', 'ships', 'maps'], electric: ['electricity', 'technology'],
  power: ['electricity', 'technology'], light: ['astronomy', 'electricity'], photo: ['old photo'], news: ['crowd', 'city'], wait: ['waiting'],
  bored: ['bored', 'waiting'], fog: ['fog'], mountain: ['mountains'], river: ['river'], japan: ['japanese print'], china: ['chinese painting'],
  persia: ['persian painting'], india: ['indian painting'], egypt: ['egypt'], paris: ['paris'], venice: ['venice'], london: ['city', 'street'],
};
const DOMAIN = {
  philosophy: ['philosophy', 'scholar', 'thinking'], science: ['science', 'astronomy', 'inventions'], mathematics: ['geometry', 'mathematics', 'science'],
  literature: ['reading', 'books', 'writing', 'letters'], economics: ['market', 'work', 'city'], politics: ['crowd', 'satire', 'city'],
  psychology: ['portrait', 'thinking', 'dreamy'], technology: ['technology', 'electricity', 'inventions'], arts: ['inventions', 'painting', 'renaissance'],
  medicine: ['science', 'work'], religion: ['medieval', 'contemplative'], strategy: ['battle', 'soldiers', 'maps'],
};

let libCache = null;
/** All pickable art: [{ id, src, width, height, title, artist, alt, tags, terms: Set<stem>, people: Set }]. */
export function artLibrary() {
  if (libCache) return libCache;
  const read = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  const items = [];
  for (const a of read(path.join(ROOT, 'media', 'art-library.json'))?.items ?? []) items.push(a);
  const legacy = read(path.join(ROOT, 'media', 'library.json'));
  const credits = read(path.join(ROOT, 'media', 'art-credits.json')) ?? {};
  for (const a of legacy?.art ?? []) {
    if (credits[a.id]) items.push({ ...a, ...credits[a.id], tags: { themes: a.tags ?? [], mood: [], era: '', people: [] } });
  }
  libCache = items.map((a) => {
    const t = a.tags ?? {};
    const tagTerms = [...(t.themes ?? []), ...(t.mood ?? []), t.era ?? ''].join(' ');
    return {
      ...a,
      terms: new Set(words(tagTerms).map(stem)),
      textTerms: new Set(words(`${a.title} ${a.alt}`).filter((w) => !STOP.has(w)).map(stem)),
      themeSet: new Set([...(t.themes ?? []), ...(t.mood ?? [])].map((x) => x.toLowerCase())),
      people: new Set(t.people ?? []),
      // found by a "<name>" portrait search: a real, named person even when not one of our personas
      namedPortrait: (a.queries ?? []).some((q) => /" portrait$/.test(q)),
    };
  });
  return libCache;
}

/** Corpus-wide used art: Set of art ids and srcs found on image media in the site's posts. */
export function usedArtFromPosts(posts) {
  const used = new Set();
  for (const p of posts) {
    for (const m of (Array.isArray(p.media) ? p.media : p.media ? [p.media] : [])) {
      if (m?.kind !== 'image') continue;
      if (m.render?.art) used.add(m.render.art);
      if (m.src) used.add(m.src);
    }
  }
  return used;
}

let usedCache = null;
/** Art used by the corpus on disk (snapshot taken on first call, so plans and their prompts stay stable within a run). */
export function usedArt() {
  if (usedCache) return usedCache;
  const dir = sitePath('content', 'posts');
  const posts = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        posts.push(...(Array.isArray(j) ? j : j.posts ?? []));
      } catch { /* a malformed file is the validator's problem */ }
    }
  }
  usedCache = usedArtFromPosts(posts);
  return usedCache;
}
const claimed = new Set();
/** Record a pick made in this run (materializeMedia); later claims of the same art get swapped. Plans ignore
 *  these so a resumed run re-plans identically. */
export function markArtUsed(id) {
  const a = artLibrary().find((x) => x.id === id);
  claimed.add(id);
  if (a) claimed.add(a.src);
}
export const isArtUsed = (a, used = usedArt()) => used.has(a.id) || used.has(a.src);
const isTaken = (a) => isArtUsed(a) || isArtUsed(a, claimed);

/** Claim art for a post: the requested id if still free, else the first free alternative, else the best free piece like it. Marks it used. */
export function claimArt(id, { ctx = {}, alternatives = [] } = {}) {
  const byId = (x) => artLibrary().find((y) => y.id === x);
  const a = byId(id);
  const alt = alternatives.map(byId).find((x) => x && !isTaken(x));
  const pick = a && !isTaken(a) ? a : alt ? alt : (shortlistArt({ ...ctx, text: [ctx.text, a?.title, a?.alt].filter(Boolean).join(' ') }, { n: 1, jitter: 0, exclude: [...claimed] })[0] ?? a);
  if (pick) markArtUsed(pick.id);
  return pick?.id ?? id;
}

/** Query terms for a post context: words + synonym-expanded themes + persona domain/people. */
export function artQuery(ctx = {}) {
  const text = [ctx.text, ctx.alt, ctx.topic?.title ?? ctx.topic, ctx.news?.title, ctx.news?.summary, ctx.quote?.text, ...(ctx.tags ?? [])].filter(Boolean).join(' ');
  const ws = words(text).filter((w) => !STOP.has(w));
  const themes = new Map();
  const add = (t, w) => themes.set(t, (themes.get(t) ?? 0) + w);
  for (const w of ws) for (const [k, ts] of Object.entries(SYN)) if (w.startsWith(k)) ts.forEach((t) => add(t, 1));
  if (ctx.mood) add(String(ctx.mood).toLowerCase(), 1.5);
  for (const t of DOMAIN[ctx.persona?.domain] ?? []) add(t, 0.5);
  return { terms: new Set(ws.map(stem)), themes, persona: ctx.persona?.id ?? null, people: new Set(ctx.people ?? []) };
}

/** Relevance of art item a to a query from artQuery(). */
export function scoreArt(a, q) {
  let s = 0;
  for (const [t, w] of q.themes) if (a.themeSet.has(t)) s += 1.5 * w;
  for (const t of q.terms) {
    if (a.terms.has(t)) s += 1;
    else if (a.textTerms.has(t)) s += 0.6;
  }
  if (a.people.size || a.namedPortrait) {
    // A portrait of someone the post isn't about reads as a misattribution: only use it when it fits.
    let hit = false;
    if (q.persona && a.people.has(q.persona)) { s += 3; hit = true; }
    for (const p of a.people) if (q.people.has(p) || q.terms.has(stem(p.split('-').pop()))) { s += 2; hit = true; }
    if (!hit) s -= 3;
  }
  return s;
}

/**
 * Best unused art for a post. ctx: { text?, alt?, topic?, news?, mood?, persona?, tags?, people? }
 * opts: { n = 5, used = usedArt(), exclude = [], rand = Math.random, jitter = 0.8 }
 * Returns up to n items, best first (a little jitter keeps equal scores varied).
 */
export function shortlistArt(ctx = {}, { n = 5, used = usedArt(), exclude = [], rand = Math.random, jitter = 0.8 } = {}) {
  const skip = new Set(exclude);
  const q = artQuery(ctx);
  return artLibrary()
    .filter((a) => !isArtUsed(a, used) && !skip.has(a.id))
    .map((a) => ({ a, s: scoreArt(a, q) + rand() * jitter }))
    .sort((x, y) => y.s - x.s)
    .slice(0, n)
    .map((x) => x.a);
}

/** Optional embedding re-rank (embedder from embed.mjs createEmbedder) of the keyword shortlist. */
export async function rerankArt(ctx, candidates, embedder) {
  if (!embedder?.embed || !candidates.length) return candidates;
  const text = [ctx.text, ctx.alt, ctx.topic?.title ?? ctx.topic, ctx.news?.title].filter(Boolean).join(' ');
  if (!text.trim()) return candidates;
  const vecs = await embedder.embed([text, ...candidates.map((a) => `${a.title}. ${a.alt}. ${[...a.themeSet].join(', ')}`)]);
  if (!vecs) return candidates;
  const cos = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
  return candidates.map((a, i) => ({ a, s: cos(vecs[0], vecs[i + 1]) - i * 0.01 })).sort((x, y) => y.s - x.s).map((x) => x.a);
}
