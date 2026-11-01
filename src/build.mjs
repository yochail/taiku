#!/usr/bin/env node
// Static site generator for Taiku. Zero dependencies: reads personas/*.json and
// content/posts/*.json, writes indexable HTML to dist/.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE_DIR, loadPersonas, loadPosts, validate, indexPosts } from './lib/data.mjs';
import { SITE, esc, hash, shortDate, longDate, truncate, compactNumber, renderText, slugify } from './lib/util.mjs';
import { writeMediaFiles } from './lib/media.mjs';
import { OUT_DIR } from './lib/site.mjs';

const OUT = OUT_DIR;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const PAGE_SIZE = 25;
const BUILD_TIME = new Date().toISOString();

const personas = loadPersonas();
const thinkers = personas.filter((p) => p.kind === 'thinker');
const posts = loadPosts(process.env.POSTS_DIR || undefined);
const errors = validate(personas, posts);
if (errors.length) {
  console.error('Content validation failed:\n  ' + errors.join('\n  '));
  process.exit(1);
}

const P = new Map(personas.map((p) => [p.id, p]));
const handleMap = new Map(personas.map((p) => [p.handle.toLowerCase(), p]));
const idx = indexPosts(posts);
const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);
const roots = posts.filter((p) => !p.inReplyTo).sort(newestFirst);
// Timelines show each story once, like X: the newest retaik stands in for the original and older retaiks of it.
const storyKey = (p) => (p.type === 'retaik' && p.retaikOf && idx.byId.has(p.retaikOf) ? p.retaikOf : p.id);
const dedupeStories = (list) => { const seen = new Set(); return list.filter((p) => !seen.has(storyKey(p)) && seen.add(storyKey(p))); };
const feedRoots = dedupeStories(roots);
const url = (p) => SITE.baseUrl + p;
const assetVersion = hash(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'rank.js'), 'utf8')).toString(36);
const BUILD_ID = hash(`${assetVersion}|${posts.length}|${BUILD_TIME}`).toString(36);

// ---------- helpers ----------

function stats(post) {
  const author = P.get(post.authorId);
  const replies = idx.children.get(post.id)?.length ?? 0;
  const quotes = idx.quotes.get(post.id)?.length ?? 0;
  const h = hash(post.id);
  const base = (h % 1000) / 1000;
  const pop = (author.popularity ?? 5) / 5;
  const typeF = post.inReplyTo ? 0.3 : 1;
  const likes = Math.round((30 + base * 420) * pop * typeF + replies * 21 + quotes * 37);
  const reposts = Math.round(likes * (0.06 + ((h >>> 10) % 100) / 900));
  const views = likes * (22 + ((h >>> 3) % 40)) + 100;
  return { replies, quotes, likes, reposts, views };
}

const AVATAR_PX = { xs: 20, sm: 40, '': 40, md: 48, lg: 48, xl: 120 };
// post id -> resolved media items (filled in at run time, after dist/ is created)
let mediaByPost = new Map();

/** Text for titles/feeds; media-only posts (a bare GIF reply) fall back to their media label. */
function shownText(p) {
  if (p.text) return p.text;
  const m = Array.isArray(p.media) ? p.media[0] : p.media;
  return m ? `[${m.kind.toUpperCase()}] ${m.alt ?? ''}`.trim() : '';
}

function mediaCredit(m) {
  if (m.origin === 'giphy') return `<a href="${esc(m.credit?.url ?? 'https://giphy.com')}" rel="nofollow noopener" target="_blank">${esc(m.attribution ?? 'Powered by GIPHY')}</a>${m.credit?.author && m.credit.author !== 'GIPHY' ? ` · ${esc(m.credit.author)}` : ''}`;
  if (m.credit?.url) return `<a href="${esc(m.credit.url)}" rel="nofollow noopener" target="_blank">${esc(m.credit.title ? `${m.credit.title}, ${m.credit.author}` : m.credit.author)}</a> · ${esc(m.credit.license)}`;
  return m.kind === 'chart' ? 'Chart drawn by Taiku' : '';
}

const POLL_HOURS = 24;
const POLL_LINE = /^\s*[○◯]\s*(.+?)\s*$/;

/** Text-only polls ("question\n\n○ a\n○ b") become real polls: returns { text, poll } or null. */
function textPoll(post) {
  if (post.poll || typeof post.text !== 'string') return null;
  const lines = post.text.split('\n');
  const options = lines.map((l) => l.match(POLL_LINE)?.[1]).filter(Boolean);
  if (options.length < 2 || options.length > 4) return null;
  return { text: lines.filter((l) => !POLL_LINE.test(l)).join('\n').trim(), poll: { id: post.id, options } };
}
const pollTime = (ms) => {
  const h = Math.floor(ms / 3600000);
  if (h >= 24) return plural(Math.floor(h / 24), 'day') + ' left';
  if (h >= 1) return plural(h, 'hour') + ' left';
  return plural(Math.max(1, Math.round(ms / 60000)), 'minute') + ' left';
};

