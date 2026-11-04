import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js';

test('desktop packager patterns retain application files and exclude private source and native caches', () => {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-package-patterns-'));
  const config = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).build;
  const application = new FileMatcher(root, root, value => value, config.files).createFilter();
  const dependencies = new FileMatcher(root, root, value => value, ['**/*', ...config.files.filter(pattern => pattern.startsWith('!'))]).createFilter();
  const check = (relative, filter, expected) => {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'synthetic package fixture');
    assert.equal(filter(file, statSync(file)), expected, relative);
  };
  try {
    for (const file of ['desktop/main.cjs', 'assets/app-icon.ico', 'dist/assets/app.js', 'dist-server/main.js', 'package.json']) check(file, application, true);
    for (const file of ['.env', 'private/settings.json', 'server/main.ts', 'tests/core.test.ts']) check(file, application, false);
    check('node_modules/better-sqlite3/build/Release/better_sqlite3.node', dependencies, true);
    for (const file of ['node_modules/better-sqlite3/bin/cached.node', 'node_modules/zod/src/index.ts', 'node_modules/example/tests/fixture.json']) check(file, dependencies, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
