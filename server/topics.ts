import { ProviderError, type Topic, type Job, type Observation, type PageSummary, type Project, type ProjectInput } from "./contracts.js";
import { comparisonKey, competitorEvidence, summarize } from "./analysis.js";
import { workspacePresentation, type HistoryPoint } from "./presentation.js";
import { completedMeasurement, measurementTime, portableJobResult } from "./portable-results.js";
import type { Store } from "./storage.js";
import { z } from "zod";
import { publicUrl, sameSiteHost } from "./network.js";
import { pageIdentity as pageKey } from './page-classification.js';

/** Topics point at the brand's own questions and competitors, so editing those lists never leaves a topic asking something the brand no longer tracks. */
export function normalizeTopics(project: ProjectInput) {
  const site = publicUrl(project.domain);
  for (const [index, topic] of project.topics.entries())
    for (const [position, url] of topic.targetUrls.entries()) {
      let page: URL | undefined;
      try { page = publicUrl(url); } catch {}
      if (!page || !sameSiteHost(page, site)) throw new z.ZodError([{ code: "custom", path: ["topics", index, "targetUrls", position], message: "Choose a page on this website." }]);
    }
  return project.topics.map((topic) => ({
    ...topic,
    prompts: project.prompts.filter((prompt) => topic.prompts.includes(prompt)),
    competitors: project.competitors.filter((competitor) => topic.competitors.includes(competitor)),
    targetUrls: [...new Set(topic.targetUrls)],
  }));
}

/** A topic check freezes only that topic's questions, so every provider asks and prices just those. */
export function topicScope(project: Project, topicId?: string): Project {
  if (!topicId) return project;
  const topic = project.topics.find((item) => item.id === topicId);
  if (!topic) throw new ProviderError("setup", "This topic is not part of this brand.");
  if (!topic.prompts.length) throw new ProviderError("setup", "Add at least one question to this topic before checking it.");
  return { ...project, prompts: topic.prompts, competitors: topic.competitors.length ? topic.competitors : project.competitors };
}

/** Plans and answers are read once per check, so summaries for every topic stay cheap on each workspace refresh. */
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

/** A check speaks for a topic only when it asked every one of the topic's questions; imported checks without a saved plan rely on the answers they kept. */
function covering(topic: Topic, jobs: Job[], read: Reader) {
  const questions = new Set(topic.prompts);
  return jobs
    .filter((job) => ["measure", "recheck"].includes(job.kind) && (completedMeasurement(job) || ["running", "paused"].includes(job.status)))
    .flatMap((job): Check[] => {
      const plan = read.plan(job);
      const asked = plan ? plan.prompts : read.answers(job).map((answer) => answer.prompt);
      if (!topic.prompts.length || !topic.prompts.every((prompt) => asked.includes(prompt))) return [];
      return [{ job, plan, observations: read.answers(job).filter((answer) => questions.has(answer.prompt)) }];
    });
}

function topicKey(project: Project, topic: Topic, check: Check) {
  return comparisonKey({ ...(check.plan ?? project), prompts: topic.prompts }, check.job, check.observations);
}

function targets(topic: Topic, observations: Observation[], pages: PageSummary[]) {
  return topic.targetUrls.map((url) => {
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

/** One topic's evidence, read from every check that asked all of its questions, with a trend that compares only like with like. */
export function topicView(store: Store, project: Project, topic: Topic) {
  const jobs = store.jobs(project.id), read = reader(store, project);
  const checks = covering(topic, jobs, read);
  const latest = checks[0], current = checks.find((check) => completedMeasurement(check.job));
  const key = current ? topicKey(project, topic, current) : null;
  const requested = topic.prompts.length;
  const history: HistoryPoint[] = checks
    .filter((check) => completedMeasurement(check.job) && topicKey(project, topic, check) === key)
    .map((check) => {
      const metrics = summarize(check.observations, requested);
      return { jobId: check.job.id, at: measurementTime(check.job), collected: metrics.completed, requested, missing: metrics.missing,
        mentionRate: metrics.missing ? null : metrics.mentionRate, citationRate: metrics.missing ? null : metrics.citationRate };
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.jobId.localeCompare(b.jobId));
  const observations = latest?.observations ?? [];
  const audit = jobs.find(job => job.kind === 'audit' && job.status === 'completed');
  const pages = audit ? store.pageCatalog.targets(project.id, audit.id, topic.targetUrls) : [];
  const presentation = workspacePresentation([], latest?.job, observations, topic.prompts, requested);
  if (audit) presentation.audit = store.pageCatalog.summary(project.id, audit.id);
  return {
    topic,
    measurement: latest?.job ?? null,
    observations,
    metrics: summarize(observations, latest ? requested : 0),
    presentation: { ...presentation, history, historyScopeAvailable: !!current },
    competitors: competitorEvidence({ ...project, competitors: topic.competitors.length ? topic.competitors : project.competitors }, observations),
    targets: targets(topic, observations, pages),
    checks: checks.map((check) => ({
      jobId: check.job.id,
      at: measurementTime(check.job),
      status: check.job.status,
      provider: check.job.provider ?? null,
      platform: check.job.platform,
      topicCheck: check.job.topicId === topic.id,
      comparable: !!key && topicKey(project, topic, check) === key,
      metrics: summarize(check.observations, requested),
    })),
  };
}

/** The list and the topic selectors need only each topic's latest covering check. */
export function topicSummaries(store: Store, project: Project, jobs: Job[]) {
  if (!project.topics.length) return [];
  const read = reader(store, project);
  return project.topics.map((topic) => {
    const latest = covering(topic, jobs, read)[0];
    const cited = latest ? targets(topic, latest.observations, []).filter((target) => target.answersCiting > 0).length : null;
    return {
      id: topic.id,
      name: topic.name,
      goal: topic.goal,
      status: topic.status,
      reviewBy: topic.reviewBy,
      questions: topic.prompts.length,
      targets: topic.targetUrls.length,
      targetsCited: cited,
      lastCheckAt: latest ? measurementTime(latest.job) : null,
      metrics: latest ? summarize(latest.observations, topic.prompts.length) : null,
    };
  });
}
export type TopicSummary = ReturnType<typeof topicSummaries>[number];
export type TopicView = ReturnType<typeof topicView>;

/** Topic checks ask only part of the brand's questions, so the brand's trend shows each one as a gap instead of a full reading. */
export function withTopicChecks(history: HistoryPoint[], jobs: Job[], project: Project) {
  if (!history.length) return history;
  const names = new Map(project.topics.map((topic) => [topic.id, topic.name]));
  const partial = jobs
    .filter((job) => job.topicId && completedMeasurement(job))
    .map((job): HistoryPoint => {
      const metrics = portableJobResult(job)?.metrics;
      return { jobId: job.id, at: measurementTime(job), collected: metrics?.completed ?? 0, requested: metrics?.requested ?? job.requestedAnswers ?? 0,
        missing: metrics?.missing ?? 0, mentionRate: null, citationRate: null, topic: names.get(job.topicId!) ?? "Removed topic" };
    });
  return [...history, ...partial].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.jobId.localeCompare(b.jobId));
}
