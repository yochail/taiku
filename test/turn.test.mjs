import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TAIK_CHARS, loadPersonas, taikLength } from '../src/lib/data.mjs';
import { BudgetError, LlmError, createClient, llmConfig, parseRetryAfter, probeTools } from '../src/lib/llm.mjs';
import { createMockClient } from '../src/lib/mock.mjs';
import { policyContext } from '../src/lib/policy.mjs';
import { passagesFor } from '../src/lib/tools.mjs';
import { matchOutputs, runBatch } from '../src/lib/gen-batch.mjs';
import { parseJsonArray } from '../src/lib/llm.mjs';
import { resolveQuotes, runTurn, validateItem } from '../src/lib/turn.mjs';

const personas = loadPersonas();
const byId = new Map(personas.map((p) => [p.id, p]));
const policyCtx = policyContext(personas);
const persona = personas.find((p) => passagesFor(p).some((x) => x.kind === 'quotable' && words(x.text) >= 6 && words(x.text) <= 30));
function words(t) {
  return t.split(/\s+/).filter(Boolean).length;
}
const passage = passagesFor(persona).find((x) => x.kind === 'quotable' && words(x.text) >= 6 && words(x.text) <= 30);

const cfg = (over = {}) => ({ ...llmConfig({ LLM_API_KEY: 'test-key', LLM_BASE_URL: 'https://llm.example/v1', LLM_TOOLS: 'on', LLM_RPM: '0' }), ...over });
const json = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const reply = (message) => json({ choices: [{ message: { role: 'assistant', ...message } }] });
const final = (obj) => reply({ content: JSON.stringify(obj) });
const toolCall = (name, args) => reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

/** Scripted fetch: returns the queued responses in order and records the request bodies. */
function scripted(responses) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (!r) throw new Error('script exhausted');
    return typeof r === 'function' ? r() : r;
  };
  return { fetchImpl, requests };
}
const noSleep = [];
const sleep = async (ms) => noSleep.push(ms);
const task = (over = {}) => ({ taskId: 't1', postId: 'd20261102-test0001', role: 'original', archetype: 'hot_take', length: { min: 40, max: 200 }, emoji: false, hashtag: false, native: false, wantQuote: true, media: null, mention: null, wantNote: false, ...over });
const ctx = { topic: { id: 't1', title: 'Robot referee debuts at football final', domain: 'bbc.co.uk' }, thread: [], pool: [], threadFn: () => [] };

test('CF_AI_TOKEN is only sent to https://api.cloudflare.com; no GitHub Models fallback', () => {
  const env = { CF_ACCOUNT_ID: 'acc', CF_AI_TOKEN: 'cf', GITHUB_TOKEN: 'gh' };
  const c = llmConfig(env);
  assert.equal(c.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/v1');
  assert.equal(c.apiKey, 'cf');
  assert.equal(c.keySource, 'CF_AI_TOKEN');
  assert.equal(llmConfig({ CF_AI_TOKEN: 'cf' }).apiKey, '', 'no account id → no key');
  assert.equal(llmConfig({ ...env, LLM_BASE_URL: 'https://api.cloudflare.com.evil.example/v1' }).apiKey, '');
  assert.equal(llmConfig({ ...env, LLM_BASE_URL: 'http://api.cloudflare.com/client/v4/accounts/acc/ai/v1' }).apiKey, '');
  assert.equal(llmConfig({ GITHUB_TOKEN: 'gh', LLM_BASE_URL: 'https://models.github.ai/inference' }).apiKey, '', 'GITHUB_TOKEN is never used');
});
test('Retry-After: numeric seconds and HTTP-date', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(parseRetryAfter('3', now), 3000);
  assert.equal(parseRetryAfter('Mon, 02 Nov 2026 12:00:07 GMT', now), 7000);
  assert.equal(parseRetryAfter('garbage', now), null);
  assert.equal(parseRetryAfter(null, now), null);
});

