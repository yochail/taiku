#!/usr/bin/env node
// Downloads the public-domain source texts listed in personas/<id>.json (`sources[]` entries that
// have both `download` and `local`), strips Project Gutenberg headers/licence boilerplate, applies
// the optional `excerpt` slicing rules and writes UTF-8 / LF excerpt files under sources/<id>/.
// These committed excerpts are what search_quotes reads at generation time (no network then).
//
//   node scripts/fetch-sources.mjs              # fetch/refresh every source (idempotent)
//   node scripts/fetch-sources.mjs --only kant  # one persona (repeatable / comma-separated)
//   node scripts/fetch-sources.mjs --check      # offline: verify every local file exists + has a header
//   node scripts/fetch-sources.mjs --force      # rewrite files even if unchanged
//   node scripts/fetch-sources.mjs --cache dir  # keep raw downloads in dir (reuse them on re-runs)
//
// `excerpt` rules (all optional; markers are matched whitespace-insensitively):
//   { start, startOccurrence = 1,   // excerpt begins AT this marker (inclusive); nth occurrence
//     end, endOccurrence = 1,       // ...and stops BEFORE this marker (searched after start)
//     maxChars,                     // cap; cut back to the last paragraph break
//     ranges: [ {start, startOccurrence, end, endOccurrence, maxChars}, … ],  // several slices,
//                                   // joined with a "[…]" separator line; top-level maxChars caps the total
//     keepUnderscores: false }      // Gutenberg _italic_ markers are stripped unless true
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const HEADER_MARK = '# taiku-source:';

const args = process.argv.slice(2);
const check = args.includes('--check');
const force = args.includes('--force');
const only = new Set();
const cacheDir = args.includes('--cache') ? path.resolve(args[args.indexOf('--cache') + 1]) : null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--only' && args[i + 1]) for (const id of args[++i].split(',')) only.add(id.trim());
  else if (args[i].startsWith('--only=')) for (const id of args[i].slice(7).split(',')) only.add(id.trim());
}

function loadSources() {
  const out = [];
  for (const f of fs.readdirSync(PERSONAS_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const p = JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, f), 'utf8'));
    if (only.size && !only.has(p.id)) continue;
    for (const s of p.sources ?? []) if (s.local) out.push({ persona: p, source: s });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markerRe = (m) => {
  const s = String(m).trim();
  const body = s.split(/\s+/).map(escapeRe).join('\\s+');
  // Whole-word at the edges so 'BOOK I' never matches 'BOOK II'.
  const pre = /^[\p{L}\p{N}]/u.test(s) ? '(?<![\\p{L}\\p{N}])' : '';
  const post = /[\p{L}\p{N}]$/u.test(s) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(pre + body + post, 'gu');
};

function findMarker(text, marker, from = 0, occurrence = 1) {
  const re = markerRe(marker);
  re.lastIndex = from;
  let m;
  for (let n = 0; n < occurrence; n++) {
    m = re.exec(text);
    if (!m) return -1;
  }
  return m.index;
}

function capAtParagraph(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const para = cut.lastIndexOf('\n\n');
  return (para > maxChars * 0.6 ? cut.slice(0, para) : cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : maxChars)).trimEnd();
}

function slice(text, rule, label) {
  let a = 0;
  if (rule.start) {
    a = findMarker(text, rule.start, 0, rule.startOccurrence ?? 1);
    if (a < 0) throw new Error(`${label}: start marker not found: ${JSON.stringify(rule.start)}`);
  }
  let b = text.length;
  if (rule.end) {
    b = findMarker(text, rule.end, a + 1, rule.endOccurrence ?? 1);
    if (b < 0) throw new Error(`${label}: end marker not found: ${JSON.stringify(rule.end)}`);
  }
  return capAtParagraph(text.slice(a, b).trim(), rule.maxChars);
}

function stripGutenberg(text) {
  const start = text.match(/^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG E(BOOK|TEXT)[^\n]*\n/im);
  if (start) text = text.slice(start.index + start[0].length);
  const end = text.match(/^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG E(BOOK|TEXT)[^\n]*$/im);
  if (end) text = text.slice(0, end.index);
  // Some files end with an old-style licence block instead.
  const endOld = text.search(/^End of (the )?Project Gutenberg'?s? /im);
  if (endOld > 0) text = text.slice(0, endOld);
  return text;
}

// MediaWiki `action=raw` source → plain text (templates, refs, links and tags removed).
function cleanWikitext(t) {
  t = t.replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '');
  for (let i = 0; i < 10 && /\{\{[^{}]*\}\}/.test(t); i++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/-\{([^{}]*)\}-/g, '$1').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/<[^>]+>/g, '');
  t = t.replace(/'{2,}/g, '').replace(/^:+\*?\s*/gm, '');
  t = t.replace(/^(=+)\s*(.+?)\s*\1\s*$/gm, (_, _e, h) => (/^\d+$/.test(h) ? `【${h}】` : h));
  return t;
}

