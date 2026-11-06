import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ProviderError, jobInput, type Job, type Observation, type Project, type ProjectInput } from "./contracts.js";
import { consoleCapabilities } from "./console-capabilities.js";
import { completedMeasurement } from "./portable-results.js";
import type { Providers } from "./providers.js";
import type { Store } from "./storage.js";
import type { Vault } from "./vault.js";
import type { Runner } from "./workflows.js";
import { askFit } from "./ask-scope.js";
import { consolePlatformKey, localPlatformKey, platformName } from './platforms.js';
import { publicObservation } from './public-results.js';
import { quotedCreditUsd, usdString } from './console-pricing.js';
import { sumUsd } from './usd.js';

/** Direct connections have implemented adapters; managed engines come from Console's live contract. */
const directEngines = {
  chatgpt: { provider: "chatgpt", platform: "chat_gpt", label: "ChatGPT", detail: "Your ChatGPT connection" },
  "dataforseo-chatgpt": { provider: "dataforseo", platform: "chat_gpt", label: "ChatGPT", detail: "Your DataForSEO connection" },
  "dataforseo-gemini": { provider: "dataforseo", platform: "gemini", label: "Gemini", detail: "Your DataForSEO connection" },
  "dataforseo-perplexity": { provider: "dataforseo", platform: "perplexity", label: "Perplexity", detail: "Your DataForSEO connection" },
} as const;
type EngineDefinition = { id: string; provider: 'chatgpt' | 'dataforseo' | 'console'; platform: string; label: string; detail: string };
const defaultLimitUsd = 1;

export type AskDeps = {
  store: Store; vault: Vault; providers: Providers; runner: Runner;
  parseProject: (raw: unknown) => ProjectInput;
};

/** Questions match when only spacing or capitals differ. */
export const sameQuestion = (a: string, b: string) =>
  a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

export function engineOf(job: Pick<Job, "provider" | "platform">): string | undefined {
  if (job.provider === 'console') return 'surfacedby-' + consolePlatformKey(job.platform);
  return Object.entries(directEngines).find(([, engine]) => engine.provider === job.provider && engine.platform === job.platform)?.[0];
}

