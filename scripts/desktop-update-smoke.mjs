import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, relative, resolve, isAbsolute, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { once } from 'node:events';

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') throw new Error('Requires an isolated Windows release runner.');
const [executable, installer, profile, receipt] = process.argv.slice(2).map(value => resolve(value));
for (const path of [executable, installer, profile, receipt]) {
  const child = relative(resolve(process.env.RUNNER_TEMP), path);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
}
const hash = createHash('sha512');
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const sha512 = hash.digest('base64');
const version = basename(installer).match(/^OpenGEO-(\d+\.\d+\.\d+-beta\.\d+)-windows-x64\.exe$/)?.[1];
assert.ok(version);
const feed = { version, files: [{ url: basename(installer), size: statSync(installer).size, sha512 }], path: basename(installer), sha512 };
let completeDownloads = 0;
const server = createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
  if (name === 'beta.yml') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(feed)); }
  else if (name === basename(installer)) {
    response.setHeader('Content-Length', statSync(installer).size);
    response.once('finish', () => completeDownloads++);
    createReadStream(installer).pipe(response);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const environmentNames = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE']);
let application;
let exitObserver;
try {
  application = await electron.launch({ executablePath: executable, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => environmentNames.has(name.toUpperCase()))), OPENGEO_DESKTOP_DATA_DIR: profile }, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => !!window.opengeoDesktop);
  // Only transport, cache location and the version comparator are controlled. The packaged IPC,
  // updater, checksum validation, install action and actual installer remain unchanged.
  await application.evaluate(({ app }, { url, cache }) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const updater = require('electron-updater').autoUpdater;
    updater.setFeedURL({ provider: 'generic', url, channel: 'beta' });
    updater.currentVersion = new updater.currentVersion.constructor('0.0.0');
    Object.defineProperty(updater.app, 'baseCachePath', { value: cache });
    if (!app.isPackaged) throw new Error('Must use packaged application');
  }, { url: 'http://127.0.0.1:' + server.address().port, cache: join(dirname(receipt), 'update-cache') });
  await page.evaluate(() => window.opengeoDesktop.updates('preference', false));
  const available = await page.evaluate(() => window.opengeoDesktop.updates('check'));
  assert.equal(available.status, 'available'); assert.equal(completeDownloads, 0);
  const ready = await page.evaluate(() => window.opengeoDesktop.updates('download'));
  assert.equal(ready.status, 'ready'); assert.equal(completeDownloads, 1);
  const downloaded = await application.evaluate(() => process.mainModule.require('electron-updater').autoUpdater.installerPath);
  const downloadedHash = createHash('sha512');
  for await (const chunk of createReadStream(downloaded)) downloadedHash.update(chunk);
  assert.equal(downloadedHash.digest('base64'), sha512);
  await page.evaluate(() => window.opengeoDesktop.setDraftProtectionPending(true));
  assert.match((await page.evaluate(() => window.opengeoDesktop.updates('install'))).message, /Save your changes/);
  await page.evaluate(() => window.opengeoDesktop.setDraftProtectionPending(false));
  // Playwright launches through cmd.exe on Windows. Observe the actual Electron
  // process handle, not that launcher or pipes inherited by the installer.
  const applicationPid = await application.evaluate(() => process.pid);
  exitObserver = spawn('pwsh', ['-NoProfile', '-File', 'scripts/observe-process-exit.ps1', '-ObservedProcessId', String(applicationPid), '-Executable', executable], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const observations = [];
  const observerLines = createInterface({ input: exitObserver.stdout });
  observerLines.on('line', line => observations.push(JSON.parse(line)));
  let observerError = '';
  exitObserver.stderr.on('data', bytes => { observerError += bytes.toString(); });
  const observerClosed = once(exitObserver, 'close');
  const observerReady = await once(observerLines, 'line', { signal: AbortSignal.timeout(10000) });
  assert.deepEqual(JSON.parse(observerReady[0]), { state: 'watching', processId: applicationPid });
  await page.evaluate(() => { setTimeout(() => void window.opengeoDesktop.updates('install'), 100); });
  const [exitCode, exitSignal] = await observerClosed;
  writeFileSync(receipt + '.exit.json', JSON.stringify({ applicationPid, observations, observerExit: exitCode, observerError }, null, 2));
  assert.equal(exitCode, 0, observerError); assert.equal(exitSignal, null);
  assert.deepEqual(observations[1], { state: 'exited', processId: applicationPid, exitCode: 0 });
  application = null;
  await promisify(execFile)('pwsh', ['-NoProfile', '-File', 'scripts/verify-installer-finish.ps1', '-Installer', downloaded, '-Installation', dirname(executable), '-Receipt', receipt + '.finish.json', '-Attach'], { windowsHide: true, timeout: 240000 });
  writeFileSync(receipt, JSON.stringify({ packagedUpdateDownload: true, downloadSha512: sha512, completeDownloads, explicitInstallRequired: true, unsavedWorkBlockedInstall: true, applicationProcessExit: observations[1], actualInstallerCompleted: true, transport: 'isolated loopback feed serving the exact candidate', comparisonVersion: '0.0.0', relaunchedBySeparateWorkspaceVerification: true }, null, 2));
} finally {
  if (exitObserver && exitObserver.exitCode === null) exitObserver.kill();
  // Failed verification must not hang cleanup on the same inherited installer handles.
  if (application?.process().exitCode === null) application.process().kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
