// Builds the site from a tiny fixture post set (never touches content/) and checks the X-style UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/lib/data.mjs';

const POSTS = path.join(ROOT, 'test', '.ui-fixture-posts');
const OUT = 'dist-ui-test';
const DIST = path.join(ROOT, OUT);
const read = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

const posts = [
  { id: 'uit-art', authorId: 'socrates', type: 'hot_take', origin: 'seed', text: 'Look at this & tell me the hemlock was worth it.', createdAt: ago(50), media: [{ kind: 'image', render: { art: 'death-of-socrates' } }] },
  { id: 'uit-meme', authorId: 'diogenes', type: 'meme', origin: 'seed', text: 'Every symposium, every time.', createdAt: ago(49), media: [{ kind: 'meme', render: { template: 'plato-vs-aristotle', captions: { up: 'The Forms', down: 'Lunch' } } }] },
  { id: 'uit-giphy', authorId: 'nietzsche', type: 'joke', origin: 'seed', text: 'Me reading Kant.', createdAt: ago(48), media: [{ kind: 'gif', src: 'https://media.giphy.com/media/abc123/giphy.gif', width: 480, height: 270, alt: 'A man slowly clapping', origin: 'giphy', rating: 'g', credit: { author: 'GIPHY', url: 'https://giphy.com/gifs/abc123' } }] },
  { id: 'uit-chart', authorId: 'kant', type: 'hot_take', origin: 'seed', text: 'My day, as data.', createdAt: ago(47), media: [{ kind: 'chart', render: { chart: { type: 'bar', title: 'Time spent', labels: ['Walking', 'Thinking'], values: [1, 23], unit: 'h' } } }] },
  { id: 'uit-link', authorId: 'socrates', type: 'news_take', origin: 'seed', text: 'Ask them what "smart" means.', createdAt: ago(46), media: [{ kind: 'link_card', url: 'https://www.example.com/news/ai-smart', title: 'AI is now smarter than us, says study', description: 'A new paper claims...' }] },
  { id: 'uit-poll-closed', authorId: 'socrates', type: 'poll', origin: 'seed', text: 'Is the unexamined life worth living?', createdAt: ago(45), poll: { id: 'uit-poll-closed', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }, { id: 'c', text: 'Ask Socrates', crowdVoteBase: 500, personaVotes: ['kant'] }] } },
  { id: 'uit-rt-old', authorId: 'kant', type: 'retaik', retaikOf: 'uit-art', text: '', origin: 'seed', createdAt: ago(5) },
  { id: 'uit-rt-new', authorId: 'diogenes', type: 'retaik', retaikOf: 'uit-art', text: '', origin: 'seed', createdAt: ago(2) },
  { id: 'uit-poll-open', authorId: 'kant', type: 'poll', origin: 'seed', text: 'Categorical or hypothetical?', createdAt: ago(1), poll: { id: 'uit-poll-open', options: [{ id: 'a', text: 'Categorical' }, { id: 'b', text: 'Hypothetical' }] } },
];

before(() => {
  fs.mkdirSync(POSTS, { recursive: true });
  fs.writeFileSync(path.join(POSTS, 'ui-fixture.json'), JSON.stringify({ posts }, null, 2));
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'build.mjs')], { env: { ...process.env, POSTS_DIR: POSTS, OUT_DIR: OUT }, stdio: 'pipe' });
});
after(() => {
  if (process.env.KEEP_UI_TEST) return;
  fs.rmSync(POSTS, { recursive: true, force: true });
  fs.rmSync(DIST, { recursive: true, force: true });
});

test('images render as lazy, sized, rounded media cards with alt text and a credit line', () => {
  const html = read('p/uit-art/index.html');
  assert.match(html, /class="media-grid n1"/);
  assert.match(html, /<img src="\/media\/art\/death-of-socrates\.jpg" alt="[^"]+" loading="lazy" decoding="async" width="\d+" height="\d+">/);
  assert.match(html, /<figcaption><a href="https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  assert.match(html, /class="alt-badge" data-alt="/);
});

