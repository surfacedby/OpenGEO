import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withoutEvidenceList } from './finding-text.js';
import { Store } from "./storage.js";
import { Providers, safeCitations } from "./providers.js";
import { crawl, auditFindings } from "./audit.js";
import { renderedFetch } from "./render.js";
import { crawlFetch } from "./network.js";
import { scheduledBudgetCeiling } from "./scheduler.js";
import { completedMeasurement } from "./portable-results.js";
import { evidenceBatches, contentSources } from "./evidence-context.js";
import {
  presence,
  summarize,
  comparisonKey,
} from "./analysis.js";
import { prompts } from "./prompts.js";
import { discoverQuestions, discoverCompetitors } from "./discovery.js";
import { consoleContent } from "./console-content.js";
import { consoleCompetitors } from "./console-competitors.js";
import { consoleOpportunities } from "./console-opportunities.js";
import { consoleMeasurement, collectCancelledMeasurement } from "./console-measurement.js";
import { consoleCapabilities } from "./console-capabilities.js";
import { cancelConsoleManaged, managedStep } from "./console-managed.js";
import {
  ProviderError,
  contentTask,
  opportunityDetails,
  type Job,
  type Project,
  type Observation,
  type Model,
} from "./contracts.js";
const factsSchema = z.object({
  facts: z.array(
    z.object({ claim: z.string(), evidenceIds: z.array(z.string()).min(1) }),
  ),
  unknowns: z.array(z.string()),
});
const reviewSchema = z.object({
  issues: z.array(
    z.object({
      claim: z.string(),
      reason: z.string(),
      evidenceIds: z.array(z.string()),
    }),
  ),
  requiresHumanReview: z.boolean(),
});
const diagnosisSchema = z
  .object({
    recommendations: z.array(
      z
        .object({
          title: z.string().min(1).max(200),
          description: z.string().min(1).max(3000),
          priority: z.enum(["high", "medium", "low"]),
          targetPageId: z.string(),
          evidenceIds: z.array(z.string()).min(1),
          steps: z.array(z.string().min(1).max(2000)).min(1),
          opportunity: opportunityDetails.optional(),
        })
        .strict(),
    ),
    uncertainties: z.array(z.string()),
  })
  .strict();
