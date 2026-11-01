// Policy gate (eng P0.5 / security B1): an output filter applied to EVERY generated taik before it
// can be written. Fails closed: the caller drops the whole topic if a topic post still fails after
// one repair. Checks text plus original.text, poll options, note and media text.
import { isGrave } from './themes.mjs';
import { readJson, sha256 } from './pipeline-util.mjs';
import { ROOT } from './data.mjs';
import path from 'node:path';

/** Names in the public-domain art library (dead painters, artwork titles) are historical, not living people. */
function libraryCorpus() {
  const lib = readJson(path.join(ROOT, 'media', 'library.json'), {}) ?? {};
  const credits = readJson(path.join(ROOT, 'media', 'art-credits.json'), {}) ?? {};
  const out = [];
  for (const a of lib.art ?? []) out.push(a.title, a.artist, a.alt);
  for (const c of Object.values(credits)) out.push(c?.author, c?.commons_artist);
  for (const m of lib.memes ?? []) out.push(m.title, m.name);
  return out.filter((x) => typeof x === 'string');
}

// Slurs are stored as sha256 prefixes so the list itself isn't a slur dump. Matched per token
// (lowercased, letters only, with/without a trailing "s").
const SLUR_HASHES = new Set(['120f6e5b4ea32f65', '08a841e996781e9e', '8f5083e3e5c7dc89', '9915ba2d822280f2', 'c3de533e9b7fe63b', '98b52c4b6b7d1f48', 'f9d0d9b18ae9033a', 'cc02032349c833ac', 'eef3bd091670c344', '16ea09fc78ca83ca', '158869a97379229b', '886d51e97ad7931d', 'e7b98c6aa5b944e0', '22fc75e65a0e9d34', '333f7618092958c7', 'dc675e448132fd2a', '12e6274e4309293e', '3b1e0d7c5dd45583', '3c8400b402baa7f1', '33740da8a87dc7de', '267463e5e36cd787', 'dcb85fcf872ebfc6', '0be9b885f4a35a18', '619bc82e0d200e4a', 'be00f1af522eaa99', '27a62b68179c96f5', 'f64c6fad9c3c8b57', '27eb0c4ad7072067']);
const SEXUAL = /\b(porn\w*|nude\w*|naked|blowjob\w*|handjob\w*|orgasm\w*|masturbat\w*|dildo\w*|cum(?:shot|ming)?|horny|erection\w*|boner\w*|onlyfans|nsfw|sext\w*|genitals?|penis\w*|vagina\w*|clit\w*|tits|titties|boobs?|anal|rape\w*|rapist\w*|molest\w*|incest\w*|pedo\w*|paedo\w*|bdsm|hentai|xxx)\b/i;
const GORE = /\b(gore|gory|disembowel\w*|decapitat\w*|behead\w*|dismember\w*|entrails|guts spilling|brains? (?:splattered|blown out)|blood[- ]soaked|mutilat\w*|corpses?|torture porn|flay\w*)\b/i;
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:com|org|net|io|ai|app|co|uk|gov|edu|ly|gg|xyz|tv|me|news|info|biz|dev)\b)/i;
const JOKE = /(\blol\b|\blmao\b|\blmfao\b|\brofl\b|haha|\bratio\b|💀|😂|🤣|😭|\bskill issue\b|\bcope\b|\bL\b)/i;
const SELF_HARM = /\b(kill (?:your|ur)self|kys|unalive (?:your|ur)self|go die)\b/i;

