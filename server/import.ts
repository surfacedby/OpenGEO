import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./storage.js";
import { projectInput, providers, jobKinds } from "./contracts.js";
import { publicUrl } from "./network.js";
import { portableJobResult } from "./portable-results.js";
import { summarize } from "./analysis.js";
const date = z.string().datetime({ offset: true });
const id = z.string().min(1).max(200);
const safeUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      publicUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "Use a public HTTP URL without credentials");
const citation = z
  .object({ url: safeUrl, title: z.string().optional() })
  .strict();
const page = z
  .object({
    id,
    jobId: id.optional(),
    url: z.string().url(),
    fetchedAt: date,
    status: z.number().int(),
    title: z.string(),
    description: z.string(),
    h1: z.array(z.string()),
    text: z.string(),
    canonical: z.string(),
    noindex: z.boolean(),
    schemaTypes: z.array(z.string()),
    links: z.array(z.string()),
  })
  .strict();
const observation = z
  .object({
    id,
    projectId: id,
    jobId: id,
    prompt: z.string(),
    provider: z.enum(providers),
    platform: z.string(),
    model: z.string(),
    locale: z.string(),
    observedAt: date,
    answer: z.string(),
    citations: z.array(citation),
    surface: z.literal("api"),
    retrieval: z.enum(["web_search", "model_only", "provider_managed"]).optional(),
    webSearchConfirmed: z.boolean().optional(),
    mentioned: z.boolean(),
    cited: z.boolean(),
    costUsd: z.number().nullable(),
  })
  .strict();
const finding = z
  .object({
    id,
    projectId: id,
    jobId: id,
    title: z.string(),
    description: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    targetUrl: z.string(),
    evidenceIds: z.array(id),
    steps: z.array(z.string()),
    confidence: z.enum(["known", "inferred"]),
    status: z.enum(["open", "doing", "done"]),
    kind: z.string(),
    remoteId: id.optional(),
    evidenceAsOf: z.string().nullable().optional(),
    remoteScanId: id.optional(),
  })
  .strict();
const content = z
  .object({
    id,
    jobId: id.optional(),
    topic: z.string(),
    locale: projectInput.shape.locale.optional(),
    markdown: z.string(),
    brief: z.string(),
    review: z
      .object({
        issues: z.array(
          z
            .object({
              claim: z.string(),
              reason: z.string(),
              evidenceIds: z.array(id),
            })
            .strict(),
        ),
        requiresHumanReview: z.boolean(),
      })
      .strict(),
    status: z.enum(["draft", "needs_review"]),
    reviewCurrent: z.boolean().optional(),
    sourceEvidence: z.array(z.object({ id, url: safeUrl, title: z.string() }).strict()).optional(),
    sourceCoverage: z.object({ pagesAvailable: z.number().int().nonnegative(), pagesUsed: z.number().int().nonnegative(), excerpts: z.boolean() }).strict()
      .refine(value => value.pagesUsed <= value.pagesAvailable).optional(),
    derivedFrom: id.optional(),
    revisionInstructions: z.string().max(2000).optional(),
    requiresHumanReview: z.literal(true),
    createdAt: date,
    model: z.string(),
    editedAt: date.optional(),
  })
  .strict();
export type PortableContent = z.infer<typeof content>;
const job = z
  .object({
    id,
    kind: z.enum(jobKinds),
    provider: z.enum(providers).optional(),
    model: z.string().optional(),
    platform: z.string(),
    status: z.enum([
      "queued",
      "running",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ]),
    createdAt: date,
    updatedAt: date,
    spentUsd: z.number().nonnegative(),
    costBasis: z.enum(['reported', 'includes_estimates']).optional(),
    result: z.unknown().optional(),
  })
  .strict();
export const migrationPackage = z
  .object({
    format: z.literal("opengeo-project"),
    version: z.literal(1),
    exportedAt: date,
    project: projectInput.extend({ id, createdAt: date }),
    jobs: z.array(job),
    pages: z.array(page),
    observations: z.array(observation),
    findings: z.array(finding),
    content: z.array(content),
  })
  .strict();
export function previewImport(store: Store, input: unknown) {
  const data = migrationPackage.parse(input);
  publicUrl(data.project.domain);
  for (const competitor of data.project.competitors) publicUrl(competitor);
  for (const row of data.pages) {
    publicUrl(row.url);
    for (const link of row.links) publicUrl(link);
  }
  for (const row of data.findings) if (row.targetUrl) publicUrl(row.targetUrl);
  const jobs = new Set(data.jobs.map((j) => j.id));
  if (jobs.size !== data.jobs.length) throw new Error("Duplicate job ids");
  const allIds = [...data.jobs, ...data.pages, ...data.observations, ...data.findings, ...data.content].map((row) => row.id);
  if (new Set(allIds).size !== allIds.length) throw new Error("Duplicate record ids");
  for (const row of [...data.pages, ...data.content])
    if (row.jobId && !jobs.has(row.jobId)) throw new Error("Evidence references an unknown job");
  for (const row of [...data.observations, ...data.findings])
    if (!jobs.has(row.jobId) || row.projectId !== data.project.id)
      throw new Error("Evidence belongs to a different project");
  return {
    data,
    summary: {
      domain: data.project.domain,
      pages: data.pages.length,
      observations: data.observations.length,
      drafts: data.content.length,
      existing: store
        .projects()
        .filter((p) => p.domain === data.project.domain)
        .map((p) => ({ id: p.id, domain: p.domain })),
      strategy:
        "Create an independent local project. Existing work is preserved.",
    },
  };
}
export const backupPackage = z
  .object({
    format: z.literal("opengeo-backup"),
    version: z.literal(1),
    projects: z.array(migrationPackage),
  })
  .strict();
