import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { exportProject } from '../server/export.js';
import { askFit, askShare } from '../server/ask-scope.js';

// Synthetic fixtures only: example.com identities, invented credentials and a fake fetch for both providers.
const session = 'synthetic-ask-session';
const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };
const question = 'Which example tools publish free reports?';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const answerStream = (text: string, urls: string[], searches: string[]) => new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
  ...searches.map(query => ({ type: 'web_search_call', status: 'completed', action: { type: 'search', query } })),
  { type: 'message', content: [{ type: 'output_text', text, annotations: urls.map(url => ({ type: 'url_citation', url, title: 'Source' })) }] },
] } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });

type Fake = {
  credits: number; platforms: string[]; missing: string[]; chatgptFails: boolean; domainKnown: boolean;
  gate?: Promise<void>; gated?: string; estimates: any[]; purchases: any[]; openai: string[];
};
function fakeProviders(state: Fake) {
  const domain = randomUUID(), quotes = new Map<string, any>(), remote = new Map<string, any>();
  const managed = (id: string) => {
    const { request } = remote.get(id);
    return { id, status: 'completed', estimated_credits: state.credits, approved_credits: request.approved_credits, cancel_requested: false, progress: null,
      receipt: { charged_credits: state.credits, refunded_credits: request.approved_credits - state.credits, status: 'completed' } };
  };
  return (async (url: string | URL, init?: RequestInit) => {
    const address = new URL(String(url)), body = init?.body ? JSON.parse(String(init.body)) : null, method = init?.method ?? 'GET';
    if (address.hostname === 'api.openai.com') {
      if (address.pathname.endsWith('/models')) return json({ models: [{ slug: 'fixture-model', display_name: 'Fixture model', visibility: 'list', context_window: 32768 }] });
      const asked = body.input[0].content;
      state.openai.push(asked);
      if (state.gate && asked === state.gated) await new Promise<void>((resolve, reject) => {
        state.gate!.then(resolve);
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
      if (state.chatgptFails) return json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429);
      return answerStream('Example Brand and other tools publish reports.', ['https://example.org/reports'], ['free example report tools']);
    }
    assert.equal(address.hostname, 'api.surfacedby.com');
    const path = address.pathname.replace('/api/v1/console', '');
    if (path === '/capabilities') return json({ data: { platforms: [{ key: 'chatgpt', name: 'ChatGPT', enabled: true }, { key: 'gemini', name: 'Gemini', enabled: true }],
      operations: ['measurement'], content_available: false, models: [], selected_question_platforms: state.platforms } });
    if (path === '/domains') return json({ data: state.domainKnown ? [{ id: domain, domain: 'example.com' }] : [], meta: {} });
    if (path.endsWith('/brand')) return json({ data: {} });
    if (path.endsWith('/measurement/estimate')) {
      const id = randomUUID(); quotes.set(id, body); state.estimates.push(body);
      return json({ data: { id, domain_id: domain, operation: 'measurement', estimated_credits: state.credits, expires_at: new Date(Date.now() + 3600000).toISOString() } });
    }
    if (path === '/measurement/jobs' && method === 'POST') {
      const id = randomUUID(); state.purchases.push(body); remote.set(id, { request: body, input: quotes.get(body.estimate_id) });
      return json({ data: { ...managed(id), status: 'queued', receipt: null } });
    }
    const results = path.match(/^\/measurement\/jobs\/([^/]+)\/results$/);
    if (results) {
      const { input } = remote.get(results[1]), row = input.questions[0], collected = !state.missing.includes(input.platform);
      return json({ data: { job: managed(results[1]), profile: 'selected_questions', requested_answers: 1, locale: input.locale, platform: input.platform,
        observations: [{ id: row.id, question: row.question, status: collected ? 'collected' : 'missing_observation', platform: input.platform, locale: input.locale,
          country: input.country, surface: 'consumer_interface', answer: collected ? 'Try example.com for free reports.' : null, model: collected ? 'fixture-app' : null,
          observed_at: new Date().toISOString(), citations: collected ? [{ url: 'https://example.com/reports', title: 'Reports' }] : [] }] } });
    }
    const polled = path.match(/^\/jobs\/([^/]+)$/);
    if (polled) return json({ data: managed(polled[1]) });
    throw new Error('Unexpected provider request ' + method + ' ' + path);
  }) as typeof fetch;
}

async function fixture(overrides: Partial<Fake> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-asks-'));
  const store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  vault.set('chatgpt', { active: 'test-account', profiles: [{ id: 'test-account', access_token: 'synthetic-access', expiresAt: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] }] });
  vault.set('console', { key: 'synthetic-console-credential' });
  const state: Fake = { credits: 1, platforms: ['chatgpt', 'gemini'], missing: [], chatgptFails: false, domainKnown: true, estimates: [], purchases: [], openai: [], ...overrides };
  const original = globalThis.fetch;
  globalThis.fetch = fakeProviders(state);
  const { app, runner } = await createApp(store, vault, session);
  const launch = { id: randomUUID(), name: 'Launch', prompts: [], createdAt: '2026-11-04T12:00:00.000Z' };
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example Brand', prompts: ['Which example dashboards are free?'], topics: [launch] }));
  const ask = (payload: object, key = 'ask-' + randomUUID()) =>
    app.inject({ method: 'POST', url: `/api/projects/${project.id}/asks`, headers: { ...headers, 'idempotency-key': key }, payload });
  const read = async (askId: string) => (await app.inject({ url: `/api/projects/${project.id}/asks/${askId}`, headers })).json();
  return { store, app, runner, state, project, launch, ask, read,
    async close() { globalThis.fetch = original; await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('an ask collects each engine once and keeps its answers out of the website\'s evidence', async () => {
  const f = await fixture();
  try {
    const check = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider: 'chatgpt', model: 'fixture-model' }), 'evidence-check');
    await f.runner.tick();
    assert.equal(f.store.job(check.id).status, 'completed');
    const workspace = async () => (await f.app.inject({ url: `/api/projects/${f.project.id}/workspace`, headers })).json();
    const before = await workspace(), exportedBefore = exportProject(f.store, f.project.id);

    const created = await f.ask({ question, engines: ['chatgpt', 'surfacedby-chatgpt', 'surfacedby-gemini'], maxCostUsd: 1 }, 'ask-evidence');
    assert.equal(created.statusCode, 200);
    const { askId, jobs } = created.json();
    assert.equal(jobs.length, 3);
    assert.deepEqual((await f.ask({ question, engines: ['chatgpt', 'surfacedby-chatgpt', 'surfacedby-gemini'], maxCostUsd: 1 }, 'ask-evidence')).json(), { askId, jobs });
    assert.deepEqual(jobs.map((id: string) => f.store.job(id).maxCostUsd), [0, .5, .5]);
    await f.runner.tick();

    const result = await f.read(askId);
    assert.deepEqual(result.engines.map((row: any) => [row.engine, row.state]), [['chatgpt', 'answered'], ['surfacedby-chatgpt', 'answered'], ['surfacedby-gemini', 'answered']]);
    const [api, app] = result.engines;
    assert.equal(api.answer.surface, 'api');
    assert.deepEqual(api.answer.searchQueries, ['free example report tools']);
    assert.equal(api.answer.mentioned, true);
    assert.equal(api.answer.cited, false);
    assert.equal(app.answer.surface, 'consumer_interface');
    assert.equal(app.answer.cited, true);
    assert.deepEqual(f.state.purchases.map(row => row.approved_credits), [5, 5]);
    assert.ok(f.state.estimates.every(row => row.questions.length === 1 && row.questions[0].question === question));
    assert.equal(result.spentUsd, .2);
    assert.equal(result.limitUsd, 1);

    const after = await workspace();
    assert.deepEqual(after.observations, before.observations);
    assert.deepEqual(after.metrics, before.metrics);
    assert.deepEqual(after.presentation, before.presentation);
    assert.ok(after.jobs.every((job: any) => job.kind !== 'ask'));
    const exportedAfter = exportProject(f.store, f.project.id);
    assert.deepEqual(exportedAfter.jobs, exportedBefore.jobs);
    assert.deepEqual(exportedAfter.observations, exportedBefore.observations);
    assert.equal(f.store.observations(f.project.id).length, 1);
    assert.equal(jobs.flatMap((id: string) => f.store.answers(f.project.id, id, 'ask-answer')).length, 3);

    const history = (await f.app.inject({ url: `/api/projects/${f.project.id}/asks`, headers })).json();
    assert.equal(history.asks.length, 1);
    assert.deepEqual(history.asks[0].engines.map((row: any) => row.cited), [false, true, true]);
  } finally { await f.close(); }
});

