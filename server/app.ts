import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Store } from "./storage.js";
import { Vault } from "./vault.js";
import identity from "../brand/identity.json";
import { Connections } from "./oauth.js";
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
} from "./contracts.js";
import { publicUrl } from "./network.js";
import { workspacePresentation, currentFindings } from "./presentation.js";
import { SiteIcons } from "./site-icons.js";
import { completedMeasurement } from "./portable-results.js";
import { UsageSharing } from "./usage.js";
import {
  measurementMetrics,
  recheckComparison,
  competitorEvidence,
} from "./analysis.js";
import { exportProject, reportMarkdown } from "./export.js";
import { htmlDocument } from "./markdown.js";
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
) {
  const app = Fastify({ logger: false, bodyLimit: 20_000_000 });
  const sessionCookie = "opengeo_session_" + createHash("sha256").update(token).digest("hex").slice(0, 16);
  const siteIcons = new SiteIcons(undefined, () => store.setting('cachedWebsiteIcons', true));
  const usage = new UsageSharing(store);
  store.onJobCompleted = (kind, provider) => { if (kind !== "discover") usage.record(({ audit: "audit_completed", measure: "visibility_completed", recheck: "recheck_completed", diagnose: "analysis_completed", competitors: "analysis_completed", content: "content_created", revise: "content_revised" } as const)[kind], kind === "audit" ? null : provider ?? null); };
  store.onImprovementCompleted = () => usage.record("improvement_completed");
  const connections = new Connections(store, vault, () => {
      const address = app.server.address();
      return address && typeof address !== "string" ? "http://127.0.0.1:" + address.port : undefined;
    }, onConnected),
    p = new Providers(vault, connections),
    runner = new Runner(store, p),
    scheduler = new Scheduler(store);
  const permittedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  app.addHook("onRequest", async (req, res) => {
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
    if (req.headers["sec-fetch-site"] === "cross-site")
      return res.code(403).send({ error: "Cross-site request refused" });
    res.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.header("X-Content-Type-Options", "nosniff");
    res.header("Referrer-Policy", "no-referrer");
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
    const draft = setupDraft.parse(req.body);
    if (!draft.projectId) throw new ProviderError("setup", "Add a website before finishing setup.");
    const project = store.project(draft.projectId);
    if (!draft.localOnly && !vault.status()[draft.provider])
      throw new ProviderError("setup", "Reconnect your selected provider, or choose local audits only.");
    if (!draft.localOnly && ["dataforseo", "openrouter"].includes(draft.provider) && !(vault.status().dataforseo && vault.status().openrouter))
      throw new ProviderError("setup", "Connect both DataForSEO and OpenRouter for measurements, analysis and content.");
    // Finishing setup is one durable transaction, so an interrupted response cannot queue duplicate audits.
    return store.db.transaction(() => {
      const job = setupAudit(project);
      const consent = store.setting<{ enabled: boolean } | null>("usageConsent", null);
      if (!consent && !store.setting<any>("onboarding", null)?.completed) usage.setEnabled(usage.status().enabled);
      store.set("onboarding", { completed: true });
      store.set("setupDraft", null);
      usage.record("setup_completed", null, true);
      return { project, job };
    })();
  });
  app.post("/api/onboarding/questions", (req) => {
    const { requestId, ...input } = z.object({ projectId: z.string().uuid(), provider: z.enum(["chatgpt", "openrouter"]), maxCostUsd: z.number().finite().min(0).max(100).default(0), requestId: z.string().uuid().optional() }).strict().parse(req.body);
    const project = store.project(input.projectId);
    if (!vault.status()[input.provider]) throw new ProviderError("auth", "Connect your chosen AI provider first.");
    return store.db.transaction(() => {
      setupAudit(project);
      const key = createHash("sha256").update(JSON.stringify([questionDiscoveryVersion, project.domain, project.brand, project.aliases, project.locale, project.knowledge.slice(0, 4000), input.provider, input.maxCostUsd])).digest("hex");
      const active = store.jobs(project.id).find(job => job.kind === "discover" && ["queued", "running", "paused"].includes(job.status) && JSON.parse(store.step(job.id, "suggestionsContext")?.body ?? "null") === key);
      const job = active ?? store.enqueue(jobInput.parse({ ...input, kind: "discover" }), "setup-questions:" + project.id + ":" + key + (requestId ? ":" + requestId : ""));
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
      const job = store.enqueue(jobInput.parse({ projectId, kind: "measure", provider: "chatgpt", discoverCompetitors: true }), "setup-check:" + projectId + ":" + key);
      if (!store.step(job.id, "project")) store.setStep(job.id, "project", "done", project);
      const draft = store.setting<any>("setupDraft", null);
      if (draft?.projectId === projectId) store.set("setupDraft", { ...draft, checkJobId: job.id });
      return job;
    })();
  });
  function setupAudit(project: import("./contracts.js").Project) {
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit", maxCostUsd: 0, maxPages: 100 }), "setup-audit:" + project.id + ":" + project.domain);
    if (!store.step(job.id, "project")) store.setStep(job.id, "project", "done", project);
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
  app.post("/api/import", (req) => importProject(store, req.body));
  app.get("/api/backup", () => ({
    format: "opengeo-backup",
    version: 1,
    projects: store.projects().map((p) => exportProject(store, p.id)),
  }));
  app.post("/api/backup/preview", (req) => previewRestore(store, req.body));
  app.post("/api/backup/restore", (req) => restoreBackup(store, req.body));
  const parseProject = (raw: unknown) => {
    const input = projectInput.parse(raw);
    try { input.domain = publicUrl(input.domain).hostname.replace(/^www\./, ""); }
    catch { throw new z.ZodError([{ code: "custom", path: ["domain"], message: "Enter a public website address without embedded credentials." }]); }
    for (const [index, competitor] of input.competitors.entries()) {
      try { publicUrl(competitor); }
      catch { throw new z.ZodError([{ code: "custom", path: ["competitors", index], message: "Enter a public competitor website without embedded credentials." }]); }
    }
    return input;
  };
  app.post("/api/projects", (req) =>
    store.createProject(parseProject(req.body)),
  );
  app.put("/api/projects/:id", (req) =>
    store.updateProject((req.params as any).id, parseProject(req.body)),
  );
  app.get("/api/projects/:id/workspace", (req) => {
    const id = (req.params as any).id;
    const project = store.project(id),
      jobs = store.jobs(id);
    const audit = jobs.find(
        (j) => j.kind === "audit" && j.status === "completed",
      ),
      measure = jobs.find(
        (j) =>
          ["measure", "recheck"].includes(j.kind) &&
          (["completed", "paused", "running", "failed"].includes(j.status) ||
            (j.status === "queued" && completedMeasurement(j))),
      );
    const observations = measure ? store.observations(id, measure.id) : [];
    const snapshot = measure ? store.step(measure.id, "project") : undefined;
    const prompts = snapshot?.body
      ? JSON.parse(snapshot.body).prompts
      : project.prompts;
    const coverage = auditCoverage.safeParse((audit?.result as any)?.coverage);
    const pages = audit ? store.pages(id, audit.id) : [];
    const metrics = measurementMetrics(measure, observations, measure ? prompts.length : 0);
    return {
      project,
      jobs,
      auditCoverage: coverage.success ? coverage.data : null,
      pages,
      observations,
      findings: currentFindings(store.findings(id), jobs),
      content: store.artifacts(id, "content"),
      metrics,
      presentation: workspacePresentation(jobs, measure, observations,
        snapshot?.body ? prompts : measure ? null : project.prompts, metrics.requested, pages),
      measurement: measure ?? null,
      comparison: recheckComparison(jobs),
      competitors: competitorEvidence(project, observations),
    };
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
    const ids = new Set(row.evidenceIds);
    const pages = store.pages(id).filter((page) => ids.has(page.id));
    const observations = store.observations(id).filter((answer) => ids.has(answer.id));
    const found = new Set([...pages, ...observations].map((record) => record.id));
    return {
      pages,
      observations,
      missing: row.evidenceIds.filter((key) => !found.has(key)).length,
    };
  });
  app.post("/api/jobs", (req) => {
    const input = jobInput.parse(req.body);
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
    return connections.start(provider, input.profileId, input.headless);
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
