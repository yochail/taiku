// Real public posts as quote targets (reference only): X via publish.twitter.com/oembed (no key),
// Bluesky via the public AppView. Text is the exact fetched text; only allowlisted public accounts
// (news outlets, institutions, public figures) from sites/<id>/real-accounts.json; deleted or
// protected posts are skipped (oEmbed 404/403, AppView returns nothing).
import fs from 'node:fs';
import { sitePath } from './site.mjs';
import { safeUrl } from './data.mjs';
import { decode, sanitizeUntrusted } from './news.mjs';
import { safeFetch } from './safe-fetch.mjs';

// Only these hosts are ever called. oEmbed is used for data only: its `html` is parsed for text
// server-side and never rendered, and widgets.js is never loaded.
export const OEMBED_HOSTS = ['publish.twitter.com', 'embed.bsky.app'];
export const API_HOSTS = ['public.api.bsky.app'];
const TEXT_MAX = 560;
const clean = (s, max = TEXT_MAX) => sanitizeUntrusted(s, max);

const BSKY = 'https://public.api.bsky.app/xrpc';
const X_STATUS = /^https:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/;
const BSKY_POST = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]{8,20})/;

const STOP = new Set('a an the of to in on for and or with as at by from is are was were be its it this that after over into new says say amid'.split(' '));
const words = (s) => new Set(String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
/** Headline similarity in [0,1]: shared content words over the shorter set, damped by the size ratio. */
export function titleOverlap(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return (n / Math.min(A.size, B.size)) * (n / Math.max(A.size, B.size)) ** 0.25;
}

export const isXStatus = (u) => X_STATUS.test(String(u ?? ''));
export const isBskyPost = (u) => BSKY_POST.test(String(u ?? ''));
export const realPostKind = (u) => (isXStatus(u) ? 'x_post' : isBskyPost(u) ? 'bsky_post' : null);

export function loadRealAccounts(file = sitePath('real-accounts.json')) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (doc.accounts ?? []).filter((a) => ['news', 'institution', 'public_figure'].includes(a.kind));
  } catch {
    return [];
  }
}

const norm = (h) => String(h ?? '').replace(/^@/, '').toLowerCase();
export function allowedAccount(accounts, platform, handle) {
  return accounts.find((a) => a.platform === platform && norm(a.handle) === norm(handle)) ?? null;
}

