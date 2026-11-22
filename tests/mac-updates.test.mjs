import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { MacUpdates } = createRequire(import.meta.url)('../desktop/mac-updates.cjs');
const { CancellationToken } = createRequire(import.meta.url)('builder-util-runtime');
test('Mac download selects the current architecture and verifies bytes before offering an installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opengeo-mac-update-'));
  const content = Buffer.from('Synthetic installer transport fixture, not executable');
  const updater = new EventEmitter();
  const urls = [];
  const mac = new MacUpdates(updater, directory, 'arm64', async url => { urls.push(url); return new Response(content); });
  const file = { url: 'OpenGEO-0.2.0-macos-arm64.dmg', size: content.length, sha512: createHash('sha512').update(content).digest('base64') };
  try {
    updater.emit('update-available', { version: '0.2.0', files: [file] });
    await mac.downloadUpdate();
    assert.deepEqual(await readFile(mac.installer), content);
    assert.deepEqual(urls, ['https://github.com/surfacedby/OpenGEO/releases/download/v0.2.0/OpenGEO-0.2.0-macos-arm64.dmg']);
    assert.deepEqual(await readdir(directory), [file.url]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a later Mac session reuses only the matching verified installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opengeo-mac-update-cache-'));
  const content = Buffer.from('first installer');
  const file = { url: 'OpenGEO-0.2.0-macos-arm64.dmg', size: content.length, sha512: createHash('sha512').update(content).digest('base64') };
  let requests = 0;
  const newSession = () => {
    const updater = new EventEmitter();
    const mac = new MacUpdates(updater, directory, 'arm64', async () => {
      requests++;
      return new Response(content);
    });
    updater.emit('update-available', { version: '0.2.0', files: [file] });
    return mac;
  };
  try {
    const first = newSession();
    await first.downloadUpdate();
    assert.equal(requests, 1);

    const reopened = newSession();
    await reopened.downloadUpdate();
    assert.equal(requests, 1);
    assert.equal(reopened.installer, first.installer);
    assert.deepEqual(await readFile(reopened.installer), content);

    await writeFile(first.installer, Buffer.alloc(content.length));
    const repaired = newSession();
    await repaired.downloadUpdate();
    assert.equal(requests, 2);
    assert.deepEqual(await readFile(repaired.installer), content);
    assert.deepEqual(await readdir(directory), [file.url]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Mac download rejects corrupt payloads and unsafe metadata without retaining a partial installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opengeo-mac-update-'));
  const updater = new EventEmitter();
  let requests = 0;
  const mac = new MacUpdates(updater, directory, 'x64', async () => { requests++; return new Response('wrong'); });
  try {
    const file = { url: 'OpenGEO-0.2.0-macos-x64.dmg', size: 5, sha512: createHash('sha512').update('right').digest('base64') };
    updater.emit('update-available', { version: '0.2.0', files: [file] });
    await assert.rejects(mac.downloadUpdate(), /checksum/);
    assert.equal(mac.installer, null);
    assert.deepEqual(await readdir(directory), []);
    updater.emit('update-available', { version: '0.2.0', files: [{ ...file, url: 'https://example.com/arbitrary.dmg' }] });
    await assert.rejects(mac.downloadUpdate(), /metadata/);
    assert.equal(requests, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Mac cancellation aborts transport without exposing a partial installer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opengeo-mac-cancel-'));
  const updater = new EventEmitter();
  const token = new CancellationToken();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const mac = new MacUpdates(updater, directory, 'arm64', async (_url, { signal }) => {
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  try {
    updater.emit('update-available', { version: '0.2.0', files: [{ url: 'OpenGEO-0.2.0-macos-arm64.dmg', size: 5, sha512: createHash('sha512').update('right').digest('base64') }] });
    const download = mac.downloadUpdate(token);
    const rejected = assert.rejects(download);
    await ready;
    token.cancel();
    await rejected;
    assert.equal(mac.installer, null);
    assert.equal(token.listenerCount('cancel'), 0);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
