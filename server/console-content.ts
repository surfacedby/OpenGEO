import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ProviderError, type Job, type Project } from "./contracts.js";
import { consoleCapabilities } from "./console-capabilities.js";
import { contentSources } from "./evidence-context.js";
import { scheduledBudgetCeiling } from "./scheduler.js";
import type { Runner } from "./workflows.js";

const credits = z.number().int().nonnegative();
/** One SurfacedBy credit is ten cents; dividing keeps whole-cent amounts exact. */
const creditUsd = (value: number) => value / 10;
const receipt = z.object({ charged_credits: credits, refunded_credits: credits,
  status: z.enum(["completed", "cancelled", "failed", "expired"]) });
const remoteJob = z.object({ id: z.string().uuid(), status: z.enum(["queued", "running", "cancelling", "waiting_reconciliation", "completed", "cancelled", "failed", "expired"]),
  estimated_credits: credits, approved_credits: credits, receipt: receipt.nullable(), cancel_requested: z.boolean() });
const recoveredJob = remoteJob.extend({ estimate_id: z.string().uuid(), request_key: z.string().uuid() });
const submission = z.object({ estimate_id: z.string().uuid(), request_key: z.string().uuid(), approved_credits: credits.positive() });
const recoveryPage = z.object({ data: z.array(recoveredJob).max(1), meta: z.object({ has_more: z.literal(false) }) });
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

/**
 * SurfacedBy reserves the approved credits, then settles them once: the charge plus the refund equals the reservation.
 * Until that receipt arrives the whole reservation counts as held spend.
 */
function recordReceipt(runner: Runner, job: Job, remote: z.infer<typeof remoteJob>, expected: { estimated: number; approved: number }) {
  if (remote.estimated_credits !== expected.estimated || remote.approved_credits !== expected.approved)
    throw new ProviderError("invalid_response", "The returned reservation does not match this draft. Review SurfacedBy before continuing.");
  if (remote.receipt && (remote.receipt.charged_credits + remote.receipt.refunded_credits !== remote.approved_credits || remote.receipt.charged_credits > remote.approved_credits))
    throw new ProviderError("invalid_response", "The final charge does not match this draft's reservation. Review SurfacedBy before continuing.");
  runner.store.updateJob(job.id, { spentUsd: creditUsd(remote.receipt?.charged_credits ?? remote.approved_credits),
    costBasis: remote.receipt ? "reported" : "includes_estimates" });
}

/** A lost acknowledgement is recovered by the approved identity, never by purchasing a replacement. */
async function recoverSubmission(runner: Runner, job: Job, signal: AbortSignal) {
  const saved = runner.store.step(job.id, "console-content-job");
  if (!saved || saved.state === "done" || saved.state === "rejected") return;
  const approved = runner.store.step(job.id, "console-content-submission");
  const quote = runner.store.step(job.id, "console-content-estimate");
  if (!approved?.body || !quote?.body)
    throw new ProviderError("waiting", "The earlier draft submission needs confirmation. Check SurfacedBy before starting another draft.", true);
  const request = submission.parse(JSON.parse(approved.body));
  const estimateValue = estimate.parse(JSON.parse(quote.body));
  if (request.request_key !== job.id || request.estimate_id !== estimateValue.id)
    throw new ProviderError("invalid_response", "The saved draft approval does not match this request. Check SurfacedBy before continuing.", true);
  const page = recoveryPage.safeParse(await runner.providers.console("/content/jobs?request_key=" + encodeURIComponent(job.id) + "&page_size=1", undefined, undefined, signal));
  if (!page.success)
    throw new ProviderError("invalid_response", "SurfacedBy did not return a confirmed draft. Resume later to check again; no new draft was submitted.", true);
  const remote = page.data.data[0];
  if (!remote)
    throw new ProviderError("waiting", "SurfacedBy has not confirmed the earlier submission yet. Resume later to check again; no replacement draft will be submitted.", true);
  if (remote.request_key !== request.request_key || remote.estimate_id !== request.estimate_id || remote.approved_credits !== request.approved_credits)
    throw new ProviderError("invalid_response", "The returned draft does not match its saved approval. Check SurfacedBy before continuing.", true);
  recordReceipt(runner, job, remote, { estimated: estimateValue.estimated_credits, approved: request.approved_credits });
  runner.store.setStep(job.id, "console-content-job", "done", remoteJob.parse(remote));
}