/** The same request key always names the same ask, so a retried request cannot start a second one. */
function askIdFor(projectId: string, key: string) {
  const h = createHash("sha256").update(projectId + ":" + key).digest("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-" + (8 | (parseInt(h[16], 16) & 3)).toString(16) + h.slice(17, 20) + "-" + h.slice(20, 32);
}

async function surfacedByPlatforms(deps: AskDeps): Promise<{ platforms: { key: string; name: string; enabled: boolean }[]; selected: string[];
  pricing?: ReturnType<typeof consoleCapabilities>['pricing']; reason?: string }> {
  try {
    const capability = consoleCapabilities((await deps.providers.console("/capabilities", undefined, undefined, AbortSignal.timeout(15000))).data);
    return { platforms: capability.platforms, selected: capability.selected_question_platforms, pricing: capability.pricing };
  } catch {
    return { platforms: [], selected: [], reason: "SurfacedBy availability could not be verified. Try again shortly." };
  }
}

/** Availability and price kind are decided here; the screen only displays them. */
export async function engineCatalog(deps: AskDeps) {
  const connected = deps.vault.status() as Record<string, boolean>;
  const surfacedBy = connected.console ? await surfacedByPlatforms(deps) : { platforms: [], selected: [] as string[] };
  if (surfacedBy.platforms.length) deps.store.set('consolePlatformNames', Object.fromEntries(surfacedBy.platforms.map(row => [localPlatformKey(row.key), row.name])));
  const requestEstimate = deps.store.setting<number>("measurementRequestEstimateUsd", 0);
  const definitions: EngineDefinition[] = [
    ...Object.entries(directEngines).map(([id, engine]) => ({ id, ...engine })),
    ...surfacedBy.platforms.map(row => ({ id: 'surfacedby-' + row.key, provider: 'console' as const,
      platform: localPlatformKey(row.key), label: row.name, detail: 'Your SurfacedBy connection' })),
  ];
  const engines = definitions.map(({ id, ...engine }) => {
    let reason: string | undefined;
    if (!connected[engine.provider]) reason = "Not connected";
    else if (engine.provider === "console" && !surfacedBy.selected.includes(consolePlatformKey(engine.platform)))
      reason = "Single-question checks are not available for this engine on your SurfacedBy connection";
    else if (engine.provider === "dataforseo" && requestEstimate <= 0) reason = "Set a DataForSEO request estimate in Settings";
    const menu = engine.provider === 'console' && !reason
      ? surfacedBy.pricing?.measurement?.platforms.find(row => row.platform === consolePlatformKey(engine.platform)) : undefined;
    return { id, ...engine, available: !reason, ...(reason ? { reason } : {}),
      price: engine.provider === "chatgpt" ? "free" as const : engine.provider === "console" ? "quote" as const : "per_request" as const,
      ...(engine.provider === "dataforseo" && requestEstimate > 0 ? { estimateUsd: requestEstimate } : {}),
      ...(menu ? { estimateUsd: Number(menu.one_answer_usd) } : {}) };
  });
  return { engines, availabilityNote: surfacedBy.reason ?? (!connected.console ? 'Connect SurfacedBy to see its available engines.' : undefined),
    defaultLimitUsd: deps.store.setting<number>("askLimitUsd", defaultLimitUsd) };
}

const question = z.string().trim().min(3, "Ask a question of at least 3 characters").max(500);
export const askEngineKey = z.string().regex(/^(chatgpt|dataforseo-[a-z][a-z0-9_]{0,63}|surfacedby-[a-z][a-z0-9_]{0,63})$/);
const engineList = z.array(askEngineKey).min(1, "Choose at least one engine").max(44)
  .refine(list => new Set(list).size === list.length, "Choose each engine once");
const askInput = z.object({ question, engines: engineList, maxCostUsd: z.number().finite().min(0).max(1000).default(0) }).strict();

/** Quote the same single question without submitting a measurement job. */
async function surfacedByQuote(deps: AskDeps, project: Project, domainId: string, text: string, platform: string) {
  const country = new Intl.Locale(project.locale).region ?? null;
  const quote = (await deps.providers.console("/domains/" + domainId + "/measurement/estimate",
    { questions: [{ id: randomUUID(), question: text }], platform: consolePlatformKey(platform), locale: project.locale, country },
    "ask-estimate:" + randomUUID(), AbortSignal.timeout(20000))).data;
  const price = z.object({ domain_id: z.string().uuid(), operation: z.literal('measurement'),
    estimated_credits: z.number().int().positive(), estimated_usd: usdString,
    expires_at: z.string().datetime({ offset: true }) }).parse(quote);
  quotedCreditUsd(price);
  if (price.domain_id !== domainId || Date.parse(price.expires_at) <= Date.now())
    throw new ProviderError('estimate', 'SurfacedBy did not return a current estimate for this website.');
  return { estimateUsd: Number(price.estimated_usd), expiresAt: price.expires_at };
}

export async function estimateAsk(deps: AskDeps, projectId: string, body: unknown) {
  const input = z.object({ question, engines: engineList }).strict().parse(body);
  const project = deps.store.project(projectId);
  const catalog = await engineCatalog(deps);
  const quote = questionQuoter(deps, project, input.question);
  const engines = await Promise.all(input.engines.map(async id => {
    const engine = catalog.engines.find(row => row.id === id);
    if (!engine?.available) return { id, estimateUsd: null, blocked: true, note: engine?.reason ?? 'This engine is not available on your connection.' };
    return { id, ...await quote(engine) };
  }));
  const known = engines.every(row => row.estimateUsd !== null);
  const expiries = engines.flatMap(row => 'expiresAt' in row && typeof row.expiresAt === 'string' ? [row.expiresAt] : []);
  return { engines, expiresAt: expiries.length ? expiries.sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null,
    totalUsd: known ? sumUsd(engines.map(row => row.estimateUsd ?? 0)) : null };
}

/** Each group uses one domain lookup. Previewing an unregistered website never registers it. */
function questionQuoter(deps: AskDeps, project: Project, text: string) {
  let domainLookup: ReturnType<Runner['findConsoleDomain']> | undefined;
  return async (engine: EngineDefinition & { estimateUsd?: number }) => {
    if (engine.provider === 'chatgpt') return { estimateUsd: 0 };
    if (engine.provider === 'dataforseo') return { estimateUsd: engine.estimateUsd ?? null };
    try {
      domainLookup ??= deps.runner.findConsoleDomain(project.domain, AbortSignal.timeout(15000));
      const domain = await domainLookup;
      if (domain) return await surfacedByQuote(deps, project, domain.id, text, engine.platform);
      if (engine.estimateUsd !== undefined) return { estimateUsd: engine.estimateUsd, publishedPrice: true };
      return { estimateUsd: null, note: 'Priced when the ask starts' };
    } catch {
      return { estimateUsd: null, blocked: true,
        note: `SurfacedBy couldn't confirm a price for ${engine.label}. Refresh prices, edit your question or deselect that engine.` };
    }
  };
}

/** Recheck estimates before atomically saving the shared approval. Execution still enforces each saved limit. */
export async function createAsk(deps: AskDeps, projectId: string, body: unknown, key: string) {
  const input = askInput.parse(body);
  const project = deps.store.project(projectId);
  const askId = askIdFor(projectId, key);
  const inputHash = createHash('sha256').update(JSON.stringify({ ...input, engines: [...input.engines].sort() })).digest('hex');
  const previous = deps.store.askRequest(askId, inputHash);
  if (previous) return previous;
  const catalog = await engineCatalog(deps);
  const chosen = input.engines.map(id => {
    const engine = catalog.engines.find(engine => engine.id === id);
    if (!engine) throw new ProviderError('capability', 'This engine is no longer available. Refresh the engine list before starting. Nothing was started.');
    return engine;
  });
  const unavailable = chosen.find(engine => !engine.available);
  if (unavailable) throw new ProviderError("capability", unavailable.label + " (" + unavailable.detail + "): " + unavailable.reason + ".");
  const paid = chosen.filter(engine => engine.price !== "free");
  if (paid.length && input.maxCostUsd <= 0) throw new ProviderError("budget", "Set a spending limit to ask paid engines. Nothing was started.");
  const quotes = await Promise.all(paid.map(questionQuoter(deps, project, input.question)));
  for (const quote of quotes) {
    if ('blocked' in quote && quote.blocked) throw new ProviderError('estimate', quote.note);
  }
  const fit = askFit(input.maxCostUsd, quotes.map(quote => quote.estimateUsd));
  if (fit.overLimit) throw new ProviderError('budget', 'The selected engines exceed your spending limit. Review the estimates or choose fewer engines. Nothing was started.');
  const limits = new Map(paid.map((engine, index) => [engine.id, fit.limitsUsd[index]]));
  const result = deps.store.enqueueAsk(askId, projectId, inputHash, chosen.map(engine => jobInput.parse({
    projectId, kind: "ask", askId, question: input.question, provider: engine.provider, platform: engine.platform,
    maxCostUsd: engine.price === "free" ? 0 : limits.get(engine.id), webSearch: true,
  })));
  if (paid.length) deps.store.set("askLimitUsd", input.maxCostUsd);
  return result;
}

function askJobs(store: Store, projectId: string, askId?: string) {
  return store.jobs(projectId).filter(job => job.kind === "ask" && (!askId || job.askId === askId));
}

/** Activity is separate from visibility evidence, so leaving Ask never hides work or changes visibility counts. */
export function askActivity(jobs: Job[]) {
  const pending = jobs.filter(job => job.kind === 'ask' &&
    (['queued', 'running', 'paused'].includes(job.status) || job.error === 'cancel_remote'));
  const ids = [...new Set(pending.map(job => job.askId!))];
  return ids.map(askId => {
    const active = pending.filter(job => job.askId === askId);
    return { askId, question: active[0].question!, collecting: active.filter(job => ['queued', 'running'].includes(job.status)).length,
      needsAttention: active.filter(job => !['queued', 'running'].includes(job.status)).length,
      paused: active.every(job => !['queued', 'running'].includes(job.status)) };
  });
}

function engineState(store: Store, job: Job) {
  const answer = store.answers(job.projectId, job.id, "ask-answer")[0] ?? null;
  const state: "answered" | "collecting" | "paused" | "skipped" | "no_answer" = answer ? "answered" : ["queued", "running"].includes(job.status) ? "collecting"
    : job.status === "paused" ? "paused" : job.status === "cancelled" ? "skipped" : "no_answer";
  return { answer, state };
}

/** History and detail share the saved billing state; a held reservation is not a final charge. */
function askTotals(jobs: Job[]) {
  return {
    limitUsd: sumUsd(jobs.map(job => job.maxCostUsd)),
    spentUsd: sumUsd(jobs.map(job => job.spentUsd)),
    costBasis: jobs.some(job => job.costBasis === 'includes_estimates') ? 'includes_estimates' as const : 'reported' as const,
  };
}

export function listAsks(store: Store, projectId: string) {
  const groups = new Map<string, Job[]>();
  for (const job of askJobs(store, projectId)) groups.set(job.askId!, [...(groups.get(job.askId!) ?? []), job]);
  const project = store.project(projectId);
  const asked = [...groups.values()].map(jobs => jobs[0].question!);
  const latestDiscovery = store.jobs(projectId).find(job => job.kind === "discover" && job.status === "completed");
  const suggestions = ((latestDiscovery?.result as { questions?: { text: string }[] } | null)?.questions ?? [])
    .map(row => row.text).filter(text => !project.prompts.some(prompt => sameQuestion(prompt, text)) && !asked.some(prior => sameQuestion(prior, text)))
    .slice(0, 3);
  return {
    asks: [...groups.entries()].map(([askId, jobs]) => ({
      askId, question: jobs[0].question!, createdAt: jobs.map(job => job.createdAt).sort()[0],
      ...askTotals(jobs),
      engines: jobs.slice().reverse().map(job => { const { answer, state } = engineState(store, job);
        return { engine: engineOf(job), platform: job.platform, label: savedEngineName(store, job.platform), state, mentioned: answer?.mentioned ?? null, cited: answer?.cited ?? null }; }),
    })),
    suggestions,
  };
}

/** Earlier answers to the same tracked question show that one ask is one sample, not a verdict. */
function trackedHistory(store: Store, projectId: string, text: string) {
  return store.jobs(projectId).filter(completedMeasurement)
    .flatMap(job => store.observations(projectId, job.id).filter((row: Observation) => sameQuestion(row.prompt, text)))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, 12)
    .map(row => ({ observedAt: row.observedAt, provider: row.provider, platform: row.platform, mentioned: row.mentioned, cited: row.cited }));
}

