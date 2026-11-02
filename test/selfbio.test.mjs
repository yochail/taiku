import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanSelfBio, selfBioHit, selfBioProfile, selfBioProfiles, selfBioRepair, unquoted } from '../src/lib/selfbio.mjs';

const moshe = {
  id: 'moshe',
  lang: 'he',
  background: 'הוציא את בני ישראל ממצרים, הוביל אותם במדבר ארבעים שנה וקיבל את התורה בהר סיני.',
  key_works: [{ title: 'עשרת הדברות' }],
  ideas: {
    signature_episodes: [
      { label: 'קריעת ים סוף', pattern: '(?:הים נבקע|בקעתי|ים סוף|קרעתי)' },
      { label: 'הלוחות / סיני', pattern: '(?:הורדתי|שברתי|הלוחות|מההר|בסיני)' },
    ],
  },
};
const benYehuda = {
  id: 'ben_yehuda',
  lang: 'he',
  background: 'החייה את השפה העברית כשפה מדוברת, חיבר את המילון הגדול וגידל את בנו כדובר עברית ראשון.',
  key_works: [{ title: 'מילון הלשון העברית' }],
};
const tesla = {
  id: 'tesla',
  background: 'Invented the alternating current induction motor and pioneered wireless power transmission at Wardenclyffe.',
  key_works: [{ title: 'My Inventions' }],
};
const other = { id: 'other', background: 'Wrote poems about the sea and taught in a village school.' };
const news = { id: 'wire', kind: 'news', background: 'News account.' };
const personas = [moshe, benYehuda, tesla, other, news];
const profiles = selfBioProfiles(personas);
const hit = (id, text) => selfBioHit(text, profiles.get(id));

test('Hebrew first-person retelling of a signature episode is a hit', () => {
  assert.equal(hit('moshe', 'טקסס תולה את עשרת הדברות. אני הורדתי אותם מההר פעמיים.')?.via, 'episode');
  assert.ok(hit('moshe', 'כשאני בקעתי את הים, אף אחד לא ביקש ועדה.'));
  assert.ok(hit('ben_yehuda', 'עברי, דבר עברית! המילון שלי נגמר באמצע.'));
  assert.ok(hit('ben_yehuda', 'אני החייתי את השפה הזאת, ואתם כותבים ״לייק״.'));
});

test('being the character today is not a hit', () => {
  assert.equal(hit('moshe', 'טקסס מחייבת לתלות את עשרת הדברות בכיתות. יפה. עכשיו שיקראו אותן.'), null);
  assert.equal(hit('moshe', 'עוד עגל? ברצינות? תנו לי מטה ושבוע אחד.'), null);
  assert.equal(hit('ben_yehuda', 'אם תכתבו פה ״לייק״ אני אמציא מילה. הצעה ראשונה: ״אַהֲדָה״.'), null);
  // Third person about the episode, no first person at all.
  assert.equal(hit('moshe', 'הים נבקע פעם, אבל הקואליציה לא תיבקע.'), null);
});

test('conditional "הייתי רוצה" is not a past deed', () => {
  assert.equal(hit('ben_yehuda', 'הייתי רוצה מילה עברית ל״סטרימינג״. מי מציע?'), null);
});

test('quoted speech of others is ignored', () => {
  assert.equal(unquoted('אמר: ״אני הורדתי את הלוחות״ וזהו').includes('הורדתי'), false);
  assert.equal(hit('moshe', 'מישהו כתב לי ״אני הורדתי את הלוחות״. לא, ידידי. אני רק מבקש שתקראו.'), null);
});

test('English first-person retelling is a hit, opinion is not', () => {
  assert.ok(hit('tesla', 'I invented the induction motor and Edison still got the credit.'));
  assert.ok(hit('tesla', 'In My Inventions I explained all of this.'));
  assert.equal(hit('tesla', 'Australia gives Fiji drones powered by sun, wind and WAVES. Finally. Bankers, stop laughing.'), null);
});

