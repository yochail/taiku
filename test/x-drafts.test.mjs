import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createDrafts, draftStateFrom, loadRecentDailyPosts, renderDraftMarkdown, xComposerUrl } from '../src/lib/x-drafts.mjs';

const DATE = '2026-11-14';
const BASE = 'https://taiku.app';
const text = (name, suffix = '') => `${name} sees a public argument and asks whether its confident conclusion has actually been earned.${suffix}`;
const root = (id, authorId, body = text(id), extra = {}) => ({ id, authorId, text: body, createdAt: `${DATE}T12:00:00Z`, ...extra });

test('creates a small, persona-diverse set of verbatim English post drafts', () => {
  const posts = Array.from({ length: 8 }, (_, i) => root(`p${i}`, `persona${i % 6}`));
  posts[1] = { ...posts[1], text: posts[0].text };
  posts.push(root('reshare', 'extra', text('reshare'), { type: 'retaik' }));
  const result = createDrafts({ date: DATE, dayPosts: posts, threadBaseUrl: BASE });

  assert.equal(result.posts.length, 5);
  assert.equal(new Set(result.posts.map((x) => x.authorId)).size, 5);
  assert.equal(new Set(result.posts.map((x) => x.text.toLowerCase())).size, 5);
  assert.ok(!result.posts.some((x) => x.sourcePostId === 'reshare'));
  assert.equal(result.posts[0].text, posts[0].text);
  assert.equal(new URL(result.posts[0].openInXUrl).searchParams.get('text'), posts[0].text);
  assert.equal(new URL(result.posts[0].openInXUrl).searchParams.has('in_reply_to'), false);
  assert.equal(result.posts[0].taikuThreadUrl, 'https://taiku.app/p/p0/');
  assert.equal(result.comments.length, 0);
  assert.equal(Object.keys(result.state.seen).length, 5);
});