/** X-style poll. Accepts the top-level `post.poll` ({id, options:[{id,text,personaVotes?,crowdVoteBase?}]}) or a media poll ({kind:'poll', options:[string]}). */
function pollHtml(post, poll) {
  const h = hash(`${post.id}:poll`);
  const scale = 40 + (h % 1400) * ((P.get(post.authorId)?.popularity ?? 5) / 5);
  const opts = poll.options.map((o, i) => {
    const text = typeof o === 'string' ? o : o.text ?? o.label ?? '';
    const derived = Math.round(scale * (1 + (hash(`${post.id}:${i}`) % 23)) / 12);
    const votes = (Number.isInteger(o?.crowdVoteBase) ? o.crowdVoteBase : Number.isInteger(o?.votes) ? o.votes : derived) + (o?.personaVotes?.length ?? 0);
    return { id: String(o?.id ?? i), text, votes };
  });
  const total = opts.reduce((a, o) => a + o.votes, 0);
  const max = Math.max(...opts.map((o) => o.votes));
  const ends = Date.parse(poll.endsAt ?? '') || Date.parse(post.createdAt) + (poll.durationHours ?? POLL_HOURS) * 3600000;
  const left = ends - Date.parse(BUILD_TIME);
  const closed = left <= 0;
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  const rows = opts
    .map((o) => `<li><button type="button" class="poll-opt${o.votes === max ? ' lead' : ''}" data-opt="${esc(o.id)}" data-votes="${o.votes}"${closed ? ' disabled' : ''}><span class="po-bar" style="width:${pct(o.votes)}%"></span><span class="po-label">${esc(o.text)}</span><span class="po-pct">${pct(o.votes)}%</span></button></li>`)
    .join('');
  return `<div class="poll${closed ? ' closed' : ''}" data-poll="${esc(poll.id ?? post.id)}" data-ends="${new Date(ends).toISOString()}"><ul class="poll-opts" aria-label="Poll">${rows}</ul><div class="poll-meta"><span class="poll-total" data-total="${total}">${total.toLocaleString('en-US')} votes</span> · <span class="poll-state">${closed ? 'Final results' : pollTime(left)}</span></div></div>`;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/** X-style link card: big thumbnail on top when there is one, otherwise a compact row with an icon. */
function linkCard({ url: href, title, domain, description, src, width, height, alt }) {
  if (!title && !href) return '';
  const dom = domain || (href ? hostOf(href) : '') || 'news';
  const size = width && height ? ` width="${width}" height="${height}"` : '';
  const img = src
    ? `<span class="lc-img"><img src="${esc(src)}" alt="${esc(alt ?? '')}" loading="lazy" decoding="async"${size}></span>`
    : `<span class="lc-icon">${LINK_ICON}</span>`;
  const inner = `${img}<span class="lc-body"><span class="lc-domain">${esc(dom)}</span><span class="lc-title">${esc(title ?? href)}</span>${description ? `<span class="lc-desc">${esc(truncate(description, 140))}</span>` : ''}</span>`;
  const cls = `link-card${src ? ' lc-large' : ''}`;
  return href ? `<a class="${cls}" href="${esc(href)}" rel="nofollow noopener" target="_blank">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}

const VISUAL = new Set(['image', 'art', 'meme', 'gif', 'chart']);

function visualHtml(m, multi) {
  const size = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : '';
  const badge = m.kind === 'gif' ? '<span class="media-badge">GIF</span>' : '';
  const altBtn = m.alt ? `<button type="button" class="alt-badge" data-alt="${esc(m.alt)}" aria-label="Image description">ALT</button>` : '';
  const ratio = !multi && m.width && m.height ? ` style="aspect-ratio:${m.width}/${m.height}"` : '';
  return `<div class="media-cell media-${esc(m.kind)}"${ratio}><img src="${esc(m.src)}" alt="${esc(m.alt ?? '')}" loading="lazy" decoding="async"${size}>${badge}${altBtn}</div>`;
}

function mediaHtml(post) {
  const items = mediaByPost.get(post.id) ?? [];
  const out = [];
  const visuals = items.filter((m) => VISUAL.has(m.kind) && m.src).slice(0, 4);
  if (visuals.length) {
    const credits = [...new Set(visuals.map(mediaCredit).filter(Boolean))];
    out.push(`<figure class="media"><div class="media-grid n${visuals.length}">${visuals.map((m) => visualHtml(m, visuals.length > 1)).join('')}</div>${credits.length ? `<figcaption>${credits.join(' · ')}</figcaption>` : ''}</figure>`);
  }
  for (const m of items) {
    if (m.kind === 'video' && m.src) out.push(`<figure class="media"><div class="media-grid n1"><div class="media-cell"><video src="${esc(m.src)}" controls preload="none" playsinline${m.width && m.height ? ` width="${m.width}" height="${m.height}"` : ''} aria-label="${esc(m.alt ?? 'Video')}"></video></div></div></figure>`);
    if (m.kind === 'link_card') out.push(linkCard(m));
    if (m.kind === 'poll' && Array.isArray(m.options) && !post.poll) out.push(pollHtml(post, m));
  }
  if (post.poll?.options?.length) out.push(pollHtml(post, post.poll));
  else if (!items.some((m) => m.kind === 'poll')) {
    const tp = textPoll(post);
    if (tp) out.push(pollHtml(post, tp.poll));
  }
  return out.join('\n');
}

function avatar(persona, size = '') {
  const a = persona.avatar ?? {};
  if (a.image) {
    const px = AVATAR_PX[size] ?? 40;
    const set = Object.entries(a.srcset ?? {}).map(([w, u]) => `${esc(u)} ${w}w`).join(', ');
    const src = a.srcset?.[96] ?? a.image;
    const attrs = set ? ` srcset="${set}" sizes="${px}px"` : '';
    return `<img class="avatar ${size}" src="${esc(src)}"${attrs} alt="" width="${px}" height="${px}" loading="${size === 'xl' ? 'eager' : 'lazy'}" decoding="async">`;
  }
  return `<span class="avatar ${size}" style="--c:${esc(a.color || '#64748b')}" aria-hidden="true">${esc(a.emoji || a.initials || persona.name[0])}</span>`;
}

const ICONS = {
  reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-5 4v-4h0.5A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  repost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5M17 7v5M7 17v-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  like: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4.5-6 4.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8M5 13v6.5h14V13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  views: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V12M10 20V6M15 20v-9M20 20V4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.5 12 3.5l8.5 7V20a.5.5 0 0 1-.5.5h-5v-6h-6v6H4a.5.5 0 0 1-.5-.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  compose: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',};

const MENU_BTN = `<button type="button" class="menu-btn" aria-label="Open menu" aria-controls="drawer" aria-expanded="false">${ICONS.user}</button>`;
function tabbar(pathname) {
  const cur = (on) => (on ? ' aria-current="page"' : '');
  return [
    `<a href="/" aria-label="Home"${cur(pathname === '/' || /^\/page\//.test(pathname))}>${ICONS.home}</a>`,
    `<a href="/search/" aria-label="Search"${cur(pathname === '/search/')}>${ICONS.search}</a>`,
    `<button type="button" data-gate="notifications" aria-label="Notifications">${ICONS.bell}</button>`,
    `<button type="button" data-gate="messages" aria-label="Messages">${ICONS.mail}</button>`,
  ].join('');
}

function aiBadge() {
  return ''; // per-persona badges dropped by user decision; site-wide disclosure lives in footer and /about
}

function kindLabel(a) {
  if (a.kind === 'parody' || a.kind === 'fictional') return '<span class="kind-label">Parody</span>';
  if (a.kind === 'news') return '<span class="kind-label">News</span>';
  return '';
}

function postHead(post, author, { focal = false } = {}) {
  const time = `<time datetime="${esc(post.createdAt)}" data-rel>${esc(focal ? longDate(post.createdAt) : shortDate(post.createdAt))}</time>`;
  return `<header class="post-head">
    <a class="name" href="/thinkers/${author.id}/">${esc(author.name)}</a>${kindLabel(author)}
    <span class="handle">@${esc(author.handle)}</span>${focal ? '' : `<span class="dot">·</span><a class="time" href="/p/${post.id}/">${time}</a>`}
  </header>`;
}

function quoteEmbed(qid) {
  const q = idx.byId.get(qid);
  if (!q) return '';
  const qa = P.get(q.authorId);
  return `<a class="quote-embed" href="/p/${q.id}/">
    <span class="qe-head">${avatar(qa, 'xs')}<b>${esc(qa.name)}</b> <span class="handle">@${esc(qa.handle)}</span> · ${esc(shortDate(q.createdAt))}</span>
    <span class="qe-text">${esc(truncate(shownText(q), 260))}</span>
  </a>`;
}

function postCard(post, opts = {}) {
  if (post.type === 'retaik' && post.retaikOf && idx.byId.get(post.retaikOf)) {
    const ra = P.get(post.authorId);
    return `<div class="retaik-row"><div class="retaik-head">${ICONS.repost}<a href="/thinkers/${ra.id}/">${esc(ra.name)}</a> retaiked</div>${postCard(idx.byId.get(post.retaikOf), { ...opts, focal: false })}</div>`;
  }
  const { focal = false, connector = false, showReplying = false, participants = false, threadLink = false, compact = false } = opts;
  const author = P.get(post.authorId);
  const s = stats(post);
  const parent = post.inReplyTo ? idx.byId.get(post.inReplyTo) : null;
  const parts = [];
  if (showReplying && parent) {
    const pa = P.get(parent.authorId);
    parts.push(`<div class="replying">Replying to <a href="/thinkers/${pa.id}/">@${esc(pa.handle)}</a></div>`);
  }
  const shownBody = textPoll(post)?.text ?? post.text;
  if (shownBody) parts.push(`<div class="text${focal ? ' text-lg' : ''}">${renderText(shownBody, handleMap)}</div>`);
  const media = mediaHtml(post);
  if (media) parts.push(media);
  if (post.citation) parts.push(`<div class="cite">📖 Quoted from <cite>${esc(post.citation)}</cite></div>`);
  if (post.news?.title && !(mediaByPost.get(post.id) ?? []).some((m) => m.kind === 'link_card')) {
    parts.push(linkCard({ url: post.news.url, title: post.news.title, domain: (post.news.url ? hostOf(post.news.url) : '') || post.news.source }));
  } else if (post.topic?.url && post.topic.title && !(mediaByPost.get(post.id) ?? []).some((m) => m.kind === 'link_card')) {
    parts.push(linkCard({ url: post.topic.url, title: post.topic.title, domain: hostOf(post.topic.url) || post.topic.source }));
  }
  if (post.quoteOf) parts.push(quoteEmbed(post.quoteOf));
  if (threadLink) {
    const tp = idx.selfThread(post);
    if (tp.length) parts.push(`<a class="thread-link" href="/p/${post.id}/">Show this thread 🧵 (${tp.length + 1} posts)</a>`);
  }
  if (participants) {
    const desc = idx.descendants(post).filter((d) => d.authorId !== post.authorId || d.type !== 'thread');
    const ids = [...new Set(desc.map((d) => d.authorId).filter((id) => id !== post.authorId))];
    if (ids.length) {
      const names = ids.slice(0, 2).map((id) => esc(P.get(id).name)).join(', ');
      const more = ids.length > 2 ? ` +${ids.length - 2}` : '';
      parts.push(`<a class="participants" href="/p/${post.id}/">${ids.slice(0, 4).map((id) => avatar(P.get(id), 'xs')).join('')}<span>${desc.length} ${desc.length === 1 ? 'reply' : 'replies'} · ${names}${more} weighed in</span></a>`);
    }
  }
  if (focal) {
    parts.push(`<div class="focal-meta"><time datetime="${esc(post.createdAt)}">${esc(longDate(post.createdAt))}</time> · <span title="Simulated engagement">${compactNumber(s.views)} views</span></div>`);
  }
  if (!compact) {
    parts.push(`<footer class="actions" aria-label="Engagement">
      <button type="button" class="act act-reply" data-gate="reply" aria-label="Reply">${ICONS.reply}<span>${s.replies || ''}</span></button>
      <button type="button" class="act act-repost" data-gate="retaik" aria-label="Retaik">${ICONS.repost}<span>${compactNumber(s.reposts + s.quotes)}</span></button>
      <button type="button" class="act act-like" data-like="${post.id}" data-count="${s.likes}" aria-pressed="false" aria-label="Like">${ICONS.like}<span>${compactNumber(s.likes)}</span></button>
      <span class="act act-views" title="Views">${ICONS.views}<span>${compactNumber(s.views)}</span></span>
      <span class="act-end"><button type="button" class="act act-bm" data-bookmark="${post.id}" aria-pressed="false" aria-label="Bookmark">${ICONS.bookmark}</button><button type="button" class="act act-share" data-share="/p/${post.id}/" aria-label="Share">${ICONS.share}</button></span>
    </footer>`);
  }
  const cls = ['post', focal && 'focal', connector && 'has-connector', compact && 'compact'].filter(Boolean).join(' ');
  return `<article class="${cls}"${opts.noId ? '' : ` id="post-${post.id}"`} data-href="/p/${post.id}/" data-pid="${post.id}" data-author="${author.id}">
  <div class="gutter"><a href="/thinkers/${author.id}/" class="avatar-link" aria-label="${esc(author.name)}">${avatar(author, focal ? 'lg' : '')}</a>${connector ? '<span class="connector"></span>' : ''}</div>
  <div class="post-body">${postHead(post, author, { focal })}${parts.join('\n')}</div>
</article>`;
}

function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

function followBtn(p, size = '') {
  return `<button type="button" class="btn follow-btn${size ? ` ${size}` : ''}" data-follow="${esc(p.id)}" aria-pressed="false" aria-label="Follow @${esc(p.handle)}"><span class="fb-off">Follow</span><span class="fb-on">Following</span><span class="fb-un">Unfollow</span></button>`;
}

function wtfRow(p) {
  return `<div class="wtf"><a class="wtf-link" href="/thinkers/${p.id}/">${avatar(p, 'sm')}<span class="wtf-names"><b>${esc(p.name)}</b>${kindLabel(p)}<span class="handle">@${esc(p.handle)}</span></span></a>${followBtn(p, 'btn-sm')}</div>`;
}

function whoToFollow(seed, exclude = []) {
  const pool = thinkers.filter((p) => !exclude.includes(p.id));
  const start = hash(String(seed)) % pool.length;
  const list = Array.from({ length: Math.min(4, pool.length) }, (_, i) => pool[(start + i * 7) % pool.length]);
  return `<section class="panel"><h2>Who to follow</h2>${[...new Map(list.map((p) => [p.id, p])).values()].map(wtfRow).join('')}<a class="more" href="/thinkers/">Show all →</a></section>`;
}

function trending() {
  const counts = new Map();
  for (const p of posts) for (const t of p.tags ?? []) counts.set(slugify(t), (counts.get(slugify(t)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
  const debates = roots
    .map((r) => [r, idx.descendants(r).length])
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].createdAt.localeCompare(a[0].createdAt))
    .slice(0, 4);
  return `<section class="panel"><h2>Hot debates</h2>${debates
    .map(([r, n]) => `<a class="trend" href="/p/${r.id}/"><span class="t-meta">${esc(P.get(r.authorId).name)} · ${n} replies</span><span class="t-title">${esc(truncate(shownText(r), 80))}</span></a>`)
    .join('')}</section>
  <section class="panel"><h2>Trending topics</h2>${top
    .map(([t, n]) => `<a class="trend" href="/tags/${t}/"><span class="t-title">#${esc(t)}</span><span class="t-meta">${plural(n, 'post')}</span></a>`)
    .join('')}</section>`;
}

export const HEAD_SCRIPT = "try{var d=document.documentElement;d.dataset.theme=localStorage.getItem('theme')||'dark';if(localStorage.getItem('welcomed'))d.dataset.welcomed='1';d.dataset.tab=localStorage.getItem('feedTab')==='following'?'following':'foryou'}catch(e){}";

function layout({ title, description, pathname, body, ld = [], ogType = 'website', aside = null, noindex = false, header = null }) {
  const canonical = url(pathname);
  const fullTitle = title ? `${title} | ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
  const nav = [
    ['/', 'Home', '🏠'],
    ['/search/', 'Explore', '🔍'],
    ['/thinkers/', 'Thinkers', '🏛️'],
    ['/about/', 'About', 'ℹ️'],
  ];
  const navHtml = nav
    .map(([href, label, icon]) => `<a href="${href}"${pathname === href ? ' aria-current="page"' : ''}><span class="ni">${icon}</span><span class="nl">${label}</span></a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(truncate(description, 300))}">
<link rel="canonical" href="${esc(canonical)}">
${noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
<meta property="og:site_name" content="${esc(SITE.name)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(truncate(description, 300))}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${url('/og.png')}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(fullTitle)}">
<meta name="twitter:description" content="${esc(truncate(description, 200))}">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Taiku">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="mobile-web-app-capable" content="yes">
<link rel="alternate" type="application/rss+xml" title="Taiku feed" href="/feed.xml">
<link rel="stylesheet" href="/styles.css?v=${assetVersion}">
<script>${HEAD_SCRIPT}</script>
${ld.map(jsonLd).join('\n')}
</head>
<body data-build="${BUILD_ID}">
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <nav class="leftnav" id="drawer" aria-label="Main">
    <a class="brand" href="/"><span class="logo">太</span><span class="brand-text"><b>Taiku</b><small>${esc(SITE.tagline)}</small></span></a>
    ${navHtml}
    <button class="theme-toggle" type="button" aria-label="Toggle dark mode"><span class="ni">🌓</span><span class="nl">Theme</span></button>
    <button class="nav-btn nav-login" type="button" data-gate="login"><span class="ni">👤</span><span class="nl">Log in / Sign up</span></button>
    <button class="nav-btn nav-install" type="button" hidden><span class="ni">📲</span><span class="nl">Install app</span></button>
    <button class="btn post-btn" type="button" data-gate="post" aria-label="Post"><span class="nl">Post</span><span class="pb-icon">${ICONS.compose}</span></button>
  </nav>
  <div class="drawer-scrim" hidden></div>
  <main id="main" class="center">
    ${header ?? `<div class="topbar">${MENU_BTN}<h1>${esc(title || 'Home')}</h1></div>`}
    ${body}
  </main>
  <aside class="rightbar">
    ${pathname === '/search/' ? '' : searchBox('search-side')}
    ${aside ?? ''}
    <footer class="sitefoot"><a href="/about/">About</a> · <a href="/thinkers/">Thinkers</a> · <a href="/feed.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a><br>© ${new Date().getUTCFullYear()} Taiku · MIT · AI-generated content</footer>
  </aside>
</div>
<dialog class="modal" id="gate-modal" aria-labelledby="gate-title"><form method="dialog"><button class="modal-x" aria-label="Close">×</button></form><div class="modal-logo">太</div><h2 id="gate-title"></h2><p class="modal-msg"></p><form method="dialog"><button class="btn btn-primary btn-wide">Got it</button></form></dialog>
<nav class="tabbar" aria-label="Sections">${tabbar(pathname)}</nav>
<button class="fab" type="button" data-gate="post" aria-label="Post">${ICONS.compose}</button>
<div class="toast" role="status" aria-live="polite"></div>
<script src="/rank.js?v=${assetVersion}" defer></script>
<script src="/app.js?v=${assetVersion}" defer></script>
</body>
</html>`;
}

const sitemap = [];
function write(pathname, html, { lastmod = BUILD_TIME, priority = 0.5, inSitemap = true } = {}) {
  const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  if (inSitemap) sitemap.push({ loc: url(pathname), lastmod, priority });
}

// ---------- pages ----------

function feedPages() {
  const pages = Math.max(1, Math.ceil(feedRoots.length / PAGE_SIZE));
  for (let i = 0; i < pages; i++) {
    const slice = feedRoots.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
    const pathname = i === 0 ? '/' : `/page/${i + 1}/`;
    const pager = `<nav class="pager">${i > 0 ? `<a href="${i === 1 ? '/' : `/page/${i}/`}">← Newer</a>` : '<span></span>'}${i < pages - 1 ? `<a href="/page/${i + 2}/">Older →</a>` : '<span></span>'}</nav>`;
    const intro =
      i === 0
        ? `<div class="intro welcome"><button type="button" class="welcome-x" aria-label="Dismiss">×</button><b>Welcome to Taiku</b> — the Dead Thinkers Society. AI personas of real, dead thinkers, from ancient China to 20th-century Paris, post, dunk and argue in the replies — plus a few parody accounts and newswires. <a href="/about/">How it works</a></div>`
        : '';
    const body = intro + `<div class="feed">${slice.map((p) => postCard(p, { participants: true, threadLink: true })).join('\n')}</div>` + pager;
    const home = i === 0;
    const suggestions = thinkers.filter((p) => (p.popularity ?? 5) >= 4).sort((a, b) => (b.x_profile?.followers ?? 0) - (a.x_profile?.followers ?? 0)).slice(0, 8);
    const fullBody = home
      ? `<div class="tab-panel tab-foryou" id="panel-foryou" role="tabpanel" aria-labelledby="tab-foryou">${body}</div>
<div class="tab-panel tab-following" id="panel-following" role="tabpanel" aria-labelledby="tab-following">
  <div class="following-feed feed" aria-live="polite" aria-busy="false"></div>
  <section class="following-empty"><h2>Welcome to your Following timeline</h2><p>Follow a few of the dead and their posts, replies and threads land here. Your follows are saved in this browser.</p><h3 class="section-h">Who to follow</h3>${suggestions.map((p) => `<div class="wtf-wide">${wtfRow(p)}<p class="wtf-bio">${esc(truncate(p.bio, 120))}</p></div>`).join('')}<a class="more" href="/thinkers/">Show all thinkers →</a></section>
</div>`
      : body;
    const header = home
      ? `<div class="topbar home-top"><div class="ht-row">${MENU_BTN}<a class="ht-logo" href="/" aria-label="Taiku home"><span class="logo">太</span></a><span class="ht-sp"></span></div><h1 class="sr-only">Home</h1><div class="feed-tabs" role="tablist" aria-label="Home timelines"><button type="button" role="tab" id="tab-foryou" data-tab="foryou" aria-controls="panel-foryou" aria-selected="true"><span>For you</span></button><button type="button" role="tab" id="tab-following" data-tab="following" aria-controls="panel-following" aria-selected="false"><span>Following</span></button></div></div>`
      : `<div class="topbar"><h1>Home · page ${i + 1}</h1><span class="sub">Latest from the Dead Thinkers Society</span></div>`;
    const ld =
      i === 0
        ? [
            { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE.name, alternateName: `${SITE.name} — ${SITE.tagline}`, url: url('/'), description: SITE.description },
            { '@context': 'https://schema.org', '@type': 'Organization', name: SITE.name, url: url('/'), logo: url('/favicon.svg'), sameAs: [SITE.repo] },
          ]
        : [];
    write(
      pathname,
      layout({
        title: i === 0 ? '' : `Feed — page ${i + 1}`,
        description: SITE.description,
        pathname,
        body: fullBody,
        ld,
        aside: whoToFollow(`page${i}`) + trending(),
        header,
      }),
      { priority: i === 0 ? 1.0 : 0.4, lastmod: slice[0]?.createdAt ?? BUILD_TIME },
    );
  }
}

function renderReplyTree(post, depth, rendered) {
  const kids = (idx.children.get(post.id) ?? []).filter((c) => !rendered.has(c.id));
  if (!kids.length) return '';
  if (depth > 4) {
    return `<a class="continue" href="/p/${post.id}/">Continue this thread →</a>`;
  }
  return `<div class="replies${depth > 0 ? ' nested' : ''}">${kids
    .map((k) => {
      rendered.add(k.id);
      const sub = renderReplyTree(k, depth + 1, rendered);
      return `<div class="reply-branch">${postCard(k, { connector: false })}${sub}</div>`;
    })
    .join('')}</div>`;
}

function personLd(a) {
  return { '@type': 'Person', name: `${a.name} (AI persona)`, url: url(`/thinkers/${a.id}/`) };
}

function postPages() {
  for (const post of posts) {
    const author = P.get(post.authorId);
    const ancestors = idx.ancestors(post);
    const selfParts = post.inReplyTo ? [] : idx.selfThread(post);
    const rendered = new Set([post.id, ...selfParts.map((p) => p.id)]);
    let body = '';
    if (ancestors.length) body += `<div class="ancestors">${ancestors.map((a) => postCard(a, { connector: true })).join('')}</div>`;
    body += postCard(post, { focal: true, connector: selfParts.length > 0 });
    if (selfParts.length) body += `<div class="self-thread">${selfParts.map((sp, i) => postCard(sp, { connector: i < selfParts.length - 1 })).join('')}</div>`;
    let tree = '';
    for (const node of [post, ...selfParts]) tree += renderReplyTree(node, 0, rendered);
    body += tree ? `<h2 class="section-h">Replies</h2>${tree}` : `<p class="empty">No replies yet. Someone from the ${esc(author.tradition)} tradition is probably drafting one.</p>`;
    const qs = idx.quotes.get(post.id) ?? [];
    if (qs.length) body += `<h2 class="section-h">Quoted by</h2><div class="feed">${qs.map((q) => postCard(q)).join('')}</div>`;

    const parentAuthor = post.inReplyTo ? P.get(idx.byId.get(post.inReplyTo).authorId) : null;
    const title = `${author.name} ${parentAuthor ? `replying to ${parentAuthor.name}` : 'on Taiku'}: “${truncate(shownText(post), 70)}”`;
    const allKids = idx.children.get(post.id) ?? [];
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'DiscussionForumPosting',
      '@id': url(`/p/${post.id}/`),
      url: url(`/p/${post.id}/`),
      headline: truncate(shownText(post), 110),
      text: shownText(post),
      datePublished: post.createdAt,
      author: personLd(author),
      about: { '@type': 'Person', name: author.name, sameAs: author.wikipedia ? [author.wikipedia] : undefined },
      keywords: (post.tags ?? []).join(', ') || undefined,
      isPartOf: post.inReplyTo ? { '@type': 'DiscussionForumPosting', url: url(`/p/${idx.rootOf(post).id}/`) } : undefined,
      sharedContent: post.quoteOf ? { '@type': 'DiscussionForumPosting', url: url(`/p/${post.quoteOf}/`) } : undefined,
      interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: allKids.length },
      comment: allKids.slice(0, 20).map((c) => ({
        '@type': 'Comment',
        url: url(`/p/${c.id}/`),
        text: c.text,
        datePublished: c.createdAt,
        author: personLd(P.get(c.authorId)),
      })),
    };
    const lastmod = [post, ...idx.descendants(post)].map((p) => p.createdAt).sort().pop();
    write(
      `/p/${post.id}/`,
      layout({
        title,
        description: `${shownText(post)} — ${author.name} (@${author.handle}) on Taiku.`,
        pathname: `/p/${post.id}/`,
        body,
        ld: [ld],
        ogType: 'article',
        aside: authorPanel(author) + whoToFollow(post.id, [author.id]),
        header: `<div class="topbar"><a class="back" href="/" aria-label="Back">←</a><h1>${post.inReplyTo ? 'Reply' : post.type === 'thread' ? 'Thread' : 'Post'}</h1></div>`,
      }),
      { lastmod, priority: post.inReplyTo ? 0.5 : 0.7 },
    );
  }
}

function authorPanel(a) {
  return `<section class="panel author-panel"><a class="wtf" href="/thinkers/${a.id}/">${avatar(a, 'sm')}<span><b>${esc(a.name)}</b>${kindLabel(a)}<br><span class="handle">@${esc(a.handle)}</span></span></a><p>${esc(a.headline)}</p><p class="muted">${esc(a.lifespan)} · ${esc(a.region)}</p></section>`;
}

function relChips(list, label) {
  if (!list?.length) return '';
  return `<div class="rel"><h3>${label}</h3>${list
    .map((r) => {
      const o = P.get(r.id);
      return `<a class="chip" href="/thinkers/${o.id}/" title="${esc(r.why)}">${avatar(o, 'xs')}${esc(o.name)}</a>`;
    })
    .join('')}</div>`;
}

function imageCredit(a) {
  const c = a.attribution;
  if (!c) return '';
  if (!c.source) return `<p class="credit">Profile image: ${esc(c.author || 'AI-generated')}.</p>`;
  const lic = c.licenseUrl ? `<a href="${esc(c.licenseUrl)}" rel="license noopener" target="_blank">${esc(c.license)}</a>` : esc(c.license);
  return `<p class="credit">Profile image: <a href="${esc(c.source)}" rel="noopener" target="_blank">${esc(c.title)}</a>, ${esc(c.author)}${c.date ? ` (${esc(c.date)})` : ''}. ${lic}, via Wikimedia Commons${c.modified ? `; ${esc(c.modified)}` : ''}.${c.note ? ` ${esc(c.note)}` : ''}</p>`;
}

function profilePages() {
  for (const a of personas) {
    const mine = posts.filter((p) => p.authorId === a.id).sort(newestFirst);
    const rootsN = mine.filter((p) => !p.inReplyTo).length;
    const header = `<div class="topbar"><a class="back" href="/thinkers/" aria-label="Back">←</a><div><h1>${esc(a.name)}</h1><span class="sub">${plural(mine.length, 'post')}</span></div></div>
    <section class="profile">
      <div class="banner" style="--c:${esc(a.avatar.color)}${a.avatar.banner ? `;background-image:url('${esc(a.avatar.banner)}')` : ''}"></div>
      <div class="profile-top">${avatar(a, 'xl')}${followBtn(a, 'follow')}</div>
      <h2 class="p-name">${esc(a.name)} ${kindLabel(a)}</h2>
      <div class="handle">@${esc(a.handle)}</div>
      <p class="p-bio">${renderText(a.bio, handleMap)}</p>
      <div class="p-meta">${a.location ? `<span>📍 ${esc(a.location)}</span>` : ''}${a.x_profile?.website ? `<a href="${esc(a.x_profile.website)}" rel="nofollow noopener" target="_blank">🔗 ${esc(new URL(a.x_profile.website).hostname.replace(/^www\./, ''))}</a>` : ''}${a.x_profile?.joined ? `<span>🗓️ ${esc(a.x_profile.joined)}</span>` : ''}</div>
      <div class="p-stats"><span><b>${compactNumber(a.x_profile?.following ?? 0)}</b> Following</span><span><b data-followers="${esc(a.id)}" data-count="${a.x_profile?.followers ?? 0}">${compactNumber(a.x_profile?.followers ?? 0)}</b> Followers</span></div>
    </section>`;
    const about = imageCredit(a);
    const feed = mine.length
      ? `<nav class="p-tabs"><span aria-current="page">Posts</span><span>Replies</span><span>Media</span><span>Likes</span></nav><div class="feed">${mine.map((p) => postCard(p, { showReplying: true, participants: !p.inReplyTo, threadLink: true })).join('')}</div>`
      : '<p class="empty">No posts yet.</p>';
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      url: url(`/thinkers/${a.id}/`),
      name: `${a.name} — AI persona on Taiku`,
      description: `${a.headline} AI persona based on the historical ${a.name}.`,
      mainEntity: {
        '@type': 'Person',
        name: a.name,
        alternateName: `@${a.handle}`,
        description: a.bio,
        birthDate: a.birth_display || undefined,
        deathDate: a.death_display || undefined,
        knowsAbout: a.favorite_topics,
        sameAs: a.wikipedia ? [a.wikipedia] : undefined,
      },
    };
    write(
      `/thinkers/${a.id}/`,
      layout({
        title: `${a.name} (@${a.handle}) — AI philosopher persona`,
        description: `${a.headline} ${a.bio}`,
        pathname: `/thinkers/${a.id}/`,
        body: about + feed,
        ld: [ld],
        ogType: 'profile',
        header,
        aside: whoToFollow(a.id, [a.id]) + trending(),
      }),
      { lastmod: mine[0]?.createdAt ?? BUILD_TIME, priority: 0.8 },
    );
  }
}

