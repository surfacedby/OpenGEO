import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Runner } from '../server/workflows.js';
import { parsePage } from '../server/audit.js';
import { jobInput, projectInput, ProviderError } from '../server/contracts.js';
import { exportProject } from '../server/export.js';
import { importProject } from '../server/import.js';

const model = { id: 'test-model', name: 'Test', contextLength: 100000, inputUsd: 0, outputUsd: 0 };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-content-test-'));
  const store = new Store(directory);
  return { store, close() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('the final edited article receives its own review and preserves unresolved findings', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const audit = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'content-audit-test');
    const page = parsePage('https://example.com/', 200, '<main><h1>Example</h1><p>Documentation examples.</p></main>');
    f.store.put('page', project.id, audit.id, page);
    f.store.updateJob(audit.id, { status: 'completed' });
    const reviewInputs: any[] = [];
    let call = 0;
    const provider = {
      models: async () => [model],
      complete: async (_provider: string, _model: string, instructions: string, input: string) => {
        if (instructions.includes('Compare the supplied Markdown')) reviewInputs.push(JSON.parse(input));
        const outputs = [
          JSON.stringify({ facts: [{ claim: 'Documentation examples.', evidenceIds: [page.id] }], unknowns: [] }),
          'A guide to documentation examples.',
          'Example provides documentation examples.',
          JSON.stringify({ issues: [], requiresHumanReview: true }),
          'Example provides documentation examples. Availability is guaranteed.',
          JSON.stringify({ issues: [{ claim: 'Availability is guaranteed.', reason: 'The source does not establish availability.', evidenceIds: [page.id] }], requiresHumanReview: true }),
        ];
        return { text: outputs[call++], model: model.id, costUsd: 0, citations: [] };
      },
    };
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content', provider: 'chatgpt' }), 'content-review-test');
    await new Runner(f.store, provider as any).tick();
    const content = f.store.artifacts<any>(project.id, 'content')[0];
    assert.equal(f.store.job(job.id).status, 'completed');
    assert.equal(reviewInputs.length, 2);
    assert.equal(reviewInputs[1].draft, content.markdown);
    assert.equal(content.status, 'needs_review');
    assert.equal(content.review.issues[0].claim, 'Availability is guaranteed.');
    assert.equal(content.requiresHumanReview, true);
    const restored = importProject(f.store, exportProject(f.store, project.id));
    const restoredContent = f.store.artifacts<any>(restored.project.id, 'content')[0];
    const restoredPage = f.store.pages(restored.project.id)[0];
    assert.equal(restoredContent.reviewCurrent, true);
    assert.equal(restoredContent.status, 'needs_review');
    assert.equal(restoredContent.sourceEvidence[0].id, restoredPage.id);
    assert.equal(restoredContent.review.issues[0].evidenceIds[0], restoredPage.id);
    assert.equal(restoredContent.markdown, content.markdown);
  } finally { f.close(); }
});

test('a refused spending estimate never marks a provider request as started', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content', provider: 'openrouter', maxCostUsd: 0 }), 'content-budget-test');
    let calls = 0;
    const runner = new Runner(f.store, { complete: async () => { calls++; } } as any);
    await assert.rejects(runner.llmPass(job, { ...model, inputUsd: 1 }, 'research', { topic: 'Example' }, new AbortController().signal), (error: unknown) => error instanceof ProviderError && error.code === 'budget');
    assert.equal(calls, 0);
    assert.equal(f.store.step(job.id, 'research'), undefined);
  } finally { f.close(); }
});

