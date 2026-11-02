#!/usr/bin/env node
// Extract glyph outlines + metrics from the self-hosted OFL meme fonts (assets/memes/fonts/src/*.woff,
// Fontsource subsets of Anton, Inter and Heebo) into compact JSON, so meme text renders as SVG paths with
// zero runtime dependencies and looks identical everywhere. Dev-only (needs opentype.js):
//   npm install && node scripts/build-meme-fonts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets', 'memes', 'fonts');
const ot = (await import('opentype.js')).default;

const FONTS = {
  anton: ['anton-latin-400-normal', 'anton-latin-ext-400-normal'],
  'inter-regular': ['inter-latin-400-normal', 'inter-latin-ext-400-normal', 'inter-greek-400-normal', 'inter-cyrillic-400-normal'],
  'inter-bold': ['inter-latin-700-normal', 'inter-latin-ext-700-normal', 'inter-greek-700-normal', 'inter-cyrillic-700-normal'],
  // Hebrew fallbacks merged into the fonts above at render time (meme-render.mjs FALLBACK).
  'heebo-regular': ['heebo-hebrew-400-normal'],
  'heebo-bold': ['heebo-hebrew-700-normal'],
  'heebo-black': ['heebo-hebrew-900-normal'],
};
// Hebrew letters + punctuation (maqaf, sof pasuq, geresh, gershayim); points/cantillation are dropped.
const HEBREW = (cp) => cp === 0x05be || cp === 0x05c0 || cp === 0x05c3 || cp === 0x05c6 || (cp >= 0x05d0 && cp <= 0x05f4);
const KERN_CHARS = [...' !"\'(),-./0123456789:;?ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz‘’“”…'];

for (const [name, files] of Object.entries(FONTS)) {
  const out = { name, license: 'SIL Open Font License 1.1 (see OFL-*.txt)', unitsPerEm: 0, ascender: 0, descender: 0, capHeight: 0, glyphs: {}, kern: {} };
  for (const file of files) {
    const buf = fs.readFileSync(path.join(DIR, 'src', `${file}.woff`));
    const f = ot.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    if (!out.unitsPerEm) Object.assign(out, { unitsPerEm: f.unitsPerEm, ascender: f.ascender, descender: f.descender, capHeight: f.tables.os2?.sCapHeight ?? Math.round(f.ascender * 0.7) });
    for (const [code, idx] of Object.entries(f.tables.cmap.glyphIndexMap)) {
      const ch = String.fromCodePoint(Number(code));
      const cp = Number(code);
      // Latin/Greek/Cyrillic + punctuation, currency, arrows; keeps the JSON small.
      const keep = name.startsWith('heebo') ? HEBREW(cp) : (cp >= 32 && cp <= 0x052f) || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x2000 && cp <= 0x20cf) || cp === 0x2122 || (cp >= 0x2190 && cp <= 0x2193);
      if (out.glyphs[ch] || !keep) continue;
      const g = f.glyphs.get(idx);
      out.glyphs[ch] = [Math.round(g.advanceWidth), g.getPath(0, 0, f.unitsPerEm).toPathData(0)];
    }
    const kt = f.position?.getKerningTables?.('latn');
    if (kt) {
      for (const a of KERN_CHARS) for (const b of KERN_CHARS) {
        const ga = f.charToGlyph(a), gb = f.charToGlyph(b);
        if (!ga?.index || !gb?.index) continue;
        const k = f.position.getKerningValue(kt, ga.index, gb.index);
        if (k) out.kern[a + b] = k;
      }
    }
  }
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(out));
  console.log(`✓ ${name}: ${Object.keys(out.glyphs).length} glyphs, ${Object.keys(out.kern).length} kerning pairs`);
}
