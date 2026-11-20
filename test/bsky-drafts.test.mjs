import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBlueskyDrafts, renderBlueskyPostSvg, writeBlueskyDrafts } from '../src/lib/bsky-drafts.mjs';

const DATE = '2026-11-20';
const persona = { id: 'ada', name: 'Ada Lovelace', handle: 'analytical_engine', avatar: { color: '#5267a8' } };
const sentence = (suffix = '') => `A careful observation about public life deserves evidence before confidence wins the argument.${suffix}`;
const root = (id, text, extra = {}) => ({ id, authorId: 'ada', text, createdAt: `${DATE}T12:00:00Z`, ...extra });

test('selects only distinct, standalone English Taiku text and keeps source links separate', () => {
  const posts = [
    root('one', sentence(), { media: [{ kind: 'link_card', url: 'https://example.org/report' }] }),
    root('duplicate', sentence()),
    root('hebrew', 'הטקסט הזה בעברית אינו יכול לצאת לטיוטת Bluesky באנגלית.'),
    root('mixed', `${sentence()} עברית`),
    { ...root('reply', sentence()), inReplyTo: 'parent' },
    root('poll', sentence(), { type: 'poll' }),
    root('x-ref', sentence(), { media: [{ kind: 'x_post', url: 'https://x.com/Reuters/status/123456789' }] }),
  ];
  const result = createBlueskyDrafts({ date: DATE, dayPosts: posts, personas: [persona], sample: true });

  assert.equal(result.site, 'taiku');
  assert.equal(result.status, 'sample');
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].text, posts[0].text);
  assert.equal(result.posts[0].sourceUrl, 'https://example.org/report');
  assert.ok(!result.posts[0].svg.includes('example.org/report'), 'the optional source link stays outside the image');
});

test('renders complete text and descriptive alt without truncation', () => {
  const message = 'Evidence matters more than the speed of a confident conclusion. Ask who measured it, what was counted, and what the missing cases might change.';
  const svg = renderBlueskyPostSvg(persona, message, { sample: true });

  assert.ok(svg.includes('SAMPLE · NOT POSTED'));
  assert.ok(svg.includes('not an actual Bluesky post'));
  assert.ok(svg.includes('Evidence matters more than the speed of a confident conclusion.'));
  assert.ok(svg.includes('what the missing cases might change.'));
  assert.ok(svg.includes('<desc'));
  assert.equal(svg.includes('…'), false);
  const imageHeight = Number(svg.match(/width="1200" height="(\d+)"/)?.[1]);
  const footerBaseline = Number(svg.match(/<text x="92" y="(\d+)"[^>]*fill="#9a5c14"/)?.[1]);
  assert.ok(imageHeight - footerBaseline >= 70, 'the full-text layout leaves room for its review label and bottom padding');

  const [draft] = createBlueskyDrafts({
    date: DATE, dayPosts: [root('full-message', message)], personas: [persona], sample: true,
  }).posts;
  assert.equal(draft.text, message);
  assert.ok(draft.alt.includes(message));
  assert.equal(draft.svg, svg);
});

test('browser export writes an uploadable PNG and matching alt text', { skip: process.env.TEST_BSKY_PNG !== '1' }, async () => {
  const message = 'Evidence matters more than a confident conclusion.\nCheck the evidence again. That includes looking in a café. 🔍';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taiku-bsky-drafts-'));
  try {
    const written = await writeBlueskyDrafts(createBlueskyDrafts({
      date: DATE,
      dayPosts: [root('full-message', message)],
      personas: [persona],
      sample: true,
    }), dir);
    const [draft] = JSON.parse(fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8')).posts;
    assert.equal(draft.text, message);
    assert.ok(draft.alt.includes(message));
    assert.match(draft.image, /\.png$/);
    const png = fs.readFileSync(path.join(dir, draft.image));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), 1200);
    assert.ok(png.length < 1_000_000);
    assert.equal(written.posts.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enforces the five-image cap and a zero cap', () => {
  const posts = Array.from({ length: 7 }, (_, i) => root(`p${i}`, sentence(` Item ${i}`)));
  assert.equal(createBlueskyDrafts({ date: DATE, dayPosts: posts, personas: [persona] }).posts.length, 5);
  assert.equal(createBlueskyDrafts({ date: DATE, dayPosts: posts, personas: [persona], limit: 0 }).posts.length, 0);
});

test('rejects invalid dates, oversized text and non-Taiku workflows', () => {
  assert.throws(() => createBlueskyDrafts({ date: '2026-02-31', dayPosts: [], personas: [] }), /invalid draft date/);
  assert.throws(() => renderBlueskyPostSvg(persona, 'A'.repeat(281)), /must be English/);

  const run = spawnSync(process.execPath, ['scripts/bsky-drafts.mjs', '--date', DATE, '--file', 'missing.json', '--sample'], {
    cwd: process.cwd(),
    env: { ...process.env, SITE: 'tarya' },
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /English Taiku only/);
});

test('daily workflow exports only gate-approved Taiku drafts as review artifacts, never posts to Bluesky', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github', 'workflows', 'generate.yml'), 'utf8');
  const step = workflow.split('- name: Create English Bluesky image drafts')[1].split('      - name:')[0];
  assert.match(step, /matrix\.site == 'taiku' && inputs\.mock != true/);
  assert.match(step, /steps\.gate\.outcome == 'success'.*steps\.contentvalidate\.outcome == 'success'.*steps\.contentchecks\.outcome == 'success'/);
  assert.match(step, /scripts\/bsky-drafts\.mjs/);
  assert.match(step, /--gate-passed/);
  const artifact = workflow.split('- name: Upload Bluesky draft images')[1].split('      - name:')[0];
  assert.match(artifact, /_scratch\/bsky-drafts\/taiku/);
  assert.match(artifact, /retention-days: 14/);
  assert.doesNotMatch(workflow, /bsky\.social\/xrpc|com\.atproto\.repo\.createRecord|public\.api\.bsky\.app.*POST/);
});