test('memes and charts render as generated images; GIPHY GIFs get a GIF badge and attribution', () => {
  const meme = read('p/uit-meme/index.html');
  const m = meme.match(/<img src="(\/media\/gen\/meme-[^"]+\.svg)"/);
  assert.ok(m, 'meme image');
  assert.ok(fs.existsSync(path.join(DIST, m[1])), 'meme svg written');
  assert.match(read('p/uit-chart/index.html'), /media-chart"[^>]*><img src="\/media\/gen\/chart-[^"]+\.svg"[^>]*alt="bar chart/);
  const gif = read('p/uit-giphy/index.html');
  assert.match(gif, /<span class="media-badge">GIF<\/span>/);
  assert.match(gif, /Powered by GIPHY/);
});

test('link cards show domain and headline', () => {
  const html = read('p/uit-link/index.html');
  assert.match(html, /<a class="link-card" href="https:\/\/www\.example\.com\/news\/ai-smart"[^>]*>.*<span class="lc-domain">example\.com<\/span><span class="lc-title">AI is now smarter than us, says study<\/span>/s);
});

test('polls render X-style with deterministic counts, final results or time left', () => {
  const closed = read('p/uit-poll-closed/index.html');
  assert.match(closed, /class="poll closed" data-poll="uit-poll-closed"/);
  assert.match(closed, /Final results/);
  assert.match(closed, /data-opt="c" data-votes="501"/);
  const pcts = [...closed.matchAll(/<span class="po-pct">(\d+)%<\/span>/g)].map((x) => Number(x[1]));
  assert.equal(pcts.length, 3);
  assert.ok(Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) <= 2);
  assert.equal(read('p/uit-poll-closed/index.html'), closed);
  const open = read('p/uit-poll-open/index.html');
  assert.match(open, /class="poll" data-poll="uit-poll-open"/);
  assert.match(open, /\d+ hours? left|\d+ minutes? left/);
  assert.doesNotMatch(open, /class="poll-opt[^"]*"[^>]*disabled/);
});

test('no always-visible login banner; one Log in / Sign up entry in the menu', () => {
  const home = read('index.html');
  assert.doesNotMatch(home, /auth-banner/);
  assert.equal((home.match(/Log in \/ Sign up/g) ?? []).length, 1);
});

test('home has For you / Following tabs and a Who to follow empty state', () => {
  const home = read('index.html');
  assert.match(home, /role="tablist"/);
  assert.match(home, /id="tab-foryou"[^>]*aria-selected="true"/);
  assert.match(home, /id="tab-following"[^>]*aria-selected="false"/);
  assert.match(home, /class="following-empty"[\s\S]*Who to follow[\s\S]*data-follow="[a-z_]+"/);
  assert.match(home, /<body[^>]*data-build="[a-z0-9]+"/);
});

test('follow buttons are real toggles and profiles expose a follower count to bump', () => {
  const html = read('thinkers/socrates/index.html');
  assert.match(html, /class="btn follow-btn follow" data-follow="socrates" aria-pressed="false"/);
  assert.match(html, /data-followers="socrates" data-count="\d+"/);
  assert.doesNotMatch(html, /data-gate="follow"/);
});

