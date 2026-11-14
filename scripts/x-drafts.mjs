#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { displayName, loadPersonas } from '../src/lib/data.mjs';
import { ROOT, SITE, SITE_CONFIG, sitePath } from '../src/lib/site.mjs';
import { createDrafts, draftStateFrom, loadRecentDailyPosts, renderDraftMarkdown } from '../src/lib/x-drafts.mjs';

function option(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1] ?? null;
}

function postsFrom(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const posts = Array.isArray(raw) ? raw : raw?.posts;
  if (!Array.isArray(posts)) throw new Error(`invalid post source ${file}: expected a posts array`);
  return posts;
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

function main() {
  if (SITE !== 'taiku') throw new Error(`X drafts are English-only and only enabled for SITE=taiku (got ${SITE})`);
  if (SITE_CONFIG.content_locale !== 'en') throw new Error(`X drafts require English Taiku content (got ${SITE_CONFIG.content_locale})`);
  const date = option('--date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('--date must be a valid YYYY-MM-DD date');
  }
  const inputs = [option('--file'), option('--fallback'), option('--staging')].filter(Boolean);
  const file = inputs.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`no Taiku post source is available for ${date}; checked ${inputs.join(', ') || '(no source paths supplied)'}`);

  const source = path.resolve(file);
  const postsDir = sitePath('content', 'posts');
  const dayPosts = postsFrom(source);
  const recentPosts = loadRecentDailyPosts(postsDir, date, source, dayPosts);
  const stateFile = path.resolve(option('--state') ?? sitePath('content', 'state', 'x-draft-state.json'));
  let state = null;
  if (fs.existsSync(stateFile)) {
    try {
      state = draftStateFrom(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    } catch (error) {
      throw new Error(`cannot load ${path.relative(ROOT, stateFile)}: ${error.message}`);
    }
  }
  const selected = createDrafts({ date, dayPosts, recentPosts, state, threadBaseUrl: SITE_CONFIG.baseUrl });
  const names = new Map(loadPersonas().map((persona) => [persona.id, displayName(persona)]));
  const result = {
    ...selected,
    posts: selected.posts.map((draft) => ({ ...draft, authorName: names.get(draft.authorId) || draft.authorId })),
    comments: selected.comments.map((draft) => ({ ...draft, authorName: names.get(draft.authorId) || draft.authorId })),
  };
  const outDir = path.resolve(option('--out') ?? path.join(ROOT, '_scratch', 'x-drafts', SITE));
  const json = {
    site: SITE,
    date,
    source: path.relative(ROOT, source),
    generatedAt: new Date().toISOString(),
    posts: result.posts,
    comments: result.comments,
  };

  writeAtomic(path.join(outDir, 'drafts.json'), `${JSON.stringify(json, null, 2)}\n`);
  writeAtomic(path.join(outDir, 'drafts.md'), renderDraftMarkdown(result));
  writeAtomic(stateFile, `${JSON.stringify(selected.state, null, 2)}\n`);
  console.log(`X drafts prepared from ${path.relative(ROOT, source)}: ${result.posts.length} posts, ${result.comments.length} comments; no X requests made.`);
}

try {
  main();
} catch (error) {
  console.error(`X draft generation failed: ${error.message}`);
  process.exitCode = 1;
}
