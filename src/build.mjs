#!/usr/bin/env node
// Static site generator for Taiku. Zero dependencies: reads personas/*.json and
// content/posts/*.json, writes indexable HTML to dist/.
import fs from 'node:fs';
import path from 'node:path';
import { displayName, publicFile, ROOT, SITE_DIR, loadPersonas, loadPosts, validate, indexPosts, safeUrl } from './lib/data.mjs';
import { sanitizeUntrusted } from './lib/news.mjs';
import { SITE, esc, hash, shortDate, longDate, truncate, compactNumber, renderText, slugify } from './lib/util.mjs';
import { writeMediaFiles } from './lib/media.mjs';
import { PostPack } from './lib/postpack.mjs';
import { OUT_DIR, SITE_CONFIG } from './lib/site.mjs';
import { t, fmtNumber, clientStrings, DIR, CA, HTML_CA, cw, CONTENT_LOCALE, STRINGS } from './lib/i18n.mjs';

/** User-facing UI strings in one place (i18n-ready). */
const STR = {
  back: t('nav.back'),
  following: t('profile.following'),
  followers: t('profile.followers'),
  profileSections: t('profile.sectionsAria'),
  followLists: t('profile.followListsAria'),
  tabs: { posts: t('profile.tabPosts'), replies: t('profile.tabReplies'), media: t('profile.tabMedia'), about: t('profile.tabAbout') },
  tabTitle: { posts: t('profile.tabPosts'), replies: t('profile.tabTitleReplies'), media: t('profile.tabMedia'), about: t('profile.tabAbout') },
  viewPhoto: t('media.viewPhoto'),
  viewBanner: t('media.viewBanner'),
  viewImage: t('media.viewImage'),
  bannerOf: (name) => t('media.bannerOf', { name }),
  close: t('nav.close'),
  imageDescription: t('media.alt'),
  emptyPosts: (handle) => ({ title: t('profile.emptyPostsTitle', { handle }), body: t('profile.emptyPostsBody') }),
  emptyMedia: (handle) => ({ title: t('profile.emptyMediaTitle', { handle }), body: t('profile.emptyMediaBody') }),
  followNote: (kind, a, n) => t(kind === 'followers' ? 'follow.noteFollowers' : 'follow.noteFollowing', { name: a.name, n }),
  noFollows: (kind, handle) => t(kind === 'followers' ? 'follow.noFollowers' : 'follow.noFollowing', { handle }),
  linkUnavailable: t('media.linkUnavailable'),
  noTagPosts: (tag) => t('tag.empty', { tag }),
};
const OUT = OUT_DIR;
const LOGO = esc(SITE_CONFIG.logo ?? SITE.name[0]);
const CLIENT_I18N = clientStrings();
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
const SITE_CSS_FILE = path.join(SITE_DIR, 'public', 'site.css');
const SITE_CSS = SITE_DIR !== ROOT && fs.existsSync(SITE_CSS_FILE) ? `\n<link rel="stylesheet" href="/site.css?v=${hash(fs.readFileSync(SITE_CSS_FILE, 'utf8')).toString(36)}">` : '';
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
  return m.kind === 'chart' ? t('media.chartCredit') : '';
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
  if (h >= 24) return t('poll.days', { n: Math.floor(h / 24) });
  if (h >= 1) return t('poll.hours', { n: h });
  return t('poll.minutes', { n: Math.max(1, Math.round(ms / 60000)) });
};

/** Every rendered poll: id -> [option ids, ends ms]. Written to _p/polls.json for the Worker's vote API. */
const POLL_INDEX = {};

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
  POLL_INDEX[poll.id ?? post.id] = [opts.map((o) => o.id), ends];
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  const rows = opts
    .map((o) => `<li><button type="button" class="poll-opt${o.votes === max ? ' lead' : ''}" data-opt="${esc(o.id)}" data-votes="${o.votes}"${closed ? ' disabled' : ''}><span class="po-bar" style="width:${pct(o.votes)}%"></span><span class="po-label">${esc(o.text)}</span><span class="po-pct">${pct(o.votes)}%</span></button></li>`)
    .join('');
  return `<div class="poll${closed ? ' closed' : ''}" data-poll="${esc(poll.id ?? post.id)}" data-ends="${new Date(ends).toISOString()}"><ul class="poll-opts" aria-label="${t('poll.aria')}">${rows}</ul><div class="poll-meta"><span class="poll-total" data-total="${total}">${t('poll.votes', { n: total, count: fmtNumber(total) })}</span> · <span class="poll-state">${closed ? t('poll.final') : pollTime(left)}</span></div></div>`;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

/** X-style link card: big thumbnail on top when there is one, otherwise a compact row with an icon. */
// Fetched card/post fields are untrusted: every URL goes through safeUrl() (or is a same-site path) and
// every fetched string through sanitizeUntrusted() at render time, whatever the stored data says.
const imgUrl = (u) => (typeof u === 'string' && /^\/(?!\/)/.test(u) ? u : safeUrl(u));
const num = (v) => (Number.isInteger(v) && v > 0 && v < 10000 ? v : undefined);

function linkCard({ url: href0, title: title0, domain, site_name: site0, description: desc0, src: src0, width: w0, height: h0, alt, image, icon: icon0 }) {
  const href = safeUrl(href0);
  const title = title0 ? sanitizeUntrusted(title0, 200) : '';
  const site = site0 ? sanitizeUntrusted(site0, 80) : '';
  const description = desc0 ? sanitizeUntrusted(desc0, 300) : '';
  const icon = imgUrl(icon0);
  if (!title && !href) return '';
  const src = imgUrl(image?.url ?? src0);
  const width = num(image ? image.width : w0);
  const height = num(image ? image.height : h0);
  const dom = domain || (href ? hostOf(href) : '') || site || 'news';
  const size = width && height ? ` width="${width}" height="${height}"` : '';
  const tile = `<span class="lc-tile" aria-hidden="true">${esc((dom.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span>`;
  const shown = esc(title || href);
  // Large card like X: the image carries the headline as an overlay and "From domain" sits below it.
  // Summary card: favicon (or a domain-letter tile) beside domain, headline and description.
  const inner = src
    ? `<span class="lc-img"><img src="${esc(src)}" alt="${esc(alt ?? '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"${size}><span class="lc-overlay">${shown}</span></span><span class="lc-from">${esc(t('card.from', { domain: dom }))}</span>`
    : `<span class="lc-icon">${icon ? `<img class="lc-favicon" src="${esc(icon)}" alt="" width="32" height="32" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : tile}</span><span class="lc-body"><span class="lc-domain">${esc(dom)}</span><span class="lc-title">${shown}</span>${description ? `<span class="lc-desc">${esc(truncate(description, 140))}</span>` : ''}</span>`;
  const cls = `link-card ${src ? 'lc-large' : 'lc-small'}`;
  return href ? `<a class="${cls}" href="${esc(href)}" rel="noopener nofollow ugc" target="_blank" data-tile="${esc(dom)}">${inner}</a>` : `<div class="${cls} lc-static" title="${esc(STR.linkUnavailable)}">${inner}</div>`;
}

/** Quote of a real public post (x_post / bsky_post): exact fetched text, links out to the original. */
function realPostHtml(m0) {
  const url = safeUrl(m0.url);
  const text = sanitizeUntrusted(m0.text ?? '', 560);
  const handle = /^[A-Za-z0-9_.:-]{1,64}$/.test(m0.handle ?? '') ? m0.handle : '';
  if (!url || !text || !handle) return '';
  const m = { ...m0, url, text, handle, author_name: sanitizeUntrusted(m0.author_name ?? '', 80), avatar_url: safeUrl(m0.avatar_url), media_thumb: safeUrl(m0.media_thumb) };
  const x = m.kind === 'x_post';
  const net = x ? 'X' : 'Bluesky';
  const ts = Date.parse(m.created_at ?? '');
  const when = Number.isFinite(ts) ? ` · <time datetime="${new Date(ts).toISOString()}">${esc(shortDate(new Date(ts).toISOString()))}</time>` : '';
  const name = m.author_name || m.handle;
  const av = m.avatar_url ? `<img class="rp-avatar" src="${esc(m.avatar_url)}" alt="" width="20" height="20" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : `<span class="rp-avatar rp-av-tile" aria-hidden="true">${esc((name.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span>`;
  const thumb = m.media_thumb ? `<span class="lc-img rp-thumb"><img src="${esc(m.media_thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>` : '';
  return `<a class="real-post quote rp-${x ? 'x' : 'bsky'}" href="${esc(m.url)}" rel="noopener nofollow ugc" target="_blank" aria-label="${esc(t('card.realPost', { name, net }))}"><span class="rp-head">${av}<b class="rp-name">${esc(name)}</b><span class="rp-handle">@${esc(m.handle)}${when}</span><span class="rp-net" title="${net}">${x ? X_LOGO : BSKY_LOGO}</span></span><span class="rp-text">${esc(truncate(m.text, 400))}</span>${thumb}</a>`;
}