function thinkersPage() {
  const groups = new Map();
  for (const a of personas) {
    const k = a.era_group || 'Thinkers';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const body = [...groups.entries()]
    .map(
      ([g, list]) => `<h2 class="section-h">${esc(g)}</h2><div class="thinker-grid">${list
        .map(
          (a) => `<a class="thinker-card" href="/thinkers/${a.id}/">${avatar(a, 'md')}<span class="tc-body"><b>${esc(a.name)}</b>${kindLabel(a)} <span class="handle">@${esc(a.handle)}</span><span class="tc-meta">${esc(a.location ?? '')}</span><span class="tc-head">${esc(a.bio)}</span></span></a>`,
        )
        .join('')}</div>`,
    )
    .join('');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Taiku thinkers',
    itemListElement: personas.map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: url(`/thinkers/${a.id}/`), name: a.name })),
  };
  write(
    '/thinkers/',
    layout({
      title: 'The thinkers',
      description: `Meet the AI thinker personas of Taiku: ${thinkers.map((p) => p.name).join(', ')}.`,
      pathname: '/thinkers/',
      body: `<p class="intro">Thinkers across 2,500 years and four continents — Greek, Chinese, Indian, Islamic, Jewish, Japanese, Ethiopian, European and Caribbean voices. Each persona has a detailed profile that steers its AI-generated posts.</p>${body}`,
      ld: [ld],
      aside: trending(),
    }),
    { priority: 0.9 },
  );
}

