import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { Runner } from '../server/workflows.js';
import { Connections } from '../server/oauth.js';
import { Providers } from '../server/providers.js';
import { ProviderError, jobInput, projectInput } from '../server/contracts.js';
import { exportProject } from '../server/export.js';
import { importProject } from '../server/import.js';

const prompts = ['Which example tools publish reports?', 'How do teams share example reports?', 'What is the best example dashboard?'];
const session = 'synthetic-topic-session';
const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };
const topic = (name: string, questions: string[], extra = {}) => ({ id: randomUUID(), name, prompts: questions, createdAt: '2026-10-29T12:00:00.000Z', ...extra });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-topics-'));
  const store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  return { dir, store, vault, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('tracking suggestions appends to current prompts without replacing topics or duplicating retries', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: [prompts[0]], topics: [topic('Reports', [prompts[0]])] }));
    f.store.updateProject(project.id, { ...project, prompts: [prompts[0], prompts[1]] });
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/prompts`, headers, payload: { prompts: [prompts[0].toUpperCase(), ' ' + prompts[2] + ' ', prompts[2]] } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().prompts, prompts);
    assert.deepEqual(response.json().topics, project.topics);
    const repeated = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/prompts`, headers, payload: { prompts: [prompts[2]] } });
    assert.deepEqual(repeated.json().prompts, prompts);
    const denied = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/prompts`, headers: { host: '127.0.0.1:4318' }, payload: { prompts: ['Unauthorized new prompt'] } });
    assert.equal(denied.statusCode, 401);
    const invalid = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/prompts`, headers, payload: { prompts: [''] } });
    assert.equal(invalid.statusCode, 422);
    assert.deepEqual(f.store.project(project.id).prompts, prompts);
  } finally { await app.close(); f.close(); }
});

function provider(asked: string[], fail?: string) {
  return {
    models: async () => [{ id: 'test-model', name: 'Test', contextLength: 10000, inputUsd: 0, outputUsd: 0 }],
    measure: async (_platform: string, _model: string, prompt: string) => {
      asked.push(prompt);
      if (prompt === fail) throw new ProviderError('quota', 'Limit reached');
      const own = prompt.includes('dashboard');
      return { text: own ? 'Example has a dashboard.' : 'Other tools publish reports.', citations: [{ url: own ? 'https://example.com/dashboard/?utm_source=openai' : 'https://example.org/reports', title: 'Reports' }], model: 'test-model', costUsd: .1 };
    },
  };
}
const measure = (projectId: string, topicId?: string) => jobInput.parse({ projectId, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, ...(topicId ? { topicId } : {}) });

