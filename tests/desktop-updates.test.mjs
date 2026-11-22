import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobInput, projectInput } from '../server/contracts.ts';
import { Store } from '../server/storage.ts';
const { createUpdates, updateInstallBlock } = createRequire(import.meta.url)('../desktop/updates.cjs');
const { CancellationToken } = createRequire(import.meta.url)('builder-util-runtime');
function fixture({ automatic = true, reason = null, installed = true, canInstall = () => reason } = {}) {
  const updater = new EventEmitter();
  let downloads = 0, installs = 0, preference = automatic;
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '0.2.0' });
  updater.downloadUpdate = async () => { downloads++; updater.emit('update-downloaded'); };
  const updates = createUpdates({ updater, installed, version: '0.1.0-beta.3', canInstall, install: async () => { installs++; }, publish: () => {}, readPreference: () => preference, savePreference: value => { preference = value; } });
  return { updater, updates, counts: () => ({ downloads, installs, preference }) };
}
test('downloads automatically but never installs without explicit approval', async () => {
  const f = fixture();
  await f.updates.command('check');
  assert.equal(f.updates.snapshot().status, 'ready');
  assert.deepEqual(f.counts(), { downloads: 1, installs: 0, preference: true });
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.updater.allowDowngrade, false);
  await f.updates.command('install');
  assert.equal(f.counts().installs, 1);
});
test('metered preference prevents automatic downloads and persists explicit changes', async () => {
  const f = fixture({ automatic: false });
  await f.updates.command('check');
  assert.equal(f.counts().downloads, 0);
  assert.equal(f.updates.snapshot().status, 'available');
  await f.updates.command('preference', true);
  assert.equal(f.counts().preference, true);
  await f.updates.command('download');
  assert.equal(f.counts().downloads, 1);
});
test('unsaved work blocks restart without losing downloaded update', async () => {
  const f = fixture({ reason: 'Save your draft before restarting.' });
  await f.updates.command('check');
  await f.updates.command('install');
  assert.equal(f.counts().installs, 0);
  assert.equal(f.updates.snapshot().status, 'ready');
  assert.match(f.updates.snapshot().message, /Save your draft/);
});

test('a saved unresolved check can survive an update while queued work and running cancellation still block', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-update-saved-check-'));
  let store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({ domain: 'example.com', brand: 'Example' }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: 'measure', provider: 'console', maxCostUsd: 1 }), 'pending-check');
    store.setStep(job.id, 'console-scan', 'started');
    let isWorking = false, draftPending = false;
    const runner = { hasActiveProject: id => id === project.id && isWorking };
    const f = fixture({ canInstall: () => updateInstallBlock({ store, runner }, draftPending) });
    await f.updates.command('check');
    await f.updates.command('install');
    assert.equal(f.counts().installs, 0);

    store.updateJob(job.id, { status: 'paused', error: 'interrupted' });
    assert.equal(updateInstallBlock({ store, runner }, false), null);
    store.updateJob(job.id, { status: 'cancelled', error: 'cancel_remote' });
    isWorking = true;
    await f.updates.command('install');
    assert.equal(f.counts().installs, 0);
    isWorking = false;
    draftPending = true;
    await f.updates.command('install');
    assert.match(f.updates.snapshot().message, /Save your changes/);
    assert.equal(f.counts().installs, 0);

    draftPending = false;
    await f.updates.command('install');
    assert.equal(f.counts().installs, 1);
    store.close();
    store = new Store(directory);
    assert.equal(store.job(job.id).error, 'cancel_remote');
    assert.equal(store.job(job.id).maxCostUsd, 1);
    assert.equal(store.step(job.id, 'console-scan')?.state, 'started');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('development builds perform no network or download work', async () => {
  const f = fixture({ installed: false });
  await f.updates.command('check');
  assert.equal(f.updates.snapshot().status, 'unavailable');
  assert.equal(f.counts().downloads, 0);
});

test('stopping an in-flight download disables automatic downloads and allows a fresh check', async () => {
  const f = fixture({ automatic: false });
  let token;
  f.updater.checkForUpdates = async () => {
    token = new CancellationToken();
    f.updater.emit('update-available', { version: '0.2.0' });
    return { cancellationToken: token };
  };
  f.updater.downloadUpdate = async received => received.createPromise(() => {});
  await f.updates.command('check');
  const download = f.updates.command('download');
  assert.equal(f.updates.snapshot().status, 'downloading');
  await f.updates.command('cancel');
  await download;
  assert.equal(token.cancelled, true);
  assert.equal(f.updates.snapshot().status, 'idle');
  assert.equal(f.updates.snapshot().autoDownload, false);
  await f.updates.command('check');
  assert.equal(token.cancelled, false);
  assert.equal(f.updates.snapshot().status, 'available');
});

test('download errors release the command lock so a later check can succeed', async () => {
  const f = fixture();
  f.updater.downloadUpdate = async () => { throw new Error('offline'); };
  await f.updates.command('check');
  assert.equal(f.updates.snapshot().status, 'error');
  f.updater.downloadUpdate = async () => f.updater.emit('update-downloaded');
  await f.updates.command('check');
  assert.equal(f.updates.snapshot().status, 'ready');
});
