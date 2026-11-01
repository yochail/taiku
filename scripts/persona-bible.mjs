// Generates docs/persona-bible.md from personas/*.json (the canonical source). Run: npm run docs:personas
import fs from 'node:fs';
import path from 'node:path';
import { loadPersonas, SITE_DIR } from '../src/lib/data.mjs';

const personas = loadPersonas();
const byId = new Map(personas.map((p) => [p.id, p]));
const name = (id) => byId.get(id)?.name ?? id;
const rel = (arr) => (arr ?? []).map((r) => `${name(r.id)} (${r.why})`).join('; ') || '—';

const out = [
  '# Taiku — Persona Bible',
  '',
  '> Generated from `personas/*.json` by `npm run docs:personas`. Do not edit by hand: edit the JSON (the canonical persona "skill"), then regenerate.',
  '> Voice, safety and product rules: [voice-guide.md](voice-guide.md).',
  '',
  'Each persona file is loaded as the full system prompt for every LLM turn: `system_prompt` + the structured profile + `quotables` (the only lines the model may quote) + `sources` (for the `search_sources` / `get_quote` tools, Community Notes and the profile Reading list).',
  '',
  '| Persona | Kind | Domain | Handle | Lifespan | School | Modernity | Reactivity | Quotables | Sources |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...personas.map((p) => `| [${p.name}](#${p.id}) | ${p.kind} | ${p.domain ?? '—'} | @${p.handle} | ${p.lifespan} | ${p.school} | ${p.modernity} | ${p.reactivity} | ${p.quotables.length} | ${p.sources.length} |`),
  '',
];

for (const p of personas) {
  const top = Object.entries(p.topic_affinity).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(', ');
  out.push(
    `<a id="${p.id}"></a>`,
    `## ${p.name} · @${p.handle}${p.kind === 'thinker' ? '' : ` (${p.kind})`}`,
    `*${p.lifespan} · ${p.region} · ${p.school}* · modernity ${p.modernity} · reactivity ${p.reactivity} · hottest topics: ${top}`,
    '',
    `> ${p.bio} · 📍 ${p.location}`,
    '',
    `- **Background (internal):** ${p.background}`,
    `- **Voice:** ${p.voice.style}`,
    `- **Tics:** ${p.voice.tics.join(' · ')}`,
    `- **Argues by:** ${p.argument_style}`,
    `- **Allies:** ${rel(p.allies)}`,
    `- **Rivals:** ${rel(p.rivals)}`,
    ...(p.native_language?.phrases?.length ? [`- **Native (${p.native_language.name}):** ${p.native_language.phrases.map((x) => `${x.text} = "${x.translation}"`).join(' · ')}`] : []),
    `- **Quotables:** ${p.quotables.map((q) => `"${q.text}" — ${q.citation}`).join(' · ') || '—'}`,
    `- **Reading list:** ${p.sources.filter((s) => s.reading_list).map((s) => `[${s.title}](${s.url})`).join(' · ')}`,
    ...(p.sensitive_notes.length ? [`- **Sensitive:** ${p.sensitive_notes.join(' ')}`] : []),
    '',
  );
}

const file = path.join(SITE_DIR, 'docs', 'persona-bible.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out.join('\n'));
console.log(`✔ wrote ${path.relative(ROOT, file)} (${personas.length} personas)`);