test('comment drafts use only stored X status URLs and keep the Taiku reference separate', () => {
  const url = 'https://x.com/Reuters/status/123456789012345?ref=taiku';
  const post = root('thread-root', 'kant', text('thread-root'), {
    media: [{ kind: 'x_post', url, handle: 'Reuters', text: 'Stored exact source text.' }],
  });
  const result = createDrafts({ date: DATE, dayPosts: [], recentPosts: [post], threadBaseUrl: BASE });
  const [comment] = result.comments;
  assert.equal(result.posts.length, 0);
  assert.equal(comment.originalUrl, url);
  assert.equal(comment.originalPostId, '123456789012345');
  assert.equal(comment.text, post.text);
  assert.equal(comment.taikuThreadUrl, `${BASE}/p/thread-root/`);
  const composer = new URL(comment.openInXUrl);
  assert.equal(composer.searchParams.get('in_reply_to'), '123456789012345');
  assert.equal(composer.searchParams.get('text'), post.text);
  assert.match(renderDraftMarkdown(result), /\[Open in X — review and reply\]\(https:\/\/twitter\.com\/intent\/tweet\?/);
  assert.ok(!JSON.stringify(result.state).includes('123456789012345'));
  assert.match(renderDraftMarkdown(result), /\[Reuters · 123456789012345\]\(https:\/\/x\.com\/Reuters\/status\/123456789012345\?ref=taiku\)/);
  assert.match(renderDraftMarkdown(result), /Taiku thread reference: \[open separately\]\(https:\/\/taiku\.app\/p\/thread-root\/\)/);
});

test('X composer links preserve Unicode, punctuation and newlines without injecting parameters', () => {
  const body = 'Curie: café 😀 & science? #evidence + 100%\n"Try (again)."';
  const url = new URL(xComposerUrl(body, '1234567890123456789'));
  assert.equal(url.origin, 'https://twitter.com');
  assert.equal(url.pathname, '/intent/tweet');
  assert.equal(url.searchParams.get('text'), body);
  assert.equal(url.searchParams.get('in_reply_to'), '1234567890123456789');
  assert.deepEqual([...url.searchParams.keys()], ['text', 'in_reply_to']);
  assert.ok(url.href.includes('%F0%9F%98%80'));
  assert.ok(url.href.includes('%26'));
  assert.ok(url.href.includes('%0A'));
  assert.throws(() => xComposerUrl(body, '12345&other=target'), /invalid X reply target/);
});

test('comment drafts are capped at three and never reuse a persona or X status', () => {
  const posts = Array.from({ length: 8 }, (_, i) => root(`comment${i}`, `persona${i % 5}`, text(`comment${i}`), {
    media: [{ kind: 'x_post', url: `https://x.com/Reuters/status/${123456789 + i}`, handle: 'Reuters' }],
  }));
  const result = createDrafts({ date: DATE, dayPosts: [], recentPosts: posts, threadBaseUrl: BASE });
  assert.equal(result.comments.length, 3);
  assert.equal(new Set(result.comments.map((x) => x.authorId)).size, 3);
  assert.equal(new Set(result.comments.map((x) => x.originalPostId)).size, 3);
});

test('rejects invented targets, Hebrew text, old posts, oversized text and duplicate drafts', () => {
  const recent = [
    root('invalid-url', 'a', text('invalid-url'), { media: [{ kind: 'x_post', url: 'https://example.com/status/123456789' }] }),
    root('hebrew', 'b', 'הטקסט הזה בעברית והוא לא צריך להופיע בטיוטה באנגלית.'),
    root('too-long', 'c', 'a'.repeat(281)),
    root('valid', 'd', text('valid'), { media: [{ kind: 'x_post', url: 'https://twitter.com/Reuters/status/123456789' }] }),
    { ...root('old', 'e', text('old'), { media: [{ kind: 'x_post', url: 'https://x.com/Reuters/status/223456789' }] }), createdAt: '2026-11-01T10:00:00Z' },
  ];
  const first = createDrafts({ date: DATE, dayPosts: recent.slice(0, 3), recentPosts: recent, threadBaseUrl: BASE });
  assert.deepEqual(first.posts, []);
  assert.deepEqual(first.comments.map((x) => x.sourcePostId), ['valid']);
  assert.ok(first.comments[0].text.length <= 280);
  const next = createDrafts({ date: DATE, dayPosts: recent.slice(0, 3), recentPosts: recent, state: first.state, threadBaseUrl: BASE });
  assert.deepEqual(next.comments, []);
  assert.deepEqual(next.posts, []);
  const emoji = root('emoji', 'f', 'a'.repeat(80) + '😀'.repeat(100));
  const astral = root('astral', 'g', 'a'.repeat(80) + '😀'.repeat(101));
  const lengths = createDrafts({ date: DATE, dayPosts: [emoji, astral], threadBaseUrl: BASE });
  assert.deepEqual(lengths.posts.map((x) => x.sourcePostId), ['emoji']);
});

test('recent daily X references load only from the last seven days and ignore mock files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiku-x-drafts-'));
  try {
    const write = (name, posts) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ posts }));
    write('daily-2026-11-12.json', []);
    write('daily-2026-11-13-mock.json', [{ id: 'mock' }]);
    write('daily-2026-11-06.json', [{ id: 'old' }]);
    write('daily-2026-11-10.json', [{ id: 'recent' }]);
    const posts = loadRecentDailyPosts(dir, DATE, path.join(dir, 'daily-2026-11-14.json'), [{ id: 'current' }]);
    assert.deepEqual(posts.map((x) => x.id), ['current', 'recent']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state format is validated and persisted output is human-readable', () => {
  assert.deepEqual(draftStateFrom(null), { version: 1, seen: {} });
  assert.throws(() => draftStateFrom({ version: 2, seen: {} }), /invalid X draft state/);
  const markdown = renderDraftMarkdown({ date: DATE, posts: [], comments: [] });
  assert.match(markdown, /Drafts only\. Nothing was sent to X/);
  assert.match(markdown, /No new eligible post drafts/);
});

