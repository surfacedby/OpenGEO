import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Scheduler, scheduledBudgetCeiling } from '../server/scheduler.js';
import { Runner } from '../server/workflows.js';
import { jobInput, projectInput, type Model } from '../server/contracts.js';
import type { Providers } from '../server/providers.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opengeo-budget-'));
  const store = new Store(dir);
  const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example',
    prompts: ['Which example is useful?', 'Where can I find examples?', 'How can I use examples?'] }));
  return { store, project, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('a schedule uses its exact remaining decimal allowance and retains it after removal', () => {
  const f = fixture();
  try {
    const scheduler = new Scheduler(f.store);
    const config = scheduler.add({ job: { projectId: f.project.id, kind: 'measure', provider: 'console', maxCostUsd: 0.2 },
      frequency: 'daily', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 0.3 });
    f.store.set('schedules', [{ ...config, nextAt: '2026-11-01T09:00:00.000Z' }]);
    scheduler.tick(new Date('2026-11-01T10:00:00Z'));
    const first = f.store.jobs()[0];
    f.store.updateJob(first.id, { status: 'completed', spentUsd: 0.1 });
    scheduler.tick(new Date('2026-11-02T10:00:00Z'));
    assert.equal(f.store.jobs().length, 2, 'the remaining $0.20 funds the next run');
    const next = f.store.jobs().find(job => job.id !== first.id)!;
    assert.equal(scheduledBudgetCeiling(f.store, next), 0.2);
    scheduler.remove(config.id);
    assert.equal(scheduledBudgetCeiling(f.store, next), 0.2);
    assert.equal(f.store.job(first.id).spentUsd, 0.1);
  } finally { f.close(); }
});

test('a resumed schedule cannot exceed its approval by a floating-point tolerance', () => {
  const f = fixture();
  try {
    const scheduler = new Scheduler(f.store);
    const config = scheduler.add({ job: { projectId: f.project.id, kind: 'measure', provider: 'console', maxCostUsd: 0.1 },
      frequency: 'daily', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 0.2 });
    f.store.set('schedules', [{ ...config, nextAt: '2026-11-01T09:00:00.000Z' }]);
    scheduler.tick(new Date('2026-11-01T10:00:00Z'));
    const job = f.store.jobs()[0];
    f.store.updateJob(job.id, { status: 'paused', error: 'budget' });
    const runner = new Runner(f.store, {} as Providers);
    assert.throws(() => runner.resume(job.id, false, 0.2000000001), (error: any) => error.code === 'budget');
    assert.equal(f.store.job(job.id).status, 'paused');
    assert.equal(f.store.job(job.id).maxCostUsd, 0.1);
    runner.resume(job.id, false, 0.2);
    assert.equal(f.store.job(job.id).maxCostUsd, 0.2);
  } finally { f.close(); }
});

for (const provider of ['dataforseo', 'openrouter'] as const) {
  test(`${provider} keeps all three paid answers within an exact $0.30 approval`, async () => {
    const f = fixture();
    try {
      let calls = 0;
      const model: Model = { id: 'fixture', name: 'Fixture', contextLength: 10000, inputUsd: 0, outputUsd: 0.1 / 4096 };
      // Replace only the provider response boundary; real receipts, budget decisions and SQLite commits run below.
      const answer = async () => { calls++; return { text: 'Example provides examples.', citations: [], model: model.id, costUsd: 0.1 }; };
      const providers = { models: async () => [model], measure: answer, complete: answer } as unknown as Providers;
      f.store.set('measurementRequestEstimateUsd', 0.1);
      const runner = new Runner(f.store, providers);
      const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'measure', provider,
        maxCostUsd: 0.3, discoverCompetitors: false, prepareRecommendations: false }), 'decimal-budget-run');
      await runner.tick();
      assert.equal(f.store.job(job.id).status, 'completed');
      assert.equal(calls, 3);
      assert.equal(f.store.job(job.id).spentUsd, 0.3);
      assert.equal(f.store.observations(f.project.id, job.id).length, 3);
      await runner.tick();
      assert.equal(calls, 3, 'saved work is never repurchased');
    } finally { f.close(); }
  });
}

test('analysis passes retain decimal charges without a false budget pause', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const model: Model = { id: 'fixture', name: 'Fixture', contextLength: 10000, inputUsd: 0, outputUsd: 0.1 / 4096 };
    const providers = { complete: async () => { calls++; return { text: 'Saved text.', model: model.id, costUsd: 0.1 }; } } as unknown as Providers;
    const runner = new Runner(f.store, providers);
    const job = f.store.enqueue(jobInput.parse({ projectId: f.project.id, kind: 'content', provider: 'openrouter', maxCostUsd: 0.3 }), 'decimal-analysis');
    for (const name of ['research', 'brief', 'draft'] as const)
      assert.equal(await runner.llmPass(job, model, name, {}, new AbortController().signal), 'Saved text.');
    assert.equal(calls, 3);
    assert.equal(f.store.job(job.id).spentUsd, 0.3);
    assert.equal(f.store.artifacts(f.project.id, 'pass').length, 3);
  } finally { f.close(); }
});
