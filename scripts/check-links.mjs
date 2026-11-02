#!/usr/bin/env node
// Link card health for the current site (SITE=<id>).
// Usage: node scripts/check-links.mjs [--sample N] [--summary FILE] [--strict] [--no-probe]
// 1) Offline, always: every link_card must carry a preview image (the article's og:image or the topic
//    fallback art from linkCardFrom). Cards without one fail the run (exit 1) unless their domain or URL is
//    listed in sites/<site>/config/link-image-allowlist.json ({ "domains": [], "urls": [] }).
// 2) Network probe (skip with --no-probe): samples N distinct card URLs (rotating daily), GETs each with a
//    timeout and reports 2xx/3xx as ok, 401/403/429 as bot-blocked (the page exists but refuses crawlers),
//    anything else as dead. Dead URLs fail the run only with --strict.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_KINDS, loadPosts } from '../src/lib/data.mjs';
import { safeFetch } from '../src/lib/safe-fetch.mjs';
import { hash8 } from '../src/lib/pipeline-util.mjs';
import { SITE_DIR } from '../src/lib/site.mjs';

export const ALLOWLIST_FILE = path.join(SITE_DIR, 'config', 'link-image-allowlist.json');

export function loadImageAllowlist(file = ALLOWLIST_FILE) {
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { domains: raw.domains ?? [], urls: raw.urls ?? [] };
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** link_cards with no preview image that the allowlist doesn't excuse: [{ id, url, title }]. */
export function cardsMissingImages(posts, allowlist = { domains: [], urls: [] }) {
  const domains = new Set((allowlist.domains ?? []).map((d) => String(d).toLowerCase().replace(/^www\./, '')));
  const urls = new Set(allowlist.urls ?? []);
  const excused = (u) => {
    const h = hostOf(u);
    return urls.has(u) || [...domains].some((d) => h === d || h.endsWith(`.${d}`));
  };
  const out = [];
  for (const p of posts) for (const m of p.media ?? []) if (m.kind === 'link_card' && !m.image?.url && !excused(m.url)) out.push({ id: p.id, url: m.url, title: m.title ?? '' });
  return out;
}

async function probe(url) {
  try {
    const res = await safeFetch(url, { timeoutMs: 12000, maxBytes: 4096 });
    const live = res.status >= 200 && res.status < 300;
    return { url, status: res.status, verdict: live ? 'ok' : [401, 403, 429].includes(res.status) ? 'blocked' : 'dead' };
  } catch (e) {
    return { url, status: 0, verdict: 'dead', error: String(e?.cause?.code ?? e?.name ?? e) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
  };
  const sample = Number(opt('--sample', 40)) || 40;
  const summary = opt('--summary', null);
  const strict = args.includes('--strict');
  const posts = loadPosts();

  const cards = posts.flatMap((p) => (p.media ?? []).filter((m) => m.kind === 'link_card'));
  const missing = cardsMissingImages(posts, loadImageAllowlist());
  const lines = [
    `### Link card images (${cards.length} cards)`,
    '',
    `with image ${cards.filter((m) => m.image?.url).length} · topic fallback art ${cards.filter((m) => m.image?.fallback).length} · missing ${missing.length}`,
    ...(missing.length ? ['', '| post | url |', '|---|---|', ...missing.map((r) => `| ${r.id} | ${r.url} |`)] : []),
    '',
  ];

  let dead = [];
  if (!args.includes('--no-probe')) {
    const where = new Map();
    for (const p of posts) for (const m of p.media ?? []) if (CARD_KINDS.has(m.kind) && m.url && !where.has(m.url)) where.set(m.url, p.id);
    const day = new Date().toISOString().slice(0, 10);
    const urls = [...where.keys()].sort((a, b) => hash8(`${day}:${a}`).localeCompare(hash8(`${day}:${b}`))).slice(0, sample);
    const results = [];
    for (let i = 0; i < urls.length; i += 8) results.push(...(await Promise.all(urls.slice(i, i + 8).map(probe))));
    const count = (v) => results.filter((r) => r.verdict === v).length;
    dead = results.filter((r) => r.verdict === 'dead');
    lines.push(
      `### Link check (${results.length} of ${where.size} card URLs)`,
      '',
      `ok ${count('ok')} · bot-blocked ${count('blocked')} · dead ${dead.length}`,
      ...(dead.length ? ['', '| status | url | post |', '|---|---|---|', ...dead.map((r) => `| ${r.status || r.error} | ${r.url} | ${where.get(r.url)} |`)] : []),
      '',
    );
  }
  console.log(lines.join('\n'));
  if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`);
  if (missing.length) {
    console.error(`${missing.length} link card(s) without a preview image; rerun \`npm run links:backfill -- --refresh-images\` or allowlist them in ${path.relative(process.cwd(), ALLOWLIST_FILE)}`);
    process.exit(1);
  }
  if (strict && dead.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