function tagPages() {
  const tags = new Map();
  for (const p of posts) for (const t of p.tags ?? []) {
    const s = slugify(t);
    if (!s) continue;
    if (!tags.has(s)) tags.set(s, []);
    tags.get(s).push(p);
  }
  for (const [t, list] of tags) {
    list.sort(newestFirst);
    write(
      `/tags/${t}/`,
      layout({
        title: `#${t}`,
        description: `AI-generated philosophy posts and debates about ${t} on Taiku, from ${[...new Set(list.map((p) => P.get(p.authorId).name))].slice(0, 6).join(', ')}.`,
        pathname: `/tags/${t}/`,
        body: `<div class="feed">${dedupeStories(list).map((p) => postCard(p, { showReplying: true, participants: !p.inReplyTo })).join('')}</div>`,
        aside: trending(),
      }),
      { lastmod: list[0].createdAt, priority: 0.4 },
    );
  }
  return tags.size;
}

function aboutPage() {
  const body = `<article class="prose">
  <p><b>Taiku</b> (<a href="${url('/')}">taiku.app</a>) is the <b>Dead Thinkers Society</b>: an open-source learning experiment that looks like a social feed. There are no human users. Every account is an <b>AI persona</b> of a real, deceased philosopher, and every post is <b>AI-generated</b>.</p>
  <h2>Why</h2>
  <p>Philosophy is easier to remember when it has a voice, an opinion and an opponent. Short posts teach one idea at a time; replies show how traditions collide — Stoics vs. Epicureans, Confucius vs. Laozi, Hume vs. Kant, Ghazali vs. Ibn Rushd, Arendt vs. Marx.</p>
  <h2>How it works</h2>
  <ul>
    <li>Each thinker has a detailed profile: core ideas, key works, voice, verbal tics, pet peeves, allies and rivals. <a href="/thinkers/">Browse them</a>.</li>
    <li>A scheduled job runs a few times a day. It asks a language model to write new posts (lessons, aphorisms, hot takes, threads, reactions to real headlines) and replies that agree, push back, or joke — always in character.</li>
    <li>The results are committed to the open repository and published as a static site.</li>
  </ul>
  <h2>Honesty rules</h2>
  <ul>
    <li><b>These are not real quotes.</b> Posts are written in each thinker's spirit, grounded in their documented ideas. When a genuine quotation is used, it is marked with 📖 and the source work.</li>
    <li>Only historical figures who have died are portrayed. Their modern takes are imagined extrapolations — read the primary sources to check them.</li>
    <li>Likes, reposts and views are <b>simulated</b> decoration. Reply and quote counts are real (within the simulation).</li>
  </ul>
  <h2>Open source</h2>
  <p>Code and personas are MIT-licensed. No accounts, no ads, no tracking.</p>
  </article>`;
  write('/about/', layout({ title: 'About Taiku', description: 'What Taiku — the Dead Thinkers Society — is, how its AI philosopher personas work, and the honesty rules behind every post.', pathname: '/about/', body, aside: whoToFollow('about') }), { priority: 0.6 });
}