const X_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
const BSKY_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.3 4.2C8.6 5.9 11 9.4 12 11.3c1-1.9 3.4-5.4 5.7-7.1 1.6-1.2 4.3-2.2 4.3.9 0 .6-.4 5.1-.6 5.8-.7 2.5-3.2 3.1-5.5 2.7 4 .7 5 2.9 2.8 5.2-4.2 4.3-6-1.1-6.5-2.5L12 15.7l-.2.6c-.5 1.4-2.3 6.8-6.5 2.5-2.2-2.3-1.2-4.5 2.8-5.2-2.3.4-4.8-.2-5.5-2.7C2.4 10.2 2 5.7 2 5.1c0-3.1 2.7-2.1 4.3-.9z"/></svg>';

const VISUAL = new Set(['image', 'art', 'meme', 'gif', 'chart']);

// Library art ships a 600px WebP next to the 1200px one: the feed picks by viewport, the lightbox keeps 1200px.
const smallArt = new Map();
function artSrcset(m) {
  const name = /^\/media\/art\/([^/]+\.webp)$/.exec(m.src ?? '')?.[1];
  if (!name) return '';
  if (!smallArt.has(name)) smallArt.set(name, fs.existsSync(publicFile(`media/art/600/${name}`)) ? `/media/art/600/${name}` : null);
  const small = smallArt.get(name);
  if (!small) return '';
  const w = m.width || 1200;
  return ` srcset="${esc(small)} ${Math.round(w / 2)}w, ${esc(m.src)} ${w}w"`;
}

