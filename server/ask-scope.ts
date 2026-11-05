import type { Project } from "./contracts.js";
import { USD_SCALE, usdMicros } from "./usd.js";

/** An ask freezes the website's identity with one question and no topics, so it is scored like a check and stored apart from one. */
export function askScope(project: Project, question: string): Project {
  return { ...project, prompts: [question], topics: [] };
}

/** Reserve each estimate first, then share unused approval without exceeding the total.
 * Unknown prices receive a positive budget and must still pass the execution quote.
 * One expensive engine must not require inflating every other engine's approval.
 */
export function askFit(limitUsd: number, paidEstimates: (number | null)[]) {
  const budget = usdMicros(limitUsd, 'floor') ?? NaN;
  const minimums = paidEstimates.map(value => value === null ? 1 : Math.max(1, usdMicros(value, 'ceil') ?? NaN));
  const required = minimums.reduce((sum, value) => sum + value, 0);
  const valid = Number.isSafeInteger(budget) && budget >= 0 && Number.isSafeInteger(required) &&
    paidEstimates.every(value => value === null || (Number.isFinite(value) && value >= 0));
  const overLimit = !valid || required > budget;
  const spare = overLimit || !minimums.length ? 0 : Math.floor((budget - required) / minimums.length);
  return {
    limitsUsd: overLimit ? [] : minimums.map(value => (value + spare) / USD_SCALE),
    overLimit,
    suggestedLimitUsd: valid && paidEstimates.length > 0 && paidEstimates.every(value => value !== null) ? required / USD_SCALE : null,
  };
}
