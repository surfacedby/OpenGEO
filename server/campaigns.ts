import { ProviderError, type Campaign, type Job, type Observation, type PageEvidence, type Project, type ProjectInput } from "./contracts.js";
import { comparisonKey, competitorEvidence, summarize } from "./analysis.js";
import { workspacePresentation, type HistoryPoint } from "./presentation.js";
import { completedMeasurement, measurementTime, portableJobResult } from "./portable-results.js";
import type { Store } from "./storage.js";

/** Campaigns point at the brand's own questions and competitors, so editing those lists never leaves a campaign asking something the brand no longer tracks. */
export function normalizeCampaigns(project: ProjectInput) {
  return project.campaigns.map((campaign) => ({
    ...campaign,
    prompts: project.prompts.filter((prompt) => campaign.prompts.includes(prompt)),
    competitors: project.competitors.filter((competitor) => campaign.competitors.includes(competitor)),
    targetUrls: [...new Set(campaign.targetUrls)],
  }));
}

/** A campaign check freezes only that campaign's questions, so every provider asks and prices just those. */
export function campaignScope(project: Project, campaignId?: string): Project {
  if (!campaignId) return project;
  const campaign = project.campaigns.find((item) => item.id === campaignId);
  if (!campaign) throw new ProviderError("setup", "This campaign is not part of this brand.");
  if (!campaign.prompts.length) throw new ProviderError("setup", "Add at least one question to this campaign before checking it.");
  return { ...project, prompts: campaign.prompts, competitors: campaign.competitors.length ? campaign.competitors : project.competitors };
}

/** Answer engines tag the links they cite (ChatGPT adds utm_source=openai), so a tracking parameter never makes a cited page a different page. */
function pageKey(value: string) {
  try {
    const url = new URL(value);
    for (const name of [...url.searchParams.keys()]) if (name.toLowerCase().startsWith("utm_")) url.searchParams.delete(name);
    return url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/+$/, "") + url.search;
  } catch {
    return value;
  }
}

/** Plans and answers are read once per check, so summaries for every campaign stay cheap on each workspace refresh. */
function reader(store: Store, project: Project) {
  const plans = new Map<string, Project | null>(), answers = new Map<string, Observation[]>();
  return {
    plan(job: Job) {
      if (!plans.has(job.id)) {
        const saved = store.step(job.id, "project");
        plans.set(job.id, saved?.body ? JSON.parse(saved.body) : null);
      }
      return plans.get(job.id)!;
    },
    answers(job: Job) {
      if (!answers.has(job.id)) answers.set(job.id, store.observations(project.id, job.id));
      return answers.get(job.id)!;
    },
  };
}
type Reader = ReturnType<typeof reader>;
type Check = { job: Job; plan: Project | null; observations: Observation[] };

/** A check speaks for a campaign only when it asked every one of the campaign's questions; imported checks without a saved plan rely on the answers they kept. */
function covering(campaign: Campaign, jobs: Job[], read: Reader) {
  const questions = new Set(campaign.prompts);
  return jobs
    .filter((job) => ["measure", "recheck"].includes(job.kind) && (completedMeasurement(job) || ["running", "paused"].includes(job.status)))
    .flatMap((job): Check[] => {
      const plan = read.plan(job);
      const asked = plan ? plan.prompts : read.answers(job).map((answer) => answer.prompt);
      if (!campaign.prompts.length || !campaign.prompts.every((prompt) => asked.includes(prompt))) return [];
      return [{ job, plan, observations: read.answers(job).filter((answer) => questions.has(answer.prompt)) }];
    });
}

function campaignKey(project: Project, campaign: Campaign, check: Check) {
  return comparisonKey({ ...(check.plan ?? project), prompts: campaign.prompts }, check.job, check.observations);
}

function targets(campaign: Campaign, observations: Observation[], pages: PageEvidence[]) {
  return campaign.targetUrls.map((url) => {
    const key = pageKey(url);
    const citing = observations.filter((answer) => answer.citations.some((citation) => pageKey(citation.url) === key));
    const page = pages.find((item) => pageKey(item.url) === key);
    return {
      url,
      answersCiting: citing.length,
      answersCollected: observations.length,
      observationIds: citing.map((answer) => answer.id),
      page: page ? { status: page.status, noindex: page.noindex, title: page.title } : null,
    };
  });
}