test('the whole ask request is immutable across concurrent retries and unavailable connections', async () => {
  const f = await fixture();
  try {
    const input = { question, engines: ['chatgpt', 'surfacedby-chatgpt'], maxCostUsd: 1 };
    const responses = await Promise.all([f.ask(input, 'stable-request'), f.ask(input, 'stable-request')]);
    assert.deepEqual(responses.map(row => row.statusCode), [200, 200]);
    assert.deepEqual(responses[0].json(), responses[1].json());
    assert.equal(f.store.jobs(f.project.id).length, 2);
    for (const change of [
      { engines: ['chatgpt', 'surfacedby-chatgpt', 'surfacedby-gemini'] },
      { engines: ['chatgpt'] }, { maxCostUsd: 2 }, { question: 'A different question for the engines?' },
    ]) {
      const refused = await f.ask({ ...input, ...change }, 'stable-request');
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().code, 'idempotency');
    }
    f.state.platforms = [];
    assert.deepEqual((await f.ask(input, 'stable-request')).json(), responses[0].json());
    assert.equal(f.store.jobs(f.project.id).length, 2);
    assert.equal(f.state.purchases.length, 0);
  } finally { await f.close(); }
});

test('deleting an ask leaves a content-free retry tombstone and deleting its brand removes it', async () => {
  const f = await fixture();
  try {
    const input = { question, engines: ['chatgpt'] };
    const { askId } = (await f.ask(input, 'delete-retry')).json();
    await f.runner.tick();
    f.store.deleteAsk(f.project.id, askId);
    assert.equal((await f.ask(input, 'delete-retry')).statusCode, 409);
    assert.equal(f.store.jobs(f.project.id).length, 0);
    const receipt = f.store.db.prepare('SELECT * FROM ask_requests WHERE id=?').get(askId);
    assert.ok(receipt);
    assert.ok(!JSON.stringify(receipt).includes(question));
    f.store.deleteProject(f.project.id, f.project.domain);
    assert.equal(f.store.db.prepare('SELECT * FROM ask_requests WHERE id=?').get(askId), undefined);
  } finally { await f.close(); }
});

