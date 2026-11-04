import { Store } from "./storage.js";
import type { Finding, PageEvidence, ManagedSourceEvidence } from "./contracts.js";
import type { PortableContent } from "./import.js";
import { portableJobResult, completedBrandMeasurement, measurementTime, analysisMeasurementId } from "./portable-results.js";
import { currentFindings } from "./presentation.js";
export { escapeHtml } from "./markdown.js";
export function exportProject(store: Store, id: string) {
  return {
    format: "opengeo-project",
    version: 1,
    exportedAt: new Date().toISOString(),
    project: store.project(id),
    jobs: store
      .jobs(id)
      .filter((job) => job.kind !== "ask")
      .map(
        ({
          id,
          kind,
          provider,
          model,
          platform,
          status,
          createdAt,
          updatedAt,
          result,
          spentUsd,
          costBasis,
          topicId,
        }) => ({
          id,
          kind,
          provider,
          model,
          platform,
          status,
          createdAt,
          updatedAt,
          result: portableJobResult({ kind, result }),
          spentUsd,
          costBasis,
          topicId,
        }),
      ),
    pages: store.portableArtifacts<PageEvidence>(id, "page"),
    sourceEvidence: store.portableArtifacts<ManagedSourceEvidence>(id, "source"),
    observations: store.observations(id),
    findings: store.findings(id),
    content: store.portableArtifacts<PortableContent>(id, "content"),
  };
}
export function reportMarkdown(store: Store, id: string) {
  const p = store.project(id),
    jobs = store.jobs(id),
    findings = currentFindings(store.findings(id), jobs),
    latest = jobs.find(completedBrandMeasurement);
  const metrics = (latest?.result as { metrics?: { requested: number; completed: number; missing: number; mentionRate: number | null; citationRate: number | null } } | null)?.metrics;
  const percent = (value: number | null) => value === null ? "No collected evidence" : value.toFixed(1) + "%";
  const scopeLabel = (finding: Finding) => {
    const job = jobs.find(item => item.id === finding.jobId);
    if (!job) return 'Historical evidence';
    if (job.kind === 'audit') return 'Website check';
    const topicId = job.topicId ?? jobs.find(item => item.id === analysisMeasurementId(job))?.topicId;
    return topicId ? 'Topic: ' + (p.topics.find(topic => topic.id === topicId)?.name ?? 'Removed topic') : 'Brand-wide check';
  };
  return (
    "# " +
    p.brand +
    "\n\nWebsite: https://" +
    p.domain +
    "\n\nGenerated: " +
    new Date().toISOString() +
    "\n\n## Visibility\n\n" +
    (latest && metrics
      ? "Checked: " + new Date(measurementTime(latest)).toISOString() + "\n\n- Brand mentions: " + percent(metrics.mentionRate) + "\n- Website citations: " + percent(metrics.citationRate) + "\n- Answers collected: " + metrics.completed + " of " + metrics.requested + "\n- Missing answers: " + metrics.missing + "\n\nRates use collected answers. API observations can differ from consumer interfaces. Missing answers do not count as absent mentions."
      : "No completed measurement. Failed checks are not evidence of absence.") +
    "\n\n## Improvements\n\n" +
    findings
      .map(
        (f) =>
          "### " +
          f.title +
          "\n\n" +
          f.description +
          "\n\nScope: " + scopeLabel(f) +
          "\n\nPage: " +
          f.targetUrl +
          "\n\nStatus: " + f.status + " / Priority: " + f.priority +
          "\n\nSupporting records: " + f.evidenceIds.length +
          "\n\n" +
          f.steps.map((s) => "- " + s).join("\n"),
      )
      .join("\n\n")
  );
}
