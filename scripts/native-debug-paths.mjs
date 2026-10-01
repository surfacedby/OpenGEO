import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Native build caches can contain alternate filenames; inspect every binary before packaging. */
export function nativeFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Native preparation does not follow symbolic links.');
    if (entry.isDirectory()) files.push(...nativeFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.node')) files.push(path);
  }
  return files;
}

/** PDB lookup paths can disclose the build machine without affecting runtime code. */
export function removeBuildPaths(input) {
  const output = Buffer.from(input);
  if (output.length < 64 || output.toString('ascii', 0, 2) !== 'MZ') return { output, changed: 0 };
  const requireRange = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > output.length) throw new Error('Invalid native PE bounds.');
  };
  const pe = output.readUInt32LE(0x3c);
  requireRange(pe, 24);
  if (output.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Invalid native PE signature.');
  const count = output.readUInt16LE(pe + 6), optionalSize = output.readUInt16LE(pe + 20), optional = pe + 24;
  requireRange(optional, optionalSize);
  const magic = output.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error('Unsupported native PE format.');
  const directories = optional + (magic === 0x20b ? 112 : 96);
  if (directories + 7 * 8 > optional + optionalSize) return { output, changed: 0 };
  if (output.readUInt32LE(directories + 4 * 8 + 4)) throw new Error('Signed native binaries must be rebuilt, not modified.');
  const debugRva = output.readUInt32LE(directories + 6 * 8), debugSize = output.readUInt32LE(directories + 6 * 8 + 4);
  if (!debugRva || !debugSize) return { output, changed: 0 };
  if (debugSize % 28) throw new Error('Invalid native debug directory.');
  const sections = optional + optionalSize;
  requireRange(sections, count * 40);
  let debugOffset;
  for (let n = 0; n < count; n++) {
    const section = sections + n * 40, rva = output.readUInt32LE(section + 12), rawSize = output.readUInt32LE(section + 16);
    if (debugRva >= rva && debugRva - rva + debugSize <= rawSize) debugOffset = output.readUInt32LE(section + 20) + debugRva - rva;
  }
  if (debugOffset === undefined) throw new Error('Unmapped native debug directory.');
  requireRange(debugOffset, debugSize);
  let changed = 0;
  for (let n = 0; n < debugSize; n += 28) {
    const entry = debugOffset + n;
    if (output.readUInt32LE(entry + 12) !== 2) continue;
    const size = output.readUInt32LE(entry + 16), start = output.readUInt32LE(entry + 24);
    requireRange(start, size);
    if (size < 25 || output.toString('ascii', start, start + 4) !== 'RSDS') throw new Error('Unsupported native CodeView record.');
    const pathStart = start + 24, end = output.indexOf(0, pathStart);
    if (end < pathStart || end >= start + size) throw new Error('Unterminated native debug path.');
    const path = output.toString('utf8', pathStart, end);
    if (!path.includes('/') && !path.includes('\\')) continue;
    const name = path.split(/[/\\]/).at(-1);
    if (!name || !/^[A-Za-z0-9_.-]+\.pdb$/i.test(name)) throw new Error('Unsafe native debug filename.');
    output.fill(0, pathStart, start + size);
    output.write(name, pathStart, 'ascii');
    changed++;
  }
  return { output, changed };
}

export function sanitizeNativeFile(path) {
  const original = readFileSync(path), { output, changed } = removeBuildPaths(original);
  if (changed) writeFileSync(path, output);
  return changed;
}
