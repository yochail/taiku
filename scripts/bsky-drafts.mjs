#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas } from '../src/lib/data.mjs';
import { ROOT, SITE, SITE_CONFIG } from '../src/lib/site.mjs';
import { createBlueskyDrafts, writeBlueskyDrafts } from '../src/lib/bsky-drafts.mjs';

function option(name) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  if (SITE !== 'taiku' || SITE_CONFIG.content_locale !== 'en') {
    throw new Error(`Bluesky drafts are English Taiku only (got SITE=${SITE}, locale=${SITE_CONFIG.content_locale})`);
  }
  const sample = process.argv.includes('--sample');
  const gatePassed = process.argv.includes('--gate-passed');
  if (sample === gatePassed) throw new Error('pass exactly one of --sample or --gate-passed');
  const date = option('--date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error('--date must be a valid YYYY-MM-DD date');
  }
  const source = option('--file');
  if (!source || !fs.existsSync(source)) throw new Error('--file must name an existing Taiku posts JSON file');
  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const dayPosts = Array.isArray(raw) ? raw : raw?.posts;
  if (!Array.isArray(dayPosts)) throw new Error(`invalid post source ${source}: expected a posts array`);
  if (!sample && (/-mock\.json$/i.test(source) || [raw.origin, raw.provider, raw.mode].some((value) => ['mock', 'dry-run'].includes(value)) || dayPosts.some((post) => post.origin === 'mock'))) {
    throw new Error('mock and dry-run input is only allowed with --sample');
  }
  const outDir = path.resolve(option('--out') ?? path.join(ROOT, '_scratch', 'bsky-drafts', 'taiku'));
  const selected = createBlueskyDrafts({ date, dayPosts, personas: loadPersonas(), sample, threadBaseUrl: SITE_CONFIG.baseUrl });
  const result = await writeBlueskyDrafts(selected, outDir);
  console.log(`Bluesky image drafts prepared for human review: ${result.posts.length} English Taiku posts; ${sample ? 'sample only' : 'gate-approved input'}; no Bluesky requests or posts made.`);
  for (const post of result.posts) console.log(`  ${post.authorName}: ${post.image}`);
}

try {
  await main();
} catch (error) {
  console.error(`Bluesky draft export failed: ${error.message}`);
  process.exitCode = 1;
}
