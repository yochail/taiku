// Post pages served by the Worker (src/worker) must match the static build byte for byte.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker/index.mjs';
import { readPostPage } from '../src/lib/postpack.mjs';
import { SITE_DIR } from '../src/lib/site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = path.join(ROOT, 'dist-worker-static');
const PACKED = path.join(ROOT, 'dist-worker-pack');
const POSTS = path.join(ROOT, 'test', '.worker-posts');
const ORIGIN = 'https://example.test';

const build = (out, extra) =>
  execFileSync(process.execPath, [path.join(ROOT, 'src', 'build.mjs')], {
    env: { ...process.env, POSTS_DIR: POSTS, OUT_DIR: out, BUILD_NOW: '2026-11-01T12:00:00Z', ...extra },
    stdio: 'pipe',
  });

// Fake ASSETS binding over a built dist: files, auto-trailing-slash index.html, 404.html with status 404.
const env = {
  ASSETS: {
    async fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      let file = path.join(PACKED, p);
      if (p.endsWith('/')) file = path.join(file, 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return new Response(fs.readFileSync(file), { status: 200 });
      return new Response(fs.readFileSync(path.join(PACKED, '404.html')), { status: 404 });
    },
  },
};
const ctx = { waitUntil() {} };
const get = (p, init) => worker.fetch(new Request(ORIGIN + p, init), env, ctx);

let ids = [];
before(() => {
  fs.rmSync(POSTS, { recursive: true, force: true });
  fs.mkdirSync(POSTS, { recursive: true });
  // The seed file is self-contained (replies and quotes point inside it).
  fs.copyFileSync(path.join(SITE_DIR, 'content', 'posts', '0000-seed.json'), path.join(POSTS, '0000-seed.json'));
  build(STATIC, { POST_PAGES: 'static' });
  build(PACKED, { POST_PAGES: '' });
  ids = fs.readdirSync(path.join(STATIC, 'p'));
});
after(() => {
  for (const d of [STATIC, PACKED, POSTS]) fs.rmSync(d, { recursive: true, force: true });
});

const norm = (s) => s.replace(/data-build="[^"]*"/, '');

test('packed build emits no per-post files and the Worker serves every post identically', async () => {
  assert.ok(ids.length > 20, `seed has ${ids.length} posts`);
  assert.ok(!fs.existsSync(path.join(PACKED, 'p')), 'no dist/p in packed build');
  for (const id of ids) {
    const want = fs.readFileSync(path.join(STATIC, 'p', id, 'index.html'), 'utf8');
    assert.equal(norm(readPostPage(PACKED, id)), norm(want), `pack ${id}`);
    const res = await get(`/p/${id}/`);
    assert.equal(res.status, 200, id);
    assert.equal(norm(await res.text()), norm(want), `worker ${id}`);
  }
});

test('Worker applies _headers, ETag/304, HEAD, redirects and 404s like the assets layer', async () => {
  const id = ids[0];
  const res = await get(`/p/${id}/`);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
  const etag = res.headers.get('etag');
  assert.equal((await get(`/p/${id}/`, { headers: { 'if-none-match': etag } })).status, 304);
  const head = await get(`/p/${id}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const p of [`/p/${id}`, `/p/${id}/index.html`]) {
    const r = await get(p);
    assert.equal(r.status, 307, p);
    assert.equal(r.headers.get('location'), `${ORIGIN}/p/${id}/`);
  }
  const miss = await get('/p/no-such-post-xyz/');
  assert.equal(miss.status, 404);
  assert.match(await miss.text(), /<html/);
  assert.equal((await get('/about/')).status, 200, 'non-post paths pass through to assets');
});
