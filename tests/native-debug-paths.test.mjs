import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { nativeFiles, removeBuildPaths } from '../scripts/native-debug-paths.mjs';
import { assertNeutralBuildRoot } from '../scripts/neutral-native-build.mjs';

test('rejects release build roots inside private directories, including directory junctions', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'opengeo-neutral-paths-'));
  try {
    const privateRoot = resolve(directory, 'private'), neutralRoot = resolve(directory, 'neutral');
    mkdirSync(privateRoot); mkdirSync(neutralRoot); mkdirSync(resolve(privateRoot, 'nested'));
    assert.equal(assertNeutralBuildRoot(neutralRoot, [privateRoot]), realpathSync(neutralRoot));
    assert.throws(() => assertNeutralBuildRoot(privateRoot, [privateRoot]), /outside/);
    assert.throws(() => assertNeutralBuildRoot(resolve(privateRoot, 'nested'), [privateRoot]), /outside/);
    const link = resolve(neutralRoot, 'redirected');
    symlinkSync(privateRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertNeutralBuildRoot(link, [privateRoot]), /outside/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('inventories alternate and nested native cache filenames without selecting one expected name', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'opengeo-native-inventory-'));
  try {
    mkdirSync(resolve(directory, 'nested'));
    for (const name of ['better_sqlite3.node', 'better-sqlite3.node', 'nested/another.node', 'ignored.pdb']) writeFileSync(resolve(directory, name), 'synthetic fixture');
    assert.deepEqual(nativeFiles(directory).sort(), ['better_sqlite3.node', 'better-sqlite3.node', 'nested/another.node'].map(name => resolve(directory, name)).sort());
    assert.deepEqual(nativeFiles(resolve(directory, 'missing')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function nativeFixture() {
  const file = Buffer.alloc(1024), pe = 64, optional = pe + 24, directories = optional + 112, section = optional + 240;
  file.write('MZ'); file.writeUInt32LE(pe, 0x3c); file.write('PE\0\0', pe);
  file.writeUInt16LE(1, pe + 6); file.writeUInt16LE(240, pe + 20); file.writeUInt16LE(0x20b, optional);
  file.writeUInt32LE(0x1000, directories + 48); file.writeUInt32LE(28, directories + 52);
  file.writeUInt32LE(0x1000, section + 12); file.writeUInt32LE(512, section + 16); file.writeUInt32LE(512, section + 20);
  file.writeUInt32LE(2, 524); file.writeUInt32LE(128, 528); file.writeUInt32LE(600, 536);
  file.write('RSDS', 600); file.fill(17, 604, 624); file.write('C:\\synthetic-build\\database.pdb\0', 624);
  return { file, directories };
}

test('removes only the declared PDB path while preserving the GUID, age and all other bytes', () => {
  const { file } = nativeFixture(), original = Buffer.from(file), { output, changed } = removeBuildPaths(file);
  assert.equal(changed, 1); assert.deepEqual(file, original);
  assert.deepEqual(output.subarray(0, 624), original.subarray(0, 624));
  assert.deepEqual(output.subarray(728), original.subarray(728));
  assert.equal(output.toString('ascii', 624, 636), 'database.pdb');
  assert.ok(output.subarray(636, 728).every(value => value === 0));
  assert.equal(removeBuildPaths(output).changed, 0);
});

test('rejects signed, out-of-bounds and unterminated records without changing the source', () => {
  const signed = nativeFixture(); signed.file.writeUInt32LE(64, signed.directories + 36);
  assert.throws(() => removeBuildPaths(signed.file), /Signed/);
  const invalid = nativeFixture(); invalid.file.writeUInt32LE(1000, 536);
  assert.throws(() => removeBuildPaths(invalid.file), /bounds/);
  const unterminated = nativeFixture(); unterminated.file.fill(65, 624, 728);
  assert.throws(() => removeBuildPaths(unterminated.file), /Unterminated/);
});
