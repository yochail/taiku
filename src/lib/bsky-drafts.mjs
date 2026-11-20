import fs from 'node:fs';
import path from 'node:path';
import { displayName, taikLength } from './data.mjs';
import { SITE_DIR, SITE_CONFIG } from './site.mjs';

export const MAX_BSKY_DRAFTS = 5;
const NON_STANDALONE_TYPES = new Set(['meme', 'news_wire', 'poll', 'retaik', 'thread']);
const isEnglish = (text) => /\p{Script=Latin}/u.test(text) && [...text].every((char) => !/\p{L}/u.test(char) || /\p{Script=Latin}/u.test(char));
const usableText = (post) => {
  const text = typeof post?.text === 'string' ? post.text : '';
  return text.trim().length >= 35 && taikLength(text) <= 280 && isEnglish(text) && !/[⟦⟧]/u.test(text) ? text : null;
};
const isRoot = (post) => !post.parentId && !post.inReplyTo;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const initials = (name) => String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || 'T';

function sourceUrlOf(post) {
  const value = post.news?.url ?? post.topic?.url ?? post.media?.find((m) => m.kind === 'link_card')?.url;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function avatarData(persona) {
  const image = String(persona.avatar?.image ?? '');
  if (!image.startsWith('/') || image.startsWith('//')) return null;
  const local = path.resolve(SITE_DIR, 'public', image.slice(1));
  const publicDir = path.resolve(SITE_DIR, 'public') + path.sep;
  if (!local.startsWith(publicDir) || !fs.existsSync(local)) return null;
  const mime = ({ '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(local).toLowerCase()];
  return mime ? `data:${mime};base64,${fs.readFileSync(local).toString('base64')}` : null;
}

function lineWidth(text, fontSize) {
  return [...text].reduce((sum, char) => sum + (/\s/.test(char) ? 0.34 : /[ilI.,'!:;|]/.test(char) ? 0.3 : /[MW@#%&]/.test(char) ? 0.85 : 0.56) * fontSize, 0);
}

function wrapParagraph(text, maxWidth, fontSize) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && lineWidth(next, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lineWidth(line, fontSize) > maxWidth) {
      const chars = [...line];
      let chunk = '';
      line = '';
      for (const char of chars) {
        if (chunk && lineWidth(chunk + char, fontSize) > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else chunk += char;
      }
      line = chunk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function blueskyPostAlt(persona, text, { sample = false } = {}) {
  const name = displayName(persona) || persona.handle;
  return `Taiku post mockup by ${name} (@${persona.handle}): ${text}${sample ? ' Sample mockup, not an actual Bluesky post.' : ' AI-generated draft for human review, not posted.'}`;
}

/** Render the complete Taiku text as a standalone, deterministic SVG image. */
export function renderBlueskyPostSvg(persona, text, { sample = false } = {}) {
  if (SITE_CONFIG.id !== 'taiku' || SITE_CONFIG.content_locale !== 'en') throw new Error('Bluesky drafts are available only for English Taiku');
  if (!usableText({ text })) throw new Error('Bluesky draft text must be English and within the post length limit');
  const name = displayName(persona) || persona.handle;
  const fontSize = 34;
  const lineHeight = 48;
  const textX = 92;
  const maxWidth = 1016;
  const lines = text.split(/\r?\n/).flatMap((paragraph) => paragraph.trim() ? wrapParagraph(paragraph, maxWidth, fontSize) : ['']);
  const textTop = 264;
  const textEnd = textTop + Math.max(1, lines.length) * lineHeight;
  const footerTop = textEnd + 62;
  const height = Math.max(580, footerTop + 110);
  const image = avatarData(persona);
  const av = image
    ? `<clipPath id="avatar-clip"><circle cx="142" cy="190" r="40"/></clipPath><image href="${image}" x="102" y="150" width="80" height="80" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>`
    : `<circle cx="142" cy="190" r="40" fill="${esc(persona.avatar?.color || '#64748b')}"/><text x="142" y="201" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" font-weight="700" fill="#fff">${esc(initials(name))}</text>`;
  const textSvg = lines.map((line, i) => `<text x="${textX}" y="${textTop + i * lineHeight}" font-family="Arial,sans-serif" font-size="${fontSize}" fill="#17202b">${esc(line)}</text>`).join('');
  const alt = blueskyPostAlt(persona, text, { sample });
  const badge = sample ? 'SAMPLE · NOT POSTED' : 'AI-GENERATED · REVIEW BEFORE POSTING';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title description">
<title id="title">${esc(alt)}</title><desc id="description">${esc(alt)}</desc>
<defs><linearGradient id="wash" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f0f7ff"/><stop offset="1" stop-color="#eef2ff"/></linearGradient></defs>
<rect width="1200" height="${height}" fill="url(#wash)"/>
<rect x="42" y="42" width="1116" height="${height - 84}" rx="30" fill="#fff" stroke="#dce4ef" stroke-width="2"/>
<rect x="42" y="42" width="1116" height="12" rx="6" fill="#5277d8"/>
<text x="92" y="100" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="3" fill="#5066b8">TAIKU</text>
<text x="92" y="128" font-family="Arial,sans-serif" font-size="15" fill="#68758a">DEAD THINKERS SOCIETY · MOCK UI PREVIEW</text>
<rect x="844" y="78" width="268" height="36" rx="18" fill="${sample ? '#fff2d6' : '#eef3ff'}"/>
<text x="978" y="102" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="700" letter-spacing="1" fill="${sample ? '#80510a' : '#4a5eaa'}">${esc(badge)}</text>
${av}
<text x="210" y="181" font-family="Arial,sans-serif" font-size="27" font-weight="700" fill="#17202b">${esc(name)}</text>
<text x="210" y="216" font-family="Arial,sans-serif" font-size="20" fill="#68758a">@${esc(persona.handle)}</text>
<circle cx="1096" cy="190" r="4" fill="#7b8799"/><circle cx="1110" cy="190" r="4" fill="#7b8799"/><circle cx="1124" cy="190" r="4" fill="#7b8799"/>
${textSvg}
<line x1="92" y1="${footerTop - 24}" x2="1108" y2="${footerTop - 24}" stroke="#e5e9f0" stroke-width="2"/>
<text x="92" y="${footerTop + 10}" font-family="Arial,sans-serif" font-size="15" fill="#68758a">Taiku · English-only image draft</text>
<text x="92" y="${footerTop + 38}" font-family="Arial,sans-serif" font-size="14" fill="#9a5c14">${sample ? 'Sample mockup, not posted. Review content and gates before use.' : 'Draft only. No post was sent to Bluesky.'}</text>
</svg>`;
}

export function createBlueskyDrafts({ date, dayPosts, personas, sample = false, threadBaseUrl = SITE_CONFIG.baseUrl, limit = MAX_BSKY_DRAFTS }) {
  if (SITE_CONFIG.id !== 'taiku' || SITE_CONFIG.content_locale !== 'en') throw new Error('Bluesky drafts are available only for English Taiku');
  const parsedDate = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0, 10) !== date) throw new Error(`invalid draft date: ${date}`);
  const base = String(threadBaseUrl ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(base)) throw new Error('threadBaseUrl must be an HTTPS site origin');
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  const selected = [];
  const seenTexts = new Set();
  const targetLimit = Math.max(0, Math.min(MAX_BSKY_DRAFTS, limit));
  if (!targetLimit) return { version: 1, site: 'taiku', date, status: sample ? 'sample' : 'approved-for-review', posts: selected };
  for (const post of dayPosts) {
    if (!isRoot(post) || NON_STANDALONE_TYPES.has(post.type) || post.media?.some((m) => ['x_post', 'bsky_post'].includes(m.kind))) continue;
    const text = usableText(post);
    const persona = byId.get(post.authorId);
    if (!text || !persona || seenTexts.has(text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase())) continue;
    seenTexts.add(text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase());
    const sourceUrl = sourceUrlOf(post);
    selected.push({
      sourcePostId: post.id,
      authorId: post.authorId,
      authorName: displayName(persona) || persona.handle,
      handle: persona.handle,
      text,
      alt: blueskyPostAlt(persona, text, { sample }),
      taikuThreadUrl: `${base}/p/${encodeURIComponent(post.id)}/`,
      ...(sourceUrl ? { sourceUrl } : {}),
      sample,
      svg: renderBlueskyPostSvg(persona, text, { sample }),
    });
    if (selected.length >= targetLimit) break;
  }
  return { version: 1, site: 'taiku', date, status: sample ? 'sample' : 'approved-for-review', posts: selected };
}

export async function writeBlueskyDrafts(drafts, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const posts = [];
  if (drafts.posts.length) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, offline: true });
      for (const { svg, ...draft } of drafts.posts) {
        const safeId = String(draft.sourcePostId).replace(/[^A-Za-z0-9_-]/g, '_');
        const image = `${drafts.date}-${safeId}.png`;
        await page.setContent(`<meta charset="utf-8"><style>body{margin:0}</style>${svg}`);
        const png = await page.locator('svg').screenshot({ animations: 'disabled' });
        if (png.length > 1_000_000) throw new Error(`Bluesky draft exceeds the image size limit: ${image}`);
        fs.writeFileSync(path.join(outDir, image), png);
        posts.push({ ...draft, image });
      }
    } finally {
      await browser.close();
    }
  }
  const result = { version: drafts.version, site: drafts.site, date: drafts.date, status: drafts.status, posts };
  fs.writeFileSync(path.join(outDir, 'drafts.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
