import { z } from "zod";
import type { Job } from "./contracts.js";

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(100).nullable();
const measurementResult = z.object({
  metrics: z.object({ requested: count, completed: count, missing: count,
    mentionRate: rate, citationRate: rate, citations: count }),
  comparisonKey: z.string().regex(/^[a-f0-9]{64}$/),
  consoleScore: z.number().finite().nullable().optional(),
  collectionCompletedAt: z.string().datetime().optional(),
}).refine(({ metrics }) => metrics.completed <= metrics.requested &&
  metrics.missing === metrics.requested - metrics.completed);

/** Portable history carries public measurement summaries, never arbitrary provider payloads. */
export function portableJobResult(job: { kind: Job["kind"]; result?: unknown }) {
  if (!["measure", "recheck"].includes(job.kind)) return null;
  const result = measurementResult.safeParse(job.result);
  return result.success ? result.data : null;
}

/** Follow-up analysis cannot invalidate a fully checkpointed answer collection. */
export function completedMeasurement(job: Job) {
  if (!["measure", "recheck"].includes(job.kind)) return false;
  if (job.status === "completed") return true;
  const result = portableJobResult(job);
  return !!result && result.metrics.missing === 0 && !!result.collectionCompletedAt;
}

/**
 * The measurement the workspace presents. A run still collecting replaces the last completed
 * check only once it has saved answers, and a run that failed for good never replaces one:
 * otherwise a single interrupted recheck would hide every earlier result.
 */
export function displayedMeasurement(jobs: Job[], savedAnswers: (job: Job) => number) {
  const measurements = jobs.filter(job => ["measure", "recheck"].includes(job.kind));
  const completed = measurements.find(completedMeasurement);
  const collecting = measurements.find(job =>
    !completedMeasurement(job) && (completed ? ["running", "paused", "queued"] : ["running", "paused", "queued", "failed"]).includes(job.status) &&
    (!completed || job.createdAt > completed.createdAt) && savedAnswers(job) > 0);
  return collecting ?? completed ?? measurements.find(job => ["running", "paused", "failed"].includes(job.status));
}

/** Follow-up processing does not change when the underlying answers were collected. */
export function measurementTime(job: Job) {
  return portableJobResult(job)?.collectionCompletedAt ?? job.updatedAt;
}
