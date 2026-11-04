import type { Observation } from '../server/contracts';

export function citesDomain(answer: Observation, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  return answer.citations.some(citation => {
    try {
      const url = new URL(citation.url), host = url.hostname.replace(/^www\./, '');
      return ['http:', 'https:'].includes(url.protocol) && (host === normalized || host.endsWith('.' + normalized));
    } catch { return false; }
  });
}

/** All comparison sections count the same unique saved answers, including answers citing neither website. */
export function competitorComparison(observations: Observation[], ownDomain: string, otherDomain: string) {
  const answers = [...new Map(observations.map(answer => [answer.id, answer])).values()];
  const rows = answers.map(answer => ({ answer, own: citesDomain(answer, ownDomain), other: citesDomain(answer, otherDomain) }));
  const counts = (items: typeof rows) => ({ total: items.length, own: items.filter(row => row.own).length, other: items.filter(row => row.other).length,
    both: items.filter(row => row.own && row.other).length, otherOnly: items.filter(row => row.other && !row.own).length,
    ownOnly: items.filter(row => row.own && !row.other).length, neither: items.filter(row => !row.own && !row.other).length });
  return { rows, ...counts(rows),
    prompts: [...new Set(answers.map(answer => answer.prompt))].map(prompt => ({ prompt, ...counts(rows.filter(row => row.answer.prompt === prompt)), answers: rows.filter(row => row.answer.prompt === prompt).map(row => row.answer) })),
    platforms: [...new Set(answers.map(answer => answer.platform))].map(platform => ({ platform, ...counts(rows.filter(row => row.answer.platform === platform)) })),
  };
}