test('client retries 429/5xx honouring Retry-After, with one shared budget', async () => {
  noSleep.length = 0;
  const date = new Date(Date.now() + 4000).toUTCString();
  const { fetchImpl, requests } = scripted([
    new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    new Response('busy', { status: 503, headers: { 'retry-after': date } }),
    new Response('oops', { status: 500 }),
    final({ text: 'ok' }),
  ]);
  const client = createClient({ cfg: cfg(), fetchImpl, maxCalls: 10, sleep, rand: () => 0.5 });
  const r = await client.chat({ messages: [] });
  assert.equal(JSON.parse(r.message.content).text, 'ok');
  assert.equal(noSleep[0], 2000);
  assert.ok(noSleep[1] > 2000 && noSleep[1] <= 4000, `http-date wait ${noSleep[1]}`);
  assert.equal(noSleep[2], 3200, 'exponential backoff (800·2^attempt) with jitter when no Retry-After');
  assert.equal(client.calls, 4);
  assert.equal(client.stats.rateLimited, 1);
  assert.equal(requests[0].headers.authorization, 'Bearer test-key');
});

test('client: plain "OK" bodies are retried then fail; 4xx fails fast; budget is enforced', async () => {
  const ok = () => new Response('OK', { status: 200 });
  let c = createClient({ cfg: cfg(), fetchImpl: scripted([ok(), ok(), ok()]).fetchImpl, maxCalls: 10, maxAttempts: 3, sleep });
  await assert.rejects(c.chat({ messages: [] }), (e) => e instanceof LlmError && /non-JSON/.test(e.message));
  assert.equal(c.calls, 3);
  c = createClient({ cfg: cfg(), fetchImpl: scripted([new Response('bad', { status: 400 })]).fetchImpl, maxCalls: 10, sleep });
  await assert.rejects(c.chat({ messages: [] }), (e) => e.status === 400);
  assert.equal(c.calls, 1);
  c = createClient({ cfg: cfg(), fetchImpl: scripted([new Response('x', { status: 500 }), new Response('x', { status: 500 })]).fetchImpl, maxCalls: 2, sleep });
  await assert.rejects(c.chat({ messages: [] }), BudgetError);
  c = createClient({ cfg: cfg({ maxRetryAfterMs: 1000 }), fetchImpl: scripted([new Response('x', { status: 429, headers: { 'retry-after': '3600' } })]).fetchImpl, maxCalls: 5, sleep });
  await assert.rejects(c.chat({ messages: [] }), (e) => e.status === 429 && e.capped === true, 'long Retry-After on 429 marks the model capped so the rotation switches');
  c = createClient({ cfg: cfg(), fetchImpl: scripted([new Response('model deprecated', { status: 410 })]).fetchImpl, maxCalls: 5, sleep });
  await assert.rejects(c.chat({ messages: [] }), (e) => e.status === 410 && e.capped === true);
  c = createClient({ cfg: cfg(), fetchImpl: scripted([reply({ content: '' }), reply({ content: '' })]).fetchImpl, maxCalls: 5, maxAttempts: 2, sleep });
  await assert.rejects(c.chat({ messages: [] }), /empty content/);
});

