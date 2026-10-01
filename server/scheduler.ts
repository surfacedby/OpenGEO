import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./storage.js";
import { jobInput, ProviderError, type Job } from "./contracts.js";
export const scheduleInput = z
  .object({
    job: jobInput,
    frequency: z.enum(["daily", "weekly"]),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(0).max(6).default(1),
    timezone: z.string(),
    monthlyBudgetUsd: z.number().finite().min(0).max(10000),
    enabled: z.boolean().default(true),
  })
  .strict();
export type Schedule = z.infer<typeof scheduleInput> & {
  id: string;
  nextAt: string;
  lastError?: string;
};
export function nextRun(s: z.infer<typeof scheduleInput>, now = new Date()) {
  new Intl.DateTimeFormat("en", { timeZone: s.timezone });
  const expr =
    "0 " + s.hour + " * * " + (s.frequency === "weekly" ? s.weekday : "*");
  return CronExpressionParser.parse(expr, { currentDate: now, tz: s.timezone })
    .next()
    .toISOString()!;
}
function committedCost(job: Job) {
  return ["queued", "running", "paused"].includes(job.status) ? Math.max(job.maxCostUsd, job.spentUsd) : job.spentUsd;
}
/** Manual recovery cannot silently exceed the monthly ceiling approved for a scheduled run. */
export function scheduledBudgetCeiling(store: Store, job: Job) {
  if (!job.provider || job.provider === "chatgpt") return undefined;
  const runs = store.setting<Record<string, string[]>>("scheduleRuns", {});
  const schedules = store.setting<Schedule[]>("schedules", []);
  const approvals = store.setting<Record<string, number>>("scheduleBudgetApprovals", {});
  const ceilings: number[] = [];
  for (const [key, ids] of Object.entries(runs)) {
      if (!ids.includes(job.id)) continue;
      const budget = approvals[key] ?? schedules.find((schedule) => key.startsWith(schedule.id + ":"))?.monthlyBudgetUsd;
      if (budget === undefined) throw new Error("The spending approval for this scheduled run is missing. Review the schedule before resuming.");
      const otherCommitted = ids.filter((id) => id !== job.id).reduce((total, id) => total + committedCost(store.job(id)), 0);
      ceilings.push(Math.max(0, budget - otherCommitted));
  }
  return ceilings.length ? Math.min(...ceilings) : undefined;
}
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly store: Store) {}
  list() {
    return this.store.setting<Schedule[]>("schedules", []);
  }
  add(raw: unknown, requestKey: string = randomUUID()) {
    const input = scheduleInput.parse(raw);
    const key = z.string().min(8).max(200).parse(requestKey);
    return this.store.db.transaction(() => {
      // Keep receipts after removal so a delayed retry cannot restart recurring paid work.
      const receipt = this.store.setting<{ input: z.infer<typeof scheduleInput>; id: string } | null>("scheduleRequest:" + key, null);
      if (receipt) {
        if (JSON.stringify(receipt.input) !== JSON.stringify(input))
          throw new ProviderError("setup", "This schedule request was already used with different settings. Start a new schedule to approve those changes.");
        const existing = this.list().find((entry) => entry.id === receipt.id);
        if (!existing) throw new ProviderError("setup", "This schedule was removed. Start a new schedule if you want to run it again.");
        return existing;
      }
      this.store.project(input.job.projectId);
      const s = { ...input, id: randomUUID(), nextAt: nextRun(input) };
      this.store.set("schedules", [...this.list(), s]);
      this.store.set("scheduleRequest:" + key, { input, id: s.id });
      return s;
    })();
  }
  remove(id: string) {
    this.store.db.transaction(() => {
    // Removing future runs must preserve the spending approval for existing paused work.
    const schedule = this.list().find((entry) => entry.id === id);
    const approvals = this.store.setting<Record<string, number>>("scheduleBudgetApprovals", {});
    if (schedule) for (const key of Object.keys(this.store.setting<Record<string, string[]>>("scheduleRuns", {})))
      if (key.startsWith(id + ":")) approvals[key] ??= schedule.monthlyBudgetUsd;
    this.store.set("scheduleBudgetApprovals", approvals);
    this.store.set(
      "schedules",
      this.list().filter((s) => s.id !== id),
    );
    })();
  }
  tick(now = new Date()) {
    this.store.db.transaction(() => this.processTick(now))();
  }
  private processTick(now: Date) {
    let changed = false;
    const schedules = this.list();
    for (const s of schedules) {
      if (!s.enabled || new Date(s.nextAt) > now) continue;
      const parts = new Intl.DateTimeFormat("en", {
        timeZone: s.timezone,
        year: "numeric",
        month: "2-digit",
      }).formatToParts(now);
      const month =
        parts.find((p) => p.type === "year")!.value +
        "-" +
        parts.find((p) => p.type === "month")!.value;
      const runs = this.store.setting<Record<string, string[]>>(
        "scheduleRuns",
        {},
      );
      const ids = runs[s.id + ":" + month] ?? [];
      const jobs = ids.map((id) => this.store.job(id));
      // Unfinished work keeps its provider access and budget constraints across calendar boundaries.
      const outstanding = Object.entries(runs)
        .filter(([key]) => key.startsWith(s.id + ":"))
        .flatMap(([, runIds]) => runIds)
        .some((id) => ["queued", "running", "paused"].includes(this.store.job(id).status));
      const committed = jobs.reduce(
        (n, j) =>
          n +
          committedCost(j),
        0,
      );
      const remaining = s.monthlyBudgetUsd - committed;
      const due = s.nextAt;
      s.nextAt = nextRun(s, now);
      if (
        s.job.provider &&
        s.job.provider !== "chatgpt" &&
        remaining < s.job.maxCostUsd
      ) {
        s.lastError = "Monthly budget is insufficient for the next run.";
      } else if (outstanding) {
        s.lastError = "A previous scheduled run still needs attention.";
      } else {
        const job = this.store.enqueue(s.job, "schedule:" + s.id + ":" + due);
        runs[s.id + ":" + month] = ids.concat(job.id);
        this.store.set("scheduleRuns", runs);
        const approvals = this.store.setting<Record<string, number>>("scheduleBudgetApprovals", {});
        approvals[s.id + ":" + month] ??= s.monthlyBudgetUsd;
        this.store.set("scheduleBudgetApprovals", approvals);
        delete s.lastError;
      }
      changed = true;
    }
    if (changed) this.store.set("schedules", schedules);
  }
  start() {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* Failed schedule processing stays pending for the next tick. */
      }
    }, 30000);
    this.timer.unref();
    this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
