import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

export const MAX_POST_DRAFTS = 5;
export const MAX_COMMENT_DRAFTS = 3;
export const COMMENT_LOOKBACK_DAYS = 7;

const NON_STANDALONE_TYPES = new Set(['meme', 'news_wire', 'poll', 'retaik', 'thread']);
const X_STATUS = /^https:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})(?:[/?#]|$)/;
const cleanDate = (date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
};
const textKey = (text) => createHash('sha256').update(String(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
const isEnglish = (text) => /\p{Script=Latin}/u.test(text) && [...text].every((char) => !/\p{L}/u.test(char) || /\p{Script=Latin}/u.test(char));
const withinLimit = (text) => text.length <= 280;
const isRoot = (post) => !post.parentId && !post.inReplyTo;

function usableText(post) {
  const text = typeof post?.text === 'string' ? post.text : '';
  return text.trim().length >= 35 && withinLimit(text) && isEnglish(text) && !/[⟦⟧]/u.test(text) ? text : null;
}

function readPosts(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const posts = Array.isArray(raw) ? raw : raw?.posts;
  if (!Array.isArray(posts)) throw new Error(`invalid Taiku post file: ${file} has no posts array`);
  return posts;
}

function selectDrafts(candidates, limit, seen) {
  const authors = new Set();
  const selected = [];
  for (const candidate of candidates) {
    const author = String(candidate.post?.authorId ?? candidate.authorId ?? '');
    const key = textKey(candidate.text);
    if (!author || authors.has(author) || seen.has(key)) continue;
    authors.add(author);
    seen.add(key);
    selected.push({ ...candidate, _key: key });
    if (selected.length >= limit) break;
  }
  return selected;
}

export function xComposerUrl(text, originalPostId = null) {
  if (originalPostId !== null && !/^\d{5,25}$/.test(originalPostId)) throw new Error('invalid X reply target ID');
  const url = new URL('https://twitter.com/intent/tweet');
  url.searchParams.set('text', text);
  if (originalPostId !== null) url.searchParams.set('in_reply_to', originalPostId);
  return url.href;
}

/**
 * Selects verbatim English Taiku text for human review. Comments only target X status URLs
 * already stored in x_post media; this module never fetches or constructs a target URL.
 */
export function createDrafts({ date, dayPosts, recentPosts = [], state = null, threadBaseUrl }) {
  if (!cleanDate(date)) throw new Error(`invalid draft date: ${date}`);
  const base = String(threadBaseUrl ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(base)) throw new Error('threadBaseUrl must be an HTTPS site origin');

  const seen = new Set(Object.keys(state?.seen ?? {}));
  const postCandidates = selectDrafts(
    dayPosts.filter((post) => isRoot(post) && !NON_STANDALONE_TYPES.has(post.type) && !post.media?.some((m) => ['x_post', 'bsky_post', 'link_card'].includes(m.kind)))
      .map((post) => ({ post, text: usableText(post) }))
      .filter((entry) => entry.text),
    MAX_POST_DRAFTS,
    seen,
  );
  const drafts = [];
  for (const { post, text, _key } of postCandidates) {
    drafts.push({
      kind: 'post',
      text,
      openInXUrl: xComposerUrl(text),
      sourcePostId: post.id,
      authorId: post.authorId,
      taikuThreadUrl: `${base}/p/${encodeURIComponent(post.id)}/`,
      _key,
    });
  }

  const minDate = Date.parse(`${date}T00:00:00Z`) - (COMMENT_LOOKBACK_DAYS - 1) * 864e5;
  const maxDate = Date.parse(`${date}T23:59:59Z`);
  const commentCandidates = [];
  const targets = new Set();
  for (const post of [...recentPosts, ...dayPosts]) {
    if (!isRoot(post)) continue;
    const created = Date.parse(post.createdAt ?? '');
    if (!Number.isFinite(created) || created < minDate || created > maxDate) continue;
    const text = usableText(post);
    if (!text || seen.has(textKey(text))) continue;
    for (const media of post.media ?? []) {
      if (media.kind !== 'x_post' || typeof media.url !== 'string') continue;
      const match = media.url.match(X_STATUS);
      if (!match || targets.has(match[2])) continue;
      targets.add(match[2]);
      commentCandidates.push({
        kind: 'comment',
        text,
        openInXUrl: xComposerUrl(text, match[2]),
        sourcePostId: post.id,
        authorId: post.authorId,
        originalUrl: media.url,
        originalPostId: match[2],
        originalAuthor: match[1],
        taikuThreadUrl: `${base}/p/${encodeURIComponent(post.id)}/`,
        _key: textKey(text),
        _created: created,
      });
      break;
    }
  }
  commentCandidates.sort((a, b) => b._created - a._created || String(a.sourcePostId).localeCompare(String(b.sourcePostId)));
  const selectedComments = selectDrafts(commentCandidates, MAX_COMMENT_DRAFTS, seen);
  const comments = selectedComments.map(({ _key, _created, ...draft }) => draft);

  const previous = state?.seen ?? {};
  const nextSeen = { ...previous };
  for (const draft of [...drafts, ...selectedComments]) nextSeen[draft._key] = { date, kind: draft.kind, sourcePostId: draft.sourcePostId };
  const result = {
    version: 1,
    date,
    posts: drafts.map(({ _key, ...draft }) => draft),
    comments,
    state: { version: 1, seen: nextSeen },
  };
  return result;
}

/** Load the recent, non-mock daily files used only to find current stored X references. */
export function loadRecentDailyPosts(postsDir, date, currentFile, currentPosts) {
  if (!cleanDate(date)) throw new Error(`invalid draft date: ${date}`);
  const first = Date.parse(`${date}T00:00:00Z`) - (COMMENT_LOOKBACK_DAYS - 1) * 864e5;
  const unique = new Map(currentPosts.map((post) => [post.id, post]));
  const pattern = /^daily-(\d{4}-\d{2}-\d{2})(?:-cf)?\.json$/;
  if (!fs.existsSync(postsDir)) return [...unique.values()];
  const files = fs.readdirSync(postsDir).filter((name) => {
    const match = name.match(pattern);
    if (!match) return false;
    const at = Date.parse(`${match[1]}T00:00:00Z`);
    return Number.isFinite(at) && at >= first && at <= Date.parse(`${date}T00:00:00Z`);
  }).sort((a, b) => b.localeCompare(a));
  for (const name of files) {
    const file = path.join(postsDir, name);
    if (path.resolve(file) === path.resolve(currentFile)) continue;
    for (const post of readPosts(file)) if (!unique.has(post.id)) unique.set(post.id, post);
  }
  return [...unique.values()];
}

export function renderDraftMarkdown(drafts) {
  const codeFence = (text) => '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length + 1)));
  const linkUrl = (url) => String(url).replace(/[()\\]/g, '\\$&');
  const lines = [
    `# Taiku X drafts — ${drafts.date}`,
    '',
    'Drafts only. Nothing was sent to X. Copy-ready text is preserved verbatim from Taiku.',
    '',
    '## Posts',
    '',
  ];
  if (!drafts.posts.length) lines.push('No new eligible post drafts.');
  for (const [index, draft] of drafts.posts.entries()) {
    const fence = codeFence(draft.text);
    lines.push(`### ${index + 1}. ${draft.authorName ?? draft.authorId}`, '', `[Open in X — review and post](${linkUrl(draft.openInXUrl)})`, '', `Taiku thread: [open](${linkUrl(draft.taikuThreadUrl)})`, '', `${fence}text`, draft.text, fence, '');
  }
  lines.push('## Comments replying to X posts', '');
  if (!drafts.comments.length) lines.push('No new eligible comments from recent Taiku X-post references.');
  for (const [index, draft] of drafts.comments.entries()) {
    const fence = codeFence(draft.text);
    lines.push(
      `### ${index + 1}. ${draft.authorName ?? draft.authorId}`,
      '',
      `Original X post: [${draft.originalAuthor} · ${draft.originalPostId}](${linkUrl(draft.originalUrl)})`,
      '',
      `[Open in X — review and reply](${linkUrl(draft.openInXUrl)})`,
      '',
      'Reply (copy-ready):',
      '',
      `${fence}text`,
      draft.text,
      fence,
      '',
      `Taiku thread reference: [open separately](${linkUrl(draft.taikuThreadUrl)})`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function draftStateFrom(value) {
  if (value == null) return { version: 1, seen: {} };
  if (value.version !== 1 || !value.seen || Array.isArray(value.seen) || typeof value.seen !== 'object') {
    throw new Error('invalid X draft state: expected { version: 1, seen: { ... } }');
  }
  return value;
}
