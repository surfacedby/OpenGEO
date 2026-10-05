import test from "node:test";
import assert from "node:assert/strict";
import { runsNeedingAttention } from "../src/runs.js";
import type { Job } from "../server/contracts.js";

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
