import type { Observation } from './contracts.js';

/** Count an answer once even when its provider repeats the same query. */
export function reportedSearches(observations: Observation[]) {
  const rows = new Map<string, { query: string; prompts: Set<string>; observationIds: Set<string> }>();
  for (const observation of observations) for (const raw of observation.searchQueries ?? []) {
    const query = raw.replace(/\s+/g, ' ').trim();
    if (!query) continue;
    const key = query.toLocaleLowerCase();
    const row = rows.get(key) ?? { query, prompts: new Set<string>(), observationIds: new Set<string>() };
    row.prompts.add(observation.prompt); row.observationIds.add(observation.id);
    rows.set(key, row);
  }
  return [...rows.values()].map(row => ({ query: row.query, prompts: [...row.prompts], observationIds: [...row.observationIds] }))
    .sort((a, b) => b.observationIds.length - a.observationIds.length || a.query.localeCompare(b.query));
}
