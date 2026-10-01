import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir, homedir } from 'node:os';
import { nativeFiles, sanitizeNativeFile } from './native-debug-paths.mjs';
import { targetedFindings } from './audit-matchers.mjs';
import { rebuildNative } from './neutral-native-build.mjs';
const require = createRequire(import.meta.url);
const version = JSON.parse(
  readFileSync(resolve("node_modules/electron/package.json"), "utf8"),
).version;
function cleanDebugPaths() {
  const candidates = ['build/Release', 'bin'].flatMap(directory => nativeFiles(resolve('node_modules/better-sqlite3', directory)));
  for (const path of candidates) {
    sanitizeNativeFile(path);
    const privatePaths = [process.cwd(), homedir()].flatMap(value => [value, value.replaceAll('\\', '/')]);
    if (targetedFindings(readFileSync(path), privatePaths).includes('confidential-value')) throw new Error('Native SQLite contains a private build path. Rebuild it in a neutral release directory before packaging.');
  }
}
function verify() {
  const directory = mkdtempSync(resolve(tmpdir(), 'opengeo-native-'));
  const receipt = resolve(directory, 'runtime.json');
  try {
    execFileSync(require('electron'), ['-e', "const d=require('better-sqlite3')(':memory:');const row=d.prepare('SELECT 1 AS verified').get();d.close();require('node:fs').writeFileSync(process.env.OPENGEO_NATIVE_PROBE,JSON.stringify({version:process.versions.electron,abi:process.versions.modules,verified:row.verified}));"], {
      stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENGEO_NATIVE_PROBE: receipt },
    });
    if (!existsSync(receipt)) return false;
    const result = JSON.parse(readFileSync(receipt, 'utf8'));
    return result.version === version && result.verified === 1;
  } catch { return false; }
  finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error('Native verification cleanup escaped its temporary directory.');
    rmSync(directory, { recursive: true, force: true });
  }
}
let privateBuild = false;
try { cleanDebugPaths(); } catch { privateBuild = true; }
if (privateBuild || process.argv.includes('--force') || !verify()) {
  rebuildNative(resolve('node_modules/better-sqlite3'), version);
  cleanDebugPaths();
  if (!verify()) throw new Error('Native SQLite failed verification in the packaged Electron runtime.');
}
console.log('Native SQLite verified against Electron ' + version + '.');
