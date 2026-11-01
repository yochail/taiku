import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateSchema } from '../src/lib/schema.mjs';
import { schemaAllowsGiphy, toSchemaMedia } from '../src/lib/gen-media.mjs';
import { mediaProblems, loadSpec } from '../src/lib/realism.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../schemas/post.schema.json', import.meta.url), 'utf8'));
// the exact shape src/lib/giphy.mjs toItem() returns
const giphyItem = {
  kind: 'gif', origin: 'giphy', giphy_id: 'l3q2K5jinAlChoCLS', src: 'https://media2.giphy.com/media/l3q2K5jinAlChoCLS/200w.gif',
  width: 200, height: 150, alt: 'Reaction GIF: slow clap', rating: 'g',
  credit: { author: 'GIPHY', license: 'GIPHY Terms of Service', url: 'https://giphy.com/gifs/l3q2K5jinAlChoCLS' },
  attribution: 'Powered by GIPHY',
};
const post = (media) => ({ id: 'g1', authorId: 'diogenes', type: 'reply', text: '', inReplyTo: 'x', createdAt: '2026-10-20T10:13:00Z', media: [media] });

test('GIPHY media: post schema stores giphy_id + attribution; generator keeps them', () => {
  assert.ok(schemaAllowsGiphy());
  assert.deepEqual(toSchemaMedia(giphyItem), giphyItem);
  assert.deepEqual(mediaProblems(giphyItem, loadSpec().media_policy), []);
  assert.deepEqual(validateSchema(post(giphyItem), schema).filter((e) => /media/.test(e)), []);
  assert.ok(validateSchema(post({ ...giphyItem, attribution: 'via GIPHY' }), schema).some((e) => /attribution/.test(e)));
  assert.ok(validateSchema(post({ ...giphyItem, giphy_id: 'bad id/..' }), schema).some((e) => /giphy_id/.test(e)));
});
