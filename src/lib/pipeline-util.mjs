// Small shared helpers for the daily pipeline (no dependencies).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hash8 = (s) => sha256(s).slice(0, 8);

/** Seeded PRNG (mulberry32 over a sha256-derived 32-bit seed). Same parts → same stream. */
export function seededRng(...parts) {
  let a = parseInt(sha256(parts.join('\u241f')).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted pick over [[key, weight], …]; null when every weight is 0. */
export function weightedPick(rand, entries) {
  const list = entries.filter(([, w]) => Number.isFinite(w) && w > 0);
  const total = list.reduce((s, [, w]) => s + w, 0);
  if (!total) return null;
  let x = rand() * total;
  for (const [k, w] of list) {
    x -= w;
    if (x <= 0) return k;
  }
  return list[list.length - 1][0];
}

export function shuffle(rand, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically: temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Time zones (Intl only; DST-safe).

/** Offset of `tz` at instant `ms`, in minutes (local − UTC). */
export function tzOffsetMinutes(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** UTC ms for local wall time `date` (YYYY-MM-DD) + hour:minute in `tz`. */
export function zonedTime(date, hour, minute, tz, second = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, second);
  let ms = guess - tzOffsetMinutes(guess, tz) * 60000;
  ms = guess - tzOffsetMinutes(ms, tz) * 60000;
  return ms;
}

/** Editorial day [start, end) in UTC ms for local date in tz. */
export function editorialDay(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: zonedTime(date, 0, 0, tz), end: zonedTime(next, 0, 0, tz) };
}

/** Today's local date (YYYY-MM-DD) in tz. */
export function localDate(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export const isoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

// ---------------------------------------------------------------------------
// Tiny BM25 over short passages.

const STOP = new Set('a an the and or of to in on at for is are was were be been it its this that with as by from but not no i you he she we they me my your his her our their what which who whom so if then than there here do does did have has had will would can could should may might must shall into out up down over about all any each more most other some such only own same too very just also how when where why'.split(' '));
export const tokens = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));

export function bm25Index(docs, textOf = (d) => d.text, { k1 = 1.2, b = 0.75 } = {}) {
  const toks = docs.map((d) => tokens(textOf(d)));
  const avg = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length);
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  return {
    search(query, limit = 5) {
      const q = [...new Set(tokens(query))];
      const scored = toks.map((t, i) => {
        let s = 0;
        for (const w of q) {
          const f = t.filter((x) => x === w).length;
          if (!f) continue;
          const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
          s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
        }
        return [s, i];
      });
      return scored.filter(([s]) => s > 0).sort((a, b2) => b2[0] - a[0] || a[1] - b2[1]).slice(0, limit).map(([s, i]) => ({ score: s, doc: docs[i] }));
    },
  };
}