/** Capitalised words that start "names" but aren't people (sentence-level noise). */
const COMMON_CAPS = new Set('I A An The This That These Those It Its He She They We You Me My Your Our Their His Her Him Them Us Me Nobody Everyone Someone Anyone Nothing Everything Real Hot Take Daily Breaking News Community Note Notes Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December God Lord Heaven Hell Truth Being Nature Reason Virtue Justice State Republic Senate Parliament Congress Court Supreme Union European EU UN US USA UK America American Americans Europe Asia Africa China Chinese Japan Japanese India Indian Greece Greek Greeks Rome Roman Romans Athens Athenian Paris France French Germany German Britain British England English London Washington Silicon Valley Wall Street Internet AI App Apple Google Meta Amazon Microsoft OpenAI Tesla Netflix Spotify Reddit Twitter X TikTok Instagram YouTube Facebook Bitcoin Crypto Mars Moon Earth Sun Olympics World Cup Premier League NFL NBA FIFA Hacker Show HN TIL Plato Socrates Aristotle Buddha Jesus Christ Moses Muhammad Allah Zeus Sisyphus Prometheus Oedipus Hamlet Shakespeare Homer Dante Kant Hegel Marx Nietzsche Freud Einstein Darwin Newton Galileo Descartes Hume Locke Hobbes Rousseau Voltaire Spinoza Leibniz Machiavelli Confucius Laozi Mencius Zhuangzi Stoics Stoic Cynic Cynics Epicurean Bible Quran Torah Gospel Ethics Politics Republic Analects Meditations Daodejing Tao Dao Zen Me Okay OK Ok No Yes Not Also And But Or So If When Why What How Who Where Day Night Week Year Today Tomorrow Yesterday Breaking Update Thread Poll Chart Meme Imagine Plot Twist Me Nobody'.split(' '));

