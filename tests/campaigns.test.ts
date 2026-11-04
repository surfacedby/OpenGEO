import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
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
const session = 'synthetic-campaign-session';
const headers = { host: '127.0.0.1:4318', authorization: 'Bearer ' + session };
const campaign = (name: string, questions: string[], extra = {}) => ({ id: randomUUID(), name, prompts: questions, createdAt: '2026-10-29T12:00:00.000Z', ...extra });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-campaigns-'));
  const store = new Store(dir);
  const vault = new Vault(dir, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  return { dir, store, vault, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
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
const measure = (projectId: string, campaignId?: string) => jobInput.parse({ projectId, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, ...(campaignId ? { campaignId } : {}) });

test('campaigns keep only the brand\'s questions and competitors, and target pages stay on the website', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, competitors: ['example.org', 'example.net'] }));
    const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, headers, payload: payload as object });
    const launch = campaign('Launch', [prompts[2], prompts[0], 'Which question is not tracked?'], { competitors: ['example.net', 'example.edu'], targetUrls: ['https://www.example.com/dashboard'] });
    let saved = (await patch({ campaigns: [launch] })).json();
    assert.deepEqual(saved.campaigns[0].prompts, [prompts[0], prompts[2]]);
    assert.deepEqual(saved.campaigns[0].competitors, ['example.net']);
    assert.equal(saved.campaigns[0].status, 'active');
    saved = (await patch({ prompts: prompts.slice(0, 2) })).json();
    assert.deepEqual(saved.campaigns[0].prompts, [prompts[0]]);
    saved = (await patch({ brand: 'Renamed' })).json();
    assert.equal(saved.campaigns.length, 1);
    const offsite = await patch({ campaigns: [{ ...launch, targetUrls: ['https://example.org/dashboard'] }] });
    assert.equal(offsite.statusCode, 422);
    assert.deepEqual(offsite.json().fields[0].path, ['campaigns', 0, 'targetUrls', 0]);
    assert.equal((await patch({ campaigns: [launch, launch] })).statusCode, 422);
  } finally { await app.close(); f.close(); }
});

test('a campaign check asks only its questions and leaves the brand view on the full check', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const launch = campaign('Launch', [prompts[0], prompts[2]], { targetUrls: ['https://example.com/dashboard'] });
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, campaigns: [launch] }));
    f.store.set('measurementRequestEstimateUsd', .1);
    const asked: string[] = [], runner = new Runner(f.store, provider(asked) as any);
    const full = f.store.enqueue(measure(project.id), 'campaign-full');
    await runner.tick();
    const scoped = f.store.enqueue(measure(project.id, launch.id), 'campaign-scoped');
    await runner.tick();
    assert.deepEqual(asked.slice(3), [prompts[0], prompts[2]]);
    assert.deepEqual(JSON.parse(f.store.step(scoped.id, 'project')!.body!).prompts, [prompts[0], prompts[2]]);
    assert.equal(f.store.job(scoped.id).requestedAnswers, 2);
    const workspace = (await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json();
    assert.equal(workspace.measurement.id, full.id);
    assert.equal(workspace.metrics.requested, 3);
    assert.deepEqual(workspace.presentation.history.map((point: any) => [point.jobId, point.campaign ?? null, point.mentionRate]), [[full.id, null, (1 / 3) * 100], [scoped.id, 'Launch', null]]);
    assert.equal(workspace.campaigns[0].questions, 2);
    assert.equal(workspace.campaigns[0].targetsCited, 1);
    const view = (await app.inject({ url: `/api/projects/${project.id}/campaigns/${launch.id}`, headers })).json();
    assert.equal(view.measurement.id, scoped.id);
    assert.deepEqual(view.metrics.requested, 2);
    assert.equal(view.metrics.mentionRate, 50);
    assert.deepEqual(view.presentation.history.map((point: any) => point.jobId), [full.id, scoped.id]);
    assert.deepEqual(view.checks.map((check: any) => [check.campaignCheck, check.comparable]), [[true, true], [false, true]]);
    assert.deepEqual(view.targets.map((target: any) => [target.answersCiting, target.answersCollected]), [[1, 2]]);
    assert.equal((await app.inject({ url: `/api/projects/${project.id}/campaigns/${randomUUID()}`, headers })).statusCode, 404);
  } finally { await app.close(); f.close(); }
});

test('a question in two campaigns counts once for the brand and once in each campaign', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const first = campaign('First', [prompts[0], prompts[1]]), second = campaign('Second', [prompts[0], prompts[2]]);
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, campaigns: [first, second] }));
    f.store.set('measurementRequestEstimateUsd', .1);
    f.store.enqueue(measure(project.id), 'shared-full');
    await new Runner(f.store, provider([]) as any).tick();
    const workspace = (await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json();
    assert.equal(workspace.metrics.completed, 3);
    assert.deepEqual(workspace.campaigns.map((item: any) => [item.name, item.metrics.completed]), [['First', 2], ['Second', 2]]);
  } finally { await app.close(); f.close(); }
});