test('contributor campaign data migrates atomically without losing scopes, schedules or answers', () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const launch = topic('Launch', [prompts[0]]);
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts }));
    const current = f.store.enqueue(measure(project.id), 'legacy-check');
    const { topics, ...legacyProject } = project;
    f.store.db.prepare('UPDATE projects SET body=? WHERE id=?').run(JSON.stringify({ ...legacyProject, campaigns: [launch] }), project.id);
    f.store.db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify({ ...current, campaignId: launch.id }), current.id);
    f.store.setStep(current.id, 'project', 'done', { ...legacyProject, campaigns: [launch] });
    f.store.set('schedules', [{ id: 'saved-schedule', job: { ...measure(project.id), campaignId: launch.id } }]);
    f.store.set('scheduleRequest:legacy', { id: 'saved-schedule', input: { job: { ...measure(project.id), campaignId: launch.id } } });
    f.store.db.prepare('DELETE FROM migrations WHERE version=3').run();
    f.store.close();
    reopened = new Store(f.dir);
    assert.equal(reopened.project(project.id).topics[0].id, launch.id);
    assert.equal(reopened.job(current.id).topicId, launch.id);
    assert.equal('campaignId' in reopened.job(current.id), false);
    assert.equal(JSON.parse(reopened.step(current.id, 'project')!.body!).topics[0].id, launch.id);
    assert.equal(reopened.setting<any[]>('schedules', [])[0].job.topicId, launch.id);
    assert.equal(reopened.setting<any>('scheduleRequest:legacy', null).input.job.topicId, launch.id);
    assert.equal(reopened.enqueue(measure(project.id, launch.id), 'legacy-check').id, current.id);
  } finally { reopened?.close(); if (f.store.db.open) f.store.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('a conflicting migration rolls back all projects and leaves the original database inspectable', () => {
  const f = fixture();
  const launch = topic('Launch', [prompts[0]]);
  const first = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts }));
  const second = f.store.createProject(projectInput.parse({ domain: 'example.org', brand: 'Other', prompts }));
  const { topics: _firstTopics, ...legacy } = first;
  const originalFirst = JSON.stringify({ ...legacy, campaigns: [launch] });
  const originalSecond = JSON.stringify({ ...second, campaigns: [launch] });
  f.store.db.prepare('UPDATE projects SET body=? WHERE id=?').run(originalFirst, first.id);
  f.store.db.prepare('UPDATE projects SET body=? WHERE id=?').run(originalSecond, second.id);
  f.store.db.prepare('DELETE FROM migrations WHERE version=3').run();
  f.store.close();
  try {
    assert.throws(() => new Store(f.dir), /Conflicting Topic and Campaign data/);
    const original = new Database(join(f.dir, 'opengeo.sqlite'));
    try {
      assert.equal((original.prepare('SELECT body FROM projects WHERE id=?').get(first.id) as { body: string }).body, originalFirst);
      assert.equal((original.prepare('SELECT body FROM projects WHERE id=?').get(second.id) as { body: string }).body, originalSecond);
      assert.equal(original.prepare('SELECT version FROM migrations WHERE version=3').get(), undefined);
    } finally { original.close(); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('duplicate visibility starts are refused while retries keep the original receipt', () => {
  const f = fixture();
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts }));
    const first = f.store.enqueue(measure(project.id), 'first-check');
    assert.equal(f.store.enqueue(measure(project.id), 'first-check').id, first.id);
    for (const status of ['queued', 'running', 'paused'] as const) {
      f.store.updateJob(first.id, { status });
      assert.throws(() => f.store.enqueue(measure(project.id), 'duplicate-' + status), /already in progress/);
    }
    f.store.updateJob(first.id, { status: 'completed' });
    assert.notEqual(f.store.enqueue(measure(project.id), 'next-check').id, first.id);
  } finally { f.close(); }
});

test('topics keep only the brand\'s questions and competitors, and target pages stay on the website', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, competitors: ['example.org', 'example.net'] }));
    const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, headers, payload: payload as object });
    const launch = topic('Launch', [prompts[2], prompts[0], 'Which question is not tracked?'], { competitors: ['example.net', 'example.edu'], targetUrls: ['https://www.example.com/dashboard'] });
    let saved = (await patch({ topics: [launch] })).json();
    assert.deepEqual(saved.topics[0].prompts, [prompts[0], prompts[2]]);
    assert.deepEqual(saved.topics[0].competitors, ['example.net']);
    assert.equal(saved.topics[0].status, 'active');
    saved = (await patch({ prompts: prompts.slice(0, 2) })).json();
    assert.deepEqual(saved.topics[0].prompts, [prompts[0]]);
    saved = (await patch({ brand: 'Renamed' })).json();
    assert.equal(saved.topics.length, 1);
    const offsite = await patch({ topics: [{ ...launch, targetUrls: ['https://example.org/dashboard'] }] });
    assert.equal(offsite.statusCode, 422);
    assert.deepEqual(offsite.json().fields[0].path, ['topics', 0, 'targetUrls', 0]);
    assert.equal((await patch({ topics: [launch, launch] })).statusCode, 422);
  } finally { await app.close(); f.close(); }
});