export function parseJson(text: string) {
  return JSON.parse(
    text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
  );
}
/** Related changes to one page share a task while retaining distinct instructions and supporting evidence. */
export function mergePageTasks<T extends { targetPageId: string; title: string; priority: 'high' | 'medium' | 'low'; evidenceIds: string[]; steps: string[]; opportunity?: { type: string } }>(recommendations: T[]) {
  const tasks = new Map<string, T>();
  const normalized = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const priorities = { high: 0, medium: 1, low: 2 };
  for (const recommendation of recommendations) {
    const key = JSON.stringify([recommendation.targetPageId, normalized(recommendation.title), recommendation.opportunity?.type]);
    const prior = tasks.get(key);
    if (!prior) { tasks.set(key, { ...recommendation }); continue; }
    const steps = new Map(prior.steps.map(step => [normalized(step), step]));
    for (const step of recommendation.steps) if (!steps.has(normalized(step))) steps.set(normalized(step), step);
    tasks.set(key, { ...prior, priority: priorities[recommendation.priority] < priorities[prior.priority] ? recommendation.priority : prior.priority,
      evidenceIds: [...new Set([...prior.evidenceIds, ...recommendation.evidenceIds])], steps: [...steps.values()] });
  }
  return [...tasks.values()];
}
export class Runner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active:
    { id: string; abort: AbortController; done: Promise<void> } | undefined;
  constructor(
    readonly store: Store,
    readonly providers: Providers,
  ) {
    for (const job of store.jobs()) {
      if (!["measure", "recheck"].includes(job.kind) || !["chatgpt", "openrouter"].includes(job.provider ?? "")) continue;
      const snapshot = store.step(job.id, "project");
      if (!snapshot?.body) continue;
      const project: Project = JSON.parse(snapshot.body);
      if (project.prompts.length && project.prompts.every((_, index) => store.step(job.id, "measure:" + index)?.state === "done"))
        this.checkpointApiMeasurement(job, project);
    }
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.active?.abort.abort();
    return this.active?.done ?? Promise.resolve();
  }
  async cancel(id: string) {
    const job = this.store.job(id);
    if (["completed", "failed"].includes(job.status) || (job.status === "cancelled" && job.error !== "cancel_remote")) return job;
    this.store.updateJob(id, {
      status: "cancelled",
      progress: "Cancelled. Completed provider calls may still be billable.",
    });
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active.done;
    }
    if (job.provider === 'console') {
      if (await cancelConsoleManaged(this, job)) {
        if (["measure", "recheck"].includes(job.kind)) {
          try {
            const snapshot = this.store.step(job.id, "project");
            await collectCancelledMeasurement(this, job, snapshot?.body ? JSON.parse(snapshot.body) : this.store.project(job.projectId));
          }
          catch { this.store.updateJob(id, { error: "cancel_remote", progress: "Cancelled. Resume cancellation later to collect the saved answers." }); }
        }
        return this.store.job(id);
      }
      const saved = this.store.step(id, 'console-scan');
      if (saved?.state === 'done') {
        const scan = JSON.parse(saved.body!);
        try {
          const result = await this.providers.console('/scans/' + scan.scan_id + '/cancel', {}, id + ':cancel', AbortSignal.timeout(20000));
          const refund = result.data?.refunded_credits;
          if (typeof refund !== 'number' || !Number.isFinite(refund) || refund < 0)
            throw new Error('Invalid cancellation receipt');
          this.store.updateJob(id, {
            error: null,
            spentUsd: Math.max(0, this.store.job(id).spentUsd - refund * 0.1),
            progress: refund > 0 ? 'Cancelled on SurfacedBy. Unused credits were returned.' : 'Cancelled on SurfacedBy. Work already started remains billable.',
            result: { cancellation: { refundedCredits: refund, priorStatus: result.data.prior_status } },
          });
        } catch {
          this.store.updateJob(id, { error: 'cancel_remote', progress: 'Stopped locally. Cancellation was not confirmed. Check SurfacedBy Console before starting another check.' });
        }
      } else if (saved?.state === 'started') {
        this.store.updateJob(id, { error: 'cancel_remote', progress: 'Stopped locally. Submission was not confirmed. Review SurfacedBy Console for a running check and any charge.' });
      }
    }
    return this.store.job(id);
  }
  resumePreview(id: string) {
    const job = this.store.job(id);
    const uncertain = this.store.db.prepare("SELECT COUNT(*) AS count FROM steps WHERE job_id=? AND state='started'").get(id) as { count: number };
    return { maxCostUsd: job.maxCostUsd, spentUsd: job.spentUsd, uncertainRequests: uncertain.count, provider: job.provider, reason: job.error, scheduledBudgetCeilingUsd: scheduledBudgetCeiling(this.store, job) };
  }
  resume(id: string, reviewed: boolean, maxCostUsd?: number) {
    const job = this.store.job(id);
    if (job.status !== "paused") throw new Error("Only paused jobs can resume");
    if (this.resumePreview(id).uncertainRequests && !reviewed)
      throw new ProviderError("review", "Review uncertain provider requests before resuming.");
    if (job.error === "approval" && !reviewed)
      throw new ProviderError("review", "Approve the displayed estimate before starting paid work.");
    if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd < Math.max(job.maxCostUsd, job.spentUsd) || maxCostUsd > 10000))
      throw new ProviderError("budget", "The new budget must cover the current ceiling and completed work.");
    return this.store.db.transaction(() => {
    const scheduledCeiling = scheduledBudgetCeiling(this.store, job);
    if (scheduledCeiling !== undefined && Math.max(maxCostUsd ?? job.maxCostUsd, job.spentUsd) > scheduledCeiling + 1e-9)
      throw new ProviderError("budget", "This run would exceed its approved monthly schedule budget. Keep it paused or start a separately approved manual run.");
    for (const row of this.store.db
      .prepare("SELECT step FROM steps WHERE job_id=? AND state='started'")
      .all(id) as any[])
      this.store.setStep(id, row.step, "approved-retry");
    if (job.error === "approval") {
      const quote = this.store.step(id, managedStep(job, "estimate"));
      if (quote?.state !== "done") throw new ProviderError("estimate", "A current estimate is required.");
      this.store.setStep(id, managedStep(job, "approval"), "done", JSON.parse(quote.body!).id);
    }
    return this.store.updateJob(id, {
      status: "queued",
      error: null,
      progress: "Waiting to resume",
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    });
    })();
  }
  async tick() {
    if (this.active) return;
    const job = this.store
      .jobs()
      .reverse()
      .find((j) => j.status === "queued");
    if (!job) return;
    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active = { id: job.id, abort, done };
    this.store.updateJob(job.id, { status: "running", progress: "Starting" });
    try {
      const saved = this.store.step(job.id, "project");
      const project: Project = saved?.body
        ? JSON.parse(saved.body)
        : this.store.project(job.projectId);
      if (!saved) this.store.setStep(job.id, "project", "done", project);
      if (["measure", "recheck"].includes(job.kind) && job.requestedAnswers === undefined)
        this.store.updateJob(job.id, { requestedAnswers: project.prompts.length });
      const result = await this.execute(job, project, abort.signal);
      if (this.store.job(job.id).status !== "cancelled")
        this.store.updateJob(job.id, {
          status: "completed",
          progress: "Complete",
          result,
        });
    } catch (e) {
      if (this.store.job(job.id).status !== "cancelled") {
        const error = e instanceof ProviderError ? e.code : "workflow";
        this.store.updateJob(job.id, {
          status: e instanceof ProviderError ? "paused" : "failed",
          error,
          progress:
            e instanceof ProviderError
              ? e.message
              : "The workflow could not complete. Review saved evidence and retry after resolving the issue.",
        });
      }
    } finally {
      this.active = undefined;
      resolveDone();
    }
  }
  async once<T>(job: Job, name: string, fn: () => Promise<T>, beforeStart?: () => void): Promise<T> {
    const prior = this.store.step(job.id, name);
    if (prior?.state === "done") return JSON.parse(prior.body!) as T;
    if (prior?.state === "started")
      throw new ProviderError(
        "interrupted",
        "An earlier provider request has uncertain completion. Review usage before resuming.",
        true,
      );
    beforeStart?.();
    this.store.setStep(job.id, name, "started");
    try {
      const value = await fn();
      this.store.setStep(job.id, name, "done", value);
      return value;
    } catch (error) {
      if (error instanceof ProviderError) {
        if (!error.uncertain && this.store.step(job.id, name)?.state !== 'done') this.store.setStep(job.id, name, 'rejected');
        throw error;
      }
      throw new ProviderError('interrupted', 'The request ended with uncertain completion. Review provider usage before resuming.', true);
    }
  }
  async execute(
    job: Job,
    project: Project,
    signal: AbortSignal,
  ): Promise<unknown> {
    const update = (progress: string) =>
      this.store.updateJob(job.id, { progress });
    if (job.kind === "discover") return discoverQuestions(this, job, project, signal);
    if (job.kind === "competitors") {
      if (!["chatgpt", "openrouter", "console"].includes(job.provider ?? "")) throw new ProviderError("capability", "Choose a connected analysis provider to review saved answers.");
      const measurement = this.store.job(job.measurementJobId!);
      if (measurement.projectId !== project.id || !completedMeasurement(measurement) || !this.store.observations(project.id, measurement.id).length)
        throw new ProviderError("evidence", "Choose a completed visibility check from this website.");
      if (job.provider === "console") return consoleCompetitors(this, job, project, signal);
      const model = await this.contentModel(job);
      const websites = await discoverCompetitors(this, job, project, model, signal, measurement.id);
      return { measurementJobId: measurement.id, competitors: websites.filter(site => site.role !== 'reference'), references: websites.filter(site => ['reference', 'both'].includes(site.role ?? '')) };
    }
    if (job.kind === "audit") {
      const coverage = await crawl(
        project.domain,
        signal,
        (p) => this.store.put("page", project.id, job.id, p),
        update,
        job.render ? renderedFetch : undefined,
        job.maxPages ?? 100,
        crawlFetch,
      );
      const pages = this.store.pages(project.id, job.id);
      for (const f of auditFindings(project, job.id, pages))
        this.store.put("finding", project.id, job.id, f);
      return {
        pages: pages.length,
        coverage,
        findings: this.store
          .findings(project.id)
          .filter((f) => f.jobId === job.id).length,
      };
    }
    if (job.kind === "measure" || job.kind === "recheck") {
      if (!project.prompts.length) throw new Error("Add at least one prompt");
      if (job.provider === "console")
        return this.consoleMeasure(job, project, signal);
      if (job.provider === "chatgpt" || job.provider === "openrouter")
        return this.apiMeasure(job, project, signal);
      if (job.provider !== "dataforseo")
        throw new ProviderError(
          "capability",
          "Select DataForSEO or SurfacedBy to collect visibility evidence.",
        );
      const models = await this.providers.models("dataforseo", job.platform);
      const model = job.model ?? models[0]?.id;
      if (!model || !models.some((m) => m.id === model))
        throw new ProviderError(
          "capability",
          "Select an available measurement model.",
        );
      this.store.updateJob(job.id, { model });
      for (let i = 0; i < project.prompts.length; i++) {
        signal.throwIfAborted();
        if (this.store.step(job.id, "measure:" + i)?.state === "done") continue;
        const live = this.store.job(job.id);
        const estimate = this.store.setting<number>(
          "measurementRequestEstimateUsd",
          0,
        );
        if (estimate <= 0)
          throw new ProviderError(
            "estimate",
            "Set a conservative measurement request estimate in Settings before paid measurements. DataForSEO does not expose a per-request dollar ceiling.",
          );
        if (live.spentUsd + estimate > job.maxCostUsd)
          throw new ProviderError(
            "budget",
            "The approved measurement budget is insufficient for the next request.",
          );
        update(
          "Collecting answer " + (i + 1) + " of " + project.prompts.length,
        );
        await this.once(job, "measure:" + i, async () => {
          const result = await this.providers.measure(
            job.platform,
            model,
            project.prompts[i],
            project.locale,
            signal,
          );
          const observation: Observation = {
            id: randomUUID(),
            projectId: project.id,
            jobId: job.id,
            prompt: project.prompts[i],
            provider: "dataforseo",
            platform: job.platform,
            model: result.model,
            locale: project.locale,
            observedAt: new Date().toISOString(),
            answer: result.text,
            citations: result.citations,
            surface: "api",
            ...presence(
              project,
              result.text,
              result.citations.map((c) => c.url),
            ),
            costUsd: result.costUsd,
          };
          this.store.db.transaction(() => {
            this.store.put("observation", project.id, job.id, observation);
            this.store.updateJob(job.id, {
              spentUsd:
                this.store.job(job.id).spentUsd + (result.costUsd ?? estimate),
              costBasis: result.costUsd === null ? 'includes_estimates' : this.store.job(job.id).costBasis ?? 'reported',
            });
            this.store.setStep(job.id, "measure:" + i, "done", observation);
          })();
          return observation;
        });
        if (this.store.job(job.id).spentUsd > job.maxCostUsd)
          throw new ProviderError(
            "budget",
            "Provider cost exceeded the estimate. Further requests have stopped.",
          );
      }
      const observations = this.store.observations(project.id, job.id);
      return {
        metrics: summarize(observations, project.prompts.length),
        comparisonKey: comparisonKey(
          project,
          this.store.job(job.id),
          observations,
        ),
      };
    }
    if (job.kind === "diagnose") {
      const completed = this.store.step(job.id, "diagnosis-result");
      if (completed?.state === "done") return JSON.parse(completed.body!);
      if (job.provider === "console") return consoleOpportunities(this, job, project, signal);
      if (job.provider === "chatgpt" || job.provider === "openrouter") {
        const model = await this.contentModel(job);
        const priorEvidence = this.store.step(job.id, "diagnosis-inputs");
        let evidence;
        if (priorEvidence?.body) evidence = JSON.parse(priorEvidence.body);
        else {
          const latest = this.store.jobs(project.id).find(completedMeasurement);
          if (!latest) throw new ProviderError("evidence", "Collect visibility evidence first.");
          const audit = this.store.jobs(project.id).find(item => item.kind === "audit" && item.status === "completed");
          const pages = audit ? this.store.pages(project.id, audit.id) : [];
          if (!pages.length) throw new ProviderError("evidence", "Complete a local audit to link recommendations to existing pages.");
          const home = pages.find(page => page.status >= 200 && page.status < 300 && new URL(page.url).pathname === '/');
          const shared = { brand: project.brand, aliases: project.aliases, locale: project.locale, businessNotes: project.knowledge.slice(0, 4000),
            siteOverview: home ? { id: home.id, url: home.url, title: home.title, headings: home.h1, text: home.text.slice(0, 3500) } : null,
            observations: this.store.observations(project.id, latest.id).map(answer => ({ ...answer, answer: answer.answer.slice(0, 6000) })) };
          // Website context holds about one page excerpt per question, and at most a third of the room left beside the answers and the page catalog that new-topic review
          // also carries, so page batches and that review keep the rest.
          const catalog = pages.map(page => ({ id: page.id, url: page.url, title: page.title.slice(0, 500) }));
          const instructions = Math.max(Buffer.byteLength(prompts.diagnose, "utf8"), Buffer.byteLength(prompts.contentGaps, "utf8"));
          const available = model.contextLength - 7000 - instructions - Buffer.byteLength(JSON.stringify([shared, catalog]), "utf8");
          // The homepage already travels as the site overview, so the website context spends its room on other pages.
          const website = contentSources(pages.filter(page => new URL(page.url).pathname !== "/"), project.prompts, Math.min(Math.max(12000, 2100 * project.prompts.length), Math.max(0, Math.floor(available / 3))), [], 2000);
          evidence = {
            version: 2,
            context: { ...shared, website },
            sources: pages.map(page => ({ id: page.id, url: page.url, title: page.title.slice(0, 500), h1: page.h1.slice(0, 5).map(heading => heading.slice(0, 500)), text: page.text.slice(0, 8000) })),
            measurementJobId: latest.id,
          };
        }
        if (!priorEvidence) this.store.setStep(job.id, "diagnosis-inputs", "done", evidence);
        const context: { brand: string; aliases: string[]; locale: string; observations: Observation[] } = evidence.context;
        const sources: { id: string; url: string; title: string; h1: string[]; text: string }[] = evidence.sources;
        const room = model.contextLength - 7000 - Buffer.byteLength(JSON.stringify(context) + prompts.diagnose, "utf8");
        const maximumBytes = evidence.version === 2 ? Math.min(40000, Math.floor(room / 2)) : Math.min(65000, room);
        const legacy = this.store.step(job.id, "diagnose");
        const savedPlan = this.store.step(job.id, "diagnosis-batches");
        const batches: typeof sources[] = savedPlan?.body ? JSON.parse(savedPlan.body) : legacy ? [sources] : evidenceBatches(sources, maximumBytes);
        if (!savedPlan) this.store.setStep(job.id, "diagnosis-batches", "done", batches);
        const result: z.infer<typeof diagnosisSchema> = { recommendations: [], uncertainties: [] };
        for (const [index, batch] of batches.entries()) {
          const reviewed = await this.structuredPass(diagnosisSchema, job, model, "diagnose", {
            ...context, pages: batch, coverage: { pagesAvailable: sources.length, pagesInThisBatch: batch.length, excerpts: true },
          }, signal, legacy ? "diagnose" : "diagnose:" + index,
          "Preparing recommendations (" + (index + 1) + " of " + batches.length + ")");
          const contextPages = evidence.version === 2 ? (evidence.context.website as ReturnType<typeof contentSources>).sources : [];
          const pageIds = new Set([...batch, ...contextPages].map(page => page.id));
          if (evidence.version === 2 && evidence.context.siteOverview?.id) pageIds.add(evidence.context.siteOverview.id);
          if (reviewed.recommendations.some(recommendation => !pageIds.has(recommendation.targetPageId)))
            this.rejectResponse(job, [legacy ? "diagnose" : "diagnose:" + index], "Analysis referenced a page outside its reviewed evidence.");
          if (evidence.version === 2 && reviewed.recommendations.length) {
            const review = await this.structuredPass(z.object({ accepted: z.array(z.object({
              index: z.number().int().nonnegative(), title: z.string().min(1).max(200),
              description: z.string().min(1).max(3000), steps: z.array(z.string().min(1).max(2000)).min(1),
              opportunity: opportunityDetails,
              // Reviewers often repeat the candidate's target and evidence; they are read from the candidate, never from the review.
              targetPageId: z.string().optional(), evidenceIds: z.array(z.string()).optional(),
            }).strict()) }).strict(), job, model, 'opportunityReview', {
              ...context, pages: [...new Map([...batch, ...sources.filter(page => reviewed.recommendations.some(candidate => candidate.targetPageId === page.id))].map(page => [page.id, page])).values()], candidates: reviewed.recommendations.map((candidate, index) => ({ ...candidate, index })),
            }, signal, 'opportunity-review:' + index, 'Checking which improvements are useful');
            const seen = new Set<number>();
            for (const accepted of review.accepted) {
              const candidate = reviewed.recommendations[accepted.index];
              if (!candidate || seen.has(accepted.index) || accepted.opportunity.type === 'new_content' ||
                (accepted.targetPageId !== undefined && accepted.targetPageId !== candidate.targetPageId) ||
                (accepted.evidenceIds !== undefined && JSON.stringify([...accepted.evidenceIds].sort()) !== JSON.stringify([...candidate.evidenceIds].sort())))
                this.rejectResponse(job, ['opportunity-review:' + index], 'The review referenced an unknown, repeated or changed improvement.');
              seen.add(accepted.index);
              const { index: candidateIndex, targetPageId, evidenceIds, ...wording } = accepted;
              result.recommendations.push({ ...candidate, ...wording });
            }
          } else result.recommendations.push(...reviewed.recommendations);
          result.uncertainties.push(...reviewed.uncertainties);
        }
        if (evidence.version === 2) {
          const { website: suppliedWebsite, ...gapContext } = evidence.context;
          const website = suppliedWebsite as ReturnType<typeof contentSources>;
          const catalog = sources.map(page => ({ id: page.id, url: page.url, title: page.title }));
          const gaps = await this.structuredPass(diagnosisSchema, job, model, 'contentGaps', {
            ...gapContext, pages: website.sources, coverage: website.coverage, catalog,
            existingImprovements: result.recommendations.map(item => ({ title: item.title, targetPageId: item.targetPageId })),
          }, signal, 'content-gaps', 'Finding new topics from your saved answers');
          // The homepage travels as the site overview, so it is supplied context alongside the website pages.
          const supplied = new Set([...website.sources.map(page => page.id), ...(evidence.context.siteOverview?.id ? [evidence.context.siteOverview.id] : [])]);
          for (const gap of gaps.recommendations) {
            if (!supplied.has(gap.targetPageId) || gap.opportunity?.type !== 'new_content' || !gap.opportunity.topic ||
              !gap.evidenceIds.some(id => supplied.has(id)) || !gap.evidenceIds.some(id => context.observations.some(answer => answer.id === id)))
              this.rejectResponse(job, ['content-gaps'], 'A new topic needs website context and a supporting saved answer.');
          }
          result.recommendations.push(...gaps.recommendations);
          result.uncertainties.push(...gaps.uncertainties);
        }
        result.uncertainties = [...new Set(result.uncertainties)];
        const allowed = new Set([
          ...sources.map((p) => p.id),
          ...context.observations.map((o) => o.id),
        ]);
        let omittedSuggestions = 0;
        result.recommendations = result.recommendations.filter(recommendation => {
          const page = sources.find((p) => p.id === recommendation.targetPageId);
          if (
            !page || !withoutEvidenceList(recommendation.description, recommendation.evidenceIds).trim() ||
            recommendation.evidenceIds.some((id) => !allowed.has(id)) ||
            (evidence.version === 2 && (!recommendation.evidenceIds.includes(page.id) ||
              !recommendation.evidenceIds.some(id => context.observations.some(answer => answer.id === id))))
          ) { omittedSuggestions++; return false; }
          return true;
        });
        if (omittedSuggestions) result.uncertainties.push(omittedSuggestions + ' suggestions were left out because their supporting evidence could not be verified.');
        result.recommendations = mergePageTasks(result.recommendations);
        if (result.recommendations.length > 1) {
          const candidates = result.recommendations.map((item, index) => ({
            index, title: item.title, summary: item.description.slice(0, 200), type: item.opportunity?.type,
            target: sources.find(page => page.id === item.targetPageId)!.url,
          }));
          const plan = await this.structuredPass(z.object({ groups: z.array(z.object({
            primaryIndex: z.number().int().nonnegative(), indices: z.array(z.number().int().nonnegative()).min(1),
          }).strict()) }).strict(), job, model, 'consolidate', { candidates }, signal);
          const seen = new Set<number>();
          for (const group of plan.groups) {
            if (!group.indices.includes(group.primaryIndex))
              this.rejectResponse(job, ['consolidate'], 'The action plan referenced an unrelated primary task.');
            if (new Set(group.indices.map(index => result.recommendations[index]?.opportunity?.type)).size > 1)
              this.rejectResponse(job, ['consolidate'], 'The action plan combined different kinds of work.');
            for (const index of group.indices) {
              if (!result.recommendations[index] || seen.has(index))
                this.rejectResponse(job, ['consolidate'], 'The action plan repeated or referenced an unknown task.');
              seen.add(index);
            }
          }
          if (seen.size !== result.recommendations.length)
            this.rejectResponse(job, ['consolidate'], 'The action plan omitted a supported task.');
          // Related tasks share a heading while preserving each page's instructions and evidence.
          result.recommendations = plan.groups.flatMap(group => {
            const primary = result.recommendations[group.primaryIndex];
            return [group.primaryIndex, ...group.indices.filter(index => index !== group.primaryIndex)]
              .map(index => ({ ...result.recommendations[index], title: primary.title }));
          });
        }
        result.recommendations = mergePageTasks(result.recommendations);
        const receipt = {
          findings: result.recommendations.length,
          omittedSuggestions,
          uncertainties: result.uncertainties,
          pagesReviewed: sources.length,
          measurementJobId: evidence.measurementJobId,
          model: model.id,
        };
        this.store.db.transaction(() => {
          for (const r of result.recommendations) {
            this.store.put("finding", project.id, job.id, {
              id: randomUUID(),
              projectId: project.id,
              jobId: job.id,
              title: r.title,
              description: withoutEvidenceList(r.description, r.evidenceIds),
              priority: r.priority,
              targetUrl: sources.find((p) => p.id === r.targetPageId)!.url,
              evidenceIds: r.evidenceIds,
              steps: r.steps,
              confidence: "inferred",
              status: "open",
              kind: "analysis",
              ...(r.opportunity ? { opportunity: r.opportunity } : {}),
            });
          }
          this.store.setStep(job.id, "diagnosis-result", "done", receipt);
        })();
        return receipt;
      }
      throw new ProviderError("capability", "Connect ChatGPT or OpenRouter to analyze your collected evidence.");
    }
    if (job.provider === "console")
      return this.consoleJob(job, project, signal);
    const completed = this.store.step(job.id, 'content-result');
    if (completed?.state === 'done') return JSON.parse(completed.body!);
    if (!["chatgpt", "openrouter"].includes(job.provider ?? ""))
      throw new ProviderError(
        "capability",
        "Connect ChatGPT or OpenRouter for content.",
      );
    const { original, task } = this.contentRequest(job, project);
    const model = await this.contentModel(job);
    const latest = this.store
      .jobs(project.id)
      .find((j) => j.kind === "audit" && j.status === "completed");
    const sourceIds = new Set<string>(original?.sourceEvidence?.map((s: any) => s.id) ?? []);
    const managedSources = this.store.artifacts<import("./contracts.js").ManagedSourceEvidence>(project.id, "source");
    const finding = task.findingId ? this.store.findings(project.id).find(row => row.id === task.findingId) : undefined;
    const sourcePages = sourceIds.size ? [...this.store.pages(project.id), ...managedSources].filter(p => sourceIds.has(p.id))
      : [...(latest ? this.store.pages(project.id, latest.id) : []), ...managedSources.filter(source => finding?.evidenceIds.includes(source.id))];
    const topic = original?.topic ?? job.topic ?? project.brand;
    const savedSources = this.store.step(job.id, "content-sources");
    if (!savedSources?.body && !sourcePages.length) throw new Error("Complete a local audit first");
    const sourceBudget = Math.min(65000, Math.floor((model.contextLength - 10000 - Buffer.byteLength(project.knowledge + (original?.markdown ?? "") + JSON.stringify(task), "utf8")) / 2));
    let selected;
    if (savedSources?.body) selected = JSON.parse(savedSources.body);
    else if (original && sourceIds.size) {
      if (sourcePages.length !== sourceIds.size) throw new ProviderError("evidence", "Some original sources are missing. Restore them before revising this draft.");
      const sources = sourcePages.map(page => ({ id: page.id, url: page.url, title: page.title.slice(0, 500), text: page.text.slice(0, 8000) }));
      if (Buffer.byteLength(JSON.stringify(sources), "utf8") > sourceBudget)
        throw new ProviderError("context", "Choose a model with more room to preserve this draft's original sources. No request was sent.");
      selected = { sources, coverage: original.sourceCoverage ?? { pagesAvailable: sources.length, pagesUsed: sources.length, excerpts: true } };
    } else selected = contentSources(sourcePages, topic, sourceBudget, task.targetUrl ? [task.targetUrl] : []);
    if (!savedSources) this.store.setStep(job.id, "content-sources", "done", selected);
    const sources: { id: string; url: string; title: string; text: string }[] = selected.sources;
    const context = {
      topic,
      task,
      brand: project.brand,
      locale: project.locale,
      knowledge: {
        id: "user-knowledge",
        text: project.knowledge,
        provenance: "user-supplied, unverified",
      },
      sources,
      coverage: selected.coverage,
    };
    const allowed = new Set([...sources.map((s) => s.id), ...(project.knowledge.trim() ? ["user-knowledge"] : [])]);
    const call = async (name: keyof typeof prompts, input: unknown) => {
      return this.llmPass(job, model, name, input, signal);
    };
    const research = await this.structuredPass(factsSchema, job, model, "research", context, signal);
    for (const fact of research.facts)
      if (fact.evidenceIds.some((id) => !allowed.has(id)))
        this.rejectResponse(job, ["research"], "The research pass cited unknown evidence.");
    const brief = await call("brief", { topic: context.topic, task, locale: context.locale, research, sourceReferences: sources.map(({ id, url, title }) => ({ id, url, title })) });
    const draft = await call("draft", {
      locale: context.locale,
      task,
      brief,
      research,
      sources,
      knowledge: context.knowledge,
      ...(original ? { previousDraft: original.markdown, revisionInstructions: job.revisionInstructions } : {}),
    });
    const review = await this.structuredPass(reviewSchema, job, model, "verify", { locale: context.locale, task, draft, research, sources }, signal);
    if (
      review.issues.some((issue) =>
        issue.evidenceIds.some((id) => !allowed.has(id)),
      )
    )
      this.rejectResponse(job, ["verify"], "Verification referenced unknown evidence.");
    const markdown = await call("edit", { locale: context.locale, task, draft, review, research, sources, ...(original ? { revisionInstructions: job.revisionInstructions } : {}) });
    const finalReview = await this.structuredPass(reviewSchema, job, model, 'verifyFinal', { locale: context.locale, task, draft: markdown, research, sources }, signal);
    if (finalReview.issues.some((issue) => issue.evidenceIds.some((id) => !allowed.has(id))))
      this.rejectResponse(job, ['verifyFinal'], 'The final review referenced unknown evidence.');
    for (const id of allowed)
      if (markdown.includes(id))
        finalReview.issues.push({ claim: 'Internal reference in the article', reason: 'An internal evidence ID appears in the article. Remove it before publishing.', evidenceIds: [id] });
    const sourceUrls = new Set(sources.map((s) => s.url));
    const unknownLinks = [...markdown.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)]
      .map((m) => m[1])
      .filter((url) => !sourceUrls.has(url));
    if (unknownLinks.length)
      // The final review read this edit, so both are requested again together.
      this.rejectResponse(job, ["edit", "verifyFinal"], "The draft contains links that are not in its source evidence.");
    const doc = {
      id: randomUUID(),
      topic: context.topic,
      task,
      locale: context.locale,
      markdown,
      brief,
      review: finalReview,
      reviewCurrent: true,
      sourceEvidence: sources.map(({ id, url, title }) => ({ id, url, title })),
      sourceCoverage: selected.coverage,
      status: finalReview.issues.length ? 'needs_review' : 'draft',
      requiresHumanReview: true,
      createdAt: new Date().toISOString(),
      model: model.id,
      ...(original ? { derivedFrom: original.id, revisionInstructions: job.revisionInstructions } : {}),
    };
    this.store.db.transaction(() => {
      this.store.put("content", project.id, job.id, doc);
      this.store.setStep(job.id, 'content-result', 'done', doc);
    })();
    return doc;
  }
  /** A revision keeps its original draft and purpose; a new draft keeps the task frozen when it was queued. Every provider reads both from here. */
  contentRequest(job: Job, project: Project) {
    let original: any;
    if (job.kind === 'revise') {
      const snapshot = this.store.step(job.id, 'revision-source');
      original = snapshot?.body ? JSON.parse(snapshot.body) : this.store.artifacts<any>(project.id, 'content').find((doc) => doc.id === job.contentId);
      if (!original) throw new Error('Content not found');
      if (!snapshot) this.store.setStep(job.id, 'revision-source', 'done', original);
    }
    const taskSnapshot = this.store.step(job.id, 'content-task');
    const task = contentTask.parse(original?.task ?? (taskSnapshot?.body ? JSON.parse(taskSnapshot.body) : { mode: 'article' }));
    return { original, task };
  }
  async contentModel(job: Job) {
    const models = await this.providers.models(job.provider!);
    const model =
      models.find((m) => m.id === job.model) ??
      (!job.model ? models[0] : undefined);
    if (!model)
      throw new ProviderError(
        "capability",
        "Select an available model for this workflow.",
      );
    this.store.updateJob(job.id, { model: model.id });
    return model;
  }
  /** API answer checks share durable request receipts and budgets with the other measurement paths. */
  async apiMeasure(job: Job, project: Project, signal: AbortSignal) {
    const model = await this.contentModel(job), provider = job.provider!;
    const instructions = "Answer the user's question independently in locale " + project.locale + ". Cite sources when available. Do not invent citations.";
    const cap = Math.min(4096, model.maxOutputTokens ?? 4096);
    for (let index = 0; index < project.prompts.length; index++) {
      signal.throwIfAborted();
      const name = "measure:" + index;
      if (this.store.step(job.id, name)?.state === "done") continue;
      const prompt = project.prompts[index], tokenUpper = Buffer.byteLength(instructions + prompt, "utf8") + 1000,
        estimate = tokenUpper * model.inputUsd + cap * model.outputUsd;
      this.store.updateJob(job.id, { progress: "Collecting answer " + (index + 1) + " of " + project.prompts.length });
      await this.once(job, name, async () => {
        const completion = await this.providers.complete(provider, model.id, instructions, prompt, signal, cap, provider === "chatgpt" && job.webSearch !== false, model);
        const observation: Observation = {
          id: randomUUID(), projectId: project.id, jobId: job.id, prompt, provider,
          platform: provider === "chatgpt" ? "chat_gpt" : "openrouter", model: completion.model, locale: project.locale,
          observedAt: new Date().toISOString(), answer: completion.text, citations: completion.citations, surface: "api",
          retrieval: provider === "chatgpt" && job.webSearch !== false ? "web_search" : "model_only",
          ...(provider === "chatgpt" ? { webSearchConfirmed: completion.webSearchConfirmed === true } : {}),
          ...presence(project, completion.text, completion.citations.map((citation) => citation.url)), costUsd: completion.costUsd,
        };
        this.store.db.transaction(() => {
          this.store.put("observation", project.id, job.id, observation);
          this.store.updateJob(job.id, { spentUsd: this.store.job(job.id).spentUsd + (completion.costUsd ?? estimate),
            costBasis: completion.costUsd === null ? "includes_estimates" : this.store.job(job.id).costBasis ?? "reported" });
          this.store.setStep(job.id, name, "done", observation);
        })();
        if (completion.costUsd === null) throw new ProviderError("cost_unknown", "The answer is saved. The provider omitted its cost; review usage before continuing.", true);
        if (this.store.job(job.id).spentUsd > job.maxCostUsd) throw new ProviderError("budget", "The answer is saved. Reported cost exceeded the budget; further requests stopped.");
        return observation;
      }, () => {
        if (tokenUpper + cap > model.contextLength) throw new ProviderError("context", "Choose a model with a larger context window.");
        if (this.store.job(job.id).spentUsd + estimate > job.maxCostUsd) throw new ProviderError("budget", "The approved budget is insufficient for the next answer.");
      });
    }
    const collection = this.checkpointApiMeasurement(job, project);
    const competitors = provider === "chatgpt" && job.discoverCompetitors ? await discoverCompetitors(this, job, project, model, signal) : [];
    return { ...collection, competitors: competitors.filter(site => site.role !== 'reference'), references: competitors.filter(site => ['reference', 'both'].includes(site.role ?? '')) };
  }
  /** The answer receipt and its findings commit together, independently of later suggestions. */
  checkpointApiMeasurement(job: Job, project: Project) {
    const prior = this.store.step(job.id, "measurement-result");
    if (prior?.state === "done") return JSON.parse(prior.body!);
    const observations = this.store.observations(project.id, job.id);
    if (observations.length !== project.prompts.length)
      throw new ProviderError("evidence", "The answer collection is incomplete. Saved answers remain available.");
    const result = {
      metrics: summarize(observations, project.prompts.length),
      comparisonKey: comparisonKey(project, this.store.job(job.id), observations),
      collectionCompletedAt: observations.map(answer => answer.observedAt).sort().at(-1),
    };
    this.store.db.transaction(() => {
      this.store.setStep(job.id, "measurement-result", "done", result);
      this.store.updateJob(job.id, { result: { ...(this.store.job(job.id).result as object ?? {}), ...result } });
    })();
    return result;
  }
  /** Each paid pass checkpoints its output and spend together before downstream validation. */
  /** A saved response that breaks an evidence rule is set aside with the steps built on it, so resuming requests it again instead of re-reading it. Every pass artifact stays saved for review. */
  rejectResponse(job: Job, receiptKeys: string[], reason: string): never {
    this.store.db.transaction(() => { for (const key of receiptKeys) this.store.setStep(job.id, key, "rejected"); })();
    throw new ProviderError("evidence", reason + " Resume to request it again.");
  }
  /** Structured output becomes evidence only once it matches its contract. A response that does not is set aside, so resuming requests it again instead of re-reading it. */
  async structuredPass<S extends z.ZodTypeAny>(schema: S, ...pass: Parameters<Runner["llmPass"]>): Promise<z.infer<S>> {
    const [job, , name, , , receiptKey = name] = pass;
    const text = await this.llmPass(...pass);
    let value: unknown;
    try { value = parseJson(text); } catch { /* Text that is not JSON fails the contract below. */ }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data as z.infer<S>;
    this.store.setStep(job.id, receiptKey, "rejected");
    throw new ProviderError("format", "The AI response did not match the expected format. Resume to request it again.");
  }
  async llmPass(
    job: Job,
    model: Model,
    name: keyof typeof prompts,
    input: unknown,
    signal: AbortSignal,
    receiptKey: string = name,
    progressLabel?: string,
  ) {
    const progress: Record<keyof typeof prompts, string> = {
      offerings: 'Understanding what your website offers',
      questions: 'Finding questions your customers might ask',
      questionReview: 'Reviewing questions for relevance and natural wording',
      competitors: 'Identifying competitors in the collected answers',
      research: 'Researching your source material',
      brief: 'Preparing a content brief',
      draft: 'Writing your draft',
      verify: 'Checking factual claims',
      edit: 'Refining your draft',
      verifyFinal: 'Checking the final draft',
      diagnose: 'Preparing recommendations',
      opportunityReview: 'Checking recommendations against your evidence',
      contentGaps: 'Finding useful new content topics',
      consolidate: 'Organizing your improvement plan',
    };
    this.store.updateJob(job.id, { progress: progressLabel ?? progress[name] });
    const text = JSON.stringify(input),
      cap = Math.min(4096, model.maxOutputTokens ?? 4096),
      tokenUpper = Buffer.byteLength(text + prompts[name], "utf8") + 1000,
      estimate = tokenUpper * model.inputUsd + cap * model.outputUsd;
    return this.once(job, receiptKey, async () => {
      const completion = await this.providers.complete(
        job.provider!,
        model.id,
        prompts[name],
        text,
        signal,
        cap,
        false,
        model,
      );
      this.store.db.transaction(() => {
        this.store.updateJob(job.id, {
          spentUsd:
            this.store.job(job.id).spentUsd +
            (completion.costUsd ?? (job.provider === "chatgpt" ? 0 : estimate)),
          costBasis: completion.costUsd === null && job.provider !== 'chatgpt' ? 'includes_estimates' : this.store.job(job.id).costBasis ?? 'reported',
        });
        this.store.put("pass", job.projectId, job.id, {
          id: randomUUID(),
          pass: name,
          input,
          output: completion.text,
          model: completion.model,
          costUsd: completion.costUsd,
          costEstimateUsd: estimate,
          createdAt: new Date().toISOString(),
        });
        this.store.setStep(job.id, receiptKey, "done", completion.text);
      })();
      if (job.provider === "openrouter" && completion.costUsd === null)
        throw new ProviderError(
          "cost_unknown",
          "The provider omitted its cost. The completed output is saved; the conservative estimate is held against your budget. Review provider usage before resuming.",
          true,
        );
      if (this.store.job(job.id).spentUsd > job.maxCostUsd)
        throw new ProviderError(
          "budget",
          "Provider cost exceeded the approved estimate. Further requests have stopped.",
        );
      return completion.text;
    }, () => {
      if (tokenUpper + cap > model.contextLength)
        throw new ProviderError('context', 'This model cannot hold the evidence. Select a model with a larger context window.');
      if (this.store.job(job.id).spentUsd + estimate > job.maxCostUsd)
        throw new ProviderError('budget', 'The approved budget is insufficient for the next analysis pass.');
    });
  }
  async consoleMeasure(job: Job, project: Project, signal: AbortSignal) {
    const savedProfile = this.store.step(job.id, "console-measurement-profile");
    const profile = savedProfile?.body ? JSON.parse(savedProfile.body) : this.store.step(job.id, "console-scan") ? "full_check"
      : await this.once(job, "console-measurement-profile", async () => {
        const capability = consoleCapabilities((await this.providers.console("/capabilities", undefined, undefined, signal)).data);
        const platform = job.platform === "chat_gpt" ? "chatgpt" : job.platform;
        return capability.operations.includes("measurement") && capability.selected_question_platforms.includes(platform as "chatgpt" | "gemini")
          ? "selected_questions" : "full_check";
      });
    if (profile === "selected_questions") return consoleMeasurement(this, job, project, signal);
    const platform = job.platform === 'chat_gpt' ? 'chatgpt' : job.platform;
    if (this.store.step(job.id, 'console-scan')?.state !== 'done') {
      const capability = await this.providers.console('/capabilities', undefined, undefined, signal);
      if (!capability.data?.platforms?.some((p: any) => p.key === platform && p.enabled === true))
        throw new ProviderError('capability', 'This AI platform is not available on your SurfacedBy connection. Select an enabled platform.');
    }
    const domain = await this.once(job, "console-domain", async () => {
      const list = await this.consolePages("/domains", signal);
      const existing = list.find((d: any) => d.domain === project.domain);
      if (existing) return existing;
      return (
        await this.providers.console(
          "/domains",
          { domain: project.domain },
          job.id + ":domain",
          signal,
        )
      ).data;
    });
    await this.once(job, "console-brand", async () =>
      this.providers.console(
        "/domains/" + domain.id + "/brand",
        {
          brand_name: project.brand,
          aliases: project.aliases,
          country: new Intl.Locale(project.locale).region,
        },
        job.id + ":brand",
        signal,
        "PATCH",
      ),
    );
    for (const [index, competitor] of project.competitors.entries())
      await this.once(job, "console-competitor:" + index, async () =>
        this.providers.console(
          "/domains/" + domain.id + "/competitors",
          { domain: competitor },
          job.id + ":competitor:" + index,
          signal,
        ),
      );
    const request = {
      domain_id: domain.id,
      platforms: [platform],
      keywords: project.prompts,
      max_credits: Math.floor((job.maxCostUsd + Number.EPSILON) / 0.1),
    };
    if (this.store.step(job.id, "console-scan")?.state !== "done") {
      const preview = await this.providers.console(
        "/scans/preview",
        request,
        undefined,
        signal,
      );
      const credits =
        preview.data?.credits_required ??
        preview.data?.credits_cost ??
        preview.data?.credit_cost;
      if (!Number.isSafeInteger(credits) || credits < 0)
        throw new ProviderError(
          "estimate",
          "SurfacedBy did not return a usable estimate.",
        );
      if (!Number.isSafeInteger(preview.data?.query_count) || preview.data.query_count < 1)
        throw new ProviderError("estimate", "The API did not return the number of answers in this check. No check was submitted.");
      if (credits * 0.1 > job.maxCostUsd)
        throw new ProviderError(
          "budget",
          "The approved budget is insufficient for this SurfacedBy check.",
        );
      this.store.updateJob(job.id, { requestedAnswers: preview.data.query_count });
    }
    const scan = await this.once(
      job,
      "console-scan",
      async () =>
        (await this.providers.console("/scans", request, job.id, signal)).data,
    );
    const scanId = scan.scan_id;
    if (!scanId)
      throw new ProviderError(
        "invalid_response",
        "SurfacedBy did not confirm this check. Review SurfacedBy Console before continuing.",
        true,
      );
    if (typeof scan.credits_charged !== 'number' || !Number.isFinite(scan.credits_charged) || scan.credits_charged < 0)
      throw new ProviderError('cost_unknown', 'SurfacedBy did not confirm the charge for this check. Review it in SurfacedBy Console before continuing.', true);
    this.store.updateJob(job.id, { spentUsd: scan.credits_charged * 0.1 });
    let state;
    for (let n = 0; n < 180; n++) {
      signal.throwIfAborted();
      state = (
        await this.providers.console(
          "/scans/" + scanId,
          undefined,
          undefined,
          signal,
        )
      ).data;
      if (state.status !== "completed" && Number.isSafeInteger(state.answers_total) && state.answers_total > 0)
        this.store.updateJob(job.id, { requestedAnswers: state.answers_total });
      if (state.status === "completed") {
        const analysis = (
          await this.providers.console(
            "/scans/" + scanId + "/analysis",
            undefined,
            undefined,
            signal,
          )
        ).data;
        if (analysis.analysis_status === "available") break;
        if (analysis.analysis_status === "unavailable")
          throw new ProviderError(
            "analysis",
            "SurfacedBy analysis is unavailable for this check. The collected answers remain in SurfacedBy.",
          );
        state = { ...state, status: "processing-analysis" };
        this.store.updateJob(job.id, {
          progress:
            "Answers collected. Waiting for SurfacedBy recommendations.",
        });
      }
      if (["failed", "cancelled"].includes(state.status))
        throw new ProviderError(
          "provider",
          "SurfacedBy did not complete this check.",
        );
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (state?.status !== "completed")
      throw new ProviderError(
        "waiting",
        "SurfacedBy is still processing. Resume later to collect results.",
      );
    await this.once(job, "console-evidence", async () => {
      const evidence = await this.consolePages(
        "/scans/" + scanId + "/observations",
        signal,
      );
      const findings: any[] = [];
      for (const kind of ["diagnoses", "opportunities"])
        findings.push(
          ...(await this.consolePages(
            "/domains/" +
              domain.id +
              "/insights/" +
              kind +
              "?scan_id=" +
              scanId,
            signal,
          )),
        );
      this.store.db.transaction(() => {
        const observationIds = new Map<string, string>();
        for (const row of evidence) {
          if (row.status === "missing_observation" || !row.answer_text?.trim())
            continue;
          const citations = safeCitations(Array.isArray(row.citations) ? row.citations : []);
          const o: Observation = {
            id: randomUUID(),
            projectId: project.id,
            jobId: job.id,
            prompt: row.prompt,
            provider: "console",
            platform: row.platform,
            model: row.model ?? "not-disclosed",
            locale: row.locale ?? project.locale,
            observedAt: row.observed_at ?? state.completed_at,
            answer: row.answer_text,
            citations,
            surface: ["api", "consumer_interface"].includes(row.surface) ? row.surface : "unknown",
            mentioned: ["cited", "named"].includes(row.presence),
            cited: row.presence === "cited",
            costUsd: null,
          };
          this.store.put("observation", project.id, job.id, o);
          observationIds.set(row.id, o.id);
        }
        for (const row of findings)
          this.store.put("finding", project.id, job.id, {
            id: randomUUID(),
            projectId: project.id,
            jobId: job.id,
            title: row.title,
            description: row.description,
            priority: row.priority ?? "medium",
            targetUrl: row.target_url ?? "https://" + project.domain,
            evidenceIds: (row.evidence ?? [])
              .map((e: any) => observationIds.get(e.observation_id))
              .filter(Boolean),
            steps: row.steps ?? [],
            confidence: "inferred",
            status: "open",
            kind: "console",
            remoteId: row.id,
            evidenceAsOf: row.evidence_as_of,
            remoteScanId: row.scan_id,
          });
        this.store.setStep(job.id, "console-evidence", "done", {
          observations: evidence.length,
        });
      })();
      return { observations: evidence.length };
    });
    const requested = state.answers_total;
    const evidenceCount = JSON.parse(this.store.step(job.id, "console-evidence")!.body!).observations;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested < evidenceCount)
      throw new ProviderError("invalid_response", "The collected answers are saved, but the API returned an inconsistent check total. Review this check before comparing results.");
    this.store.updateJob(job.id, { requestedAnswers: requested });
    return {
      metrics: summarize(
        this.store.observations(project.id, job.id),
        requested,
      ),
      consoleScore: state.visibility_score,
      comparisonKey: comparisonKey(
        project,
        job,
        this.store.observations(project.id, job.id),
      ),
    };
  }
  async consolePages(path: string, signal: AbortSignal) {
    const rows: any[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      signal.throwIfAborted();
      const result = await this.providers.console(
        path +
          (cursor
            ? (path.includes("?") ? "&" : "?") +
              "cursor=" +
              encodeURIComponent(cursor)
            : ""),
        undefined,
        undefined,
        signal,
      );
      rows.push(...(result.data ?? []));
      cursor = result.meta?.next_cursor;
      if (cursor && seen.has(cursor))
        throw new ProviderError(
          "pagination",
          "SurfacedBy returned an incomplete list. Try again shortly.",
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }
  async consoleJob(job: Job, project: Project, signal: AbortSignal) {
    return consoleContent(this, job, project, signal);
  }
}
