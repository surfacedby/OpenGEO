import type { Job, Observation } from './contracts.js';
export type PublicObservation = Omit<Observation, 'model' | 'surface'>;

/** Keep collection details in local evidence for comparison integrity, outside the presentation contract. */
export function publicObservation({ model: _model, surface: _surface, ...answer }: Observation) {
  return answer;
}

/** Workflow and draft metadata is private; authored prose and evidence are returned unchanged. */
export function publicArtifact<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { model: _model, surface: _surface, ...record } = value as Record<string, unknown>;
  if (record.analysis) record.analysis = publicArtifact(record.analysis);
  return record as T;
}

export function publicJob({ model: _model, ...job }: Job) {
  return { ...job, result: publicArtifact(job.result) };
}