function visualHtml(m, multi) {
  const set = artSrcset(m);
  const size = (m.width && m.height ? ` width="${m.width}" height="${m.height}"` : '') + (set ? `${set} sizes="${multi ? '(max-width: 600px) 45vw, 260px' : '(max-width: 600px) calc(100vw - 72px), 516px'}"` : '');
  const badge = m.kind === 'gif' ? '<span class="media-badge">GIF</span>' : '';
  const altBtn = m.alt ? `<button type="button" class="alt-badge" data-alt="${esc(m.alt)}" aria-label="${esc(STR.imageDescription)}">ALT</button>` : '';
  const ratio = !multi && m.width && m.height ? ` style="aspect-ratio:${m.width}/${m.height}"` : '';
  return `<div class="media-cell media-${esc(m.kind)}"${ratio}><button type="button" class="media-zoom" data-zoom="${esc(m.src)}" data-zoom-alt="${esc(m.alt ?? '')}" aria-label="${esc(STR.viewImage)}"><img src="${esc(m.src)}" alt="${esc(m.alt ?? '')}" loading="lazy" decoding="async"${size}></button>${badge}${altBtn}</div>`;
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
    if (m.kind === 'video' && m.src) out.push(`<figure class="media"><div class="media-grid n1"><div class="media-cell"><video src="${esc(m.src)}" controls preload="none" playsinline${m.width && m.height ? ` width="${m.width}" height="${m.height}"` : ''} aria-label="${esc(m.alt ?? t('media.video'))}"></video></div></div></figure>`);
    if (m.kind === 'link_card') out.push(linkCard(m));
    if (m.kind === 'x_post' || m.kind === 'bsky_post') out.push(realPostHtml(m));
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

const MENU_BTN = `<button type="button" class="menu-btn" aria-label="${t('nav.openMenu')}" aria-controls="drawer" aria-expanded="false">${ICONS.user}</button>`;
function tabbar(pathname) {
  const cur = (on) => (on ? ' aria-current="page"' : '');
  return [
    `<a href="/" aria-label="${t('nav.home')}"${cur(pathname === '/' || /^\/page\//.test(pathname))} data-home>${ICONS.home}</a>`,
    `<a href="/search/" aria-label="${t('nav.search')}"${cur(pathname === '/search/')}>${ICONS.search}</a>`,
    `<button type="button" data-gate="notifications" aria-label="${t('nav.notifications')}">${ICONS.bell}</button>`,
    `<a href="/me/" aria-label="${t('me.title')}"${cur(pathname === '/me/')}>${ICONS.user}</a>`,
  ].join('');
}

function aiBadge() {
  return ''; // per-persona badges dropped by user decision; site-wide disclosure lives in footer and /about
}

function kindLabel(a) {
  if (a.kind === 'parody' || a.kind === 'fictional') return `<span class="kind-label">${t('kind.parody')}</span>`;
  if (a.kind === 'news') return `<span class="kind-label">${t('kind.news')}</span>`;
  return '';
}

function postHead(post, author, { focal = false } = {}) {
  const time = `<time datetime="${esc(post.createdAt)}" data-rel>${esc(focal ? longDate(post.createdAt) : shortDate(post.createdAt))}</time>`;
  return `<header class="post-head">
    <a class="name"${CA} href="/thinkers/${author.id}/">${esc(displayName(author))}</a>${kindLabel(author)}
    <a class="handle" href="/thinkers/${author.id}/" tabindex="-1">@${esc(author.handle)}</a>${focal ? '' : `<span class="dot">·</span><a class="time" href="/p/${post.id}/">${time}</a>`}
  </header>`;
}

function quoteEmbed(qid) {
  const q = idx.byId.get(qid);
  if (!q) return '';
  const qa = P.get(q.authorId);
  return `<a class="quote-embed" href="/p/${q.id}/">
    <span class="qe-head">${avatar(qa, 'xs')}<b${CA}>${esc(displayName(qa))}</b> <span class="handle">@${esc(qa.handle)}</span> · ${esc(shortDate(q.createdAt))}</span>
    <span class="qe-text"${CA}>${esc(truncate(shownText(q), 260))}</span>
  </a>`;
}

function postCard(post, opts = {}) {
  if (post.type === 'retaik' && post.retaikOf && idx.byId.get(post.retaikOf)) {
    const ra = P.get(post.authorId);
    return `<div class="retaik-row"><div class="retaik-head">${ICONS.repost}${t('post.retaiked', { name: `<a href="/thinkers/${ra.id}/"${CA}>${esc(displayName(ra))}</a>` })}</div>${postCard(idx.byId.get(post.retaikOf), { ...opts, focal: false, noId: true })}</div>`;
  }
  const { focal = false, connector = false, showReplying = false, participants = false, threadLink = false, compact = false } = opts;
  const author = P.get(post.authorId);
  const s = stats(post);
  const parent = post.inReplyTo ? idx.byId.get(post.inReplyTo) : null;
  const parts = [];
  if (showReplying && parent) {
    const pa = P.get(parent.authorId);
    parts.push(`<div class="replying">${t('post.replyingTo')} <a href="/thinkers/${pa.id}/">@${esc(pa.handle)}</a></div>`);
  }
  const shownBody = textPoll(post)?.text ?? post.text;
  if (shownBody) parts.push(`<div class="text${focal ? ' text-lg' : ''}"${CA}>${renderText(shownBody, handleMap)}</div>`);
  const media = mediaHtml(post);
  if (media) parts.push(media);
  if (post.citation) parts.push(`<div class="cite">📖 ${t('post.quotedFrom')} <cite${CA}>${esc(post.citation)}</cite></div>`);
  const hasCard = (mediaByPost.get(post.id) ?? []).some((m) => ['link_card', 'x_post', 'bsky_post'].includes(m.kind));
  if (post.news?.title && post.news.url && !hasCard) {
    parts.push(linkCard({ url: post.news.url, title: post.news.title, domain: (post.news.url ? hostOf(post.news.url) : '') || post.news.source }));
  } else if (post.topic?.url && post.topic.title && !hasCard) {
    parts.push(linkCard({ url: post.topic.url, title: post.topic.title, domain: hostOf(post.topic.url) || post.topic.source }));
  }
  if (post.quoteOf) parts.push(quoteEmbed(post.quoteOf));
  if (threadLink) {
    const tp = idx.selfThread(post);
    if (tp.length) parts.push(`<a class="thread-link" href="/p/${post.id}/">${t('post.showThread', { n: tp.length + 1 })}</a>`);
  }
  if (participants) {
    const desc = convo(post);
    const ids = [...new Set(desc.map((d) => d.authorId).filter((id) => id !== post.authorId))];
    if (ids.length) {
      const names = ids.slice(0, 2).map((id) => cw(esc(P.get(id).name))).join(', ');
      const more = ids.length > 2 ? ` +${ids.length - 2}` : '';
      parts.push(`<a class="participants" href="/p/${post.id}/">${ids.slice(0, 4).map((id) => avatar(P.get(id), 'xs')).join('')}<span>${t('post.weighedIn', { n: desc.length, names: names + more })}</span></a>`);
    }
  }
  if (focal) {
    parts.push(`<div class="focal-meta"><time datetime="${esc(post.createdAt)}">${esc(longDate(post.createdAt))}</time> · <span title="${t('post.simulated')}">${t('post.views', { n: s.views, count: compactNumber(s.views) })}</span></div>`);
  }
  if (!compact) {
    parts.push(`<footer class="actions" aria-label="${t('act.engagement')}">
      <button type="button" class="act act-reply" data-gate="reply" aria-label="${t('act.reply')}">${ICONS.reply}<span>${convoReplies(post) || ''}</span></button>
      <button type="button" class="act act-repost" data-gate="retaik" aria-label="${t('act.retaik')}">${ICONS.repost}<span>${compactNumber(s.reposts + s.quotes)}</span></button>
      <button type="button" class="act act-like" data-like="${post.id}" data-count="${s.likes}" aria-pressed="false" aria-label="${t('act.like')}">${ICONS.like}<span>${compactNumber(s.likes)}</span></button>
      <span class="act act-views" title="${t('act.views')}">${ICONS.views}<span>${compactNumber(s.views)}</span></span>
      <span class="act-end"><button type="button" class="act act-bm" data-bookmark="${post.id}" aria-pressed="false" aria-label="${t('act.bookmark')}">${ICONS.bookmark}</button><button type="button" class="act act-share" data-share="/p/${post.id}/" aria-label="${t('act.share')}">${ICONS.share}</button></span>
    </footer>`);
  }
  const cls = ['post', focal && 'focal', connector && 'has-connector', compact && 'compact'].filter(Boolean).join(' ');
  return `<article class="${cls}"${opts.noId ? '' : ` id="post-${post.id}"`} data-href="/p/${post.id}/" data-pid="${post.id}" data-author="${author.id}">
  <div class="gutter"><a href="/thinkers/${author.id}/" class="avatar-link" aria-label="${esc(author.name)}">${avatar(author, focal ? 'lg' : '')}</a>${connector ? '<span class="connector"></span>' : ''}</div>
  <div class="post-body">${postHead(post, author, { focal })}${parts.join('\n')}</div>
</article>`;
}

/** Replies in a conversation (all descendants, minus the author's own thread continuation): same number on the button and the participants row. */
const convo = (post) => idx.descendants(post).filter((d) => d.authorId !== post.authorId || d.type !== 'thread');
const convoReplies = (post) => convo(post).length;

function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

function followBtn(p, size = '') {
  return `<button type="button" class="btn follow-btn${size ? ` ${size}` : ''}" data-follow="${esc(p.id)}" aria-pressed="false" aria-label="${esc(t('follow.aria', { handle: p.handle }))}"><span class="fb-off">${t('follow.follow')}</span><span class="fb-on">${t('follow.following')}</span><span class="fb-un">${t('follow.unfollow')}</span></button>`;
}

function wtfRow(p) {
  return `<div class="wtf"><a class="wtf-link" href="/thinkers/${p.id}/">${avatar(p, 'sm')}<span class="wtf-names"><b${CA}>${esc(displayName(p))}</b>${kindLabel(p)}<span class="handle">@${esc(p.handle)}</span></span></a>${followBtn(p, 'btn-sm')}</div>`;
}

function whoToFollow(seed, exclude = []) {
  const pool = thinkers.filter((p) => !exclude.includes(p.id));
  const start = hash(String(seed)) % pool.length;
  const list = Array.from({ length: Math.min(4, pool.length) }, (_, i) => pool[(start + i * 7) % pool.length]);
  return `<section class="panel wtf-panel"><h2>${t('wtf.title')}</h2><div class="wtf-rows">${[...new Map(list.map((p) => [p.id, p])).values()].map(wtfRow).join('')}</div><a class="more" href="/connect/">${t('wtf.showAll')}</a></section>`;
}

// ---------- topics & trends: a followable taxonomy derived from post tags and news topics ----------
const META_TAGS = new Set(['news', 'recap', 'press', 'breaking', 'update', 'thread']);
const postsN = (n) => t('count.posts', { n });
const topicLabel = (k) => STRINGS[`topic.label.${k}`] ?? k.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const rootOf = (p) => { let r = p; for (let i = 0; i < 60 && r.inReplyTo && idx.byId.has(r.inReplyTo); i++) r = idx.byId.get(r.inReplyTo); return r; };
const newsKey = (p) => (p.topic?.id ? `n_${slugify(p.topic.id).slice(0, 60)}` : null);
/** Topic keys of a post: its own tags and news topic plus its thread root's (replies are rarely tagged). */
function topicKeysOf(p) {
  const src = p.type === 'retaik' && idx.byId.has(p.retaikOf) ? idx.byId.get(p.retaikOf) : p;
  const r = rootOf(src);
  const keys = new Set();
  for (const q of r === src ? [src] : [src, r]) {
    for (const tag of q.tags ?? []) { const s = slugify(tag); if (s && !META_TAGS.has(s)) keys.add(s); }
    const n = newsKey(q);
    if (n) keys.add(n);
  }
  return [...keys];
}
let TOPICS = null;
function topicIndex() {
  if (TOPICS) return TOPICS;
  const all = new Map();
  const newest = posts.reduce((m, p) => (p.createdAt > m ? p.createdAt : m), '');
  const since = new Date(Date.parse(newest || BUILD_TIME) - 48 * 3600000).toISOString();
  const recent = new Map();
  const keysOf = new Map();
  for (const p of posts) {
    const keys = topicKeysOf(p);
    keysOf.set(p.id, keys);
    if (p.type === 'retaik') continue;
    for (const k of keys) {
      if (!all.has(k)) {
        const n = k.startsWith('n_') ? (p.topic?.id && newsKey(p) === k ? p.topic : rootOf(p).topic) : null;
        all.set(k, { k, label: n ? n.title : topicLabel(k), news: !!n, source: n?.source ?? '', posts: [] });
      }
      all.get(k).posts.push(p);
      if (p.createdAt >= since) recent.set(k, (recent.get(k) ?? 0) + 1);
    }
  }
  for (const e of all.values()) e.posts.sort(newestFirst);
  const topics = [...all.values()].filter((e) => !e.news && e.posts.length >= 6).sort((a, b) => b.posts.length - a.posts.length || a.k.localeCompare(b.k)).slice(0, 40);
  const trends = [...recent.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([k, n]) => ({ ...all.get(k), recent: n }));
  TOPICS = { all, topics, trends, keysOf };
  return TOPICS;
}
const topicHref = (e) => (e.news ? `/p/${e.posts.slice().sort((a, b) => convoReplies(b) - convoReplies(a))[0].id}/` : `/tags/${e.k}/`);
function topicBtn(e) {
  return `<button type="button" class="btn follow-btn btn-sm" data-topic="${esc(e.k)}" aria-pressed="false" aria-label="${esc(t('topic.follow', { label: e.label }))}"><span class="fb-off">${t('follow.follow')}</span><span class="fb-on">${t('follow.following')}</span><span class="fb-un">${t('follow.unfollow')}</span></button>`;
}
function topicChip(e) {
  return `<button type="button" class="tchip" data-topic="${esc(e.k)}" aria-pressed="false"><span>${esc(e.label)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path class="tc-plus" d="M12 6v12M6 12h12"/><path class="tc-tick" d="m6 12.5 4 4 8-9"/></svg></button>`;
}
function topicChips(list) {
  return `<div class="topic-chips">${list.map(topicChip).join('')}</div>`;
}
const trendMeta = (e, i) => (e.news ? (e.source ? t('topic.newsFrom', { source: e.source }) : t('topic.news')) : t('topic.trendRank', { rank: i + 1 }));
function trendRow(e, i) {
  const meta = trendMeta(e, i);
  return `<div class="trend trend-f"><a class="trend-link" href="${esc(topicHref(e))}"><span class="t-meta">${esc(meta)}</span><span class="t-title">${e.news ? '' : '#'}${esc(e.news ? truncate(e.label, 80) : e.k)}</span><span class="t-meta">${esc(postsN(e.recent ?? e.posts.length))}</span></a>${topicBtn(e)}</div>`;
}
function whatsHappening(n = 5) {
  const { trends } = topicIndex();
  if (!trends.length) return '';
  return `<section class="panel trends-panel"><h2>${esc(t('topic.whatsHappening'))}</h2>${trends.slice(0, n).map(trendRow).join('')}<a class="more" href="/connect/#trending">${esc(t('topic.showMore'))}</a></section>`;
}

function trending() {
  const debates = roots
    .map((r) => [r, idx.descendants(r).length])
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].createdAt.localeCompare(a[0].createdAt))
    .slice(0, 4);
  return `<section class="panel"><h2>${t('trend.debates')}</h2>${debates
    .map(([r, n]) => `<a class="trend" href="/p/${r.id}/"><span class="t-meta">${cw(esc(P.get(r.authorId).name))} · ${t('trend.replies', { n })}</span><span class="t-title"${CA}>${esc(truncate(shownText(r), 80))}</span></a>`)
    .join('')}</section>

  ${whatsHappening()}`;
}

export const HEAD_SCRIPT = "try{var d=document.documentElement;d.dataset.theme=localStorage.getItem('theme')||'dark';if(localStorage.getItem('welcomed'))d.dataset.welcomed='1';d.dataset.tab=localStorage.getItem('feedTab')==='following'?'following':'foryou'}catch(e){}";

