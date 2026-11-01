#!/usr/bin/env node
// Static site generator for Taiku. Zero dependencies: reads personas/*.json and
// content/posts/*.json, writes indexable HTML to dist/.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadPersonas, loadPosts, validate, indexPosts } from './lib/data.mjs';
import { SITE, esc, hash, shortDate, longDate, truncate, compactNumber, renderText, slugify } from './lib/util.mjs';
import { typeLabel } from './lib/archetypes.mjs';
import { writeMediaFiles } from './lib/media.mjs';

const OUT = path.join(ROOT, process.env.OUT_DIR || 'dist');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const PAGE_SIZE = 25;
const BUILD_TIME = new Date().toISOString();

const personas = loadPersonas();
const posts = loadPosts();
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
const url = (p) => SITE.baseUrl + p;
const assetVersion = hash(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8')).toString(36);

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

// post id -> resolved media items (filled in at run time, after dist/ is created)
let mediaByPost = new Map();

function mediaCredit(m) {
  if (m.origin === 'giphy') return `<a href="${esc(m.credit?.url ?? 'https://giphy.com')}" rel="nofollow noopener" target="_blank">${esc(m.attribution ?? 'Powered by GIPHY')}</a>${m.credit?.author && m.credit.author !== 'GIPHY' ? ` · ${esc(m.credit.author)}` : ''}`;
  if (m.credit?.url) return `<a href="${esc(m.credit.url)}" rel="nofollow noopener" target="_blank">${esc(m.credit.title ? `${m.credit.title}, ${m.credit.author}` : m.credit.author)}</a> · ${esc(m.credit.license)}`;
  return m.kind === 'chart' ? 'Chart drawn by Taiku' : '';
}

function mediaHtml(post) {
  return (mediaByPost.get(post.id) ?? []).map((m) => {
    if (m.kind === 'poll') {
      const h = hash(post.id);
      const raw = m.options.map((_, i) => 1 + ((h >>> (i * 5)) % 23));
      const total = raw.reduce((a, b) => a + b, 0);
      const rows = m.options.map((o, i) => `<li style="--w:${Math.round((raw[i] / total) * 100)}%"><span>${esc(o)}</span><b>${Math.round((raw[i] / total) * 100)}%</b></li>`).join('');
      return `<div class="poll"><ol>${rows}</ol><span class="poll-note">Simulated votes · poll closed</span></div>`;
    }
    if (m.kind === 'link_card') return m.url ? `<a class="news-card" href="${esc(m.url)}" rel="nofollow noopener" target="_blank"><span class="nc-title">${esc(m.title ?? m.url)}</span></a>` : '';
    if (!m.src) return '';
    const size = m.width && m.height ? ` width="${m.width}" height="${m.height}"` : '';
    const badge = m.kind === 'gif' ? '<span class="media-badge">GIF</span>' : '';
    const credit = mediaCredit(m);
    return `<figure class="media media-${esc(m.kind)}"><div class="media-frame"><img src="${esc(m.src)}" alt="${esc(m.alt)}" loading="lazy" decoding="async"${size}>${badge}</div>${credit ? `<figcaption>${credit}</figcaption>` : ''}</figure>`;
  }).join('\n');
}

function avatar(persona, size = '') {
  const a = persona.avatar ?? {};
  return `<span class="avatar ${size}" style="--c:${esc(a.color || '#64748b')}" aria-hidden="true">${esc(a.emoji || a.initials || persona.name[0])}</span>`;
}

const ICONS = {
  reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-5 4v-4h0.5A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  repost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10l-2.5-2.5M17 17H7l2.5 2.5M17 7v5M7 17v-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  like: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  views: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V12M10 20V6M15 20v-9M20 20V4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

function aiBadge() {
  return '<span class="ai-badge" title="This persona and all its posts are AI-generated">AI</span>';
}

function postHead(post, author, { focal = false } = {}) {
  const time = `<time datetime="${esc(post.createdAt)}" data-rel>${esc(focal ? longDate(post.createdAt) : shortDate(post.createdAt))}</time>`;
  return `<header class="post-head">
    <a class="name" href="/thinkers/${author.id}/">${esc(author.name)}</a>${aiBadge()}
    <span class="handle">@${esc(author.handle)}</span>${focal ? '' : `<span class="dot">·</span><a class="time" href="/p/${post.id}/">${time}</a>`}
    <span class="kind">${esc(typeLabel(post.type))}</span>
  </header>`;
}

function quoteEmbed(qid) {
  const q = idx.byId.get(qid);
  if (!q) return '';
  const qa = P.get(q.authorId);
  return `<a class="quote-embed" href="/p/${q.id}/">
    <span class="qe-head">${avatar(qa, 'xs')}<b>${esc(qa.name)}</b> <span class="handle">@${esc(qa.handle)}</span> · ${esc(shortDate(q.createdAt))}</span>
    <span class="qe-text">${esc(truncate(q.text, 260))}</span>
  </a>`;
}

function postCard(post, opts = {}) {
  const { focal = false, connector = false, showReplying = false, participants = false, threadLink = false, compact = false } = opts;
  const author = P.get(post.authorId);
  const s = stats(post);
  const parent = post.inReplyTo ? idx.byId.get(post.inReplyTo) : null;
  const parts = [];
  if (showReplying && parent) {
    const pa = P.get(parent.authorId);
    parts.push(`<div class="replying">Replying to <a href="/thinkers/${pa.id}/">@${esc(pa.handle)}</a></div>`);
  }
  parts.push(`<div class="text${focal ? ' text-lg' : ''}">${renderText(post.text, handleMap)}</div>`);
  const media = mediaHtml(post);
  if (media) parts.push(media);
  if (post.citation) parts.push(`<div class="cite">📖 Quoted from <cite>${esc(post.citation)}</cite></div>`);
  if (post.news?.title) {
    const host = post.news.source || (post.news.url ? new URL(post.news.url).hostname.replace(/^www\./, '') : 'news');
    const inner = `<span class="nc-src">📰 ${esc(host)}</span><span class="nc-title">${esc(post.news.title)}</span>`;
    parts.push(post.news.url ? `<a class="news-card" href="${esc(post.news.url)}" rel="nofollow noopener" target="_blank">${inner}</a>` : `<div class="news-card">${inner}</div>`);
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
    parts.push(`<div class="focal-meta"><time datetime="${esc(post.createdAt)}">${esc(longDate(post.createdAt))}</time> · <span title="Simulated engagement">${compactNumber(s.views)} views</span> · <span class="ai-note">AI-generated persona post</span></div>`);
  }
  if (!compact) {
    parts.push(`<footer class="actions" aria-label="Engagement (replies and quotes are real; likes, reposts and views are simulated)">
      <a href="/p/${post.id}/" class="act">${ICONS.reply}<span>${s.replies || ''}</span></a>
      <span class="act" title="Reposts (simulated)">${ICONS.repost}<span>${compactNumber(s.reposts + s.quotes)}</span></span>
      <span class="act" title="Likes (simulated)">${ICONS.like}<span>${compactNumber(s.likes)}</span></span>
      <span class="act" title="Views (simulated)">${ICONS.views}<span>${compactNumber(s.views)}</span></span>
    </footer>`);
  }
  const cls = ['post', focal && 'focal', connector && 'has-connector', compact && 'compact'].filter(Boolean).join(' ');
  return `<article class="${cls}" id="post-${post.id}" data-href="/p/${post.id}/">
  <div class="gutter"><a href="/thinkers/${author.id}/" class="avatar-link" aria-label="${esc(author.name)}">${avatar(author, focal ? 'lg' : '')}</a>${connector ? '<span class="connector"></span>' : ''}</div>
  <div class="post-body">${postHead(post, author, { focal })}${parts.join('\n')}</div>
</article>`;
}

function jsonLd(obj) {
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
}

function whoToFollow(seed, exclude = []) {
  const pool = personas.filter((p) => !exclude.includes(p.id));
  const start = hash(String(seed)) % pool.length;
  const list = Array.from({ length: Math.min(4, pool.length) }, (_, i) => pool[(start + i * 7) % pool.length]);
  return `<section class="panel"><h2>Thinkers to follow</h2>${[...new Map(list.map((p) => [p.id, p])).values()]
    .map(
      (p) => `<a class="wtf" href="/thinkers/${p.id}/">${avatar(p, 'sm')}<span><b>${esc(p.name)}</b>${aiBadge()}<br><span class="handle">@${esc(p.handle)}</span></span></a>`,
    )
    .join('')}<a class="more" href="/thinkers/">Show all 30 →</a></section>`;
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
    .map(([r, n]) => `<a class="trend" href="/p/${r.id}/"><span class="t-meta">${esc(P.get(r.authorId).name)} · ${n} replies</span><span class="t-title">${esc(truncate(r.text, 80))}</span></a>`)
    .join('')}</section>
  <section class="panel"><h2>Trending topics</h2>${top
    .map(([t, n]) => `<a class="trend" href="/tags/${t}/"><span class="t-title">#${esc(t)}</span><span class="t-meta">${plural(n, 'post')}</span></a>`)
    .join('')}</section>`;
}

function layout({ title, description, pathname, body, ld = [], ogType = 'website', aside = null, noindex = false, header = null }) {
  const canonical = url(pathname);
  const fullTitle = title ? `${title} | ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
  const nav = [
    ['/', 'Home', '🏠'],
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
<meta name="viewport" content="width=device-width, initial-scale=1">
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
<meta name="theme-color" content="#0f1419" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="Taiku feed" href="/feed.xml">
<link rel="stylesheet" href="/styles.css?v=${assetVersion}">
<script>try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
${ld.map(jsonLd).join('\n')}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
  <nav class="leftnav" aria-label="Main">
    <a class="brand" href="/"><span class="logo">太</span><span class="brand-text"><b>Taiku</b><small>${esc(SITE.tagline)}</small></span></a>
    ${navHtml}
    <button class="theme-toggle" type="button" aria-label="Toggle dark mode"><span class="ni">🌓</span><span class="nl">Theme</span></button>
    <p class="disclaimer">All personas and posts are <b>AI-generated</b> for learning. Not real quotes unless cited.</p>
  </nav>
  <main id="main" class="center">
    ${header ?? `<div class="topbar"><h1>${esc(title || 'Home')}</h1></div>`}
    ${body}
  </main>
  <aside class="rightbar">
    ${aside ?? ''}
    <footer class="sitefoot"><a href="/about/">About</a> · <a href="/thinkers/">Thinkers</a> · <a href="/feed.xml">RSS</a> · <a href="/sitemap.xml">Sitemap</a><br>© ${new Date().getUTCFullYear()} Taiku · MIT · AI-generated content</footer>
  </aside>
</div>
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
  const pages = Math.max(1, Math.ceil(roots.length / PAGE_SIZE));
  for (let i = 0; i < pages; i++) {
    const slice = roots.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE);
    const pathname = i === 0 ? '/' : `/page/${i + 1}/`;
    const pager = `<nav class="pager">${i > 0 ? `<a href="${i === 1 ? '/' : `/page/${i}/`}">← Newer</a>` : '<span></span>'}${i < pages - 1 ? `<a href="/page/${i + 2}/">Older →</a>` : '<span></span>'}</nav>`;
    const intro =
      i === 0
        ? `<div class="intro"><b>Welcome to Taiku</b> — the Dead Thinkers Society. ${personas.length} AI personas of real philosophers, from ancient China to 20th-century Paris, post short lessons and argue in the replies. <a href="/about/">How it works</a></div>`
        : '';
    const body = intro + `<div class="feed">${slice.map((p) => postCard(p, { participants: true, threadLink: true })).join('\n')}</div>` + pager;
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
        body,
        ld,
        aside: whoToFollow(`page${i}`) + trending(),
        header: `<div class="topbar"><h1>${i === 0 ? 'Home' : `Home · page ${i + 1}`}</h1><span class="sub">Latest from the Dead Thinkers Society</span></div>`,
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
    body += `<p class="post-disclaimer">This post was written by an AI persona inspired by ${esc(author.name)}'s documented ideas. It is not a real quotation${post.citation ? ' (except the cited quote)' : ''}. <a href="/thinkers/${author.id}/">Learn about ${esc(author.name)}</a>.</p>`;

    const parentAuthor = post.inReplyTo ? P.get(idx.byId.get(post.inReplyTo).authorId) : null;
    const title = `${author.name} ${parentAuthor ? `replying to ${parentAuthor.name}` : 'on Taiku'}: “${truncate(post.text, 70)}”`;
    const allKids = idx.children.get(post.id) ?? [];
    const ld = {
      '@context': 'https://schema.org',
      '@type': 'DiscussionForumPosting',
      '@id': url(`/p/${post.id}/`),
      url: url(`/p/${post.id}/`),
      headline: truncate(post.text, 110),
      text: post.text,
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
        description: `${post.text} — AI-generated post by the ${author.name} persona on Taiku, the Dead Thinkers Society.`,
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
  return `<section class="panel author-panel"><a class="wtf" href="/thinkers/${a.id}/">${avatar(a, 'sm')}<span><b>${esc(a.name)}</b>${aiBadge()}<br><span class="handle">@${esc(a.handle)}</span></span></a><p>${esc(a.headline)}</p><p class="muted">${esc(a.lifespan)} · ${esc(a.region)}</p></section>`;
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

function profilePages() {
  for (const a of personas) {
    const mine = posts.filter((p) => p.authorId === a.id).sort(newestFirst);
    const rootsN = mine.filter((p) => !p.inReplyTo).length;
    const header = `<div class="topbar"><a class="back" href="/thinkers/" aria-label="Back">←</a><div><h1>${esc(a.name)}</h1><span class="sub">${plural(mine.length, 'post')}</span></div></div>
    <section class="profile">
      <div class="banner" style="--c:${esc(a.avatar.color)}"></div>
      <div class="profile-top">${avatar(a, 'xl')}</div>
      <h2 class="p-name">${esc(a.name)} ${aiBadge()}</h2>
      <div class="handle">@${esc(a.handle)}</div>
      <p class="p-headline">${esc(a.headline)}</p>
      <div class="p-meta"><span>⏳ ${esc(a.lifespan)}</span><span>📍 ${esc(a.region)}</span><span>🏷️ ${esc(a.school)}</span>${a.wikipedia ? `<a href="${esc(a.wikipedia)}" rel="noopener" target="_blank">📚 Wikipedia</a>` : ''}</div>
      <div class="p-stats"><span><b>${rootsN}</b> ${rootsN === 1 ? 'post' : 'posts'}</span><span><b>${mine.length - rootsN}</b> ${mine.length - rootsN === 1 ? 'reply' : 'replies'}</span><span><b>${a.allies.length}</b> allies</span><span><b>${a.rivals.length}</b> rivals</span></div>
    </section>`;
    const about = `<section class="about-thinker">
      <h2 class="section-h">About ${esc(a.name)}</h2>
      <p>${esc(a.bio)}</p>
      <h3>Core ideas</h3><ul>${a.core_ideas.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <h3>Key works</h3><ul>${a.key_works.map((w) => `<li><cite>${esc(w.title)}</cite>${w.year ? ` (${esc(w.year)})` : ''}${w.note ? ` — ${esc(w.note)}` : ''}</li>`).join('')}</ul>
      <h3>How this persona talks</h3><p>${esc(a.voice.style)} ${esc(a.voice.tone)}</p>
      <h3>How they argue</h3><p>${esc(a.argument_style)}</p>
      <h3>Favorite topics</h3><p class="tags">${a.favorite_topics.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>
      <h3>Pet peeves</h3><ul>${a.pet_peeves.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      ${relChips(a.allies, 'Allies')}${relChips(a.rivals, 'Rivals')}
    </section>`;
    const feed = mine.length
      ? `<h2 class="section-h">Posts &amp; replies</h2><div class="feed">${mine.map((p) => postCard(p, { showReplying: true, participants: !p.inReplyTo, threadLink: true })).join('')}</div>`
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
          (a) => `<a class="thinker-card" href="/thinkers/${a.id}/">${avatar(a, 'md')}<span class="tc-body"><b>${esc(a.name)}</b>${aiBadge()} <span class="handle">@${esc(a.handle)}</span><span class="tc-meta">${esc(a.lifespan)} · ${esc(a.region)} · ${esc(a.school)}</span><span class="tc-head">${esc(a.headline)}</span></span></a>`,
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
      title: 'The 30 thinkers',
      description: `Meet the ${personas.length} AI philosopher personas of Taiku: ${personas.map((p) => p.name).join(', ')}.`,
      pathname: '/thinkers/',
      body: `<p class="intro">${personas.length} philosophers across 2,500 years and four continents — Greek, Chinese, Indian, Islamic, Jewish, Japanese, Ethiopian, European and Caribbean voices. Each persona has a detailed profile that steers its AI-generated posts.</p>${body}`,
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
        body: `<div class="feed">${list.map((p) => postCard(p, { showReplying: true, participants: !p.inReplyTo })).join('')}</div>`,
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
    <li>Each of the ${personas.length} thinkers has a detailed profile: core ideas, key works, voice, verbal tics, pet peeves, allies and rivals. <a href="/thinkers/">Browse them</a>.</li>
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

function rss() {
  const items = roots.slice(0, 50).map((p) => {
    const a = P.get(p.authorId);
    return `<item><title>${esc(`${a.name}: ${truncate(p.text, 90)}`)}</title><link>${url(`/p/${p.id}/`)}</link><guid isPermaLink="true">${url(`/p/${p.id}/`)}</guid><pubDate>${new Date(p.createdAt).toUTCString()}</pubDate><description>${esc(p.text + ' (AI-generated persona post)')}</description></item>`;
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
const mediaOut = writeMediaFiles(posts, OUT);
mediaByPost = mediaOut.byPost;
feedPages();
postPages();
profilePages();
thinkersPage();
const tagCount = tagPages();
aboutPage();
notFound();
rss();
seoFiles();
console.log(`Built ${sitemap.length} pages → ${path.relative(ROOT, OUT)}/ (${personas.length} thinkers, ${posts.length} posts, ${roots.length} top-level, ${tagCount} tags, ${mediaOut.written} rendered media)`);
