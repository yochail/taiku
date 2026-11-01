// Platform i18n: every locale file matches en.json, and a Hebrew RTL fixture pack builds with dir/lang/strings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/lib/site.mjs';

const I18N = path.join(ROOT, 'i18n');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const vars = (v) => new Set(JSON.stringify(v).match(/\{\w+\}/g) || []);

test('every i18n/<lang>.json has exactly the en.json keys, same placeholders, and plural objects with "other"', () => {
  const en = read(path.join(I18N, 'en.json'));
  for (const f of fs.readdirSync(I18N).filter((x) => x.endsWith('.json') && x !== 'en.json')) {
    const loc = read(path.join(I18N, f));
    assert.deepEqual(Object.keys(loc).sort(), Object.keys(en).sort(), `${f} keys`);
    for (const [k, v] of Object.entries(loc)) {
      assert.equal(typeof v, typeof en[k], `${f} ${k} type`);
      if (typeof v === 'object') assert.ok(v.other != null, `${f} ${k} needs "other"`);
      for (const x of vars(v)) assert.ok(vars(en[k]).has(x), `${f} ${k}: unknown placeholder ${x}`);
    }
  }
});

const FIX = path.join(ROOT, 'test', '.rtl-site');
const PACK = path.join(FIX, 'sites', 'rtlfix');
const OUT = path.join(ROOT, 'dist-rtl-test');
const html = (rel) => fs.readFileSync(path.join(OUT, rel), 'utf8');

before(() => {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(path.join(PACK, 'personas'), { recursive: true });
  fs.mkdirSync(path.join(PACK, 'content', 'posts'), { recursive: true });
  const ids = ['socrates', 'kant'];
  // Two real personas, trimmed to this pack: relations to absent personas removed, avatars and source texts copied.
  const keep = (v) => (Array.isArray(v) ? v.filter((x) => ids.includes(typeof x === 'string' ? x : x?.id)) : v);
  fs.mkdirSync(path.join(PACK, 'public', 'avatars'), { recursive: true });
  for (const id of ids) {
    const p = read(path.join(ROOT, 'sites', 'taiku', 'personas', `${id}.json`));
    for (const k of ['allies', 'rivals', 'frenemies']) p[k] = keep(p[k]);
    fs.cpSync(path.join(ROOT, 'sites', 'taiku', 'sources', id), path.join(PACK, 'sources', id), { recursive: true });
    fs.writeFileSync(path.join(PACK, 'personas', `${id}.json`), JSON.stringify(p));
    for (const img of fs.readdirSync(path.join(ROOT, 'sites', 'taiku', 'public', 'avatars')).filter((x) => x.startsWith(`${id}`))) fs.copyFileSync(path.join(ROOT, 'sites', 'taiku', 'public', 'avatars', img), path.join(PACK, 'public', 'avatars', img));
  }
  fs.writeFileSync(path.join(PACK, 'site.json'), JSON.stringify({ name: 'בדיקה', tagline: 'אתר בדיקה', description: 'בדיקה', domain: 'rtl.example', locale: 'he-IL', dir: 'rtl', logo: 'ב' }));
  const posts = [
    { id: 'rtl-1', authorId: 'socrates', type: 'hot_take', origin: 'seed', text: 'שלום עולם #ירושלים', createdAt: new Date(Date.now() - 3 * 864e5).toISOString() },
    { id: 'rtl-2', authorId: 'kant', type: 'hot_take', origin: 'seed', inReplyTo: 'rtl-1', text: 'חובה, לא נטייה.', createdAt: new Date(Date.now() - 2 * 864e5).toISOString() },
  ];
  fs.writeFileSync(path.join(PACK, 'content', 'posts', 'fixture.json'), JSON.stringify({ posts }));
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'build.mjs')], { env: { ...process.env, SITES_DIR: path.join(FIX, 'sites'), SITE: 'rtlfix', POSTS_DIR: path.join(PACK, 'content', 'posts'), OUT_DIR: OUT }, stdio: 'pipe' });
});
after(() => {
  if (process.env.KEEP_UI_TEST) return;
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
});

test('RTL Hebrew pack: html lang/dir, Hebrew UI strings, client i18n block, Unicode tag slug, no English chrome', () => {
  const home = html('index.html');
  assert.match(home, /<html lang="he-IL" dir="rtl"/);
  assert.match(home, /aria-label="חיפוש"/);
  assert.match(home, /<span>בשבילך<\/span>/);
  assert.match(home, /<script type="application\/json" id="i18n">\{"locale":"he-IL"/);
  assert.ok(!/>For you<|aria-label="Search"|>Thinkers</.test(home), 'English UI leaked into the Hebrew build');
  assert.ok(!/Taiku|太/.test(home), 'taiku branding leaked into another site');
  assert.ok(fs.existsSync(path.join(OUT, 'tags', 'ירושלים', 'index.html')) || fs.readdirSync(path.join(OUT, 'tags')).some((d) => d.includes('ירושלים')), 'Hebrew tag page');
});
