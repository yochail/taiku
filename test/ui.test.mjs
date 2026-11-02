// Builds the site from a tiny fixture post set (never touches content/) and checks the X-style UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/lib/data.mjs';
import { readPostPage } from '../src/lib/postpack.mjs';

const POSTS = path.join(ROOT, 'test', '.ui-fixture-posts');
const OUT = 'dist-ui-test';
const DIST = path.join(ROOT, OUT);
const read = (rel) => (/^p\/[^/]+\/index\.html$/.test(rel) ? readPostPage(DIST, rel.split('/')[1]) : fs.readFileSync(path.join(DIST, rel), 'utf8'));
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

const posts = [
  { id: 'uit-art', authorId: 'socrates', type: 'hot_take', origin: 'seed', text: 'Look at this & tell me the hemlock was worth it.', createdAt: ago(50), media: [{ kind: 'image', render: { art: 'death-of-socrates' } }] },
  { id: 'uit-meme', authorId: 'diogenes', type: 'meme', origin: 'seed', text: 'Every symposium, every time.', createdAt: ago(49), media: [{ kind: 'meme', render: { template: 'plato-vs-aristotle', captions: { up: 'The Forms', down: 'Lunch' } } }] },
  { id: 'uit-giphy', authorId: 'nietzsche', type: 'joke', origin: 'seed', text: 'Me reading Kant.', createdAt: ago(48), media: [{ kind: 'gif', src: 'https://media.giphy.com/media/abc123/giphy.gif', width: 480, height: 270, alt: 'A man slowly clapping', origin: 'giphy', rating: 'g', credit: { author: 'GIPHY', url: 'https://giphy.com/gifs/abc123' } }] },
  { id: 'uit-chart', authorId: 'kant', type: 'hot_take', origin: 'seed', text: 'My day, as data.', createdAt: ago(47), media: [{ kind: 'chart', render: { chart: { type: 'bar', title: 'Time spent', labels: ['Walking', 'Thinking'], values: [1, 23], unit: 'h' } } }] },
  { id: 'uit-link', authorId: 'socrates', type: 'news_take', origin: 'seed', text: 'Ask them what "smart" means.', createdAt: ago(46), media: [{ kind: 'link_card', url: 'https://www.example.com/news/ai-smart', title: 'AI is now smarter than us, says study', description: 'A new paper claims...' }] },
  { id: 'uit-poll-closed', authorId: 'socrates', type: 'poll', origin: 'seed', text: 'Is the unexamined life worth living?', createdAt: ago(45), poll: { id: 'uit-poll-closed', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }, { id: 'c', text: 'Ask Socrates', crowdVoteBase: 500, personaVotes: ['kant'] }] } },
  { id: 'uit-reply', authorId: 'kant', type: 'hot_take', inReplyTo: 'uit-art', origin: 'seed', text: 'Duty, not hemlock. #uitfixturetag', createdAt: ago(10) },
  { id: 'uit-rt-old', authorId: 'kant', type: 'retaik', retaikOf: 'uit-art', text: '', origin: 'seed', createdAt: ago(5) },
  { id: 'uit-rt-new', authorId: 'diogenes', type: 'retaik', retaikOf: 'uit-art', text: '', origin: 'seed', createdAt: ago(2) },
  { id: 'uit-og', authorId: 'kant', type: 'news_take', origin: 'seed', text: 'Universalize this.', createdAt: ago(3), media: [{ kind: 'link_card', url: 'https://news.example.org/story', domain: 'news.example.org', title: 'Big story & more', image: { url: 'https://cdn.example.org/og.jpg', width: 1200, height: 630 } }] },
  { id: 'uit-xpost', authorId: 'diogenes', type: 'hot_take', origin: 'seed', text: 'Look at this guy.', createdAt: ago(3), media: [{ kind: 'x_post', url: 'https://x.example/NASA/status/123456789', author_name: 'NASA', handle: 'NASA', avatar_url: 'https://pbs.example/profile_images/1/nasa.jpg', text: 'Exact words <here>.', created_at: '2026-10-30T12:00:00Z' }] },
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
  const m = meme.match(/<img src="(\/media\/gen\/meme-[^"]+\.(?:svg|jpg))"/);
  assert.ok(m, 'meme image');
  assert.ok(fs.existsSync(path.join(DIST, m[1])), 'meme image written');
  assert.match(read('p/uit-chart/index.html'), /media-chart"[^>]*>(<button[^>]*>)?<img src="\/media\/gen\/chart-[^"]+\.svg"[^>]*alt="bar chart/);
  const gif = read('p/uit-giphy/index.html');
  assert.match(gif, /<span class="media-badge">GIF<\/span>/);
  assert.match(gif, /Powered by GIPHY/);
});

