import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage.js';
import { Vault } from '../server/vault.js';
import { createApp } from '../server/app.js';
import { jobInput, projectInput } from '../server/contracts.js';
import { exportProject } from '../server/export.js';

test('draft recovery survives restarts, orders delayed writes and cannot overwrite saved revisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-recovery-'));
  let store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const other = store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content' }), 'recovery-fixture');
    store.put('content', project.id, job.id, { id: 'draft', markdown: 'Saved' });
    const editor = store.openContentRecovery(project.id, 'draft');
    const edit = { session: editor.session, baseMarkdown: 'Saved', markdown: 'Latest edit', sequence: 2 };
    store.protectContentEdit(project.id, 'draft', edit);
    assert.equal(store.protectContentEdit(project.id, 'draft', { ...edit, markdown: 'Delayed edit', sequence: 1 }).protected, false);
    assert.throws(() => store.openContentRecovery(other.id, 'draft'), /not found/);
    assert.equal((exportProject(store, project.id).content[0] as { markdown: string }).markdown, 'Saved');
    store.close(); store = new Store(directory);
    const reopened = store.openContentRecovery(project.id, 'draft');
    assert.equal(reopened.recovery.markdown, 'Latest edit');
    assert.equal(reopened.recovery.baseMarkdown, 'Saved');
    assert.throws(() => store.protectContentEdit(project.id, 'draft', { ...edit, sequence: 3 }), /opened or saved elsewhere/);
    store.editContent(project.id, 'draft', 'Saved elsewhere', 'Saved');
    assert.throws(() => store.editContent(project.id, 'draft', 'Overwrite', 'Saved'), /changed elsewhere/);
    assert.equal(store.artifacts<any>(project.id, 'content')[0].markdown, 'Saved elsewhere');
    const conflict = store.openContentRecovery(project.id, 'draft');
    assert.equal(conflict.recovery.markdown, 'Latest edit');
    store.editContent(project.id, 'draft', 'Reviewed recovery', 'Saved elsewhere', conflict.session);
    assert.equal(store.openContentRecovery(project.id, 'draft').recovery, null);
    const active = store.openContentRecovery(project.id, 'draft');
    store.protectContentEdit(project.id, 'draft', { ...edit, session: active.session, sequence: 1 });
    store.discardContentRecovery(project.id, 'draft');
    assert.throws(() => store.protectContentEdit(project.id, 'draft', { ...edit, session: active.session, sequence: 2 }));
    assert.equal(store.openContentRecovery(project.id, 'draft').recovery, null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery endpoints require a local session, validate edits and enforce project scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-recovery-http-'));
  const key = join(directory, 'encryption-secret'); writeFileSync(key, Buffer.alloc(32, 9));
  const previous = process.env.OPENGEO_SECRET_FILE; process.env.OPENGEO_SECRET_FILE = key;
  const store = new Store(directory);
  const { app } = await createApp(store, new Vault(directory), 'local-recovery-test');
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const other = store.createProject(projectInput.parse({ domain: 'other.example', brand: 'Other' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'content' }), 'recovery-http-fixture');
    store.put('content', project.id, job.id, { id: 'draft', markdown: 'Saved' });
    const path = '/api/projects/' + project.id + '/content/draft/recovery';
    const headers = { host: '127.0.0.1:4318', authorization: 'Bearer local-recovery-test' };
    assert.equal((await app.inject({ method: 'POST', url: path, headers: { host: headers.host }, payload: {} })).statusCode, 401);
    const opened = await app.inject({ method: 'POST', url: path, headers, payload: {} });
    assert.equal(opened.statusCode, 200);
    const payload = { session: opened.json().session, sequence: 1, baseMarkdown: 'Saved', markdown: 'Protected' };
    assert.equal((await app.inject({ method: 'PUT', url: path, headers, payload })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: path, headers, payload: { ...payload, sequence: -1 } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'PUT', url: path.replace(project.id, other.id), headers, payload })).statusCode, 404);
    assert.equal((await app.inject({ method: 'PATCH', url: path.replace('/recovery', ''), headers, payload: { markdown: 'Wrong', baseMarkdown: 'Old' } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'PATCH', url: path.replace('/recovery', ''), headers, payload: { markdown: 'Committed', baseMarkdown: 'Saved', recoverySession: opened.json().session } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: path, headers, payload: { ...payload, sequence: 2 } })).statusCode, 409);
    assert.equal(store.openContentRecovery(project.id, 'draft').recovery, null);
  } finally { await app.close(); store.close(); process.env.OPENGEO_SECRET_FILE = previous; rmSync(directory, { recursive: true, force: true }); }
});
