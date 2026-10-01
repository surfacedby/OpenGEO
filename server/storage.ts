import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderError } from "./contracts.js";
import type {
  Project,
  ProjectInput,
  Job,
  JobInput,
  Observation,
  PageEvidence,
  Finding,
} from "./contracts.js";
export class Store {
  readonly db: Database.Database;
  onJobCompleted?: (kind: Job["kind"], provider: Job["provider"]) => void;
  onImprovementCompleted?: () => void;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(resolve(directory, "opengeo.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),status TEXT NOT NULL,body TEXT NOT NULL,idempotency TEXT UNIQUE);
 CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),job_id TEXT NOT NULL REFERENCES jobs(id),kind TEXT NOT NULL,body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id,kind);
 CREATE TABLE IF NOT EXISTS steps(job_id TEXT NOT NULL REFERENCES jobs(id),step TEXT NOT NULL,state TEXT NOT NULL,body TEXT,PRIMARY KEY(job_id,step));
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(1);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS content_recovery(content_id TEXT PRIMARY KEY REFERENCES artifacts(id),project_id TEXT NOT NULL REFERENCES projects(id),session TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT);
 INSERT OR IGNORE INTO migrations VALUES(2);`);
    // An interrupted provider call must be reconciled by a human, never replayed as a fresh paid request.
    for (const job of this.jobs().filter((j) => j.status === "running"))
      this.updateJob(job.id, {
        status: "paused",
        error: "interrupted",
        progress: "Interrupted. Review completed evidence before resuming.",
      });
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT body FROM projects ORDER BY rowid DESC")
      .all()
      .map((r: any) => JSON.parse(r.body));
  }
  project(id: string): Project {
    const r = this.db
      .prepare("SELECT body FROM projects WHERE id=?")
      .get(id) as any;
    if (!r) throw new Error("Project not found");
    return JSON.parse(r.body);
  }
  createProject(input: ProjectInput) {
    const p = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO projects VALUES(?,?)")
      .run(p.id, JSON.stringify(p));
    return p;
  }
  updateProject(id: string, input: ProjectInput) {
    const p = { ...this.project(id), ...input };
    this.db
      .prepare("UPDATE projects SET body=? WHERE id=?")
      .run(JSON.stringify(p), id);
    return p;
  }
  jobs(projectId?: string): Job[] {
    return this.db
      .prepare(
        "SELECT body FROM jobs " +
          (projectId ? "WHERE project_id=? " : "") +
          "ORDER BY rowid DESC",
      )
      .all(...(projectId ? [projectId] : []))
      .map((r: any) => JSON.parse(r.body));
  }
  job(id: string): Job {
    const r = this.db
      .prepare("SELECT body FROM jobs WHERE id=?")
      .get(id) as any;
    if (!r) throw new Error("Job not found");
    return JSON.parse(r.body);
  }
  enqueue(input: JobInput, key: string): Job {
    return this.db.transaction(() => {
      const r = this.db
        .prepare("SELECT body FROM jobs WHERE idempotency=?")
        .get(key) as any;
      if (r) {
        const old = JSON.parse(r.body);
        for (const k of Object.keys(input))
          if (JSON.stringify(old[k]) !== JSON.stringify((input as any)[k]))
            throw new Error(
              "Idempotency key already used with different input",
            );
        return old;
      }
      this.project(input.projectId);
      if (input.kind === 'revise' && !this.artifacts<any>(input.projectId, 'content').some((doc) => doc.id === input.contentId))
        throw new Error('Content not found');
      const now = new Date().toISOString();
      const j: Job = {
        ...input,
        id: randomUUID(),
        status: "queued",
        createdAt: now,
        updatedAt: now,
        step: 0,
        progress: "Waiting to start",
        error: null,
        result: null,
        spentUsd: 0,
      };
      this.db
        .prepare("INSERT INTO jobs VALUES(?,?,?,?,?)")
        .run(j.id, input.projectId, j.status, JSON.stringify(j), key);
      return j;
    })();
  }
  updateJob(id: string, patch: Partial<Job>) {
    const previous = this.job(id);
    const j = {
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE jobs SET status=?,body=? WHERE id=?")
      .run(j.status, JSON.stringify(j), id);
    if (previous.status !== "completed" && j.status === "completed" && !(j.result as { imported?: boolean } | null)?.imported) {
      try { this.onJobCompleted?.(j.kind, j.provider); } catch { /* Optional observers cannot interrupt durable work. */ }
    }
    return j;
  }
  put(kind: string, projectId: string, jobId: string, value: any) {
    this.db
      .prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
      .run(value.id, projectId, jobId, kind, JSON.stringify(value));
  }
  artifacts<T = unknown>(projectId: string, kind: string, jobId?: string): T[] {
    return this.db
      .prepare(
        "SELECT body FROM artifacts WHERE project_id=? AND kind=?" +
          (jobId ? " AND job_id=?" : "") +
          " ORDER BY rowid DESC",
      )
      .all(projectId, kind, ...(jobId ? [jobId] : []))
      .map((r: any) => JSON.parse(r.body));
  }
  pages(id: string, jobId?: string) {
    return this.artifacts<PageEvidence>(id, "page", jobId);
  }
  portableArtifacts<T = Record<string, unknown>>(projectId: string, kind: "page" | "content"): (T & { jobId: string })[] {
    return this.db.prepare("SELECT body,job_id FROM artifacts WHERE project_id=? AND kind=? ORDER BY rowid DESC")
      .all(projectId, kind).map((row: any) => ({ ...JSON.parse(row.body), jobId: row.job_id }));
  }
  observations(id: string, jobId?: string) {
    return this.artifacts<Observation>(id, "observation", jobId);
  }
  findings(id: string) {
    return this.artifacts<Finding>(id, "finding");
  }
  patchFinding(projectId: string, id: string, status: Finding["status"]) {
    const r = this.db
      .prepare(
        "SELECT body FROM artifacts WHERE id=? AND project_id=? AND kind='finding'",
      )
      .get(id, projectId) as any;
    if (!r) throw new Error("Finding not found");
    const previous = JSON.parse(r.body);
    const f = { ...previous, status };
    this.db
      .prepare("UPDATE artifacts SET body=? WHERE id=?")
      .run(JSON.stringify(f), id);
    if (previous.status !== "done" && status === "done") {
      try { this.onImprovementCompleted?.(); } catch { /* Optional observers cannot interrupt a saved improvement. */ }
    }
    return f;
  }
  private contentRow(projectId: string, id: string) {
    const r = this.db
      .prepare(
        "SELECT body,job_id FROM artifacts WHERE id=? AND project_id=? AND kind='content'",
      )
      .get(id, projectId) as any;
    if (!r) throw new Error("Content not found");
    return r;
  }
  openContentRecovery(projectId: string, id: string) {
    return this.db.transaction(() => {
      this.contentRow(projectId, id);
      const previous = this.db.prepare("SELECT body FROM content_recovery WHERE content_id=? AND project_id=?").get(id, projectId) as { body: string | null } | undefined;
      const session = randomUUID();
      this.db.prepare("INSERT INTO content_recovery VALUES(?,?,?,0,?) ON CONFLICT(content_id) DO UPDATE SET session=excluded.session,sequence=0").run(id, projectId, session, previous?.body ?? null);
      return { session, recovery: previous?.body ? JSON.parse(previous.body) : null };
    })();
  }
  protectContentEdit(projectId: string, id: string, input: { session: string; sequence: number; baseMarkdown: string; markdown: string }) {
    return this.db.transaction(() => {
      this.contentRow(projectId, id);
      const row = this.db.prepare("SELECT session,sequence FROM content_recovery WHERE content_id=? AND project_id=?").get(id, projectId) as { session: string; sequence: number } | undefined;
      if (!row || row.session !== input.session) throw new ProviderError("editor_changed", "This draft was opened or saved elsewhere. Reopen it before continuing.");
      // Monotonic writes keep delayed requests from replacing newer recovery text.
      if (input.sequence <= row.sequence) return { protected: false };
      const body = { baseMarkdown: input.baseMarkdown, markdown: input.markdown, updatedAt: new Date().toISOString() };
      this.db.prepare("UPDATE content_recovery SET sequence=?,body=? WHERE content_id=?").run(input.sequence, JSON.stringify(body), id);
      return { protected: true };
    })();
  }
  discardContentRecovery(projectId: string, id: string) {
    this.contentRow(projectId, id);
    this.db.prepare("UPDATE content_recovery SET session=?,body=NULL WHERE content_id=? AND project_id=?").run(randomUUID(), id, projectId);
    return { discarded: true };
  }
  editContent(projectId: string, id: string, markdown: string, baseMarkdown?: string, recoverySession?: string) {
    const r = this.contentRow(projectId, id);
    if (baseMarkdown !== undefined && JSON.parse(r.body).markdown !== baseMarkdown)
      throw new ProviderError("draft_changed", "The saved draft changed elsewhere. Keep or export your edits, then reopen the latest draft before saving.");
    const doc = {
      ...JSON.parse(r.body),
      markdown,
      editedAt: new Date().toISOString(),
      requiresHumanReview: true,
      reviewCurrent: false,
    };
    this.db.transaction(() => {
      this.put("revision", projectId, r.job_id, {
        ...JSON.parse(r.body),
        id: randomUUID(),
        contentId: id,
      });
      this.db
        .prepare("UPDATE artifacts SET body=? WHERE id=?")
        .run(JSON.stringify(doc), id);
      const recovery = this.db.prepare("SELECT session,body FROM content_recovery WHERE content_id=? AND project_id=?").get(id, projectId) as { session: string; body: string | null } | undefined;
      // A save in another editor must preserve protected text for explicit recovery.
      if (recovery && (recovery.session === recoverySession || (recovery.body && JSON.parse(recovery.body).markdown === markdown))) this.discardContentRecovery(projectId, id);
      else this.db.prepare("UPDATE content_recovery SET session=? WHERE content_id=? AND project_id=?").run(randomUUID(), id, projectId);
    })();
    return doc;
  }
  setting<T>(key: string, fallback: T): T {
    const r = this.db
      .prepare("SELECT body FROM settings WHERE key=?")
      .get(key) as any;
    return r ? JSON.parse(r.body) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
      )
      .run(key, JSON.stringify(value));
  }
  step(jobId: string, name: string) {
    return this.db
      .prepare("SELECT state,body FROM steps WHERE job_id=? AND step=?")
      .get(jobId, name) as { state: string; body: string | null } | undefined;
  }
  setStep(jobId: string, name: string, state: string, body: unknown = null) {
    this.db
      .prepare(
        "INSERT INTO steps VALUES(?,?,?,?) ON CONFLICT(job_id,step) DO UPDATE SET state=excluded.state,body=excluded.body",
      )
      .run(jobId, name, state, JSON.stringify(body));
  }
  close() {
    this.db.close();
  }
}