test('news accounts get no profile; profile builds from inline ideas', () => {
  assert.equal(profiles.has('wire'), false);
  const p = selfBioProfile(moshe);
  assert.equal(p.episodes.length, 2);
});

const day = (d, h = 10) => `2026-10-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const post = (id, authorId, d, text) => ({ id, authorId, createdAt: day(d), text });
const filler = (authorId, n, from = 1) => Array.from({ length: n }, (_, i) => post(`${authorId}-f${i}`, authorId, from + (i % 20), `מחשבה של היום מספר ${i}, בלי שום סיפור.`));

test('same signature episode twice within 14 days is flagged; outside the window it is not', () => {
  const posts = [
    ...filler('moshe', 30),
    post('m1', 'moshe', 1, 'אני הורדתי את הלוחות, ואתם מתווכחים על פוסטרים.'),
    post('m2', 'moshe', 10, 'שוב: אני הורדתי את הלוחות. שמרו עליהם.'),
    post('m3', 'moshe', 30, 'אני הורדתי את הלוחות, ועדיין לא קראתם.'),
  ];
  const r = scanSelfBio(posts, { personas, profiles });
  const ep = r.offenders.filter((o) => o.reason === 'self_bio_episode').map((o) => o.postId);
  assert.deepEqual(ep, ['m2']);
  assert.equal(r.offenders.find((o) => o.postId === 'm2').otherId, 'm1');
});

test('persona cap (10%) and site cap (5%)', () => {
  // ben_yehuda: 3 hits over 20 posts (15%) -> allowed 2, one share offender (the latest).
  const by = [
    ...filler('ben_yehuda', 17),
    post('b1', 'ben_yehuda', 2, 'המילון שלי עוד לא גמור.'),
    post('b2', 'ben_yehuda', 20, 'אני החייתי את השפה, אז תדברו בה.'),
    post('b3', 'ben_yehuda', 30, 'המילון שלי לא מכיר את המילה הזאת.'),
  ];
  const r = scanSelfBio([...by, ...filler('other', 200)], { personas, profiles });
  const row = r.personas.find((p) => p.personaId === 'ben_yehuda');
  assert.equal(row.k, 3);
  assert.equal(row.allowed, 2);
  assert.equal(row.over, true);
  assert.ok(r.offenders.some((o) => o.postId === 'b3' && o.reason !== 'self_bio_site'));
  assert.equal(r.site.over, false);

  // Small site where every persona is within its own cap but the site is over 5%.
  const small = [...filler('ben_yehuda', 9), post('s1', 'ben_yehuda', 3, 'המילון שלי עוד לא גמור.'), ...filler('other', 9), post('s2', 'moshe', 4, 'אני הורדתי את הלוחות.')];
  const rs = scanSelfBio(small, { personas, profiles });
  assert.equal(rs.site.over, true);
  assert.ok(rs.offenders.some((o) => o.reason === 'self_bio_site'));
  assert.ok(rs.offenders.length <= rs.site.k - rs.site.allowed + rs.offenders.filter((o) => o.reason !== 'self_bio_site').length);
});

test('isTarget limits offenders to target items but history still counts', () => {
  const posts = [...filler('moshe', 30), post('h1', 'moshe', 1, 'אני הורדתי את הלוחות.'), post('t1', 'moshe', 5, 'אני הורדתי את הלוחות שוב.')];
  const r = scanSelfBio(posts, { personas, profiles, isTarget: (p) => p.id === 't1' });
  assert.deepEqual(r.offenders.map((o) => o.postId), ['t1']);
  const none = scanSelfBio(posts, { personas, profiles, isTarget: () => false });
  assert.equal(none.offenders.length, 0);
  assert.equal(none.hits.length, 2);
});

test('repair hint is a house-style message', () => {
  assert.match(selfBioRepair('המילון'), /^House style:.*biography.*המילון/s);
});
