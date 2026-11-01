import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, validate } from '../src/lib/data.mjs';
import { loadDistribution } from '../src/lib/crowd.mjs';
import { outputPaths, runDaily } from '../src/lib/run.mjs';
import { createMockClient } from '../src/lib/mock.mjs';
import { promote } from '../scripts/promote.mjs';
import { newsPersona, parodyPersona, realPersonas } from './fixtures/pipeline-fixtures.mjs';

const spec = loadDistribution();
const base = realPersonas();
const SCRATCH = path.join(ROOT, 'test', '.pipeline-scratch');
let n = 0;
const freshRoot = () => {
  const dir = path.join(SCRATCH, `r${++n}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

const DATE = '2026-11-02';
const run = (o) => runDaily({ date: DATE, mock: true, quiet: true, seed: 'test', nonce: 'nonce1', spec, personas: base, env: {}, ...o });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const persErr = (e) => !/^(persona |duplicate persona|duplicate handle)/.test(e);

test('news wire flow: wire posts carry headline + link_card, thinkers quote/reply/retaik them, parody joins', async () => {
  const personas = [...base, newsPersona(base[0]), parodyPersona(base[1])];
  const root = freshRoot();
  const r = await run({ root, personas });
  assert.equal(r.status, 'complete', JSON.stringify(r.manifest?.completeness));
  const posts = [...r.published, ...r.staged];
  const wires = posts.filter((p) => p.authorId === 'agora_wire');
  const withUrl = r.topics.picks.filter((t) => t.url);
  assert.equal(wires.length, withUrl.length, 'one wire post per topic with a feed URL');
  for (const w of wires) {
    const topic = r.topics.picks.find((t) => t.id === w.topic.id);
    assert.ok(['wire', 'news_take'].includes(w.type));
    assert.equal(w.media[0].kind, 'link_card');
    assert.equal(w.media[0].url, topic.url, 'link card URL is copied from the feed item');
    assert.ok(w.text.startsWith(topic.title.slice(0, 20)), 'real headline first');
    const reactions = posts.filter((p) => p.quoteOf === w.id || p.inReplyTo === w.id);
    assert.ok(reactions.length >= 1, `thinkers react to wire ${w.id}`);
    assert.ok(reactions.every((p) => p.authorId !== 'agora_wire'));
  }
  assert.ok(wires.some((w) => (w.personaReposts ?? []).length + (w.personaLikes ?? []).length > 0), 'retaiks/likes land on wire posts');
  assert.ok(!posts.some((p) => p.type === 'news_take' && !p.inReplyTo && !p.quoteOf && p.authorId !== 'agora_wire' && p.topic), 'no hidden-topic roots when a wire exists');
  const parodyActs = r.manifest.reactions.filter((x) => x.personaId === 'zenos_arrow').length + r.manifest.tasks.filter((t) => t.personaId === 'zenos_arrow').length;
  assert.ok(parodyActs > 0, 'parody account takes part in the reaction graph');
  assert.ok(!r.manifest.tasks.some((t) => t.personaId === 'agora_wire' && t.role !== 'wire'), 'wire accounts never reply/quote');
  const errors = validate(personas, posts.map((p) => ({ ...p, _file: 'x' }))).filter(persErr);
  assert.deepEqual(errors, []);
});

test('fallback without news personas: 1–2 thinker roots per topic with topic{}', async () => {
  const root = freshRoot();
  const r = await run({ root });
  assert.equal(r.status, 'complete');
  const posts = [...r.published, ...r.staged];
  for (const t of r.topics.picks) {
    const roots = posts.filter((p) => p.topic?.id === t.id && !p.inReplyTo && !p.quoteOf);
    assert.ok(roots.length >= 1 && roots.length <= 2, `${t.id}: ${roots.length} roots`);
  }
  for (const p of posts) {
    for (const k of ['likedBy', 'repostedBy', 'engagement']) assert.equal(p[k], undefined, `old field ${k}`);
    assert.ok(Array.isArray(p.personaLikes) && Number.isFinite(p.crowdLikeBase) && Number.isFinite(p.views));
    assert.equal(p.runId, r.manifest.runId);
    assert.ok(p.taskId && p.promptVersion && p.model && p.origin === 'mock');
    for (const m of p.media ?? []) if (m.kind !== 'link_card') assert.match(m.src, /^\/media\/[A-Za-z0-9_-]+-\d+\.svg$/);
  }
  const times = posts.map((p) => Date.parse(p.createdAt));
  assert.ok(Math.max(...times) - Math.min(...times) > 6 * 3.6e6, 'posts are spread through the day (drip)');
  assert.ok(r.manifest.reactions.length > 0 && r.manifest.reactions.every((x) => x.taskId));
  assert.ok(!JSON.stringify(posts).includes('"reactions"'), 'reaction debug log never leaks into posts');
});

test('idempotent + resumable: rerunning the same date skips done tasks and never duplicates', async () => {
  const root = freshRoot();
  const a = await run({ root, nonce: undefined });
  const paths = outputPaths(root, DATE, { mock: true });
  const first = read(paths.posts).posts.map((p) => p.id);
  const manifest = read(paths.run);
  assert.ok(manifest.nonce, 'nonce is logged');
  const b = await run({ root, nonce: undefined });
  assert.equal(b.manifest.nonce, manifest.nonce, 'resume reuses the logged nonce');
  assert.equal(b.manifest.budget.used, 0, 'no LLM calls on a complete rerun');
  const second = read(paths.posts).posts.map((p) => p.id);
  assert.deepEqual(second, first);
  assert.equal(new Set(second).size, second.length);
  assert.ok(b.manifest.tasks.every((t) => t.status !== 'done' || t.resumed));
  assert.equal(a.manifest.tasks[0].taskId, b.manifest.tasks[0].taskId, 'stable task ids');
  // replay with the logged nonce in a new root gives the same plan
  const c = await run({ root: freshRoot(), nonce: manifest.nonce });
  assert.deepEqual(c.manifest.tasks.map((t) => t.taskId), b.manifest.tasks.map((t) => t.taskId));
  const d = await run({ root: freshRoot(), nonce: 'other-nonce' });
  assert.notDeepEqual(d.manifest.reactions.map((x) => `${x.taskId}:${x.personaId}:${x.action}`), c.manifest.reactions.map((x) => `${x.taskId}:${x.personaId}:${x.action}`));
});

test('budget exhaustion → partial: exit 2, nothing published, rerun resumes', async () => {
  const root = freshRoot();
  const paths = outputPaths(root, DATE, { mock: true });
  const r = await run({ root, maxCalls: 6 });
  assert.equal(r.status, 'partial');
  assert.equal(r.exitCode, 2);
  assert.ok(!fs.existsSync(paths.posts), 'no published content for a partial day');
  assert.equal(read(paths.run).status, 'partial');
  assert.ok(read(paths.run).budget.budgetHit);
  const done1 = r.manifest.tasks.filter((t) => t.status === 'done').length;
  const r2 = await run({ root });
  assert.equal(r2.status, 'complete');
  assert.equal(r2.manifest.tasks.filter((t) => t.resumed).length, done1, 'finished turns are reused');
});

test('community topics are staged; promote moves them into content without duplicates', async () => {
  const root = freshRoot();
  const r = await run({ root });
  const paths = outputPaths(root, DATE, { mock: true });
  const community = new Set(r.topics.picks.filter((t) => t.tier === 'community').map((t) => t.id));
  assert.ok(community.size > 0, 'fixture feeds include community topics');
  for (const p of r.published) assert.ok(!community.has(p.topic?.id), 'community topics never auto-publish');
  const staged = read(paths.staged);
  assert.ok(staged.posts.length > 0 && staged.groups.length > 0);
  const ids = new Set(r.published.map((p) => p.id));
  for (const p of r.published) for (const ref of [p.inReplyTo, p.quoteOf]) if (ref) assert.ok(ids.has(ref), 'published posts never depend on staged ones');

  const listed = promote({ root, date: DATE, mock: true, list: true, topics: [] });
  assert.ok(listed.list.length > 0);
  const one = promote({ root, date: DATE, mock: true, topics: [listed.list[0].topicId], personas: base });
  assert.equal(one.ok, true, JSON.stringify(one));
  const all = promote({ root, date: DATE, mock: true, all: true, topics: [], personas: base });
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.ok(!fs.existsSync(paths.staged), 'staging emptied');
  const promoted = read(path.join(root, 'content', 'posts', `${DATE}-promoted-mock.json`)).posts;
  assert.equal(promoted.length, staged.posts.length);
  // a rerun after promotion must not re-stage or duplicate promoted posts
  const again = await run({ root });
  assert.equal(again.staged.length, 0);
  assert.ok(!again.published.some((p) => promoted.some((q) => q.id === p.id)));
});

test('kill switch PUBLISH_ENABLED=false writes only to staging', async () => {
  const root = freshRoot();
  const r = await run({ root, env: { PUBLISH_ENABLED: 'false' } });
  assert.equal(r.status, 'complete');
  assert.equal(r.published.length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'content')), 'content/ untouched');
  const paths = outputPaths(root, DATE, { mock: true, publish: false });
  assert.ok(read(paths.staged).posts.length > 0);
  assert.match(read(paths.staged).reason, /PUBLISH_ENABLED/);
  assert.ok(fs.existsSync(paths.run));
});

test('dry-run writes nothing', async () => {
  const root = freshRoot();
  const r = await runDaily({ date: DATE, dryRun: true, quiet: true, seed: 'ci', spec, personas: base, env: {}, root });
  assert.equal(r.status, 'complete');
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a policy failure fails the whole topic', async () => {
  const root = freshRoot();
  const inner = createMockClient({ nonce: 'p' });
  // Every turn that mentions the football headline in its prompt answers with a URL (policy violation).
  const client = {
    cfg: inner.cfg,
    isMock: true,
    stats: inner.stats,
    get calls() { return inner.calls; },
    get remaining() { return inner.remaining; },
    async chat(body) {
      const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
      if (/Football club/i.test(user)) return { message: { role: 'assistant', content: JSON.stringify({ text: 'details at evil-site.com' }) } };
      return inner.chat(body);
    },
  };
  const r = await run({ root, client });
  const topic = r.manifest.topics.find((t) => /Football club/.test(t.title));
  assert.ok(topic, 'fixture topic picked');
  assert.equal(topic.status, 'blocked');
  assert.ok(![...r.published, ...r.staged].some((p) => p.topic?.id === topic.id || r.manifest.tasks.find((t) => t.postId === p.id)?.topicId === topic.id));
  assert.ok(r.manifest.tasks.some((t) => t.topicId === topic.id && t.status === 'blocked'));
});
