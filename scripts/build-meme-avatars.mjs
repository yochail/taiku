#!/usr/bin/env node
// Convert the site's persona avatars (sites/<id>/public/avatars/<p>-96.webp) to small JPEGs in sites/<id>/assets/memes/avatars/
// for the tweet-screenshot meme (the build-time rasteriser, resvg, cannot decode WebP).
// Dev-only, run after adding personas: npm install --no-save sharp && node scripts/build-meme-avatars.mjs
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sitePath } from '../src/lib/site.mjs';

const OUT = sitePath('assets', 'memes', 'avatars');
const sharp = (await import('sharp')).default;
fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(sitePath('personas')).filter((x) => x.endsWith('.json'))) {
  const p = JSON.parse(fs.readFileSync(sitePath('personas', f), 'utf8'));
  const src = p.avatar?.srcset?.['96'] ?? p.avatar?.image;
  if (!src) continue;
  const rel = src.replace(/^\//, '');
  const file = [sitePath('public', rel), path.join(ROOT, 'public', rel)].find((x) => fs.existsSync(x));
  if (!file) continue;
  await sharp(file).resize(96, 96, { fit: 'cover' }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toFile(path.join(OUT, `${p.id}.jpg`));
  n++;
}
console.log(`✓ ${n} avatars`);
