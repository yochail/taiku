// Taiku meme renderer: real-meme layouts drawn as SVG with text converted to vector paths from
// self-hosted OFL fonts (Anton = open Impact look-alike, Inter = modern caption font), so output is
// identical everywhere. At build time the SVG is rasterised to JPEG (resvg-js + jpeg-js) when those
// deps are installed; otherwise the self-contained SVG is used as-is.
// Templates: assets/memes/templates.json (see scripts/fetch-memes.mjs). Layouts:
//   top-bottom  classic Impact captions (white, black outline, uppercase, auto-fit, wrap, safe margins)
//   boxes       captions placed on template regions (memegen geometry); style impact | plain
//   caption-bar modern "Twitter meme": white bar above the image, left-aligned sans caption
//   tweet       X-style screenshot of a quoted taik, then a caption + reaction image (dunks)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, sitePath } from './site.mjs';

const MEMES = path.join(ROOT, 'assets', 'memes');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Output width of every meme (height follows the template's aspect ratio + caption bars). */
export const MEME_W = 640;

// ---------- template library ----------

let lib = null;
export function loadTemplates() {
  if (lib) return lib;
  const data = readJson(path.join(MEMES, 'templates.json'));
  const credits = readJson(path.join(ROOT, 'media', 'art-credits.json'));
  const templates = new Map();
  for (const t of data.templates) {
    if (t.art && !credits[t.art]) continue;
    templates.set(t.id, { ...t, description: t.usage });
  }
  lib = { version: data.version, templates };
  return lib;
}

const dataUris = new Map();
function imageOf(t) {
  if (!dataUris.has(t.id)) {
    const file = t.art
      ? path.join(ROOT, 'public', 'media', 'art', `${t.art}.jpg`)
      : path.join(ROOT, t.image);
    const buf = fs.readFileSync(file);
    dataUris.set(t.id, { href: `data:image/jpeg;base64,${buf.toString('base64')}`, ...jpegSize(buf) });
  }
  return dataUris.get(t.id);
}

export function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('not a JPEG');
}

// ---------- fonts + text layout ----------

const fonts = {};
export function font(name) {
  if (!fonts[name]) {
    const f = readJson(path.join(MEMES, 'fonts', `${name}.json`));
    f.scaleTo = (size) => size / f.unitsPerEm;
    const fb = FALLBACK[name];
    if (fb) {
      // Merge Hebrew glyphs (Heebo), scaled to this font's em and optically matched to its cap height.
      const h = readJson(path.join(MEMES, 'fonts', `${fb.name}.json`));
      const k = (f.unitsPerEm / h.unitsPerEm) * fb.scale;
      const sc = (n) => Math.round(n * k * 10) / 10;
      for (const [ch, [adv, d]] of Object.entries(h.glyphs)) {
        if (!f.glyphs[ch]) f.glyphs[ch] = [sc(adv), d ? d.replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (n) => String(sc(Number(n)))) : d];
      }
    }
    fonts[name] = f;
  }
  return fonts[name];
}
const FONT = { impact: 'anton', plain: 'inter-regular', bold: 'inter-bold' };
const FALLBACK = {
  anton: { name: 'heebo-black', scale: 1.3 },
  'inter-regular': { name: 'heebo-regular', scale: 1.12 },
  'inter-bold': { name: 'heebo-bold', scale: 1.12 },
};

