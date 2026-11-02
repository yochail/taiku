// Self-biography detector: a persona narrating its own Wikipedia ("I split the sea", "I founded the
// state in Basel", "my dictionary") instead of being the character today. Language-aware (Hebrew and
// English), site-agnostic, deterministic. A taik is a self-bio hit when, outside quotation marks:
//  A. it puts a distinctive verb of the persona's own `background` in the first person past
//     (background "ייסד עיתונים" → "ייסדתי"; "founded the Academy" → "I founded"), or
//  B. a first-person cue (a 1sg past verb, "כשאני / כשהייתי / פעם אני", "when I", "I once",
//     "my book / המילון שלי / בספרי") co-occurs with an anchor of the persona's famous life or work:
//     a distinctive token of `background`, a `key_works` title, or
//  C. a curated `signature_episodes` pattern (sites/<id>/ideas/<persona>.json) appears in a
//     first-person taik.
// Each hit carries an `episode` label (the background clause, work title or curated episode) so the
// same signature episode can be rate-limited. Caps (spec.sampling.self_bio): a persona's share, the
// site-wide share, and one telling of the same episode per persona per window.
import { ideaFile } from './ideas.mjs';
import { foldText, isHebrew, phraseMatcher, words } from './textnorm.mjs';

const DAY = 864e5;
export const SELF_BIO_DEFAULTS = {
  persona_max_share: 0.1,
  site_max_share: 0.05,
  episode_window_days: 14,
  share_window_days: 14,
  persona_min_items: 10,
  small_persona_max: 1,
  max_anchor_df: 3,
};
export const selfBioConfig = (spec) => ({ ...SELF_BIO_DEFAULTS, ...(spec?.sampling?.self_bio ?? {}) });

