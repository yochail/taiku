import { loadPersonas, loadPosts, validate } from '../src/lib/data.mjs';

const personas = loadPersonas();
const posts = loadPosts();
const errors = validate(personas, posts);
if (errors.length) {
  console.error(`✖ ${errors.length} validation error(s):\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`✔ ${personas.length} personas, ${posts.length} posts — all valid`);