test('resuming one engine cannot raise the original group approval', async () => {
  const f = await fixture();
  try {
    const { jobs } = (await f.ask({ question, engines: ['surfacedby-chatgpt', 'surfacedby-gemini'], maxCostUsd: 1 })).json();
    f.store.updateJob(jobs[0], { status: 'paused', error: 'budget' });
    assert.throws(() => f.runner.resume(jobs[0], true, 2), /original ask limit/);
    assert.equal(f.store.job(jobs[0]).maxCostUsd, .5);
    assert.equal(f.store.job(jobs[0]).status, 'paused');
  } finally { await f.close(); }
});

test('all engines retain the brand and language approved at submission even if the brand changes before collection', async () => {
  const f = await fixture();
  try {
    const { askId, jobs } = (await f.ask({ question, engines: ['chatgpt', 'surfacedby-chatgpt'], maxCostUsd: 1 })).json();
    const { id, createdAt, ...settings } = f.project;
    f.store.updateProject(id, projectInput.parse({ ...settings, brand: 'Another name', locale: 'fr-FR' }));
    await f.runner.tick();
    for (const id of jobs) {
      const frozen = JSON.parse(f.store.step(id, 'project')!.body!);
      assert.equal(frozen.brand, f.project.brand);
      assert.equal(frozen.locale, f.project.locale);
      assert.deepEqual(frozen.prompts, [question]);
    }
    const result = await f.read(askId);
    assert.equal(result.brand, f.project.brand);
    assert.equal(result.locale, f.project.locale);
    assert.equal(result.engines[0].answer.mentioned, true);
  } finally { await f.close(); }
});