const getJson = async (fetchImpl, url, timeoutMs, lookup) => {
  const res = await safeFetch(url, { fetchImpl, ...(lookup ? { lookup } : {}), hosts: [...OEMBED_HOSTS, ...API_HOSTS], expect: 'json', timeoutMs, maxBytes: 256 * 1024 });
  let body = null;
  try {
    body = res.ok ? JSON.parse(res.text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

/** Parse the oEmbed blockquote: <p>TEXT</p>&mdash; Name (@handle) <a href="…/status/ID">Date</a>. */
export function parseOembed(doc) {
  const html = String(doc?.html ?? '');
  const p = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';
  const text = decode(p.replace(/<br\s*\/?>/gi, '\n').replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1').replace(/<[^>]+>/g, '')).trim();
  const handle = html.match(/\(@([A-Za-z0-9_]{1,15})\)/)?.[1] ?? String(doc?.author_url ?? '').split('/').pop();
  const date = html.match(/<a\b[^>]*status\/\d+[^>]*>([^<]+)<\/a>\s*<\/blockquote>/i)?.[1];
  const t = Date.parse(date ?? '');
  return { text, handle, author_name: decode(doc?.author_name ?? ''), created_at: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null };
}

export async function fetchXPost(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, lookup } = {}) {
  const m = String(url).match(X_STATUS);
  if (!m) return null;
  const canon = `https://x.com/${m[1]}/status/${m[2]}`;
  const { status, body } = await getJson(fetchImpl, `https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(canon)}`, timeoutMs, lookup);
  if (!body) return { ok: false, status };
  const o = parseOembed(body);
  const text = clean(o.text);
  if (!text || !/^[A-Za-z0-9_]{1,15}$/.test(o.handle ?? '')) return { ok: false, status };
  return { ok: true, status, post: { kind: 'x_post', url: `https://x.com/${o.handle}/status/${m[2]}`, author_name: clean(o.author_name, 80), handle: o.handle, text, created_at: o.created_at } };
}

const bskyPost = (p) => {
  const thumb = p.embed?.images?.[0]?.thumb ?? p.embed?.external?.thumb ?? p.embed?.media?.images?.[0]?.thumb;
  const rkey = String(p.uri).split('/').pop();
  return {
    kind: 'bsky_post',
    url: `https://bsky.app/profile/${p.author.handle}/post/${rkey}`,
    author_name: clean(p.author.displayName || p.author.handle, 80),
    handle: p.author.handle,
    ...(safeUrl(p.author.avatar ?? '') ? { avatar_url: p.author.avatar } : {}),
    text: clean(p.record?.text ?? ''),
    created_at: p.record?.createdAt ?? p.indexedAt,
    ...(safeUrl(thumb ?? '') ? { media_thumb: thumb } : {}),
    metrics: { likes: p.likeCount ?? 0, reposts: p.repostCount ?? 0, replies: p.replyCount ?? 0, quotes: p.quoteCount ?? 0 },
    ...(safeUrl(p.embed?.external?.uri ?? '') ? { link: p.embed.external.uri } : {}),
  };
};

export async function fetchBskyPost(url, { fetchImpl = globalThis.fetch, timeoutMs = 8000, lookup } = {}) {
  const m = String(url).match(BSKY_POST);
  if (!m) return null;
  let did = m[1];
  if (!did.startsWith('did:')) {
    const r = await getJson(fetchImpl, `${BSKY}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(did)}`, timeoutMs, lookup);
    if (!r.body?.did) return { ok: false, status: r.status };
    did = r.body.did;
  }
  const r = await getJson(fetchImpl, `${BSKY}/app.bsky.feed.getPosts?uris=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${m[2]}`)}`, timeoutMs, lookup);
  const p = r.body?.posts?.[0];
  if (!p?.record?.text || !clean(p.record.text)) return { ok: false, status: r.status };
  return { ok: true, status: r.status, post: bskyPost(p) };
}

/** Recent original posts (no replies/reposts) from allowlisted Bluesky accounts, newest first. */
export async function fetchBskyCandidates(accounts, { fetchImpl = globalThis.fetch, timeoutMs = 8000, perAccount = 10, log = () => {}, lookup } = {}) {
  const out = [];
  for (const a of accounts.filter((x) => x.platform === 'bluesky')) {
    try {
      const r = await getJson(fetchImpl, `${BSKY}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(a.handle)}&filter=posts_no_replies&limit=${perAccount}`, timeoutMs, lookup);
      for (const item of r.body?.feed ?? []) if (!item.reason && item.post?.record?.text && norm(item.post.author.handle) === norm(a.handle)) out.push({ ...bskyPost(item.post), account: a.kind });
    } catch (e) {
      log(`bsky ${a.handle}: ${e.name}`);
    }
  }
  return out.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
}

export async function fetchRealPost(url, opts = {}) {
  const kind = realPostKind(url);
  if (kind === 'x_post') return fetchXPost(url, opts);
  if (kind === 'bsky_post') return fetchBskyPost(url, opts);
  return null;
}

/** Cache-backed fetch; entries live in the unfurl cache next to link unfurls ({post} instead of {meta}). */
export async function realPostCached(url, { cache, offline = false, now = Date.now(), retryDays = 7, ...opts } = {}) {
  const hit = cache?.items[url];
  if (hit && (hit.ok || offline || now - Date.parse(hit.fetchedAt) < retryDays * 864e5)) return hit;
  if (offline) return hit ?? null;
  let entry;
  try {
    const r = await fetchRealPost(url, opts);
    if (!r) return null;
    entry = { url, ok: r.ok, status: r.status, fetchedAt: new Date(now).toISOString(), post: r.post ?? null };
  } catch (e) {
    entry = { url, ok: false, status: 0, error: String(e?.name ?? 'error'), fetchedAt: new Date(now).toISOString(), post: null };
  }
  if (cache) {
    cache.items[url] = entry;
    if (entry.post?.url && entry.post.url !== url) cache.items[entry.post.url] = entry;
  }
  return entry;
}
