import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderError, type Finding, type Job, type ManagedSourceEvidence, type Project } from "./contracts.js";
import { publicUrl } from "./network.js";
import { completedMeasurement } from "./portable-results.js";
import { consoleAnswerInput } from "./console-competitors.js";
import { consoleManaged, managedJob } from "./console-managed.js";
import type { Runner } from "./workflows.js";

const url = z.string().max(2048).refine(value => { try { publicUrl(value); return true; } catch { return false; } });
const result = z.object({ job: managedJob, review_complete: z.literal(true), locale: z.string().max(40),
  provenance: z.literal("client_supplied_answers"), pages_read: z.number().int().min(1).max(6),
  sources: z.array(z.object({ url, title: z.string().max(1000), text: z.string().min(1).max(50000),
    fetched_at: z.string().datetime({ offset: true }) })).min(1).max(6),
  uncertainties: z.array(z.string().trim().min(1).max(600)).max(12),
  opportunities: z.array(z.object({ title: z.string().trim().min(3).max(200), description: z.string().trim().min(10).max(1200),
    benefit: z.string().trim().min(10).max(500), type: z.enum(["page_update", "new_content", "site_change"]),
    page_title: z.string().trim().min(2).max(200), page_label: z.string().trim().min(2).max(80), topic: z.string().trim().min(3).max(500),
    target_url: url.nullable(), source_urls: z.array(url).min(1).max(6), answer_ids: z.array(z.string().uuid()).min(1).max(100),
    steps: z.array(z.string().trim().min(1).max(500)).min(1).max(8) })).max(12) });

/** Fresh excerpts and original answers remain separate, immutable evidence records. */
export async function consoleOpportunities(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  const { output, input } = await consoleManaged(runner, job, project, signal, () => {
    const measurement = job.measurementJobId ? runner.store.job(job.measurementJobId)
      : runner.store.jobs(project.id).find(completedMeasurement);
    if (!measurement || measurement.projectId !== project.id || !completedMeasurement(measurement))
      throw new ProviderError("evidence", "Complete a visibility check before looking for improvements.");
    runner.store.setStep(job.id, "opportunity-measurement", "done", measurement.id);
    return consoleAnswerInput(runner, project, measurement.id);
  }, result);
  const invalid = () => new ProviderError("invalid_response", "These recommendations do not match their saved evidence. Resume to check the same result again; no replacement will be purchased.");
  if (output.locale !== input.locale || output.pages_read !== output.sources.length) throw invalid();
  const pageIds = new Map<string, string>(), sources: ManagedSourceEvidence[] = [];
  for (const source of output.sources) {
    const address = publicUrl(source.url), host = address.hostname.replace(/^www\./, "");
    if ((host !== project.domain && !host.endsWith("." + project.domain)) || pageIds.has(source.url)) throw invalid();
    const id = randomUUID(); pageIds.set(source.url, id);
    sources.push({ id, jobId: job.id, url: source.url, title: source.title, text: source.text,
      fetchedAt: source.fetched_at, provenance: "managed_public_page" });
  }
  const seen = new Set<string>();
  const findings: Finding[] = output.opportunities.map(row => {
    if (new Set(row.source_urls).size !== row.source_urls.length || row.source_urls.some(url => !pageIds.has(url)) ||
      new Set(row.answer_ids).size !== row.answer_ids.length || row.answer_ids.some(id => !input.answers.some(answer => answer.id === id)) ||
      (row.type === "new_content" ? row.target_url !== null : !row.target_url || !row.source_urls.includes(row.target_url))) throw invalid();
    const key = JSON.stringify([row.type, row.target_url, row.topic.toLowerCase().trim().replace(/\s+/g, " ")]);
    if (seen.has(key)) throw invalid(); seen.add(key);
    return { id: randomUUID(), projectId: project.id, jobId: job.id, title: row.title, description: row.description,
      priority: "medium", targetUrl: row.target_url ?? row.source_urls[0], evidenceIds: [...row.source_urls.map(url => pageIds.get(url)!), ...row.answer_ids],
      steps: row.steps, confidence: "inferred", status: "open", kind: "analysis",
      opportunity: { type: row.type, pageLabel: row.page_label, pageTitle: row.page_title, benefit: row.benefit, topic: row.topic } };
  });
  const receipt = { findings: findings.length, uncertainties: output.uncertainties, pagesReviewed: output.pages_read,
    measurementJobId: JSON.parse(runner.store.step(job.id, "opportunity-measurement")!.body!), model: "managed" };
  runner.store.db.transaction(() => {
    for (const source of sources) runner.store.put("source", project.id, job.id, source);
    for (const finding of findings) runner.store.put("finding", project.id, job.id, finding);
    runner.store.setStep(job.id, "diagnosis-result", "done", receipt);
  })();
  return receipt;
}
