// Post-build sanity checks for dist/.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadPersonas, loadPosts } from '../src/lib/data.mjs';

const DIST = path.join(ROOT, 'dist');
const failures = [];
const must = (cond, msg) => { if (!cond) failures.push(msg); };
const exists = (rel) => fs.existsSync(path.join(DIST, rel));
const read = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8');

const personas = loadPersonas();
const posts = loadPosts();

must(exists('index.html'), 'dist/index.html missing');
must(exists('thinkers/index.html'), 'dist/thinkers/index.html missing');
must(exists('about/index.html'), 'dist/about/index.html missing');
must(exists('404.html'), 'dist/404.html missing');
must(exists('robots.txt'), 'robots.txt missing');
must(exists('feed.xml'), 'feed.xml missing');

const profileDirs = fs.existsSync(path.join(DIST, 'thinkers'))
  ? fs.readdirSync(path.join(DIST, 'thinkers')).filter((d) => exists(`thinkers/${d}/index.html`))
  : [];
must(profileDirs.length === personas.length, `expected ${personas.length} profile pages, found ${profileDirs.length}`);
must(personas.length === 30, `expected 30 personas, found ${personas.length}`);

let missingPosts = 0;
for (const p of posts) if (!exists(`p/${p.id}/index.html`)) missingPosts++;
must(missingPosts === 0, `${missingPosts} post pages missing`);

let locCount = 0;
if (exists('sitemap.xml')) {
  const sm = read('sitemap.xml');
  must(sm.startsWith('<?xml'), 'sitemap.xml missing XML declaration');
  must(/<urlset[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(sm), 'sitemap.xml missing urlset namespace');
  must(sm.trim().endsWith('</urlset>'), 'sitemap.xml not closed');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  locCount = locs.length;
  must((sm.match(/<url>/g) || []).length === locCount, 'sitemap <url>/<loc> mismatch');
  must(locs.every((l) => /^https?:\/\/[^\s<>&]+$/.test(l)), 'sitemap has invalid <loc> values');
  must(locCount >= posts.length + personas.length + 2, `sitemap has too few URLs (${locCount})`);
  must(!/&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(sm), 'sitemap has unescaped &');
} else failures.push('sitemap.xml missing');

if (exists('robots.txt')) must(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/.test(read('robots.txt')), 'robots.txt lacks Sitemap line');

if (exists('index.html')) {
  const home = read('index.html');
  must(/<link rel="canonical"/.test(home), 'home lacks canonical');
  must(/property="og:title"/.test(home), 'home lacks og:title');
  must(/application\/ld\+json/.test(home), 'home lacks JSON-LD');
  must(/AI-generated/i.test(home), 'home lacks AI-generated label');
}
const sample = posts.find((p) => !p.inReplyTo);
if (sample && exists(`p/${sample.id}/index.html`)) {
  const html = read(`p/${sample.id}/index.html`);
  must(/DiscussionForumPosting/.test(html), 'post page lacks DiscussionForumPosting JSON-LD');
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(m[1]); } catch { failures.push(`invalid JSON-LD on /p/${sample.id}/`); }
  }
}

if (failures.length) {
  console.error('✖ check failed:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(`✔ dist OK — ${profileDirs.length} profiles, ${posts.length} post pages, ${locCount} sitemap URLs`);