test('estimates refuse unavailable engines without submitting quotes', async () => {
  const f = await fixture({ platforms: [] });
  try {
    const response = await f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/asks/estimate`, headers,
      payload: { question, engines: ['surfacedby-chatgpt'] } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().totalUsd, null);
    assert.match(response.json().engines[0].note, /Not available/);
    assert.equal(f.state.estimates.length, 0);
    assert.equal(f.state.purchases.length, 0);
  } finally { await f.close(); }
});

test('an ask refuses paid engines without a limit and never buys more than an engine\'s share', async () => {
  const f = await fixture({ credits: 4 });
  try {
    const unpriced = await f.ask({ question, engines: ['chatgpt', 'surfacedby-chatgpt'], maxCostUsd: 0 });
    assert.equal(unpriced.statusCode, 409);
    assert.equal(unpriced.json().code, 'budget');
    assert.equal(f.store.jobs(f.project.id).length, 0);

    const estimate = (await f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/asks/estimate`, headers,
      payload: { question, engines: ['chatgpt', 'surfacedby-chatgpt', 'surfacedby-gemini'] } })).json();
    assert.deepEqual(estimate.engines.map((row: any) => row.estimateUsd), [0, .4, .4]);
    assert.equal(estimate.totalUsd, .8);
    assert.equal(f.state.purchases.length, 0);

    const { jobs } = (await f.ask({ question, engines: ['surfacedby-chatgpt', 'surfacedby-gemini'], maxCostUsd: .1 })).json();
    assert.deepEqual(jobs.map((id: string) => f.store.job(id).maxCostUsd), [.05, .05]);
    await f.runner.tick();
    assert.deepEqual(jobs.map((id: string) => [f.store.job(id).status, f.store.job(id).error]), [['paused', 'budget'], ['paused', 'budget']]);
    assert.equal(f.state.purchases.length, 0);

    const direct = await f.app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers, 'idempotency-key': 'direct-ask-job' },
      payload: { projectId: f.project.id, kind: 'ask', askId: randomUUID(), question, provider: 'console', maxCostUsd: 5 } });
    assert.equal(direct.statusCode, 409);
    const scheduled = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: { ...headers, 'idempotency-key': 'scheduled-ask' },
      payload: { job: { projectId: f.project.id, kind: 'ask', askId: randomUUID(), question, provider: 'chatgpt' }, frequency: 'daily', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 0 } });
    assert.equal(scheduled.statusCode, 422);
  } finally { await f.close(); }
});

test('an engine with no answer stays out of every count, and a failed free answer buys nothing else', async () => {
  const f = await fixture({ missing: ['gemini'], chatgptFails: true });
  try {
    const { askId, jobs } = (await f.ask({ question, engines: ['chatgpt', 'surfacedby-chatgpt', 'surfacedby-gemini'], maxCostUsd: 1 })).json();
    await f.runner.tick();
    const result = await f.read(askId);
    assert.deepEqual(result.engines.map((row: any) => [row.engine, row.state]), [['chatgpt', 'paused'], ['surfacedby-chatgpt', 'answered'], ['surfacedby-gemini', 'no_answer']]);
    assert.equal(result.engines[0].error, 'quota');
    assert.equal(result.engines[2].answer, null);
    const listed = (await f.app.inject({ url: `/api/projects/${f.project.id}/asks`, headers })).json().asks[0];
    assert.deepEqual(listed.engines.map((row: any) => row.mentioned), [null, true, null]);
    assert.equal(f.store.jobs(f.project.id).length, jobs.length);
    assert.equal(f.state.purchases.length, 2);

    const free = (await f.ask({ question: 'Which example reports cost nothing?', engines: ['chatgpt'] })).json();
    await f.runner.tick();
    assert.equal(f.store.job(free.jobs[0]).error, 'quota');
    assert.equal(f.store.jobs(f.project.id).length, jobs.length + 1);
    assert.equal(f.state.purchases.length, 2);
  } finally { await f.close(); }
});

