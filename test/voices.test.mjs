import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas } from '../src/lib/data.mjs';
import { listSites, siteDir } from '../src/lib/site.mjs';
import { closestVoices, dayAttribution, styleFeatures, voiceAttributionConfig, voiceProblems, trigrams, cosine } from '../src/lib/voices.mjs';

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

test('fingerprinted packs: each recent day is attributable to its authors well above chance (same measure as the day gate)', () => {
  for (const s of fingerprinted()) {
    const spec = JSON.parse(fs.readFileSync(path.join(siteDir(s.id), 'realism', 'spec.json'), 'utf8'));
    const cfg = voiceAttributionConfig(spec);
    assert.ok(cfg, `site ${s.id}: fingerprinted packs must set realism/spec.json voice_attribution`);
    const dir = path.join(siteDir(s.id), 'content', 'posts');
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const byFile = new Map(files.map((f) => [f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).posts ?? []]));
    const all = [...byFile.values()].flat();
    const days = files.filter((f) => /^daily-\d{4}-\d{2}-\d{2}(-cf)?\.json$/.test(f)).slice(-cfg.recent_days);
    for (const f of days) {
      // Exactly what scripts/realism.mjs --file passes to gateDay: the file's posts, everything else as context.
      const day = byFile.get(f);
      const ids = new Set(day.map((p) => p.id));
      const r = dayAttribution(day, all.filter((p) => !ids.has(p.id)), cfg);
      if (r.n < cfg.min_items) continue;
      assert.ok(r.lift >= cfg.min_lift, `site ${s.id} ${f}: attribution lift ${r.lift.toFixed(1)}× chance (${(r.accuracy * 100).toFixed(1)}% of ${r.n} over ${r.authors} authors) < ${cfg.min_lift}`);
    }
  }
});

test('voice attribution: a day where everyone writes in the same voice fails, a distinct-voice day passes', () => {
  const cfg = { window_days: 30, min_letters: 20, min_context_items: 6 };
  const voices = {
    rashi: (i) => `ד״ה ${['פשוטו', 'מדרשו', 'לשונו'][i % 3]} של מקרא, כמו לשון עצירה ${i}. ודו״ק היטב בפירוש`,
    bro: (i) => `יאללה אחי חחחח סבבה ${i} תכלס זה הכי טוב בעולם 🔥🔥`,
    judge: (i) => `📐 תוצאה: בית הלל ${i}, בית שמאי ${i + 1}. אחרי רבים להטות, לא בשמים היא`,
    poet: (i) => `And the evening ${i} falls softly on the sleeping town; I count the quiet stars alone`,
    prof: (i) => `Three points on item ${i}: first, the data; second, the method; third — the conclusion.`,
  };
  const ids = Object.keys(voices);
  const t0 = Date.parse('2026-11-01T00:00:00Z');
  const post = (a, i, t, text) => ({ id: `${a}-${t}-${i}`, authorId: a, text, createdAt: new Date(t0 + t * 36e5 + i * 6e4).toISOString() });
  const context = ids.flatMap((a) => Array.from({ length: 10 }, (_, i) => post(a, i, i, voices[a](i))));
  const day = ids.flatMap((a) => Array.from({ length: 5 }, (_, i) => post(a, i, 400, voices[a](i + 20))));
  const sameVoice = ids.flatMap((a) => Array.from({ length: 5 }, (_, i) => post(a, i, 400, voices.bro(i + 20))));
  const good = dayAttribution(day, context, cfg);
  const flat = dayAttribution(sameVoice, context, cfg);
  assert.equal(good.authors, 5);
  assert.ok(good.lift >= 4.5, `distinct voices: lift ${good.lift}`);
  assert.ok(flat.lift <= 1, `same voice: lift ${flat.lift}`);
  // Hebrew normalisation: clitic prefixes, final letters and niqqud don't split a word's features.
  const f = styleFeatures('וּבְשָׁלוֹם');
  assert.ok(f.has('wשלומ') && f.has('pוב'));
  // Emoji/one-word replies carry no voice and are not scored.
  assert.equal(dayAttribution([post('bro', 0, 400, '🔥🔥 סבבה')], context, cfg).n, 0);
});

test('voice attribution: on the real corpus a recent day passes and the same day with shuffled authors / one voice fails', () => {
  for (const s of fingerprinted()) {
    const spec = JSON.parse(fs.readFileSync(path.join(siteDir(s.id), 'realism', 'spec.json'), 'utf8'));
    const cfg = voiceAttributionConfig(spec);
    const dir = path.join(siteDir(s.id), 'content', 'posts');
    if (!cfg || !fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => /^daily-.*\.json$/.test(f)).sort();
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).posts ?? []);
    const f = files.at(-1);
    if (!f) continue;
    const day = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).posts ?? [];
    const ids = new Set(day.map((p) => p.id));
    const context = all.filter((p) => !ids.has(p.id));
    const real = dayAttribution(day, context, cfg);
    if (real.n < cfg.min_items) continue;
    // Shuffled: every text kept, but posted by a different persona (deterministic rotation).
    const authors = day.map((p) => p.authorId);
    const shuffled = day.map((p, i) => ({ ...p, authorId: authors[(i * 7 + 3) % authors.length] }));
    // One voice: every persona posts the text of the day's most active persona.
    const counts = new Map();
    for (const p of day) if (p.text && p.text.length > 40) counts.set(p.authorId, (counts.get(p.authorId) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const texts = day.filter((p) => p.authorId === top && p.text?.length > 40).map((p) => p.text);
    const oneVoice = day.map((p, i) => ({ ...p, text: p.text ? texts[i % texts.length] : p.text }));
    const sh = dayAttribution(shuffled, context, cfg);
    const ov = dayAttribution(oneVoice, context, cfg);
    assert.ok(real.lift >= cfg.min_lift, `site ${s.id} ${f}: real lift ${real.lift.toFixed(1)}`);
    assert.ok(sh.lift < cfg.min_lift, `site ${s.id} ${f}: shuffled authors still pass (lift ${sh.lift.toFixed(1)})`);
    assert.ok(ov.lift < cfg.min_lift, `site ${s.id} ${f}: one-voice day still passes (lift ${ov.lift.toFixed(1)})`);
  }
});

test('trigram cosine separates different registers', () => {
  const rashi = trigrams('ד״ה פשוטו של מקרא, כמו לשון עצירה. ודו״ק');
  const same = trigrams('פשוטו של מקרא: כמו לשון הפסקה');
  const other = trigrams('יאללה אחי חחחח סבבה');
  assert.ok(cosine(rashi, same) > cosine(rashi, other));
});
