import type { Job } from "../server/contracts";
import { completedMeasurement } from "../server/portable-results";

/** The work a run produces. A later success on the same work resolves an earlier failure. */
function target(job: Job) {
  switch (job.kind) {
    case "measure":
    case "recheck":
      return "measure";
    case "content":
      return "content:" + (job.findingId ?? job.topic ?? "");
    case "revise":
      return "revise:" + (job.contentId ?? "");
    case "competitors":
      return "competitors:" + (job.measurementJobId ?? "");
    default:
      return job.kind;
  }
}

/**
 * Runs the user can act on or should wait for. Completed work is shown through its results
 * (checks, pages, drafts), so a list of finished runs would only repeat the same titles. A
 * failure stays visible until the user dismisses it or a later run of the same work completes.
 * Question suggestions belong to setup, which shows their progress itself.
 */
export function runsNeedingAttention(jobs: Job[], kinds?: Job["kind"][]) {
  const scoped = (kinds ? jobs.filter((job) => kinds.includes(job.kind)) : jobs).filter((job) => job.kind !== "discover");
  return scoped.filter((job) => {
    if (["queued", "running", "paused"].includes(job.status)) return true;
    if (job.status === "cancelled") return job.error === "cancel_remote";
    // A check whose answers were all saved is a usable result even if follow-up work failed.
    if (job.status !== "failed" || job.dismissedAt || completedMeasurement(job)) return false;
    return !scoped.some((other) => target(other) === target(job) && other.status === "completed" && other.createdAt > job.createdAt);
  });
}