test('an ask runs beside a running check instead of waiting behind it', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ gate, gated: 'Which example dashboards are free?' });
  try {
    const check = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider: 'chatgpt', model: 'fixture-model' }), 'slow-check');
    const pending = f.runner.tick();
    const { askId, jobs } = (await f.ask({ question, engines: ['chatgpt'] })).json();
    const next = f.runner.tick();
    for (let attempt = 0; attempt < 200 && f.store.job(jobs[0]).status !== 'completed'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.store.job(jobs[0]).status, 'completed');
    assert.equal(f.store.job(check.id).status, 'running');
    assert.equal(f.runner.isWorking(check.id), true);
    assert.equal(f.runner.hasActiveProject(f.project.id), true);
    assert.equal((await f.read(askId)).engines[0].state, 'answered');
    release();
    await Promise.all([pending, next]);
    assert.equal(f.store.job(check.id).status, 'completed');
  } finally { await f.close(); }
});

test('tracking adds the question once, and deleting an ask removes its runs and answers', async () => {
  const f = await fixture({ platforms: ['chatgpt'] });
  try {
    const catalog = (await f.app.inject({ url: `/api/projects/${f.project.id}/asks/engines`, headers })).json();
    const reason = (id: string) => catalog.engines.find((row: any) => row.id === id).reason;
    assert.equal(reason('chatgpt'), undefined);
    assert.equal(reason('surfacedby-gemini'), 'Not available on this SurfacedBy connection');
    assert.equal(reason('dataforseo-perplexity'), 'Not connected');
    assert.equal(catalog.defaultLimitUsd, 1);
    assert.equal((await f.ask({ question, engines: ['surfacedby-gemini'], maxCostUsd: 1 })).json().code, 'capability');

    const { askId, jobs } = (await f.ask({ question, engines: ['chatgpt'] })).json();
    const early = await f.app.inject({ method: 'DELETE', url: `/api/projects/${f.project.id}/asks/${askId}`, headers });
    assert.equal(early.statusCode, 409);
    await f.runner.tick();
    const track = (payload: object) => f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/asks/${askId}/track`, headers, payload });
    assert.equal((await track({ topicId: f.launch.id })).statusCode, 200);
    assert.equal((await track({ topicId: f.launch.id })).statusCode, 200);
    const saved = f.store.project(f.project.id);
    assert.deepEqual(saved.prompts, ['Which example dashboards are free?', question]);
    assert.deepEqual(saved.topics[0].prompts, [question]);
    const result = await f.read(askId);
    assert.equal(result.tracked, true);
    assert.deepEqual(result.topics, [{ id: f.launch.id, name: 'Launch', tracked: true }]);
    assert.equal(f.store.observations(f.project.id).length, 0);

    assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/projects/${f.project.id}/asks/${askId}`, headers })).statusCode, 200);
    const rows = (table: string) => (f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'jobs' ? 'id' : 'job_id'}=?`).get(jobs[0]) as { count: number }).count;
    assert.deepEqual(['jobs', 'steps', 'artifacts'].map(rows), [0, 0, 0]);
    assert.equal((await f.app.inject({ url: `/api/projects/${f.project.id}/asks`, headers })).json().asks.length, 0);
  } finally { await f.close(); }
});

test('earlier tracked answers to the same question show beside an ask, and an unknown website is priced at the start', async () => {
  const f = await fixture({ domainKnown: false });
  try {
    const check = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider: 'chatgpt', model: 'fixture-model' }), 'history-check');
    await f.runner.tick();
    assert.equal(f.store.job(check.id).status, 'completed');
    const { askId } = (await f.ask({ question: '  which EXAMPLE dashboards are free? ', engines: ['chatgpt'] })).json();
    await f.runner.tick();
    const result = await f.read(askId);
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].mentioned, true);
    const estimate = (await f.app.inject({ method: 'POST', url: `/api/projects/${f.project.id}/asks/estimate`, headers,
      payload: { question, engines: ['surfacedby-chatgpt'] } })).json();
    assert.deepEqual(estimate.engines[0], { id: 'surfacedby-chatgpt', estimateUsd: null, note: 'Priced when the ask starts' });
    assert.equal(estimate.totalUsd, null);
  } finally { await f.close(); }
});

test('the limit is shared so paid engines can never spend more than it, and the warning names the smallest limit that fits', () => {
  for (const [limit, engines] of [[1, 3], [.1, 3], [.07, 2], [10, 6], [.01, 2]] as const)
    assert.ok(askShare(limit, engines) * engines <= limit + 1e-9, `${limit} across ${engines}`);
  assert.equal(askShare(.25, 2), .12);
  assert.deepEqual(askFit(.1, [.1, .1]), { shareUsd: .05, overLimit: true, suggestedLimitUsd: .2 });
  assert.deepEqual(askFit(.24, [.12, .12]), { shareUsd: .12, overLimit: false, suggestedLimitUsd: .24 });
  assert.deepEqual(askFit(.23, [.12, .12]), { shareUsd: .11, overLimit: true, suggestedLimitUsd: .24 });
  assert.equal(askFit(1, [null, .4]).overLimit, false);
  assert.equal(askFit(0, [null]).overLimit, true);
  assert.deepEqual(askFit(1, []), { shareUsd: 0, overLimit: false, suggestedLimitUsd: null });
});

test('a fork ask without a saved approval cannot buy more work on retry', async () => {
  const f = await fixture();
  try {
    const input = { question, engines: ['chatgpt'], maxCostUsd: 0 };
    const { askId, jobs } = (await f.ask(input, 'fork-request')).json();
    f.store.db.prepare('DELETE FROM ask_requests WHERE id=?').run(askId);
    const retried = await f.ask({ ...input, engines: ['chatgpt', 'surfacedby-chatgpt'], maxCostUsd: 1 }, 'fork-request');
    assert.equal(retried.statusCode, 409);
    assert.equal(retried.json().code, 'idempotency');
    assert.deepEqual(f.store.jobs(f.project.id).map(job => job.id), jobs);
    assert.equal((await f.read(askId)).engines.length, 1);
    assert.equal(f.state.purchases.length, 0);
  } finally { await f.close(); }
});

test('workspace activity follows asks without adding them to visibility and retains unresolved cancellation', async () => {
  const f = await fixture();
  try {
    const { askId, jobs } = (await f.ask({ question, engines: ['chatgpt', 'surfacedby-chatgpt'], maxCostUsd: 1 })).json();
    const workspace = async () => (await f.app.inject({ url: `/api/projects/${f.project.id}/workspace`, headers })).json();
    assert.deepEqual((await workspace()).askActivity, [{ askId, question, collecting: 2, needsAttention: 0, paused: false }]);
    f.store.updateJob(jobs[0], { status: 'completed' });
    f.store.updateJob(jobs[1], { status: 'cancelled', error: 'cancel_remote' });
    const unresolved = await workspace();
    assert.deepEqual(unresolved.askActivity, [{ askId, question, collecting: 0, needsAttention: 1, paused: true }]);
    assert.deepEqual(unresolved.jobs, []);
    assert.equal(unresolved.metrics.completed, 0);
    f.store.updateJob(jobs[1], { error: null });
    assert.deepEqual((await workspace()).askActivity, []);
  } finally { await f.close(); }
});
