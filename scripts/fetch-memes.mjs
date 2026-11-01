#!/usr/bin/env node
// Download + cache the meme template images listed in assets/memes/templates.json into
// assets/memes/img/<id>.jpg (normalised to <= MAX_W px wide JPEG) and record width/height,
// source URL and (for Wikimedia Commons art) the verified license/credit.
// Run when adding templates: npm run memes:fetch [-- --force]
// Sources: memegen (https://github.com/jacebrowning/memegen, blank images via api.memegen.link)
// and public-domain paintings from Wikimedia Commons (descriptive User-Agent required).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rasterizeSvg, jpegSize } from '../src/lib/meme-render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'assets', 'memes', 'templates.json');
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'media', 'library.json'), 'utf8'));
const UA = { 'User-Agent': 'TaikuMediaFetcher/0.1 (https://taiku.app; hobby, non-commercial)' };
const MAX_W = 640;
const force = process.argv.includes('--force');
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Re-encode to a reasonably small JPEG (cap width) so the repo stays light.
function normalise(buf) {
  const { width, height } = jpegSize(buf);
  if (width <= MAX_W && buf.length < 160_000) return buf;
  const w = Math.min(width, MAX_W);
  const h = Math.round((height * w) / width);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}">`
    + `<image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${buf.toString('base64')}"/></svg>`;
  return rasterizeSvg(svg, 78);
}

let failed = 0;
for (const t of data.templates) {
  if (!t.image) continue;
  const dest = path.join(ROOT, t.image);
  try {
    if (force || !fs.existsSync(dest)) {
      let url = t.source_url;
      if (t.source === 'commons') {
        const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime'
          + `&iiurlwidth=960&titles=${encodeURIComponent(t.commons_file)}`;
        const page = Object.values((await (await fetch(api, { headers: UA })).json()).query?.pages ?? {})[0];
        const ii = page?.imageinfo?.[0];
        if (!ii) throw new Error(`not found on Commons (${t.commons_file})`);
        const m = ii.extmetadata ?? {};
        const license = m.LicenseShortName?.value ?? '';
        if (!LIB.allowed_licenses.some((l) => license.toLowerCase() === l.toLowerCase())) throw new Error(`license "${license}" not allowed`);
        const artist = strip(m.Artist?.value).slice(0, 80);
        const title = strip(m.ObjectName?.value).slice(0, 100) || t.name;
        url = ii.thumburl;
        t.source_url = ii.thumburl;
        t.origin_url = ii.descriptionurl;
        t.license_note = `Public-domain painting: ${title}, ${artist} (${license}, Wikimedia Commons).`;
        t.credit = { author: artist, license, url: ii.descriptionurl, title };
      }
      const res = await fetch(url, { headers: UA });
      if (!res.ok || !/^image\/jpe?g/.test(res.headers.get('content-type') ?? '')) throw new Error(`download failed (${res.status} ${res.headers.get('content-type')})`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      await new Promise((r) => setTimeout(r, 300));
    }
    const buf = normalise(fs.readFileSync(dest));
    fs.writeFileSync(dest, buf);
    Object.assign(t, jpegSize(buf));
    console.log(`✓ ${t.id} ${t.width}x${t.height} ${Math.round(buf.length / 1024)}KB`);
  } catch (e) {
    console.error(`✗ ${t.id}: ${e.message}`);
    failed++;
  }
}
const order = ['id', 'name', 'source', 'source_id', 'commons_file', 'art', 'source_url', 'origin_url', 'image', 'width', 'height', 'public_domain', 'license_note', 'credit'];
data.templates = data.templates.map((t) => Object.fromEntries([...order.filter((k) => k in t), ...Object.keys(t).filter((k) => !order.includes(k))].map((k) => [k, t[k]])));
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
if (failed) { console.error(`${failed} template(s) failed`); process.exit(1); }