test('a topic check asks only its questions and leaves the brand view on the full check', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const launch = topic('Launch', [prompts[0], prompts[2]], { targetUrls: ['https://example.com/dashboard'] });
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [launch] }));
    f.store.set('measurementRequestEstimateUsd', .1);
    const asked: string[] = [], runner = new Runner(f.store, provider(asked) as any);
    const full = f.store.enqueue(measure(project.id), 'topic-full');
    await runner.tick();
    const scoped = f.store.enqueue(measure(project.id, launch.id), 'topic-scoped');
    await runner.tick();
    assert.deepEqual(asked.slice(3), [prompts[0], prompts[2]]);
    assert.deepEqual(JSON.parse(f.store.step(scoped.id, 'project')!.body!).prompts, [prompts[0], prompts[2]]);
    assert.equal(f.store.job(scoped.id).requestedAnswers, 2);
    const workspace = (await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json();
    assert.equal(workspace.measurement.id, full.id);
    assert.equal(workspace.metrics.requested, 3);
    assert.deepEqual(workspace.presentation.history.map((point: any) => [point.jobId, point.topic ?? null, point.mentionRate]), [[full.id, null, (1 / 3) * 100], [scoped.id, 'Launch', null]]);
    assert.equal(workspace.topics[0].questions, 2);
    assert.equal(workspace.topics[0].targetsCited, 1);
    const view = (await app.inject({ url: `/api/projects/${project.id}/topics/${launch.id}`, headers })).json();
    assert.equal(view.measurement.id, scoped.id);
    assert.deepEqual(view.metrics.requested, 2);
    assert.equal(view.metrics.mentionRate, 50);
    assert.deepEqual(view.presentation.history.map((point: any) => point.jobId), [full.id, scoped.id]);
    assert.deepEqual(view.checks.map((check: any) => [check.topicCheck, check.comparable]), [[true, true], [false, true]]);
    assert.deepEqual(view.targets.map((target: any) => [target.answersCiting, target.answersCollected]), [[1, 2]]);
    assert.equal((await app.inject({ url: `/api/projects/${project.id}/topics/${randomUUID()}`, headers })).statusCode, 404);
  } finally { await app.close(); f.close(); }
});

test('a question in two topics counts once for the brand and once in each topic', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const first = topic('First', [prompts[0], prompts[1]]), second = topic('Second', [prompts[0], prompts[2]]);
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [first, second] }));
    f.store.set('measurementRequestEstimateUsd', .1);
    f.store.enqueue(measure(project.id), 'shared-full');
    await new Runner(f.store, provider([]) as any).tick();
    const workspace = (await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json();
    assert.equal(workspace.metrics.completed, 3);
    assert.deepEqual(workspace.topics.map((item: any) => [item.name, item.metrics.completed]), [['First', 2], ['Second', 2]]);
  } finally { await app.close(); f.close(); }
});

test('a check that skipped a topic question is not a topic reading, and missing answers stay missing', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: prompts.slice(0, 2) }));
    f.store.set('measurementRequestEstimateUsd', .1);
    f.store.enqueue(measure(project.id), 'partial-full');
    await new Runner(f.store, provider([]) as any).tick();
    const later = topic('Later', [prompts[0], prompts[2]]);
    f.store.updateProject(project.id, projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [later] }));
    let view = (await app.inject({ url: `/api/projects/${project.id}/topics/${later.id}`, headers })).json();
    assert.equal(view.measurement, null);
    assert.equal(view.metrics.requested, 0);
    assert.equal((await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json().topics[0].metrics, null);
    const paused = f.store.enqueue(measure(project.id, later.id), 'partial-scoped');
    await new Runner(f.store, provider([], prompts[2]) as any).tick();
    assert.equal(f.store.job(paused.id).status, 'paused');
    view = (await app.inject({ url: `/api/projects/${project.id}/topics/${later.id}`, headers })).json();
    assert.equal(view.measurement.id, paused.id);
    assert.deepEqual([view.metrics.completed, view.metrics.missing], [1, 1]);
    assert.equal(view.presentation.history.length, 0);
  } finally { await app.close(); f.close(); }
});