// ---------- minimal bidi (Hebrew RTL inside LTR fonts) ----------
const RTL_CH = /[\u0590-\u05ff\ufb1d-\ufb4f]/;
const LTR_CH = /[\p{L}\p{N}]/u;
const dirOf = (ch) => (RTL_CH.test(ch) ? 'R' : LTR_CH.test(ch) ? 'L' : 'N');
/** Paragraph direction: that of the first strong character (default LTR). */
export function isRtl(text) {
  for (const ch of String(text ?? '')) { const t = dirOf(ch); if (t !== 'N') return t === 'R'; }
  return false;
}
const MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };
/** Logical -> visual order for one line (simplified UBA: strong R/L, neutrals resolved by neighbours). */
export function visualOrder(line, rtl) {
  const chs = [...line];
  if (!chs.some((c) => RTL_CH.test(c))) return line;
  const base = rtl ? 'R' : 'L';
  const t = chs.map(dirOf);
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== 'N') continue;
    let j = i; while (j < t.length && t[j] === 'N') j++;
    const before = i > 0 ? t[i - 1] : base, after = j < t.length ? t[j] : base;
    for (let k = i; k < j; k++) t[k] = before === after ? before : base;
    i = j - 1;
  }
  const lv = t.map((d) => (rtl ? (d === 'R' ? 1 : 2) : (d === 'R' ? 1 : 0)));
  const idx = chs.map((_, i) => i);
  for (let level = Math.max(...lv); level >= 1; level--) {
    for (let i = 0; i < idx.length; i++) {
      if (lv[idx[i]] < level) continue;
      let j = i; while (j < idx.length && lv[idx[j]] >= level) j++;
      idx.splice(i, j - i, ...idx.slice(i, j).reverse());
      i = j - 1;
    }
  }
  return idx.map((i) => (lv[i] % 2 && MIRROR[chs[i]]) || chs[i]).join('');
}

