#!/usr/bin/env node
// Quota classifier for the Daily feed fallback (scripts/ci-generate.sh, .github/workflows/generate.yml).
// Tells a quota / rate-limit day (free-tier LLM providers exhausted: not a defect, the job ends green
// with a warning and publishes nothing) apart from a genuine error (which must still fail the job).
//
//   node scripts/ci-quota.mjs manifest <run manifest>  exit 0 + reasons when that run was quota-limited
//   node scripts/ci-quota.mjs log <generate output>    exit 0 + reason when the run died on a quota error
// Any other outcome exits 1 (not quota).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Rotation marks these when a model's own plan ran out; not a provider limit.
const NOT_PROVIDER = new Set(['no allowance']);

/** Why a run was limited by LLM quota / rate limits ([] = it was not). */
export function quotaReasons(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  const b = manifest.budget ?? {};
  const out = [];
  if (b.budgetHit) out.push('LLM quota / call budget exhausted');
  if (b.timeUp) out.push('wall clock reached');
  for (const m of manifest.models ?? []) {
    const n = Number(m?.['429s']) || 0;
    const capped = typeof m?.capped === 'string' && !NOT_PROVIDER.has(m.capped) ? m.capped : null;
    if (n > 0 || capped) out.push(`${m.name ?? m.model ?? '?'} ${n > 0 ? `${n}x429` : 'capped'}${capped ? ` (${capped.slice(0, 60)})` : ''}`);
  }
  return out;
}

const QUOTA_ERR = /\b(HTTP 429|429 Too Many Requests|rate.?limit|quota|capped( mid-turn)?|exhausted mid-turn|Retry-After \d+s exceeds limit|budget exhausted)\b/i;

/**
 * The fatal error of a failed generate run, if it was a quota / rate-limit error. Only the thrown
 * error counts (the last `SomethingError: …` header of the uncaught stack), not 429 lines logged
 * earlier by the rotation while it switched models.
 */
export function quotaFailure(logText) {
  const lines = String(logText ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*(?:Uncaught\s+)?([A-Za-z]*Error)(?: \[[^\]]*\])?: (.*)$/.exec(lines[i]);
    if (!m) continue;
    return QUOTA_ERR.test(m[2]) ? `${m[1]}: ${m[2].slice(0, 160)}` : null;
  }
  return null;
}

function main([kind, file]) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 1;
  }
  let reasons = [];
  if (kind === 'manifest') {
    try {
      reasons = quotaReasons(JSON.parse(text));
    } catch {}
  } else if (kind === 'log') {
    const r = quotaFailure(text);
    if (r) reasons = [r];
  } else {
    console.error('usage: ci-quota.mjs manifest|log <file>');
    return 2;
  }
  if (!reasons.length) return 1;
  console.log(reasons.join('; '));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