/** Capitalised multi-word sequences that look like a person's name ("Elon Musk", "Taylor Swift"). */
export function nameCandidates(text, commonWords = new Set()) {
  const out = [];
  const re = /\b([A-Z][a-z'’]+(?:[-\s](?:[A-Z][a-z'’]+|de|da|van|von|al|bin|ibn|di|le|la)){1,3})\b/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const words = m[1].split(/[-\s]+/).filter((w) => /^[A-Z]/.test(w));
    const meaningful = words.filter((w) => !COMMON_CAPS.has(w.replace(/['’]s$/, '')) && !commonWords.has(w.toLowerCase()));
    if (meaningful.length >= 2) out.push(meaningful.join(' '));
  }
  return out;
}

const lower = (s) => String(s ?? '').toLowerCase();

/**
 * Build the policy context once per run: persona ids/handles, an allowlist of names from persona
 * data (names, works, rivals, ideas — historical figures and titles are fine), and extra names.
 */
export function policyContext(personas, { allowNames = [] } = {}) {
  const handles = new Set();
  const corpus = [];
  for (const p of personas) {
    handles.add(lower(p.id));
    handles.add(lower(p.handle));
    corpus.push(p.name, p.bio, p.headline, p.background, p.school, p.tradition, ...(p.key_works ?? []).map((w) => (typeof w === 'string' ? w : `${w.title ?? ''}`)), ...(p.core_ideas ?? []).map(String), ...(p.sources ?? []).map((s) => `${s.title} ${s.author ?? ''} ${s.translator ?? ''}`), ...(p.quotables ?? []).map((q) => `${q.citation ?? ''} ${q.context ?? ''}`), ...(p.anchors ?? []).map((a) => `${a.work} ${a.idea}`), ...(p.system_prompt ?? []),
      ...(p.quotables ?? []).map((q) => q.text), ...(p.quote_bank ?? []).map((q) => `${q.work ?? ''} ${q.section ?? ''} ${q.text ?? ''}`), ...(p.native_language?.phrases ?? []).map((x) => `${x.text} ${x.translation ?? ''}`));
  }
  const raw = corpus.filter(Boolean).join(' ');
  const allow = lower(`${raw} ${libraryCorpus().join(' ')} ${allowNames.join(' ')}`);
  // Words that appear in lowercase somewhere in persona prose are ordinary English words
  // ("dear", "supposed", "right"), so a capitalised "Dear Emperor" is not a person's name.
  const commonWords = new Set((raw.match(/(?<![\p{L}])[a-z][a-z'’]+/gu) ?? []).filter((w) => w.length > 1));
  return { handles, allow, commonWords, allowWords: new Set(allow.split(/[^\p{L}'’]+/u)), allowNames: allowNames.map(lower) };
}

function slurHit(text) {
  for (const tok of lower(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/)) {
    if (!tok) continue;
    for (const t of [tok, tok.replace(/s$/, ''), tok.replace(/es$/, '')]) if (SLUR_HASHES.has(sha256(t).slice(0, 16))) return true;
  }
  return false;
}

/** All text surfaces of a post the model wrote. */
export function surfaces(post) {
  const out = [['text', post.text]];
  if (post.original?.text) out.push(['original', post.original.text]);
  for (const o of post.poll?.options ?? []) out.push(['poll', o.text]);
  for (const m of post.media ?? []) {
    const r = m.render ?? {};
    out.push(['media', [m.alt, r.title, r.caption, r.text, ...(r.lines ?? []), ...(r.labels ?? [])].filter(Boolean).join(' \n ')]);
  }
  return out.filter(([, t]) => t);
}

/**
 * Check one generated post. `topic` = the topic it reacts to (title is the living-person allowlist
 * for that topic). Returns { ok, violations: [{ rule, where, detail }] }.
 */
export function checkPost(post, ctx, { topic = null, parentText = '' } = {}) {
  const v = [];
  const topicText = lower(`${topic?.title ?? ''} ${parentText}`);
  const topicWords = new Set(topicText.split(/[^\p{L}'’]+/u));
  // Verified source passages (canonical text set from this turn's tool log) are historical text.
  const verified = lower([...(post.quoteRefs ?? []).map((q) => q.canonical ?? ''), post.note?.text ?? ''].join(' '));
  for (const [where, raw] of surfaces(post)) {
    const t = String(raw);
    if (URLISH.test(t)) v.push({ rule: 'url', where, detail: t.match(URLISH)[0] });
    for (const m of t.matchAll(/@([A-Za-z0-9_]{1,30})/g)) if (!ctx.handles.has(lower(m[1]))) v.push({ rule: 'handle', where, detail: `@${m[1]}` });
    if (slurHit(t)) v.push({ rule: 'slur', where, detail: 'blocklisted term' });
    if (SEXUAL.test(t)) v.push({ rule: 'sexual', where, detail: t.match(SEXUAL)[0] });
    if (GORE.test(t)) v.push({ rule: 'gore', where, detail: t.match(GORE)[0] });
    if (SELF_HARM.test(t)) v.push({ rule: 'self-harm', where, detail: t.match(SELF_HARM)[0] });
    if (isGrave(t) && JOKE.test(t)) v.push({ rule: 'tragedy-mockery', where, detail: 'grave event + joke marker' });
    if (where !== 'original') {
      for (const name of nameCandidates(t, ctx.commonWords)) {
        const n = lower(name);
        const parts = n.split(' ');
        const known = topicText.includes(n) || verified.includes(n) || ctx.allow.includes(n) || ctx.allowNames.some((a) => a.includes(n)) || parts.every((w) => topicWords.has(w) || ctx.allowWords.has(w));
        if (!known) v.push({ rule: 'living-person', where, detail: name });
      }
    }
  }
  if (topic && isGrave(topic.title)) v.push({ rule: 'tragedy-topic', where: 'topic', detail: topic.title.slice(0, 60) });
  return { ok: v.length === 0, violations: v };
}

/** Short human-readable repair hint for a failed check. */
export const repairHint = (violations) =>
  `Your draft broke the content policy (${[...new Set(violations.map((x) => x.rule))].join(', ')}). Rewrite it: no URLs or domains, no @handles except Taiku personas, no slurs/sexual/gore terms, no mocking of tragedies, and name living people only if they are in the headline.`;
