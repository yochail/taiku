#!/usr/bin/env node
/**
 * Promote human-reviewed staged taiks into published content.
 *
 *   node scripts/promote.mjs <date> --list
 *   node scripts/promote.mjs <date> --all
 *   node scripts/promote.mjs <date> --topic <topicId> [--topic <topicId> …]
 *   flags: --dry-run (print only), --mock (use the -mock staging dir), --root <dir>
 *
 * Moves the selected groups from staging/<date>/posts.json into content/posts/<date>-promoted.json
 * (merging, never duplicating), pulling in any staged ancestors a selected post replies to or quotes.
 * The whole corpus is validated before anything is written; staging is rewritten (or removed when empty).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_DIR, loadPersonas, validate } from '../src/lib/data.mjs';
import { loadOtherPosts, outputPaths } from '../src/lib/run.mjs';
import { readJson, writeJsonAtomic } from '../src/lib/pipeline-util.mjs';

export function parseArgs(argv) {
  const o = { date: null, topics: [], all: false, list: false, dryRun: false, mock: false, root: SITE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--list') o.list = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--mock') o.mock = true;
    else if (a === '--topic') o.topics.push(argv[++i]);
    else if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) o.date = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** Pure promotion step: returns { promote, remain } given a staging doc and selected topic ids. */
export function selectPromotion(doc, { all = false, topics = [] } = {}) {
  const byId = new Map(doc.posts.map((p) => [p.id, p]));
  const want = new Set();
  for (const g of doc.groups ?? []) if (all || topics.includes(g.topicId)) for (const id of g.postIds) want.add(id);
  const unknown = topics.filter((t) => !(doc.groups ?? []).some((g) => g.topicId === t));
  // Pull in staged ancestors so promoted replies/quotes never dangle.
  const stack = [...want];
  while (stack.length) {
    const p = byId.get(stack.pop());
    for (const ref of [p?.inReplyTo, p?.quoteOf]) if (ref && byId.has(ref) && !want.has(ref)) { want.add(ref); stack.push(ref); }
  }
  const promote = doc.posts.filter((p) => want.has(p.id));
  const remain = doc.posts.filter((p) => !want.has(p.id));
  const groups = (doc.groups ?? []).map((g) => ({ ...g, postIds: g.postIds.filter((id) => !want.has(id)) })).filter((g) => g.postIds.length);
  return { promote, remain, groups, unknown };
}

export function promote(opts) {
  const paths = outputPaths(opts.root, opts.date, { mock: opts.mock });
  const doc = readJson(paths.staged, null);
  if (!doc) return { ok: false, error: `nothing staged at ${path.relative(opts.root, paths.staged)}` };
  if (opts.list || (!opts.all && !opts.topics.length)) {
    return { ok: true, list: (doc.groups ?? []).map((g) => ({ topicId: g.topicId, tier: g.tier, title: g.title, url: g.url, posts: g.postIds.length })), reason: doc.reason };
  }
  const { promote: moving, remain, groups, unknown } = selectPromotion(doc, opts);
  if (unknown.length) return { ok: false, error: `unknown topic id(s): ${unknown.join(', ')}` };
  if (!moving.length) return { ok: false, error: 'selection is empty' };

  const target = path.join(paths.postsDir, `${opts.date}-promoted${opts.mock ? '-mock' : ''}.json`);
  const existing = readJson(target, { posts: [] });
  const others = loadOtherPosts(paths.postsDir, [target]);
  const taken = new Set([...others, ...existing.posts].map((p) => p.id));
  const add = moving.filter((p) => !taken.has(p.id));
  const merged = [...existing.posts, ...add].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));

  const pdir = path.join(opts.root, 'personas');
  const personas = opts.personas ?? (fs.existsSync(pdir) ? loadPersonas(pdir) : loadPersonas());
  const errors = validate(personas, [...others, ...merged.map((p) => ({ ...p, _file: path.basename(target) }))])
    .filter((e) => !/^(persona |duplicate persona|duplicate handle)/.test(e));
  if (errors.length) return { ok: false, error: 'validation failed', errors };

  if (!opts.dryRun) {
    writeJsonAtomic(target, { runId: doc.runId, promotedAt: new Date().toISOString(), posts: merged });
    if (remain.length) writeJsonAtomic(paths.staged, { ...doc, groups, posts: remain });
    else fs.rmSync(paths.staged);
  }
  return { ok: true, dryRun: opts.dryRun, promoted: add.length, skippedDuplicates: moving.length - add.length, remaining: remain.length, target: path.relative(opts.root, target) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (!opts.date) throw new Error('usage: node scripts/promote.mjs <YYYY-MM-DD> (--list | --all | --topic <id>…) [--dry-run] [--mock]');
  } catch (e) {
    console.error(e.message);
    process.exit(64);
  }
  const res = promote(opts);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