function layout({ title, description, pathname, body, ld = [], ogType = 'website', aside = null, noindex = false, header = null }) {
  const canonical = url(pathname);
  const fullTitle = title ? `${title} | ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
  const nav = [
    ['/search/', t('nav.explore'), '🔍'],
    ['/thinkers/', t('nav.thinkers'), '🏛️'],
    ['/me/', t('me.title'), '🙂'],
    ['/about/', t('nav.about'), 'ℹ️'],
  ];
  const navHtml = nav
    .map(([href, label, icon]) => `<a href="${href}"${pathname === href ? ' aria-current="page"' : ''}><span class="ni">${icon}</span><span class="nl">${label}</span></a>`)
    .join('');
  return `<!doctype html>
<html lang="${esc(SITE.locale)}"${DIR === 'rtl' ? ' dir="rtl"' : ''}${HTML_CA}>
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
<meta name="apple-mobile-web-app-title" content="${esc(SITE.name)}">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="mobile-web-app-capable" content="yes">
<link rel="alternate" type="application/rss+xml" title="${esc(t('rss.linkTitle'))}" href="/feed.xml">
<link rel="stylesheet" href="/styles.css?v=${assetVersion}">${SITE_CSS}
<script>${HEAD_SCRIPT}</script>
${ld.map(jsonLd).join('\n')}
</head>
<body data-build="${BUILD_ID}">
<a class="skip" href="#main">${t('skip')}</a>
<div class="shell">
  <nav class="leftnav" id="drawer" aria-label="${t('nav.mainAria')}">
    <a class="brand" href="/" data-home${pathname === '/' ? ' aria-current="page"' : ''}><span class="logo">${LOGO}</span><span class="brand-text"><b>${esc(SITE.name)}</b><small>${esc(SITE.tagline)}</small></span></a>
    ${navHtml}
    <button class="theme-toggle" type="button" aria-label="${t('nav.themeAria')}"><span class="ni">🌓</span><span class="nl">${t('nav.theme')}</span></button>
    <button class="nav-btn nav-login" type="button" data-gate="login"><span class="ni">👤</span><span class="nl">${t('nav.login')}</span></button>
    <button class="nav-btn nav-install" type="button" hidden><span class="ni">📲</span><span class="nl">${t('nav.install')}</span></button>
    <button class="btn post-btn" type="button" data-gate="post" aria-label="${t('nav.post')}"><span class="nl">${t('nav.post')}</span><span class="pb-icon">${ICONS.compose}</span></button>
  </nav>
  <div class="drawer-scrim" hidden></div>
  <main id="main" class="center">
    ${header ?? `<div class="topbar">${MENU_BTN}<h1>${esc(title || t('home.title'))}</h1></div>`}
    ${body}
  </main>
  <aside class="rightbar">
    ${pathname === '/search/' ? '' : searchBox('search-side')}
    ${aside ?? ''}
    <footer class="sitefoot"><a href="/about/">${t('nav.about')}</a> · <a href="/thinkers/">${t('nav.thinkers')}</a> · <a href="/feed.xml">${t('footer.rss')}</a> · <a href="/sitemap.xml">${t('footer.sitemap')}</a><br>${t('footer.copy', { year: new Date().getUTCFullYear() })}</footer>
  </aside>
</div>
<dialog class="lightbox" id="lightbox" aria-label="${esc(STR.viewImage)}"><form method="dialog"><button class="lb-x" aria-label="${esc(t('nav.close'))}">×</button></form><figure><img alt=""><figcaption></figcaption></figure></dialog>
<dialog class="modal" id="gate-modal" aria-labelledby="gate-title"><form method="dialog"><button class="modal-x" aria-label="${t('nav.close')}">×</button></form><div class="modal-logo">${LOGO}</div><h2 id="gate-title"></h2><p class="modal-msg"></p><form method="dialog"><button class="btn btn-primary btn-wide">${t('gotIt')}</button></form></dialog>
<nav class="tabbar" aria-label="${t('nav.sectionsAria')}">${tabbar(pathname)}</nav>
<button class="fab" type="button" data-gate="post" aria-label="${t('nav.post')}">${ICONS.compose}</button>
<div class="toast" role="status" aria-live="polite"></div>
${CLIENT_I18N}<script src="/rank.js?v=${assetVersion}" defer></script>
<script src="/app.js?v=${assetVersion}" defer></script>
</body>
</html>`;
}

const sitemap = [];
// POST_PAGES=static writes /p/<id>/index.html files; default packs them into dist/_p for the Worker (src/worker).
let postPack = null;
function write(pathname, html, { lastmod = BUILD_TIME, priority = 0.5, inSitemap = true, pack = null } = {}) {
  if (pack && postPack?.add(pack, html)) {
    if (inSitemap) sitemap.push({ loc: url(pathname), lastmod, priority });
    return;
  }
  const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html);
  if (inSitemap) sitemap.push({ loc: url(pathname), lastmod, priority });
}

// ---------- pages ----------

function onboardDialog() {
  const people = thinkers.filter((p) => (p.popularity ?? 5) >= 4).sort((a, b) => (b.popularity ?? 5) - (a.popularity ?? 5) || a.name.localeCompare(b.name)).slice(0, 12);
  return `<dialog class="modal onboard" id="onboard" aria-labelledby="ob-title"><form method="dialog"><button class="modal-x" aria-label="${esc(t('nav.close'))}">×</button></form><div class="modal-logo">${LOGO}</div><h2 id="ob-title">${esc(t('onboard.title'))}</h2><p class="modal-msg">${esc(t('onboard.body'))}</p>
<h3 class="ob-h">${esc(t('onboard.people'))}</h3><div class="ob-people">${people.map((p) => `<button type="button" class="ob-person" data-follow="${esc(p.id)}" aria-pressed="false">${avatar(p, 'md')}<span>${esc(p.name)}</span></button>`).join('')}</div>
<h3 class="ob-h">${esc(t('topic.topics'))}</h3>${topicChips(topicIndex().topics.slice(0, 18))}
<div class="ob-foot"><span class="ob-count" aria-live="polite"></span><button type="button" class="btn ob-skip">${esc(t('onboard.skip'))}</button><button type="button" class="btn btn-primary ob-done" disabled>${esc(t('onboard.done'))}</button></div></dialog>`;
}

/** /connect/: people, topics and trends to follow (X's "Connect" + Explore topics); the client re-ranks people by similarity. */
function connectPage() {
  const { topics, trends } = topicIndex();
  const people = personas.filter((p) => p.kind === 'thinker' || p.kind === 'parody' || p.kind === 'fictional').sort((a, b) => (b.popularity ?? 5) - (a.popularity ?? 5) || a.name.localeCompare(b.name));
  const tabs = Object.entries({ people: t('connect.tabPeople'), topics: t('connect.tabTopics'), trending: t('connect.tabTrending') }).map(([k, l], i) => `<button type="button" role="tab" id="ctab-${k}" data-ctab="${k}" aria-controls="cpanel-${k}" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ''}><span>${esc(l)}</span></button>`).join('');
  const header = `<div class="topbar connect-top"><div class="tb-row">${MENU_BTN}<div class="tb-title"><h1>${esc(t('connect.title'))}</h1><span class="sub">${esc(t('connect.sub'))}</span></div></div><div class="feed-tabs connect-tabs" role="tablist" aria-label="${esc(t('connect.title'))}">${tabs}</div></div>`;
  const body = `<section class="ctab-panel" id="cpanel-people" role="tabpanel" aria-labelledby="ctab-people"><h2 class="section-h">${esc(t('connect.suggested'))}</h2><div class="connect-people">${people.map((p) => `<div class="wtf-wide" data-pid="${esc(p.id)}">${wtfRow(p)}<p class="wtf-bio">${esc(truncate(p.bio ?? '', 140))}</p></div>`).join('')}</div><p class="fl-note">${esc(t('connect.note'))}</p></section>