test('pipeline CLI writes downloadable JSON and Markdown using only stored post data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiku-x-draft-cli-'));
  try {
    const source = path.join(dir, 'daily.json');
    const out = path.join(dir, 'out');
    const state = path.join(dir, 'state.json');
    const url = 'https://x.com/Reuters/status/123456789';
    const post = root('thread-root', 'kant', text('cli'), {
      media: [{ kind: 'x_post', url, handle: 'Reuters', text: 'Stored source.' }],
    });
    fs.writeFileSync(source, JSON.stringify({ posts: [post] }));
    execFileSync(process.execPath, [
      'scripts/x-drafts.mjs', '--date', DATE, '--file', source, '--out', out, '--state', state,
    ], { cwd: process.cwd(), env: { ...process.env, SITE: 'taiku' }, stdio: 'pipe' });
    const json = JSON.parse(fs.readFileSync(path.join(out, 'drafts.json'), 'utf8'));
    const markdown = fs.readFileSync(path.join(out, 'drafts.md'), 'utf8');
    assert.equal(json.comments[0].originalUrl, url);
    assert.equal(json.comments[0].originalPostId, '123456789');
    assert.equal(new URL(json.comments[0].openInXUrl).searchParams.get('in_reply_to'), '123456789');
    assert.equal(json.posts.length, 0);
    assert.match(markdown, /Taiku thread reference/);
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).version, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow uploads drafts when the daily feed was skipped and persists state without X posting', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'generate.yml'), 'utf8');
  assert.match(workflow, /git show "FETCH_HEAD:\$f" > "\$f"/);
  assert.match(workflow, /git show "FETCH_HEAD:\$draft_state" > "\$draft_state"/);
  assert.match(workflow, /Create English X post and comment drafts[\s\S]*?if: always\(\) && matrix\.site == 'taiku' && inputs\.mock != true/);
  assert.match(workflow, /steps\.contentvalidate\.outcome == 'success' && steps\.contentchecks\.outcome == 'success'/);
  assert.match(workflow, /Upload readable X drafts[\s\S]*?retention-days: 14/);
  assert.match(workflow, /Show X drafts and download link in run summary[\s\S]*?steps\.draftartifact\.outcome == 'success'/);
  assert.match(workflow, /DRAFT_ARTIFACT_URL: \$\{\{ steps\.draftartifact\.outputs\.artifact-url \}\}/);
  assert.match(workflow, /cat _scratch\/x-drafts\/taiku\/drafts\.md >> "\$GITHUB_STEP_SUMMARY"/);
  assert.doesNotMatch(workflow, /CF_EMAIL_API_TOKEN|X_DRAFT_EMAIL_|smtp|send-x-drafts-email/);
  assert.match(workflow, /Download X draft dedupe state[\s\S]*?name: x-draft-state-taiku-/);
  assert.match(workflow, /git add sites\/taiku\/content\/state\/x-draft-state\.json/);
  assert.doesNotMatch(workflow, /api\.x\.com|twitter\.com\/i\/|statuses\/update/);
});

test('run summary contains the actual upload URL and readable composer drafts; missing URL fails', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'generate.yml'), 'utf8');
  const step = workflow.split('- name: Show X drafts and download link in run summary')[1].split('      - name:')[0];
  const script = step.split('        run: |\n')[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiku-summary-'));
  try {
    const draftDir = path.join(dir, '_scratch', 'x-drafts', 'taiku');
    fs.mkdirSync(draftDir, { recursive: true });
    const result = createDrafts({ date: DATE, dayPosts: [root('p1', 'kant')], threadBaseUrl: BASE });
    fs.writeFileSync(path.join(draftDir, 'drafts.md'), renderDraftMarkdown(result));
    const artifactUrl = 'https://github.com/example/repo/actions/runs/1/artifacts/1234';
    const env = { ...process.env, GITHUB_STEP_SUMMARY: 'summary.md', DRAFT_ARTIFACT_URL: artifactUrl };
    const run = spawnSync('bash', ['-e', '-c', script], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const summary = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8');
    assert.ok(summary.includes(`[Download draft artifact](${artifactUrl})`));
    assert.ok(summary.includes(result.posts[0].openInXUrl));
    assert.ok(summary.includes(result.posts[0].text));
    assert.match(summary, /14 days/);
    const missing = spawnSync('bash', ['-e', '-c', script], { cwd: dir, env: { ...env, DRAFT_ARTIFACT_URL: '' }, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /draft upload returned no artifact link/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
