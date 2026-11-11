import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { start } from '../server/main.js';
import { jobInput, projectInput, type Observation } from '../server/contracts.js';
import { comparisonKey } from '../server/analysis.js';
import { completedAnalysisBasis } from '../server/portable-results.js';
import { deepseekAnswerEstimate, deepseekCheckBudget, deepseekModels } from '../server/deepseek.js';
import { answerReply, fixture, headers, toolReply, type Script } from './deepseek-fixture.js';

// DeepSeek in visibility checks (SOW opengeo-deepseek-engine, phase 8). Synthetic example.com data and the
// fake DeepSeek from deepseek-fixture.ts; nothing leaves the process.
const prompts = ['Which example dashboards are free?', 'Which example tools publish reports?'];
const startCheck = (f: Awaited<ReturnType<typeof fixture>>, body: object, key = 'check-' + randomUUID()) =>
  f.app.inject({ method: 'POST', url: '/api/jobs', headers: { ...headers, 'idempotency-key': key }, payload: { projectId: f.project.id, ...body } });

/** A completed ChatGPT check seeded directly, as the brand's earlier reading. */
function seedChatGptCheck(f: Awaited<ReturnType<typeof fixture>>) {
  const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider: 'chatgpt', model: 'synthetic-gpt' }), 'seeded-gpt');
  for (const prompt of prompts)
    f.store.put('observation', f.project.id, job.id, { id: randomUUID(), projectId: f.project.id, jobId: job.id, prompt, provider: 'chatgpt',
      platform: 'chat_gpt', model: 'synthetic-gpt', locale: 'en-US', observedAt: '2026-11-10T10:00:00.000Z', answer: 'Example answer.',
      citations: [], surface: 'api', mentioned: false, cited: false, costUsd: 0 } satisfies Observation);
  f.store.updateJob(job.id, { status: 'completed', requestedAnswers: 2,
    result: { metrics: { requested: 2, completed: 2, missing: 0, mentionRate: 0, citationRate: 0 }, collectionCompletedAt: '2026-11-10T10:00:00.000Z' } });
  return f.store.job(job.id);
}

test('a DeepSeek check saves its answers as evidence, files them under DeepSeek, and leaves recommendations on the ChatGPT check', async () => {
  const script: Script = { requests: [], replies: [
    toolReply(['free example dashboards']),
    answerReply('Example Brand lists free dashboards at [Example dashboards](https://example.com/dashboards).'),
    answerReply('Several tools publish reports, see https://example.org/compare.'),
  ] };
  const f = await fixture(script, true, prompts);
  try {
    const gpt = seedChatGptCheck(f);
    await new Promise(r => setTimeout(r, 5));
    // The check dialog and a recheck of a DeepSeek check list models for the DeepSeek platform.
    const listed = await f.app.inject({ url: '/api/providers/deepseek/models?platform=deepseek', headers });
    assert.equal(listed.statusCode, 200, listed.body);
    // An older dialog default of "chat_gpt" is still filed under DeepSeek by the server.
    const body = { kind: 'measure', provider: 'deepseek', model: 'deepseek-flash', platform: 'chat_gpt', maxCostUsd: 1 };
    const created = await startCheck(f, body, 'deepseek-check-1');
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().platform, 'deepseek');
    const retried = await startCheck(f, body, 'deepseek-check-1');
    assert.deepEqual([retried.statusCode, retried.json().id], [200, created.json().id], 'a retry with the same key returns the same check');
    await f.runner.tick();

    const job = f.store.job(created.json().id);
    assert.equal(job.status, 'completed');
    assert.equal(job.costBasis, 'includes_estimates');
    assert.ok(job.spentUsd > 0 && job.spentUsd < 0.01, String(job.spentUsd));
    const saved = f.store.answers(f.project.id, job.id, 'observation');
    assert.equal(saved.length, 2, 'both answers are evidence');
    assert.equal(f.store.answers(f.project.id, job.id, 'ask-answer').length, 0);
    const [first, second] = prompts.map(p => saved.find(o => o.prompt === p)!);
    assert.deepEqual([first.provider, first.platform, first.retrieval, first.webSearchConfirmed], ['deepseek', 'deepseek', 'web_search', true]);
    assert.deepEqual(first.searchQueries, ['free example dashboards']);
    assert.deepEqual([first.mentioned, first.cited, second.mentioned, second.cited], [true, true, false, false]);
    assert.notEqual((job.result as any).comparisonKey, comparisonKey(f.project, gpt, f.store.answers(f.project.id, gpt.id, 'observation')),
      'a DeepSeek check is its own comparison series');

    // The brand view shows the newest check, which is DeepSeek's, labeled as DeepSeek.
    const workspace = (await f.app.inject({ url: `/api/projects/${f.project.id}/workspace`, headers })).json();
    assert.equal(workspace.measurement.id, job.id);
    assert.equal(workspace.measurement.platform, 'deepseek');
    assert.ok(workspace.observations.every((o: Observation) => o.provider === 'deepseek'));
    // Recommendations keep reading the ChatGPT check, by default and when an analysis is started without one.
    assert.equal(f.store.jobs(f.project.id).find(completedAnalysisBasis)?.id, gpt.id);
    const analysis = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'diagnose', provider: 'chatgpt' }), 'analysis-default');
    assert.equal(analysis.measurementJobId, gpt.id);
  } finally { await f.close(); }
});

