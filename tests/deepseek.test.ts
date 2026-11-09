import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { jobInput, projectInput, ProviderError } from '../server/contracts.js';
import { deepseekAnswerEstimate, deepseekComplete, deepseekModels, deepseekPrices, isPeak, maxSearches } from '../server/deepseek.js';

// Synthetic fixtures only: example.com identities and an invented key. Response shapes follow DeepSeek's
// documented schemas: https://api-docs.deepseek.com/api/create-chat-completion (chat, tool calls, usage),
// https://api-docs.deepseek.com/guides/search (search), https://api-docs.deepseek.com/api/get-user-balance and
// https://api-docs.deepseek.com/api/list-models.
const session = 'synthetic-deepseek-session';
const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };
const key = 'synthetic-deepseek-fixture-key';
const question = 'Which example tools publish free reports?';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800 };
const toolReply = (queries: string[]) => ({ id: 'chat-' + randomUUID(), object: 'chat.completion', model: 'deepseek-flash', usage,
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
    tool_calls: queries.map((query, i) => ({ id: 'call_' + i, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } })) } }] });
const answerReply = (content: string, finish = 'stop') => ({ id: 'chat-' + randomUUID(), object: 'chat.completion', model: 'deepseek-flash', usage,
  choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }] });
const answer = 'Example Brand publishes free reports. See [Example reports](https://example.com/reports) and https://example.org/compare.';

