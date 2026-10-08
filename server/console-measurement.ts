import { randomUUID } from "node:crypto";
import { z } from "zod";
import { presence, comparisonKey, summarize } from "./analysis.js";
import { ProviderError, type Job, type Project, type Observation } from "./contracts.js";
import { publicUrl } from "./network.js";
import { managedJob, consoleManaged, managedStep, validateManagedResult } from "./console-managed.js";
import type { Runner } from "./workflows.js";

const resultSchema = z.object({ job: managedJob, profile: z.literal("selected_questions"),
  requested_answers: z.number().int().min(1).max(100), locale: z.string().max(40), platform: z.enum(["chatgpt", "gemini"]),
  observations: z.array(z.object({ id: z.string().uuid(), question: z.string().min(3).max(500),
    status: z.enum(["collected", "missing_observation"]), platform: z.enum(["chatgpt", "gemini"]), locale: z.string().max(40),
    country: z.string().regex(/^[A-Z]{2}$/).nullable(), surface: z.literal("consumer_interface"),
    answer: z.string().max(100000).nullable(), model: z.string().max(500).nullable(), observed_at: z.string().datetime({ offset: true }),
    citations: z.array(z.object({ url: z.string().max(2048).refine(value => { try { publicUrl(value); return true; } catch { return false; } }),
      title: z.string().max(1000).nullable().optional() })).max(100) })).max(100) });
type Input = { questions: { id: string; question: string }[]; platform: string; locale: string; country: string | null };

/** An answer keeps its measured surface and date; failed checks never count as absent mentions. */
function save(runner: Runner, job: Job, project: Project, input: Input, output: z.infer<typeof resultSchema>) {
  const invalid = () => new ProviderError("invalid_response", "These answers do not match your approved questions. Resume to check the same run; no replacement will be purchased.");
  if (output.requested_answers !== input.questions.length || output.platform !== input.platform || output.locale !== input.locale ||
      new Set(output.observations.map(row => row.id)).size !== output.observations.length ||
      output.job.status === "completed" && output.observations.length !== input.questions.length) throw invalid();
  const observations: Observation[] = [];
  for (const row of output.observations) {
    if (input.questions.find(question => question.id === row.id)?.question !== row.question || row.platform !== input.platform ||
        row.locale !== input.locale || row.country !== input.country ||
        (row.status === "collected" ? !row.answer?.trim() : row.answer !== null || row.citations.length > 0)) throw invalid();
    if (row.status === "missing_observation") continue;
    const citations = row.citations.map(source => ({ url: source.url, title: source.title ?? undefined }));
    observations.push({ id: row.id, projectId: project.id, jobId: job.id, provider: "console",
      prompt: row.question, answer: row.answer!, citations, platform: job.platform, model: row.model || "not-disclosed",
      locale: row.locale, surface: row.surface, observedAt: row.observed_at,
      ...presence(project, row.answer!, citations.map(source => source.url)), costUsd: null });
  }
  const result = { metrics: summarize(observations, input.questions.length),
    comparisonKey: comparisonKey(project, job, observations), profile: "selected_questions", terminalStatus: output.job.status,
    collectionCompletedAt: observations.map(row => row.observedAt).sort().at(-1) };
  runner.store.db.transaction(() => {
    for (const observation of observations) runner.store.put("observation", project.id, job.id, observation);
    runner.store.updateJob(job.id, { requestedAnswers: input.questions.length, result });
    runner.store.setStep(job.id, "console-measurement-result", "done", result);
  })();
  return result;
}

export async function consoleMeasurement(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  const saved = runner.store.step(job.id, "console-measurement-result");
  if (saved?.state === "done") {
    const result = JSON.parse(saved.body!);
    if (result.terminalStatus !== "completed")
      throw new ProviderError("provider", "This check did not finish. Collected answers and its final charge are saved.");
    return result;
  }
  const { output, input } = await consoleManaged(runner, job, project, signal, async () => {
    if (project.prompts.length > 100 || project.prompts.some(question => question.length > 500))
      throw new ProviderError("evidence", "This connection supports up to 100 questions of 500 characters each per selected-question check.");
    const domain = JSON.parse(runner.store.step(job.id, "console-domain")!.body!);
    await runner.once(job, "console-brand", () => runner.providers.console("/domains/" + domain.id + "/brand",
      { brand_name: project.brand, aliases: project.aliases, country: new Intl.Locale(project.locale).region }, job.id + ":brand", signal, "PATCH"));
    return { questions: project.prompts.map(question => ({ id: randomUUID(), question })),
      platform: job.platform === "chat_gpt" ? "chatgpt" : job.platform, locale: project.locale,
      country: new Intl.Locale(project.locale).region ?? null };
  }, resultSchema, true);
  const result = save(runner, job, project, input, output);
  if (output.job.status !== "completed")
    throw new ProviderError("provider", "This check did not finish. Collected answers and its final charge are saved.");
  return result;
}

/** Cancellation may finish after the local worker stops; collecting is a free read of the original job. */
export async function collectCancelledMeasurement(runner: Runner, job: Job, project: Project) {
  const remote = runner.store.step(job.id, managedStep(job, "job")), input = runner.store.step(job.id, managedStep(job, "input"));
  if (remote?.state !== "done" || !input?.body || runner.store.job(job.id).error === "cancel_remote") return;
  const confirmed = managedJob.parse(JSON.parse(remote.body!)), id = confirmed.id;
  const output = resultSchema.parse((await runner.providers.console("/measurement/jobs/" + id + "/results", undefined,
    undefined, AbortSignal.timeout(20000))).data);
  validateManagedResult(confirmed, output.job);
  save(runner, job, project, JSON.parse(input.body), output);
}
