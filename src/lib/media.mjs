// Taiku's $0 local media pipeline: public-domain art (media/library.json + media/art-credits.json),
// locally rendered memes, reaction "GIFs" (animated SVG) and charts. Everything is rendered to
// self-contained SVG at build time from the `render` params stored on each post's media item,
// so the repo only stores small JSON and nothing is hotlinked.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './util.mjs';
import { loadTemplates, renderMeme, memeAlt, canRaster, rasterizeSvg } from './meme-render.mjs';
import { shortlistTemplates, pickReaction } from './meme-select.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

let cache = null;
export function loadLibrary() {
  if (cache) return cache;
  const lib = readJson(path.join(ROOT, 'media', 'library.json'));
  const credits = readJson(path.join(ROOT, 'media', 'art-credits.json'));
  const art = new Map(lib.art.filter((a) => credits[a.id]).map((a) => [a.id, { ...a, ...credits[a.id] }]));
  // Meme templates live in assets/memes/templates.json (real meme library + PD-art templates).
  const memes = loadTemplates().templates;
  const reactions = new Map(lib.reactions.filter((r) => art.has(r.art)).map((r) => [r.id, r]));
  cache = { art, memes, reactions };
  return cache;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const chars = (s) => [...String(s ?? '')].length;
const dataUris = new Map();
function artDataUri(a) {
  if (!dataUris.has(a.id)) {
    const buf = fs.readFileSync(path.join(ROOT, 'public', a.src.replace(/^\//, '')));
    dataUris.set(a.id, `data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return dataUris.get(a.id);
}
const creditOf = (a) => ({ author: a.author, license: a.license, url: a.url, title: a.title });

/** Greedy word wrap to at most maxChars per line (long words get their own line). */
export function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const word of String(text).trim().split(/\s+/)) {
    if (!line) line = word;
    else if (chars(line) + 1 + chars(word) <= maxChars) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest font size (step 1) whose wrapped text fits maxLines within width. */
function fit(text, width, { max, min, maxLines, em }) {
  for (let size = max; size >= min; size--) {
    const lines = wrap(text, Math.max(4, Math.floor(width / (size * em))));
    if (lines.length <= maxLines) return { size, lines };
  }
  return { size: min, lines: wrap(text, Math.max(4, Math.floor(width / (min * em)))) };
}

// textLength pins each line to its estimated width so text never spills, whatever font the viewer has.
function textLines({ lines, size, x, y, anchor = 'middle', em, lineHeight = 1.15, maxWidth, attrs = '' }) {
  return lines.map((ln, i) => {
    const w = Math.min(maxWidth, chars(ln) * size * em);
    return `<text x="${x}" y="${(y + i * size * lineHeight).toFixed(1)}" font-size="${size}" text-anchor="${anchor}" textLength="${w.toFixed(1)}" lengthAdjust="spacingAndGlyphs" ${attrs}>${xml(ln)}</text>`;
  }).join('');
}

const IMPACT = `font-family="Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Black', sans-serif" font-weight="900" fill="#fff" stroke="#000" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`;
// Impact caps are ~0.6em wide, but the Arial Black fallback is ~0.75em; 0.7 keeps both readable.
const IMPACT_EM = 0.7;
const SANS = `font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`;

// ---------- memes ----------

// Real-meme layouts, fonts and rasterising live in meme-render.mjs.
export function renderMemeSvg(template, captions, opts = {}) {
  return renderMeme(template, captions, opts).svg;
}

// ---------- reaction "GIFs" (animated SVG, loops, respects reduced motion) ----------

const EFFECTS = {
  shake: { dur: '0.6s', kf: '0%,100%{transform:scale(1.08) translate(0,0)}20%{transform:scale(1.08) translate(-5px,3px)}40%{transform:scale(1.08) translate(5px,-3px)}60%{transform:scale(1.08) translate(-4px,-2px)}80%{transform:scale(1.08) translate(4px,2px)}' },
  zoom: { dur: '2.4s', kf: '0%{transform:scale(1)}35%,85%{transform:scale(1.35)}100%{transform:scale(1)}' },
  slowzoom: { dur: '5s', kf: '0%,100%{transform:scale(1)}50%{transform:scale(1.18)}' },
  pan: { dur: '6s', kf: '0%,100%{transform:scale(1.3) translateX(-7%)}50%{transform:scale(1.3) translateX(7%)}' },
  bounce: { dur: '0.7s', kf: '0%,100%{transform:scale(1.06) translateY(0)}50%{transform:scale(1.06) translateY(-9px)}' },
  pop: { dur: '2s', kf: '0%,30%{transform:scale(1)}36%,90%{transform:scale(1.45)}100%{transform:scale(1)}' },
  sway: { dur: '3s', kf: '0%,100%{transform:scale(1.1) rotate(-2deg)}50%{transform:scale(1.1) rotate(2deg)}' },
  pulse: { dur: '3.2s', kf: '0%,100%{transform:scale(1);filter:saturate(1)}50%{transform:scale(1.1);filter:saturate(1.6)}' },
};

export function renderReactionSvg(reaction, caption = '') {
  const a = loadLibrary().art.get(reaction.art);
  const fx = EFFECTS[reaction.effect] ?? EFFECTS.zoom;
  const W = a.width, H = a.height;
  let cap = '';
  if (caption) {
    const em = IMPACT_EM;
    const { size, lines } = fit(String(caption).toUpperCase(), W - 24, { max: 34, min: 18, maxLines: 2, em });
    cap = textLines({ lines, size, x: W / 2, y: H - 14 - (lines.length - 1) * size * 1.1, em, lineHeight: 1.1, maxWidth: W - 24, attrs: IMPACT });
  }
  const style = `<style>.fx{transform-box:view-box;transform-origin:50% 45%;animation:fx ${fx.dur} ease-in-out infinite}@keyframes fx{${fx.kf}}@media (prefers-reduced-motion:reduce){.fx{animation:none}}</style>`;
  return svg(W, H, `${style}<rect width="${W}" height="${H}" fill="#000"/><g class="fx"><image href="${artDataUri(a)}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/></g>${cap}`);
}

// ---------- charts ----------

export const CHART_TYPES = ['bar', 'hbar', 'line', 'pie'];
const PALETTE = ['#1d9bf0', '#f91880', '#00ba7c', '#ffad1f', '#7856ff', '#ff7a00', '#536471', '#e0245e'];
const num = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(Math.round(v * 10) / 10));

export function renderChartSvg(c) {
  const W = 520, H = 340, top = 58, bottom = 46, left = 44, right = 20;
  const pw = W - left - right, ph = H - top - bottom;
  const unit = c.unit ? String(c.unit) : '';
  const max = Math.max(...c.values.map(Math.abs), 1e-9);
  const title = fit(c.title, W - 40, { max: 20, min: 14, maxLines: 2, em: 0.56 });
  let body = `<rect width="${W}" height="${H}" rx="14" fill="#fff"/>`
    + textLines({ ...title, x: 20, y: 30, anchor: 'start', em: 0.56, lineHeight: 1.2, maxWidth: W - 40, attrs: `${SANS} font-weight="700" fill="#0f1419"` });
  const label = (t, x, y, anchor = 'middle', size = 12) => {
    const s = String(t);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}" ${SANS} fill="#536471"${chars(s) * size * 0.55 > 90 ? ` textLength="90" lengthAdjust="spacingAndGlyphs"` : ''}>${xml(s)}</text>`;
  };
  const n = c.values.length;
  if (c.type === 'bar' || c.type === 'line') {
    body += `<line x1="${left}" y1="${top + ph}" x2="${left + pw}" y2="${top + ph}" stroke="#cfd9de"/>`;
    const step = pw / n;
    const pts = c.values.map((v, i) => [left + step * (i + 0.5), top + ph - (Math.max(0, v) / max) * ph]);
    if (c.type === 'bar') {
      c.values.forEach((v, i) => {
        const h = (Math.max(0, v) / max) * ph, bw = Math.min(64, step * 0.62);
        body += `<rect x="${(pts[i][0] - bw / 2).toFixed(1)}" y="${(top + ph - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${PALETTE[i % PALETTE.length]}"/>`;
      });
    } else {
      body += `<polyline points="${pts.map((p) => p.map((x) => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${PALETTE[0]}" stroke-width="3" stroke-linejoin="round"/>`
        + pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${PALETTE[0]}"/>`).join('');
    }
    pts.forEach((p, i) => {
      body += label(num(c.values[i]) + unit, p[0], p[1] - 7, 'middle', 12);
      body += label(c.labels[i], p[0], top + ph + 18);
    });
  } else if (c.type === 'hbar') {
    const step = ph / n, lw = 150;
    c.values.forEach((v, i) => {
      const w = (Math.max(0, v) / max) * (pw - lw - 50), y = top + step * i + step * 0.18, h = step * 0.64;
      body += label(c.labels[i], 20 + lw - 8, y + h / 2 + 4, 'end', 13, lw - 8)
        + `<rect x="${20 + lw}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${PALETTE[i % PALETTE.length]}"/>`
        + label(num(v) + unit, 20 + lw + w + 6, y + h / 2 + 4, 'start', 12);
    });
  } else if (c.type === 'pie') {
    const total = c.values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
    const cx = left + 110, cy = top + ph / 2, r = Math.min(ph / 2, 110);
    let ang = -Math.PI / 2;
    c.values.forEach((v, i) => {
      const frac = Math.max(0, v) / total, end = ang + frac * Math.PI * 2;
      const [x1, y1, x2, y2] = [cx + r * Math.cos(ang), cy + r * Math.sin(ang), cx + r * Math.cos(end), cy + r * Math.sin(end)];
      body += frac >= 0.9999
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${PALETTE[i % PALETTE.length]}"/>`
        : `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff" stroke-width="2"/>`;
      const ly = top + 14 + i * 26;
      body += `<rect x="${cx + r + 30}" y="${ly - 11}" width="14" height="14" rx="3" fill="${PALETTE[i % PALETTE.length]}"/>`
        + label(`${c.labels[i]} · ${Math.round(frac * 100)}%`, cx + r + 52, ly, 'start', 13, W - (cx + r + 52) - 16);
      ang = end;
    });
  } else throw new Error(`unknown chart type ${c.type}`);
  body += label(`Source: ${c.source || 'illustrative, not real data'}`, 20, H - 14, 'start', 11, W - 40);
  return svg(W, H, body);
}

function svg(W, H, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`;
}

// ---------- validation + resolution ----------

/** Problems with a media item's `render` params (unknown template, caption too long, bad chart data). */
export function renderProblems(item) {
  const r = item?.render;
  if (!r) return [];
  const lib = loadLibrary();
  const out = [];
  const textOk = (t, max, name) => {
    if (typeof t !== 'string' || !t.trim()) out.push(`${name} is empty`);
    else if (chars(t) > max) out.push(`${name} is ${chars(t)} chars (max ${max}; rewrite, never truncate)`);
    else if (/https?:|<|>/i.test(t)) out.push(`${name} contains a URL or markup`);
  };
  if (item.kind === 'meme') {
    const t = lib.memes.get(r.template);
    if (!t) return [`unknown meme template "${r.template}"`];
    for (const s of t.slots) if (!s.optional || r.captions?.[s.name]) textOk(r.captions?.[s.name], s.max, `caption "${s.name}"`);
    if (t.layout === 'tweet') {
      if (!r.quote?.text) out.push('tweet-dunk needs render.quote {name, handle, text}');
      if (r.reaction && !lib.memes.get(r.reaction)?.reaction) out.push(`unknown reaction template "${r.reaction}"`);
    }
  } else if (item.kind === 'gif') {
    if (!lib.reactions.has(r.reaction)) return [`unknown reaction "${r.reaction}"`];
    if (r.caption) textOk(r.caption, 40, 'gif caption');
  } else if (item.kind === 'image') {
    if (!lib.art.has(r.art)) return [`unknown art "${r.art}"`];
  } else if (item.kind === 'chart') {
    const c = r.chart ?? {};
    if (!CHART_TYPES.includes(c.type)) out.push(`chart type must be one of ${CHART_TYPES.join('|')}`);
    textOk(c.title, 80, 'chart title');
    if (!Array.isArray(c.labels) || !Array.isArray(c.values) || c.labels.length !== c.values.length) out.push('chart labels/values must be equal-length arrays');
    else {
      if (c.values.length < 2 || c.values.length > 8) out.push('chart needs 2-8 values');
      if (!c.values.every((v) => typeof v === 'number' && Number.isFinite(v))) out.push('chart values must be finite numbers');
      if (c.type !== 'line' && c.values.some((v) => v < 0)) out.push('bar/pie values must be >= 0');
      c.labels.forEach((l, i) => textOk(String(l), 24, `chart label ${i + 1}`));
    }
    if (c.unit != null && chars(c.unit) > 6) out.push('chart unit max 6 chars');
    if (c.source != null) textOk(c.source, 60, 'chart source');
  } else out.push(`render not supported for kind "${item.kind}"`);
  return out;
}

/**
 * Turn a media item with `render` params into its canonical, publishable form:
 * { kind, render, src, width, height, alt, rating, origin, credit? } plus `svg` (not stored).
 * Throws if the params are invalid.
 */
export function resolveMedia(item) {
  const problems = renderProblems(item);
  if (problems.length) throw new Error(problems.join('; '));
  const lib = loadLibrary();
  const r = item.render;
  const base = { kind: item.kind, render: r, rating: item.rating ?? 'pg' };
  const genSrc = (svgText) => `/media/gen/${item.kind}-${hash(JSON.stringify(r)).toString(36)}-${hash(svgText).toString(36)}.svg`;
  if (item.kind === 'image') {
    const a = lib.art.get(r.art);
    return { ...base, src: a.src, width: a.width, height: a.height, alt: item.alt || a.alt, origin: 'commons', credit: creditOf(a) };
  }
  if (item.kind === 'meme') {
    const t = lib.memes.get(r.template);
    const { svg: svgText, width, height } = renderMeme(t, r.captions, { quote: r.quote, reaction: r.reaction });
    const raster = canRaster();
    const src = genSrc(svgText).replace(/\.svg$/, raster ? '.jpg' : '.svg');
    const credit = t.credit ?? (r.reaction ? lib.memes.get(r.reaction)?.credit : undefined);
    return { ...base, src, width, height, alt: item.alt || memeAlt(t, r.captions, r), origin: 'local-render', ...(credit ? { credit } : {}), svg: svgText, ...(raster ? { raster } : {}) };
  }
  if (item.kind === 'gif') {
    const rx = lib.reactions.get(r.reaction), a = lib.art.get(rx.art);
    const svgText = renderReactionSvg(rx, r.caption);
    return { ...base, src: genSrc(svgText), ...svgSize(svgText), alt: item.alt || `Animated reaction (${rx.moods[0]}): ${a.alt}${r.caption ? `. Caption: "${r.caption}"` : ''}`, origin: 'local-render', credit: creditOf(a), svg: svgText };
  }
  const c = r.chart;
  const svgText = renderChartSvg(c);
  const data = c.labels.map((l, i) => `${l}: ${c.values[i]}${c.unit ?? ''}`).join(', ');
  return { ...base, src: genSrc(svgText), ...svgSize(svgText), alt: item.alt || `${c.type} chart, "${c.title}": ${data}. Source: ${c.source || 'illustrative'}`, origin: 'local-render', svg: svgText };
}

function svgSize(s) {
  const m = s.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  return { width: Math.round(Number(m[1])), height: Math.round(Number(m[2])) };
}

/** Write SVG files for every rendered media item into outDir (e.g. dist). Returns { byPost: Map<postId, resolved[]>, written }. */
export function writeMediaFiles(posts, outDir) {
  const byPost = new Map();
  let written = 0;
  for (const p of posts) {
    const items = (Array.isArray(p.media) ? p.media : p.media ? [p.media] : []).filter(Boolean);
    if (!items.length) continue;
    const resolved = items.map((it) => {
      if (!it.render) return it;
      const r = resolveMedia(it);
      if (r.svg) {
        const dest = path.join(outDir, r.src.replace(/^\//, ''));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, r.raster ? rasterizeSvg(r.svg) : r.svg);
        written++;
      }
      delete r.svg;
      delete r.raster;
      return r;
    });
    byPost.set(p.id, resolved);
  }
  return { byPost, written };
}

// ---------- generator hooks ----------

function sample(rand, arr, k) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

/**
 * Decide whether a post gets media and what the LLM must supply. Uses sampler.mediaKind(role)
 * so the corpus follows realism/spec.json. Returns null (no media) or a plan:
 *   { kind, options?, prompt }  -> put `plan.prompt` into the LLM turn, then call materializeMedia(plan, llmJson.media)
 * ctx: { mood?: string, news?: object, giphy?: client from createGiphyClient(), persona?: object (scales
 *   visual kinds by x_behavior.meme_affinity), kind?: force a kind (e.g. the day's guaranteed poll) }
 *   link cards need ctx.news; 'video' is never produced; gifs use GIPHY per spec.sampling.gif_sources
 *   when ctx.giphy is enabled, else the local public-domain reactions.
 */
export function planMedia(sampler, role = 'original', ctx = {}) {
  const kind = ctx.kind ?? sampler.mediaKind(role, ctx.persona ?? null);
  const rand = sampler.rand;
  const lib = loadLibrary();
  if (kind === 'none' || kind === 'video') return null;
  if (kind === 'link_card') return ctx.news ? { kind, prompt: 'Attach the news link as a link card (react to the headline).' } : null;
  if (kind === 'poll') {
    return { kind, prompt: 'Make this post a poll. Add "media": {"options": ["...", "..."]} with 2-4 short options (max 25 chars each). The post text is the question.' };
  }
  if (kind === 'meme') {
    // Shortlist by fit (usage notes / keywords / tone vs. news, mood, persona, dunk target), then the LLM picks.
    const picks = shortlistTemplates({ ...ctx, text: ctx.text ?? ctx.topic?.title }, { n: 5, rand, exclude: ctx.excludeMemes ?? [] });
    const options = picks.map((m) => ({ id: m.id, name: m.name, description: m.usage, slots: m.slots.map(({ name, hint, max }) => ({ name, hint, max })) }));
    const dunk = picks.some((m) => m.layout === 'tweet') ? { quote: ctx.quote, reaction: pickReaction(ctx, rand) } : {};
    return { kind, options, ...dunk, prompt: `Attach a meme. Choose ONE template whose "description" (when to use it) fits your point, and write its captions in your voice (witty, PG, no URLs; follow each slot hint, respect each max length, never truncate). Return "media": {"template": id, "captions": {slot: text}}. Templates: ${JSON.stringify(options)}` };
  }
  if (kind === 'gif') {
    const all = [...lib.reactions.values()];
    const matching = ctx.mood ? all.filter((r) => r.moods.some((m) => m.includes(String(ctx.mood).toLowerCase()))) : [];
    const options = (matching.length ? matching : sample(rand, all, 6)).map((r) => ({ id: r.id, moods: r.moods }));
    const source = sampler.gifSource ? sampler.gifSource() : 'local';
    if (source === 'giphy' && ctx.giphy?.enabled) {
      return { kind, source, options, prompt: `Attach a reaction GIF. Give a 1-4 word GIPHY search query for the reaction you want (an emotion or gesture, e.g. "slow clap", "mind blown"; PG; no names of real living people) plus a fallback from these public-domain reactions. Return "media": {"query": text, "reaction": id}. Fallback options: ${JSON.stringify(options)}` };
    }
    return { kind, source: 'local', options, prompt: `Attach a reaction GIF. Pick the ONE whose mood fits your reply. Optional caption (max 40 chars, PG). Return "media": {"reaction": id, "caption"?: text}. Options: ${JSON.stringify(options)}` };
  }
  if (kind === 'image') {
    const options = sample(rand, [...lib.art.values()], 5).map((a) => ({ id: a.id, title: a.title, artist: a.artist, tags: a.tags }));
    return { kind, options, prompt: `Attach a painting as the post's picture. Pick the ONE that fits (or is wryly apt). Return "media": {"art": id}. Options: ${JSON.stringify(options)}` };
  }
  if (kind === 'chart') {
    return { kind, prompt: `Attach a simple chart. Return "media": {"type": "bar"|"hbar"|"line"|"pie", "title": max 80 chars, "labels": [2-8 short labels], "values": [numbers], "unit"?: max 6 chars, "source"?: citation}. Only use real figures when you name a real source; otherwise it is labelled "illustrative" — keep it obviously playful (e.g. "time spent: thinking vs. doing").` };
  }
  return null;
}

/**
 * Validate the LLM's media answer for a plan and return the post.media item (without svg).
 * Async because GIPHY plans search at generation time; on any GIPHY miss it falls back to the local reaction.
 * Throws on invalid input. opts: { giphy?: client, rand?: () => number }
 */
export async function materializeMedia(plan, fill = {}, { giphy = null, rand = Math.random } = {}) {
  if (!plan) return null;
  if (plan.kind === 'gif' && plan.source === 'giphy' && giphy && fill.query) {
    const hit = await giphy.search(fill.query, { rand });
    if (hit) return hit;
  }
  if (plan.kind === 'link_card') return null; // the generator renders link cards from post.news
  if (plan.kind === 'poll') {
    const options = (fill.options ?? []).map(String);
    if (options.length < 2 || options.length > 4 || options.some((o) => !o.trim() || chars(o) > 25)) throw new Error('poll needs 2-4 options of max 25 chars');
    return { kind: 'poll', options };
  }
  const allowed = new Set((plan.options ?? []).map((o) => o.id));
  const pickId = fill.template ?? fill.reaction ?? fill.art;
  if (plan.options && !allowed.has(pickId)) throw new Error(`"${pickId}" is not one of the offered options`);
  const render = plan.kind === 'meme' ? { template: fill.template, captions: fill.captions ?? {}, ...(fill.template === 'tweet-dunk' ? { quote: plan.quote, reaction: fill.reaction ?? plan.reaction } : {}) }
    : plan.kind === 'gif' ? { reaction: fill.reaction, ...(fill.caption ? { caption: String(fill.caption) } : {}) }
      : plan.kind === 'image' ? { art: fill.art }
        : { chart: { type: fill.type, title: fill.title, labels: fill.labels, values: fill.values, ...(fill.unit ? { unit: fill.unit } : {}), ...(fill.source ? { source: fill.source } : {}) } };
  const { svg: _svg, raster: _raster, ...item } = resolveMedia({ kind: plan.kind, render });
  return item;
}
