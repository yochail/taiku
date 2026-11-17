import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from '../src/lib/data.mjs';
import { quotaFailure, quotaReasons } from '../scripts/ci-quota.mjs';
import { loadPersonas } from '../src/lib/data.mjs';

// The Nov 7 2026 repair: exit 0, no budget hit, but Groq / Gemini 429s left the day gate failing.
const rateLimitedRepair = {
  status: 'complete',
  budget: { maxCalls: 90, used: 16, budgetHit: false, timeUp: false },
  models: [
    { name: 'cf-gemma-4-26b-micro', calls: 3, '429s': 0, items: 6 },
    { name: 'gemini-3.5-flash', calls: 8, '429s': 1, items: 6, capped: 'HTTP 429: [{ "error": { "code": 429' },
    { name: 'groq-qwen3.8-27b', calls: 2, '429s': 1, items: 0, capped: 'HTTP 429: {"error":{"message":"Rate limit reached' },
  ],
};
const cleanRun = {
  status: 'complete',
  budget: { maxCalls: 90, used: 40, budgetHit: false, timeUp: false },
  models: [{ name: 'cf-llama-3.3-70b', calls: 40, '429s': 0, items: 30 }, { name: 'groq-gpt-oss-120b', calls: 0, '429s': 0, items: 0, capped: 'no allowance' }],
};

test('quotaReasons: 429s / capped models / budget hit / wall clock are quota; a clean run is not', () => {
  const r = quotaReasons(rateLimitedRepair);
  assert.equal(r.length, 2);
  assert.match(r.join('; '), /gemini-3\.5-flash 1x429/);
  assert.match(r.join('; '), /groq-qwen3\.8-27b 1x429/);
  assert.deepEqual(quotaReasons(cleanRun), []);
  assert.deepEqual(quotaReasons({ ...cleanRun, budget: { budgetHit: true } }), ['LLM quota / call budget exhausted']);
  assert.deepEqual(quotaReasons({ ...cleanRun, budget: { timeUp: true } }), ['wall clock reached']);
  assert.deepEqual(quotaReasons({ models: [{ name: 'x', capped: 'allowance used' }] }), ['x capped (allowance used)']);
  assert.deepEqual(quotaReasons(null), []);
});

test('quotaFailure: only the fatal error decides, not 429 lines logged while rotating', () => {
  const quota = 'model groq capped: HTTP 429: Rate limit reached\nLlmError: model groq-qwen3.8-27b capped mid-turn\n    at Object.chat (file:///x/rotation.mjs:200:19)';
  assert.match(quotaFailure(quota), /capped mid-turn/);
  assert.ok(quotaFailure('Error: HTTP 429: {"error":{"message":"Rate limit reached for model"}}\n    at f (x.mjs:1:1)'));
  const bug = 'model gemini capped: HTTP 429: quota\nTypeError: Cannot read properties of undefined (reading \'posts\')\n    at runDaily (file:///x/run.mjs:900:3)';
  assert.equal(quotaFailure(bug), null);
  assert.equal(quotaFailure('Error: --repair: sites/x/daily.json does not exist; run the day first'), null);
  assert.equal(quotaFailure(''), null);
  assert.equal(quotaFailure('model x capped: HTTP 429: quota\nLlmAuthError: HTTP 401: authentication/authorization rejected for openrouter. Check OPENROUTER_API_KEY.\n    at x (llm.mjs:1:1)'), null);
});