<section class="ctab-panel" id="cpanel-topics" role="tabpanel" aria-labelledby="ctab-topics" hidden><h2 class="section-h">${esc(t('topic.toFollow'))}</h2>${topics.map((e) => `<div class="trend trend-f"><a class="trend-link" href="/tags/${esc(e.k)}/"><span class="t-title">${esc(e.label)}</span><span class="t-meta">${esc(postsN(e.posts.length))}</span></a>${topicBtn(e)}</div>`).join('')}</section>
<section class="ctab-panel" id="cpanel-trending" role="tabpanel" aria-labelledby="ctab-trending" hidden><h2 class="section-h">${esc(t('topic.whatsHappening'))}</h2>${trends.map(trendRow).join('')}</section>`;
  write('/connect/', layout({ title: t('connect.title'), description: t('connect.desc'), pathname: '/connect/', noindex: true, header, body, aside: whatsHappening() }), { inSitemap: false });
}

/** /me/: the visitor's local profile (likes, bookmarks, follows) rendered client-side from cookie/localStorage. */
function mePage() {
  const tabs = Object.entries({ likes: t('me.tabLikes'), bookmarks: t('me.tabBookmarks'), following: t('me.tabFollowing'), topics: t('me.tabTopics'), viewed: t('me.tabViewed') }).map(([k, l], i) => `<button type="button" role="tab" id="mtab-${k}" data-mtab="${k}" aria-controls="me-panel" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ''}><span>${esc(l)}</span></button>`).join('');
  const header = `<div class="topbar">${MENU_BTN}<div class="tb-title"><h1>${esc(t('me.title'))}</h1><span class="sub">${esc(t('me.sub'))}</span></div></div>`;
  const body = `<section class="profile me">
  <div class="banner me-banner"></div>
  <div class="profile-top"><span class="avatar xl me-avatar" aria-hidden="true">${ICONS.user}</span></div>
  <h2 class="p-name">${esc(t('me.title'))}</h2><div class="handle">${esc(t('me.handle'))}</div>
  <p class="me-note">${esc(t('me.note'))}</p>
  <div class="p-stats"><a href="#following" data-mtab-link="following"><b data-me-n="follows">0</b> ${esc(STR.following)}</a><a href="#topics" data-mtab-link="topics"><b data-me-n="topics">0</b> ${esc(t('topic.topics'))}</a></div>
</section>
<div class="feed-tabs me-tabs" role="tablist" aria-label="${esc(t('me.title'))}">${tabs}</div>
<div class="me-panel feed" id="me-panel" role="tabpanel" aria-live="polite" aria-busy="false"></div>
<p class="fe-cta"><a class="more" href="/connect/">${esc(t('me.findMore'))}</a></p>`;
  write('/me/', layout({ title: t('me.title'), description: t('me.desc'), pathname: '/me/', noindex: true, header, body, aside: whoToFollow('me') + whatsHappening() }), { inSitemap: false });
}

function feedPages() {
  const pages = Math.max(1, Math.ceil(feedRoots.length / PAGE_SIZE));
  for (let i = 0; i < pages; i++) {
    const slice = feedRoots.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
    const pathname = i === 0 ? '/' : `/page/${i + 1}/`;
    const pager = `<nav class="pager">${i > 0 ? `<a href="${i === 1 ? '/' : `/page/${i}/`}">${t('pager.newer')}</a>` : '<span></span>'}${i < pages - 1 ? `<a href="/page/${i + 2}/">${t('pager.older')}</a>` : '<span></span>'}</nav>`;
    const intro =
      i === 0
        ? `<div class="intro welcome"><button type="button" class="welcome-x" aria-label="${t('nav.dismiss')}">×</button>${t('home.welcome')}</div>`
        : '';
    const body = intro + `<div class="feed">${slice.map((p) => postCard(p, { participants: true, threadLink: true })).join('\n')}</div>` + pager;
    const home = i === 0;
    const suggestions = thinkers.filter((p) => (p.popularity ?? 5) >= 4).sort((a, b) => (b.x_profile?.followers ?? 0) - (a.x_profile?.followers ?? 0)).slice(0, 8);
    const fullBody = home
      ? `<div class="tab-panel tab-foryou" id="panel-foryou" role="tabpanel" aria-labelledby="tab-foryou">${body}</div>
<div class="tab-panel tab-following" id="panel-following" role="tabpanel" aria-labelledby="tab-following">
  <div class="following-feed feed" aria-live="polite" aria-busy="false"></div>
  <section class="following-empty"><h2>${t('following.emptyTitle')}</h2><p>${t('following.emptyText')}</p><h3 class="section-h">${t('wtf.title')}</h3>${suggestions.map((p) => `<div class="wtf-wide">${wtfRow(p)}<p class="wtf-bio"${CA}>${esc(truncate(p.bio, 120))}</p></div>`).join('')}<a class="more" href="/connect/">${t('wtf.showAll')}</a><h3 class="section-h">${t('topic.toFollow')}</h3>${topicChips(topicIndex().topics.slice(0, 16))}<p class="fe-cta"><button type="button" class="btn btn-primary" data-onboard>${esc(t('onboard.cta'))}</button></p></section>
</div>
${onboardDialog()}`
      : body;
    const header = home
      ? `<div class="topbar home-top"><div class="ht-row">${MENU_BTN}<a class="ht-logo" href="/" aria-label="${esc(t('home.logoAria'))}" data-home><span class="logo">${LOGO}</span></a><span class="ht-sp"></span></div><h1 class="sr-only">${t('home.title')}</h1><div class="feed-tabs" role="tablist" aria-label="${t('home.tabsAria')}"><button type="button" role="tab" id="tab-foryou" data-tab="foryou" aria-controls="panel-foryou" aria-selected="true"><span>${t('home.forYou')}</span></button><button type="button" role="tab" id="tab-following" data-tab="following" aria-controls="panel-following" aria-selected="false"><span>${t('home.following')}</span></button></div></div>`
      : `<div class="topbar">${MENU_BTN}<div class="tb-title"><h1>${t('home.page', { n: i + 1 })}</h1><span class="sub">${esc(t('home.pageSub'))}</span></div></div>`;
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
        title: i === 0 ? '' : t('home.pageTitle', { n: i + 1 }),
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
    return `<a class="continue" href="/p/${post.id}/">${t('post.continue')}</a>`;
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
  return { '@type': 'Person', name: t('ld.persona', { name: a.name }), url: url(`/thinkers/${a.id}/`) };
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
    body += tree ? `<h2 class="section-h">${t('post.replies')}</h2>${tree}` : `<p class="empty">${t('post.noReplies', { tradition: esc(author.tradition) })}</p>`;
    const qs = idx.quotes.get(post.id) ?? [];
    if (qs.length) body += `<h2 class="section-h">${t('post.quotedBy')}</h2><div class="feed">${qs.map((q) => postCard(q)).join('')}</div>`;

    const parentAuthor = post.inReplyTo ? P.get(idx.byId.get(post.inReplyTo).authorId) : null;
    const title = parentAuthor ? t('post.titleReply', { name: author.name, parent: parentAuthor.name, text: truncate(shownText(post), 70) }) : t('post.titleRoot', { name: author.name, text: truncate(shownText(post), 70) });
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
        description: t('post.desc', { text: shownText(post), name: author.name, handle: author.handle }),
        pathname: `/p/${post.id}/`,
        body,
        ld: [ld],
        ogType: 'article',
        aside: authorPanel(author) + whoToFollow(post.id, [author.id]),
        header: `<div class="topbar"><a class="back" href="/" aria-label="${t('nav.back')}">←</a><h1>${post.inReplyTo ? t('post.hReply') : post.type === 'thread' ? t('post.hThread') : t('post.hPost')}</h1></div>`,
      }),
      { lastmod, priority: post.inReplyTo ? 0.5 : 0.7, pack: post.id },
    );
  }
}

function authorPanel(a) {
  return `<section class="panel author-panel"><a class="wtf" href="/thinkers/${a.id}/">${avatar(a, 'sm')}<span><b${CA}>${esc(displayName(a))}</b>${kindLabel(a)}<br><span class="handle">@${esc(a.handle)}</span></span></a><p${CA}>${esc(a.headline)}</p><p class="muted">${esc(a.lifespan)} · ${cw(esc(a.region))}</p></section>`;
}

function relChips(list, label) {
  if (!list?.length) return '';
  return `<div class="rel"><h3>${label}</h3>${list
    .map((r) => {
      const o = P.get(r.id);
      return `<a class="chip" href="/thinkers/${o.id}/" title="${esc(r.why)}">${avatar(o, 'xs')}${cw(esc(displayName(o)))}</a>`;
    })
    .join('')}</div>`;
}

/** Wikipedia article in the content language (persona field wikipedia_<lang>, e.g. wikipedia_he), if any. */
const wikiLocal = (a) => a[`wikipedia_${CONTENT_LOCALE.split('-')[0]}`] || null;

/** Educational About block (who they were, key works, Wikipedia), in the content language. Opt-in per pack: site.json profile.about. */
function aboutSection(a) {
  if (!SITE_CONFIG.profile?.about) return '';
  const works = (a.key_works ?? []).slice(0, 6).map((w) => `<li${CA}>${esc(w.title)}${w.year ? ` (${esc(w.year)})` : ''}</li>`).join('');
  const wiki = wikiLocal(a) || a.wikipedia;
  if (!a.background && !works && !wiki) return '';
  return `<section class="p-about"><h2>${t('profile.about')}</h2>${a.background ? `<p${CA}>${esc(a.background)}</p>` : ''}${works ? `<h3>${t('profile.works')}</h3><ul>${works}</ul>` : ''}${wiki ? `<p><a href="${esc(wiki)}" rel="noopener" target="_blank">${t('profile.wikipedia')}</a></p>` : ''}</section>`;
}

function imageCredit(a) {
  const c = a.attribution;
  if (!c) return '';
  if (!c.source) return `<p class="credit">${t('profile.image')} ${esc(c.author || t('profile.aiGenerated'))}.</p>`;
  const lic = c.licenseUrl ? `<a href="${esc(c.licenseUrl)}" rel="license noopener" target="_blank">${esc(c.license)}</a>` : esc(c.license);
  return `<p class="credit">${t('profile.image')} <a href="${esc(c.source)}" rel="noopener" target="_blank">${esc(c.title)}</a>, ${esc(c.author)}${c.date ? ` (${esc(c.date)})` : ''}. ${lic}, ${t('profile.viaCommons')}${c.modified ? `; ${esc(c.modified)}` : ''}.${c.note ? ` ${esc(c.note)}` : ''}</p>`;
}

/** schema.org Person for the real historical figure (About tab). */
function aboutLd(a) {
  const same = [...new Set([a.wikipedia, wikiLocal(a)].filter(Boolean))];
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': url(`/thinkers/${a.id}/about/#person`),
    url: url(`/thinkers/${a.id}/about/`),
    name: a.name,
    description: a.background || undefined,
    birthDate: a.birth_display || undefined,
    deathDate: a.death_display || undefined,
    homeLocation: a.region ? { '@type': 'Place', name: a.region } : undefined,
    knowsAbout: a.core_ideas?.length ? a.core_ideas : a.favorite_topics,
    image: a.avatar?.image ? url(a.avatar.image) : undefined,
    sameAs: same.length ? same : undefined,
  };
}
/**
 * Educational About tab: who the real person was, key ideas, major works, cited quotes, public-domain
 * texts, relations on the site, Wikipedia and the image credit. Only public, educational persona fields
 * are read here; the voice/behaviour fields that drive generation never reach the page.
 */