test('a check that skipped a campaign question is not a campaign reading, and missing answers stay missing', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: prompts.slice(0, 2) }));
    f.store.set('measurementRequestEstimateUsd', .1);
    f.store.enqueue(measure(project.id), 'partial-full');
    await new Runner(f.store, provider([]) as any).tick();
    const later = campaign('Later', [prompts[0], prompts[2]]);
    f.store.updateProject(project.id, projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, campaigns: [later] }));
    let view = (await app.inject({ url: `/api/projects/${project.id}/campaigns/${later.id}`, headers })).json();
    assert.equal(view.measurement, null);
    assert.equal(view.metrics.requested, 0);
    assert.equal((await app.inject({ url: `/api/projects/${project.id}/workspace`, headers })).json().campaigns[0].metrics, null);
    const paused = f.store.enqueue(measure(project.id, later.id), 'partial-scoped');
    await new Runner(f.store, provider([], prompts[2]) as any).tick();
    assert.equal(f.store.job(paused.id).status, 'paused');
    view = (await app.inject({ url: `/api/projects/${project.id}/campaigns/${later.id}`, headers })).json();
    assert.equal(view.measurement.id, paused.id);
    assert.deepEqual([view.metrics.completed, view.metrics.missing], [1, 1]);
    assert.equal(view.presentation.history.length, 0);
  } finally { await app.close(); f.close(); }
});

test('campaign checks and schedules are refused for another brand\'s campaign and for other kinds of work', async () => {
  const f = fixture();
  const { app } = await createApp(f.store, f.vault, session);
  try {
    const owned = campaign('Owned', [prompts[0]]), empty = campaign('Empty', []);
    const other = f.store.createProject(projectInput.parse({ domain: 'example.org', brand: 'Other', prompts, campaigns: [owned] }));
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, campaigns: [empty] }));
    const start = (payload: object) => app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers, 'idempotency-key': randomUUID() }, payload });
    assert.equal((await start({ projectId: project.id, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, campaignId: owned.id })).statusCode, 409);
    assert.equal((await start({ projectId: project.id, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, campaignId: empty.id })).statusCode, 409);
    assert.equal((await start({ projectId: other.id, kind: 'audit', campaignId: owned.id })).statusCode, 422);
    assert.equal(f.store.jobs().length, 0);
    const schedule = (projectId: string, campaignId: string) => app.inject({ method: 'POST', url: '/api/schedules', headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { job: { projectId, kind: 'measure', provider: 'dataforseo', maxCostUsd: 1, campaignId }, frequency: 'weekly', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 1 } });
    assert.equal((await schedule(project.id, owned.id)).statusCode, 409);
    assert.equal((await schedule(project.id, empty.id)).statusCode, 409);
    assert.equal((await schedule(other.id, owned.id)).statusCode, 200);
    assert.deepEqual((await app.inject({ url: '/api/schedules', headers })).json().map((row: { job: { campaignId: string } }) => row.job.campaignId), [owned.id]);
  } finally { await app.close(); f.close(); }
});

test('export and import keep campaigns and the campaign link on checks', async () => {
  const f = fixture();
  try {
    const launch = campaign('Launch', [prompts[1]], { reviewBy: '2026-12-01' });
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, campaigns: [launch] }));
    f.store.set('measurementRequestEstimateUsd', .1);
    f.store.enqueue(measure(project.id, launch.id), 'portable-scoped');
    await new Runner(f.store, provider([]) as any).tick();
    const restored = importProject(f.store, exportProject(f.store, project.id));
    const copy = f.store.project(restored.project.id);
    assert.deepEqual(copy.campaigns, project.campaigns);
    assert.deepEqual(f.store.jobs(copy.id).map(job => job.campaignId), [launch.id]);
  } finally { f.close(); }
});

test('a campaign check on SurfacedBy prices only the campaign\'s questions and waits for approval', async () => {
  const f = fixture();
  f.vault.set('console', { key: 'synthetic-console-credential' });
  const launch = campaign('Launch', [prompts[2]]);
  const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts, campaigns: [launch] }));
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
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: .5, campaignId: launch.id }), 'console-scoped');
    await runner.tick();
    assert.deepEqual(estimated, [prompts[2]]);
    assert.equal(f.store.job(job.id).error, 'approval');
    assert.equal(purchases, 0);
  } finally { globalThis.fetch = original; server.close(); f.close(); }
});