// End to end: scripts/ci-generate.sh with a stub `npm` that writes a run manifest and exits with a code.
const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
const SCRATCH = path.join(ROOT, 'test', '.ci-quota-scratch');
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function ciGenerate(name, { rc, manifest, stderr = '', candidates = null, existingDay = null }, args = []) {
  const dir = path.join(SCRATCH, name);
  const bin = path.join(dir, 'bin');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  const runs = path.join(dir, 'sites/x/content/runs');
  fs.writeFileSync(path.join(dir, 'stub-manifest.json'), manifest ? JSON.stringify(manifest) : '');
  fs.writeFileSync(path.join(dir, 'stub-stderr.txt'), stderr);
  if (candidates) {
    fs.mkdirSync(path.join(dir, 'sites/x/staging/2026-11-07'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sites/x/staging/2026-11-07/candidates.json'), JSON.stringify(candidates));
  }
  if (existingDay) {
    fs.mkdirSync(path.join(dir, 'sites/x/content/posts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sites/x/content/posts/daily-2026-11-07.json'), JSON.stringify(existingDay));
  }
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/usr/bin/env bash\nmkdir -p "${runs.replace(/\\/g, '/')}"\n[ -s stub-manifest.json ] && cp stub-manifest.json "${runs.replace(/\\/g, '/')}/2026-11-07.json"\ncat stub-stderr.txt >&2\nexit ${rc}\n`,
    { mode: 0o755 },
  );
  const out = path.join(dir, 'out.txt');
  const sum = path.join(dir, 'summary.md');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/ci-generate.sh').replace(/\\/g, '/'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SITE: candidates || existingDay ? 'taiku' : 'x', POSTS_DIR: path.join(dir, 'sites/x/content/posts'), GEN_DATE: '2026-11-07', DAYFILE: 'sites/x/content/posts/daily-2026-11-07.json', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, MOCK: '', FORCE: '', GEN_NONCE: '' },
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { status: r.status, stdout: r.stdout, output: read(out), summary: read(sum), skipped: read(path.join(dir, 'gen-meta/skipped.txt')), quota: read(path.join(dir, 'gen-meta/quota-repair.txt')),
    day: read(path.join(dir, 'sites/x/content/posts/daily-2026-11-07.json')) };
}

test('ci-generate.sh: a rate-limited repair is flagged quota=true for the gate after repair', { skip: bash.status !== 0 && 'no bash' }, () => {
  const r = ciGenerate('repair-429', { rc: 0, manifest: rateLimitedRepair }, ['--repair']);
  assert.equal(r.status, 0);
  assert.match(r.output, /^quota=true$/m);
  assert.doesNotMatch(r.output, /soft=true/);
  assert.match(r.quota, /groq-qwen3\.8-27b 1x429/);
});

test('ci-generate.sh: a clean repair is not quota, so a still-failing gate blocks', { skip: bash.status !== 0 && 'no bash' }, () => {
  const r = ciGenerate('repair-clean', { rc: 0, manifest: cleanRun }, ['--repair']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.output, /quota=true/);
  const none = ciGenerate('repair-none', { rc: 0, manifest: rateLimitedRepair, stderr: 'day gate fails but no item is regenerable (persona.format_run); not repairing\n' }, ['--repair']);
  assert.doesNotMatch(none.output, /quota=true/, 'a repair that did not run leaves the old manifest: not evidence');
});

test('ci-generate.sh: a repair that dies on a rate limit ends green with a warning and a summary', { skip: bash.status !== 0 && 'no bash' }, () => {
  const r = ciGenerate('repair-dies', { rc: 1, stderr: 'model groq capped: HTTP 429\nLlmError: model groq-qwen3.8-27b capped mid-turn\n    at x (rotation.mjs:1:1)\n' }, ['--repair']);
  assert.equal(r.status, 0);
  assert.match(r.output, /^soft=true$/m);
  assert.match(r.stdout, /::warning title=Daily feed fallback skipped \(x\)::generate --repair failed on LLM quota/);
  assert.match(r.summary, /### Daily feed fallback: `x` 2026-11-07 skipped/);
  assert.match(r.skipped, /quota/);
});

test('ci-generate.sh: a genuine error still fails', { skip: bash.status !== 0 && 'no bash' }, () => {
  const r = ciGenerate('bug', { rc: 1, manifest: rateLimitedRepair, stderr: "TypeError: Cannot read properties of undefined (reading 'posts')\n    at runDaily (run.mjs:1:1)\n" }, ['--repair']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=Daily feed fallback failed/);
  assert.doesNotMatch(r.output, /soft=true|quota=true/);
  assert.equal(r.skipped, '');
  const auth = ciGenerate('auth', { rc: 1, stderr: 'LlmAuthError: HTTP 401: authentication/authorization rejected for openrouter. Check OPENROUTER_API_KEY.\n    at x (llm.mjs:1:1)\n' });
  assert.equal(auth.status, 1);
  assert.doesNotMatch(auth.output, /soft=true|quota=true/);
  assert.equal(auth.skipped, '');
});

test('ci-generate.sh: a partial run stays a soft skip', { skip: bash.status !== 0 && 'no bash' }, () => {
  const r = ciGenerate('partial', { rc: 2, manifest: { ...rateLimitedRepair, status: 'partial', budget: { budgetHit: true } } });
  assert.equal(r.status, 0);
  assert.match(r.output, /^soft=true$/m);
  assert.match(r.output, /^quota=true$/m);
  assert.match(r.summary, /ended \*\*partial\*\*/);
});

test('ci-generate.sh: a usable partial day is salvaged without inference; unsafe or mock candidates never publish', { skip: bash.status !== 0 && 'no bash' }, () => {
  const authors = loadPersonas().filter((p) => p.kind !== 'news');
  const posts = Array.from({ length: 4 }, (_, i) => ({ id: `salvage-${i}`, authorId: authors[i].id, origin: 'cloudflare',
    type: i ? 'joke' : 'hot_take', text: ['A new question for this morning.', 'Try a different starting point.', 'The premise needs work.', 'What would change your mind?'][i],
    createdAt: `2026-11-07T10:${13 + i * 3}:17Z`, ...(i ? { inReplyTo: 'salvage-0' } :
      { media: [{ kind: 'gif', src: '/test.gif', alt: 'A reaction.', rating: 'g' }] }) }));
  const candidates = { origin: 'cloudflare', provider: 'fixture', threadPolicy: { min: 3, max: 8 }, posts };
  const manifest = { ...rateLimitedRepair, status: 'partial' };
  const r = ciGenerate('usable-partial', { rc: 2, manifest, candidates });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.output, /^partial=true$/m, r.stdout);
  assert.doesNotMatch(r.output, /soft=true/);
  assert.equal(JSON.parse(r.day).posts.length, 4);
  assert.equal(JSON.parse(r.day).publication.status, 'partial');
  assert.match(r.summary, /4\/4 existing posts retained/);
  const unsafe = ciGenerate('unsafe-partial', { rc: 2, manifest, candidates: { ...candidates, posts: posts.map((p) => ({ ...p, text: 'https://example.com' })) } });
  assert.equal(unsafe.day, '');
  assert.match(unsafe.output, /soft=true/);
  assert.match(unsafe.summary, /unpublishable/);
  const mock = ciGenerate('mock-partial', { rc: 2, manifest, candidates: { ...candidates, origin: 'mock' } });
  assert.notEqual(mock.status, 0);
  assert.equal(mock.day, '');
  const quota = ciGenerate('quota-existing', { rc: 1, manifest: null, existingDay: candidates,
    stderr: 'LlmError: model test capped mid-turn\n    at test (rotation.mjs:1:1)\n' }, ['--repair']);
  assert.equal(quota.status, 0, quota.stdout);
  assert.match(quota.output, /partial=true/);
  assert.doesNotMatch(quota.output, /soft=true/);
  assert.equal(JSON.parse(quota.day).publication.retained, 4);
  const auth = ciGenerate('auth-existing', { rc: 1, manifest: null, existingDay: candidates,
    stderr: 'LlmAuthError: HTTP 401: rejected\n    at test (llm.mjs:1:1)\n' });
  assert.equal(auth.status, 1, 'authentication failures must not be hidden by salvage');
  assert.doesNotMatch(auth.output, /partial=true/);
});

test('generate.yml: the gate after repair turns a rate-limited repair into a green skip, nothing published', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/generate.yml'), 'utf8');
  const regate = yml.slice(yml.indexOf('id: regate'), yml.indexOf('- name: Validate content'));
  assert.match(regate, /REPAIR_QUOTA: \$\{\{ steps\.repair\.outputs\.quota \}\}/);
  assert.match(regate, /if \[ "\$REPAIR_QUOTA" = "true" \]/);
  assert.match(regate, /::warning title=Daily feed fallback skipped/);
  assert.match(regate, /GITHUB_STEP_SUMMARY/);
  assert.match(regate, /gen-meta\/skipped\.txt/);
  assert.match(regate, /exit 1\s*$/);
  // Every step that leads to publishing is gated on all three soft outputs.
  const record = yml.slice(yml.indexOf('- name: Record the day file for publish'), yml.indexOf('- name: Upload generated content'));
  for (const s of ['gen', 'repair', 'regate']) assert.match(record, new RegExp(`steps\\.${s}\\.outputs\\.soft != 'true'`));
  // The publish job skips a site whose generate leg wrote gen-meta/skipped.txt.
  assert.match(yml, /if \[ -f gen-meta\/skipped\.txt \]; then/);
});

test('publish distinguishes unapproved diagnostic output from a missing approved file', { skip: bash.status !== 0 && 'no bash' }, () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/generate.yml'), 'utf8');
  const step = yml.split('- name: Generated day file present?')[1].split('      - name:')[0];
  const script = step.split('        run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  for (const state of ['unapproved', 'missing', 'quota']) {
    const dir = path.join(SCRATCH, `publish-${state}`);
    fs.mkdirSync(path.join(dir, 'gen-meta'), { recursive: true });
    if (state === 'missing') fs.writeFileSync(path.join(dir, 'gen-meta/dayfile.txt'), 'sites/x/content/posts/daily-2026-11-17.json');
    if (state === 'quota') fs.writeFileSync(path.join(dir, 'gen-meta/skipped.txt'), 'quota exhausted');
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, SITE: 'x', GITHUB_OUTPUT: 'out.txt' } });
    assert.equal(r.status, state === 'missing' ? 1 : 0, r.stderr);
    assert.match(r.stdout, state === 'missing' ? /::error::.*approved a missing day file/ : /::notice::/);
    if (state !== 'missing') assert.match(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), /ok=false/);
    if (state === 'unapproved') assert.match(r.stdout, /did not approve a day for publication/);
  }
});
