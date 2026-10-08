import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ProviderError, type Job, type Project } from "./contracts.js";
import { consoleCapabilities } from "./console-capabilities.js";
import { scheduledBudgetCeiling } from "./scheduler.js";
import type { Runner } from "./workflows.js";

const credits = z.number().int().nonnegative();
/** Dividing by ten keeps the provider's whole-credit prices exact in dollars. */
const creditUsd = (value: number) => value / 10;
const receipt = z.object({ charged_credits: credits, refunded_credits: credits,
  status: z.enum(["completed", "cancelled", "failed", "expired"]) });
export const managedJob = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "running", "cancelling", "waiting_reconciliation", "completed", "cancelled", "failed", "expired"]),
  estimated_credits: credits, approved_credits: credits, receipt: receipt.nullable(),
  cancel_requested: z.boolean(), progress: z.string().max(500).nullable().optional(),
});
const recoveredJob = managedJob.extend({ estimate_id: z.string().uuid(), request_key: z.string().uuid() });
const submission = z.object({ estimate_id: z.string().uuid(), request_key: z.string().uuid(), approved_credits: credits.positive() });
const recoveryPage = z.object({ data: z.array(recoveredJob).max(1), meta: z.object({ has_more: z.literal(false) }) });

const contracts = {
  content: { prefix: "console-content", collection: "/content/jobs", reserve: "/content/jobs", result: "/content/jobs",
    quote: (domain: string) => "/domains/" + domain + "/content/estimates/content", label: "draft" },
  questions: { prefix: "console-questions", collection: "/jobs", reserve: "/questions/jobs", result: "/questions/jobs",
    quote: (domain: string) => "/domains/" + domain + "/questions/estimate", label: "question suggestions" },
  competitors: { prefix: "console-competitors", collection: "/jobs", reserve: "/competitors/jobs", result: "/competitors/jobs",
    quote: (domain: string) => "/domains/" + domain + "/competitors/estimate", label: "website role review" },
  local_opportunities: { prefix: "console-opportunities", collection: "/jobs", reserve: "/opportunities/jobs", result: "/opportunities/jobs",
    quote: (domain: string) => "/domains/" + domain + "/opportunities/estimate", label: "recommendations" },
} as const;
type Operation = keyof typeof contracts;
export function managedOperation(job: Job): Operation {
  return job.kind === "discover" ? "questions" : job.kind === "competitors" ? "competitors" : job.kind === "diagnose" ? "local_opportunities" : "content";
}
export function managedStep(job: Job, step: string) {
  return contracts[managedOperation(job)].prefix + "-" + step;
}
const quoteSchema = (operation: Operation) => z.object({ id: z.string().uuid(), estimated_credits: credits,
  operation: z.literal(operation), domain_id: z.string().uuid(), expires_at: z.string().datetime({ offset: true }) });

/** Held spend remains the full reservation until one balanced final receipt arrives. */
function recordReceipt(runner: Runner, job: Job, remote: z.infer<typeof managedJob>, expected: { estimated: number; approved: number }) {
  if (remote.estimated_credits !== expected.estimated || remote.approved_credits !== expected.approved)
    throw new ProviderError("invalid_response", "The returned reservation does not match this run. Review SurfacedBy before continuing.");
  if (remote.receipt && (remote.receipt.charged_credits + remote.receipt.refunded_credits !== remote.approved_credits ||
    remote.receipt.charged_credits > remote.approved_credits || remote.status !== remote.receipt.status))
    throw new ProviderError("invalid_response", "The final charge does not match this run's reservation. Review SurfacedBy before continuing.");
  runner.store.updateJob(job.id, { spentUsd: creditUsd(remote.receipt?.charged_credits ?? remote.approved_credits),
    costBasis: remote.receipt ? "reported" : "includes_estimates" });
}