export function previewRestore(store: Store, input: unknown) {
  const backup = backupPackage.parse(input);
  return backup.projects.map(
    (project) => previewImport(store, project).summary,
  );
}
export function restoreBackup(store: Store, input: unknown) {
  const backup = backupPackage.parse(input);
  previewRestore(store, backup);
  return store.db.transaction(() =>
    backup.projects.map((project) => importProject(store, project)),
  )();
}

/** Imports retain collection provenance and never enqueue historical paid work. */
export function importProject(store: Store, input: unknown) {
  const { data } = previewImport(store, input);
  const digest = createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
  const prior = store.setting<string | null>("import:" + digest, null);
  if (prior) return { project: store.project(prior), replayed: true };
  return store.db.transaction(() => {
    const { id: oldId, createdAt, ...configuration } = data.project;
    const project = store.createProject(configuration);
    const ids = new Map<string, string>();
    for (const row of [
      ...data.jobs,
      ...data.pages,
      ...data.observations,
      ...data.findings,
      ...data.content,
    ]) {
      if (ids.has(row.id)) throw new Error("Duplicate ids");
      ids.set(row.id, randomUUID());
    }
    for (const old of [...data.jobs].reverse()) {
      const measurement = portableJobResult(old);
      const observations = data.observations.filter((row) => row.jobId === old.id);
      const measuredResult = measurement && measurement.metrics.completed === observations.length
        ? { ...measurement, metrics: summarize(observations, measurement.metrics.requested) } : null;
      const restored = {
        ...old,
        id: ids.get(old.id)!,
        projectId: project.id,
        status: old.status === "completed" ? "completed" : "cancelled",
        maxCostUsd: 0,
        render: false,
        webSearch: false,
        step: 0,
        progress: "Imported historical work. Original status: " + old.status,
        error: null,
        result: measuredResult,
        importedAt: new Date().toISOString(),
        originalId: old.id,
      };
      store.db
        .prepare("INSERT INTO jobs VALUES(?,?,?,?,?)")
        .run(
          restored.id,
          project.id,
          restored.status,
          JSON.stringify(restored),
          "import:" + digest + ":" + old.id,
        );
    }
    // Older version-one exports omit page/draft job ownership. Only those
    // records need a synthetic historical container; it must not become the
    // newest completed audit when every record has its original job mapping.
    const needsFallback = [...data.pages, ...data.content].some((row) => !row.jobId);
    const fallback = needsFallback ? store.enqueue(
      {
        projectId: project.id,
        kind: "audit",
        platform: "chat_gpt",
        maxCostUsd: 0,
        render: false,
        webSearch: false,
        maxPages: 100,
      },
      "import:" + digest + ":artifacts",
    ) : null;
    if (fallback) store.updateJob(fallback.id, {
      status: "completed",
      progress: "Imported historical evidence",
      result: { imported: true },
    });
    for (const [kind, rows] of [
      ["page", data.pages],
      ["observation", data.observations],
      ["finding", data.findings],
      ["content", data.content],
    ] as const)
      for (const old of [...rows].reverse()) {
        const row = old as any;
        const jobId = ids.get(row.jobId) ?? fallback?.id;
        if (!jobId) throw new Error("Evidence references an unknown job");
        store.put(kind, project.id, jobId, {
          ...row,
          id: ids.get(row.id),
          ...("projectId" in row ? { projectId: project.id } : {}),
          ...("jobId" in row ? { jobId } : {}),
          ...("evidenceIds" in row
            ? {
                evidenceIds: row.evidenceIds.map(
                  (id: string) => ids.get(id) ?? id,
                ),
              }
            : {}),
          ...(kind === "content"
            ? {
                brief: row.brief.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (reference: string) => ids.get(reference) ?? reference),
                review: {
                  ...row.review,
                  issues: row.review.issues.map((issue: any) => ({
                    ...issue,
                    evidenceIds: issue.evidenceIds.map(
                      (id: string) => ids.get(id) ?? id,
                    ),
                  })),
                },
                ...(row.sourceEvidence ? { sourceEvidence: row.sourceEvidence.map((source: any) => ({ ...source, id: ids.get(source.id) ?? source.id })) } : {}),
                ...(row.derivedFrom ? { derivedFrom: ids.get(row.derivedFrom) ?? row.derivedFrom } : {}),
              }
            : {}),
        });
      }
    store.set("import:" + digest, project.id);
    return { project, replayed: false };
  })();
}
