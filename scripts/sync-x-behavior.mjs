#!/usr/bin/env node
// Writes/updates ONLY the `x_behavior` key of every personas/<id>.json from DEFAULT_X_BEHAVIOR
// (src/lib/behavior.mjs). Text-level edit: all other keys and their formatting are left untouched.
//   node scripts/sync-x-behavior.mjs            # add missing x_behavior blocks
//   node scripts/sync-x-behavior.mjs --force    # overwrite existing blocks with the defaults
//   node scripts/sync-x-behavior.mjs --check    # validate only
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PERSONAS_DIR } from '../src/lib/data.mjs';
import { DEFAULT_X_BEHAVIOR, GENERIC_X_BEHAVIOR, validateBehavior } from '../src/lib/behavior.mjs';

const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');
const KEY_ORDER = Object.keys(GENERIC_X_BEHAVIOR);

function render(b, eol) {
  const lines = KEY_ORDER.filter((k) => b[k] !== undefined).map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(b[k]).replace(/","/g, '", "').replace(/,(?=\d|-)/g, ', ')}`);
  return `  "x_behavior": {${eol}${lines.join(`,${eol}`)}${eol}  }`;
}

let changed = 0;
const errors = [];
for (const f of fs.readdirSync(PERSONAS_DIR).filter((x) => x.endsWith('.json')).sort()) {
  const file = path.join(PERSONAS_DIR, f);
  const text = fs.readFileSync(file, 'utf8');
  const before = JSON.parse(text);
  const id = before.id;
  if (checkOnly || (before.x_behavior && !force)) {
    errors.push(...validateBehavior(id, before.x_behavior ? { ...GENERIC_X_BEHAVIOR, ...before.x_behavior } : null));
    continue;
  }
  const def = DEFAULT_X_BEHAVIOR[id];
  if (!def) {
    errors.push(`${id}: no DEFAULT_X_BEHAVIOR entry`);
    continue;
  }
  errors.push(...validateBehavior(id, def));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = render(def, eol);
  let out;
  const existing = /(\r?\n)  "x_behavior": \{[\s\S]*?\r?\n  \}/;
  if (before.x_behavior && existing.test(text)) out = text.replace(existing, (m, nl) => nl + block);
  else {
    const body = text.trimEnd();
    if (!body.endsWith('}')) throw new Error(`${f}: unexpected JSON layout`);
    out = `${body.slice(0, -1).trimEnd()},${eol}${block}${eol}}${eol}`;
  }
  const after = JSON.parse(out);
  const { x_behavior: _a, ...restBefore } = before;
  const { x_behavior: written, ...restAfter } = after;
  if (!isDeepStrictEqual(restBefore, restAfter) || !isDeepStrictEqual(written, def)) throw new Error(`${f}: round-trip mismatch, not written`);
  // Re-read right before writing to minimise the window for concurrent edits of other keys.
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`${f}: changed while processing — rerun`);
  fs.writeFileSync(file, out);
  changed++;
}
if (errors.length) {
  console.error('✖ x_behavior problems:\n  ' + errors.join('\n  '));
  process.exit(1);
}
console.log(checkOnly ? '✔ x_behavior valid for all personas' : `✔ x_behavior written to ${changed} persona file(s)`);