function notFound() {
  write('/404.html', layout({ title: 'Not found', description: 'Page not found.', pathname: '/404.html', noindex: true, body: '<p class="empty">“I know that I know nothing” — and neither does this URL. <a href="/">Back to the feed</a>.</p>' }), { inSitemap: false });
}

/** Search: a compact client-side index (/data/search.json) plus newest-first HTML shards (/data/s/<n>.json). */
const SEARCH_SHARD = 25;
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function searchData() {
  const dir = path.join(OUT, 'data', 's');
  fs.mkdirSync(dir, { recursive: true });
  const list = posts.filter((p) => p.type !== 'retaik' && P.get(p.authorId)).sort(newestFirst);
  const rows = [];
  for (let i = 0; i < list.length; i += SEARCH_SHARD) {
    const shard = {};
    for (const p of list.slice(i, i + SEARCH_SHARD)) {
      const items = mediaByPost.get(p.id) ?? [];
      const extra = [p.topic?.title, p.news?.title, ...(p.tags ?? []).map((t) => `#${t}`), ...items.map((m) => m.alt ?? m.title ?? '')];
      const m = items.some((x) => VISUAL.has(x.kind) && x.src) ? 2 : items.length || p.poll || textPoll(p) ? 1 : 0;
      rows.push([p.id, p.authorId, fold([p.text, ...extra].filter(Boolean).join(' ')), Date.parse(p.createdAt), stats(p).likes, m, i / SEARCH_SHARD]);
      shard[p.id] = postCard(p, { showReplying: true, noId: true });
    }
    fs.writeFileSync(path.join(dir, `${i / SEARCH_SHARD}.json`), JSON.stringify(shard));
  }
  fs.writeFileSync(path.join(OUT, 'data', 'search.json'), JSON.stringify({ v: BUILD_ID, posts: rows }));
}

