import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPersonas, displayName, displayNameProblems } from '../src/lib/data.mjs';

test('display names: some (not all) personas decorated, handles intact, names recognisable', () => {
  const ps = loadPersonas();
  const dec = ps.filter((p) => p.x_profile?.display_name);
  const share = dec.length / ps.length;
  assert.ok(share >= 0.2 && share <= 0.4, `decorated share ${share}`);
  for (const p of dec) {
    assert.deepEqual(displayNameProblems(p), [], p.id);
    assert.match(p.handle, /^[A-Za-z0-9_]+$/, p.id);
  }
  assert.equal(displayName({ name: 'Plain' }), 'Plain');
  assert.equal(displayName({ name: 'Kant', x_profile: { display_name: 'Kant | 🕰️' } }), 'Kant | 🕰️');
  assert.ok(displayNameProblems({ name: 'Kant', x_profile: { display_name: 'Hegel 🔥' } }).length);
});
