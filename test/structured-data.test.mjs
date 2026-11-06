// JSON-LD on built pages must satisfy Google's structured-data requirements (Search Console:
// DiscussionForumPosting / ProfilePage / Comment / sharedContent), for every site pack.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assemble, bucketOf, readRecord } from '../src/worker/posts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = [
  { id: 'taiku', out: path.join(ROOT, 'dist-ld-taiku') },
  { id: 'tarya', out: path.join(ROOT, 'dist-ld-tarya') },
];

before(() => {
  for (const s of SITES) {
    execFileSync(process.execPath, [path.join(ROOT, 'src', 'build.mjs')], {
      env: { ...process.env, SITE: s.id, OUT_DIR: s.out, POST_PAGES: '' },
      stdio: 'pipe',
    });
  }
});
after(() => {
  for (const s of SITES) fs.rmSync(s.out, { recursive: true, force: true });
});

const ISO_DT = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
const ISO_DATE = /^\d{4}(-\d\d(-\d\d)?)?$/;
const POSTING = new Set(['DiscussionForumPosting', 'SocialMediaPosting', 'Comment']);
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/.test(u);
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

const lds = (html) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));

function checkAuthor(a, where, errs) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return errs.push(`${where}: author must be a Person/Organization object`);
  if (!['Person', 'Organization'].includes(a['@type'])) errs.push(`${where}: author @type ${a['@type']}`);
  if (!nonEmpty(a.name)) errs.push(`${where}: author.name missing`);
  if (!isUrl(a.url)) errs.push(`${where}: author.url not an absolute URL`);
}

function checkCounter(c, where, errs) {
  for (const x of [c].flat()) {
    if (x?.['@type'] !== 'InteractionCounter') errs.push(`${where}: interactionStatistic @type`);
    if (!isUrl(x?.interactionType)) errs.push(`${where}: interactionType must be a schema.org action URL`);
    if (!Number.isInteger(x?.userInteractionCount) || x.userInteractionCount < 0) errs.push(`${where}: userInteractionCount must be a non-negative integer`);
  }
}

/** Recursively validates a JSON-LD node; returns nothing, pushes messages into errs. */
function checkNode(n, where, errs) {
  if (Array.isArray(n)) return n.forEach((x, i) => checkNode(x, `${where}[${i}]`, errs));
  if (!n || typeof n !== 'object') return;
  const type = n['@type'];
  if (POSTING.has(type)) {
    checkAuthor(n.author, where, errs);
    if (!ISO_DT.test(n.datePublished ?? '')) errs.push(`${where}: datePublished "${n.datePublished}" not ISO 8601 with timezone`);
    if (!nonEmpty(n.text) && !n.image && !n.video) errs.push(`${where}: needs text, image or video`);
    if (type !== 'Comment' && !nonEmpty(n.headline)) errs.push(`${where}: headline missing`);
    if (!isUrl(n.url)) errs.push(`${where}: url`);
  }
  if (n.sharedContent) {
    const s = n.sharedContent;
    if (!POSTING.has(s['@type'])) {
      if (!isUrl(s.url)) errs.push(`${where}.sharedContent: url`);
      if (!nonEmpty(s.headline) && !nonEmpty(s.name)) errs.push(`${where}.sharedContent: headline`);
    }
  }
  if (n.isPartOf !== undefined && !isUrl(n.isPartOf) && !isUrl(n.isPartOf?.url)) errs.push(`${where}: isPartOf`);
  if (n.interactionStatistic) checkCounter(n.interactionStatistic, where, errs);
  if (type === 'ProfilePage') {
    const m = n.mainEntity;
    if (!['Person', 'Organization'].includes(m?.['@type']) || !nonEmpty(m?.name)) errs.push(`${where}: ProfilePage.mainEntity must be a named Person/Organization`);
    for (const k of ['dateCreated', 'dateModified']) if (n[k] !== undefined && !ISO_DT.test(n[k])) errs.push(`${where}: ${k} "${n[k]}"`);
  }
  for (const k of ['birthDate', 'deathDate']) if (n[k] !== undefined && !ISO_DATE.test(n[k]) && !ISO_DT.test(n[k])) errs.push(`${where}: ${k} "${n[k]}" is not a schema.org Date`);
  for (const k of ['url', 'image', 'logo']) for (const v of [n[k]].flat()) if (v !== undefined && typeof v !== 'object' && !isUrl(v)) errs.push(`${where}: ${k} "${v}" not a URL`);
  if (n.sameAs !== undefined) for (const v of [n.sameAs].flat()) if (!isUrl(v)) errs.push(`${where}: sameAs "${v}"`);
  for (const [k, v] of Object.entries(n)) if (v && typeof v === 'object' && k !== '@context') checkNode(v, `${where}.${k}`, errs);
}

function postPages(out) {
  const meta = JSON.parse(fs.readFileSync(path.join(out, '_p', 'meta.json'), 'utf8'));
  const ids = [...fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8').matchAll(/<loc>[^<]*\/p\/([^/<]+)\/<\/loc>/g)].map((m) => m[1]);
  const bins = new Map();
  return ids.map((id) => {
    const b = bucketOf(id, meta.n);
    if (!bins.has(b)) bins.set(b, new Uint8Array(fs.readFileSync(path.join(out, '_p', `${b}.bin`))));
    const rec = readRecord(bins.get(b), id);
    assert.ok(rec, `pack record for ${id}`);
    return [`/p/${id}/`, assemble(meta.segs, rec)];
  });
}

for (const s of SITES) {
  test(`${s.id}: JSON-LD on home, profile, about and every post page meets Google's required fields`, () => {
    const pages = [['/', fs.readFileSync(path.join(s.out, 'index.html'), 'utf8')]];
    for (const d of fs.readdirSync(path.join(s.out, 'thinkers'), { withFileTypes: true }).filter((x) => x.isDirectory())) {
      for (const sub of ['', 'about/']) {
        const f = path.join(s.out, 'thinkers', d.name, sub, 'index.html');
        if (fs.existsSync(f)) pages.push([`/thinkers/${d.name}/${sub}`, fs.readFileSync(f, 'utf8')]);
      }
    }
    const posts = postPages(s.out);
    assert.ok(posts.length > 100, `${s.id}: ${posts.length} post pages`);
    pages.push(...posts);

    const errs = [];
    const seen = new Map();
    for (const [p, html] of pages) {
      for (const [i, obj] of lds(html).entries()) {
        seen.set(obj['@type'], (seen.get(obj['@type']) ?? 0) + 1);
        checkNode(obj, `${p}#${i}`, errs);
      }
    }
    for (const t of ['WebSite', 'ProfilePage', 'DiscussionForumPosting']) assert.ok(seen.get(t), `${s.id}: no ${t} emitted`);
    assert.deepEqual(errs.slice(0, 25), [], `${errs.length} structured-data problems on ${s.id}`);
  });
}
