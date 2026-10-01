import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

const forbidden = /(?:^|\/)(?:\.claude|\.codex|audit-private)(?:\/|$)|(?:^|\/)(?:implementation-ledger|private-notes|internal-notes|session-notes|handoff|release-dispositions|ux-audit|positioning)(?:[.-][^/]*)?\.(?:md|json)$|(?:^|\/)(?:credentials\.sealed|local-session|runtime\.lock|encryption-secret|\.env(?!\.example$)[^/]*)$|\.(?:sqlite(?:-wal|-shm)?|dump|pem|key)$/i;
const internalNarration = /\x3csend_user_message_question_reply>|^\s*(?:\/\/|\/\*|\*|<!--)\s*(?:(?:I|we)\s+(?:fixed|added|changed|removed|improved|updated)\b|(?:fixed|added|changed|removed|improved|updated)\s+(?:this|the)\b|(?:as|per)\s+(?:the\s+)?(?:user|reviewer|your)\s+(?:asked|requested|feedback)\b)/im;
const textFile = /\.(?:[cm]?[jt]sx?|css|html|svg|md|json|ya?ml)$/i;

/** Deleted development material must not become public through an older commit. */
export function publicSurfaceFindings(root) {
  const read = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const tracked = read(['ls-files', '-z']).split('\0');
  const history = read(['log', '--all', '--reflog', '--format=', '--name-only']).split(/\r?\n/);
  const files = [];
  const excluded = new Set(['.git', 'node_modules', '.browser-runtime', 'dist', 'dist-server', 'release', 'test-results', 'playwright-report', 'coverage']);
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) { if (!excluded.has(entry.name)) walk(resolve(directory, entry.name), path + '/'); }
      else files.push(path);
    }
  };
  walk(root);
  const narrated = files.filter(path => textFile.test(path) && internalNarration.test(readFileSync(resolve(root, path), 'utf8')));
  return [...new Set([...tracked, ...history, ...files].filter(path => forbidden.test(path)).concat(narrated))].sort();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const findings = publicSurfaceFindings(process.cwd());
    if (findings.length) { console.error('Publication blocked: development-only or private files occur in source/history.'); for (const path of findings) console.error(path); process.exitCode = 1; }
    else console.log('Public source/history boundary passed. Secret and artifact audits are still required.');
  } catch { console.error('Publication blocked: source/history review could not complete.'); process.exitCode = 1; }
}
