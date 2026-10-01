import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./storage.js";
import packageInfo from "../package.json";

export const usageNames = ["usage_enabled", "workspace_opened", "setup_completed", "audit_completed", "visibility_completed", "recheck_completed", "analysis_completed", "content_created", "content_revised", "improvement_completed", "report_exported"] as const;
export const usageEvent = z.object({
  id: z.string().uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.enum(usageNames), provider: z.enum(["chatgpt", "console", "dataforseo", "openrouter"]).nullable(),
}).strict();
type EventName = typeof usageNames[number];
type Provider = z.infer<typeof usageEvent>["provider"];
type Consent = { enabled: boolean; installation?: string; since?: string; day?: string; daily?: string[]; count?: number };
const endpoint = "https://api.surfacedby.com/api/v1/open-source/usage";

/** Only closed, non-content fields enter the outbox; project data is never serialized. */
export class UsageSharing {
  private timer?: ReturnType<typeof setInterval>;
  private request?: AbortController;
  private pending?: Promise<void>;
  constructor(private store: Store, private send: typeof fetch = fetch, private clock = () => new Date()) {
    store.db.exec("CREATE TABLE IF NOT EXISTS usage_outbox(id TEXT PRIMARY KEY,day TEXT NOT NULL,body TEXT NOT NULL); INSERT OR IGNORE INTO migrations VALUES(3);");
    if (store.setting<boolean | null>("usageSetupDefault", null) === null)
      store.set("usageSetupDefault", !store.setting<any>("onboarding", null)?.completed && store.projects().length === 0);
  }
  status() {
    const saved = this.store.setting<Consent | null>("usageConsent", null);
    // New setup offers a checked preference, but no records are sent until it is saved.
    return { enabled: saved?.enabled ?? this.store.setting<boolean>("usageSetupDefault", false) };
  }
  setEnabled(enabled: boolean) {
    if (this.store.setting<Consent | null>("usageConsent", null)?.enabled === enabled) return this.status();
    this.request?.abort();
    this.store.db.transaction(() => {
      this.store.db.prepare("DELETE FROM usage_outbox").run();
      this.store.set("usageConsent", enabled ? { enabled: true, installation: randomUUID(), since: this.clock().toISOString() } : { enabled: false });
    })();
    if (enabled) { this.record("usage_enabled"); this.record("workspace_opened", null, true); }
    return this.status();
  }
  record(name: EventName, provider: Provider = null, daily = false) {
    try { this.append(name, provider, daily); }
    catch { /* Optional measurement cannot change whether local work succeeds. */ }
  }
  private append(name: EventName, provider: Provider, daily: boolean) {
    const consent = this.store.setting<Consent>("usageConsent", { enabled: false });
    if (!consent.enabled || !consent.installation) return;
    const day = this.clock().toISOString().slice(0, 10), key = name + ":" + (provider ?? "local");
    const keys = consent.day === day ? (consent.daily ?? []) : [];
    const countToday = consent.day === day ? (consent.count ?? 0) : 0;
    if (daily && keys.includes(key)) return;
    if (countToday >= 40) return;
    const row = usageEvent.parse({ id: randomUUID(), day, name, provider });
    this.store.db.transaction(() => {
      this.prune();
      const count = (this.store.db.prepare("SELECT count(*) AS n FROM usage_outbox").get() as { n: number }).n;
      if (count >= 256) return;
      this.store.db.prepare("INSERT INTO usage_outbox VALUES(?,?,?)").run(row.id, day, JSON.stringify(row));
      this.store.set("usageConsent", { ...consent, day, daily: daily ? [...keys, key] : keys, count: countToday + 1 });
    })();
  }
  private prune() {
    const limit = new Date(this.clock().getTime() - 7 * 86400000).toISOString().slice(0, 10);
    this.store.db.prepare("DELETE FROM usage_outbox WHERE day < ?").run(limit);
  }
  flush() {
    if (this.pending) return this.pending;
    this.pending = this.dispatch().catch(() => { /* Optional storage/transport failures remain isolated. */ }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async dispatch() {
    const consent = this.store.setting<Consent>("usageConsent", { enabled: false });
    if (!consent.enabled || !consent.installation) return;
    this.prune();
    const rows = this.store.db.prepare("SELECT body FROM usage_outbox ORDER BY rowid LIMIT 40").all() as { body: string }[];
    if (!rows.length) return;
    const events = rows.map(row => usageEvent.parse(JSON.parse(row.body)));
    const controller = new AbortController();
    this.request = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await this.send(endpoint, {
        method: "POST", redirect: "error", credentials: "omit", signal: controller.signal,
        headers: { "Content-Type": "application/json", "User-Agent": "OpenGEO-Usage/1" },
        body: JSON.stringify({ version: 1, installation: consent.installation, appVersion: packageInfo.version,
          channel: process.env.OPENGEO_CONTAINER === "1" ? "docker" : process.versions.electron ? "desktop" : "local",
          platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", events }),
      });
      // A late response after withdrawal cannot acknowledge a later consent's events.
      if (!response.ok) { await response.body?.cancel(); return; }
      const receipt = z.object({ accepted: z.array(z.string().uuid()).max(40) }).strict().parse(await response.json());
      if (controller.signal.aborted || this.store.setting<Consent>("usageConsent", { enabled: false }).installation !== consent.installation) return;
      const offered = new Set(events.map(row => row.id));
      this.store.db.transaction(() => { for (const id of receipt.accepted) if (offered.has(id)) this.store.db.prepare("DELETE FROM usage_outbox WHERE id=?").run(id); })();
    } catch { /* Usage collection must never interrupt a local workflow or report private errors. */ }
    finally { clearTimeout(timeout); this.request = undefined; }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), 300000);
    this.timer.unref();
    void this.flush();
  }
  async close() { clearInterval(this.timer); this.timer = undefined; this.request?.abort(); await this.pending; }
}
