import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { nativeFiles, sanitizeNativeFile } from './native-debug-paths.mjs';

const require = createRequire(import.meta.url);
export function assertNeutralBuildRoot(directory, privateDirectories) {
  const root = realpathSync(directory);
  for (const privateDirectory of privateDirectories) {
    const privateRoot = realpathSync(privateDirectory);
    const inside = relative(privateRoot, root);
    if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
      throw new Error('Native release builds must stay outside the workspace and home directory.');
  }
  return root;
}

/** Compile source and headers in a neutral directory so native __FILE__ data cannot reveal the maintainer. */
export function rebuildNative(moduleDirectory, electronVersion) {
  const moduleRoot = realpathSync(moduleDirectory);
  const configured = process.env.OPENGEO_NATIVE_BUILD_ROOT;
  const defaultRoot = process.platform === 'win32'
    ? resolve(process.env.SystemDrive || 'C:', '/OpenGEOBuild') : '/tmp/opengeo-build';
  const candidate = resolve(configured || defaultRoot);
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const root = assertNeutralBuildRoot(candidate, [process.cwd(), homedir()]);
  const directory = mkdtempSync(resolve(root, 'sqlite-'));
  const source = resolve(directory, 'source');
  try {
    cpSync(moduleRoot, source, { recursive: true, filter: file => {
      const location = relative(moduleRoot, file);
      if (location && ['build', 'bin', 'node_modules', '.git'].includes(location.split(/[\\/]/)[0])) return false;
      if (lstatSync(file).isSymbolicLink()) throw new Error('Native build source must not contain symbolic links.');
      return true;
    } });
    const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
    execFileSync(process.execPath, [nodeGyp, 'rebuild', '--release',
      '--target=' + electronVersion, '--arch=' + process.arch,
      '--dist-url=https://electronjs.org/headers', '--devdir=' + resolve(directory, 'headers'),
    ], { cwd: source, stdio: 'inherit', windowsHide: true });
    const compiled = nativeFiles(resolve(source, 'build/Release'));
    if (!compiled.some(file => basename(file) === 'better_sqlite3.node'))
      throw new Error('The native release build did not produce SQLite.');
    const release = resolve(moduleRoot, 'build/Release');
    if (existsSync(release) && realpathSync(release) !== release)
      throw new Error('The native output directory must not be redirected.');
    const compiledNames = new Set(compiled.map(file => basename(file)));
    for (const existing of nativeFiles(release)) {
      if (!compiledNames.has(basename(existing)))
        throw new Error('An unrecognized native binary needs review before packaging.');
    }
    mkdirSync(release, { recursive: true });
    for (const file of compiled) {
      sanitizeNativeFile(file);
      copyFileSync(file, resolve(release, basename(file)));
    }
    // Unused ABI caches can contain private build paths and must not enter a package.
    const cache = resolve(moduleRoot, 'bin');
    if (relative(moduleRoot, cache) !== 'bin') throw new Error('Native cache cleanup escaped its dependency.');
    if (existsSync(cache) && realpathSync(cache) !== cache)
      throw new Error('The native cache directory must not be redirected.');
    rmSync(cache, { recursive: true, force: true });
  } finally {
    if (dirname(directory) !== root) throw new Error('Native build cleanup escaped its temporary directory.');
    rmSync(directory, { recursive: true, force: true });
  }
}
