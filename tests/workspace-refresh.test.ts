import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from '../src/api.js';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { projectInput, jobInput } from '../server/contracts.js';

test('unchanged workspace polling avoids evidence reads and response bodies without hiding writes or expired sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-refresh-'));
  const store = new Store(directory);
  const vault = new Vault(directory, { encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
  const { app } = await createApp(store, vault);
  const originalFetch = globalThis.fetch;
  let cookie = '';
  const responses: { status: number; validator?: string; cache: string | null }[] = [];
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    // Only browser URL resolution and cookie storage are supplied; real HTTP, authorization and SQLite handle every request.
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(new URL(String(input), origin), { ...options, headers: { ...options?.headers, cookie } });
      const saved = response.headers.get('set-cookie');
      if (saved) cookie = saved.split(';')[0];
      if (String(input).endsWith('/workspace')) responses.push({ status: response.status, validator: (options?.headers as Record<string, string>)?.['If-None-Match'], cache: response.headers.get('cache-control') });
      return response;
    };
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const path = `/projects/${project.id}/workspace`;
    const first = await api(path);
    assert.equal(first.project.brand, 'Example');
    const jobs = store.jobs.bind(store);
    let reads = 0;
    store.jobs = (...args) => { reads++; return jobs(...args); };
    assert.equal(await api(path), first, 'Unchanged refresh preserves the existing object and view');
    assert.equal(reads, 0, 'The conditional response must return before loading jobs or evidence');
    assert.equal(responses.at(-1)?.status, 304);
    assert.equal(responses.at(-1)?.cache, 'no-store', 'Private workspace data must not enter the browser disk cache');
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'audit' }), 'refresh-audit');
    const running = await api(path);
    assert.equal(running.jobs[0].id, job.id);
    assert.equal(responses.at(-1)?.status, 200);
    const external = new Store(directory);
    try { external.updateProject(project.id, projectInput.parse({ domain: project.domain, brand: 'Updated elsewhere' })); }
    finally { external.close(); }
    const updated = await api(path);
    assert.equal(updated.project.brand, 'Updated elsewhere', 'Writes through another connection invalidate the view');
    assert.equal(await api(path), updated);
    cookie = '';
    const recovered = await api(path);
    assert.equal(recovered.project.brand, 'Updated elsewhere');
    assert.deepEqual(responses.slice(-2).map(row => row.status), [401, 200]);
    assert.equal(responses.at(-1)?.validator, undefined, 'Session recovery obtains a fresh representation');
    const other = store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    assert.equal((await api(`/projects/${other.id}/workspace`)).project.id, other.id);
    assert.equal(responses.at(-1)?.validator, undefined);
    assert.equal((await api(path)).project.id, project.id);
    assert.equal(responses.at(-1)?.validator, undefined, 'Only one workspace is retained');
    store.updateJob(job.id, { status: 'completed' });
    const validator = (await originalFetch(new URL('/api' + path, origin), { headers: { cookie } })).headers.get('etag')!;
    store.deleteProject(project.id, project.domain);
    const deleted = await originalFetch(new URL('/api' + path, origin), { headers: { cookie, 'If-None-Match': validator } });
    assert.equal(deleted.status, 404, 'A cached view cannot hide project deletion');
    const reopened = new Store(directory);
    try { assert.notEqual(reopened.workspaceRevision(), store.workspaceRevision(), 'Reopening cannot collide with a previous instance'); }
    finally { reopened.close(); }
  } finally {
    globalThis.fetch = originalFetch;
    await app.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  }
});
