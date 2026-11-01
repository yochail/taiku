import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEME_W, loadTemplates, renderMeme, memeAlt, canRaster, rasterizeSvg, jpegSize } from '../src/lib/meme-render.mjs';

const { templates } = loadTemplates();
const longText = (max) => ('Tom & "Jerry" argue about the categorical imperative over breakfast again ' + 'and again '.repeat(20)).slice(0, max).trim();
const quote = { persona: 'kant', name: 'Immanuel Kant', handle: 'kant_stop_wont', text: 'Not everything is a scheme, Niccolò!! I walk at half past three because reason, not habit, demands it. '.repeat(2).slice(0, 270) };
const byLayout = (layout) => [...templates.values()].filter((t) => t.layout === layout);
const inside = (b, W, H) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= W + 0.5 && b.y + b.h <= H + 0.5;

function renderAtMax(t) {
  const captions = Object.fromEntries(t.slots.map((s) => [s.name, longText(s.max)]));
  const opts = t.layout === 'tweet' ? { quote, reaction: 'democritus-laughs' } : {};
  return { captions, opts, out: renderMeme(t, captions, opts) };
}

for (const layout of ['top-bottom', 'boxes', 'caption-bar', 'tweet']) {
  test(`${layout} memes: fixed width, sane height, every caption fits inside the canvas at max length`, () => {
    const list = byLayout(layout);
    assert.ok(list.length, `at least one ${layout} template`);
    for (const t of list) {
      const { out } = renderAtMax(t);
      assert.equal(out.width, MEME_W, t.id);
      assert.ok(out.height > 200 && out.height < 2400, `${t.id} height ${out.height}`);
      assert.match(out.svg, new RegExp(`^<svg xmlns="http://www\\.w3\\.org/2000/svg"[^>]* width="${MEME_W}" height="${out.height}"`));
      assert.doesNotMatch(out.svg, /<script|on\w+=|href="http/i, t.id);
      for (const b of out.boxes) {
        assert.equal(b.overflow, false, `${t.id}/${b.slot} overflows`);
        assert.ok(b.size >= 10, `${t.id}/${b.slot} font ${b.size}px is unreadable`);
        if (b.box) assert.ok(inside(b.box, out.width, out.height), `${t.id}/${b.slot} box outside canvas`);
      }
    }
  });
}

test('classic captions use the Impact-style font (white fill, black stroke, uppercase); caption bars use plain black text', () => {
  const tb = renderMeme(templates.get('one-does-not-simply') ?? byLayout('top-bottom')[0], { top: 'one does not simply', bottom: 'refute Zeno' });
  assert.match(tb.svg, /fill="#fff" stroke="#000"/);
  assert.match(tb.svg, /paint-order="stroke fill"/);
  const bar = renderMeme(templates.get('scream-when'), { caption: 'when the dream analysis reaches your mother in minute two' });
  assert.match(bar.svg, /fill="#0f1419"/);
  assert.ok(bar.boxes[0].lines.length >= 1 && bar.boxes[0].lines.length <= 4);
});

test('short captions get bigger text than long ones (auto-fit)', () => {
  const t = templates.get('one-does-not-simply');
  const a = renderMeme(t, { top: 'me', bottom: 'ok' }).boxes[0].size;
  const b = renderMeme(t, { top: longText(t.slots[0].max), bottom: 'ok' }).boxes[0].size;
  assert.ok(a > b, `${a} > ${b}`);
});

test('tweet-screenshot dunk: card with name, handle and quoted text, then the reaction', () => {
  const t = templates.get('tweet-dunk');
  const out = renderMeme(t, { caption: 'his 3:30 walk, every day' }, { quote, reaction: 'roll-safe' });
  const solo = renderMeme(t, {}, { quote });
  assert.ok(out.height > solo.height, 'the reaction image adds height');
  assert.match(out.svg, /stroke="#cfd9de"/);
  const alt = memeAlt(t, { caption: 'his 3:30 walk, every day' }, { quote, reaction: 'roll-safe' });
  assert.match(alt, /Immanuel Kant/);
  assert.match(alt, /his 3:30 walk/);
});

test('raster output is a JPEG of exactly the declared size', { skip: !canRaster() && 'resvg/jpeg-js not installed (optional)' }, () => {
  const out = renderMeme(templates.get('drake'), { no: 'reading the primary sources', yes: 'quoting the meme' });
  const jpg = rasterizeSvg(out.svg);
  assert.deepEqual(jpegSize(jpg), { width: out.width, height: out.height });
});
