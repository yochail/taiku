import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas } from '../src/lib/data.mjs';
import { listSites, siteDir } from '../src/lib/site.mjs';
import { closestVoices, attributionAccuracy, voiceProblems, trigrams, cosine } from '../src/lib/voices.mjs';

// Packs opt in by giving any persona a voice.idiolect; then every persona in that pack must have one.
const fingerprinted = () => listSites()
  .map((id) => ({ id, personas: loadPersonas(path.join(siteDir(id), 'personas')) }))
  .filter((s) => s.personas.some((p) => p.voice?.idiolect));

test('fingerprinted packs: every persona has register, idiolect and 3-5 sample phrases', () => {
  for (const s of fingerprinted()) {
    const bad = s.personas.map((p) => [p.id, voiceProblems(p)]).filter(([, e]) => e.length);
    assert.deepEqual(bad, [], `site ${s.id}`);
  }
});

test('fingerprinted packs: no two personas share a voice fingerprint (char-trigram cosine < 0.5)', () => {
  for (const s of fingerprinted()) {
    const [top] = closestVoices(s.personas);
    assert.ok(!top || top.cos < 0.5, `site ${s.id}: @${top?.a} and @${top?.b} sound alike (cos ${top?.cos.toFixed(2)})`);
  }
});

test('fingerprinted packs: posts are attributable to their author well above chance', () => {
  for (const s of fingerprinted()) {
    const dir = path.join(siteDir(s.id), 'content', 'posts');
    if (!fs.existsSync(dir)) continue;
    const posts = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
      .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).posts ?? []);
    const r = attributionAccuracy(posts);
    if (r.authors < 10) continue;
    // chance is 1/authors (~1%); a corpus where everyone sounds alike scores in the single digits.
    assert.ok(r.accuracy >= 0.3, `site ${s.id}: nearest-centroid attribution ${(r.accuracy * 100).toFixed(1)}% over ${r.authors} authors`);
  }
});

test('trigram cosine separates different registers', () => {
  const rashi = trigrams('ד״ה פשוטו של מקרא, כמו לשון עצירה. ודו״ק');
  const same = trigrams('פשוטו של מקרא: כמו לשון הפסקה');
  const other = trigrams('יאללה אחי חחחח סבבה');
  assert.ok(cosine(rashi, same) > cosine(rashi, other));
});
