import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/api.js';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { projectInput } from '../server/contracts.js';

test('browser request helper can remove schedules and connections over actual HTTP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-browser-http-'));
  const secret = join(directory, 'encryption-secret'); writeFileSync(secret, Buffer.alloc(32, 11));
  const previous = process.env.OPENGEO_SECRET_FILE; process.env.OPENGEO_SECRET_FILE = secret;
  const store = new Store(directory), vault = new Vault(directory);
  const { app, scheduler } = await createApp(store, vault, 'browser-http-fixture');
  const originalFetch = globalThis.fetch;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    // Node has no browser cookie jar or relative URL resolution. Only that
    // transport boundary is supplied; requests still reach the real backend.
    globalThis.fetch = (input, options) => originalFetch(new URL(String(input), origin), { ...options, headers: { ...options?.headers, authorization: 'Bearer browser-http-fixture' } });
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const schedule = scheduler.add({ job: { projectId: project.id, kind: 'audit', maxCostUsd: 0 }, frequency: 'daily', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 0 });
    assert.equal((await api('/schedules')).length, 1);
    await api('/schedules/' + schedule.id, undefined, 'DELETE');
    assert.equal(scheduler.list().length, 0);
    const request = { job: { projectId: project.id, kind: 'audit', maxCostUsd: 0 }, frequency: 'daily', hour: 9, timezone: 'UTC', monthlyBudgetUsd: 0 };
    const key = 'schedule-approved-fixture';
    const created = await api('/schedules', request, 'POST', key);
    assert.equal((await api('/schedules', request, 'POST', key)).id, created.id);
    assert.equal(scheduler.list().length, 1);
    await assert.rejects(api('/schedules', { ...request, hour: 10 }, 'POST', key), /different settings/);
    assert.equal(scheduler.list()[0].hour, 9);
    // An independent connection to the same database observes the durable receipt.
    const reopened = new Store(directory);
    try { assert.equal(new (await import('../server/scheduler.js')).Scheduler(reopened).add(request, key).id, created.id); }
    finally { reopened.close(); }
    await api('/schedules/' + created.id, undefined, 'DELETE');
    await assert.rejects(api('/schedules', request, 'POST', key), /was removed/);
    assert.equal(scheduler.list().length, 0);
    assert.ok(!JSON.stringify(await api('/backup')).includes(key));
    vault.set('openrouter', { key: ['synthetic', 'fixture', 'key'].join('-') });
    await api('/providers/openrouter', undefined, 'DELETE');
    assert.equal(vault.status().openrouter, false);
  } finally { globalThis.fetch = originalFetch; await app.close(); store.close(); process.env.OPENGEO_SECRET_FILE = previous; rmSync(directory, { recursive: true, force: true }); }
});