type Request = { host: string; path: string; method: string; auth?: string; body: any };
type Script = { replies: any[]; requests: Request[]; balanceStatus?: number; chatStatus?: number; dropChat?: boolean };
function fakeDeepSeek(script: Script) {
  return (async (url: string | URL, init?: RequestInit) => {
    const address = new URL(String(url)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    script.requests.push({ host: address.hostname, path: address.pathname, method, auth, body });
    assert.equal(address.hostname, 'api.deepseek.com', 'only DeepSeek may be called in these tests');
    if (address.pathname === '/user/balance') return script.balanceStatus === 401 ? json({ error: { message: 'Authentication Fails', type: 'authentication_error' } }, 401)
      : json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.87', granted_balance: '0.00', topped_up_balance: '9.87' }] });
    if (address.pathname === '/models') return json({ object: 'list', data: ['deepseek-v4-pro', 'deepseek-future', 'deepseek-flash'].map(id => ({ id, object: 'model', owned_by: 'deepseek' })) });
    if (address.pathname === '/v1/tools/search') return json({ results: body.query.includes('nothing') ? [] : [
      { rerank_score: 2.5, title: 'Free example reports', url: 'https://example.com/reports', snippet: 'Example Brand shares free reports.', summary: 'Longer summary.', content: '', site_name: 'Example', site_icon: null, date: '2026-10-01T00:00:00Z', authority: 3 },
      { rerank_score: 1.9, title: 'Comparing example tools', url: 'https://example.org/compare', snippet: 'A comparison.', summary: '', content: '', site_name: null, site_icon: null, date: null, authority: -1 }] });
    if (address.pathname === '/chat/completions') {
      if (script.dropChat) throw new TypeError('fetch failed');
      if (script.chatStatus) return json({ error: { message: 'Insufficient Balance', type: 'unknown_error' } }, script.chatStatus);
      const reply = script.replies.shift();
      if (!reply) throw new Error('No scripted DeepSeek reply left');
      return json(reply);
    }
    throw new Error('Unexpected DeepSeek request ' + method + ' ' + address.pathname);
  }) as typeof fetch;
}

async function fixture(script: Script, connected = true) {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-deepseek-'));
  const store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  if (connected) vault.set('deepseek', { provider: 'deepseek', key });
  const original = globalThis.fetch;
  globalThis.fetch = fakeDeepSeek(script);
  const { app, runner } = await createApp(store, vault, session);
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example Brand', prompts: ['Which example dashboards are free?'] }));
  const ask = (payload: object) => app.inject({ method: 'POST', url: `/api/projects/${project.id}/asks`, headers: { ...headers, 'idempotency-key': 'ask-' + randomUUID() }, payload });
  const read = async (askId: string) => (await app.inject({ url: `/api/projects/${project.id}/asks/${askId}`, headers })).json();
  const chats = () => script.requests.filter(r => r.path === '/chat/completions');
  return { store, vault, app, runner, project, ask, read, chats,
    async close() { globalThis.fetch = original; await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const costOf = (calls: number, searches: number, at: Date) => {
  const r = isPeak(at) ? deepseekPrices.models['deepseek-flash'].peak : deepseekPrices.models['deepseek-flash'].offPeak;
  return calls * (200 * r.hit + 800 * r.miss + 50 * r.output) / 1e6 + searches * deepseekPrices.searchUsd;
};

test('a DeepSeek ask runs its own searches, cites links in the answer, records an estimated cost and stays out of evidence', async () => {
  const script: Script = { requests: [], replies: [toolReply(['free example report tools']), toolReply(['example reports site:example.com', 'nothing matches this']), answerReply(answer)] };
  const f = await fixture(script);
  try {
    const started = new Date();
    const created = await f.ask({ question, engines: ['deepseek'], maxCostUsd: 1 });
    assert.equal(created.statusCode, 200);
    await f.runner.tick();
    const result = await f.read(created.json().askId), row = result.engines[0];
    assert.equal(row.state, 'answered');
    assert.deepEqual([row.answer.provider, row.answer.platform, row.answer.surface, row.answer.retrieval, row.answer.webSearchConfirmed], ['deepseek', 'deepseek', 'api', 'web_search', true]);
    assert.deepEqual(row.answer.citations.map((c: any) => c.url), ['https://example.com/reports', 'https://example.org/compare']);
    assert.equal(row.answer.citations[0].title, 'Example reports');
    assert.deepEqual(row.answer.searchQueries, ['free example report tools', 'example reports site:example.com', 'nothing matches this']);
    assert.deepEqual([row.answer.mentioned, row.answer.cited], [true, true]);
    // Three chat calls and two searches with results; the empty search is not billed.
    const job = f.store.job(row.jobId);
    assert.equal(job.costBasis, 'includes_estimates');
    assert.ok([costOf(3, 2, started), costOf(3, 2, new Date())].some(v => Math.abs(job.spentUsd - v) < 1e-9), 'spent ' + job.spentUsd);
    const [first, , last] = f.chats().map(r => r.body);
    assert.equal(first.model, 'deepseek-flash');
    assert.deepEqual(first.thinking, { type: 'disabled' });
    assert.equal(first.tools[0].function.name, 'web_search');
    assert.deepEqual(last.messages.filter((m: any) => m.role === 'tool').length, 3);
    assert.equal(JSON.parse(last.messages.find((m: any) => m.role === 'tool').content).results[0].url, 'https://example.com/reports');
    assert.ok(last.messages.some((m: any) => m.role === 'assistant' && m.tool_calls?.length === 2));
    // The key is sent to DeepSeek's host only, and nothing else was contacted.
    assert.ok(script.requests.length > 0 && script.requests.every(r => r.host === 'api.deepseek.com' && r.auth === 'Bearer ' + key));
    // Ask answers are kept apart from the website's evidence.
    assert.equal(f.store.answers(f.project.id, row.jobId, 'ask-answer').length, 1);
    assert.equal(f.store.answers(f.project.id, row.jobId, 'observation').length, 0);
  } finally { await f.close(); }
});

test('a model that keeps searching gets four searches, then a call without the tool', async () => {
  const script: Script = { requests: [], replies: [toolReply(['q one', 'q two', 'q three']), toolReply(['q four', 'q five']), answerReply('Done. https://example.com/reports')] };
  const f = await fixture(script);
  try {
    const created = await f.ask({ question, engines: ['deepseek'], maxCostUsd: 1 });
    await f.runner.tick();
    const row = (await f.read(created.json().askId)).engines[0];
    assert.equal(row.state, 'answered');
    assert.deepEqual(script.requests.filter(r => r.path === '/v1/tools/search').map(r => r.body.query), ['q one', 'q two', 'q three', 'q four']);
    const calls = f.chats().map(r => r.body);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].tools && calls[1].tools && !calls[2].tools, 'the last call must not offer the tool');
    assert.match(calls[2].messages.at(-1).content, /No more searches are available/);
    assert.match(calls[0].messages[0].content, /Do not mention your searches, the search tool or any search limit\./, 'the answer must not narrate the search loop');
    assert.equal(maxSearches, 4);
  } finally { await f.close(); }
});

test('cost uses the rate in force for each call and bills searches only when they return results', async () => {
  const peak = new Date('2026-11-09T02:30:00Z'), offPeak = new Date('2026-11-07T02:30:00Z');
  assert.deepEqual([isPeak(peak), isPeak(offPeak), isPeak(new Date('2026-11-09T05:00:00Z')), isPeak(new Date('2026-11-09T09:59:00Z'))], [true, false, false, true]);
  for (const at of [peak, offPeak]) {
    const script: Script = { requests: [], replies: [toolReply(['nothing here']), answerReply('No sources found.')] };
    const original = globalThis.fetch;
    globalThis.fetch = fakeDeepSeek(script);
    try {
      const result = await deepseekComplete(key, 'deepseek-flash', 'Answer.', question, new AbortController().signal, 4096, true, () => at);
      assert.ok(Math.abs((result.costUsd ?? -1) - costOf(2, 0, at)) < 1e-9);
      assert.equal(result.webSearchConfirmed, false);
      assert.deepEqual(result.searchQueries, ['nothing here']);
    } finally { globalThis.fetch = original; }
  }
});

test('the worst-case estimate bounds an answer, and a share below it stops before any DeepSeek request', async () => {
  const [flash, pro] = deepseekModels(['deepseek-flash', 'deepseek-v4-pro']);
  const flashWorst = deepseekAnswerEstimate(flash, 1500, 4096), proWorst = deepseekAnswerEstimate(pro, 1500, 4096);
  assert.ok(flashWorst > 0.05 && flashWorst < 0.1 && proWorst > flashWorst, flashWorst + ' ' + proWorst);
  assert.ok(costOf(5, 4, new Date('2026-11-09T02:30:00Z')) < flashWorst, 'a full search loop at peak must fit the estimate');
  const script: Script = { requests: [], replies: [answerReply(answer)] };
  const f = await fixture(script);
  try {
    const created = await f.ask({ question, engines: ['deepseek'], maxCostUsd: 0.02 });
    await f.runner.tick();
    const row = (await f.read(created.json().askId)).engines[0];
    assert.equal(f.store.job(row.jobId).error, 'budget');
    assert.equal(f.chats().length, 0);
  } finally { await f.close(); }
});

test('an exhausted balance pauses with no fallback, and a dropped connection needs review before resuming', async () => {
  const broke: Script = { requests: [], replies: [], chatStatus: 402 };
  const f = await fixture(broke);
  try {
    const created = await f.ask({ question, engines: ['deepseek'], maxCostUsd: 1 });
    await f.runner.tick();
    const row = (await f.read(created.json().askId)).engines[0], job = f.store.job(row.jobId);
    assert.equal(job.error, 'quota');
    assert.match(job.progress ?? '', /balance is insufficient/);
    assert.equal(f.store.jobs(f.project.id).length, 1, 'no other engine or provider was started');
  } finally { await f.close(); }
  const dropped: Script = { requests: [], replies: [], dropChat: true };
  const g = await fixture(dropped);
  try {
    const created = await g.ask({ question, engines: ['deepseek'], maxCostUsd: 1 });
    await g.runner.tick();
    const row = (await g.read(created.json().askId)).engines[0];
    assert.equal(g.store.job(row.jobId).error, 'connection_interrupted');
    assert.equal((await g.app.inject({ url: `/api/jobs/${row.jobId}/resume-preview`, headers })).json().uncertainRequests, 1);
  } finally { await g.close(); }
  const original = globalThis.fetch;
  globalThis.fetch = fakeDeepSeek({ requests: [], replies: [answerReply('Cut off', 'length')] });
  try {
    await assert.rejects(deepseekComplete(key, 'deepseek-flash', 'Answer.', question, new AbortController().signal, 4096, false),
      (error: unknown) => error instanceof ProviderError && error.code === 'incomplete' && error.uncertain);
  } finally { globalThis.fetch = original; }
});

test('connecting checks the key with DeepSeek, keeps the previous key on failure, and lists only priced models', async () => {
  const script: Script = { requests: [], replies: [] };
  const f = await fixture(script, false);
  try {
    const put = (k: string) => f.app.inject({ method: 'PUT', url: '/api/providers', headers, payload: { provider: 'deepseek', key: k } });
    assert.equal((await put(key)).statusCode, 200);
    assert.equal((await f.app.inject({ url: '/api/providers', headers })).json().connected.deepseek, true);
    script.balanceStatus = 401;
    const refused = await put('synthetic-other-deepseek-key');
    assert.notEqual(refused.statusCode, 200);
    assert.equal(f.vault.get('deepseek').key, key, 'the working key is kept');
    script.balanceStatus = undefined;
    const models = (await f.app.inject({ url: '/api/providers/deepseek/models', headers })).json();
    const list = Array.isArray(models) ? models : models.models;
    assert.deepEqual(list.map((m: any) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(list[0].outputUsd, 1.2 / 1e6);
    assert.ok(script.requests.every(r => r.host === 'api.deepseek.com'));
  } finally { await f.close(); }
});

test('DeepSeek answers one-off Asks only, and the Ask catalog prices it as metered', async () => {
  const projectId = randomUUID();
  assert.equal(jobInput.safeParse({ projectId, kind: 'measure', provider: 'deepseek' }).success, false);
  assert.equal(jobInput.safeParse({ projectId, kind: 'ask', provider: 'deepseek', platform: 'deepseek', askId: randomUUID(), question }).success, true);
  const script: Script = { requests: [], replies: [] };
  const f = await fixture(script);
  try {
    const refused = await f.app.inject({ method: 'POST', url: '/api/jobs', headers, payload: { projectId: f.project.id, kind: 'measure', provider: 'deepseek', maxCostUsd: 1 } });
    assert.notEqual(refused.statusCode, 200);
    const catalog = (await f.app.inject({ url: `/api/projects/${f.project.id}/asks/engines`, headers })).json();
    const engine = catalog.engines.find((e: any) => e.id === 'deepseek');
    assert.deepEqual([engine.available, engine.price, engine.label], [true, 'metered', 'DeepSeek']);
    const estimate = (await f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/asks/estimate`, headers, payload: { question, engines: ['deepseek'] } })).json();
    assert.ok(estimate.engines[0].estimateUsd > 0 && estimate.engines[0].estimateUsd <= 0.1, JSON.stringify(estimate));
    f.vault.remove('deepseek');
    const after = (await f.app.inject({ url: `/api/projects/${f.project.id}/asks/engines`, headers })).json();
    assert.equal(after.engines.find((e: any) => e.id === 'deepseek').reason, 'Not connected');
    assert.equal(script.requests.length, 0, 'the catalog and estimate are priced without calling DeepSeek');
  } finally { await f.close(); }
});