test('link cards show domain and headline', () => {
  const html = read('p/uit-link/index.html');
  assert.match(html, /<a class="link-card lc-small" href="https:\/\/www\.example\.com\/news\/ai-smart" rel="noopener nofollow ugc" target="_blank"[^>]*>.*<span class="lc-tile"[^>]*>E<\/span>.*<span class="lc-domain">example\.com<\/span><span class="lc-title">AI is now smarter than us, says study<\/span>/s);
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
test('search: lazy index + HTML shards, /search/ page with X tabs, sidebar box and tab-bar link', () => {
  const idx = JSON.parse(read('data/search.json'));
  const row = idx.posts.find((r) => r[0] === 'uit-art');
  assert.ok(row, 'post indexed');
  const [id, author, text, t, , m, shard] = row;
  assert.equal(author, 'socrates');
  assert.equal(text, text.toLowerCase());
  assert.ok(Number.isFinite(t) && m === 2);
  assert.ok(JSON.parse(read(`data/s/${shard}.json`))[id].includes(`data-pid="${id}"`));
  assert.ok(!idx.posts.some((r) => r[0] === 'uit-rt-old' || r[0] === 'uit-rt-new'), 'retaiks are not indexed');
  assert.ok(idx.posts.every((r, i, a) => !i || a[i - 1][3] >= r[3]), 'index is newest first');
  const page = read('search/index.html');
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.match(page, /<form class="search-form search-main" action="\/search\/" method="get" role="search">/);
  for (const l of ['Top', 'Latest', 'People', 'Media']) assert.match(page, new RegExp(`role="tab" data-f="[a-z]+"[^>]*><span>${l}</span>`));
  assert.match(page, /id="search-results"/);
  assert.doesNotMatch(page, /search-side/);
  const home = read('index.html');
  assert.match(home, /class="search-form search-side" action="\/search\/"/);
  assert.match(home, /<nav class="tabbar"[^>]*><a href="\/"[^>]*>[\s\S]*?<a href="\/search\/" aria-label="Search"/);
  assert.match(home, /href="\/search\/"><span class="ni">/);
  assert.doesNotMatch(read('sitemap.xml'), /\/search\//);
});
test('profile tabs are real routes; Posts excludes replies, Replies includes them', () => {
  const posts = read('thinkers/kant/index.html');
  const replies = read('thinkers/kant/with_replies/index.html');
  assert.match(posts, /<nav class="p-tabs"[^>]*>[\s\S]*?<a [^>]*href="\/thinkers\/kant\/with_replies\/"/);
  assert.match(posts, /<a [^>]*aria-current="page"[^>]*>Posts</);
  assert.doesNotMatch(posts, /data-pid="uit-reply"/);
  assert.match(replies, /data-pid="uit-reply"/);
  for (const r of ['media', 'likes', 'following', 'followers']) assert.ok(fs.existsSync(path.join(DIST, 'thinkers', 'kant', r, 'index.html')), r);
  assert.match(read('thinkers/kant/likes/index.html'), /likes are private/);
  assert.match(posts, /href="\/thinkers\/kant\/following\/"[^>]*>/);
  assert.match(posts, /href="\/thinkers\/kant\/followers\/"[^>]*>/);
});

test('QA: handle links, image viewer, unique post ids, inline hashtag pages', () => {
  const home = read('index.html');
  assert.match(home, /<a class="handle" href="\/thinkers\/[a-z_]+\/"/);
  assert.match(home, /<dialog class="lightbox" id="lightbox"/);
  assert.match(home, /<\/dialog>\n<dialog class="modal" id="gate-modal"/);
  assert.match(read('p/uit-art/index.html'), /class="media-zoom" data-zoom="/);
  assert.match(read('thinkers/kant/index.html'), /class="p-avatar-btn"[^>]*data-zoom=/);
  const ids = [...home.matchAll(/ id="(post-[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate post ids');
  assert.ok(fs.existsSync(path.join(DIST, 'tags', 'uitfixturetag', 'index.html')), 'inline hashtag page');
});
test('the logo is the way home: no separate Home item in the side menu', () => {
  const home = read('index.html');
  const nav = home.match(/<nav class="leftnav"[\s\S]*?<\/nav>/)[0];
  assert.match(nav, /<a class="brand" href="\/" data-home aria-current="page">/);
  assert.doesNotMatch(nav, /class="nl">Home</);
  assert.match(home, /class="ht-logo" href="\/" aria-label="Taiku home" data-home/);
});
test('discovery: topics/trends data, /connect and /me pages, onboarding outside the hidden panel', () => {
  const topics = JSON.parse(read('data/topics.json'));
  assert.ok(Array.isArray(topics.topics) && Array.isArray(topics.trends));
  for (const [k] of topics.topics.slice(0, 3)) assert.ok(fs.existsSync(path.join(DIST, 'data', 't', `${k}.json`)));
  for (const rel of ['connect/index.html', 'me/index.html']) assert.match(read(rel), /<meta name="robots" content="noindex/);
  assert.match(read('connect/index.html'), /data-ctab="people"[\s\S]*data-ctab="topics"/);
  assert.match(read('me/index.html'), /data-mtab="likes"[\s\S]*data-mtab="bookmarks"[\s\S]*data-mtab="following"/);
  const home = read('index.html');
  assert.match(home, /class="tabbar"[\s\S]*?href="\/me\/"/);
  const onboard = home.indexOf('id="onboard"');
  assert.ok(onboard > 0);
  const panel = home.slice(home.indexOf('id="panel-following"'), onboard);
  assert.equal((panel.match(/<div\b/g) ?? []).length + 1, (panel.match(/<\/div>/g) ?? []).length, 'panel closes before the dialog');
  const { items } = JSON.parse(read('data/foryou.json'));
  assert.ok(items.every((x) => Array.isArray(x.g)));
  const people = JSON.parse(read('data/personas.json')).personas;
  assert.ok(Object.values(people).some((p) => Array.isArray(p.tp) && Array.isArray(p.co) && Array.isArray(p.rel)));
});

test('X-style link cards and real-post quotes: whole card links out, hotlinked images, no third-party JS', () => {
  const og = read('p/uit-og/index.html');
  assert.match(og, /<a class="link-card lc-large" href="https:\/\/news\.example\.org\/story" rel="noopener nofollow ugc" target="_blank"[^>]*><span class="lc-img"><img src="https:\/\/cdn\.example\.org\/og\.jpg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="1200" height="630"><span class="lc-overlay">Big story &amp; more<\/span><\/span><span class="lc-from">From news\.example\.org<\/span><\/a>/);
  const xp = read('p/uit-xpost/index.html');
  assert.match(xp, /<a class="real-post quote rp-x" href="https:\/\/x\.example\/NASA\/status\/123456789" rel="noopener nofollow ugc" target="_blank" aria-label="NASA on X">/);
  assert.match(xp, /class="rp-avatar" src="https:\/\/pbs\.example[^"]+"[^>]*referrerpolicy="no-referrer"/);
  assert.match(xp, /<span class="rp-text">Exact words [^<]*here[^<]*<\/span>/);
  assert.doesNotMatch(xp, /<here>/);
  assert.match(xp, /<span class="rp-net" title="X"><svg/);
  assert.doesNotMatch(xp, /platform\.twitter\.com|widgets\.js/);
  assert.match(read('_headers'), /img-src[^;]* https:/);
});