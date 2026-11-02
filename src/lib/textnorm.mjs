// Language-aware text normalization for matching (novelty shingles, catchphrases, idea usage, hash
// embeddings). Latin: lowercase + strip diacritics. Hebrew: strip niqqud/cantillation, geresh and
// gershayim (and ASCII ' " used as them), fold final letters, and peel the one-letter prefixes
// ו ה ב ל מ ש כ, so "ירושלים של זהב", "בִּירוּשָׁלַיִם שֶׁל זָהָב" and "וירושלים של-זהב" normalize alike.
const HEB_LETTER = /[\u05D0-\u05EA]/;
const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const PREFIX = new Set(['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ']);
const EN_STOP = new Set('the a an and or of to in on for with is are was were be it this that at by as from but not no so if do does did i you he she we they me my your our their its'.split(' '));
// Folded (final letters normalized) Hebrew function words.
const HE_STOP = new Set('של את על זה זו זאת לא כי גמ אמ מה יש אינ הוא היא אני אתה את המ הנ אנחנו עמ כל או רק עוד כמו אבל אז פה שמ מי לי לו לה לכ לנו אותו אותה כנ אכ הזה הזאת יותר מאוד אלה אלו היה הייתי'.split(' '));

export const isHebrew = (w) => HEB_LETTER.test(w);

/** Fold a text for matching: lowercase, no Latin diacritics, no Hebrew points/geresh, final letters folded. */
export function foldText(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, '')
    .replace(/[\u05BE\u05C0\u05C3\u05C6]/g, ' ')
    .replace(/[\u05F3\u05F4]/g, '')
    .replace(/([\u05D0-\u05EA])['"’”]+(?=[\u05D0-\u05EA])/g, '$1')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .toLowerCase();
}

// Which prefix may follow another (וה, וב, שב, מה, כש...); keeps "להיות" from losing its ה.
const SECOND = { ו: 'הבלכמ', ש: 'הבלכמ', מ: 'ה', כ: 'ש', ה: '', ב: '', ל: '' };
const SHORT_STEMS = new Set('על את לא כי גמ אמ מה זה זו מי רק כל'.split(' '));

/** Peel one-letter Hebrew prefixes (up to two, in a valid order), keeping a stem of at least 3 letters. */
export function hebStem(w) {
  if (w.length === 3 && PREFIX.has(w[0]) && SHORT_STEMS.has(w.slice(1))) return w.slice(1);
  if (w.length < 4 || !PREFIX.has(w[0])) return w;
  let s = w.slice(1);
  if (s.length >= 4 && SECOND[w[0]].includes(s[0])) s = s.slice(1);
  return s;
}

/** All words (folded, Hebrew stemmed), stopwords kept, Latin apostrophes kept ("don't"): n-gram shingles, phrases. */
export function words(s) {
  return foldText(s)
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => (isHebrew(w) ? hebStem(w.replace(/'/g, '')) : w))
    .filter((w) => w && w !== "'");
}

/** Content tokens: no stopwords; Latin words of 3+ letters, Hebrew stems of 2+. */
export function tokens(s) {
  return foldText(s)
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => (isHebrew(w) ? hebStem(w) : w))
    .filter((w) => (isHebrew(w) ? w.length >= 2 && !HE_STOP.has(w) : w.length > 2 && !EN_STOP.has(w)));
}

/** A "long" content word (shingles need a few of these): Latin 4+ letters, Hebrew 3+. */
export const isLongWord = (w) => w.length >= (isHebrew(w) ? 3 : 4);

/** Distinctive key words (idea usage): Latin 5+ letters, Hebrew 4+. */
export const isKeyWord = (w) => w.length >= (isHebrew(w) ? 4 : 5);

// Hebrew plene/defective spelling (תקוותנו / תקותנו): compare without inner ו/י.
const skel = (w) => (isHebrew(w) && w.length > 2 ? w[0] + w.slice(1).replace(/[וי]/g, '') : w);

/** Compile a plain phrase into a matcher over normalized word sequences (any prefix/niqqud/spelling form). */
export function phraseMatcher(phrase) {
  const want = words(phrase).map(skel);
  if (!want.length) return null;
  return (text) => {
    const w = words(text).map(skel);
    outer: for (let i = 0; i + want.length <= w.length; i++) {
      for (let j = 0; j < want.length; j++) if (w[i + j] !== want[j]) continue outer;
      return true;
    }
    return false;
  };
}
