import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { jobInput, projectInput, type Observation } from '../server/contracts.js';
import { comparisonKey, summarize } from '../server/analysis.js';
import { exportProject } from '../server/export.js';
import { importProject } from '../server/import.js';

test('public evidence and exports omit internal metadata without changing answers or private comparison evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-public-evidence-'));
  const store = new Store(directory), vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(store, vault, 'public-evidence-session');
  try {
    const prompt = 'Where can I find an example?', topic = randomUUID();
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example', prompts: [prompt],
      topics: [{ id: topic, name: 'Examples', prompts: [prompt], createdAt: new Date().toISOString() }] }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', model: 'private-collection-model' }), 'public-check');
    store.setStep(job.id, 'project', 'done', project);
    const observation: Observation = { id: randomUUID(), projectId: project.id, jobId: job.id, prompt, provider: 'console', platform: 'chatgpt',
      model: 'private-collection-model', surface: 'consumer_interface', locale: 'en-US', observedAt: new Date().toISOString(),
      answer: 'Example has a guide to model selection.', citations: [{ url: 'https://example.com/guide' }], mentioned: true, cited: true, costUsd: null };
    store.put('observation', project.id, job.id, observation);
    const digest = comparisonKey(project, job, [observation]);
    store.updateJob(job.id, { status: 'completed', result: { metrics: summarize([observation], 1), comparisonKey: digest,
      analysis: { measurementJobId: job.id, findings: 0, model: 'private-analysis-model' } } });
    const headers = { host: '127.0.0.1:4318', authorization: 'Bearer public-evidence-session' };
    const paths = [`/projects/${project.id}/workspace`, `/jobs/${job.id}`, `/projects/${project.id}/checks/${job.id}/answers`, `/projects/${project.id}/topics/${topic}`];
    for (const path of paths) {
      const response = await app.inject({ url: '/api' + path, headers });
      assert.equal(response.statusCode, 200, path);
      assert.doesNotMatch(response.body, /private-collection-model|private-analysis-model|consumer_interface|"model":|"surface":/, path);
    }
    const exported = exportProject(store, project.id);
    assert.equal(exported.observations[0].answer, observation.answer);
    assert.deepEqual(exported.observations[0].citations, observation.citations);
    assert.doesNotMatch(JSON.stringify(exported), /private-collection-model|private-analysis-model|"model":|"surface":/);
    const restored = importProject(store, exported).project;
    assert.equal(store.observations(restored.id)[0].surface, 'unknown');
    assert.equal((store.jobs(restored.id)[0].result as { comparisonKey: string }).comparisonKey, digest);
    assert.deepEqual(store.observations(project.id), [observation]);
    assert.equal(store.job(job.id).model, 'private-collection-model');
  } finally {
    await app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