function personaAbout(a) {
  const ext = (u, label) => { const h = safeUrl(u); return h ? `<a href="${esc(h)}" rel="noopener" target="_blank">${label}</a>` : label; };
  const facts = [[t('profile.lived'), a.lifespan], [t('profile.place'), a.region], [t('profile.era'), a.era_group], [t('profile.tradition'), [a.tradition, a.school].filter(Boolean).join(' · ')]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div><dt>${k}</dt><dd${CA}>${cw(esc(v))}</dd></div>`)
    .join('');
  const ideas = (a.core_ideas ?? []).map((x) => `<li${CA}>${esc(x)}</li>`).join('');
  const works = (a.key_works ?? []).map((w) => `<li${CA}><b>${esc(w.title)}</b>${w.year ? ` (${esc(w.year)})` : ''}${w.note ? ` — ${esc(w.note)}` : ''}</li>`).join('');
  const quotes = (a.quotables ?? []).slice(0, 6).map((q) => `<blockquote class="ab-quote"><p${CA}>“${esc(q.text)}”</p>${q.context ? `<p class="muted"${CA}>${esc(q.context)}</p>` : ''}${q.citation ? `<cite>— ${q.source_url ? ext(q.source_url, esc(q.citation)) : esc(q.citation)}</cite>` : ''}</blockquote>`).join('');
  const reads = (a.sources ?? []).filter((x) => x.url && safeUrl(x.url) && x.kind !== 'internal').slice(0, 10)
    .map((x) => `<li>${ext(x.url, esc(x.title))}${x.public_domain ? ` <span class="ab-pd">${t('profile.publicDomain')}</span>` : ''}</li>`).join('');
  const phrases = (a.native_language?.phrases ?? []).slice(0, 3).map((x) => `<li><span lang="${esc(a.native_language.code ?? '')}">${esc(x.text)}</span>${x.translation ? ` — <i>${esc(x.translation)}</i>` : ''}</li>`).join('');
  const wiki = wikiLocal(a) || a.wikipedia;
  const sec = (title, inner) => (inner ? `<section><h3>${title}</h3>${inner}</section>` : '');
  return `<article class="p-about ab-page">
    <h2${CA}>${esc(t('profile.aboutName', { name: a.name }))}</h2>
    <p class="ab-note">${esc(t('profile.aboutNote', { name: a.name }))}</p>
    ${facts ? `<dl class="ab-facts">${facts}</dl>` : ''}
    ${a.background ? `<p${CA}>${esc(a.background)}</p>` : ''}
    ${sec(t('profile.ideas'), ideas && `<ul>${ideas}</ul>`)}
    ${sec(t('profile.works'), works && `<ul>${works}</ul>`)}
    ${sec(t('profile.quotes'), quotes)}
    ${sec(t('profile.read'), reads && `<ul>${reads}</ul>`)}
    ${sec(a.native_language?.name ? t('profile.ownLanguage', { lang: a.native_language.name }) : '', phrases && `<ul>${phrases}</ul>`)}
    ${relChips(a.allies, t('profile.allies'))}${relChips(a.frenemies, t('profile.frenemies'))}${relChips(a.rivals, t('profile.rivals'))}
    ${wiki ? `<p class="ab-wiki">${ext(wiki, t('profile.wikipedia'))}</p>` : ''}
  </article>${imageCredit(a)}`;
}
/** Who a persona "follows" on Taiku: allies, frenemies and rivals (with the reason), and the reverse for followers. */
function followGraph() {
  const following = new Map(personas.map((a) => [a.id, new Map()]));
  for (const a of personas) for (const r of [...(a.allies ?? []), ...(a.frenemies ?? []), ...(a.rivals ?? [])]) {
    const id = typeof r === 'string' ? r : r?.id;
    if (P.get(id) && id !== a.id && !following.get(a.id).has(id)) following.get(a.id).set(id, r?.why ?? '');
  }
  const followers = new Map(personas.map((a) => [a.id, new Map()]));
  for (const [from, list] of following) for (const [to, why] of list) followers.get(to).set(from, why);
  return { following, followers };
}

const PROFILE_TABS = [['', 'posts'], ['with_replies/', 'replies'], ['media/', 'media'], ['about/', 'about']];
function profileHeader(a, { count, back = '/thinkers/', backLabel = STR.back } = {}) {
  const full = a.avatar?.srcset?.[400] ?? a.avatar?.image;
  const av = avatar(a, 'xl');
  const banner = `<div class="banner" style="--c:${esc(a.avatar.color)}${a.avatar.banner ? `;background-image:url('${esc(a.avatar.banner)}')` : ''}"></div>`;
  const g = graph;
  return `<div class="topbar"><a class="back" href="${back}" aria-label="${esc(backLabel)}">←</a><div class="tb-title"><h1${CA}>${esc(displayName(a))}</h1><span class="sub">${t('count.posts', { n: count })}</span></div></div>
    <section class="profile">
      ${a.avatar.banner ? `<button type="button" class="banner-btn" data-zoom="${esc(a.avatar.banner)}" data-zoom-alt="${esc(STR.bannerOf(a.name))}" aria-label="${esc(STR.viewBanner)}">${banner}</button>` : banner}
      <div class="profile-top">${full ? `<button type="button" class="p-avatar-btn" data-zoom="${esc(full)}" data-zoom-alt="${esc(a.name)}" aria-label="${esc(STR.viewPhoto)}">${av}</button>` : av}${followBtn(a, 'follow')}</div>
      <h2 class="p-name">${cw(esc(displayName(a)))}${kindLabel(a)}</h2>
      <div class="handle">@${esc(a.handle)}</div>
      <p class="p-bio"${CA}>${renderText(a.bio, handleMap)}</p>
      <a class="p-about-link" href="/thinkers/${a.id}/about/">${esc(t('profile.aboutName', { name: a.name }))} →</a>
      <div class="p-meta">${a.location ? `<span>📍 ${cw(esc(a.location))}</span>` : ''}${a.x_profile?.website ? `<a href="${esc(a.x_profile.website)}" rel="nofollow noopener" target="_blank">🔗 ${esc(new URL(a.x_profile.website).hostname.replace(/^www\./, ''))}</a>` : ''}${a.x_profile?.joined ? `<span>🗓️ ${esc(a.x_profile.joined)}</span>` : ''}</div>
      <div class="p-stats"><a href="/thinkers/${a.id}/following/"><b>${compactNumber(Math.max(a.x_profile?.following ?? 0, g.following.get(a.id).size))}</b> ${STR.following}</a><a href="/thinkers/${a.id}/followers/"><b data-followers="${esc(a.id)}" data-count="${a.x_profile?.followers ?? 0}">${compactNumber(a.x_profile?.followers ?? 0)}</b> ${STR.followers}</a></div>
    </section>`;
}

function profileTabs(a, cur) {
  return `<nav class="p-tabs" aria-label="${esc(STR.profileSections)}">${PROFILE_TABS.map(([sub, key]) => `<a href="/thinkers/${a.id}/${sub}"${key === cur ? ' aria-current="page"' : ''}>${STR.tabs[key]}</a>`).join('')}</nav>`;
}

let graph;
function profilePages() {
  graph = followGraph();
  for (const a of personas) {
    const mine = posts.filter((p) => p.authorId === a.id).sort(newestFirst);
    const card = (p) => postCard(p, { showReplying: true, participants: !p.inReplyTo, threadLink: true });
    const lists = {
      posts: mine.filter((p) => !p.inReplyTo),
      replies: mine,
      media: mine.filter((p) => (mediaByPost.get(p.id) ?? []).some((m) => VISUAL.has(m.kind) && m.src) || (mediaByPost.get(p.id) ?? []).some((m) => m.kind === 'video')),
    };
    const empty = {
      posts: STR.emptyPosts(a.handle),
      replies: STR.emptyPosts(a.handle),
      media: STR.emptyMedia(a.handle),
    };
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      url: url(`/thinkers/${a.id}/`),
      name: t('profile.ldName', { name: a.name }),
      description: t('profile.ldDesc', { headline: a.headline, name: a.name }),
      mainEntity: {
        '@type': 'Person',
        name: a.name,
        alternateName: `@${a.handle}`,
        description: a.bio,
        birthDate: a.birth_display || undefined,
        deathDate: a.death_display || undefined,
        knowsAbout: a.favorite_topics,
        sameAs: [a.wikipedia, wikiLocal(a)].filter(Boolean).length ? [...new Set([a.wikipedia, wikiLocal(a)].filter(Boolean))] : undefined,
      },
    };
    const header = profileHeader(a, { count: mine.length });
    const aside = whoToFollow(a.id, [a.id]) + trending();
    for (const [sub, key] of PROFILE_TABS) {
      const list = lists[key] ?? [];
      const about = key === 'about';
      const feed = profileTabs(a, key) + (about ? personaAbout(a) : list.length ? `<div class="feed">${list.map(card).join('')}</div>` : `<div class="p-empty"><h2>${esc(empty[key].title)}</h2><p>${esc(empty[key].body)}</p></div>`);
      const main = key === 'posts';
      write(
        `/thinkers/${a.id}/${sub}`,
        layout({
          title: main ? t('profile.title', { name: a.name, handle: a.handle }) : about ? t('profile.aboutTitle', { name: a.name, lifespan: a.lifespan ?? '' }) : `${STR.tabTitle[key]} · ${a.name} (@${a.handle})`,
          description: about ? truncate(a.background || `${a.headline} ${a.bio}`, 300) : `${a.headline} ${a.bio}`,
          pathname: `/thinkers/${a.id}/${sub}`,
          body: (main ? aboutSection(a) + imageCredit(a) : '') + feed,
          ld: main ? [ld] : about ? [aboutLd(a)] : [],
          ogType: 'profile',
          header,
          aside,
          noindex: !main && !about,
        }),
        main ? { lastmod: mine[0]?.createdAt ?? BUILD_TIME, priority: 0.8 } : about ? { priority: 0.7 } : { inSitemap: false },
      );
    }
    // The old private Likes tab moved to About; keep shared links working.
    write(`/thinkers/${a.id}/likes/`, `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><link rel="canonical" href="${url(`/thinkers/${a.id}/about/`)}"><meta http-equiv="refresh" content="0; url=/thinkers/${a.id}/about/"><a href="/thinkers/${a.id}/about/">${esc(t('profile.aboutName', { name: a.name }))}</a>`, { inSitemap: false });
    for (const kind of ['following', 'followers']) {
      const rel = graph[kind].get(a.id);
      const tabs = `<nav class="p-tabs" aria-label="${esc(STR.followLists)}">${['followers', 'following'].map((k) => `<a href="/thinkers/${a.id}/${k}/"${k === kind ? ' aria-current="page"' : ''}>${STR[k]}</a>`).join('')}</nav>`;
      const rows = [...rel].map(([id, why]) => { const p = P.get(id); return `<div class="wtf-wide">${wtfRow(p)}<p class="wtf-bio"${CA}>${esc(why || truncate(p.bio, 120))}</p></div>`; }).join('');
      const note = `<p class="fl-note">${esc(STR.followNote(kind, a, compactNumber(kind === 'followers' ? a.x_profile?.followers ?? 0 : a.x_profile?.following ?? 0)))}</p>`;
      write(
        `/thinkers/${a.id}/${kind}/`,
        layout({
          title: `${STR[kind]} · ${a.name} (@${a.handle})`,
          description: t(kind === 'followers' ? 'follow.descFollowers' : 'follow.descFollowing', { name: a.name }),
          pathname: `/thinkers/${a.id}/${kind}/`,
          header: `<div class="topbar"><a class="back" href="/thinkers/${a.id}/" aria-label="${esc(STR.back)}">←</a><div class="tb-title"><h1${CA}>${esc(displayName(a))}</h1><span class="sub">@${esc(a.handle)}</span></div></div>${tabs}`,
          body: rows ? rows + note : `<div class="p-empty"><h2>${esc(STR.noFollows(kind, a.handle))}</h2></div>`,
          aside,
          noindex: true,
        }),
        { inSitemap: false },
      );
    }
  }
}
function thinkersPage() {
  const groups = new Map();
  for (const a of personas) {
    const k = a.era_group || t('thinkers.group');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const body = [...groups.entries()]
    .map(
      ([g, list]) => `<h2 class="section-h">${esc(g)}</h2><div class="thinker-grid">${list
        .map(
          (a) => `<a class="thinker-card" href="/thinkers/${a.id}/">${avatar(a, 'md')}<span class="tc-body"><b${CA}>${esc(displayName(a))}</b>${kindLabel(a)} <span class="handle">@${esc(a.handle)}</span><span class="tc-meta"${CA}>${esc(a.location ?? '')}</span><span class="tc-head"${CA}>${esc(a.bio)}</span></span></a>`,
        )
        .join('')}</div>`,
    )
    .join('');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: t('thinkers.ldName'),
    itemListElement: personas.map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: url(`/thinkers/${a.id}/`), name: a.name })),
  };
  write(
    '/thinkers/',
    layout({
      title: t('thinkers.title'),
      description: t('thinkers.desc', { names: thinkers.map((p) => p.name).join(', ') }),
      pathname: '/thinkers/',
      body: `${t('thinkers.intro') ? `<p class="intro">${t('thinkers.intro')}</p>` : ''}${body}`,
      ld: [ld],
      aside: trending(),
    }),
    { priority: 0.9 },
  );
}

function tagPages() {
  const tags = new Map();
  const add = (t, p) => {
    const s = slugify(t);
    if (!s) return;
    if (!tags.has(s)) tags.set(s, []);
    if (p && !tags.get(s).includes(p)) tags.get(s).push(p);
  };
  // renderText links every inline #hashtag, so each one needs a page (bio-only tags get an empty state).
  const inline = (text) => [...String(text ?? '').matchAll(/(^|[^\p{L}\p{M}\p{N}_&/])#(\p{L}[\p{L}\p{M}\p{N}_]{1,40})/gu)].map((m) => m[2]);
  for (const p of posts) for (const tag of [...(p.tags ?? []), ...inline(p.text)]) add(tag, p);
  for (const a of personas) for (const tag of inline(a.bio)) add(tag);
  for (const [tag, list] of tags) {
    list.sort(newestFirst);
    write(
      `/tags/${tag}/`,
      layout({
        title: `#${tag}`,
        description: t('tag.desc', { tag, names: [...new Set(list.map((p) => P.get(p.authorId).name))].slice(0, 6).join(', ') }),
        pathname: `/tags/${tag}/`,
        noindex: !list.length,
        body: list.length ? `<div class="feed">${dedupeStories(list).map((p) => postCard(p, { showReplying: true, participants: !p.inReplyTo })).join('')}</div>` : `<div class="p-empty"><h2>${esc(STR.noTagPosts(tag))}</h2></div>`,
        aside: trending(),
      }),
      list.length ? { lastmod: list[0].createdAt, priority: 0.4 } : { inSitemap: false },
    );
  }
  return tags.size;
}

