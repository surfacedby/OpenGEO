import type { Job } from "../server/contracts";

/** Runs in one family replace each other: a completed recheck resolves a failed check. */
const family: Record<Job["kind"], string> = { audit: "audit", discover: "discover", competitors: "competitors", measure: "measure", recheck: "measure", diagnose: "diagnose", content: "content", revise: "revise" };

/**
 * Runs the user can act on or should wait for. Completed work is shown through its results
 * (checks, pages, drafts), so a list of finished runs would only repeat the same titles. A
 * failure stays visible until a later run of the same kind completes.
 */
export function runsNeedingAttention(jobs: Job[], kinds?: Job["kind"][]) {
  const scoped = kinds ? jobs.filter((job) => kinds.includes(job.kind)) : jobs;
  return scoped.filter((job) => {
    if (["queued", "running", "paused"].includes(job.status)) return true;
    const unresolved = job.status === "failed" || (job.status === "cancelled" && job.error === "cancel_remote");
    return unresolved && !scoped.some((other) => family[other.kind] === family[job.kind] && other.status === "completed" && other.createdAt > job.createdAt);
  });
}