// Folded Hebrew words ending in תי that are not first-person past verbs.
const HE_NOT_VERB = new Set('אותי איתי אתי מתי שתי עתי אמיתי דתי חברתי ממלכתי מסורתי תרבותי דעתי אשתי בתי ביתי עדתי כיתתי שיטתי בעייתי בעיתי חוקתי לאומיתי עממיתי אישיותי סטטיסטי רגעיתי תכליתי ספרותי מהותי סמכותי כמותי איכותי מלכותי ייחודיתי אכפתי גברתי מחשבתי רוחניתי פוליטי ביתי נשמתי אופנתי מעמדתי עמדתי בעמדתי מקצועיתי'.split(' '));
// Background verbs too generic to mark a life episode on their own (skeletons).
const HE_GENERIC = new Set('היה אמר ראה הלכ בא עשה נתנ ידע חשב רצה יכל נולד מת חי גר עבד למד לימד שאל ענה קרא כתב'.split(' ').map((w) => skelOf(w)));
const HE_STOP = new Set('של את על זה זו זאת לא כי גמ אמ מה יש אינ הוא היא אני אתה המ הנ אנחנו עמ כל או רק עוד כמו אבל אז פה שמ מי לי לו לה לכ לנו אותו אותה כנ אכ הזה הזאת יותר מאוד אלה אלו היה בינ אחרי לפני תוכ ידי בידי שנה שנת שנות שנים בנ בת ישראל יהודי יהודים היהודי היהודית עברית העברית ימי בימי תריא מציגה אותו אותה כמו בלי'.split(' '));
const HE_CUE = /(?:^|[\s,.;:!?(״"'׳-])(?:כש(?:אני|הייתי|כתבתי|קמתי)|פעם\s+(?:אני|הייתי)|גם\s+אני\s+\S+תי|אני\s+(?:זה\s+)?ש\S+תי|אני\s+הייתי|אני\s+\S+תי|בזמני|בימיי|אצלי\s+ב)/u;
const HE_WORK_NOUN = '(?:ספר|ספרון|ספרים|מילון|שיר|שירים|נאום|נאומים|מכתב|מכתבים|מאמר|מאמרים|פסק|פסקים|תוכנית|חזון|יומן|יומנים|מחזה|רומן|סיפור|סיפורים|פירוש|חיבור|משנה|תורה|שיטה|ישיבה|עיתון|קונגרס|מסע|מסעות|מלחמה|מרד|מגילה|מגילות|הלכות|תשובה|תשובות)';
const finals = (x) => x.replace(/[ךםןףץ]/g, (c) => 'כמנפצ'['ךםןףץ'.indexOf(c)]);
const HE_MY_WORK = new RegExp(finals(`(?:(?:ב|ה|מ|ל|ו|ש)?${HE_WORK_NOUN}\\s+שלי|(?:^|[\\s,.;:!?(])(?:(?:ב|מ|ל|ו|ה)?(?:מילוני|יומני|חזוני|משנתי|ספריי|ספרוני)(?=$|[\\s,.;:!?)])|(?:ב|מ|ל|ו|ה)?(?:ספרי|שירי|נאומי|מכתבי|מאמרי|פירושי|חיבורי)(?=\\s*(?:$|[,.;:!?)]|ש(?:כתבתי|פרסמתי)))))`), 'u');
const EN_IRREGULAR = new Set('wrote written built led ran fought won lost saw took brought gave made went came spent broke split threw drank taught told sat stood began sang drew found held kept left met paid sent sold spoke swore understood was were done been seen given taken spoken drunk sung begun fled hid rode bore shook struck stole chose flew forgave forgot froze grew knew laid lay rose sank slew sought sprang strove swam swung tore thrust wove wept withdrew became overcame'.split(' '));
const EN_NOT_PAST = new Set('need feed proceed succeed exceed bleed breed heed seed speed indeed embed shed red bed wed'.split(' '));
const EN_GENERIC = new Set('was were said did made went saw got came knew thought wanted could would been done told asked tried used called seemed liked loved hated felt looked meant read heard found kept left gave took'.split(' '));
const EN_CUE = /\b(?:when I|back when I|I once|I used to|in my day|in my time|back in my|I was the one who|I'm the one who)\b/i;
const EN_WORK_NOUN = /\bmy (?:own )?(?:book|books|dialogue|dialogues|dictionary|poem|poems|novel|novels|treatise|essay|essays|speech|speeches|trial|theory|letters|diary|diaries|play|plays|manifesto|meditations|ruling|commentary|commentaries|works|masterpiece|lectures|sermon|sermons|symphony|paintings|painting|discovery|experiment|expedition|voyage|campaign|army|reign|empire|revolution|movement|congress|journal|notebooks|equations?|proof|invention|patent)\b/i;

const PREF = 'והבלמשכ';
/** A folded Hebrew word and its forms without one or two one-letter prefixes (stem ≥ 3 letters). */
function variants(w) {
  const out = [w];
  if (w.length >= 4 && PREF.includes(w[0])) {
    out.push(w.slice(1));
    if (w.length >= 5 && PREF.includes(w[1])) out.push(w.slice(2));
  }
  return out;
}
const heWords = (s) => foldText(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w && isHebrew(w));

function skelOf(w) {
  if (!isHebrew(w) || w.length <= 2) return w;
  return w[0] + w.slice(1).replace(/[וי]/g, '');
}

// Text outside quotation marks (verified quotes are governed elsewhere), without @handles and URLs.
// `keep(q)` keeps a quoted span (e.g. the persona's own work title: ״מדינת היהודים״).
export function unquoted(text, keep = null) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\p{L}\p{M}\p{N}_]+/gu, ' ')
    .replace(/(^|[\s(\[:,;—–-])[״"“„]([^״"”“\n]{2,240}?)[״"”](?=$|[\s.,;:!?)\]…\-–—]|[\u{1F300}-\u{1FAFF}\u2600-\u27BF])/gu, (m, pre, q) => (keep?.(q) ? `${pre}${q} ` : `${pre} `))
    .replace(/(^|[\s(])[‘'](?![\u05D0-\u05EA]{1,2}[\s,.])([^’'\n]{3,200}?)[’'](?=$|[\s.,;:!?)])/gu, '$1 ');
}

const enWords = (s) => foldText(s).split(/[^a-z']+/).filter(Boolean);

/** 1sg past forms in a text: Hebrew folded words ending in תי (stems), English "I <past>". */
function firstPersonPast(text) {
  const he = [];
  // Conditional "הייתי רוצה / אומר" is not a past deed.
  const heText = String(text).replace(/(?:^|\s)(?:ו|ש)?הייתי\s+(?:רוצה|אומר|אומרת|מציע|מציעה|ממליץ|ממליצה|שמח|שמחה|מוסיף|מוסיפה|עושה|נותן|נותנת)/gu, ' ');
  for (const w of heWords(heText)) {
    if (w.length < 5 || !w.endsWith('תי')) continue;
    const vs = variants(w);
    if (vs.some((v) => HE_NOT_VERB.has(v))) continue;
    he.push({ form: w, skels: vs.map((v) => v.slice(0, -2)).filter((v) => v.length >= 2).map(skelOf) });
  }
  const en = [];
  for (const m of String(text).matchAll(/\bI(?:'ve|'d| have| had| once| also| even| literally| actually| already| personally| myself| then| too)?\s+(?:[a-z]+ly\s+)?([a-z]+)\b/gi)) {
    const w = m[1].toLowerCase();
    if ((w.endsWith('ed') && w.length > 3 && !EN_NOT_PAST.has(w)) || EN_IRREGULAR.has(w)) en.push(w);
  }
  return { he, en };
}

/** Skeletons a 1sg past could map to from one background word (prefixes peeled; fem/ל"ה final ה dropped). */
function bgSkels(w) {
  const out = new Set();
  for (const v of variants(w)) {
    if (v.length < 3) continue;
    out.add(skelOf(v));
    if (v.endsWith('ה')) out.add(skelOf(v.slice(0, -1)));
  }
  return out;
}
/** Anchor keys of a Hebrew word (itself and without prefixes, 4+ letters, not a stopword). */
const heKeys = (w) => variants(w).filter((v) => v.length >= 4 && !HE_STOP.has(v)).map(skelOf);

const clauses = (s) => String(s ?? '').split(/[.;:!?\n]|,\s+(?=\S)|\s+ו(?=[\u05D0-\u05EA]{3,}\s)/u).map((c) => c.trim()).filter((c) => c.length >= 6);
const shortLabel = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 80);
const lifeText = (p) => [p.background, p.bio].filter(Boolean).join('. ');

/** Document frequency of anchor keys over every persona's background + bio (distinctiveness). */
function backgroundDf(personas) {
  const df = new Map();
  for (const p of personas) {
    const seen = new Set();
    const t = lifeText(p);
    for (const w of heWords(t)) for (const k of [...heKeys(w), ...bgSkels(w)]) seen.add(k);
    for (const w of enWords(t)) seen.add(w);
    for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1);
  }
  return df;
}

const EN_STOPISH = new Set('about after again against among around because before being between during known later often other since still their there these those through under until where which while whose would could should every early first great people world years never always'.split(' '));
const enAnchor = (w) => w.length >= 5 && !EN_GENERIC.has(w) && !EN_IRREGULAR.has(w) && !EN_STOPISH.has(w);

/**
 * Compiled self-bio profile for one persona: life verbs (A), anchors (B) and curated episodes (C).
 * Life text = background + bio; `df` = backgroundDf(all personas) keeps anchors distinctive in the site.
 */
export function selfBioProfile(persona, { df = null, cfg = SELF_BIO_DEFAULTS } = {}) {
  const maxDf = cfg.max_anchor_df ?? SELF_BIO_DEFAULTS.max_anchor_df;
  const distinct = (k) => !df || (df.get(k) ?? 0) <= maxDf;
  const verbs = new Map();
  const enVerbs = new Map();
  const anchors = new Map();
  const setOnce = (m, k, v) => {
    if (!m.has(k)) m.set(k, v);
  };
  for (const c of clauses(lifeText(persona))) {
    const label = shortLabel(c);
    for (const w of heWords(c)) {
      if (HE_STOP.has(w)) continue;
      for (const s of bgSkels(w)) if (s.length >= 2 && !HE_GENERIC.has(s) && distinct(s)) setOnce(verbs, s, label);
      for (const k of heKeys(w)) if (distinct(k)) setOnce(anchors, k, label);
    }
    for (const w of enWords(c)) {
      if (w.length >= 4 && !EN_GENERIC.has(w) && (w.endsWith('ed') || EN_IRREGULAR.has(w)) && distinct(w)) setOnce(enVerbs, w, label);
      if (enAnchor(w) && distinct(w)) setOnce(anchors, w, label);
    }
  }
  const works = [];
  for (const k of persona.key_works ?? []) {
    const title = String(k?.title ?? k ?? '').replace(/[()]/g, ' ').trim();
    if (!title) continue;
    const label = shortLabel(title);
    const test = words(title).length >= 2 ? phraseMatcher(title) : null;
    if (test) works.push({ label, test });
    for (const w of heWords(title)) for (const key of heKeys(w)) setOnce(anchors, key, label);
    for (const w of enWords(title)) if (enAnchor(w)) setOnce(anchors, w, label);
  }
  const episodes = (ideaFile(persona).signature_episodes ?? []).flatMap((e) => {
    try {
      return [{ label: e.label, re: new RegExp(e.pattern, 'iu') }];
    } catch {
      return [];
    }
  });
  return { id: persona.id, verbs, enVerbs, anchors, works, episodes };
}

/** Self-bio verdict for one text: null, or { episode, via: 'episode'|'verb'|'anchor', cue }. */
export function selfBioHit(text, profile) {
  if (!profile) return null;
  const body = unquoted(text, (q) => q.trim().split(/\s+/).length <= 4 && profile.works.some((w) => w.test(q)));
  if (!body.trim()) return null;
  const folded = foldText(body);
  const fp = firstPersonPast(body);
  const heCue = HE_CUE.exec(folded)?.[0]?.trim() ?? HE_MY_WORK.exec(folded)?.[0]?.trim() ?? null;
  const enCue = EN_CUE.exec(body)?.[0] ?? EN_WORK_NOUN.exec(body)?.[0] ?? null;
  const firstPerson =
    fp.he.length || fp.en.length || heCue || enCue ||
    /(?:^|[\s,.;:!?(])(?:ו|ש|כש)?(?:אני|אנכי|אנוכי|שלי|אותי|עצמי)(?=$|[\s,.;:!?)])/u.test(folded) ||
    /\b(?:I|my|me|mine)\b/.test(body);
  if (!firstPerson) return null;
  // C: a curated signature episode in a first-person taik.
  for (const e of profile.episodes) if (e.re.test(body) || e.re.test(folded)) return { episode: e.label, via: 'episode', cue: e.label };
  // A: a distinctive verb of the persona's life put in the first person past.
  for (const v of fp.he) for (const s of v.skels) if (profile.verbs.has(s)) return { episode: profile.verbs.get(s), via: 'verb', cue: v.form };
  for (const v of fp.en) if (profile.enVerbs.has(v)) return { episode: profile.enVerbs.get(v), via: 'verb', cue: 'I ' + v };
  // B: a first-person deed cue + an anchor of the famous life or work.
  const cue = fp.he[0]?.form ?? (fp.en[0] ? 'I ' + fp.en[0] : null) ?? heCue ?? enCue;
  if (!cue) return null;
  for (const w of profile.works) if (w.test(body)) return { episode: w.label, via: 'anchor', cue };
  for (const w of heWords(body)) for (const k of heKeys(w)) if (profile.anchors.has(k)) return { episode: profile.anchors.get(k), via: 'anchor', cue };
  for (const w of enWords(body)) if (profile.anchors.has(w)) return { episode: profile.anchors.get(w), via: 'anchor', cue };
  return null;
}

/** Profiles for a persona set (news accounts get none). */
export function selfBioProfiles(personas, cfg = SELF_BIO_DEFAULTS) {
  const df = backgroundDf(personas);
  return new Map(personas.filter((p) => (p.kind ?? 'thinker') !== 'news').map((p) => [p.id, selfBioProfile(p, { df, cfg })]));
}

const judged = (p, profiles) => p && p.text && !p.retaikOf && profiles.has(p.authorId) && !Number.isNaN(Date.parse(p.createdAt));

/**
 * Scan posts for self-biography. `isTarget(p)` limits which items are judged as offenders (others
 * still count as history and towards shares). Returns:
 *   hits:       [{ postId, personaId, createdAt, episode, via, cue }] for every judged-or-history item
 *   site:       { n, k, share, max, over }
 *   personas:   [{ personaId, n, k, share, allowed, over }] sorted by share desc
 *   offenders:  [{ postId, personaId, reason: 'self_bio_share'|'self_bio_episode'|'self_bio_site', episode, otherId? }]
 */
export function scanSelfBio(posts, { personas, cfg = SELF_BIO_DEFAULTS, isTarget = () => true, profiles = selfBioProfiles(personas, cfg) }) {
  const items = posts.filter((p) => judged(p, profiles)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  const hits = [];
  const byPersona = new Map();
  for (const p of items) {
    const row = byPersona.get(p.authorId) ?? byPersona.set(p.authorId, { n: 0, k: 0, nT: 0, hits: [] }).get(p.authorId);
    row.n++;
    if (isTarget(p)) row.nT++;
    const h = selfBioHit(p.text, profiles.get(p.authorId));
    if (!h) continue;
    const hit = { postId: p.id, personaId: p.authorId, createdAt: p.createdAt, target: Boolean(isTarget(p)), ...h };
    hits.push(hit);
    row.k++;
    row.hits.push(hit);
  }
  const allowedFor = (n) => (n >= cfg.persona_min_items ? Math.floor(cfg.persona_max_share * n + 1e-9) : cfg.small_persona_max);
  const offenders = new Map();
  const flag = (h, reason, extra = {}) => {
    if (!h.target || offenders.has(h.postId)) return;
    offenders.set(h.postId, { postId: h.postId, personaId: h.personaId, reason, episode: h.episode, ...extra });
  };
  // Same episode by the same persona within the window: every retelling after the first.
  for (const row of byPersona.values()) {
    for (let i = 0; i < row.hits.length; i++) {
      const h = row.hits[i];
      const t = Date.parse(h.createdAt);
      const prev = row.hits.slice(0, i).reverse().find((o) => o.episode === h.episode && Date.parse(o.createdAt) >= t - cfg.episode_window_days * DAY);
      if (prev) flag(h, 'self_bio_episode', { otherId: prev.postId });
    }
  }
  const personasOut = [];
  for (const [pid, row] of byPersona) {
    const allowed = allowedFor(row.n);
    const over = row.k > allowed;
    personasOut.push({ personaId: pid, n: row.n, k: row.k, share: row.n ? row.k / row.n : 0, allowed, over });
    // Over the persona cap: the latest hits beyond the allowance.
    if (over) row.hits.slice(allowed).forEach((h) => flag(h, 'self_bio_share'));
  }
  personasOut.sort((a, b) => b.share - a.share || b.k - a.k || a.personaId.localeCompare(b.personaId));
  const n = items.length;
  const k = hits.length;
  const siteAllowed = Math.floor(cfg.site_max_share * n + 1e-9);
  const site = { n, k, share: n ? k / n : 0, max: cfg.site_max_share, allowed: siteAllowed, over: k > siteAllowed };
  if (site.over) {
    // Site over cap: the remaining target hits from the highest-share personas first, until under.
    let excess = k - siteAllowed - [...offenders.values()].length;
    const rank = new Map(personasOut.map((r, i) => [r.personaId, i]));
    const rest = hits.filter((h) => h.target && !offenders.has(h.postId)).sort((a, b) => rank.get(a.personaId) - rank.get(b.personaId) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const h of rest) {
      if (excess-- <= 0) break;
      flag(h, 'self_bio_site');
    }
  }
  return { hits, site, personas: personasOut, offenders: [...offenders.values()] };
}

/** Repair hint for the generator (prefixed "House style:" so repair loops treat it as style). */
export const selfBioRepair = (episode) =>
  `House style: you are retelling your own biography${episode ? ` ("${String(episode).slice(0, 60)}")` : ''}. Don't narrate what you once did, wrote or founded. Be the character NOW: react to today's news, people and thread with your temperament, values, obsessions and humor. Say what you think, not what you did.`;