/** A lost acknowledgement is recovered by its approval, never by buying a replacement. */
async function recoverSubmission(runner: Runner, job: Job, signal: AbortSignal) {
  const saved = runner.store.step(job.id, managedStep(job, "job"));
  if (!saved || saved.state === "done" || saved.state === "rejected") return;
  const approved = runner.store.step(job.id, managedStep(job, "submission"));
  const quote = runner.store.step(job.id, managedStep(job, "estimate"));
  if (!approved?.body || !quote?.body)
    throw new ProviderError("waiting", "The earlier submission needs confirmation. Check SurfacedBy before starting another run.", true);
  const request = submission.parse(JSON.parse(approved.body));
  const estimate = quoteSchema(managedOperation(job)).parse(JSON.parse(quote.body));
  if (request.request_key !== job.id || request.estimate_id !== estimate.id)
    throw new ProviderError("invalid_response", "The saved approval does not match this request. Check SurfacedBy before continuing.", true);
  const path = contracts[managedOperation(job)].collection;
  const page = recoveryPage.safeParse(await runner.providers.console(path + "?request_key=" + encodeURIComponent(job.id) + "&page_size=1", undefined, undefined, signal));
  if (!page.success)
    throw new ProviderError("invalid_response", "SurfacedBy did not confirm the earlier run. Resume later to check again; no new work was submitted.", true);
  const remote = page.data.data[0];
  if (!remote)
    throw new ProviderError("waiting", "The earlier submission is not confirmed yet. Resume later to check again; no replacement will be submitted.", true);
  if (remote.request_key !== request.request_key || remote.estimate_id !== request.estimate_id || remote.approved_credits !== request.approved_credits)
    throw new ProviderError("invalid_response", "The returned run does not match its saved approval. Check SurfacedBy before continuing.", true);
  recordReceipt(runner, job, remote, { estimated: estimate.estimated_credits, approved: request.approved_credits });
  runner.store.setStep(job.id, managedStep(job, "job"), "done", managedJob.parse(remote));
}

export async function cancelConsoleManaged(runner: Runner, job: Job) {
  let saved = runner.store.step(job.id, managedStep(job, "job"));
  if (!saved) return false;
  if (saved.state !== "done") {
    try {
      await recoverSubmission(runner, job, AbortSignal.timeout(20000));
      saved = runner.store.step(job.id, managedStep(job, "job"));
    } catch {
      runner.store.updateJob(job.id, { error: "cancel_remote", progress: "Stopped locally. Submission was not confirmed. Retry cancellation before starting another run." });
      return true;
    }
    if (saved?.state !== "done") return false;
  }
  const remote = managedJob.parse(JSON.parse(saved.body!));
  try {
    const cancelled = managedJob.parse((await runner.providers.console(contracts[managedOperation(job)].collection + "/" + remote.id + "/cancel", {}, job.id + ":cancel", AbortSignal.timeout(20000))).data);
    if (cancelled.id !== remote.id) throw new Error("Unrelated cancellation receipt");
    recordReceipt(runner, job, cancelled, { estimated: remote.estimated_credits, approved: remote.approved_credits });
    runner.store.updateJob(job.id, { error: cancelled.receipt ? null : "cancel_remote", progress: cancelled.receipt
      ? "Cancelled. Completed work is charged and unused credits returned."
      : "Cancellation requested. Waiting for the final charge. Retry cancellation to check again." });
  } catch {
    runner.store.updateJob(job.id, { error: "cancel_remote", progress: "Stopped locally. Cancellation was not confirmed. Check SurfacedBy before starting another run." });
  }
  return true;
}

