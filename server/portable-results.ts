import { z } from "zod";
import type { Job } from "./contracts.js";

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(100).nullable();
const analysisResult = z.object({
  findings: count,
  measurementJobId: z.string().uuid(),
  omittedSuggestions: count.optional(),
  uncertainties: z.array(z.string()).optional(),
  pagesReviewed: count.optional(),
});
const measurementResult = z.object({
  metrics: z.object({ requested: count, completed: count, missing: count,
    mentionRate: rate, citationRate: rate, citations: count }),
  comparisonKey: z.string().regex(/^[a-f0-9]{64}$/),
  consoleScore: z.number().finite().nullable().optional(),
  collectionCompletedAt: z.string().datetime().optional(),
  analysis: analysisResult.optional(),
}).refine(({ metrics }) => metrics.completed <= metrics.requested &&
  metrics.missing === metrics.requested - metrics.completed);

/** Portable history carries public measurement summaries, never arbitrary provider payloads. */
export function portableJobResult(job: { kind: Job["kind"]; result?: unknown }) {
  if (!["measure", "recheck"].includes(job.kind)) return null;
  const result = measurementResult.safeParse(job.result);
  return result.success ? result.data : null;
}

/** A scan's follow-up and a separately requested analysis use the same completion receipt. */
export function completedAnalysisResult(job: Job) {
  if (job.status !== 'completed') return null;
  const payload = job.kind === 'diagnose' ? job.result
    : ['measure', 'recheck'].includes(job.kind) ? (job.result as { analysis?: unknown } | null)?.analysis : null;
  const result = analysisResult.safeParse(payload);
  return result.success ? result.data : null;
}

/** The pinned check remains the source of scope even for a separately requested analysis. */
export function analysisMeasurementId(job: Job) {
  return completedAnalysisResult(job)?.measurementJobId ?? job.measurementJobId ?? (job.result as { measurementJobId?: string } | null)?.measurementJobId;
}

export function analysisInProgress(job: Job) {
  return ['queued', 'running', 'paused'].includes(job.status) &&
    (job.kind === 'diagnose' || (job.prepareRecommendations === true && completedMeasurement(job)));
}

/** Follow-up analysis cannot invalidate a fully checkpointed answer collection. */
export function completedMeasurement(job: Job) {
  if (!["measure", "recheck"].includes(job.kind)) return false;
  if (job.status === "completed") return true;
  const result = portableJobResult(job);
  return !!result && result.metrics.missing === 0 && !!result.collectionCompletedAt;
}

/** Brand-wide readings skip topic checks, which ask only part of the brand's questions. */
export function completedBrandMeasurement(job: Job) {
  return !job.topicId && completedMeasurement(job);
}

/**
 * Engines whose checks are readings of their own and never the default basis for recommendations.
 * A DeepSeek check stays in the brand view and its own trend, while recommendations keep reading the
 * newest check from an engine that prepares them, so a weekly DeepSeek check never displaces them.
 */
export const comparisonOnlyProviders: readonly string[] = ["deepseek"];

/** A completed check that recommendations may read by default, brand-wide or for a topic. */
export function analysisBasisCheck(job: Job) {
  return completedMeasurement(job) && !comparisonOnlyProviders.includes(job.provider ?? "");
}

/** The check that brand recommendations read by default: the newest brand check outside comparison-only engines. */
export function completedAnalysisBasis(job: Job) {
  return !job.topicId && analysisBasisCheck(job);
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