function aboutPage() {
  const body = `<article class="prose">
${t('about.body', { home: url('/') })}</article>`;
  write('/about/', layout({ title: t('about.title'), description: t('about.desc'), pathname: '/about/', body, aside: whoToFollow('about') }), { priority: 0.6 });
}

function notFound() {
  write('/404.html', layout({ title: t('notFound.title'), description: t('notFound.desc'), pathname: '/404.html', noindex: true, body: `<p class="empty">${t('notFound.body')}</p>` }), { inSitemap: false });
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
      const extra = [p.topic?.title, p.news?.title, ...(p.tags ?? []).map((x) => `#${x}`), ...items.map((m) => m.alt ?? m.title ?? '')];
      const m = items.some((x) => VISUAL.has(x.kind) && x.src) ? 2 : items.length || p.poll || textPoll(p) ? 1 : 0;
      rows.push([p.id, p.authorId, fold([p.text, ...extra].filter(Boolean).join(' ')), Date.parse(p.createdAt), stats(p).likes, m, i / SEARCH_SHARD]);
      shard[p.id] = postCard(p, { showReplying: true, noId: true });
    }
    fs.writeFileSync(path.join(dir, `${i / SEARCH_SHARD}.json`), JSON.stringify(shard));
  }
  fs.writeFileSync(path.join(OUT, 'data', 'search.json'), JSON.stringify({ v: BUILD_ID, posts: rows }));
}