test('topic checks and schedules are refused for another brand\'s topic and for other kinds of work', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const owned = topic('Owned', [prompts[0]]), empty = topic('Empty', []);
    const other = f.store.createProject(projectInput.parse({ domain: 'example.org', brand: 'Other', prompts, topics: [owned] }));
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [empty] }));
    const start = (payload: object) => app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers, 'idempotency-key': randomUUID() }, payload });
    assert.equal((await start({ projectId: project.id, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, topicId: owned.id })).statusCode, 409);
    assert.equal((await start({ projectId: project.id, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, topicId: empty.id })).statusCode, 409);
    assert.equal((await start({ projectId: other.id, kind: 'audit', topicId: owned.id })).statusCode, 422);
    assert.equal(f.store.jobs().length, 0);
    const schedule = (projectId: string, topicId: string) => app.inject({ method: 'POST', url: '/api/schedules', headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { job: { projectId, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, topicId }, frequency: 'weekly', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 1 } });
    assert.equal((await schedule(project.id, owned.id)).statusCode, 409);
    assert.equal((await schedule(project.id, empty.id)).statusCode, 409);
    assert.equal((await schedule(other.id, owned.id)).statusCode, 200);
    assert.deepEqual((await app.inject({ url: '/api/schedules', headers })).json().map((row: { job: { topicId: string } }) => row.job.topicId), [owned.id]);
  } finally { await app.close(); f.close(); }
});

test('export and import keep topics and the topic link on checks', async () => {
  const f = fixture();
  try {
    const launch = topic('Launch', [prompts[1]], { reviewBy: '2026-12-01' });
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [launch] }));
    f.store.set('measurementRequestEstimateUsd', .1);
    f.store.enqueue(measure(project.id, launch.id), 'portable-scoped');
    await new Runner(f.store, provider([]) as any).tick();
    const restored = importProject(f.store, exportProject(f.store, project.id));
    const copy = f.store.project(restored.project.id);
    assert.deepEqual(copy.topics, project.topics);
    assert.deepEqual(f.store.jobs(copy.id).map(job => job.topicId), [launch.id]);
  } finally { f.close(); }
});

test('legacy Campaign exports import as Topics and reject offsite targets without creating a project', () => {
  const f = fixture();
  try {
    const launch = topic('Launch', [prompts[0]], { targetUrls: ['https://example.com/docs'] });
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [launch] }));
    const exported = exportProject(f.store, project.id);
    const { topics, ...legacyProject } = exported.project;
    const legacy = { ...exported, project: { ...legacyProject, campaigns: topics } };
    const restored = importProject(f.store, legacy);
    assert.deepEqual(f.store.project(restored.project.id).topics, project.topics);
    const before = f.store.projects().length;
    assert.throws(() => importProject(f.store, { ...legacy, project: { ...legacy.project, campaigns: [{ ...topics[0], targetUrls: ['https://example.org/private'] }] } }), /target|website/i);
    assert.equal(f.store.projects().length, before);
  } finally { f.close(); }
});

test('a topic check on SurfacedBy prices only the topic\'s questions and waits for approval', async () => {
  const f = fixture();
  f.vault.set('console', { key: 'synthetic-console-credential' });
  const launch = topic('Launch', [prompts[2]]);
  const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, topics: [launch] }));
  const runner = new Runner(f.store, new Providers(f.vault, new Connections(f.store, f.vault)));
  const domain = randomUUID();
  let estimated: string[] = [], purchases = 0;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, path = new URL(request.url!, 'http://localhost').pathname;
    let data: unknown;
    if (path === '/capabilities') data = { platforms: [{ key: 'chatgpt', name: 'ChatGPT', enabled: true }], operations: ['measurement'], content_available: false, models: [], selected_question_platforms: ['chatgpt'] };
    else if (path === '/domains') data = [{ id: domain, domain: project.domain }];
    else if (path.endsWith('/brand')) data = {};
    else if (path.endsWith('/measurement/estimate')) {
      estimated = body.questions.map((row: any) => row.question);
      data = { id: randomUUID(), domain_id: domain, operation: 'measurement', estimated_credits: 4, expires_at: new Date(Date.now() + 3600000).toISOString() };
    } else { purchases++; data = {}; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const original = globalThis.fetch;
  globalThis.fetch = ((url, init) => { const address = new URL(String(url)); return original('http://127.0.0.1:' + (server.address() as any).port + address.pathname.replace('/api/v1/console', '') + address.search, init); }) as typeof fetch;
  try {
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: .5, topicId: launch.id }), 'console-scoped');
    await runner.tick();
    assert.deepEqual(estimated, [prompts[2]]);
    assert.equal(f.store.job(job.id).error, 'approval');
    assert.equal(purchases, 0);
  } finally { globalThis.fetch = original; server.close(); f.close(); }
});
