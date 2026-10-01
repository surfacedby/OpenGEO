import { existsSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileHash } from './audit-file-hash.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** A review applies only to the bytes in its declared source or unpacked-artifact scope. */
export function dispositionFor(finding, roots, dispositions) {
  const directory = roots.get(finding.scope);
  if (!directory) return null;
  const path = finding.path.replace(/^\/repo\//, '').replaceAll('\\', '/');
  if (isAbsolute(path)) return null;
  const file = resolve(directory, path), location = relative(directory, file);
  if (!location || location.startsWith('..') || isAbsolute(location)) return null;
  if (finding.scope === 'git-history') {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(finding.commit ?? '')) return null;
    const review = dispositions.find(entry => entry.scope === 'git-history' && entry.commit === finding.commit && entry.path === path && entry.rule === finding.rule && typeof entry.reason === 'string' && entry.reason.length > 20);
    if (!review) return null;
    try {
      const bytes = execFileSync('git', ['show', finding.commit + ':' + path], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 20_000_000 });
      const hash = createHash('sha256').update(bytes).digest('hex');
      return review.sha256 === hash ? { ...finding, sha256: hash, reason: review.reason } : null;
    } catch { return null; }
  }
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  const hash = fileHash(file);
  const review = dispositions.find((entry) => (entry.scope ?? 'working-tree') === finding.scope && entry.path === path && entry.rule === finding.rule && entry.sha256 === hash && typeof entry.reason === 'string' && entry.reason.length > 20);
  return review ? { ...finding, sha256: hash, reason: review.reason } : null;
}
