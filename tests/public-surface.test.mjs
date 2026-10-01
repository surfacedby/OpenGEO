import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicSurfaceFindings } from '../scripts/public-surface.mjs';

test('publication refuses deleted private material retained by history or other refs', () => {
  const root = mkdtempSync(join(tmpdir(), 'opengeo-public-history-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init'); git('config', 'user.name', 'Test contributor'); git('config', 'user.email', 'test@example.invalid');
    mkdirSync(join(root, 'docs')); writeFileSync(join(root, 'README.md'), '# Public project\n');
    git('add', '.'); git('commit', '-m', 'Public source');
    assert.deepEqual(publicSurfaceFindings(root), []);
    writeFileSync(join(root, '.gitignore'), '.env\n');
    writeFileSync(join(root, '.env'), 'TEST_PLACEHOLDER=synthetic\n');
    assert.deepEqual(publicSurfaceFindings(root), ['.env']);
    rmSync(join(root, '.env'));
    writeFileSync(join(root, 'docs', 'implementation-ledger.md'), '# Private development record\n');
    git('add', '.'); git('commit', '-m', 'Local development');
    git('branch', 'local-record');
    git('rm', 'docs/implementation-ledger.md'); git('commit', '-m', 'Remove development record');
    assert.deepEqual(publicSurfaceFindings(root), ['docs/implementation-ledger.md']);
    writeFileSync(join(root, 'narration.ts'), ['// We', 'changed this after testing.\nexport const value = 1;\n'].join(' '));
    writeFileSync(join(root, 'invariant.ts'), '// A delayed request must preserve newer data.\nexport const value = 1;\n');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'ux-audit.md'), '# Development review\n');
    assert.deepEqual(publicSurfaceFindings(root), ['docs/implementation-ledger.md', 'docs/ux-audit.md', 'narration.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
