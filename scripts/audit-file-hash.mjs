import { openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Bundled browsers can exceed memory budgets; their provenance still needs an exact digest. */
export function fileHash(file) {
  const descriptor = openSync(file, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    while ((length = readSync(descriptor, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, length));
    return hash.digest('hex');
  } finally { closeSync(descriptor); }
}
