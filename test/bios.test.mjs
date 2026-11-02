import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadPersonas, bioProblems } from '../src/lib/data.mjs';
import { listSites, siteDir } from '../src/lib/site.mjs';

test('bios are X-style self-written profiles in every site pack', () => {
  for (const id of listSites()) {
    const bad = loadPersonas(path.join(siteDir(id), 'personas')).map((p) => [p.id, bioProblems(p)]).filter(([, e]) => e.length);
    assert.deepEqual(bad, [], `site ${id}`);
  }
});

test('bioProblems flags wiki-style bios', () => {
  assert.ok(bioProblems({ bio: 'משורר עברי (1873–1934). היה המשורר הלאומי.' }).length >= 2);
  assert.ok(bioProblems({ bio: 'נולד בבוצ׳אץ׳ וזכה בפרס נובל.' }).length);
  assert.ok(bioProblems({ bio: 'x'.repeat(161) }).length);
  assert.ok(bioProblems({ bio: 'Philosopher. Born 1724 in Königsberg.' }).length);
  assert.ok(bioProblems({ bio: 'כותב שירים.', wikipedia_he: 'https://he.wikipedia.org/wiki/X', x_profile: { website: 'https://he.wikipedia.org/wiki/X' } }).length);
  assert.deepEqual(bioProblems({ bio: 'הכניסיני תחת כנפך. כותב בשביל העם וגם בשביל הילדים.' }), []);
});