/** A quote freezes inputs; every interface uses the same approval and recovery path. */
export async function consoleManaged<I, O extends { job: z.infer<typeof managedJob> }>(
  runner: Runner, job: Job, project: Project, signal: AbortSignal,
  prepareInput: () => I | Promise<I>, resultSchema: z.ZodType<O>,
) {
  const operation = managedOperation(job), contract = contracts[operation], step = (name: string) => managedStep(job, name);
  await recoverSubmission(runner, job, signal);
  const submitted = runner.store.step(job.id, step("job"))?.state === "done";
  const savedCapability = runner.store.step(job.id, step("capabilities"));
  const capability = submitted
    ? savedCapability?.body ? consoleCapabilities(JSON.parse(savedCapability.body)) : null
    : consoleCapabilities((await runner.providers.console("/capabilities", undefined, undefined, signal)).data);
  if (!submitted && (!capability?.operations.includes(operation) || operation === "content" && !capability.content_available))
    throw new ProviderError("capability", "SurfacedBy cannot provide " + contract.label + " on this connection right now. Choose ChatGPT or OpenRouter, or try again later.");
  if (!submitted) runner.store.setStep(job.id, step("capabilities"), "done", capability);
  const domain = await runner.once(job, "console-domain", async () => {
    const domains = await runner.consolePages("/domains", signal);
    return domains.find(row => row.domain === project.domain) ??
      (await runner.providers.console("/domains", { domain: project.domain }, job.id + ":domain", signal)).data;
  });
  const domainId = z.string().uuid().parse(domain.id);
  const input: I = await runner.once(job, step("input"), async () => prepareInput());
  const quote = quoteSchema(operation).parse(await runner.once(job, step("estimate"), async () =>
    quoteSchema(operation).parse((await runner.providers.console(contract.quote(domainId), input, job.id + ":estimate", signal)).data)));
  if (quote.domain_id !== domainId)
    throw new ProviderError("invalid_response", "The estimate does not belong to this website. No work was submitted.");
  if (!submitted) {
    if (Date.parse(quote.expires_at) <= Date.now())
      throw new ProviderError("estimate_expired", "This estimate has expired. Start a new run for a current price; no work was submitted.");
    if (!quote.estimated_credits || creditUsd(quote.estimated_credits) > job.maxCostUsd + 1e-9)
      throw new ProviderError("budget", "Estimated maximum: $" + creditUsd(quote.estimated_credits).toFixed(2) + ". Increase your approved maximum or choose another connection.");
    const recurringCeiling = scheduledBudgetCeiling(runner.store, job);
    if (recurringCeiling !== undefined) {
      if (creditUsd(quote.estimated_credits) > recurringCeiling + 1e-9)
        throw new ProviderError("budget", "This run exceeds the remaining schedule allowance. No work was submitted.");
      runner.store.setStep(job.id, step("approval"), "done", quote.id);
    }
    if (runner.store.step(job.id, step("approval"))?.body !== JSON.stringify(quote.id))
      throw new ProviderError("approval", "Estimated maximum: $" + creditUsd(quote.estimated_credits).toFixed(2) + ". Approve to start. Completed work is charged and unused credits returned.");
  }
  const approvedCredits = Math.floor(job.maxCostUsd * 10 + 1e-9);
  const savedSubmission = runner.store.step(job.id, step("submission"));
  const request = submission.parse(savedSubmission?.body ? JSON.parse(savedSubmission.body) : {
    estimate_id: quote.id, request_key: job.id, approved_credits: approvedCredits });
  if (request.estimate_id !== quote.id || request.request_key !== job.id || request.approved_credits > approvedCredits)
    throw new ProviderError("invalid_response", "The saved approval does not match this budget. No new request was submitted.");
  if (!savedSubmission) runner.store.setStep(job.id, step("submission"), "done", request);
  let remote = managedJob.parse(await runner.once(job, step("job"), async () =>
    managedJob.parse((await runner.providers.console(contract.reserve, request, job.id, signal)).data)));
  const remoteId = remote.id, expected = { estimated: quote.estimated_credits, approved: request.approved_credits };
  recordReceipt(runner, job, remote, expected);
  for (let attempt = 0; attempt < 180; attempt++) {
    signal.throwIfAborted();
    remote = managedJob.parse((await runner.providers.console(contract.collection + "/" + remoteId, undefined, undefined, signal)).data);
    if (remote.id !== remoteId)
      throw new ProviderError("invalid_response", "The returned run does not match this request. Check SurfacedBy before continuing.");
    recordReceipt(runner, job, remote, expected);
    if (remote.receipt) break;
    if (remote.status === "waiting_reconciliation")
      throw new ProviderError("waiting", "Your run is awaiting charge confirmation. Resume later to collect it; no replacement will be submitted.");
    runner.store.updateJob(job.id, { progress: remote.cancel_requested ? "Waiting for cancellation confirmation" : remote.progress || "Preparing your " + contract.label });
    await delay(5000, undefined, { signal });
  }
  if (!remote.receipt) throw new ProviderError("waiting", "Your run is still being prepared. Resume later to collect it.");
  if (remote.receipt.status !== "completed")
    throw new ProviderError("provider", "This run did not complete. Its final charge is saved. Review it in SurfacedBy.");
  const parsed = resultSchema.safeParse((await runner.providers.console(contract.result + "/" + remoteId + "/results", undefined, undefined, signal)).data);
  if (!parsed.success)
    throw new ProviderError("invalid_response", "SurfacedBy returned an incomplete result. Resume to check this saved run again; no replacement will be submitted.");
  const output = parsed.data;
  if (output.job.id !== remoteId || output.job.receipt?.status !== "completed")
    throw new ProviderError("invalid_response", "SurfacedBy did not return a completed result. The saved request will not be submitted again.");
  recordReceipt(runner, job, output.job, expected);
  return { output, input, capability };
}