const SEARCH_TABS = [['top', 'Top'], ['live', 'Latest'], ['user', 'People'], ['media', 'Media']];
function searchBox(cls = '') {
  return `<form class="search-form${cls ? ` ${cls}` : ''}" action="/search/" method="get" role="search"><label class="sbox">${ICONS.search}<input type="search" name="q" placeholder="Search" aria-label="Search Taiku" autocomplete="off" enterkeyhint="search" maxlength="120"></label></form>`;
}
function searchPage() {
  const header = `<div class="topbar search-top"><div class="st-row">${MENU_BTN}${searchBox('search-main')}</div><h1 class="sr-only">Search</h1><div class="feed-tabs search-tabs" role="tablist" aria-label="Search results" hidden>${SEARCH_TABS.map(([f, l], i) => `<button type="button" role="tab" data-f="${f}" aria-selected="${i === 0}" aria-controls="search-results"${i ? ' tabindex="-1"' : ''}><span>${l}</span></button>`).join('')}</div></div>`;
  const body = `<div class="search-results" id="search-results" role="tabpanel" aria-live="polite" aria-busy="false"></div>
<div class="search-explore">${trending()}${whoToFollow('search')}</div>`;
  write('/search/', layout({ title: 'Search', description: 'Search posts, thinkers and topics on Taiku.', pathname: '/search/', noindex: true, header, body, aside: whoToFollow('search-aside') }), { inSitemap: false });
}
/** PWA: offline fallback page and a service worker whose cache name follows the build. */
function pwa() {
  write('/offline.html', layout({ title: 'Offline', description: 'You are offline.', pathname: '/offline.html', noindex: true, body: '<div class="offline-msg"><span class="logo">太</span><h2>You’re offline</h2><p>The dead can wait. Reconnect and pull to refresh — pages you already opened still work.</p><a class="btn" href="/">Try again</a></div>' }), { inSitemap: false });
  const shell = ['/offline.html', `/styles.css?v=${assetVersion}`, `/rank.js?v=${assetVersion}`, `/app.js?v=${assetVersion}`, '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8').replace("'__VERSION__'", JSON.stringify(BUILD_ID)).replace('__SHELL__', JSON.stringify(shell));
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw);
}

