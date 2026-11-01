#!/usr/bin/env node
// Fetch the public-domain/CC0 art listed in media/library.json from Wikimedia Commons
// into public/media/art/<id>.jpg and record verified credits in media/art-credits.json.
// Run once (and when adding art): npm run media:fetch [-- --force]
// Commons API usage is free; a descriptive User-Agent is required by Wikimedia policy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = JSON.parse(fs.readFileSync(path.join(ROOT, 'media', 'library.json'), 'utf8'));
const OUT = path.join(ROOT, 'public', 'media', 'art');
const CREDITS = path.join(ROOT, 'media', 'art-credits.json');
const UA = { 'User-Agent': 'TaikuMediaFetcher/0.1 (https://taiku.app; hobby, non-commercial)' };
// Commons only serves standard thumbnail widths (https://w.wiki/GHai); 500px keeps files ~50-100 KB.
const WIDTH = 500;
const force = process.argv.includes('--force');

function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('not a JPEG');
}
const strip = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const credits = fs.existsSync(CREDITS) ? JSON.parse(fs.readFileSync(CREDITS, 'utf8')) : {};
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const art of LIB.art) {
  const dest = path.join(OUT, `${art.id}.jpg`);
  if (!force && fs.existsSync(dest) && credits[art.id]) continue;
  const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata|size|mime'
    + `&iiurlwidth=${WIDTH}&titles=${encodeURIComponent(art.file)}`;
  const page = Object.values((await (await fetch(api, { headers: UA })).json()).query?.pages ?? {})[0];
  const ii = page?.imageinfo?.[0];
  const m = ii?.extmetadata ?? {};
  const license = m.LicenseShortName?.value ?? '';
  if (!ii) { console.error(`✗ ${art.id}: not found (${art.file})`); failed++; continue; }
  if (!LIB.allowed_licenses.some((l) => license.toLowerCase() === l.toLowerCase())) {
    console.error(`✗ ${art.id}: license "${license}" not allowed`); failed++; continue;
  }
  const thumb = ii.thumburl.replace(/\/\d+px-([^/?]+)/, `/${WIDTH}px-$1`);
  const res = await fetch(thumb, { headers: UA });
  if (!res.ok || !/^image\/jpe?g/.test(res.headers.get('content-type') ?? '')) {
    console.error(`✗ ${art.id}: download failed (${res.status} ${res.headers.get('content-type')})`); failed++; continue;
  }
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  credits[art.id] = {
    src: `/media/art/${art.id}.jpg`,
    ...jpegSize(fs.readFileSync(dest)),
    author: `${art.artist}${art.year ? ` (${art.year})` : ''}`,
    commons_artist: strip(m.Artist?.value).slice(0, 120),
    license,
    url: ii.descriptionurl,
  };
  console.log(`✓ ${art.id} ${credits[art.id].width}x${credits[art.id].height} ${license}`);
  await new Promise((r) => setTimeout(r, 300));
}
const sorted = Object.fromEntries(Object.keys(credits).sort().map((k) => [k, credits[k]]));
fs.writeFileSync(CREDITS, JSON.stringify(sorted, null, 2) + '\n');
if (failed) { console.error(`${failed} item(s) failed`); process.exit(1); }
