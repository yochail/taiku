import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchphraseHits, catchphrases, compareNovelty, derivedCatchphrases, fingerprint, modelThreshold, NOVELTY_DEFAULTS, scanRepetition, semanticRepetition } from '../src/lib/ideas.mjs';
import { foldText, phraseMatcher, tokens, words } from '../src/lib/textnorm.mjs';

const shemer = {
  id: 'shemer_t',
  name: 'נעמי שמר',
  key_works: [{ title: 'ירושלים של זהב', note: 'שיר' }, { title: 'לו יהי', note: 'שיר' }],
  quotables: [{ text: 'ירושלים של זהב ושל נחושת ושל אור' }],
  signature_moves: ['"שירו איתי עכשיו."'],
};

test('textnorm: niqqud, gershayim, maqaf, final letters and prefixes fold to one form', () => {
  const forms = ['ירושלים של זהב', 'בִּירוּשָׁלַיִם שֶׁל זָהָב', 'וירושלים של-זהב', '״ירושלים של זהב״', 'ירושלים־של־זהב', 'הירושלים של הזהב'];
  for (const f of forms) assert.deepEqual(words(f), ['ירושלימ', 'של', 'זהב'], f);
  assert.equal(foldText('ה׳'), 'ה');
  assert.equal(foldText('צה"ל'), 'צהל');
  assert.ok(!tokens('של את על זה').length, 'Hebrew stopwords dropped');
});

test('textnorm: Latin behaviour unchanged (diacritics, apostrophes, stopwords)', () => {
  assert.deepEqual(tokens("Dōgen's zazen and the method"), ['dogen', 'zazen', 'method']);
  assert.deepEqual(words("Don't think"), ["don't", 'think']);
  assert.ok(phraseMatcher('I think, therefore I am')('Yes: i THINK therefore i am!'));
});

test('derived catchphrases: songs, quotes, signature lines and the shared Hebrew canon, in every spelling', () => {
  const list = catchphrases(shemer);
  const labels = list.map((c) => c.label);
  assert.ok(labels.includes('ירושלים של זהב'));
  assert.ok(labels.includes('לו יהי'));
  assert.ok(labels.includes('שירו איתי עכשיו'));
  assert.ok(labels.includes('עוד לא אבדה תקוותנו'), 'Hatikvah for Hebrew personas');
  for (const t of ['כתבתי שוב על ירושלים של זהב', 'בִּירוּשָׁלַיִם שֶׁל זָהָב', 'וירושלים, של־זהב'] ) assert.ok(catchphraseHits(t, list).includes('ירושלים של זהב'), t);
  assert.ok(catchphraseHits('עוד לא אָבְדָה תִּקְוָתֵנוּ', list).includes('עוד לא אבדה תקוותנו'), 'defective spelling');
  assert.deepEqual(catchphraseHits('מחירי הדלק עלו', list), []);
  assert.equal(derivedCatchphrases({ name: 'Socrates', quote_bank: [{ text: 'The unexamined life is not worth living' }] })[0].label, 'The unexamined life is');
});

test('catchphrase cap and novelty guard work on Hebrew taiks', () => {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const mk = (i, text) => ({ id: `h${i}`, authorId: 'shemer_t', createdAt: new Date(t0 + i * 864e5).toISOString(), text });
  const posts = [
    mk(0, 'ירושלים של זהב, כתבתי ב־1967 והעיר עוד עומדת על ההרים'),
    mk(1, 'בִּירוּשָׁלַיִם שֶׁל זָהָב עוד מדליקים נרות בחלונות הישנים'),
    mk(2, 'הכנרת יורדת שוב השבוע, החקלאים בעמק מחכים לגשם הראשון של החורף'),
    mk(3, 'והכנרת יורדת שוב השבוע, וחקלאים בעמק מחכים לגשם הראשון בחורף'),
  ];
  const hits = scanRepetition(posts, { personas: [shemer] });
  assert.deepEqual(hits.map((h) => [h.postId, h.reason]), [['h1', 'catchphrase'], ['h3', 'repetitive']]);
  const a = fingerprint(posts[2].text);
  assert.ok(a && compareNovelty(fingerprint(posts[3].text), [{ id: 'x', fp: a }]).repetitive);
});

test('semantic pass: per-language threshold plus shared tokens', () => {
  assert.equal(modelThreshold('ירושלים של זהב ושל נחושת'), NOVELTY_DEFAULTS.model_cosine.he);
  assert.equal(modelThreshold('the unexamined life'), NOVELTY_DEFAULTS.model_cosine.en);
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const p = (i, text) => ({ id: `s${i}`, authorId: 'shemer_t', createdAt: new Date(t0 + i * 864e5).toISOString(), text });
  const posts = [p(0, 'the old city walls glow at sunset over the market stalls and the stone streets'), p(1, 'sunset turns the old city walls golden above market stalls and stone streets'), p(2, 'parliament voted on a new budget for schools hospitals roads and pensions')];
  const vec = { s0: [1, 0], s1: [0.95, 0.31], s2: [0.94, 0.34] };
  const hits = semanticRepetition(posts, { personas: [shemer], vecOf: (x) => vec[x.id] });
  assert.deepEqual(hits.map((h) => h.postId), ['s1'], 'high cosine without shared tokens is not a repeat');
});