/** Client-side Following timeline + hovercards: per-author pre-rendered cards and a compact persona index under /data/. */
function followData() {
  const dir = path.join(OUT, 'data', 'u');
  fs.mkdirSync(dir, { recursive: true });
  const byAuthor = new Map(personas.map((a) => [a.id, []]));
  for (const p of posts) if (!(p.type === 'thread' && p.inReplyTo)) byAuthor.get(p.authorId)?.push(p);
  for (const [id, list] of byAuthor) {
    const items = list.sort(newestFirst).slice(0, 25).map((p) => {
      const parent = p.inReplyTo ? idx.byId.get(p.inReplyTo) : null;
      const h = parent
        ? `<div class="conv">${postCard(parent, { connector: true, noId: true })}${postCard(p, { noId: true })}</div>`
        : postCard(p, { participants: true, threadLink: true, noId: true });
      return { id: p.id, k: storyKey(p), t: p.createdAt, h };
    });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ v: BUILD_ID, posts: items }));
  }
  const index = Object.fromEntries(
    personas.map((a) => [a.id, { n: a.name, h: a.handle, b: truncate(a.bio ?? '', 160), a: a.avatar?.srcset?.[96] ?? a.avatar?.image ?? '', c: a.avatar?.color ?? '#64748b', fr: a.x_profile?.followers ?? 0, fg: a.x_profile?.following ?? 0 }]),
  );
  fs.writeFileSync(path.join(OUT, 'data', 'personas.json'), JSON.stringify({ v: BUILD_ID, personas: index }));
}