function clean(raw, excerpt = {}, label = 'source') {
  let text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').normalize('NFC');
  text = stripGutenberg(text);
  if (excerpt.format === 'wikitext' || /[?&]action=raw\b/.test(excerpt._download ?? '')) text = cleanWikitext(text);
  if (!excerpt.keepUnderscores) text = text.replace(/_([^_\n](?:[^_]{0,600}?[^_\s])?)_/g, '$1');
  let body;
  if (Array.isArray(excerpt.ranges) && excerpt.ranges.length) body = excerpt.ranges.map((r, i) => slice(text, r, `${label} range ${i + 1}`)).join('\n\n[…]\n\n');
  else body = slice(text, excerpt, label);
  body = capAtParagraph(body, excerpt.ranges ? excerpt.maxChars : null);
  return body
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function header(p, s) {
  const by = [s.author ?? p.name, s.translator ? `tr. ${s.translator}` : null, s.year ? String(s.year) : null].filter(Boolean).join(', ');
  return [
    `${HEADER_MARK} ${p.id}/${s.id}`,
    `# ${s.title} — ${by}`,
    `# License: ${s.license}. Page: ${s.url}`,
    `# Downloaded from: ${s.download}`,
    `# Excerpt generated by scripts/fetch-sources.mjs — do not edit by hand; edit the persona's sources[].excerpt and re-run.`,
    '',
    '',
  ].join('\n');
}

async function download(url, tries = 3) {
  const cached = cacheDir && path.join(cacheDir, url.replace(/[^a-z0-9]+/gi, '_').slice(-120) + '.raw');
  if (cached && fs.existsSync(cached)) return fs.readFileSync(cached, 'utf8');
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'taiku-fetch-sources/1.0 (+https://taiku.app)' }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer()).toString('utf8');
      if (cached) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cached, body);
      }
      return body;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`download failed ${url}: ${last?.message}`);
}

const list = loadSources();
const problems = [];
if (check) {
  for (const { persona: p, source: s } of list) {
    const abs = path.join(ROOT, s.local);
    if (!s.local.startsWith(`sources/${p.id}/`)) problems.push(`${p.id}/${s.id}: local must be under sources/${p.id}/`);
    if (!fs.existsSync(abs)) problems.push(`${p.id}/${s.id}: missing ${s.local}`);
    else {
      const t = fs.readFileSync(abs, 'utf8');
      if (!t.startsWith(`${HEADER_MARK} ${p.id}/${s.id}`)) problems.push(`${p.id}/${s.id}: ${s.local} lacks the provenance header`);
      if (t.includes('\r')) problems.push(`${p.id}/${s.id}: ${s.local} has CR line endings`);
      if (t.length < 2000) problems.push(`${p.id}/${s.id}: ${s.local} is suspiciously short`);
    }
  }
  if (problems.length) {
    console.error(`✖ ${problems.length} source problem(s):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`✔ ${list.length} local source file(s) present`);
  process.exit(0);
}

const cache = new Map();
let written = 0;
let total = 0;
for (const { persona: p, source: s } of list) {
  const label = `${p.id}/${s.id}`;
  if (!s.download) {
    problems.push(`${label}: has local but no download URL`);
    continue;
  }
  if (!s.local.startsWith(`sources/${p.id}/`)) {
    problems.push(`${label}: local must be under sources/${p.id}/`);
    continue;
  }
  try {
    if (!cache.has(s.download)) cache.set(s.download, download(s.download));
    const raw = await cache.get(s.download);
    const body = clean(raw, { ...(s.excerpt ?? {}), _download: s.download }, label);
    const out = header(p, s) + body + '\n';
    if (args.includes('--verbose')) for (const part of body.split('\n\n[…]\n\n')) console.log(`   ▸ ${part.slice(0, 90).replace(/\s+/g, ' ')} … ${part.slice(-60).replace(/\s+/g, ' ')}`);
    const abs = path.join(ROOT, s.local);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    const bytes = Buffer.byteLength(out);
    total += bytes;
    if (prev !== out || force) {
      fs.writeFileSync(abs, out);
      written++;
    }
    console.log(`${prev === out ? '=' : '✎'} ${s.local}  ${(bytes / 1024).toFixed(1)} KB`);
  } catch (e) {
    problems.push(`${label}: ${e.message}`);
  }
}
console.log(`${list.length} source(s), ${written} written, ${(total / 1024).toFixed(0)} KB total`);
if (problems.length) {
  console.error(`✖ ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