const SEARCH_TABS = ['top', 'live', 'user', 'media'].map((f) => [f, t(`search.${f}`)]);
function searchBox(cls = '') {
  return `<form class="search-form${cls ? ` ${cls}` : ''}" action="/search/" method="get" role="search"><label class="sbox">${ICONS.search}<input type="search" name="q" placeholder="${esc(t('search.placeholder'))}" aria-label="${esc(t('search.aria'))}" autocomplete="off" enterkeyhint="search" maxlength="120"></label></form>`;
}
function searchPage() {
  const header = `<div class="topbar search-top"><div class="st-row">${MENU_BTN}${searchBox('search-main')}</div><h1 class="sr-only">${t('search.title')}</h1><div class="feed-tabs search-tabs" role="tablist" aria-label="${t('search.resultsAria')}" hidden>${SEARCH_TABS.map(([f, l], i) => `<button type="button" role="tab" data-f="${f}" aria-selected="${i === 0}" aria-controls="search-results"${i ? ' tabindex="-1"' : ''}><span>${l}</span></button>`).join('')}</div></div>`;
  const body = `<div class="search-results" id="search-results" role="tabpanel" aria-live="polite" aria-busy="false"></div>
<div class="search-explore">${trending()}${whoToFollow('search')}</div>`;
  write('/search/', layout({ title: t('search.title'), description: t('search.desc'), pathname: '/search/', noindex: true, header, body, aside: whoToFollow('search-aside') }), { inSitemap: false });
}
/** PWA: offline fallback page and a service worker whose cache name follows the build. */
function pwa() {
  write('/offline.html', layout({ title: t('offline.title'), description: t('offline.desc'), pathname: '/offline.html', noindex: true, body: `<div class="offline-msg"><span class="logo">${LOGO}</span><h2>${t('offline.heading')}</h2><p>${t('offline.text')}</p><a class="btn" href="/">${t('offline.retry')}</a></div>` }), { inSitemap: false });
  const shell = ['/offline.html', `/styles.css?v=${assetVersion}`, `/rank.js?v=${assetVersion}`, `/app.js?v=${assetVersion}`, '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']
    .filter((u) => !/^\/(favicon|manifest|icons)/.test(u) || fs.existsSync(publicFile(u.slice(1))));
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8').replace("'__VERSION__'", JSON.stringify(BUILD_ID)).replace('__SHELL__', JSON.stringify(shell));
  fs.writeFileSync(path.join(OUT, 'sw.js'), sw);
}

/** Client-side Following timeline + hovercards: per-author pre-rendered cards and a compact persona index under /data/. */
function followItem(p) {
  const parent = p.inReplyTo ? idx.byId.get(p.inReplyTo) : null;
  const h = parent
    ? `<div class="conv">${postCard(parent, { connector: true, noId: true })}${postCard(p, { noId: true })}</div>`
    : postCard(p, { participants: true, threadLink: true, noId: true });
  return { id: p.id, k: storyKey(p), a: p.authorId, t: p.createdAt, h };
}
function followData() {
  const dir = path.join(OUT, 'data', 'u');
  fs.mkdirSync(dir, { recursive: true });
  const byAuthor = new Map(personas.map((a) => [a.id, []]));
  for (const p of posts) if (!(p.type === 'thread' && p.inReplyTo)) byAuthor.get(p.authorId)?.push(p);
  for (const [id, list] of byAuthor) {
    const items = list.sort(newestFirst).slice(0, 25).map(followItem);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ v: BUILD_ID, posts: items }));
  }
  // followed topics: same shape as /data/u, keyed by topic key
  const { all, topics, trends, keysOf } = topicIndex();
  const tdir = path.join(OUT, 'data', 't');
  fs.mkdirSync(tdir, { recursive: true });
  const followable = new Set([...topics, ...trends].map((e) => e.k));
  for (const e of all.values()) {
    if (e.posts.length < 2 && !followable.has(e.k)) continue;
    fs.writeFileSync(path.join(tdir, `${e.k}.json`), JSON.stringify({ v: BUILD_ID, posts: e.posts.slice(0, 25).map(followItem) }));
  }
  fs.writeFileSync(
    path.join(OUT, 'data', 'topics.json'),
    JSON.stringify({ v: BUILD_ID, topics: topics.map((e) => [e.k, e.label, e.posts.length]), trends: trends.map((e, i) => [e.k, e.label, trendMeta(e, i), e.recent, topicHref(e)]), labels: Object.fromEntries([...all.values()].filter((e) => followable.has(e.k) || e.posts.length >= 2).map((e) => [e.k, e.label])) }),
  );
  // similarity signals for "Who to follow": topics each persona posts about and who they talk to
  const tp = new Map(personas.map((a) => [a.id, new Map()]));
  const co = new Map(personas.map((a) => [a.id, new Map()]));
  const bump = (m, k, n = 1) => m?.set(k, (m.get(k) ?? 0) + n);
  for (const p of posts) {
    for (const k of keysOf.get(p.id) ?? []) if (!k.startsWith('n_')) bump(tp.get(p.authorId), k);
    const other = p.inReplyTo ? idx.byId.get(p.inReplyTo)?.authorId : p.quoteOf ? idx.byId.get(p.quoteOf)?.authorId : null;
    if (other && other !== p.authorId) { bump(co.get(p.authorId), other); bump(co.get(other), p.authorId, 0.5); }
  }
  const top6 = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([k]) => k);
  const rel = (a) => [...new Set(['allies', 'rivals', 'frenemies'].flatMap((r) => (a.relationships?.[r] ?? a[r] ?? []).map((x) => (typeof x === 'string' ? x : x?.id))).filter((id) => id && P.has(id) && id !== a.id))];
  const index = Object.fromEntries(
    personas.map((a) => [a.id, { n: displayName(a), h: a.handle, b: truncate(a.bio ?? '', 160), a: a.avatar?.srcset?.[96] ?? a.avatar?.image ?? '', c: a.avatar?.color ?? '#64748b', fr: a.x_profile?.followers ?? 0, fg: a.x_profile?.following ?? 0, k: a.kind, tp: top6(tp.get(a.id)), co: top6(co.get(a.id)), rel: rel(a) }]),
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
      items.push({ id: p.id, a: p.authorId, t: Date.parse(p.createdAt), l: s.likes, r: s.replies, rt: s.reposts + s.quotes, m: visual ? 1 : 0, s: i / FY_SHARD, g: topicIndex().keysOf.get(p.id) ?? [], ...(src !== p ? { k: src.id } : {}) });
      const kids = (idx.children.get(p.id) ?? []).filter((k) => k.authorId !== p.authorId || k.type !== 'thread');
      const top = kids.slice().sort((a, b) => stats(b).likes - stats(a).likes)[0];
      if (top) {
        const more = idx.descendants(p).length - 1;
        shard[p.id] = `<div class="conv">${postCard(p, { connector: true, threadLink: true, noId: true })}${postCard(top, { noId: true })}${more > 0 ? `<a class="conv-more" href="/p/${p.id}/">${t('post.convMore', { n: more })}</a>` : ''}</div>`;
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
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(t('rss.title'))}</title><link>${url('/')}</link><description>${esc(SITE.description)}</description><language>${esc(CONTENT_LOCALE)}</language>${items.join('')}</channel></rss>\n`,
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
if (process.env.POST_PAGES !== 'static') {
  postPack = new PostPack(OUT, layout({ title: '@@S0@@', description: '@@S1@@', pathname: '/p/@@S2@@/', body: '@@S3@@', ld: ['@@S4@@'], ogType: 'article', aside: '@@S5@@', header: '@@S6@@' }), BUILD_ID);
}
postPages();
profilePages();
thinkersPage();
const tagCount = tagPages();
aboutPage();
notFound();
searchPage();
connectPage();
mePage();
pwa();
followData();
forYouData();
searchData();
rss();
seoFiles();
const packed = postPack?.finish();
fs.mkdirSync(path.join(OUT, '_p'), { recursive: true });
fs.writeFileSync(path.join(OUT, '_p', 'polls.json'), JSON.stringify(POLL_INDEX));
if (packed && packed.count < posts.length) console.warn(`post pack: ${posts.length - packed.count} page(s) didn't fit the template; written as static files`);
console.log(`Built ${sitemap.length} pages → ${path.relative(ROOT, OUT)}/ (${thinkers.length} thinkers, ${personas.length - thinkers.length} parody/news, ${posts.length} posts, ${roots.length} top-level, ${tagCount} tags, ${mediaOut.written} rendered media${packed ? `, ${packed.count} post pages in ${packed.files} pack files` : ''})`);
