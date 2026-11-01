#!/usr/bin/env node
// Spot-checks that link cards and real-post quotes in the corpus still resolve.
// Usage: node scripts/check-links.mjs [--sample N] [--summary FILE] [--strict]
// Samples N distinct card URLs (rotating daily), GETs each with a timeout and reports 2xx/3xx as ok,
// 401/403/429 as bot-blocked (the page exists but refuses crawlers), anything else as dead.
// Exit 0 unless --strict and some URL is dead.
import fs from 'node:fs';
import { CARD_KINDS, loadPosts } from '../src/lib/data.mjs';
import { UA } from '../src/lib/unfurl.mjs';
import { hash8 } from '../src/lib/pipeline-util.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const sample = Number(opt('--sample', 40)) || 40;
const summary = opt('--summary', null);
const strict = args.includes('--strict');

const where = new Map();
for (const p of loadPosts()) for (const m of p.media ?? []) if (CARD_KINDS.has(m.kind) && m.url && !where.has(m.url)) where.set(m.url, p.id);
const day = new Date().toISOString().slice(0, 10);
const urls = [...where.keys()].sort((a, b) => hash8(`${day}:${a}`).localeCompare(hash8(`${day}:${b}`))).slice(0, sample);

async function probe(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    res.body?.cancel().catch(() => {});
    return { url, status: res.status, verdict: res.ok ? 'ok' : [401, 403, 429].includes(res.status) ? 'blocked' : 'dead' };
  } catch (e) {
    return { url, status: 0, verdict: 'dead', error: String(e?.cause?.code ?? e?.name ?? e) };
  }
}

const results = [];
for (let i = 0; i < urls.length; i += 8) results.push(...(await Promise.all(urls.slice(i, i + 8).map(probe))));
const count = (v) => results.filter((r) => r.verdict === v).length;
const dead = results.filter((r) => r.verdict === 'dead');
const lines = [
  `### Link check (${results.length} of ${where.size} card URLs)`,
  '',
  `ok ${count('ok')} · bot-blocked ${count('blocked')} · dead ${dead.length}`,
  ...(dead.length ? ['', '| status | url | post |', '|---|---|---|', ...dead.map((r) => `| ${r.status || r.error} | ${r.url} | ${where.get(r.url)} |`)] : []),
  '',
];
console.log(lines.join('\n'));
if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`);
if (strict && dead.length) process.exit(1);
