import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import identity from '../brand/identity.json' with { type: 'json' };

// Build children receive only system paths, never provider or production configuration.
const systemNames = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'PSMODULEPATH']);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemNames.has(key.toUpperCase())));
environment.NODE_ENV = 'production';
environment.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const desktop = process.argv.includes('--desktop-dir') || process.argv.includes('--desktop-installer');
const target = process.argv.find(argument => argument.startsWith('--platform='))?.slice('--platform='.length)
  ?? ({ win32: 'win', darwin: 'mac', linux: 'linux' })[process.platform];
const architecture = process.argv.find(argument => argument.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch;
if (desktop && (!['win', 'mac', 'linux'].includes(target) || !['x64', 'arm64'].includes(architecture)))
  throw new Error('Select a supported desktop platform and architecture.');
if (desktop && (target !== ({ win32: 'win', darwin: 'mac', linux: 'linux' })[process.platform] || architecture !== process.arch))
  throw new Error('Desktop builds require a runner with the target OS and architecture so SQLite and the bundled browser agree.');
const output = process.argv.find((argument) => argument.startsWith('--desktop-output='))?.slice('--desktop-output='.length) ?? 'release/candidate';
if (desktop) {
  const withinRelease = relative(resolve('release'), resolve(output));
  if (!withinRelease || withinRelease.startsWith('..') || isAbsolute(withinRelease)) throw new Error('Desktop output must be a child directory of release.');
}
for (const file of readdirSync('.'))
  if (file.startsWith('.env') && file !== '.env.example')
    throw new Error('Release builds require a checkout without populated environment files.');

function run(packageName, binary, args) {
  const manifestPath = resolve('node_modules', packageName, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binary];
  if (!entry || !existsSync(resolve(dirname(manifestPath), entry))) throw new Error('Missing build tool: ' + packageName);
  execFileSync(process.execPath, [resolve(dirname(manifestPath), entry), ...args], { env: environment, stdio: 'inherit' });
}

execFileSync(process.execPath, [resolve('scripts/sync-identity.mjs')], { env: environment, stdio: 'inherit' });
run('typescript', 'tsc', ['--noEmit']);
run('vite', 'vite', ['build']);
run('tsup', 'tsup', ['server/main.ts', 'server/cli.ts', 'server/mcp.ts', '--format', 'esm', '--platform', 'node', '--out-dir', 'dist-server', '--external', 'better-sqlite3']);
if (desktop) {
  for (const script of ['prepare-browser.mjs', 'prepare-native.mjs'])
    execFileSync(process.execPath, [resolve('scripts', script)], { env: environment, stdio: 'inherit' });
  run('electron-builder', 'electron-builder', ['--' + target, '--' + architecture, ...(process.argv.includes('--desktop-installer') ? [] : ['--dir']), '--config.directories.output=' + output]);
}
console.log(identity.name + ' built with permitted system settings only.');
