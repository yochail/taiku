import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTemplates, renderMeme, font, supported, textPath, visualOrder, isRtl } from '../src/lib/meme-render.mjs';
import { listSites, siteDir } from '../src/lib/site.mjs';

const { templates } = loadTemplates();
const HEB = /[\u05d0-\u05ea]/g;
const hebrewOf = (s) => (String(s).match(HEB) || []).join('');

function storedMemes() {
  const out = [];
  for (const site of listSites()) {
    const id = typeof site === 'string' ? site : site.id;
    const dir = path.join(siteDir(id), 'content', 'posts');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      for (const p of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).posts || []) {
        for (const m of p.media || []) if (m.kind === 'meme' && m.render) out.push({ site: id, post: p.id, render: m.render });
      }
    }
  }
  return out;
}

test('every meme font draws all Hebrew letters (Heebo fallback merged)', () => {
  const alef = 'אבגדהוזחטיכךלמםנןסעפףצץקרשת';
  for (const name of ['anton', 'inter-regular', 'inter-bold']) {
    const f = font(name);
    assert.equal(supported(f, alef), alef, name);
    for (const ch of alef) assert.ok(f.glyphs[ch]?.[1], `${name} has an outline for ${ch}`);
  }
});

test('bidi: Hebrew lines are drawn right-to-left, numbers and Latin stay LTR', () => {
  assert.equal(isRtl('שלום world'), true);
  assert.equal(isRtl('hello שלום'), false);
  assert.equal(visualOrder('אבג', true), 'גבא');
  assert.equal(visualOrder('ערב שבת,', true), ',תבש ברע');
  assert.equal(visualOrder('עד 14:00', true), '14:00 דע');
  assert.equal(visualOrder('(אב)', true), '(בא)');
  assert.equal(visualOrder('Plain English (no change)', false), 'Plain English (no change)');
});

test('stored memes with Hebrew captions render every caption with non-empty glyph paths', () => {
  const heb = storedMemes().filter((m) => Object.values(m.render.captions || {}).some((c) => hebrewOf(c)));
  if (listSites().some((s) => (s.id ?? s) === 'tarya')) assert.ok(heb.length > 0, 'tarya has Hebrew memes to check');
  for (const m of heb) {
    const t = templates.get(m.render.template);
    assert.ok(t, `${m.post}: template ${m.render.template}`);
    const base = renderMeme(t, {}, {}).svg;
    for (const [slot, cap] of Object.entries(m.render.captions)) {
      if (!hebrewOf(cap)) continue;
      for (const name of ['anton', 'inter-regular']) {
        const f = font(name);
        assert.equal(hebrewOf(supported(f, cap)), hebrewOf(cap), `${m.site}/${m.post} ${slot}: ${name} drops Hebrew`);
        const d = textPath(f, [hebrewOf(cap)], { size: 40, lh: 1.2, x: 0, y: 0, w: 4000 });
        assert.ok(d.length > hebrewOf(cap).length * 10, `${m.post} ${slot}: empty path in ${name}`);
      }
      const one = renderMeme(t, { [slot]: cap }, {}).svg;
      assert.ok(one.length > base.length + hebrewOf(cap).length * 20, `${m.site}/${m.post} ${slot}: caption renders empty`);
    }
  }
});