test('Following timeline data is emitted per author, newest first, without duplicate ids', () => {
  const data = JSON.parse(read('data/u/socrates.json'));
  const mine = data.posts.map((p) => p.id);
  assert.ok(mine.includes('uit-art') && mine.includes('uit-poll-closed'));
  const times = data.posts.map((p) => p.t);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.ok(data.posts.every((p) => !/id="post-/.test(p.h)));
  const people = JSON.parse(read('data/personas.json')).personas;
  assert.equal(people.socrates.h, 'the_og_gadfly');
});
test('For you ranking data: a compact index plus HTML shards, rank.js loaded before app.js', () => {
  const home = read('index.html');
  assert.match(home, /<script src="\/rank\.js\?v=[a-z0-9]+" defer><\/script>\s*<script src="\/app\.js/);
  const { items } = JSON.parse(read('data/foryou.json'));
  const art = items.find((x) => (x.k || x.id) === 'uit-art');
  assert.ok(art && art.id === 'uit-rt-new' && art.a === 'diogenes' && art.m === 1 && Number.isFinite(art.t) && art.l > 0);
  assert.equal(items.find((x) => x.id === 'uit-poll-open').m, 1);
  const shard = JSON.parse(read(`data/f/${art.s}.json`));
  assert.match(shard[art.id], /retaiked[\s\S]*data-pid="uit-art" data-author="socrates"/);
  assert.doesNotMatch(shard[art.id], /id="post-/);
});
test('mobile chrome: drawer menu button, bottom tab bar and compose button on every page', () => {
  for (const rel of ['index.html', 'thinkers/index.html']) {
    const html = read(rel);
    assert.match(html, /<nav class="leftnav" id="drawer"/);
    assert.match(html, /class="menu-btn"[^>]*aria-controls="drawer"[^>]*aria-expanded="false"/);
    assert.match(html, /<nav class="tabbar" aria-label="Sections">/);
    assert.match(html, /class="fab"[^>]*data-gate="post"/);
    assert.match(html, /viewport-fit=cover/);
    assert.equal((html.match(/Log in \/ Sign up/g) ?? []).length, 1);
  }
  assert.match(read('index.html'), /class="tabbar"[\s\S]*?href="\/" aria-label="Home" aria-current="page"/);
});

test('installable PWA: manifest, icons, head links, versioned service worker, offline page, CSP', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'Taiku');
  assert.equal(m.short_name, 'Taiku');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(DIST, i.src)), i.src);
  const home = read('index.html');
  assert.match(home, /<link rel="manifest" href="\/manifest.webmanifest">/);
  assert.match(home, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png">/);
  assert.match(home, /<meta name="theme-color" content="#000000"/);
  assert.match(home, /class="nav-btn nav-install" type="button" hidden/);
  const build = home.match(/data-build="([^"]+)"/)[1];
  const sw = read('sw.js');
  assert.ok(sw.includes(`const VERSION = "${build}"`));
  assert.ok(!sw.includes('__SHELL__'));
  const shell = JSON.parse(sw.match(/const SHELL = (\[.*\]);/)[1]);
  assert.ok(shell.includes('/offline.html') && shell.some((u) => u.startsWith('/app.js?v=')));
  for (const u of shell) assert.ok(fs.existsSync(path.join(DIST, u.split('?')[0])), u);
  assert.match(read('offline.html'), /You’re offline/);
  assert.match(read('_headers'), /worker-src 'self'; manifest-src 'self'/);
});

test('UI copy has no hardcoded persona counts', () => {
  const home = read('index.html');
  assert.match(home, /Dead Thinkers Society\. AI personas of real, dead thinkers/);
  assert.match(home, /Show all →/);
  assert.doesNotMatch(home + read('thinkers/index.html') + read('about/index.html'), /\b\d+ (AI personas|thinkers|AI thinker personas)\b|Show all \d+/);
});

test('timelines show each story once: the newest retaik stands in for the original', () => {
  const pages = ['index.html', ...(fs.existsSync(path.join(DIST, 'page')) ? fs.readdirSync(path.join(DIST, 'page')) : []).map((n) => `page/${n}/index.html`)].filter((f) => fs.existsSync(path.join(DIST, f)));
  const ids = pages.flatMap((f) => [...read(f).matchAll(/<article class="post"[^>]*data-pid="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(ids.includes('uit-art'));
  assert.equal(new Set(ids).size, ids.length, `duplicate posts in feed: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`);
  const home = read('index.html');
  assert.equal((home.match(/retaiked<\/div>/g) ?? []).length, 1);
  assert.match(home, /Diogenes[^<]*<\/a> retaiked/);
  const fy = JSON.parse(read('data/foryou.json')).items.map((i) => i.k || i.id);
  assert.equal(new Set(fy).size, fy.length);
  const u = JSON.parse(read('data/u/kant.json')).posts.find((p) => p.id === 'uit-rt-old');
  assert.equal(u.k, 'uit-art');
});