function latestAuditPages(store: Store, project: Project, jobs: Job[]) {
  const audit = jobs.find((job) => job.kind === "audit" && job.status === "completed");
  return audit ? store.pages(project.id, audit.id) : [];
}

/** One campaign's evidence, read from every check that asked all of its questions, with a trend that compares only like with like. */
export function campaignView(store: Store, project: Project, campaign: Campaign) {
  const jobs = store.jobs(project.id), read = reader(store, project);
  const checks = covering(campaign, jobs, read);
  const latest = checks[0], current = checks.find((check) => completedMeasurement(check.job));
  const key = current ? campaignKey(project, campaign, current) : null;
  const requested = campaign.prompts.length;
  const history: HistoryPoint[] = checks
    .filter((check) => completedMeasurement(check.job) && campaignKey(project, campaign, check) === key)
    .map((check) => {
      const metrics = summarize(check.observations, requested);
      return { jobId: check.job.id, at: measurementTime(check.job), collected: metrics.completed, requested, missing: metrics.missing,
        mentionRate: metrics.missing ? null : metrics.mentionRate, citationRate: metrics.missing ? null : metrics.citationRate };
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.jobId.localeCompare(b.jobId));
  const observations = latest?.observations ?? [];
  const pages = latestAuditPages(store, project, jobs);
  return {
    campaign,
    measurement: latest?.job ?? null,
    observations,
    metrics: summarize(observations, latest ? requested : 0),
    presentation: { ...workspacePresentation([], latest?.job, observations, campaign.prompts, requested, pages), history, historyScopeAvailable: !!current },
    competitors: competitorEvidence({ ...project, competitors: campaign.competitors.length ? campaign.competitors : project.competitors }, observations),
    targets: targets(campaign, observations, pages),
    checks: checks.map((check) => ({
      jobId: check.job.id,
      at: measurementTime(check.job),
      status: check.job.status,
      provider: check.job.provider ?? null,
      platform: check.job.platform,
      campaignCheck: check.job.campaignId === campaign.id,
      comparable: !!key && campaignKey(project, campaign, check) === key,
      metrics: summarize(check.observations, requested),
    })),
  };
}

/** The list and the campaign selectors need only each campaign's latest covering check. */
export function campaignSummaries(store: Store, project: Project, jobs: Job[]) {
  const read = reader(store, project), pages = latestAuditPages(store, project, jobs);
  return project.campaigns.map((campaign) => {
    const latest = covering(campaign, jobs, read)[0];
    const cited = latest ? targets(campaign, latest.observations, pages).filter((target) => target.answersCiting > 0).length : null;
    return {
      id: campaign.id,
      name: campaign.name,
      goal: campaign.goal,
      status: campaign.status,
      reviewBy: campaign.reviewBy,
      questions: campaign.prompts.length,
      targets: campaign.targetUrls.length,
      targetsCited: cited,
      lastCheckAt: latest ? measurementTime(latest.job) : null,
      metrics: latest ? summarize(latest.observations, campaign.prompts.length) : null,
    };
  });
}
export type CampaignSummary = ReturnType<typeof campaignSummaries>[number];
export type CampaignView = ReturnType<typeof campaignView>;

/** Campaign checks ask only part of the brand's questions, so the brand's trend shows each one as a gap instead of a full reading. */
export function withCampaignChecks(history: HistoryPoint[], jobs: Job[], project: Project) {
  if (!history.length) return history;
  const names = new Map(project.campaigns.map((campaign) => [campaign.id, campaign.name]));
  const partial = jobs
    .filter((job) => job.campaignId && completedMeasurement(job))
    .map((job): HistoryPoint => {
      const metrics = portableJobResult(job)?.metrics;
      return { jobId: job.id, at: measurementTime(job), collected: metrics?.completed ?? 0, requested: metrics?.requested ?? job.requestedAnswers ?? 0,
        missing: metrics?.missing ?? 0, mentionRate: null, citationRate: null, campaign: names.get(job.campaignId!) ?? "Removed campaign" };
    });
  return [...history, ...partial].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.jobId.localeCompare(b.jobId));
}