test('a DeepSeek check stops before an answer whose worst case would pass its budget', async () => {
  const costly = (content: string) => ({ ...answerReply(content),
    usage: { prompt_tokens: 50_000, completion_tokens: 20_000, total_tokens: 70_000, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50_000 } });
  const script: Script = { requests: [], replies: [costly('Example Brand has free dashboards.')] };
  const f = await fixture(script, true, prompts);
  try {
    const [flash] = deepseekModels(['deepseek-flash']);
    assert.ok(deepseekAnswerEstimate(flash, 1300, 4096) < 0.085, 'one worst case fits the budget, so the first answer starts');
    const created = await startCheck(f, { kind: 'measure', provider: 'deepseek', model: 'deepseek-flash', maxCostUsd: 0.085 });
    await f.runner.tick();
    const job = f.store.job(created.json().id);
    assert.equal(job.error, 'budget');
    assert.equal(f.store.answers(f.project.id, job.id, 'observation').length, 1, 'the first answer is kept');
    assert.equal(script.requests.filter(r => r.path === '/chat/completions').length, 1, 'no request was made for the second answer');
  } finally { await f.close(); }
});

test('the suggested check budget lets a whole check finish and scales with the model', () => {
  const [flash, pro] = deepseekModels(['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(deepseekCheckBudget(82, flash), 1, 'the owner\'s 82 questions on Flash suggest $1.00');
  assert.equal(deepseekCheckBudget(1, flash), 0.25, 'never below $0.25');
  assert.ok(deepseekCheckBudget(82, pro) > deepseekCheckBudget(82, flash));
  // Each answer needs its worst case to fit after the answers before it, so the suggestion must cover that.
  const worst = deepseekAnswerEstimate(flash, 1700, 4096);
  assert.ok(deepseekCheckBudget(82, flash) >= 81 * 0.0049 + worst, 'covers 81 typical answers plus one worst case');
});

test('a weekly DeepSeek schedule with a per-check and monthly budget is accepted', async () => {
  const f = await fixture({ requests: [], replies: [] }, true, prompts);
  try {
    const schedule = { job: { projectId: f.project.id, kind: 'measure', provider: 'deepseek', model: 'deepseek-flash', maxCostUsd: 1 },
      frequency: 'weekly', weekday: 5, hour: 9, timezone: 'America/Chicago', monthlyBudgetUsd: 5 };
    const saved = await f.app.inject({ method: 'POST', url: '/api/schedules', headers: { ...headers, 'idempotency-key': 'weekly-deepseek' }, payload: schedule });
    assert.equal(saved.statusCode, 200, saved.body);
    const list = (await f.app.inject({ url: '/api/schedules', headers })).json();
    const row = (Array.isArray(list) ? list : list.schedules).find((s: any) => s.job.provider === 'deepseek');
    assert.deepEqual([row.job.kind, row.job.maxCostUsd, row.monthlyBudgetUsd, row.weekday, row.hour], ['measure', 1, 5, 5, 9]);
  } finally { await f.close(); }
});

test('agents can start a DeepSeek check through the MCP, and only a check', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-deepseek-mcp-'));
  const runtime = await start({ directory, port: 0, protector: { encrypt: value => Buffer.from(value), decrypt: value => value.toString() } });
  const client = new Client({ name: 'Local verification', version: '1.0.0' });
  const env = Object.fromEntries(Object.entries({ ...process.env, OPENGEO_DATA_DIR: directory })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  try {
    await runtime.runner.stop(); runtime.scheduler.stop(); runtime.usage.setEnabled(false);
    const project = runtime.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts }));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('node_modules/tsx/dist/cli.mjs'), 'server/mcp.ts'], env, stderr: 'pipe' }));
    const tool = (await client.listTools()).tools.find(t => t.name === 'start_workflow')!;
    assert.ok(((tool.inputSchema.properties as any).provider.enum as string[]).includes('deepseek'));
    const read = (result: any) => JSON.parse(result.content[0].text);
    const check = await client.callTool({ name: 'start_workflow', arguments: { projectId: project.id, kind: 'measure', provider: 'deepseek', maxCostUsd: 1 } });
    assert.equal(check.isError, false);
    assert.deepEqual([read(check).provider, read(check).platform, read(check).status], ['deepseek', 'deepseek', 'queued']);
    const analysis = await client.callTool({ name: 'start_workflow', arguments: { projectId: project.id, kind: 'diagnose', provider: 'deepseek', maxCostUsd: 1 } });
    assert.equal(analysis.isError, true, 'analysis stays with the other providers');
  } finally {
    await client.close(); await runtime.app.close(); rmSync(directory, { recursive: true, force: true });
  }
});
