import type { Finding } from '../server/contracts';

const priority = { high: 0, medium: 1, low: 2 };

/** Related page findings share a heading while retaining their own evidence and status. */
export function findingGroups(findings: Finding[]) {
  const groups = new Map<string, { key: string; title: string; priority: Finding['priority']; findings: Finding[] }>();
  for (const finding of findings) {
    const key = JSON.stringify([finding.kind, finding.title]);
    const group = groups.get(key) ?? { key, title: finding.title, priority: finding.priority, findings: [] };
    group.findings.push(finding);
    if (priority[finding.priority] < priority[group.priority]) group.priority = finding.priority;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => priority[a.priority] - priority[b.priority] || a.title.localeCompare(b.title));
}

export function targetLabel(url: string | undefined) {
  if (!url) return 'Review supporting evidence';
  try {
    const page = new URL(url);
    return page.pathname === '/' ? page.hostname : page.pathname + page.search;
  } catch { return url; }
}
