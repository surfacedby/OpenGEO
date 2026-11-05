import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ProviderError, contentTask } from "./contracts.js";
import { topicNames } from "./topic-migration.js";
import { PageCatalog } from './page-catalog.js';
import { askScope } from './ask-scope.js';
import { completedBrandMeasurement, completedMeasurement, analysisInProgress } from './portable-results.js';
import type {
  Project,
  ProjectInput,
  Job,
  JobInput,
  Observation,
  PageEvidence,
  PageSummary,
  Finding,
} from "./contracts.js";
export class Store {
  readonly db: Database.Database;
  readonly pageCatalog: PageCatalog;
  private readonly instanceId = randomUUID();
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
 CREATE INDEX IF NOT EXISTS artifacts_project_job ON artifacts(project_id,kind,job_id);
 CREATE TABLE IF NOT EXISTS steps(job_id TEXT NOT NULL REFERENCES jobs(id),step TEXT NOT NULL,state TEXT NOT NULL,body TEXT,PRIMARY KEY(job_id,step));
 CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crawl_cooldowns(host TEXT PRIMARY KEY,retry_at REAL NOT NULL);
 CREATE TABLE IF NOT EXISTS ask_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,input_hash TEXT NOT NULL,result TEXT);
 INSERT OR IGNORE INTO migrations VALUES(1);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS content_recovery(content_id TEXT PRIMARY KEY REFERENCES artifacts(id),project_id TEXT NOT NULL REFERENCES projects(id),session TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT);
 INSERT OR IGNORE INTO migrations VALUES(2);`);
    // Rename only known scope fields, atomically; answer text and other user data stay untouched.
    try {
    if (!this.db.prepare('SELECT version FROM migrations WHERE version=3').get()) this.db.transaction(() => {
      for (const table of ['projects', 'jobs'] as const) {
        for (const row of this.db.prepare(`SELECT id, body FROM ${table}`).all() as { id: string; body: string }[]) {
          const body = JSON.stringify(topicNames(JSON.parse(row.body), table === 'projects'));
          if (body !== row.body) this.db.prepare(`UPDATE ${table} SET body=? WHERE id=?`).run(body, row.id);
        }
      }
      for (const row of this.db.prepare("SELECT job_id, body FROM steps WHERE step='project' AND body IS NOT NULL").all() as { job_id: string; body: string }[]) {
        const body = JSON.stringify(topicNames(JSON.parse(row.body), true));
        if (body !== row.body) this.db.prepare("UPDATE steps SET body=? WHERE job_id=? AND step='project'").run(body, row.job_id);
      }
      const schedules = this.setting<any[]>('schedules', []);
      this.set('schedules', schedules.map(row => ({ ...row, job: topicNames(row.job) })));
      for (const row of this.db.prepare("SELECT key, body FROM settings WHERE key GLOB 'scheduleRequest:*'").all() as { key: string; body: string }[]) {
        const receipt = JSON.parse(row.body);
        if (receipt.input?.job) this.set(row.key, { ...receipt, input: { ...receipt.input, job: topicNames(receipt.input.job) } });
      }
      this.db.prepare('INSERT INTO migrations VALUES(3)').run();
    })();
    this.pageCatalog = new PageCatalog(this.db);
    } catch (error) {
      // A refused migration must release the file so the original backup can be inspected or restored.
      this.db.close();
      throw error;
    }
    // An interrupted provider call must be reconciled by a human, never replayed as a fresh paid request.
    for (const job of this.jobs().filter((j) => j.status === "running"))
      this.updateJob(job.id, {
        status: job.kind === 'audit' && job.background ? 'queued' : 'paused',
        error: job.kind === 'audit' && job.background ? null : 'interrupted',
        progress: job.kind === 'audit' && job.background ? 'Continuing your saved website check' : 'Interrupted. Review completed evidence before resuming.',
      });
  }
  projects(): Project[] {
    return this.db
      .prepare("SELECT body FROM projects ORDER BY rowid DESC")
      .all()
      .map((r: any) => ({ topics: [], ...JSON.parse(r.body) }));
  }
  /** Projects saved before topics existed read as having none. */
  project(id: string): Project {
    const r = this.db
      .prepare("SELECT body FROM projects WHERE id=?")
      .get(id) as any;
    if (!r) throw new Error("Project not found");
    return { topics: [], ...JSON.parse(r.body) };
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
  /** Active work keeps provider receipts until the user has stopped and reconciled it. */
  deleteProject(id: string, confirmation: string) {
    return this.db.transaction(() => {
      const project = this.project(id);
      if (confirmation !== project.domain)
        throw new ProviderError("confirmation", "Type the website address exactly to delete this brand.");
      const jobs = this.jobs(id);
      if (jobs.some(job => ["queued", "running", "paused"].includes(job.status) || job.error === "cancel_remote"))
        throw new ProviderError("in_progress", "Stop or resolve this brand's unfinished scans before deleting it.");
      const ids = new Set(jobs.map(job => job.id));
      const schedules = this.setting<{ id: string; job: { projectId: string } }[]>("schedules", []);
      const removedSchedules = new Set(schedules.filter(row => row.job.projectId === id).map(row => row.id));
      this.set("schedules", schedules.filter(row => row.job.projectId !== id));
      const runs = this.setting<Record<string, string[]>>("scheduleRuns", {});
      const approvals = this.setting<Record<string, number>>("scheduleBudgetApprovals", {});
      for (const key of Object.keys(runs)) {
        runs[key] = runs[key].filter(jobId => !ids.has(jobId));
        if (!runs[key].length || [...removedSchedules].some(schedule => key.startsWith(schedule + ":"))) {
          delete runs[key]; delete approvals[key];
        }
      }
      this.set("scheduleRuns", runs);
      for (const key of Object.keys(approvals)) {
        if ([...removedSchedules].some(schedule => key.startsWith(schedule + ":"))) delete approvals[key];
      }
      this.set("scheduleBudgetApprovals", approvals);
      // Idempotency receipts contain the original brand input and must follow its deletion.
      for (const row of this.db.prepare("SELECT key, body FROM settings WHERE key GLOB 'scheduleRequest:*'").all() as { key: string; body: string }[]) {
        const receipt = JSON.parse(row.body);
        if (receipt.input?.job?.projectId === id || removedSchedules.has(receipt.id))
          this.db.prepare("DELETE FROM settings WHERE key=?").run(row.key);
      }
      if (this.setting<{ projectId?: string } | null>("setupDraft", null)?.projectId === id) this.set("setupDraft", null);
      this.db.prepare("DELETE FROM content_recovery WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM artifacts WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM steps WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?)").run(id);
      this.db.prepare("DELETE FROM jobs WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
      return { deleted: true };
    })();
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
      if (input.kind === 'audit' && input.background && this.jobs(input.projectId).some(job =>
        job.kind === 'audit' && job.background && ['queued', 'running', 'paused'].includes(job.status)))
        throw new ProviderError('in_progress', 'Website discovery is already saved for this brand. Follow or resume it in Scans.');
      if (['measure', 'recheck'].includes(input.kind) && this.jobs(input.projectId).some(job =>
        ['measure', 'recheck'].includes(job.kind) && job.provider === input.provider &&
        job.topicId === input.topicId && ['queued', 'running', 'paused'].includes(job.status) && (!completedMeasurement(job) || job.prepareRecommendations)))
        throw new ProviderError('in_progress', 'This visibility check is already in progress. Open the current check to follow or resume it.');
      if (input.kind === 'diagnose' && this.jobs(input.projectId).some(job => analysisInProgress(job) && ['queued', 'running'].includes(job.status)))
        throw new ProviderError('in_progress', 'An improvement plan is already being prepared. Follow its progress in Opportunities.');
      const analysisMeasurement = input.kind === 'diagnose' ? input.measurementJobId
        ? this.job(input.measurementJobId) : this.jobs(input.projectId).find(completedBrandMeasurement) : undefined;
      if (analysisMeasurement && (analysisMeasurement.projectId !== input.projectId || !completedMeasurement(analysisMeasurement)))
        throw new ProviderError('evidence', 'Choose a completed visibility check for this brand.');
      if (input.kind === 'competitors' && this.jobs(input.projectId).some(job => job.kind === 'competitors' && job.measurementJobId === input.measurementJobId && ['queued', 'running', 'paused'].includes(job.status)))
        throw new ProviderError('in_progress', 'A competitor review is already saved for this check. Resume it or follow its progress.');
      if (input.kind === 'revise' && !this.artifacts<any>(input.projectId, 'content').some((doc) => doc.id === input.contentId))
        throw new Error('Content not found');
      const finding = input.findingId ? this.findings(input.projectId).find(row => row.id === input.findingId) : undefined;
      if (input.findingId && (!finding || !['analysis', 'console'].includes(finding.kind)))
        throw new ProviderError('evidence', 'Choose a saved opportunity from this website.');
      if (finding?.opportunity?.type === 'site_change')
        throw new ProviderError('capability', 'This improvement requires website changes rather than a content draft.');
      if (finding?.opportunity?.type === 'new_content' && input.contentMode === 'page_update')
        throw new ProviderError('capability', 'This opportunity is for a new resource. Choose a new article draft.');
      if (input.findingId && this.jobs(input.projectId).some(job => job.kind === 'content' && job.findingId === input.findingId && ['queued', 'running', 'paused'].includes(job.status)))
        throw new ProviderError('in_progress', 'A draft for this opportunity is already saved. Follow its progress or resume it in Content.');
      const now = new Date().toISOString();
      const j: Job = {
        ...input,
        ...(analysisMeasurement ? { measurementJobId: analysisMeasurement.id } : {}),
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
      if (input.kind === 'content') this.setStep(j.id, 'content-task', 'done', contentTask.parse({
        mode: input.contentMode ?? (finding && finding.opportunity?.type !== 'new_content' ? 'page_update' : 'article'),
        ...(finding ? { findingId: finding.id, targetUrl: finding.targetUrl,
          recommendation: { title: finding.title, description: finding.description, steps: finding.steps } } : {}),
      }));
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
  dismissJob(id: string) {
    const job = this.job(id);
    if (job.status !== "failed") throw new ProviderError("state", "Only a run that did not finish can be dismissed.");
    return job.dismissedAt ? job : this.updateJob(id, { dismissedAt: new Date().toISOString() });
  }
  put(kind: string, projectId: string, jobId: string, value: any) {
    const insert = () => this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)")
      .run(value.id, projectId, jobId, kind, JSON.stringify(value));
    if (kind !== 'page') { insert(); return; }
    this.db.transaction(() => {
      const result = insert();
      this.pageCatalog.insert(projectId, jobId, value, Number(result.lastInsertRowid));
    })();
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
  /** Both this connection's writes and other SQLite writers invalidate a polled view; reopening cannot reuse an old validator. */
  workspaceRevision(): string {
    const row = this.db.prepare('SELECT total_changes() AS changes, data_version AS external FROM pragma_data_version').get() as { changes: number; external: number };
    return `${this.instanceId}:${row.changes}:${row.external}`;
  }
  /** Polling reads metadata directly; large crawl bodies stay out of the JavaScript object graph. */
  pageSummaries(projectId: string, jobId: string): PageSummary[] {
    return this.db.prepare("SELECT json_remove(body, '$.text', '$.links') AS body FROM artifacts WHERE project_id=? AND job_id=? AND kind='page' ORDER BY rowid DESC")
      .all(projectId, jobId).map((row: any) => JSON.parse(row.body));
  }
  pageCount(projectId: string, jobId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=? AND job_id=? AND kind='page'").get(projectId, jobId) as { count: number }).count;
  }
  /** Older saved crawls may need findings backfilled; read bodies only for those pages. */
  unauditedPageIds(projectId: string, jobId: string): string[] {
    return (this.db.prepare("SELECT a.id FROM artifacts a WHERE a.project_id=? AND a.job_id=? AND a.kind='page' AND NOT EXISTS (SELECT 1 FROM steps s WHERE s.job_id=a.job_id AND s.step='audit-page:' || a.id) ORDER BY a.rowid")
      .all(projectId, jobId) as { id: string }[]).map(row => row.id);
  }
  findingCount(projectId: string, jobId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=? AND job_id=? AND kind='finding'").get(projectId, jobId) as { count: number }).count;
  }
  pageEvidence(projectId: string, id: string): PageEvidence | undefined {
    const row = this.db.prepare("SELECT body FROM artifacts WHERE project_id=? AND id=? AND kind='page'").get(projectId, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  evidenceRecords(projectId: string, ids: string[]) {
    const result = { pages: [] as PageEvidence[], sources: [] as { id: string }[], observations: [] as Observation[] };
    if (!ids.length) return result;
    const rows = this.db.prepare("SELECT kind,body FROM artifacts WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) AND kind IN ('page','source','observation') ORDER BY rowid DESC")
      .all(projectId, JSON.stringify([...new Set(ids)])) as { kind: string; body: string }[];
    for (const row of rows) {
      const body = JSON.parse(row.body);
      if (row.kind === 'page') result.pages.push(body);
      else if (row.kind === 'source') result.sources.push(body);
      else result.observations.push(body);
    }
    return result;
  }
  portableArtifacts<T = Record<string, unknown>>(projectId: string, kind: "page" | "source" | "content"): (T & { jobId: string })[] {
    return this.db.prepare("SELECT body,job_id FROM artifacts WHERE project_id=? AND kind=? ORDER BY rowid DESC")
      .all(projectId, kind).map((row: any) => ({ ...JSON.parse(row.body), jobId: row.job_id }));
  }
  observations(id: string, jobId?: string) {
    return this.artifacts<Observation>(id, "observation", jobId);
  }
  /** Answers of one job under its own kind: observations for checks, ask answers for asks. */
  answers(projectId: string, jobId: string, kind: "observation" | "ask-answer") {
    return this.artifacts<Observation>(projectId, kind, jobId);
  }
  answerCount(projectId: string, jobId: string, kind: "observation" | "ask-answer" = "observation") {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE project_id=? AND job_id=? AND kind=?").get(projectId, jobId, kind) as { count: number }).count;
  }
  /** The group receipt binds all engines and the approved limit, including concurrent and lost-response retries. */
  askRequest(askId: string, inputHash: string): { askId: string; jobs: string[] } | null {
    const row = this.db.prepare('SELECT input_hash,result FROM ask_requests WHERE id=?').get(askId) as { input_hash: string; result: string | null } | undefined;
    if (!row) {
      // Older fork builds stored jobs without a group approval. Reusing that key cannot authorize new engines.
      const existing = this.db.prepare("SELECT 1 FROM jobs WHERE json_extract(body,'$.askId')=? LIMIT 1").get(askId);
      if (existing) throw new ProviderError('idempotency', 'This ask predates saved request approvals. Open its existing results, or start a new ask.');
      return null;
    }
    if (row.input_hash !== inputHash)
      throw new ProviderError('idempotency', 'This request was already used with different questions, engines or spending limits. Start a new ask for different settings.');
    if (!row.result)
      throw new ProviderError('idempotency', 'This ask was deleted. Start a new ask instead of retrying its original request.');
    return JSON.parse(row.result);
  }
  enqueueAsk(askId: string, projectId: string, inputHash: string, inputs: JobInput[]) {
    return this.db.transaction(() => {
      const previous = this.askRequest(askId, inputHash);
      if (previous) return previous;
      const project = this.project(projectId);
      const result = { askId, jobs: inputs.map((input, index) => {
        const job = this.enqueue(input, `ask:${askId}:${index}`);
        this.setStep(job.id, 'project', 'done', askScope(project, input.question!));
        return job.id;
      }) };
      this.db.prepare('INSERT INTO ask_requests VALUES(?,?,?,?)').run(askId, projectId, inputHash, JSON.stringify(result));
      return result;
    })();
  }
  /** Keep a content-free retry tombstone so deleting an ask cannot silently authorize buying it again. */
  deleteAsk(projectId: string, askId: string) {
    return this.db.transaction(() => {
      const jobs = this.jobs(projectId).filter(job => job.kind === "ask" && job.askId === askId);
      if (!jobs.length) throw new Error("Ask not found");
      if (jobs.some(job => ["queued", "running"].includes(job.status) ||
          ["interrupted", "waiting", "cancel_remote", "cost_unknown", "invalid_response"].includes(job.error ?? "")))
        throw new ProviderError("in_progress", "Wait for this ask to finish, or skip its engines, before deleting it.");
      for (const job of jobs) {
        this.db.prepare("DELETE FROM artifacts WHERE job_id=?").run(job.id);
        this.db.prepare("DELETE FROM steps WHERE job_id=?").run(job.id);
        this.db.prepare("DELETE FROM jobs WHERE id=?").run(job.id);
      }
      this.db.prepare('UPDATE ask_requests SET result=NULL WHERE id=? AND project_id=?').run(askId, projectId);
      return { deleted: true };
    })();
  }
  findings(id: string) {
    return this.artifacts<Finding>(id, "finding");
  }
  nonAuditFindings(id: string): Finding[] {
    return (this.db.prepare(`SELECT f.body FROM artifacts f JOIN jobs j ON j.id=f.job_id
      WHERE f.project_id=? AND f.kind='finding' AND json_extract(j.body,'$.kind')!='audit'
      ORDER BY f.rowid DESC`).all(id) as { body: string }[]).map(row => JSON.parse(row.body));
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
  crawlRetryAt(host: string): number | undefined {
    const row = this.db.prepare('SELECT retry_at FROM crawl_cooldowns WHERE host=? AND retry_at>?').get(host, Date.now()) as { retry_at: number } | undefined;
    return row?.retry_at;
  }
  deferCrawlHost(host: string, retryAt: number) {
    this.db.prepare('DELETE FROM crawl_cooldowns WHERE retry_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO crawl_cooldowns(host,retry_at) VALUES(?,?) ON CONFLICT(host) DO UPDATE SET retry_at=MAX(retry_at,excluded.retry_at)').run(host, retryAt);
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
