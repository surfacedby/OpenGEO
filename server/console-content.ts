import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderError, type Job, type Project } from "./contracts.js";
import { contentSources } from "./evidence-context.js";
import { consoleManaged, managedJob } from "./console-managed.js";
import type { Runner } from "./workflows.js";

const source = z.object({ url: z.string().url().refine(value => {
  const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}), title: z.string() });
const result = z.object({ job: managedJob, brief: z.string().nullable(),
  draft: z.object({ title: z.string().nullable(), markdown: z.string().nullable() }).nullable(),
  review: z.object({ requires_human_review: z.literal(true), claim_scope: z.literal("numeric_and_absolute_statements"),
    coverage_complete: z.boolean(), issues: z.array(z.object({ claim: z.string(), support: z.string(), evidence_urls: z.array(source.shape.url) })) }),
  sources: z.array(source) });

/** Local documents retain their task and source review; purchases share one managed lifecycle. */
export async function consoleContent(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  const completed = runner.store.step(job.id, "content-result");
  if (completed?.state === "done") return JSON.parse(completed.body!);
  const { original, task } = runner.contentRequest(job, project);
  const { output, input, capability } = await consoleManaged(runner, job, project, signal, () => {
    const question = original?.topic ?? job.topic ?? project.brand;
    const required = task.mode === "page_update" && task.targetUrl ? [task.targetUrl] : [];
    let urls: string[];
    if (original) urls = (original.sourceEvidence ?? []).map((source: { url: string }) => source.url);
    else {
      const audit = runner.store.jobs(project.id).find(item => item.kind === "audit" && item.status === "completed");
      const pages = audit ? runner.store.pages(project.id, audit.id) : [];
      if (!pages.length) throw new ProviderError("evidence", "Complete a website audit before creating a draft.");
      urls = contentSources(pages, question, 65000, required).sources.map(page => page.url);
    }
    const note = original ? job.revisionInstructions ?? "" : project.knowledge;
    if (note.length > 4000) throw new ProviderError("context", "This connection accepts up to 4,000 characters of supplied expertise. Choose ChatGPT or OpenRouter for the complete material.");
    const recommendation = task.recommendation;
    // SurfacedBy's limits are checked here so nothing is cut silently.
    if (recommendation && (recommendation.title.length > 200 || recommendation.description.length > 1200 || recommendation.steps.length > 8 || recommendation.steps.some(step => step.length > 500)))
      throw new ProviderError("context", "This opportunity is longer than SurfacedBy accepts. Choose ChatGPT or OpenRouter to draft it.");
    if (original && original.markdown.length > 32000)
      throw new ProviderError("context", "This draft is longer than SurfacedBy can revise. Choose ChatGPT or OpenRouter.");
    const finding = task.findingId ? runner.store.findings(project.id).find(row => row.id === task.findingId) : undefined;
    return {
      question, content_type: "blog_post", locale: original?.locale ?? project.locale, user_note: note,
      source_urls: [...new Set([...required, ...urls])].slice(0, 5),
      ...(recommendation ? { task: { action: task.mode === "page_update" ? "improve_page" : "create_page", ...recommendation } } : {}),
      ...(required.length ? { target_url: required[0] } : {}),
      ...(finding?.kind === "console" && finding.remoteId ? { opportunity_id: finding.remoteId } : {}),
      ...(original ? { original_draft: original.markdown } : {}),
    };
  }, result);
  if (!output.draft?.markdown?.trim())
    throw new ProviderError("invalid_response", "SurfacedBy did not return a completed draft. The saved request will not be submitted again.");
  const sources = output.sources.map(item => ({ ...item, id: randomUUID() }));
  const doc = { id: randomUUID(), topic: input.question, task, locale: input.locale,
    markdown: output.draft.markdown, brief: output.brief ?? "", sourceEvidence: sources,
    sourceCoverage: { pagesAvailable: sources.length, pagesUsed: sources.length, excerpts: true },
    review: { requiresHumanReview: true, scope: output.review.claim_scope, coverageComplete: output.review.coverage_complete,
      issues: output.review.issues.map(issue => ({ claim: issue.claim, reason: "Source support: " + issue.support.replaceAll("_", " "),
        evidenceIds: sources.filter(source => issue.evidence_urls.includes(source.url)).map(source => source.id) })) },
    reviewCurrent: true, requiresHumanReview: true,
    status: output.review.issues.length || !output.review.coverage_complete ? "needs_review" : "draft",
    createdAt: new Date().toISOString(), model: capability?.models.find(model => model.operations.includes("content"))?.id ?? "managed",
    ...(original ? { derivedFrom: original.id, revisionInstructions: job.revisionInstructions } : {}) };
  runner.store.db.transaction(() => {
    runner.store.put("content", project.id, job.id, doc);
    runner.store.setStep(job.id, "content-result", "done", doc);
  })();
  return doc;
}
