import type { Project } from "./contracts.js";

/** An ask freezes the website's identity with one question and no topics, so it is scored like a check and stored apart from one. */
export function askScope(project: Project, question: string): Project {
  return { ...project, prompts: [question], topics: [] };
}

/** Each paid engine gets an even share of the limit, rounded down to the cent, so together they can never spend more than it. */
export function askShare(limitUsd: number, paidEngines: number) {
  return paidEngines ? Math.floor((limitUsd / paidEngines) * 100 + 1e-9) / 100 : 0;
}

/** Whether every paid estimate fits its share, and the smallest limit that would make them fit. Unknown prices are checked when the ask starts. */
export function askFit(limitUsd: number, paidEstimates: (number | null)[]) {
  const share = askShare(limitUsd, paidEstimates.length);
  const known = paidEstimates.filter((value): value is number => value !== null);
  const overLimit = paidEstimates.length > 0 && (share <= 0 || known.some(value => value > share + 1e-9));
  const suggestedLimitUsd = known.length ? Math.ceil(Math.max(...known) * paidEstimates.length * 100 - 1e-9) / 100 : null;
  return { shareUsd: share, overLimit, suggestedLimitUsd };
}
