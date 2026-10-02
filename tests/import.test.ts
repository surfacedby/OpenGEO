import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { projectInput, jobInput } from "../server/contracts.js";
import { exportProject, reportMarkdown } from "../server/export.js";
import { importProject, previewImport, restoreBackup } from "../server/import.js";
import { comparisonKey, recheckComparison, summarize } from "../server/analysis.js";
test("portable restore isolates projects, preserves evidence provenance, and cannot replay paid work", () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-import-test-")),
    store = new Store(directory);
  try {
    const project = store.createProject(
      projectInput.parse({ domain: "example.com", brand: "Example" }),
    );
    const job = store.enqueue(
      jobInput.parse({
        projectId: project.id,
        kind: "measure",
        provider: "dataforseo",
        maxCostUsd: 1,
      }),
      "portable-measure",
    );
    store.put("observation", project.id, job.id, {
      id: "original-observation",
      projectId: project.id,
      jobId: job.id,
      prompt: "An example?",
      provider: "dataforseo",
      platform: "chat_gpt",
      model: "model",
      locale: "en-US",
      observedAt: "2026-09-01T10:00:00Z",
      answer: "Example",
      citations: [{ url: "https://example.com" }],
      surface: "api",
      mentioned: true,
      cited: true,
      costUsd: 0.1,
    });
    const source = exportProject(store, project.id),
      restored = importProject(store, source);
    assert.notEqual(restored.project.id, project.id);
    const evidence = store.observations(restored.project.id)[0];
    assert.equal(evidence.observedAt, "2026-09-01T10:00:00Z");
    assert.equal(evidence.provider, "dataforseo");
    assert.notEqual(evidence.id, "original-observation");
    assert.equal(evidence.projectId, restored.project.id);
    assert.equal(store.job(evidence.jobId).status, "cancelled");
    assert.equal(importProject(store, source).project.id, restored.project.id);
    for (const surface of ["consumer_interface", "unknown"] as const) {
      const copy = importProject(store, { ...source, observations: [{ ...source.observations[0], surface }] });
      assert.equal(store.observations(copy.project.id)[0].surface, surface);
      assert.equal(store.job(store.observations(copy.project.id)[0].jobId).status, "cancelled");
    }
    const before = store.projects().length;
    assert.throws(() =>
      restoreBackup(store, {
        format: "opengeo-backup",
        version: 1,
        projects: [
          {
            ...source,
            project: { ...source.project, credentials: "never-accepted" },
          },
        ],
      }),
    );
    assert.equal(store.projects().length, before);
    assert.throws(() =>
      importProject(store, {
        ...source,
        observations: [
          {
            ...source.observations[0],
            citations: [{ url: "http://127.0.0.1/private" }],
          },
        ],
      }),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore preserves run order, current drafts, comparable checks and artifact ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-history-restore-")), store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example", prompts: ["An example?"] }));
    for (const [index, kind] of ["measure", "recheck"].entries()) {
      const job = store.enqueue(jobInput.parse({ projectId: project.id, kind, provider: "chatgpt", model: "fixture-model" }), "history-" + kind);
      const observation = { id: "answer-" + index, projectId: project.id, jobId: job.id,
        prompt: project.prompts[0], provider: "chatgpt" as const, platform: "chat_gpt", model: "fixture-model",
        locale: "en-US", observedAt: "2026-09-0" + (index + 1) + "T10:00:00Z", answer: index ? "Example" : "Another brand",
        citations: [], surface: "api" as const, mentioned: Boolean(index), cited: false, costUsd: 0 };
      store.put("observation", project.id, job.id, observation);
      store.updateJob(job.id, { status: "completed", result: { metrics: summarize([observation], 1),
        comparisonKey: comparisonKey(project, job, [observation]), credentials: "synthetic-must-not-export" } });
    }
    for (const index of [1, 2]) {
      const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "chatgpt" }), "draft-" + index);
      store.put("content", project.id, job.id, { id: "draft-" + index, topic: "Example topic", markdown: "Draft " + index,
        brief: "Example brief", review: { issues: [], requiresHumanReview: false }, status: "draft",
        requiresHumanReview: true, createdAt: "2026-09-0" + index + "T12:00:00Z", model: "fixture-model" });
      store.updateJob(job.id, { status: "completed" });
    }
    const source = exportProject(store, project.id);
    assert.equal(JSON.stringify(source).includes("synthetic-must-not-export"), false);
    const restored = importProject(store, source).project, restoredJobs = store.jobs(restored.id);
    assert.deepEqual(restoredJobs.map((job) => job.kind), source.jobs.map((job) => job.kind));
    assert.equal(restoredJobs.length, source.jobs.length);
    const drafts = store.artifacts<any>(restored.id, "content");
    assert.equal(drafts[0].markdown, "Draft 2");
    assert.equal(store.job(drafts[0].jobId).kind, "content");
    const comparison = recheckComparison(restoredJobs);
    assert.equal(comparison?.status, "comparable");
    assert.equal(comparison && "mentionPoints" in comparison ? comparison.mentionPoints : null, 100);
    assert.match(reportMarkdown(store, restored.id), /Brand mentions: 100\.0%/);
    assert.equal(restoredJobs.filter((job) => ["queued", "running", "paused"].includes(job.status)).length, 0);
    const before = store.projects().length;
    assert.throws(() => previewImport(store, { ...source, content: [{ ...source.content[0], jobId: "foreign-job" }] }));
    assert.throws(() => previewImport(store, { ...source, content: [{ ...source.content[0], id: source.observations[0].id }] }));
    assert.equal(store.projects().length, before);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
