import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Store } from "./storage.js";
import { Vault } from "./vault.js";
import identity from "../brand/identity.json";
import { Connections, type CallbackListener } from "./oauth.js";
import { Providers } from "./providers.js";
import { consoleCapabilities } from "./console-capabilities.js";
import { questionDiscoveryVersion } from "./discovery.js";
import { Runner } from "./workflows.js";
import { Scheduler } from "./scheduler.js";
import {
  projectInput,
  jobInput,
  credentialInput,
  setupDraft,
  providers,
  ProviderError,
  auditCoverage,
  type Finding,
} from "./contracts.js";
import { publicUrl } from "./network.js";
import { topicScope, topicSummaries, topicView, normalizeTopics, withTopicChecks } from "./topics.js";
import { workspacePresentation, currentFindings } from "./presentation.js";
import { auditFindings, auditFindingPresentation } from './audit.js';
import { SiteIcons } from "./site-icons.js";
import { displayedMeasurement } from "./portable-results.js";
import { UsageSharing } from "./usage.js";
import {
  measurementMetrics,
  recheckComparison,
  competitorEvidence,
} from "./analysis.js";
import { exportProject, reportMarkdown } from "./export.js";
import { htmlDocument } from "./markdown.js";
import { RemoteAccess, securityHeaders, type RemoteConfig } from "./remote-access.js";
import {
  previewImport,
  importProject,
  previewRestore,
  restoreBackup,
} from "./import.js";
export async function createApp(
  store: Store,
  vault: Vault,
  token = randomBytes(32).toString("base64url"),
  staticRoot = resolve("dist"),
  onConnected?: () => void,
  remoteOptions?: RemoteConfig,
  callbackListener?: CallbackListener,
) {
  const app = Fastify({ logger: false, bodyLimit: 20_000_000 });
  const remote = remoteOptions ? new RemoteAccess(remoteOptions, token) : undefined;
  const sessionCookie = "opengeo_session_" + createHash("sha256").update(token).digest("hex").slice(0, 16);
  const siteIcons = new SiteIcons(undefined, () => store.setting('cachedWebsiteIcons', true));
  const usage = new UsageSharing(store);
  store.onJobCompleted = (kind, provider) => { if (kind !== "discover") usage.record(({ audit: "audit_completed", measure: "visibility_completed", recheck: "recheck_completed", diagnose: "analysis_completed", competitors: "analysis_completed", content: "content_created", revise: "content_revised" } as const)[kind], kind === "audit" ? null : provider ?? null); };
  store.onImprovementCompleted = () => usage.record("improvement_completed");
  const connections = new Connections(store, vault, () => {
      const address = app.server.address();
      return address && typeof address !== "string" ? "http://127.0.0.1:" + address.port : undefined;
    }, onConnected, callbackListener),
    p = new Providers(vault, connections),
    runner = new Runner(store, p),
    scheduler = new Scheduler(store);
  const permittedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  app.addHook("onRequest", async (req, res) => {
    securityHeaders(res);
    if (remote) return remote.guard(req, res);
    const host = req.headers.host;
    let hostname: string;
    try {
      hostname = new URL("http://" + host).hostname;
    } catch {
      return res.code(403).send({ error: "Invalid host" });
    }
    if (!permittedHosts.has(hostname))
      return res.code(403).send({ error: "Remote exposure is disabled" });
    if (req.headers.origin) {
      let origin: URL;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        return res.code(403).send({ error: "Invalid origin" });
      }
      if (
        !permittedHosts.has(origin.hostname) ||
        !["http:", "https:"].includes(origin.protocol) ||
        origin.host !== host
      )
        return res.code(403).send({ error: "Cross-origin request refused" });
    }
    // Opening the app from a link elsewhere is a top-level GET of the static shell, which has no
    // side effects; frames, subresources and every API request from another site stay refused.
    const topLevelPage = req.method === "GET" && !req.url.startsWith("/api/") &&
      req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document";
    if (req.headers["sec-fetch-site"] === "cross-site" && !topLevelPage)
      return res.code(403).send({ error: "Cross-site request refused" });
    if (req.url.startsWith("/api/")) res.header("Cache-Control", "no-store");
    if (!req.url.startsWith("/api/") || req.url === "/api/session") return;
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(sessionCookie + "="))
      ?.split("=")[1];
    const provided =
      req.headers.authorization?.replace(/^Bearer /, "") ?? cookie ?? "";
    const a = Buffer.from(provided),
      b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return res.code(401).send({ error: "Local session required" });
  });
  remote?.register(app);
  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/api/access", () => ({ remote: Boolean(remote) }));
  app.setErrorHandler((error, req, res) => {
    if (error instanceof z.ZodError)
      return res.code(422).send({
        error: "Invalid request",
        fields: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (error instanceof ProviderError)
      return res.code(409).send({ error: error.message, code: error.code });
    res
      .code(
        error instanceof Error && error.message.includes("not found")
          ? 404
          : 400,
      )
      .send({
        error:
          "The request could not be completed. Check the supplied settings.",
      });
  });
  app.get("/api/session", async (_, res) => {
    usage.record("workspace_opened", null, true);
    if (remote) return { product: identity.name, remote: true };
    res.header(
      "Set-Cookie",
      sessionCookie + "=" + token + "; HttpOnly; SameSite=Strict; Path=/",
    );
    res.header("Cache-Control", "no-store");
    return { product: identity.name };
  });
  app.get("/api/settings/usage-sharing", () => usage.status());
  app.get('/api/settings/website-icons', () => ({ enabled: store.setting('cachedWebsiteIcons', true) }));
  app.put('/api/settings/website-icons', (req) => {
    const input = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    store.set('cachedWebsiteIcons', input.enabled);
    if (!input.enabled) siteIcons.disableCached();
    return input;
  });
  app.put("/api/settings/usage-sharing", (req, res) => {
    const input = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
    if (!input.success) return res.code(400).send({ error: "Choose whether to share usage." });
    return usage.setEnabled(input.data.enabled);
  });
  app.get("/api/projects", () => store.projects());
  app.get("/api/onboarding", () => {
    const saved = store.setting<any>("onboarding", null);
    if (saved) return { ...saved, draft: store.setting("setupDraft", null) };
    const state = { completed: store.projects().length > 0 };
    store.set("onboarding", state);
    return { ...state, draft: null };
  });
  app.put("/api/onboarding/draft", (req) => {
    const draft = setupDraft.nullable().parse(req.body);
    if (draft?.projectId) store.project(draft.projectId);
    validateSetupJobs(draft);
    store.set("setupDraft", draft);
    return { saved: true };
  });
  app.post("/api/onboarding/website", (req) => {
    const input = z.object({ project: projectInput, draft: setupDraft }).strict().parse(req.body);
    const project = parseProject(input.project);
    return store.db.transaction(() => {
      const pending = store.setting<z.infer<typeof setupDraft> | null>("setupDraft", null);
      const existingId = input.draft.projectId ?? pending?.projectId;
      const saved = existingId ? store.updateProject(existingId, project) : store.createProject(project);
      const draft = { ...input.draft, projectId: saved.id };
      validateSetupJobs(draft);
      store.set("setupDraft", draft);
      return { project: saved, draft };
    })();
  });
  app.post("/api/onboarding/start", (req) => {
    const { backgroundCrawl, ...draft } = setupDraft.extend({ backgroundCrawl: z.boolean().default(false) }).parse(req.body);
    if (!draft.projectId) throw new ProviderError("setup", "Add a website before finishing setup.");
    const project = store.project(draft.projectId);
    if (!draft.localOnly && !vault.status()[draft.provider])
      throw new ProviderError("setup", "Reconnect your selected provider, or choose local audits only.");
    if (!draft.localOnly && ["dataforseo", "openrouter"].includes(draft.provider) && !(vault.status().dataforseo && vault.status().openrouter))
      throw new ProviderError("setup", "Connect both DataForSEO and OpenRouter for measurements, analysis and content.");
    // Finishing setup is one durable transaction, so an interrupted response cannot queue duplicate audits.
    return store.db.transaction(() => {
      const backgroundAudit = backgroundCrawl ? setupAudit(project, 10000, true) : null;
      const job = draft.localOnly ? backgroundAudit ?? setupAudit(project) : null;
      const consent = store.setting<{ enabled: boolean } | null>("usageConsent", null);
      if (!consent && !store.setting<any>("onboarding", null)?.completed) usage.setEnabled(usage.status().enabled);
      store.set("onboarding", { completed: true });
      store.set("setupDraft", null);
      usage.record("setup_completed", null, true);
      return { project, job };
    })();
  });
  app.post("/api/onboarding/questions", (req) => {
    const { requestId, ...input } = z.object({ projectId: z.string().uuid(), provider: z.enum(["chatgpt", "openrouter", "console"]), maxCostUsd: z.number().finite().min(0).max(100).default(0), requestId: z.string().uuid().optional() }).strict().parse(req.body);
    const project = store.project(input.projectId);
    if (!vault.status()[input.provider]) throw new ProviderError("auth", "Connect your chosen AI provider first.");
    return store.db.transaction(() => {
      const audit = setupAudit(project, 6);
      const key = createHash("sha256").update(JSON.stringify([questionDiscoveryVersion, project.domain, project.brand, project.aliases, project.locale, project.knowledge.slice(0, 4000), input.provider, input.maxCostUsd])).digest("hex");
      const active = store.jobs(project.id).find(job => job.kind === "discover" && ["queued", "running", "paused"].includes(job.status) && JSON.parse(store.step(job.id, "suggestionsContext")?.body ?? "null") === key);
      const job = active ?? store.enqueue(jobInput.parse({ ...input, kind: "discover", auditJobId: audit.id }), "setup-questions:" + project.id + ":" + key + (requestId ? ":" + requestId : ""));
      if (!store.step(job.id, "suggestionsContext")) store.setStep(job.id, "suggestionsContext", "done", key);
      if (!store.step(job.id, "project")) store.setStep(job.id, "project", "done", project);
      const draft = store.setting<any>("setupDraft", null);
      if (draft?.projectId === project.id) store.set("setupDraft", { ...draft, discoveryJobId: job.id });
      return job;
    })();
  });
  app.post("/api/onboarding/check", (req) => {
    const { projectId } = z.object({ projectId: z.string().uuid() }).strict().parse(req.body);
    const project = store.project(projectId);
    if (!vault.status().chatgpt) throw new ProviderError("auth", "Reconnect ChatGPT before checking your questions.");
    if (!project.prompts.length) throw new ProviderError("setup", "Select at least one question to check.");
    return store.db.transaction(() => {
      const key = createHash("sha256").update(JSON.stringify([project.domain, project.brand, project.aliases, project.prompts, project.locale])).digest("hex");
      const job = store.enqueue(jobInput.parse({ projectId, kind: "measure", provider: "chatgpt", discoverCompetitors: true, prepareRecommendations: true }), "setup-check:" + projectId + ":" + key);
      if (!store.step(job.id, "project")) store.setStep(job.id, "project", "done", project);
      const draft = store.setting<any>("setupDraft", null);
      if (draft?.projectId === projectId) store.set("setupDraft", { ...draft, checkJobId: job.id });
      return job;
    })();
  });
  /** Setup reuses an active or finished audit of this domain, so retried requests never queue a second one; an audit that did not finish is replaced rather than awaited. */
  function setupAudit(project: import("./contracts.js").Project, maxPages = 100, background = false) {
    const usable = store.jobs(project.id).find(job => job.kind === "audit" && ["queued", "running", "paused", "completed"].includes(job.status) &&
      (!background || job.maxPages >= maxPages) && JSON.parse(store.step(job.id, "project")?.body ?? "null")?.domain === project.domain);
    if (usable) return usable;
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit", maxCostUsd: 0, maxPages, ...(background ? { background: true } : {}) }), "setup-audit:" + project.id + ":" + randomUUID());
    store.setStep(job.id, "project", "done", project);
    return job;
  }
  function validateSetupJobs(draft: z.infer<typeof setupDraft> | null) {
    for (const [id, kind] of [[draft?.discoveryJobId, "discover"], [draft?.checkJobId, "measure"]]) {
      if (!id) continue;
      const job = store.job(id);
      if (job.projectId !== draft?.projectId || job.kind !== kind)
        throw new ProviderError("setup", "This setup task belongs to a different website.");
    }
  }
  app.post(
    "/api/import/preview",
    (req) => previewImport(store, req.body).summary,
  );
  function restoreWork<T>(restore: () => T): T {
    return store.db.transaction(() => {
      const firstProject = store.projects().length === 0;
      const result = restore();
      if (firstProject && store.projects().length > 0) {
        store.set("onboarding", { completed: true });
        store.set("setupDraft", null);
        // Restoring history does not grant consent or start a new workflow.
        if (store.setting("usageConsent", null) === null) store.set("usageSetupDefault", false);
      }
      return result;
    })();
  }
  app.post("/api/import", (req) => restoreWork(() => importProject(store, req.body)));
  app.get("/api/backup", () => ({
    format: "opengeo-backup",
    version: 1,
    projects: store.projects().map((p) => exportProject(store, p.id)),
  }));
  app.post("/api/backup/preview", (req) => previewRestore(store, req.body));
  app.post("/api/backup/restore", (req) => restoreWork(() => restoreBackup(store, req.body)));
  const parseProject = (raw: unknown) => {
    const input = projectInput.parse(raw);
    try { input.domain = publicUrl(input.domain).hostname.replace(/^www\./, ""); }
    catch { throw new z.ZodError([{ code: "custom", path: ["domain"], message: "Enter a public website address without embedded credentials." }]); }
    for (const [index, competitor] of input.competitors.entries()) {
      try { publicUrl(competitor); }
      catch { throw new z.ZodError([{ code: "custom", path: ["competitors", index], message: "Enter a public competitor website without embedded credentials." }]); }
    }
    input.topics = normalizeTopics(input);
    return input;
  };
  app.post("/api/projects", (req) =>
    store.createProject(parseProject(req.body)),
  );
  app.put("/api/projects/:id", (req) =>
    store.updateProject((req.params as any).id, parseProject(req.body)),
  );
  app.patch("/api/projects/:id", (req) => {
    const id = (req.params as any).id;
    const parsed = projectInput.omit({ domain: true }).partial().parse(req.body);
    const patch = Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(req.body as object, key)));
    const { id: _id, createdAt: _createdAt, ...current } = store.project(id);
    return store.updateProject(id, parseProject({ ...current, ...patch }));
  });
  app.delete("/api/projects/:id", (req) => {
    const input = z.object({ confirmation: z.string() }).strict().parse(req.body);
    if (runner.hasActiveProject((req.params as any).id)) throw new ProviderError('in_progress', 'Wait for this brand\'s current scan or cancellation to finish.');
    return store.deleteProject((req.params as any).id, input.confirmation);
  });
  app.post('/api/projects/:id/prompts', (req) => {
    const input = z.object({ prompts: z.array(z.string().trim().min(3).max(500)).min(1).max(200) }).strict().parse(req.body);
    return store.db.transaction(() => {
      const id = (req.params as { id: string }).id;
      const { id: _id, createdAt: _createdAt, ...current } = store.project(id);
      const known = new Set(current.prompts.map(text => text.trim().toLocaleLowerCase()));
      const added = input.prompts.filter(text => {
        const key = text.toLocaleLowerCase();
        if (known.has(key)) return false;
        known.add(key); return true;
      });
      return store.updateProject(id, parseProject({ ...current, prompts: [...current.prompts, ...added] }));
    })();
  });
  app.get("/api/projects/:id/workspace", (req, res) => {
    const id = (req.params as any).id;
    const { pages: pageMode } = z.object({ pages: z.enum(['full', 'lazy']).default('full') }).strict().parse(req.query);
    // Read the revision first: a concurrent external write during assembly must invalidate the next poll.
    const revision = store.workspaceRevision();
    const etag = '"' + createHash('sha256').update(id + ':' + pageMode + ':' + revision).digest('hex') + '"';
    const project = store.project(id);
    // Authorization and project existence are checked before accepting the browser's in-memory validator.
    res.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.code(304).send();
    const jobs = store.jobs(id),
      brandJobs = jobs.filter((job) => !job.topicId);
    const audit = jobs.find(
        (j) => j.kind === "audit" && (j.status === "completed" || ['queued', 'running', 'paused'].includes(j.status) && store.pageCount(id, j.id) > 0),
      ),
      measure = displayedMeasurement(brandJobs, (job) => store.answerCount(id, job.id));
    const observations = measure ? store.observations(id, measure.id) : [];
    const snapshot = measure ? store.step(measure.id, "project") : undefined;
    const prompts = snapshot?.body
      ? JSON.parse(snapshot.body).prompts
      : project.prompts;
    const coverage = auditCoverage.safeParse((audit?.result as any)?.coverage);
    const pages = audit && pageMode === 'full' ? store.pageSummaries(id, audit.id) : [];
    const pageFindings = new Map<string, Finding[] | null>();
    const auditJobs = new Set(jobs.filter(job => job.kind === 'audit').map(job => job.id));
    const findings = currentFindings(pageMode === 'lazy' ? store.nonAuditFindings(id) : store.findings(id), jobs, audit?.id).map(finding => {
      if (!auditJobs.has(finding.jobId)) return finding;
      // Accepted older work still needs its original evidence, but polling must not load every historical crawl.
      const current = finding.evidenceIds.map(evidenceId => {
        if (!pageFindings.has(evidenceId)) {
          const page = store.pageEvidence(id, evidenceId);
          pageFindings.set(evidenceId, page ? auditFindings(project, finding.jobId, [page]) : null);
        }
        return pageFindings.get(evidenceId);
      }).find(Boolean);
      const copy = current?.find(item => item.kind === finding.kind);
      return copy ? { ...finding, title: copy.title, description: copy.description, steps: copy.steps } : finding;
    });
    const metrics = measurementMetrics(measure, observations, measure ? prompts.length : 0);
    const presentation = workspacePresentation(brandJobs, measure, observations,
      snapshot?.body ? prompts : measure ? null : project.prompts, metrics.requested, pages);
    if (pageMode === 'lazy' && audit) presentation.audit = store.pageCatalog.summary(id, audit.id);
    const auditCounts = pageMode === 'lazy' ? store.pageCatalog.findingCounts(id, audit?.id) : { total: 0, done: 0 };
    return {
      project,
      jobs,
      auditCoverage: coverage.success ? coverage.data : null,
      pages,
      pageMode,
      auditId: audit?.id ?? null,
      revision,
      findingCounts: { total: findings.length + auditCounts.total, done: findings.filter(finding => finding.status === 'done').length + auditCounts.done },
      observations,
      findings,
      content: store.artifacts(id, "content"),
      metrics,
      presentation: { ...presentation, history: withTopicChecks(presentation.history, jobs, project) },
      measurement: measure ?? null,
      comparison: recheckComparison(brandJobs),
      competitors: competitorEvidence(project, observations),
      topics: topicSummaries(store, project, jobs),
    };
  });
  app.get('/api/projects/:id/checks/:check/pages', (req, res) => {
    const { id, check } = z.object({ id: z.string().uuid(), check: z.string().uuid() }).parse(req.params);
    store.project(id);
    const job = store.job(check);
    if (job.projectId !== id || job.kind !== 'audit') return res.code(404).send({ error: 'Website check not found' });
    const input = z.object({
      query: z.string().max(300).default(''),
      tab: z.enum(['all', 'attention', 'unavailable', 'excluded']).default('all'),
      grouping: z.enum(['type', 'folder', 'none']).default('type'), group: z.string().max(500).optional(),
      offset: z.coerce.number().int().min(0).max(1000000).default(0),
      limit: z.coerce.number().int().min(1).max(50).default(10),
      groupOffset: z.coerce.number().int().min(0).max(1000000).default(0),
    }).strict().parse(req.query);
    return { checkId: check, ...store.pageCatalog.list(id, check, input) };
  });
  app.get('/api/projects/:id/checks/:check/page-suggestions', (req, res) => {
    const { id, check } = z.object({ id: z.string().uuid(), check: z.string().uuid() }).parse(req.params);
    store.project(id);
    const job = store.job(check);
    if (job.projectId !== id || job.kind !== 'audit') return res.code(404).send({ error: 'Website check not found' });
    const { query } = z.object({ query: z.string().max(300).default('') }).strict().parse(req.query);
    return { pages: store.pageCatalog.suggestions(id, check, query) };
  });
  app.get('/api/projects/:id/checks/:check/pages/:page', (req, res) => {
    const { id, check, page: pageId } = z.object({ id: z.string().uuid(), check: z.string().uuid(), page: z.string().uuid() }).parse(req.params);
    const project = store.project(id), job = store.job(check);
    if (job.projectId !== id || job.kind !== 'audit') return res.code(404).send({ error: 'Website check not found' });
    const page = store.pageCatalog.page(id, check, pageId);
    if (!page) return res.code(404).send({ error: 'Page not found' });
    const originals = new Map<string, ReturnType<Store['pageEvidence']>>();
    const findings = store.pageCatalog.findings(id, check, page.url).map(finding => {
      const evidence = finding.evidenceIds.map(evidenceId => {
        if (!originals.has(evidenceId)) originals.set(evidenceId, store.pageEvidence(id, evidenceId));
        return originals.get(evidenceId);
      }).find(Boolean);
      return evidence ? auditFindingPresentation(project, finding, evidence) : finding;
    });
    return { page, findings };
  });
  app.get("/api/projects/:id/topics/:topic", (req) => {
    const { id, topic } = req.params as { id: string; topic: string };
    const project = store.project(id), found = project.topics.find((item) => item.id === topic);
    if (!found) throw new Error("Topic not found");
    return topicView(store, project, found);
  });
  app.get("/api/projects/:id/site-icon", async (req, res) => {
    const id = (req.params as any).id;
    const { domain } = z.object({ domain: z.string().regex(/^[a-z0-9.-]{1,253}$/) }).strict().parse(req.query);
    const project = store.project(id);
    const known = new Set([project.domain, ...project.competitors.map(value => publicUrl(value).hostname)]);
    for (const observation of store.observations(id)) for (const citation of observation.citations) {
      try { known.add(publicUrl(citation.url).hostname); } catch { /* Invalid historical links cannot authorize network requests. */ }
    }
    if (![...known].some(host => host.replace(/^www\./, "") === domain.replace(/^www\./, ""))) return res.code(404).send();
    const icon = await siteIcons.get(domain);
    if (!icon) return res.code(404).send();
    return res.header("Cache-Control", "private, max-age=86400").type(icon.contentType).send(icon.bytes);
  });
  app.get('/api/projects/:id/checks/:check/answers', (req, res) => {
    const { id, check } = z.object({ id: z.string().uuid(), check: z.string().uuid() }).parse(req.params);
    store.project(id);
    const job = store.job(check);
    if (job.projectId !== id || !['measure', 'recheck'].includes(job.kind)) return res.code(404).send();
    return store.observations(id, check);
  });
  app.patch("/api/projects/:id/findings/:finding", (req) => {
    const status = z
      .enum(["open", "doing", "done"])
      .parse((req.body as any)?.status);
    return store.patchFinding(
      (req.params as any).id,
      (req.params as any).finding,
      status,
    );
  });
  app.get("/api/projects/:id/findings/:finding/evidence", (req) => {
    const { id, finding } = req.params as { id: string; finding: string };
    store.project(id);
    const row = store.findings(id).find((f) => f.id === finding);
    if (!row) throw new Error("Finding not found");
    const { pages, sources, observations } = store.evidenceRecords(id, row.evidenceIds);
    const found = new Set([...pages, ...sources, ...observations].map((record) => record.id));
    return {
      pages,
      sources,
      observations,
      missing: row.evidenceIds.filter((key) => !found.has(key)).length,
    };
  });
  app.post("/api/jobs", (req) => {
    const input = jobInput.parse(req.body);
    if (input.topicId) topicScope(store.project(input.projectId), input.topicId);
    const key = z
      .string()
      .min(8)
      .max(200)
      .parse(req.headers["idempotency-key"]);
    return store.enqueue(input, key);
  });
  app.patch("/api/projects/:id/content/:content", (req) => {
    const input = z
      .object({ markdown: z.string().max(500000), baseMarkdown: z.string().max(500000).optional(), recoverySession: z.string().uuid().optional() })
      .strict()
      .parse(req.body);
    const params = req.params as any;
    return store.editContent(params.id, params.content, input.markdown, input.baseMarkdown, input.recoverySession);
  });
  app.post("/api/projects/:id/content/:content/recovery", (req) => {
    const { id, content } = req.params as { id: string; content: string };
    return store.openContentRecovery(id, content);
  });
  app.put("/api/projects/:id/content/:content/recovery", (req) => {
    const { id, content } = req.params as { id: string; content: string };
    const input = z.object({ session: z.string().uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), baseMarkdown: z.string().max(500000), markdown: z.string().max(500000) }).strict().parse(req.body);
    return store.protectContentEdit(id, content, input);
  });
  app.delete("/api/projects/:id/content/:content/recovery", (req) => {
    const { id, content } = req.params as { id: string; content: string };
    return store.discardContentRecovery(id, content);
  });
  app.get("/api/jobs/:id", (req) => store.job((req.params as any).id));
  app.post("/api/jobs/:id/cancel", (req) =>
    runner.cancel((req.params as any).id),
  );
  app.post("/api/jobs/:id/dismiss", (req) => store.dismissJob((req.params as any).id));
  app.get("/api/jobs/:id/resume-preview", (req) => runner.resumePreview((req.params as any).id));
  app.post("/api/jobs/:id/resume", (req) => {
    const input = z.object({ reviewed: z.boolean().default(false), maxCostUsd: z.number().finite().min(0).max(10000).optional() }).strict().parse(req.body ?? {});
    return runner.resume((req.params as any).id, input.reviewed, input.maxCostUsd);
  });
  app.get("/api/providers", () => ({
    connected: vault.status(),
    chatgpt: connections.profiles(),
    measurementRequestEstimateUsd: store.setting(
      "measurementRequestEstimateUsd",
      0,
    ),
  }));
  app.put("/api/providers", async (req) => {
    const input = credentialInput.parse(req.body);
    if (store.jobs().some((job) => job.provider === input.provider && job.status === "running"))
      throw new ProviderError("busy", "Stop the active workflow before changing this connection.");
    await p.validateConnection(input);
    if (store.jobs().some((job) => job.provider === input.provider && job.status === "running"))
      throw new ProviderError("busy", "Stop the active workflow before changing this connection.");
    vault.set(input.provider, input);
    return { connected: true };
  });
  app.delete("/api/providers/:provider", async (req) => {
    const provider = z.enum(providers).parse((req.params as any).provider);
    if (store.jobs().some((job) => job.provider === provider && job.status === "running"))
      throw new ProviderError("busy", "Stop the active workflow before disconnecting this provider.");
    if (provider === "chatgpt") return connections.signOut();
    vault.remove(provider);
    return { disconnected: true };
  });
  app.get("/api/providers/:provider/models", (req) =>
    p.models(
      z.enum(providers).parse((req.params as any).provider),
      z
        .enum(["chat_gpt", "gemini", "perplexity"])
        .parse((req.query as any)?.platform ?? "chat_gpt"),
    ),
  );
  app.get("/api/providers/console/capabilities", async () => {
    const result = await p.console("/capabilities");
    return consoleCapabilities(result.data);
  });
  app.post("/api/connections/:provider/start", (req) => {
    const provider = z
      .enum(["chatgpt", "openrouter"])
      .parse((req.params as any).provider);
    const input = z
      .object({
        profileId: z.string().optional(),
        headless: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return connections.start(provider, input.profileId, remote && provider === "openrouter" ? true : input.headless)
      .then(result => ({ ...result, manualCallback: Boolean(remote) && provider === "chatgpt" }));
  });
  app.post("/api/connections/chatgpt/finish", async (req) => {
    const input = z.object({ state: z.string().min(32).max(100), callback: z.string().max(8192) }).strict().parse(req.body);
    await connections.completeCallback(input.state, input.callback);
    return { connected: true };
  });
  app.get("/api/connections/:provider/status", (req) => {
    const provider = z.enum(["chatgpt", "openrouter"]).parse((req.params as any).provider);
    const state = z.string().min(32).max(100).parse((req.query as any)?.state);
    return connections.status(provider, state);
  });
  app.post("/api/connections/openrouter/finish", async (req) => {
    const input = z
      .object({ state: z.string(), code: z.string() })
      .parse(req.body);
    await connections.finish(
      input.state,
      new URLSearchParams({ code: input.code }),
    );
    return { connected: true };
  });
  app.post("/api/connections/chatgpt/select", (req) => {
    if (
      store
        .jobs()
        .some((j) => j.provider === "chatgpt" && j.status === "running")
    )
      throw new ProviderError(
        "busy",
        "Wait for the active ChatGPT workflow to finish before changing accounts.",
      );
    connections.select(z.string().parse((req.body as any)?.id));
    return { selected: true };
  });
  app.put("/api/settings/measurement-estimate", (req) => {
    const { amount } = z.object({ amount: z
      .number()
      .finite()
      .positive()
      .max(100) }).strict().parse(req.body);
    store.set("measurementRequestEstimateUsd", amount);
    return { amount };
  });
  app.post("/api/connections/chatgpt/acknowledge-plan", () => {
    connections.acknowledgePlan();
    return { acknowledged: true };
  });
  app.get("/api/schedules", () => scheduler.list());
  app.post("/api/schedules", (req) => scheduler.add(req.body, z.string().min(8).max(200).parse(req.headers["idempotency-key"])));
  app.delete("/api/schedules/:id", (req) => {
    scheduler.remove((req.params as any).id);
    return { removed: true };
  });
  app.get("/api/projects/:id/export", (_req, res) => {
    const id = (_req.params as any).id;
    res.header(
      "Content-Disposition",
      'attachment; filename="opengeo-project.json"',
    );
    return exportProject(store, id);
  });
  app.get("/api/projects/:id/report", (_req, res) => {
    const text = reportMarkdown(store, (_req.params as any).id);
    usage.record("report_exported", null, true);
    if ((_req.query as any)?.format === "html") {
      res.type("text/html");
      return htmlDocument(identity.name + " report", text);
    }
    res.header(
      "Content-Disposition",
      'attachment; filename="opengeo-report.md"',
    );
    res.type("text/markdown");
    return text;
  });
  const root = staticRoot;
  if (existsSync(root)) {
    await app.register(staticFiles, { root });
    app.setNotFoundHandler((req, res) => {
      if (req.url.startsWith("/api/"))
        return res.code(404).send({ error: "Not found" });
      return res.sendFile("index.html");
    });
  }
  app.addHook("onClose", async () => {
    await usage.close();
    store.onJobCompleted = undefined;
    store.onImprovementCompleted = undefined;
    await runner.stop();
    scheduler.stop();
    connections.close();
  });
  return { app, runner, scheduler, token, usage };
}
