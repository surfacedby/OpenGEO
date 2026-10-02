import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ProviderError, type Job, type Project } from "./contracts.js";
import { consoleCapabilities } from "./console-capabilities.js";
import { contentSources } from "./evidence-context.js";
import { scheduledBudgetCeiling } from "./scheduler.js";
import type { Runner } from "./workflows.js";

const credits = z.number().int().nonnegative();
const receipt = z.object({ charged_credits: credits, refunded_credits: credits,
  status: z.enum(["completed", "cancelled", "failed", "expired"]) });
const remoteJob = z.object({ id: z.string().uuid(), status: z.enum(["queued", "running", "cancelling", "waiting_reconciliation", "completed", "cancelled", "failed", "expired"]),
  estimated_credits: credits, receipt: receipt.nullable(), cancel_requested: z.boolean() });
const estimate = z.object({ id: z.string().uuid(), estimated_credits: credits,
  operation: z.literal("content"), domain_id: z.string().uuid(), expires_at: z.string().datetime({ offset: true }) });
const source = z.object({ url: z.string().url().refine(value => {
  const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}), title: z.string() });
const result = z.object({ job: remoteJob, brief: z.string().nullable(),
  draft: z.object({ title: z.string().nullable(), markdown: z.string().nullable() }).nullable(),
  review: z.object({ requires_human_review: z.literal(true), claim_scope: z.literal("numeric_and_absolute_statements"),
    coverage_complete: z.boolean(), issues: z.array(z.object({ claim: z.string(), support: z.string(), evidence_urls: z.array(source.shape.url) })) }),
  sources: z.array(source) });

/** A remote reservation remains visible locally until its final charge is confirmed. */
function recordReceipt(runner: Runner, job: Job, remote: z.infer<typeof remoteJob>, expectedCredits: number) {
  if (remote.estimated_credits !== expectedCredits)
    throw new ProviderError("invalid_response", "The returned reservation does not match this draft. Review SurfacedBy before continuing.");
  if (remote.receipt && remote.receipt.charged_credits + remote.receipt.refunded_credits !== remote.estimated_credits)
    throw new ProviderError("invalid_response", "The final charge does not match this draft's reservation. Review SurfacedBy before continuing.");
  runner.store.updateJob(job.id, { spentUsd: (remote.receipt?.charged_credits ?? remote.estimated_credits) * 0.1,
    costBasis: remote.receipt ? "reported" : "includes_estimates" });
}

export async function cancelConsoleContent(runner: Runner, job: Job) {
  const saved = runner.store.step(job.id, "console-content-job");
  if (!saved) return false;
  if (saved.state !== "done") {
    runner.store.updateJob(job.id, { error: "cancel_remote", progress: "Stopped locally. Submission was not confirmed. Review content jobs in SurfacedBy before starting another draft." });
    return true;
  }
  const remote = remoteJob.parse(JSON.parse(saved.body!));
  try {
    const cancelled = remoteJob.parse((await runner.providers.console("/content/jobs/" + remote.id + "/cancel", {}, job.id + ":cancel", AbortSignal.timeout(20000))).data);
    if (cancelled.id !== remote.id) throw new Error("Unrelated cancellation receipt");
    recordReceipt(runner, job, cancelled, remote.estimated_credits);
    runner.store.updateJob(job.id, { error: cancelled.receipt ? null : "cancel_remote", progress: cancelled.receipt
      ? "Cancelled. Completed work is charged and unused credits returned."
      : "Cancellation requested. Waiting for SurfacedBy to confirm the final charge. Retry cancellation to check again." });
  } catch {
    runner.store.updateJob(job.id, { error: "cancel_remote", progress: "Stopped locally. Cancellation was not confirmed. Check SurfacedBy before starting another draft." });
  }
  return true;
}

