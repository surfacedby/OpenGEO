import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';

test('Windows exit observation binds the actual process handle and retains its exit code', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.once("data", () => process.exit(7)); process.stdout.write("ready\\n");'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let observer;
  try {
    await once(child.stdout, 'data');
    observer = spawn('pwsh', ['-NoProfile', '-File', resolve('scripts/observe-process-exit.ps1'), '-ObservedProcessId', String(child.pid), '-Executable', process.execPath], { windowsHide: true });
    const lines = createInterface({ input: observer.stdout });
    const observations = [];
    lines.on('line', line => observations.push(JSON.parse(line)));
    const observerClosed = once(observer, 'close');
    await once(lines, 'line', { signal: AbortSignal.timeout(10000) });
    assert.deepEqual(observations, [{ state: 'watching', processId: child.pid }]);
    assert.equal(child.exitCode, null);
    child.stdin.end('exit');
    assert.deepEqual(await observerClosed, [0, null]);
    assert.deepEqual(observations[1], { state: 'exited', processId: child.pid, exitCode: 7 });
  } finally {
    if (child.exitCode === null) child.kill();
    if (observer && observer.exitCode === null) observer.kill();
  }
});

test('Windows exit observation refuses a different executable before reporting readiness', { skip: process.platform !== 'win32' }, async () => {
  const observer = spawn('pwsh', ['-NoProfile', '-File', resolve('scripts/observe-process-exit.ps1'), '-ObservedProcessId', String(process.pid), '-Executable', resolve('different-application.exe')], { windowsHide: true });
  let output = '', error = '';
  observer.stdout.on('data', bytes => { output += bytes; });
  observer.stderr.on('data', bytes => { error += bytes; });
  assert.equal((await once(observer, 'close'))[0], 1);
  assert.equal(output, '');
  assert.match(error, /not the expected application/);
});