export async function cancelConsoleContent(runner: Runner, job: Job) {
  let saved = runner.store.step(job.id, "console-content-job");
  if (!saved) return false;
  if (saved.state !== "done") {
    try {
      await recoverSubmission(runner, job, AbortSignal.timeout(20000));
      saved = runner.store.step(job.id, "console-content-job");
    } catch {
      runner.store.updateJob(job.id, { error: "cancel_remote", progress: "Stopped locally. Submission was not confirmed. Retry cancellation to check for your draft before starting another." });
      return true;
    }
    if (saved?.state !== "done") return false;
  }
  const remote = remoteJob.parse(JSON.parse(saved.body!));
  try {
    const cancelled = remoteJob.parse((await runner.providers.console("/content/jobs/" + remote.id + "/cancel", {}, job.id + ":cancel", AbortSignal.timeout(20000))).data);
    if (cancelled.id !== remote.id) throw new Error("Unrelated cancellation receipt");
    recordReceipt(runner, job, cancelled, { estimated: remote.estimated_credits, approved: remote.approved_credits });
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
  await recoverSubmission(runner, job, signal);
  const submitted = runner.store.step(job.id, "console-content-job")?.state === "done";
  const savedCapability = runner.store.step(job.id, "console-content-capabilities");
  // Stopping new purchases must not prevent collection of an existing reservation.
  const capability = submitted
    ? savedCapability?.body ? consoleCapabilities(JSON.parse(savedCapability.body)) : null
    : consoleCapabilities((await runner.providers.console("/capabilities", undefined, undefined, signal)).data);
  if (!submitted && (!capability?.content_available || !capability.operations.includes("content")))
    throw new ProviderError("capability", "Content is unavailable on this SurfacedBy connection. Choose ChatGPT or OpenRouter.");
  if (!submitted) runner.store.setStep(job.id, "console-content-capabilities", "done", capability);
  const domain = await runner.once(job, "console-domain", async () => {
    const domains = await runner.consolePages("/domains", signal);
    return domains.find(row => row.domain === project.domain) ?? (await runner.providers.console("/domains", { domain: project.domain }, job.id + ":domain", signal)).data;
  });
  const domainId = z.string().uuid().parse(domain.id);
  const { original, task } = runner.contentRequest(job, project);
  const savedInput = runner.store.step(job.id, "console-content-input");
  let input;
  if (savedInput?.body) input = JSON.parse(savedInput.body);
  else {
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
    input = {
      question, content_type: "blog_post", locale: original?.locale ?? project.locale, user_note: note,
      source_urls: [...new Set([...required, ...urls])].slice(0, 5),
      ...(recommendation ? { task: { action: task.mode === "page_update" ? "improve_page" : "create_page", ...recommendation } } : {}),
      ...(required.length ? { target_url: required[0] } : {}),
      ...(finding?.kind === "console" && finding.remoteId ? { opportunity_id: finding.remoteId } : {}),
      ...(original ? { original_draft: original.markdown } : {}),
    };
    runner.store.setStep(job.id, "console-content-input", "done", input);
  }
  const quote = estimate.parse(await runner.once(job, "console-content-estimate", async () =>
    estimate.parse((await runner.providers.console("/domains/" + domainId + "/content/estimates/content", input, job.id + ":estimate", signal)).data)));
  if (quote.domain_id !== domainId) throw new ProviderError("invalid_response", "The estimate does not belong to this website. No draft was submitted.");
  if (!submitted) {
    if (Date.parse(quote.expires_at) <= Date.now()) throw new ProviderError("estimate_expired", "The draft estimate has expired. Start a new draft for a current price; no job was submitted.");
    if (!quote.estimated_credits || creditUsd(quote.estimated_credits) > job.maxCostUsd + 1e-9)
      throw new ProviderError("budget", "Draft estimate: $" + creditUsd(quote.estimated_credits).toFixed(2) + ". Increase your approved maximum or choose another connection.");
    const recurringCeiling = scheduledBudgetCeiling(runner.store, job);
    if (recurringCeiling !== undefined) {
      if (creditUsd(quote.estimated_credits) > recurringCeiling + 1e-9) throw new ProviderError("budget", "This draft exceeds the remaining schedule allowance. No draft was submitted.");
      runner.store.setStep(job.id, "console-content-approval", "done", quote.id);
    }
    if (runner.store.step(job.id, "console-content-approval")?.body !== JSON.stringify(quote.id))
      throw new ProviderError("approval", "Draft estimate: $" + creditUsd(quote.estimated_credits).toFixed(2) + ". Review the price and approve to start. Unused credits are returned after completion.");
  }
  // The approved maximum is reserved; settlement charges verified work and returns the rest.
  const approvedCredits = Math.floor(job.maxCostUsd * 10 + 1e-9);
  const savedSubmission = runner.store.step(job.id, "console-content-submission");
  const request = submission.parse(savedSubmission?.body ? JSON.parse(savedSubmission.body) : {
    estimate_id: quote.id, request_key: job.id, approved_credits: approvedCredits });
  if (request.estimate_id !== quote.id || request.request_key !== job.id || request.approved_credits > approvedCredits)
    throw new ProviderError("invalid_response", "The saved approval does not match this draft's budget. No new request was submitted.");
  if (!savedSubmission) runner.store.setStep(job.id, "console-content-submission", "done", request);
  let remote = remoteJob.parse(await runner.once(job, "console-content-job", async () =>
    remoteJob.parse((await runner.providers.console("/content/jobs", request, job.id, signal)).data)));
  const remoteId = remote.id, expected = { estimated: quote.estimated_credits, approved: remote.approved_credits };
  if (remote.estimated_credits !== quote.estimated_credits || remote.approved_credits !== request.approved_credits)
    throw new ProviderError("invalid_response", "The reserved credits do not match your approved draft. Review SurfacedBy before continuing.");
  recordReceipt(runner, job, remote, expected);
  for (let attempt = 0; attempt < 180; attempt++) {
    signal.throwIfAborted();
    remote = remoteJob.parse((await runner.providers.console("/content/jobs/" + remoteId, undefined, undefined, signal)).data);
    if (remote.id !== remoteId) throw new ProviderError("invalid_response", "The returned draft does not match this request. Review SurfacedBy before continuing.");
    recordReceipt(runner, job, remote, expected);
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
  recordReceipt(runner, job, output.job, expected);
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
