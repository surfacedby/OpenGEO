import test from "node:test";
import assert from "node:assert/strict";
import { runsNeedingAttention } from "../src/runs.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/storage.js";
import { jobInput, projectInput, ProviderError, type Job } from "../server/contracts.js";

const run = (id: string, kind: Job["kind"], status: Job["status"], createdAt: string, error: string | null = null) =>
  ({ id, kind, status, createdAt, error }) as Job;

test("only active, interrupted and unresolved runs ask for attention", () => {
  const jobs = [
    run("audit-done", "audit", "completed", "2026-10-01T09:00:00Z"),
    run("check-running", "recheck", "running", "2026-10-03T09:00:00Z"),
    run("draft-paused", "content", "paused", "2026-10-02T09:00:00Z"),
    run("analysis-failed", "diagnose", "failed", "2026-10-02T09:00:00Z"),
    run("cancelled-locally", "measure", "cancelled", "2026-10-01T09:00:00Z"),
    run("remote-unconfirmed", "content", "cancelled", "2026-10-01T10:00:00Z", "cancel_remote"),
  ];
  assert.deepEqual(runsNeedingAttention(jobs).map((job) => job.id), ["check-running", "draft-paused", "analysis-failed", "remote-unconfirmed"]);
  assert.deepEqual(runsNeedingAttention(jobs, ["audit"]), []);
});

test("a later completed run of the same family resolves an earlier failure", () => {
  const failed = run("check-failed", "measure", "failed", "2026-10-01T09:00:00Z");
  assert.deepEqual(runsNeedingAttention([run("recheck-done", "recheck", "completed", "2026-10-02T09:00:00Z"), failed]), []);
  assert.deepEqual(runsNeedingAttention([run("older-done", "recheck", "completed", "2026-09-30T09:00:00Z"), failed]).map((job) => job.id), ["check-failed"]);
  assert.deepEqual(runsNeedingAttention([run("audit-done", "audit", "completed", "2026-10-02T09:00:00Z"), failed]).map((job) => job.id), ["check-failed"], "another kind of run does not resolve it");
});

test("failures resolve per piece of work, can be dismissed, and setup-only or answered runs stay out", () => {
  const draftFailed = { ...run("draft-x-failed", "content", "failed", "2026-10-01T09:00:00Z"), findingId: "finding-x" } as Job;
  const otherDraft = { ...run("draft-y-done", "content", "completed", "2026-10-02T09:00:00Z"), findingId: "finding-y" } as Job;
  const sameDraft = { ...run("draft-x-done", "content", "completed", "2026-10-02T09:00:00Z"), findingId: "finding-x" } as Job;
  assert.deepEqual(runsNeedingAttention([otherDraft, draftFailed]).map((job) => job.id), ["draft-x-failed"], "another opportunity's draft does not resolve it");
  assert.deepEqual(runsNeedingAttention([sameDraft, draftFailed]), []);
  assert.deepEqual(runsNeedingAttention([{ ...draftFailed, dismissedAt: "2026-10-03T09:00:00Z" } as Job]), []);
  assert.deepEqual(runsNeedingAttention([run("questions", "discover", "failed", "2026-10-01T09:00:00Z"), run("questions-paused", "discover", "paused", "2026-10-01T09:00:00Z")]), []);
  const answered = { ...run("answered", "measure", "failed", "2026-10-01T09:00:00Z"), result: { comparisonKey: "a".repeat(64), collectionCompletedAt: "2026-10-01T09:00:00Z", metrics: { requested: 1, completed: 1, missing: 0, mentionRate: 100, citationRate: 0, citations: 0 } } } as Job;
  assert.deepEqual(runsNeedingAttention([answered]), [], "a check with every answer saved is a result, not a failure");
});

test("only a run that did not finish can be dismissed", () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-dismiss-"));
  const store = new Store(directory);
  try {
    const project = store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = store.enqueue(jobInput.parse({ projectId: project.id, kind: "audit" }), "dismiss-test");
    assert.throws(() => store.dismissJob(job.id), ProviderError);
    store.updateJob(job.id, { status: "failed" });
    const dismissed = store.dismissJob(job.id);
    assert.ok(dismissed.dismissedAt);
    assert.equal(store.dismissJob(job.id).dismissedAt, dismissed.dismissedAt, "dismissing again keeps the first time");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