test('a completed pass that exceeds the estimate is preserved and is never billed again on resume', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content', provider: 'openrouter', maxCostUsd: 0.1 }), 'content-overrun-test');
    let calls = 0;
    const runner = new Runner(f.store, { complete: async () => { calls++; return { text: 'Completed research', costUsd: 0.2, model: model.id, citations: [] }; } } as any);
    await assert.rejects(runner.llmPass(job, model, 'research', { topic: 'Example' }, new AbortController().signal), (error: unknown) => error instanceof ProviderError && error.code === 'budget');
    assert.equal(f.store.step(job.id, 'research')?.state, 'done');
    assert.equal(await runner.llmPass(job, model, 'research', { topic: 'Example' }, new AbortController().signal), 'Completed research');
    assert.equal(calls, 1);
    assert.equal(f.store.job(job.id).spentUsd, 0.2);
  } finally { f.close(); }
});

test('Console cancellation returns a confirmed pending-check refund to the local spend receipt', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: 1 }), 'console-cancellation-test');
    f.store.updateJob(job.id, { status: 'paused', spentUsd: 1 });
    f.store.setStep(job.id, 'console-scan', 'done', { scan_id: 'remote-check', credits_charged: 10 });
    let calls = 0;
    const runner = new Runner(f.store, { console: async (path: string) => { assert.equal(path, '/scans/remote-check/cancel'); calls++; return { data: { refunded_credits: 10, prior_status: 'pending' } }; } } as any);
    await runner.cancel(job.id);
    assert.equal(f.store.job(job.id).status, 'cancelled');
    assert.equal(f.store.job(job.id).spentUsd, 0);
    await runner.cancel(job.id);
    assert.equal(calls, 1);
  } finally { f.close(); }
});

test('AI revisions remain scoped, preserve the source draft, and checkpoint the completed revision', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const other = f.store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    const audit = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'revision-audit-test');
    const page = parsePage('https://example.com/', 200, '<h1>Example</h1><p>Documentation examples.</p>');
    f.store.put('page', project.id, audit.id, page);
    f.store.updateJob(audit.id, { status: 'completed' });
    const sourceJob = f.store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content' }), 'revision-source-test');
    const sourceId = '00000000-0000-4000-8000-000000000001';
    f.store.put('content', project.id, sourceJob.id, { id: sourceId, topic: 'Documentation', markdown: 'Original article', sourceEvidence: [{ id: page.id, url: page.url, title: page.title }] });
    f.store.updateJob(sourceJob.id, { status: 'completed' });
    const input = jobInput.parse({ projectId: project.id, kind: 'revise', provider: 'chatgpt', contentId: sourceId, revisionInstructions: 'Make the explanation clearer.' });
    assert.throws(() => f.store.enqueue({ ...input, projectId: other.id }, 'wrong-revision-test'), /not found/);
    let calls = 0;
    let draftInput: any;
    const provider = {
      models: async () => [model],
      complete: async (_provider: string, _model: string, _instructions: string, input: string) => {
        if (calls === 2) draftInput = JSON.parse(input);
        const outputs = [JSON.stringify({ facts: [{ claim: 'Documentation examples.', evidenceIds: [page.id] }], unknowns: [] }), 'Brief', 'Clear article', JSON.stringify({ issues: [], requiresHumanReview: true }), 'Clear reviewed article', JSON.stringify({ issues: [], requiresHumanReview: true })];
        return { text: outputs[calls++], model: model.id, costUsd: 0, citations: [] };
      },
    };
    const job = f.store.enqueue(input, 'revision-job-test');
    const runner = new Runner(f.store, provider as any);
    await runner.tick();
    const docs = f.store.artifacts<any>(project.id, 'content');
    assert.equal(f.store.job(job.id).status, 'completed');
    assert.equal(docs.length, 2);
    assert.equal(docs.find((d) => d.id === sourceId).markdown, 'Original article');
    assert.equal(docs[0].derivedFrom, sourceId);
    assert.equal(docs[0].reviewCurrent, true);
    assert.equal(draftInput.previousDraft, 'Original article');
    assert.equal(draftInput.revisionInstructions, input.revisionInstructions);
    await runner.execute(job, project, new AbortController().signal);
    assert.equal(calls, 6);
    assert.equal(f.store.artifacts<any>(project.id, 'content').length, 2);
  } finally { f.close(); }
});