const SUBST = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u00a0': ' ', '\t': ' ' };
/** Keep only characters the font can draw (fold accents / smart quotes; drop emoji etc.). */
export function supported(f, text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (ch === '\n' || f.glyphs[ch]) { out += ch; continue; }
    const sub = SUBST[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, '');
    if (sub && sub !== ch && [...sub].every((c) => f.glyphs[c])) out += sub;
    else if (/\s/.test(ch)) out += ' ';
  }
  return out.replace(/ +/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function measure(f, s, size) {
  let w = 0, prev = '';
  for (const ch of s) {
    w += (f.glyphs[ch]?.[0] ?? 0) + (prev ? f.kern[prev + ch] ?? 0 : 0);
    prev = ch;
  }
  return w * f.scaleTo(size);
}

function wrapLines(f, text, size, maxW, breakWords) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (let word of para.split(' ').filter(Boolean)) {
      const cand = line ? `${line} ${word}` : word;
      if (measure(f, cand, size) <= maxW) { line = cand; continue; }
      if (line) lines.push(line);
      line = '';
      if (breakWords) {
        while (measure(f, word, size) > maxW && word.length > 1) {
          let k = word.length - 1;
          while (k > 1 && measure(f, word.slice(0, k), size) > maxW) k--;
          lines.push(word.slice(0, k));
          word = word.slice(k);
        }
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Largest font size in [min, max] whose wrapped text fits w x h (line height lh em, at most maxLines).
 * Words are only split at the minimum size; if it still does not fit, lines are cut with an ellipsis
 * and `overflow` is true (validation keeps captions short enough that this does not happen).
 */
export function fitText(f, text, { w, h, max, min, lh = 1.1, maxLines = 99 }) {
  const fits = (lines, size) => lines.length <= maxLines && lines.length * lh * size <= h + 0.01
    && lines.every((l) => measure(f, l, size) <= w + 0.01);
  for (let size = Math.floor(max); size >= Math.ceil(min); size--) {
    const lines = wrapLines(f, text, size, w, false);
    if (fits(lines, size)) return { size, lines, overflow: false };
  }
  const size = Math.ceil(min);
  let lines = wrapLines(f, text, size, w, true);
  if (fits(lines, size)) return { size, lines, overflow: false };
  const keep = Math.max(1, Math.min(maxLines, Math.floor(h / (lh * size))));
  lines = lines.slice(0, keep);
  let last = lines[keep - 1];
  while (last && measure(f, `${last}...`, size) > w) last = last.slice(0, -1);
  lines[keep - 1] = `${last}...`;
  return { size, lines, overflow: true };
}

const r1 = (n) => Math.round(n * 10) / 10;
/**
 * Path data for laid-out lines; (x, y) = top-left of the text block, line boxes lh*size tall.
 * Hebrew is drawn right-to-left; `align: 'left'` means "start" (right for RTL text) unless `fixed`.
 */
export function textPath(f, lines, { size, lh, x, y, w, align = 'center', fixed = false }) {
  const s = f.scaleTo(size), L = lh * size;
  const capH = f.capHeight * s;
  const rtl = isRtl(lines.join('\n'));
  if (rtl && !fixed && align === 'left') align = 'right';
  let d = '';
  lines.forEach((logical, i) => {
    const line = visualOrder(logical, rtl);
    const lw = measure(f, line, size);
    let ox = align === 'left' ? x : align === 'right' ? x + w - lw : x + (w - lw) / 2;
    const base = y + i * L + (L + capH) / 2;
    let prev = '';
    for (const ch of line) {
      const g = f.glyphs[ch];
      if (!g) continue;
      if (prev) ox += (f.kern[prev + ch] ?? 0) * s;
      if (g[1]) {
        let k = 0;
        d += g[1].replace(/-?\d*\.?\d+(?:e-?\d+)?/g, (n) => ` ${r1(k++ % 2 === 0 ? ox + Number(n) * s : base + Number(n) * s)}`);
      }
      ox += g[0] * s;
      prev = ch;
    }
  });
  return d;
}

const STYLE = {
  impact: { font: 'impact', lh: 1.04, upper: true, attrs: (size) => `fill="#fff" stroke="#000" stroke-width="${r1(Math.max(2, size * 0.12))}" stroke-linejoin="round" paint-order="stroke fill"` },
  plain: { font: 'plain', lh: 1.22, upper: false, attrs: () => 'fill="#000"' },
};

/** Draw `text` into a box ({x,y,w,h} px). Returns { svg, size, lines, overflow, box }. */
function textBox(text, box, { style = 'impact', align = 'center', valign = 'middle', max, min, upper, angle = 0, grow = true }) {
  const st = STYLE[style] ?? STYLE.impact;
  const f = font(FONT[st.font]);
  let t = supported(f, text);
  if (upper ?? st.upper) t = t.toUpperCase();
  if (!t) return { svg: '', size: 0, lines: [], overflow: false, box };
  let b = { ...box };
  let fit = fitText(f, t, { w: b.w, h: b.h, max, min, lh: st.lh });
  if (fit.overflow && grow) {
    // Small memegen label boxes: let long labels spill a little around the region instead of cutting.
    const cw = box.canvasW, ch = box.canvasH;
    const w = Math.min(cw - 8, b.w * 1.7), h = Math.min(ch - 8, b.h * 1.7);
    b = { ...b, x: Math.max(4, Math.min(cw - 4 - w, b.x - (w - b.w) / 2)), y: Math.max(4, Math.min(ch - 4 - h, b.y - (h - b.h) / 2)), w, h };
    fit = fitText(f, t, { w: b.w, h: b.h, max, min, lh: st.lh });
  }
  const blockH = fit.lines.length * st.lh * fit.size;
  const y = valign === 'top' ? b.y : valign === 'bottom' ? b.y + b.h - blockH : b.y + (b.h - blockH) / 2;
  const d = textPath(f, fit.lines, { size: fit.size, lh: st.lh, x: b.x, y, w: b.w, align });
  const rot = angle ? ` transform="rotate(${angle} ${r1(b.x + b.w / 2)} ${r1(b.y + b.h / 2)})"` : '';
  return { svg: `<path d="${d.trim()}" ${st.attrs(fit.size)}${rot}/>`, ...fit, box: { ...b, y, h: blockH } };
}

const svgDoc = (W, H, body) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
const img = (href, x, y, w, h) => `<image xlink:href="${href}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" preserveAspectRatio="xMidYMid slice"/>`;

// ---------- layouts ----------

function topBottom(t, captions, W) {
  const im = imageOf(t);
  const H = Math.round((W * im.height) / im.width);
  const m = Math.round(W * 0.035);
  const boxes = [];
  let body = img(im.href, 0, 0, W, H);
  t.slots.forEach((s, i) => {
    const text = captions[s.name];
    if (!text) return;
    const box = { x: m, y: i === 0 ? m * 0.6 : H - m * 0.6 - H * 0.3, w: W - 2 * m, h: H * 0.3, canvasW: W, canvasH: H };
    const r = textBox(text, box, { style: 'impact', valign: i === 0 ? 'top' : 'bottom', max: W * 0.1, min: W * 0.038, grow: false });
    body += r.svg;
    boxes.push({ slot: s.name, ...r });
  });
  return { svg: svgDoc(W, H, body), width: W, height: H, boxes };
}

function regionBoxes(t, captions, W) {
  const im = imageOf(t);
  const ext = t.extend_right ? 1 + t.extend_right : 1;
  const iw = W / ext;
  const H = Math.round((iw * im.height) / im.width);
  let body = (ext > 1 ? `<rect width="${W}" height="${H}" fill="#fff"/>` : '') + img(im.href, 0, 0, iw, H);
  const boxes = [];
  for (const s of t.slots) {
    const text = captions[s.name];
    if (!text) continue;
    const pad = Math.min(6, s.w * W * 0.04);
    const box = { x: s.x * W + pad, y: s.y * H + pad, w: s.w * W - 2 * pad, h: s.h * H - 2 * pad, canvasW: W, canvasH: H };
    const plain = s.style === 'plain';
    const r = textBox(text, box, {
      style: s.style, align: s.align ?? 'center', upper: s.upper, angle: s.angle, grow: !plain,
      max: Math.min(box.h * (plain ? 0.8 : 0.95), W * (plain ? 0.06 : 0.085)), min: W * (plain ? 0.024 : 0.03),
    });
    body += r.svg;
    boxes.push({ slot: s.name, ...r });
  }
  return { svg: svgDoc(W, H, body), width: W, height: H, boxes };
}

/** Modern caption: white bar, left-aligned sans text, image below. Returns the bar as SVG fragment. */
function captionBar(text, W, y0 = 0) {
  const f = font(FONT.plain);
  const t = supported(f, text);
  if (!t) return { svg: '', height: 0, box: null };
  const pad = Math.round(W * 0.04), lh = 1.28;
  const w = W - 2 * pad;
  let fit = fitText(f, t, { w, h: 4 * lh * W * 0.052, max: W * 0.052, min: W * 0.042, lh });
  if (fit.overflow) fit = fitText(f, t, { w, h: 7 * lh * W * 0.034, max: W * 0.04, min: W * 0.034, lh });
  const blockH = fit.lines.length * lh * fit.size;
  const vpad = Math.round(pad * 0.75);
  const height = Math.round(blockH + 2 * vpad);
  const d = textPath(f, fit.lines, { size: fit.size, lh, x: pad, y: y0 + vpad, w, align: 'left' });
  return { svg: `<rect y="${y0}" width="${W}" height="${height}" fill="#fff"/><path d="${d.trim()}" fill="#0f1419"/>`, height, box: { x: pad, y: y0 + vpad, w: Math.max(...fit.lines.map((l) => measure(f, l, fit.size))), h: blockH }, ...fit };
}

function captionBarLayout(t, captions, W) {
  const im = imageOf(t);
  let text = t.slots.map((s) => captions[s.name]).filter(Boolean).join('\n');
  if (t.prefix) {
    if (t.id === 'nobody-me' && !/^\s*me\s*:/i.test(text)) text = `me: ${text}`;
    text = t.prefix + text;
  }
  const bar = captionBar(text, W);
  const ih = Math.round((W * im.height) / im.width);
  const H = bar.height + ih;
  return { svg: svgDoc(W, H, bar.svg + img(im.href, 0, bar.height, W, ih)), width: W, height: H, boxes: [{ slot: 'caption', ...bar }] };
}

function avatarDataUri(persona) {
  const file = persona && sitePath('assets', 'memes', 'avatars', `${persona}.jpg`);
  return file && fs.existsSync(file) ? `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}` : null;
}

/**
 * X-style screenshot card of the quoted taik.
 * quote: { persona?, name, handle, text, color?, initials? }
 */
export function tweetCard(quote, W, y0 = 0) {
  const bold = font(FONT.bold), reg = font(FONT.plain);
  const m = Math.round(W * 0.03), p = Math.round(W * 0.04), av = Math.round(W * 0.085);
  const cx = m, cw = W - 2 * m;
  const tx = cx + p + av + Math.round(p * 0.5);
  const nameSize = Math.round(W * 0.031), textSize = Math.round(W * 0.036), lh = 1.32;
  const nameW = cw - (tx - cx) - p;
  let name = supported(bold, quote.name || quote.handle || 'Taiku');
  while (name.length > 1 && measure(bold, name, nameSize) > nameW * 0.62) name = name.slice(0, -1);
  const handle = supported(reg, `@${String(quote.handle ?? '').replace(/^@/, '')}${quote.date ? ` · ${quote.date}` : ''}`);
  const body = supported(reg, quote.text);
  const tw = cw - 2 * p;
  const fit = fitText(reg, body, { w: tw, h: 8 * lh * textSize, max: textSize, min: Math.round(W * 0.03), lh, maxLines: 8 });
  const textY = y0 + m + p + av + Math.round(p * 0.4);
  const textH = fit.lines.length * lh * fit.size;
  const ch = Math.round(textY + textH + p * 0.9 - (y0 + m));
  const ay = y0 + m + p;
  const uri = avatarDataUri(quote.persona);
  const r = av / 2, acx = cx + p + r, acy = ay + r;
  let s = `<rect x="${cx}" y="${y0 + m}" width="${cw}" height="${ch}" rx="${Math.round(W * 0.025)}" fill="#fff" stroke="#cfd9de" stroke-width="1.5"/>`;
  s += uri
    ? `<clipPath id="av"><circle cx="${r1(acx)}" cy="${r1(acy)}" r="${r1(r)}"/></clipPath><image xlink:href="${uri}" x="${cx + p}" y="${ay}" width="${av}" height="${av}" clip-path="url(#av)"/>`
    : `<circle cx="${r1(acx)}" cy="${r1(acy)}" r="${r1(r)}" fill="${quote.color || '#536471'}"/>`
      + `<path d="${textPath(bold, [supported(bold, quote.initials || name.slice(0, 1)).toUpperCase()], { size: av * 0.38, lh: 1, x: cx + p, y: ay + av * 0.31, w: av, align: 'center' })}" fill="#fff"/>`;
  const nameY = ay + av * 0.08;
  s += `<path d="${textPath(bold, [name], { size: nameSize, lh: 1.25, x: tx, y: nameY, w: nameW, align: 'left', fixed: true })}" fill="#0f1419"/>`;
  const nw = measure(bold, name, nameSize);
  // X-style blue check after the name.
  const ck = nameSize * 0.95, ckx = tx + nw + nameSize * 0.25, cky = nameY + (nameSize * 1.25 - ck) / 2;
  s += `<g transform="translate(${r1(ckx)} ${r1(cky)}) scale(${r1(ck / 24 * 100) / 100})"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z" fill="#1d9bf0"/><path d="M10.54 16.2l-3.5-3.5 1.41-1.42 2.09 2.1 5.55-5.56 1.41 1.42z" fill="#fff"/></g>`;
  let h = handle;
  while (h.length > 2 && measure(reg, h, nameSize) > nameW) h = h.slice(0, -1);
  s += `<path d="${textPath(reg, [h], { size: nameSize, lh: 1.25, x: tx, y: nameY + nameSize * 1.3, w: nameW, align: 'left', fixed: true })}" fill="#536471"/>`;
  s += `<path d="${textPath(reg, fit.lines, { size: fit.size, lh, x: cx + p, y: textY, w: tw, align: 'left' })}" fill="#0f1419"/>`;
  return { svg: s, height: ch + 2 * m, box: { x: cx + p, y: textY, w: tw, h: textH }, ...fit };
}

function tweetLayout(t, captions, W, opts) {
  const quote = opts.quote;
  if (!quote?.text) throw new Error('tweet-dunk needs render.quote {name, handle, text}');
  const card = tweetCard(quote, W);
  const bar = captions.caption ? captionBar(captions.caption, W, card.height - Math.round(W * 0.015)) : { svg: '', height: 0 };
  let y = card.height + (bar.height ? bar.height - Math.round(W * 0.015) : 0);
  let body = `<rect width="${W}" height="${y}" fill="#fff"/>${card.svg}${bar.svg}`;
  const rx = opts.reaction && loadTemplates().templates.get(opts.reaction);
  if (rx && rx.layout !== 'tweet') {
    const im = imageOf(rx);
    const ih = Math.round((W * im.height) / im.width);
    body += img(im.href, 0, y, W, ih);
    y += ih;
  }
  return { svg: svgDoc(W, y, body), width: W, height: y, boxes: [{ slot: 'quote', ...card }, ...(bar.box ? [{ slot: 'caption', ...bar }] : [])] };
}

/**
 * Render a meme. captions: {slotName: text}. opts: { width?, quote?, reaction? } (tweet layout).
 * Returns { svg, width, height, boxes:[{slot, size, lines, overflow, box}] }.
 */
export function renderMeme(t, captions = {}, opts = {}) {
  const W = opts.width ?? MEME_W;
  if (t.layout === 'top-bottom') return topBottom(t, captions, W);
  if (t.layout === 'boxes') return regionBoxes(t, captions, W);
  if (t.layout === 'caption-bar') return captionBarLayout(t, captions, W);
  if (t.layout === 'tweet') return tweetLayout(t, captions, W, opts);
  throw new Error(`unknown meme layout ${t.layout}`);
}

/** Alt text = the captions (plus what the picture is). */
export function memeAlt(t, captions = {}, opts = {}) {
  const said = t.slots.map((s) => captions[s.name]).filter(Boolean).map((c) => `"${c}"`).join(' / ');
  if (t.layout === 'tweet') {
    const rx = opts.reaction && loadTemplates().templates.get(opts.reaction);
    return `Screenshot of a taik by ${opts.quote?.name ?? 'someone'}: "${opts.quote?.text ?? ''}"${said ? `, captioned ${said}` : ''}${rx ? `, with the ${rx.name} reaction image` : ''}.`;
  }
  return `${t.name} meme: ${said}`;
}

// ---------- rasterising ----------

const require = createRequire(import.meta.url);
let deps;
function loadDeps() {
  if (deps === undefined) {
    try {
      deps = process.env.TAIKU_MEME_SVG ? null : { Resvg: require('@resvg/resvg-js').Resvg, jpeg: require('jpeg-js') };
    } catch {
      deps = null;
    }
  }
  return deps;
}
/** True when resvg-js + jpeg-js are installed (memes become JPEGs; otherwise SVG). */
export const canRaster = () => Boolean(loadDeps());

export function rasterizeSvg(svg, quality = 84) {
  const d = loadDeps();
  if (!d) throw new Error('rasterising needs @resvg/resvg-js and jpeg-js (npm install)');
  const out = new d.Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'original' } }).render();
  return Buffer.from(d.jpeg.encode({ data: out.pixels, width: out.width, height: out.height }, quality).data);
}
