import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { jobInput, ProviderError } from '../server/contracts.js';
import { deepseekAnswerEstimate, deepseekComplete, deepseekModels, isPeak, maxSearches } from '../server/deepseek.js';
import { answer, answerReply, costOf, fakeDeepSeek, fixture, headers, key, question, toolReply, type Script } from './deepseek-fixture.js';

test('an oversized tool conversation stops before buying more context', async () => {
  const reply = toolReply(['example reports']);
  reply.choices[0].message.content = 'x'.repeat(400_000);
  const script: Script = { requests: [], replies: [reply, answerReply(answer)] };
  const original = globalThis.fetch;
  globalThis.fetch = fakeDeepSeek(script);
  try {
    await assert.rejects(deepseekComplete(key, 'deepseek-flash', 'Answer.', question, new AbortController().signal, 4096, true),
      (error: unknown) => error instanceof ProviderError && error.code === 'budget' && error.uncertain);
    assert.equal(script.requests.filter(r => r.path === '/chat/completions').length, 1);
  } finally { globalThis.fetch = original; }
});

for (const failure of [{ searchStatus: 402 }, { searchStatus: 429 }, { dropSearch: true }]) {
  test('a search failure after a paid chat retains the request for review: ' + JSON.stringify(failure), async () => {
    const script: Script = { requests: [], replies: [toolReply(['example reports']), answerReply(answer)], ...failure };
    const f = await fixture(script);
    try {
      const created = await f.ask({ question, engines: ['deepseek'], maxCostUsd: 1 });
      assert.equal(created.statusCode, 200);
      await f.runner.tick();
      const row = (await f.read(created.json().askId)).engines[0];
      assert.equal(row.state, 'paused');
      assert.equal(f.chats().length, 1, 'a failed search cannot cause another paid chat');
      const preview = (await f.app.inject({ url: `/api/jobs/${row.jobId}/resume-preview`, headers })).json();
      assert.equal(preview.uncertainRequests, 1, 'earlier paid usage requires review even after a definite search refusal');
      await f.runner.tick();
      assert.equal(f.chats().length, 1);
    } finally { await f.close(); }
  });
}

test('citations require returned search evidence and other retrieved sources remain available', async () => {
  const script: Script = { requests: [], replies: [toolReply(['example reports']), answerReply('See https://example.com/invented and https://example.org/compare.')] };
  const f = await fixture(script);
  try {
    const created = await f.ask({ question, engines: ['deepseek'], maxCostUsd: 1 });
    await f.runner.tick();
    const row = (await f.read(created.json().askId)).engines[0];
    assert.equal(row.state, 'answered');
    assert.equal(row.answer.cited, false);
    assert.deepEqual(row.answer.citations.map((link: any) => link.url), ['https://example.org/compare']);
    assert.deepEqual(row.answer.retrievedSources.map((link: any) => link.url), ['https://example.com/reports']);
    assert.match(row.answer.answer, /example.com\/invented/, 'the original answer stays intact');
  } finally { await f.close(); }
});

test('an unusable nonempty search is charged and missing chat usage stops further purchases', async () => {
  const original = globalThis.fetch;
  const at = new Date('2026-11-09T02:30:00Z');
  try {
    globalThis.fetch = fakeDeepSeek({ requests: [], replies: [toolReply(['example reports']), answerReply(answer)], searchResults: [{ url: 'http://127.0.0.1/private' }] });
    const result = await deepseekComplete(key, 'deepseek-flash', 'Answer.', question, new AbortController().signal, 4096, true, () => at);
    assert.ok(Math.abs(result.costUsd! - costOf(2, 1, at)) < 1e-9);
    assert.deepEqual(result.links, []);
    assert.equal(result.webSearchConfirmed, false);
    const reply = toolReply(['example reports']);
    const script: Script = { requests: [], replies: [{ ...reply, usage: undefined }] };
    globalThis.fetch = fakeDeepSeek(script);
    await assert.rejects(deepseekComplete(key, 'deepseek-flash', 'Answer.', question, new AbortController().signal, 4096, true),
      (error: unknown) => error instanceof ProviderError && error.code === 'cost_unknown' && error.uncertain);
    assert.equal(script.requests.length, 1);
  } finally { globalThis.fetch = original; }
});

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
    const stored = f.store.answers(f.project.id, row.jobId, 'ask-answer')[0];
    assert.deepEqual([stored.provider, stored.platform, stored.surface, stored.retrieval, stored.webSearchConfirmed], ['deepseek', 'deepseek', 'api', 'web_search', true]);
    assert.equal(row.answer.surface, undefined, 'collection internals stay out of public results');
    assert.equal(row.answer.model, undefined, 'model identifiers stay out of public results');
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
    assert.equal(created.statusCode, 409, 'the group approval is refused before creating jobs');
    await f.runner.tick();
    assert.equal(f.store.jobs(f.project.id).length, 0);
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

test('DeepSeek runs Asks and visibility checks but no analysis or content, and the Ask catalog prices it as metered', async () => {
  const projectId = randomUUID(), only = 'DeepSeek runs Asks and visibility checks only';
  const refusal = (input: object) => { const r = jobInput.safeParse(input); return r.success ? null : r.error.issues.map(i => i.message); };
  assert.equal(refusal({ projectId, kind: 'measure', provider: 'deepseek', maxCostUsd: 1 }), null);
  assert.equal(refusal({ projectId, kind: 'recheck', provider: 'deepseek', maxCostUsd: 1 }), null);
  assert.equal(refusal({ projectId, kind: 'ask', provider: 'deepseek', platform: 'deepseek', askId: randomUUID(), question }), null);
  for (const input of [{ kind: 'diagnose' }, { kind: 'content', topic: 'Free example reports' }, { kind: 'discover', auditJobId: randomUUID() },
    { kind: 'competitors', measurementJobId: randomUUID() }, { kind: 'revise', contentId: randomUUID(), revisionInstructions: 'Add sources' }])
    assert.deepEqual(refusal({ projectId, provider: 'deepseek', maxCostUsd: 1, ...input }), [only], input.kind);
  assert.ok(refusal({ projectId, kind: 'measure', provider: 'deepseek', maxCostUsd: 1, prepareRecommendations: true })?.length,
    'a DeepSeek check never prepares recommendations');
  const script: Script = { requests: [], replies: [] };
  const f = await fixture(script);
  try {
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
