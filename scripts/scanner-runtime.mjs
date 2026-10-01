import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { scannerImages } from './scanner-config.mjs';

// These binaries are extracted from the corresponding official release archives.
const nativeReleases = {
  gitleaks: { version: '8.30.1', directory: 'gitleaks-windows', sha256: '17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c' },
  trufflehog: { version: '3.97.9', directory: 'trufflehog-windows', sha256: 'a1825a8b0feb00a0a3a2b1fed765fdde4d0d65c9e775adb91ff5be15170ec5db' },
};

function windowsGitUri(directory) {
  const path = directory.replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(path)) throw new Error('Native Git history scans require a local Windows drive.');
  // This pinned scanner duplicates the drive for standard triple-slash file URLs.
  return 'file://' + path.split('/').map((part, index) => index === 0 ? part : encodeURIComponent(part)).join('/');
}

function nativeBinary(scanner) {
  if (process.platform !== 'win32') throw new Error('Pinned native scanners currently support Windows x64 only.');
  const release = nativeReleases[scanner];
  const file = resolve(process.env.OPENGEO_SCANNER_DIR, release.directory, scanner + '.exe');
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== release.sha256)
    throw new Error('Scanner binary does not match its pinned release digest.');
  return { file, release };
}

/** Keep detector output private; callers receive only paths, rules and scan provenance. */
export function runScanner(scanner, directory, report, history = false) {
  const native = !!process.env.OPENGEO_SCANNER_DIR;
  const target = native ? resolve(directory) : '/repo';
  const command = scanner === 'gitleaks'
    ? [history ? 'git' : 'dir', target, '--redact=100', '--ignore-gitleaks-allow', '--max-decode-depth=3', '--report-format=json', '--report-path=' + (native ? report : '/tmp/report.json'), ...(history ? ['--log-opts=--all'] : [])]
    : [history ? 'git' : 'filesystem', history ? (native ? windowsGitUri(target) : 'file:///repo') : target, '--no-verification', '--no-update', '--no-ignore-tag', '--fail-on-scan-errors', '--json', '--fail'];
  let exit, logs, provenance;
  if (native) {
    const { file, release } = nativeBinary(scanner);
    const result = spawnSync(file, command, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
    if (result.error) throw new Error('Native scanner could not complete: ' + result.error.code);
    exit = result.status;
    logs = result.stdout;
    provenance = { transport: 'native', version: release.version, sha256: release.sha256, credentialVerification: false, networkIsolated: false };
  } else {
    const name = 'opengeo-audit-' + randomUUID();
    const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      docker(['create', '--name', name, '--network', 'none', scannerImages[scanner], ...command]);
      docker(['cp', directory + '/.', name + ':/repo']);
      docker(['start', name]); docker(['wait', name]);
      exit = Number(docker(['inspect', name, '--format', '{{.State.ExitCode}}']).trim());
      logs = docker(['logs', name]);
      if (scanner === 'gitleaks') docker(['cp', name + ':/tmp/report.json', report]);
    } finally { try { docker(['rm', '-f', name]); } catch {} }
    provenance = { transport: 'docker', image: scannerImages[scanner], credentialVerification: false, networkIsolated: true };
  }
  const accepted = scanner === 'gitleaks' ? [0, 1] : [0, 183];
  if (!accepted.includes(exit)) throw new Error(scanner + ' scan incomplete (exit ' + exit + ').');
  let findings;
  if (scanner === 'gitleaks') {
    if (!existsSync(report)) throw new Error('Gitleaks report is missing.');
    findings = JSON.parse(readFileSync(report, 'utf8')).map(row => ({ path: row.File, rule: 'gitleaks:' + row.RuleID, ...(history ? { commit: row.Commit } : {}) }));
  } else {
    findings = [];
    for (const line of logs.split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.DetectorName) findings.push({ path: row.SourceMetadata?.Data?.Filesystem?.file ?? row.SourceMetadata?.Data?.Git?.file ?? '(unknown)', rule: 'trufflehog:' + row.DetectorName, ...(history ? { commit: row.SourceMetadata?.Data?.Git?.commit } : {}) });
    }
  }
  findings = findings.map(finding => ({ ...finding, path: (native && !history && resolve(finding.path).startsWith(resolve(directory) + '\\') ? relative(directory, finding.path) : finding.path.replace(/^\/repo\//, '')).replaceAll('\\', '/') }));
  return { findings, provenance };
}
