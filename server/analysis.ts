import { createHash } from "node:crypto";
import type { Observation, Project, Job } from "./contracts.js";
import { portableJobResult, completedMeasurement, measurementTime } from "./portable-results.js";
export function presence(project: Project, answer: string, urls: string[]) {
  const names = [project.brand, ...project.aliases, project.domain]
    .map((x) => x.trim())
    .filter(Boolean);
  const mentioned = names.some((name) =>
    new RegExp(
      "(?<![\\p{L}\\p{N}])" +
        name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "(?![\\p{L}\\p{N}])",
      "iu",
    ).test(answer),
  );
  const cited = urls.some((url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return host === project.domain || host.endsWith("." + project.domain);
    } catch {
      return false;
    }
  });
  return { mentioned: mentioned || cited, cited };
}
export function summarize(observations: Observation[], requested: number) {
  const n = observations.length;
  return {
    requested,
    completed: n,
    missing: Math.max(0, requested - n),
    mentionRate: n
      ? (observations.filter((o) => o.mentioned).length / n) * 100
      : null,
    citationRate: n
      ? (observations.filter((o) => o.cited).length / n) * 100
      : null,
    citations: observations.reduce((n, o) => n + o.citations.length, 0),
  };
}
/** A saved check owns its denominator, including after project edits or restore. */
export function measurementMetrics(job: Job | undefined, observations: Observation[], fallback: number) {
  const saved = job ? portableJobResult(job) : null;
  return summarize(observations, saved?.metrics.requested ?? job?.requestedAnswers ?? fallback);
}
export function comparisonKey(
  project: Project,
  job: Job,
  observations: Observation[] = [],
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        domain: project.domain,
        brand: project.brand,
        aliases: project.aliases,
        prompts: project.prompts,
        locale: project.locale,
        provider: job.provider,
        platform: job.platform,
        model: job.model,
        observedModels: [...new Set(observations.map((o) => o.model))].sort(),
        observedPrompts: [...new Set(observations.map((o) => o.prompt))].sort(),
        surfaces: [...new Set(observations.map((o) => o.surface ?? "unknown"))].sort(),
        retrieval: [...new Set(observations.map((observation) => observation.retrieval ?? "provider_managed"))].sort(),
        webSearchConfirmed: [...new Set(observations.filter((observation) => observation.provider === "chatgpt").map((observation) => observation.webSearchConfirmed === true))].sort(),
      }),
    )
    .digest("hex");
}
export function recheckComparison(jobs: Job[]) {
  const completed = jobs.filter(
    completedMeasurement,
  );
  const latest = completed[0],
    current = latest?.result as any;
  if (!latest || !current?.comparisonKey) return null;
  const previous = completed
    .slice(1)
    .find(
      (j) =>
        (j.result as any)?.comparisonKey === current.comparisonKey &&
        (j.result as any)?.metrics?.missing === 0,
    );
  if (current.metrics?.missing !== 0)
    return {
      status: "incomplete",
      message:
        "This check has missing observations. A comparable change is unavailable.",
    };
  if (!previous)
    return {
      status: "unavailable",
      message:
        "Complete another check with the same questions, locale, provider, platform and model to compare.",
    };
  const prior = (previous.result as any).metrics;
  return {
    status: "comparable",
    previousJobId: previous.id,
    previousAt: measurementTime(previous),
    currentAt: measurementTime(latest),
    mentionPoints:
      current.metrics.mentionRate === null || prior.mentionRate === null
        ? null
        : current.metrics.mentionRate - prior.mentionRate,
    citationPoints:
      current.metrics.citationRate === null || prior.citationRate === null
        ? null
        : current.metrics.citationRate - prior.citationRate,
  };
}
export function competitorEvidence(
  project: Project,
  observations: Observation[],
) {
  return project.competitors.map((value) => {
    const domain = new URL(
      value.includes("://") ? value : "https://" + value,
    ).hostname.replace(/^www\./, "");
    const matched = observations.filter((o) =>
      o.citations.some((c) => {
        try {
          const h = new URL(c.url).hostname.replace(/^www\./, "");
          return h === domain || h.endsWith("." + domain);
        } catch {
          return false;
        }
      }),
    );
    return {
      domain,
      answersCiting: matched.length,
      answersCollected: observations.length,
      citationRate: observations.length
        ? (matched.length / observations.length) * 100
        : null,
      observationIds: matched.map((o) => o.id),
      urls: [
        ...new Set(
          matched.flatMap((o) =>
            o.citations
              .filter((c) => {
                const h = new URL(c.url).hostname.replace(/^www\./, "");
                return h === domain || h.endsWith("." + domain);
              })
              .map((c) => c.url),
          ),
        ),
      ],
    };
  });
}