function savedEngineName(store: Store, platform: string) {
  const names = store.setting<Record<string, string>>('consolePlatformNames', {});
  return Object.hasOwn(names, platform) && typeof names[platform] === 'string' ? names[platform] : platformName(platform);
}

export function readAsk(store: Store, projectId: string, askId: string) {
  const jobs = askJobs(store, projectId, askId);
  if (!jobs.length) throw new Error("Ask not found");
  const project = store.project(projectId), text = jobs[0].question!;
  const saved = store.step(jobs[0].id, 'project');
  const context: Project = saved?.body ? JSON.parse(saved.body) : project;
  return {
    askId, question: text, createdAt: jobs.map(job => job.createdAt).sort()[0], locale: context.locale,
    brand: context.brand, domain: context.domain,
    ...askTotals(jobs),
    tracked: project.prompts.some(prompt => sameQuestion(prompt, text)),
    topics: project.topics.filter(topic => topic.status === "active")
      .map(topic => ({ id: topic.id, name: topic.name, tracked: topic.prompts.some(prompt => sameQuestion(prompt, text)) })),
    engines: jobs.slice().reverse().map(job => {
      const id = engineOf(job), { answer, state } = engineState(store, job);
      return { engine: id ?? null, provider: job.provider, platform: job.platform, label: savedEngineName(store, job.platform),
        jobId: job.id, state, status: job.status, progress: job.progress, error: job.error,
        spentUsd: job.spentUsd, maxCostUsd: job.maxCostUsd, costBasis: job.costBasis ?? null, answer: answer ? publicObservation(answer) : null };
    }),
    history: trackedHistory(store, projectId, text),
  };
}

