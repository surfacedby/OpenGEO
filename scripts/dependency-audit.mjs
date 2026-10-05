import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dependency advisory gate. Runtime dependencies must be free of advisories. A build-tool advisory
 * passes only when a reviewed disposition matches its exact locked bytes, its only dependents and
 * the precondition that keeps the vulnerable code unreachable; any drift makes it a failure again.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm sets npm_execpath for scripts it runs; invoking its CLI through Node avoids a shell on every platform.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with `npm run audit:deps`.');
function audit(args) {
  let output;
  try { output = execFileSync(process.execPath, [npmCli, 'audit', '--json', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 50_000_000 }); }
  catch (error) { output = error.stdout; }
  const report = JSON.parse(output);
  if (!report.vulnerabilities) throw new Error('npm audit did not return a vulnerability report: ' + (report.error?.summary ?? 'unknown error'));
  return report.vulnerabilities;
}
const advisories = (vulnerabilities) => Object.values(vulnerabilities).flatMap((entry) => entry.via
  .filter((via) => typeof via === 'object')
  .map((via) => ({ package: via.name, advisory: via.url?.split('/').at(-1), title: via.title, severity: via.severity })));

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dispositions = JSON.parse(readFileSync(join(root, 'scripts', 'dependency-dispositions.json'), 'utf8'));

function unmet(finding) {
  const review = dispositions.find((entry) => entry.advisory === finding.advisory && entry.package === finding.package);
  if (!review) return 'no reviewed disposition';
  const installs = Object.entries(lock).filter(([path]) => path === 'node_modules/' + review.package || path.endsWith('/node_modules/' + review.package));
  if (installs.length !== 1) return `expected one locked copy, found ${installs.length}`;
  const [, entry] = installs[0];
  if (entry.version !== review.version || entry.integrity !== review.integrity) return `locked ${entry.version} no longer matches the reviewed ${review.version}`;
  if (entry.dev !== true) return 'the package is no longer limited to build tooling';
  // Every way a locked package can require another, including the project itself (the "" entry).
  const requires = (item) => ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((map) => item[map]?.[review.package]);
  const dependents = Object.entries(lock).filter(([, item]) => requires(item)).map(([name]) => name).sort();
  if (JSON.stringify(dependents) !== JSON.stringify([...review.dependents].sort())) return `dependents changed to ${dependents.join(', ') || 'none'}`;
  if (review.requiresUnsetDownloadCache) {
    const download = manifest.build?.electronDownload;
    if (download?.cache !== undefined || download?.downloadOptions?.cache !== undefined) return 'the build configuration now enables a download cache';
  }
  return null;
}

const runtime = advisories(audit(['--omit=dev']));
const all = advisories(audit(['--include=dev']));
const failures = [
  ...runtime.map((finding) => ({ ...finding, problem: 'runtime dependency advisory' })),
  ...all.map((finding) => ({ ...finding, problem: unmet(finding) })).filter((finding) => finding.problem),
];
const accepted = all.filter((finding) => !unmet(finding));
const stale = dispositions.filter((entry) => !all.some((finding) => finding.advisory === entry.advisory && finding.package === entry.package));
for (const entry of stale) failures.push({ ...entry, problem: 'disposition no longer matches any advisory; remove it' });
console.log(JSON.stringify({ runtimeAdvisories: runtime.length, accepted: accepted.map(({ advisory, package: name }) => advisory + ' ' + name), failures }, null, 2));
if (failures.length) process.exit(1);