/** Quotes freeze source selection and all retries retain the same approved request identity. */
export async function consoleContent(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  const completed = runner.store.step(job.id, "content-result");
  if (completed?.state === "done") return JSON.parse(completed.body!);
  if (job.kind !== "content") throw new ProviderError("capability", "Choose ChatGPT or OpenRouter to revise an existing draft.");
  const capability = consoleCapabilities((await runner.providers.console("/capabilities", undefined, undefined, signal)).data);
  if (!capability.content_available || !capability.operations.includes("content"))
    throw new ProviderError("capability", "Content is unavailable on this SurfacedBy connection. Choose ChatGPT or OpenRouter.");
  const domain = await runner.once(job, "console-domain", async () => {
    const domains = await runner.consolePages("/domains", signal);
    return domains.find(row => row.domain === project.domain) ?? (await runner.providers.console("/domains", { domain: project.domain }, job.id + ":domain", signal)).data;
  });
  const domainId = z.string().uuid().parse(domain.id);
  const savedInput = runner.store.step(job.id, "console-content-input");
  let input;
  if (savedInput?.body) input = JSON.parse(savedInput.body);
  else {
    const audit = runner.store.jobs(project.id).find(item => item.kind === "audit" && item.status === "completed");
    const pages = audit ? runner.store.pages(project.id, audit.id) : [];
    if (!pages.length) throw new ProviderError("evidence", "Complete a website audit before creating a draft.");
    if (project.knowledge.length > 4000) throw new ProviderError("context", "This connection accepts up to 4,000 characters of supplied expertise. Choose ChatGPT or OpenRouter for the complete material.");
    const question = job.topic ?? project.brand;
    const selected = contentSources(pages, question, 65000);
    input = { question, content_type: "blog_post", locale: project.locale, source_urls: selected.sources.slice(0, 5).map(page => page.url), user_note: project.knowledge };
    runner.store.setStep(job.id, "console-content-input", "done", input);
  }
  const quote = estimate.parse(await runner.once(job, "console-content-estimate", async () =>
    estimate.parse((await runner.providers.console("/domains/" + domainId + "/content/estimates/content", input, job.id + ":estimate", signal)).data)));
  if (quote.domain_id !== domainId) throw new ProviderError("invalid_response", "The estimate does not belong to this website. No draft was submitted.");
  const submitted = runner.store.step(job.id, "console-content-job")?.state === "done";
  if (!submitted) {
    if (Date.parse(quote.expires_at) <= Date.now()) throw new ProviderError("estimate_expired", "The draft estimate has expired. Start a new draft for a current price; no job was submitted.");
    if (!quote.estimated_credits || quote.estimated_credits * 0.1 > job.maxCostUsd + 1e-9)
      throw new ProviderError("budget", "Draft estimate: $" + (quote.estimated_credits * 0.1).toFixed(2) + ". Increase your approved maximum or choose another connection.");
    const recurringCeiling = scheduledBudgetCeiling(runner.store, job);
    if (recurringCeiling !== undefined) {
      if (quote.estimated_credits * 0.1 > recurringCeiling + 1e-9) throw new ProviderError("budget", "This draft exceeds the remaining schedule allowance. No draft was submitted.");
      runner.store.setStep(job.id, "console-content-approval", "done", quote.id);
    }
    if (runner.store.step(job.id, "console-content-approval")?.body !== JSON.stringify(quote.id))
      throw new ProviderError("approval", "Draft estimate: $" + (quote.estimated_credits * 0.1).toFixed(2) + ". Review the price and approve to start. Unused credits are returned after completion.");
  }
  let remote = remoteJob.parse(await runner.once(job, "console-content-job", async () =>
    remoteJob.parse((await runner.providers.console("/content/jobs", { estimate_id: quote.id, request_key: job.id,
      approved_credits: Math.floor((job.maxCostUsd + 1e-9) / 0.1) }, job.id, signal)).data)));
  const remoteId = remote.id;
  if (remote.estimated_credits !== quote.estimated_credits) throw new ProviderError("invalid_response", "The reserved credits do not match your draft estimate. Review SurfacedBy before continuing.");
  recordReceipt(runner, job, remote, quote.estimated_credits);
  for (let attempt = 0; attempt < 180; attempt++) {
    signal.throwIfAborted();
    remote = remoteJob.parse((await runner.providers.console("/content/jobs/" + remoteId, undefined, undefined, signal)).data);
    if (remote.id !== remoteId) throw new ProviderError("invalid_response", "The returned draft does not match this request. Review SurfacedBy before continuing.");
    recordReceipt(runner, job, remote, quote.estimated_credits);
    if (remote.receipt) break;
    if (remote.status === "waiting_reconciliation")
      throw new ProviderError("waiting", "Your draft is awaiting charge confirmation. Resume later to collect it; no replacement draft will be submitted.");
    runner.store.updateJob(job.id, { progress: remote.cancel_requested ? "Waiting for cancellation confirmation" : "Preparing your researched draft" });
    await delay(5000, undefined, { signal });
  }
  if (!remote.receipt) throw new ProviderError("waiting", "Your draft is still being prepared. Resume later to collect it.");
  if (remote.receipt.status !== "completed") throw new ProviderError("provider", "The draft did not complete. Its final charge is saved. Review the job in SurfacedBy.");
  const output = result.parse((await runner.providers.console("/content/jobs/" + remoteId + "/results", undefined, undefined, signal)).data);
  if (output.job.id !== remoteId || output.job.receipt?.status !== "completed" || !output.draft?.markdown?.trim())
    throw new ProviderError("invalid_response", "SurfacedBy did not return a completed draft. The saved request will not be submitted again.");
  recordReceipt(runner, job, output.job, quote.estimated_credits);
  const sources = output.sources.map(item => ({ ...item, id: randomUUID() }));
  const doc = { id: randomUUID(), topic: job.topic ?? project.brand, locale: project.locale,
    markdown: output.draft.markdown, brief: output.brief ?? "", sourceEvidence: sources,
    sourceCoverage: { pagesAvailable: sources.length, pagesUsed: sources.length, excerpts: true },
    review: { requiresHumanReview: true, scope: output.review.claim_scope, coverageComplete: output.review.coverage_complete,
      issues: output.review.issues.map(issue => ({ claim: issue.claim, reason: "Source support: " + issue.support.replaceAll("_", " "),
        evidenceIds: sources.filter(source => issue.evidence_urls.includes(source.url)).map(source => source.id) })) },
    reviewCurrent: true, requiresHumanReview: true,
    status: output.review.issues.length || !output.review.coverage_complete ? "needs_review" : "draft",
    createdAt: new Date().toISOString(), model: capability.models.find(model => model.operations.includes("content"))?.id ?? "managed" };
  runner.store.db.transaction(() => {
    runner.store.put("content", project.id, job.id, doc);
    runner.store.setStep(job.id, "content-result", "done", doc);
  })();
  return doc;
}