/** Tracking adds the question to the website's questions (and a topic's) once; the ask's own answers stay out of the rates. */
export function trackAsk(deps: AskDeps, projectId: string, askId: string, body: unknown) {
  const input = z.object({ topicId: z.string().uuid().optional() }).strict().parse(body ?? {});
  const job = askJobs(deps.store, projectId, askId)[0];
  if (!job) throw new Error("Ask not found");
  const project = deps.store.project(projectId), text = job.question!;
  if (input.topicId && !project.topics.some(topic => topic.id === input.topicId && topic.status === 'active')) throw new Error("Active topic not found");
  const add = (list: string[]) => list.some(prompt => sameQuestion(prompt, text)) ? list : [...list, text];
  const prompts = add(project.prompts);
  const tracked = prompts.find(prompt => sameQuestion(prompt, text))!;
  const topics = project.topics.map(topic => topic.id === input.topicId
    ? { ...topic, prompts: topic.prompts.some(prompt => sameQuestion(prompt, text)) ? topic.prompts : [...topic.prompts, tracked] } : topic);
  const { id: _id, createdAt: _createdAt, ...current } = project;
  return deps.store.updateProject(projectId, deps.parseProject({ ...current, prompts, topics }));
}

export function registerAsks(app: FastifyInstance, deps: AskDeps) {
  const ids = (req: { params: unknown }) => req.params as { id: string; ask: string };
  app.get("/api/projects/:id/asks/engines", async (req) => { deps.store.project(ids(req).id); return engineCatalog(deps); });
  app.post("/api/projects/:id/asks/estimate", (req) => estimateAsk(deps, ids(req).id, req.body));
  app.get("/api/projects/:id/asks", (req) => listAsks(deps.store, ids(req).id));
  app.post("/api/projects/:id/asks", (req) =>
    createAsk(deps, ids(req).id, req.body, z.string().min(8).max(200).parse(req.headers["idempotency-key"])));
  app.get("/api/projects/:id/asks/:ask", (req) => readAsk(deps.store, ids(req).id, ids(req).ask));
  app.post("/api/projects/:id/asks/:ask/track", (req) => trackAsk(deps, ids(req).id, ids(req).ask, req.body));
  app.delete("/api/projects/:id/asks/:ask", (req) => {
    const { id, ask } = ids(req);
    if (askJobs(deps.store, id, ask).some(job => deps.runner.isWorking(job.id)))
      throw new ProviderError("in_progress", "Wait for this ask to finish, or skip its engines, before deleting it.");
    return deps.store.deleteAsk(id, ask);
  });
}
