import type { Observation } from '../server/contracts';

/** Exact prompt text keeps edited questions separate; each saved answer contributes once. */
export function promptResults(observations: Observation[]) {
  const results = new Map<string, { ids: string[]; mentions: number; citations: number }>();
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.id)) continue;
    seen.add(observation.id);
    const row = results.get(observation.prompt) ?? { ids: [], mentions: 0, citations: 0 };
    row.ids.push(observation.id);
    if (observation.mentioned) row.mentions++;
    if (observation.cited) row.citations++;
    results.set(observation.prompt, row);
  }
  return results;
}
