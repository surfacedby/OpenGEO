import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { Connections } from '../server/oauth.js';
import { Providers } from '../server/providers.js';
import { Runner } from '../server/workflows.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { consoleManaged, managedJob, cancelConsoleManaged } from '../server/console-managed.js';

for (const action of ['collect', 'cancel'] as const) {
  test('an earlier larger reservation retains its receipt during ' + action, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'opengeo-reservation-recovery-'));
    const store = new Store(directory);
    const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
    vault.set('console', { key: 'synthetic-console-credential' });
    const connections = new Connections(store, vault), runner = new Runner(store, new Providers(vault, connections));
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content', provider: 'console', maxCostUsd: .5 }), 'historical-reservation');
    const domainId = randomUUID(), quoteId = randomUUID(), remoteId = randomUUID();
    const approval = { estimate_id: quoteId, request_key: job.id, approved_credits: 5 };
    store.setStep(job.id, 'console-domain', 'done', { id: domainId, domain: project.domain });
    store.setStep(job.id, 'console-content-input', 'done', {});
    store.setStep(job.id, 'console-content-estimate', 'done', { id: quoteId, operation: 'content', domain_id: domainId,
      estimated_credits: 3, estimated_usd: '0.30', expires_at: '2026-01-01T00:00:00Z' });
    store.setStep(job.id, 'console-content-submission', 'done', approval);
    store.setStep(job.id, 'console-content-job', 'started');
    let finished = false;
    const calls: string[] = [];
    const remote = () => ({ id: remoteId, ...approval, estimated_credits: 3, cancel_requested: action === 'cancel' && finished,
      status: finished ? action === 'cancel' ? 'cancelled' : 'completed' : 'waiting_reconciliation',
      receipt: finished ? { status: action === 'cancel' ? 'cancelled' : 'completed', charged_credits: 1, refunded_credits: 4 } : null });
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const address = new URL(String(url));
      assert.equal(address.origin, 'https://api.surfacedby.com');
      const path = address.pathname.replace('/api/v1/console', '');
      calls.push((init?.method ?? 'GET') + ' ' + path);
      let data: unknown;
      if (path === '/content/jobs') {
        assert.equal(init?.method ?? 'GET', 'GET', 'an uncertain historical purchase must never be resubmitted');
        assert.equal(address.searchParams.get('request_key'), job.id);
        data = [remote()];
      } else if (path === '/content/jobs/' + remoteId + '/cancel') {
        assert.equal(init?.method, 'POST');
        finished = true; data = remote();
      } else if (path === '/content/jobs/' + remoteId + '/results') data = { job: remote() };
      else { assert.equal(path, '/content/jobs/' + remoteId); data = remote(); }
      return new Response(JSON.stringify({ data, meta: { has_more: false } }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const collect = () => consoleManaged(runner, store.job(job.id), project, AbortSignal.timeout(5000),
      () => { throw new Error('A saved input must not be regenerated'); }, z.object({ job: managedJob }));
    try {
      await assert.rejects(collect(), (error: any) => error.code === 'waiting');
      assert.equal(store.job(job.id).spentUsd, .5);
      assert.equal(store.job(job.id).costBasis, 'includes_estimates');
      assert.deepEqual(JSON.parse(store.step(job.id, 'console-content-submission')!.body!), approval);
      if (action === 'cancel') assert.equal(await cancelConsoleManaged(runner, store.job(job.id)), true);
      else { finished = true; await collect(); }
      assert.equal(store.job(job.id).spentUsd, .1);
      assert.equal(store.job(job.id).costBasis, 'reported');
      assert.deepEqual(JSON.parse(store.step(job.id, 'console-content-submission')!.body!), approval);
      assert.equal(calls.filter(call => call === 'GET /content/jobs').length, 1);
      assert.deepEqual(calls.filter(call => call.startsWith('POST')), action === 'cancel' ? ['POST /content/jobs/' + remoteId + '/cancel'] : []);
    } finally {
      globalThis.fetch = original; connections.close(); await runner.stop(); store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
