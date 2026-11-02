// Platform i18n: every locale file matches en.json; locale resolution; a Hebrew-content fixture pack builds with English chrome.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, resolveLocales } from '../src/lib/site.mjs';

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

test('resolveLocales: ui/content split, legacy locale+dir, RTL detection, defaults', () => {
  assert.deepEqual(resolveLocales({}), { ui_locale: 'en', ui_dir: 'ltr', content_locale: 'en', content_dir: 'ltr', locale: 'en', dir: 'ltr' });
  const split = resolveLocales({ ui_locale: 'en', content_locale: 'he' });
  assert.equal(split.ui_dir, 'ltr');
  assert.equal(split.content_dir, 'rtl');
  assert.equal(split.locale, 'en');
  // Legacy: locale/dir describe the whole site, so Hebrew UI (he.json) stays available as an option.
  const legacy = resolveLocales({ locale: 'he-IL', dir: 'rtl' });
  assert.equal(legacy.ui_dir, 'rtl');
  assert.equal(legacy.content_locale, 'he-IL');
  assert.equal(legacy.content_dir, 'rtl');
  assert.throws(() => resolveLocales({ content_locale: 'he" onload="x' }), /invalid locale/);
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
    if (id === 'socrates') Object.assign(p, { bio: 'שואל שאלות בשוק.', background: 'פילוסוף אתונאי.', wikipedia_he: 'https://he.wikipedia.org/wiki/%D7%A1%D7%95%D7%A7%D7%A8%D7%98%D7%A1' });
    fs.cpSync(path.join(ROOT, 'sites', 'taiku', 'sources', id), path.join(PACK, 'sources', id), { recursive: true });
    fs.writeFileSync(path.join(PACK, 'personas', `${id}.json`), JSON.stringify(p));
    for (const img of fs.readdirSync(path.join(ROOT, 'sites', 'taiku', 'public', 'avatars')).filter((x) => x.startsWith(`${id}`))) fs.copyFileSync(path.join(ROOT, 'sites', 'taiku', 'public', 'avatars', img), path.join(PACK, 'public', 'avatars', img));
  }
  fs.writeFileSync(path.join(PACK, 'site.json'), JSON.stringify({ name: 'בדיקה', tagline: 'אתר בדיקה', description: 'בדיקה', domain: 'rtl.example', ui_locale: 'en', content_locale: 'he', logo: 'ב', profile: { about: true } }));
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

test('Hebrew-content pack: English LTR chrome, Hebrew RTL content elements, Unicode tag slug', () => {
  const home = html('index.html');
  assert.match(home, /<html lang="en" data-clang="he" data-cdir="rtl">/);
  assert.match(home, /aria-label="Search"/);
  assert.match(home, /<span>For you<\/span>/);
  assert.ok(!home.includes('id="i18n"'), 'English UI needs no client i18n block');
  assert.ok(!/בשבילך|aria-label="חיפוש"/.test(home), 'Hebrew UI strings leaked into the English chrome');
  assert.match(home, /<div class="text" lang="he" dir="rtl">שלום עולם/);
  assert.match(home, /<a class="name" lang="he" dir="rtl" href="\/thinkers\/socrates\/">/);
  assert.ok(!/Taiku|太/.test(home), 'taiku branding leaked into another site');
  assert.ok(fs.existsSync(path.join(OUT, 'tags', 'ירושלים', 'index.html')) || fs.readdirSync(path.join(OUT, 'tags')).some((d) => d.includes('ירושלים')), 'Hebrew tag page');
});

test('Hebrew-content pack: profile name, bio and About tab (with Hebrew Wikipedia) are content; tabs are chrome', () => {
  const p = html(path.join('thinkers', 'socrates', 'index.html'));
  const ab = html(path.join('thinkers', 'socrates', 'about', 'index.html'));
  assert.doesNotMatch(p, /p-about|Read more on Wikipedia/, 'About content stays in the About tab');
  assert.match(p, /<p class="p-bio" lang="he" dir="rtl">שואל שאלות בשוק\.<\/p>/);
  assert.match(p, /<h2 class="p-name"><span lang="he" dir="rtl">/);
  assert.match(ab, /<p lang="he" dir="rtl">פילוסוף אתונאי\.<\/p>/);
  assert.match(ab, /<a href="https:\/\/he\.wikipedia\.org\/wiki\/[^"]+" rel="noopener" target="_blank">Read more on Wikipedia<\/a>/);
  assert.match(p, />Posts<\/a>/);
  assert.match(p, /"sameAs":\["https:\/\/en\.wikipedia\.org[^"]*","https:\/\/he\.wikipedia\.org/);
});