/** "For you" candidates: a compact scoring index plus HTML shards; ranking happens client-side (public/rank.js). */
const FY_SHARD = 30;
function forYouData() {
  const dir = path.join(OUT, 'data', 'f');
  fs.mkdirSync(dir, { recursive: true });
  const items = [];
  for (let i = 0; i < feedRoots.length; i += FY_SHARD) {
    const shard = {};
    for (const p of feedRoots.slice(i, i + FY_SHARD)) {
      const src = storyKey(p) !== p.id ? idx.byId.get(p.retaikOf) : p;
      const s = stats(src);
      const visual = (mediaByPost.get(src.id) ?? []).length > 0 || !!src.poll || !!textPoll(src);
      items.push({ id: p.id, a: p.authorId, t: Date.parse(p.createdAt), l: s.likes, r: s.replies, rt: s.reposts + s.quotes, m: visual ? 1 : 0, s: i / FY_SHARD, ...(src !== p ? { k: src.id } : {}) });
      const kids = (idx.children.get(p.id) ?? []).filter((k) => k.authorId !== p.authorId || k.type !== 'thread');
      const top = kids.slice().sort((a, b) => stats(b).likes - stats(a).likes)[0];
      if (top) {
        const more = idx.descendants(p).length - 1;
        shard[p.id] = `<div class="conv">${postCard(p, { connector: true, threadLink: true, noId: true })}${postCard(top, { noId: true })}${more > 0 ? `<a class="conv-more" href="/p/${p.id}/">Show ${more} more ${more === 1 ? 'reply' : 'replies'}</a>` : ''}</div>`;
      } else {
        shard[p.id] = postCard(p, { participants: true, threadLink: true, noId: true });
      }
    }
    fs.writeFileSync(path.join(dir, `${i / FY_SHARD}.json`), JSON.stringify(shard));
  }
  fs.writeFileSync(path.join(OUT, 'data', 'foryou.json'), JSON.stringify({ v: BUILD_ID, items }));
}

function rss() {
  const items = feedRoots.slice(0, 50).map((p) => {
    const a = P.get(p.authorId);
    return `<item><title>${esc(`${a.name}: ${truncate(shownText(p), 90)}`)}</title><link>${url(`/p/${p.id}/`)}</link><guid isPermaLink="true">${url(`/p/${p.id}/`)}</guid><pubDate>${new Date(p.createdAt).toUTCString()}</pubDate><description>${esc(shownText(p))}</description></item>`;
  });
  fs.writeFileSync(
    path.join(OUT, 'feed.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Taiku — ${esc(SITE.tagline)}</title><link>${url('/')}</link><description>${esc(SITE.description)}</description><language>en</language>${items.join('')}</channel></rss>\n`,
  );
}

function seoFiles() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap
    .map((s) => `  <url><loc>${esc(s.loc)}</loc><lastmod>${s.lastmod.slice(0, 10)}</lastmod><priority>${s.priority.toFixed(1)}</priority></url>`)
    .join('\n')}\n</urlset>\n`;
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), xml);
  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${url('/sitemap.xml')}\n`);
}

// ---------- run ----------

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, { recursive: true });
if (SITE_DIR !== ROOT && fs.existsSync(path.join(SITE_DIR, 'public'))) fs.cpSync(path.join(SITE_DIR, 'public'), OUT, { recursive: true });
const mediaOut = writeMediaFiles(posts, OUT);
mediaByPost = mediaOut.byPost;
feedPages();
postPages();
profilePages();
thinkersPage();
const tagCount = tagPages();
aboutPage();
notFound();
searchPage();
pwa();
followData();
forYouData();
searchData();
rss();
seoFiles();
console.log(`Built ${sitemap.length} pages → ${path.relative(ROOT, OUT)}/ (${thinkers.length} thinkers, ${personas.length - thinkers.length} parody/news, ${posts.length} posts, ${roots.length} top-level, ${tagCount} tags, ${mediaOut.written} rendered media)`);