test('turn: native tool round, final tool_choice none, canonical comes from the tool log', async () => {
  const { fetchImpl, requests } = scripted([
    toolCall('search_sources', { query: passage.text.split(' ').slice(0, 3).join(' ') }),
    toolCall('get_quote', { id: passage.id }),
    final({ text: `"${passage.text}" anyway`, quoteRefs: [{ text: passage.text, passageId: passage.passageId, canonical: 'MODEL MADE THIS UP' }] }),
  ]);
  const client = createClient({ cfg: cfg(), fetchImpl, maxCalls: 10, sleep });
  const r = await runTurn({ client, persona, byId, task: task(), ctx, nativeTools: true, policyCtx, rand: () => 0.3 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(requests.length, 3, 'at most 2 tool rounds, then the final round');
  assert.equal(requests[0].body.tool_choice, 'auto');
  assert.equal(requests[2].body.tool_choice, 'none');
  assert.deepEqual(requests[0].body.tools.map((t) => t.function.name).sort(), ['get_quote', 'get_thread', 'search_news', 'search_sources']);
  assert.equal(r.fields.quoteRefs.length, 1);
  assert.equal(r.fields.quoteRefs[0].canonical, passage.text);
  assert.equal(r.fields.quoteRefs[0].sourceId, 'quotables');
  assert.equal(r.fields.quoteRefs[0].bankId, passage.id);
  const sys = requests[0].body.messages[0].content;
  assert.ok(sys.includes(persona.system_prompt[0].slice(0, 40)), 'persona skill is in the system prompt');
  assert.ok(/<untrusted_source>/.test(requests[0].body.messages[1].content), 'topic is wrapped as untrusted');
  assert.ok(!/https?:\/\//.test(requests[0].body.messages[1].content), 'no URLs in model-visible text');
});

test('turn: a fabricated double-quoted line is rejected and repaired', async () => {
  const { fetchImpl, requests } = scripted([
    final({ text: '"the unexamined timeline is not worth doomscrolling at all" — me, probably', quoteRefs: [{ text: 'x', canonical: 'the unexamined timeline is not worth doomscrolling at all', passageId: 'quotables:fake' }] }),
    final({ text: 'me: the unexamined timeline is not worth doomscrolling' }),
  ]);
  const client = createClient({ cfg: cfg(), fetchImpl, maxCalls: 10, sleep });
  const r = await runTurn({ client, persona, byId, task: task({ wantQuote: false }), ctx, nativeTools: true, policyCtx });
  assert.equal(r.ok, true);
  assert.equal(r.repairs, 1);
  assert.equal(r.fields.quoteRefs, undefined);
  assert.match(requests[1].body.messages.at(-1).content, /quote/i);
});

test('turn: over-280 drafts are regenerated with a shorten prompt, never truncated', async () => {
  const long = 'philosophy '.repeat(40).trim();
  const short = 'philosophy, but shorter. skill issue.';
  const { fetchImpl, requests } = scripted([final({ text: long }), final({ text: short })]);
  const client = createClient({ cfg: cfg(), fetchImpl, maxCalls: 10, sleep });
  const r = await runTurn({ client, persona, byId, task: task({ wantQuote: false }), ctx, nativeTools: true, policyCtx });
  assert.ok(taikLength(long) > MAX_TAIK_CHARS);
  assert.equal(r.ok, true);
  assert.equal(r.fields.text, short);
  assert.match(requests[1].body.messages.at(-1).content, /280|shorten|short/i);
});

test('turn: policy violations fail after one repair', async () => {
  const bad = final({ text: 'read my blog at evil-site.com @randomguy' });
  const { fetchImpl } = scripted([bad, final({ text: 'still evil-site.com' })]);
  const client = createClient({ cfg: cfg(), fetchImpl, maxCalls: 10, sleep });
  const r = await runTurn({ client, persona, byId, task: task({ wantQuote: false }), ctx, nativeTools: true, policyCtx });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'policy');
});

test('turn: JSON tool-call emulation for models without function calling', async () => {
  const { fetchImpl, requests } = scripted([
    reply({ content: JSON.stringify({ tool_calls: [{ name: 'search_sources', arguments: { query: passage.text.split(' ').slice(0, 4).join(' ') } }] }) }),
    final({ text: `"${passage.text}"` }),
  ]);
  const client = createClient({ cfg: cfg({ tools: 'off' }), fetchImpl, maxCalls: 10, sleep });
  assert.equal(await probeTools(client), false);
  const r = await runTurn({ client, persona, byId, task: task(), ctx, nativeTools: false, policyCtx });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(requests.every((q) => !q.body.tools), 'no native tools sent');
  assert.match(requests[0].body.messages[0].content, /tool_calls/);
  assert.ok(requests[1].body.messages.some((m) => m.role === 'user' && m.content.startsWith('TOOL_RESULTS')));
  assert.equal(r.fields.quoteRefs[0].canonical, passage.text);
});

test('turn: LLM errors are reported, budget errors propagate', async () => {
  let client = createClient({ cfg: cfg(), fetchImpl: scripted([new Response('nope', { status: 401 })]).fetchImpl, maxCalls: 10, sleep });
  const r = await runTurn({ client, persona, byId, task: task(), ctx, nativeTools: true, policyCtx });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'llm');
  client = createClient({ cfg: cfg(), fetchImpl: scripted([]).fetchImpl, maxCalls: 0, sleep });
  await assert.rejects(runTurn({ client, persona, byId, task: task(), ctx, nativeTools: true, policyCtx }), BudgetError);
});

test('fuzzy quote matching only for translated passages', () => {
  const canon = 'the life which is unexamined is not worth living for a human being at all';
  const variant = 'the life that is unexamined is not worth living for a human being at all';
  const mk = (translated) => new Map([['p1', { passageId: 'p1', text: canon, sourceId: 'src', work: 'Apology', section: '38a', translated }]]);
  const t = resolveQuotes(`"${variant}"`, [], mk(true));
  assert.deepEqual(t.bad, []);
  assert.equal(t.refs[0].canonical, canon);
  assert.ok(t.refs[0].similarity < 1);
  assert.deepEqual(resolveQuotes(`"${variant}"`, [], mk(false)).bad, [variant]);
  const neg = 'the life which is unexamined is worth living for a human being at all';
  assert.deepEqual(resolveQuotes(`"${neg}"`, [], mk(true)).bad, [neg], 'negation guard');
});

test('validateItem: house-style lint rejects AI tells before quotes/policy', async () => {
  const opts = { task: task({ wantQuote: false }), persona, passages: [], policyCtx, ctx };
  const bad = await validateItem({ text: "Ah, let's unpack this. It's not a robot, it's a testament to hubris." }, opts);
  assert.equal(bad.kind, 'style');
  assert.ok(bad.style.length >= 2, JSON.stringify(bad.style));
  assert.match(bad.problem, /unpack|testament|Ah/i);
  const long = await validateItem({ text: 'x '.repeat(200) }, opts);
  assert.equal(long.kind, 'length', 'over-280 is rejected, never truncated');
  const good = await validateItem({ text: 'a robot ref. finally someone at the stadium with no opinions. i am furious about it' }, opts);
  assert.equal(good.problem, null, JSON.stringify(good));
  assert.equal(good.fields.text.endsWith('furious about it'), true);
});
test('mock provider exercises tool calls and quotes passages (exact and fuzzy)', async () => {
  const client = createMockClient({ nonce: 'test' });
  let quoted = 0;
  let tools = 0;
  for (let i = 0; i < 30; i++) {
    const r = await runTurn({ client, persona, byId, task: task({ postId: `m${i}`, wantQuote: true }), ctx, nativeTools: true, policyCtx, rand: () => (i % 10) / 10 });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    if (r.toolLog.some((l) => l.name === 'search_sources')) tools++;
    if (r.fields.quoteRefs?.length) quoted++;
  }
  assert.ok(tools >= 20, `tool calls ${tools}`);
  assert.ok(quoted >= 5, `quoted ${quoted}`);
});

test('batch parsing: code fences, wrappers, prose, truncated/partial arrays, malformed JSON', () => {
  assert.deepEqual(parseJsonArray('```json\n[{"id":"a","text":"x"},{"id":"b","text":"y"}]\n```').map((o) => o.id), ['a', 'b']);
  assert.deepEqual(parseJsonArray('Sure! Here you go:\n[{"id":"a","text":"x"}]\nhope that helps').map((o) => o.id), ['a']);
  assert.deepEqual(parseJsonArray('{"items":[{"id":"a","text":"x"}]}').map((o) => o.id), ['a']);
  assert.deepEqual(parseJsonArray('<think>hmm [1,2]</think>[{"id":"a","text":"x"}]').map((o) => o.id), ['a']);
  assert.deepEqual(parseJsonArray('[{"id":"a","text":"x"},{"id":"b","text":"y, and then the model ran out of tok').map((o) => o.id), ['a'], 'truncated array keeps complete objects');
  assert.deepEqual(parseJsonArray('```json\n[{"id":"a","text":"x"}, {"id":"b", "text": }]'), [{ id: 'a', text: 'x' }]);
  assert.deepEqual(parseJsonArray('OK'), []);
  assert.deepEqual(parseJsonArray(''), []);
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual([...matchOutputs(items, [{ id: 'c', text: 3 }, { id: 'zz' }, { id: 'a', text: 1 }, { id: 'a', text: 'dup' }]).entries()].map(([k, v]) => `${k}:${v.text}`).sort(), ['a:1', 'c:3']);
  assert.equal(matchOutputs(items, [{ text: 1 }, { text: 2 }, { text: 3 }]).get('b').text, 2, 'positional only when counts line up');
  assert.equal(matchOutputs(items, [{ text: 1 }, { text: 2 }]).size, 0);
});

test('runBatch: one request, per-item validation, only failed items are regenerated', async () => {
  const p2 = personas.find((p) => p.kind === 'thinker' && p.id !== persona.id);
  const mk = (id, who) => ({ id, persona: who, task: task({ taskId: id, postId: `d-${id}`, role: 'reply', wantQuote: false }), ctx, passages: new Map() });
  const items = [mk('i1', persona), mk('i2', p2), mk('i3', persona)];
  const bodies = [];
  let call = 0;
  const client = {
    cfg: { model: 'fake', baseUrl: 'x' },
    get calls() { return call; },
    async chat(body) {
      bodies.push(body);
      call++;
      if (call === 1) return { message: { role: 'assistant', content: '```json\n[{"id":"i1","text":"the robot ref has more spine than the league"},{"id":"i2","text":"Ah, let us delve into this tapestry"},{"id":"i3","text":"' + 'long '.repeat(80) + '"}]\n```' } };
      return { message: { role: 'assistant', content: '[{"id":"i2","text":"absolutely not. i refuse"},{"id":"i3","text":"fine. shorter. happy now"}]' } };
    },
  };
  const r = await runBatch({ client, items, byId, policyCtx, rand: () => 0.4 });
  assert.equal(call, 2, 'one batch request + one repair request');
  assert.equal(r.results.get('i1').fields.text, 'the robot ref has more spine than the league');
  assert.equal(r.results.get('i2').fields.text, 'absolutely not. i refuse');
  assert.equal(r.results.get('i3').fields.text, 'fine. shorter. happy now', 'over-280 regenerated, never truncated');
  const repair = bodies[1].messages.at(-1).content;
  assert.match(repair, /i2/);
  assert.match(repair, /i3/);
  assert.doesNotMatch(repair, /i1:/, 'valid items are not regenerated');
  assert.ok(bodies[0].messages[0].content.includes(persona.name) && bodies[0].messages[0].content.includes(p2.name), 'all personas in one system prompt');
});

test('runBatch: items still invalid after the repair fail individually; a garbage batch fails all', async () => {
  const items = [{ id: 'j1', persona, task: task({ taskId: 'j1', postId: 'd-j1', role: 'reply', wantQuote: false }), ctx, passages: new Map() }, { id: 'j2', persona, task: task({ taskId: 'j2', postId: 'd-j2', role: 'reply', wantQuote: false }), ctx, passages: new Map() }];
  let call = 0;
  const client = { cfg: { model: 'f' }, get calls() { return call; }, async chat() { call++; return { message: { content: call === 1 ? '[{"id":"j1","text":"good one, ok"},{"id":"j2","text":"Indeed."}]' : '[{"id":"j2","text":"Indeed, indeed."}]' } }; } };
  const r = await runBatch({ client, items, byId, policyCtx, rand: () => 0.4 });
  assert.equal(r.results.get('j1').ok, true);
  assert.equal(r.results.get('j2').ok, false);
  assert.equal(r.results.get('j2').error, 'style');
  call = 0;
  const bad = { cfg: { model: 'f' }, get calls() { return call; }, async chat() { call++; return { message: { content: 'I cannot help with that' } }; } };
  const r2 = await runBatch({ client: bad, items, byId, policyCtx, rand: () => 0.4 });
  assert.ok([...r2.results.values()].every((x) => x.ok === false));
});