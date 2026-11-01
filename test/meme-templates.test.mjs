import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/site.mjs';
import { loadTemplates } from '../src/lib/meme-render.mjs';
import { shortlistTemplates, pickTemplate, pickReaction } from '../src/lib/meme-select.mjs';

const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'memes', 'templates.json'), 'utf8'));
const LAYOUTS = ['top-bottom', 'boxes', 'caption-bar', 'tweet'];

test('meme library: 60-120 templates with unique ids, usage notes, license notes and credited images', () => {
  const list = raw.templates;
  assert.ok(list.length >= 60 && list.length <= 120, `${list.length} templates`);
  assert.equal(new Set(list.map((t) => t.id)).size, list.length, 'unique ids');
  for (const t of list) {
    assert.match(t.id, /^[a-z0-9-]+$/, t.id);
    assert.ok(t.name && t.usage && t.usage.length >= 20, `${t.id}: name + usage ("when to use")`);
    assert.ok(LAYOUTS.includes(t.layout), `${t.id}: layout ${t.layout}`);
    assert.ok(Array.isArray(t.tone) && t.tone.length, `${t.id}: tone`);
    assert.ok(Array.isArray(t.keywords), `${t.id}: keywords`);
    assert.ok(typeof t.license_note === 'string' && t.license_note.length > 10, `${t.id}: license_note`);
    assert.ok(typeof t.public_domain === 'boolean', `${t.id}: public_domain flag`);
    assert.equal(t.captions, t.slots.length, `${t.id}: captions = number of slots`);
    assert.ok(t.slots.length >= 1 && t.slots.length <= 6);
    const names = new Set();
    for (const s of t.slots) {
      assert.ok(s.name && !names.has(s.name), `${t.id}: slot names unique`);
      names.add(s.name);
      assert.ok(s.hint && Number.isInteger(s.max) && s.max >= 12 && s.max <= 140, `${t.id}/${s.name}: hint + max`);
      assert.ok(['impact', 'plain'].includes(s.style ?? 'impact'), `${t.id}/${s.name}: style`);
      if ((t.layout === 'top-bottom' || t.layout === 'boxes') && (t.layout === 'boxes' || s.x != null)) {
        for (const k of ['x', 'y', 'w', 'h']) assert.ok(s[k] >= 0 && s[k] <= 1, `${t.id}/${s.name}: ${k} is a 0-1 fraction`);
        assert.ok(s.x + s.w <= 1.001 && s.y + s.h <= 1.001, `${t.id}/${s.name}: box inside the image`);
      }
    }
    if (t.layout === 'tweet') continue;
    assert.match(t.source_url, /^https:\/\//, `${t.id}: source_url recorded`);
    assert.ok(t.credit?.license && t.credit?.url, `${t.id}: credit`);
    assert.ok(t.width > 0 && t.height > 0, `${t.id}: size`);
    if (t.image) assert.ok(fs.existsSync(path.join(ROOT, t.image)), `${t.id}: ${t.image} cached in the repo`);
    else assert.ok(t.art, `${t.id}: image or art`);
  }
  assert.ok(list.filter((t) => t.public_domain).length >= 30, 'public-domain art/history is well represented');
  assert.ok(list.filter((t) => t.reaction).length >= 10, 'enough reaction images for tweet dunks');
});

test('every template in the file loads, and legacy ids keep working', () => {
  const { templates } = loadTemplates();
  assert.equal(templates.size, raw.templates.length);
  for (const id of ['drake-like', 'scream-when', 'democritus-laughs', 'plato-vs-aristotle', 'diogenes-searching', 'pollice-verso-verdict', 'tweet-dunk']) {
    if (raw.templates.some((t) => t.id === id)) assert.ok(templates.has(id), id);
  }
});

test('selector: fitting templates rank first, exclusions hold, dunks are offered only with a quote', () => {
  const ctx = { text: 'choosing a shiny new idea over my loyal old one', mood: 'mocking' };
  const short = shortlistTemplates(ctx, { n: 5, rand: () => 0.5 });
  assert.equal(short.length, 5);
  assert.ok(short.every((t) => t.layout !== 'tweet'), 'no tweet-dunk without a quote');
  assert.ok(short.some((t) => t.id === 'distracted-boyfriend'), short.map((t) => t.id).join());
  const ex = shortlistTemplates(ctx, { n: 5, rand: () => 0.5, exclude: ['distracted-boyfriend'] });
  assert.ok(!ex.some((t) => t.id === 'distracted-boyfriend'));
  const dunk = shortlistTemplates({ ...ctx, quote: { name: 'Kant', handle: 'k', text: 'Not everything is a scheme' } }, { n: 5, rand: () => 0.5 });
  assert.equal(dunk[0].id, 'tweet-dunk');
  assert.ok(raw.templates.find((t) => t.id === pickReaction({ text: 'laughing at this' }, () => 0.5))?.reaction);
  assert.ok(pickTemplate('everything is fine, the house is on fire'));
});
