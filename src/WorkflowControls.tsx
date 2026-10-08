import { useEffect, useRef, useState } from "react";
import { api, download } from "./api";
import { Select } from "./Select";
import { FormFeedback, useFormFeedback } from "./FormFeedback";
import { ProviderIcon, providerOptions, providerLabels } from "./provider-ui";
import { AnswerCard } from "./DataPresentation";
import { SiteIcon } from "./SiteIcon";
import { targetDomain } from "./finding-groups";
import { CalendarClock, Check, Plus, Trash2, Upload, Download } from "lucide-react";
import identity from "../brand/identity.json";
import { dateTime, shortDate } from "./format";
import { markdownHtml, htmlDocument } from "../server/markdown";
import type { Model, Project, Provider } from "../server/contracts";
import type { Observation, PageEvidence, ManagedSourceEvidence } from "../server/contracts";

export function FindingEvidence({ projectId, findingId }: { projectId: string; findingId: string }) {
  const [evidence, setEvidence] = useState<{ pages: PageEvidence[]; sources: ManagedSourceEvidence[]; observations: Observation[]; missing: number } | null>(null);
  const [error, setError] = useState("");
  return <details onToggle={(event) => {
    if (event.currentTarget.open && !evidence)
      void api("/projects/" + projectId + "/findings/" + findingId + "/evidence").then(setEvidence).catch((e) => setError(e.message));
  }}>
    <summary>Inspect supporting evidence</summary>
    {error && <p role="alert">{error}</p>}
    {evidence && <>
      {evidence.pages.map((page) => <article key={page.id}>
        <h3><a className="evidence-source-link" href={page.url} target="_blank" rel="noreferrer"><SiteIcon projectId={projectId} domain={targetDomain(page.url)!} size={24} /><span>{page.title || page.url}</span></a></h3>
        <p className="small">Inspected {shortDate(page.fetchedAt)}{page.status >= 400 ? " / Page unavailable" : ""}</p>
        <p className="answer-text">{page.text}</p>
      </article>)}
      {evidence.sources.map(source => <article key={source.id}>
        <h3><a className="evidence-source-link" href={source.url} target="_blank" rel="noreferrer"><SiteIcon projectId={projectId} domain={targetDomain(source.url)!} size={24} /><span>{source.title || source.url}</span></a></h3>
        <p className="small">Read by SurfacedBy {shortDate(source.fetchedAt)} / Page excerpt</p>
        <p className="answer-text">{source.text}</p>
      </article>)}
      {evidence.observations.map((answer) => <AnswerCard observation={answer} key={answer.id} />)}
      {evidence.missing > 0 && <p>{evidence.missing} supporting records are unavailable on this installation.</p>}
      {!evidence.pages.length && !evidence.sources.length && !evidence.observations.length && !evidence.missing && <p>This domain-level interpretation has no linked answer records. Review its evidence period and explanation.</p>}
    </>}
  </details>;
}

export function BackupControls({
  run, restoreOnly = false, onImported,
}: {
  run: (f: () => Promise<unknown>) => Promise<void>;
  restoreOnly?: boolean;
  onImported?: (project: Project) => Promise<void>;
}) {
  const [pending, setPending] = useState<{
      body: unknown;
      backup: boolean;
      summary: any[];
    } | null>(null),
    [message, setMessage] = useState("");
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{restoreOnly ? "Open saved work" : "Backup and restore"}</h2>
      </div>
      <div className="panel-padding">
        <p>
          {restoreOnly ? "Choose an exported project or backup. Your evidence and drafts stay together; connect providers when you need a new check." : "Save your projects, evidence, improvements and drafts. Provider credentials stay on this installation and are excluded."}
        </p>
        <div className="button-row">
          {!restoreOnly && <button
            className="secondary"
            onClick={() =>
              void run(async () =>
                download(
                  "opengeo-backup.json",
                  JSON.stringify(await api("/backup"), null, 2),
                  "application/json",
                ),
              )
            }
          >
            <Download size={16} />Download backup
          </button>}
          <label className="secondary file-upload">
            <Upload size={16} />Choose a backup or project
            <input
              className="visually-hidden"
              aria-label="Import backup or project"
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void run(async () => {
                  if (file.size > 20_000_000)
                    throw new Error(
                      "This file exceeds the 20 MB import limit.",
                    );
                  const body = JSON.parse(await file.text()),
                    backup = body.format === "opengeo-backup";
                  const result = await api(
                    backup ? "/backup/preview" : "/import/preview",
                    body,
                  );
                  setPending({
                    body,
                    backup,
                    summary: backup ? result : [result],
                  });
                  setMessage("");
                });
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {pending && (
          <div className="import-preview">
            <h3>Review the import</h3>
            {pending.summary.map((s, i) => (
              <p key={i}>
                <strong>{s.domain}</strong>: {s.pages} pages, {s.observations}{" "}
                observations, {s.drafts} drafts.{" "}
                {s.existing.length
                  ? "An existing website will be preserved. "
                  : ""}
                Imported work becomes an independent local project.
              </p>
            ))}
            <p>
              Historical evidence keeps its original collection time and
              provider. Past jobs will not run again.
            </p>
            <div className="button-row">
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ project: Project; replayed: boolean } | { project: Project; replayed: boolean }[]>(
                      pending.backup ? "/backup/restore" : "/import",
                      pending.body,
                    );
                    const imported = Array.isArray(result) ? result[0]?.project : result.project;
                    setPending(null);
                    setMessage(
                      imported ? "Your work has been imported. Select the website in the sidebar." : "This backup has no projects. Choose another file to restore.",
                    );
                    if (imported && onImported) await onImported(imported);
                  })
                }
              >
                Import reviewed work
              </button>
              <button className="secondary" onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        )}
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  );
}

export function ContentEditor({
  content,
  projectId,
  run,
  revise,
  onDraftChange,
}: {
  content: any;
  projectId: string;
  run: (f: () => Promise<unknown>) => Promise<void>;
  revise: () => void;
  onDraftChange: (edit: { markdown: string; baseMarkdown: string; recoverySession: string } | null) => void;
}) {
  const [markdown, setMarkdown] = useState<string>(content.markdown),
    [saved, setSaved] = useState<string>(content.markdown), [editing, setEditing] = useState(false), [error, setError] = useState(""),
    [recovery, setRecovery] = useState<{ baseMarkdown: string; markdown: string; updatedAt: string } | null>(null),
    [protection, setProtection] = useState("Opening draft..."), [justSaved, setJustSaved] = useState(false);
  const session = useRef(""), sequence = useRef(0), mounted = useRef(true);
  const path = "/projects/" + projectId + "/content/" + content.id;
  async function openRecovery() {
    const result = await api(path + "/recovery", {});
    if (!mounted.current) return;
    session.current = result.session; sequence.current = 0;
    setRecovery(result.recovery?.markdown !== result.recovery?.baseMarkdown ? result.recovery : null);
    setProtection("");
  }
  useEffect(() => {
    mounted.current = true;
    void openRecovery().catch((failure) => { if (mounted.current) { setError(failure.message); setProtection("Recovery unavailable"); } });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (markdown === saved) { setMarkdown(content.markdown); setSaved(content.markdown); }
  }, [content.markdown]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (markdown !== saved && protection !== "Edits protected locally") { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    window.opengeoDesktop?.setDraftProtectionPending(markdown !== saved && protection !== "Edits protected locally");
    return () => window.removeEventListener("beforeunload", guard);
  }, [markdown, saved, protection]);
  useEffect(() => {
    const unsubscribe = window.opengeoDesktop?.onQuitDeferred(() => setError("Your edits have not finished saving locally. Save or export the draft before quitting."));
    return () => { unsubscribe?.(); window.opengeoDesktop?.setDraftProtectionPending(false); };
  }, []);
  function changeDraft(value: string) {
    setJustSaved(false);
    window.opengeoDesktop?.setDraftProtectionPending(value !== saved);
    setMarkdown(value); onDraftChange(value === saved ? null : { markdown: value, baseMarkdown: saved, recoverySession: session.current });
    const currentSession = session.current, currentSequence = ++sequence.current;
    setProtection("Protecting edits...");
    void api(path + "/recovery", { session: currentSession, sequence: currentSequence, baseMarkdown: saved, markdown: value }, "PUT").then(() => {
      if (mounted.current && session.current === currentSession && sequence.current === currentSequence) setProtection(value === saved ? "" : "Edits protected locally");
    }).catch((failure) => {
      if (mounted.current && session.current === currentSession && sequence.current === currentSequence) { setProtection("Edits not protected. Save or export them before closing."); setError(failure.message); }
    });
  }
  return (
    <>
      {recovery && <section className="draft-recovery" aria-label="Draft recovery"><h3>Recover your unsaved edits</h3><p>{recovery.baseMarkdown !== content.markdown ? "The saved draft has changed. Review your recovered text before saving over it." : "Your edits from the previous session are available on this device."}</p><details><summary>Preview recovered text</summary><div className="document-preview" dangerouslySetInnerHTML={{ __html: markdownHtml(recovery.markdown) }} /></details><div className="button-row"><button className="primary" onClick={() => { changeDraft(recovery.markdown); setRecovery(null); setEditing(true); }}>Restore to editor</button><button className="secondary" onClick={() => void run(async () => { await api(path + "/recovery", undefined, "DELETE"); await openRecovery(); })}>Discard recovered edits</button><button className="secondary" onClick={() => download("opengeo-recovered-content.md", recovery.markdown)}>Export recovered edits</button></div></section>}
      <div className="workspace-tabs" role="group" aria-label="Draft view"><button aria-pressed={!editing} onClick={() => setEditing(false)}>Read draft</button><button aria-pressed={editing} disabled={!session.current || !!recovery} onClick={() => setEditing(true)}>Edit Markdown</button></div>
      {!editing ? <div className="document-preview" lang={content.locale} dir="auto" dangerouslySetInnerHTML={{ __html: markdownHtml(markdown) }} /> : <textarea
        className="draft"
        aria-label={"Draft for " + content.topic}
        value={markdown}
        onChange={(e) => changeDraft(e.target.value)}
      />}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!session.current && error && <button className="secondary" onClick={() => { setError(""); void openRecovery().catch((failure) => setError(failure.message)); }}>Reopen draft</button>}
      <p className="small draft-status" role="status">{protection || (justSaved ? "Draft saved." : "")}</p>
      {content.markdown !== saved && <p className="inline-error" role="alert">The saved draft changed elsewhere. Export your edits, then reopen the draft to review both versions.</p>}
      <div className="button-row">
        {/* The button stays mounted when there is nothing to save so keyboard focus is not lost. */}
        <button
          className={markdown === saved ? "secondary" : "primary"}
          aria-disabled={markdown === saved}
          onClick={() => {
            if (markdown === saved) return;
            void run(async () => {
              setError(""); try { await api(
                "/projects/" + projectId + "/content/" + content.id,
                { markdown, baseMarkdown: saved, recoverySession: session.current },
                "PATCH",
              );
              setSaved(markdown); onDraftChange(null); setJustSaved(true); session.current = ""; await openRecovery(); } catch (failure) { setError((failure as Error).message); }
            });
          }}
        >
          {markdown === saved ? <><Check size={15} />Saved</> : "Save draft"}
        </button>
        <button
          className="secondary"
          onClick={() => download("opengeo-content.md", markdown)}
        >
          Export Markdown
        </button>
        <button className="secondary" disabled={markdown !== saved} onClick={revise}>Revise with AI</button>
        <button
          className="secondary"
          onClick={() =>
            download(
              "opengeo-content.html",
              htmlDocument(content.topic || identity.name + " draft", markdown, content.locale),
              "text/html",
            )
          }
        >
          Export HTML
        </button>
      </div>
    </>
  );
}
export function ContentBrief({ brief, sources = [] }: { brief: string; sources?: { id: string; url: string; title: string }[] }) {
  // Historical briefs retain their original references in storage, while readers see source links.
  let readable = brief.replaceAll("user-knowledge", "Your supplied expertise");
  sources.forEach((source, index) => { readable = readable.replaceAll(source.id, "[Source " + (index + 1) + "](" + source.url + ")"); });
  return <div className="document-preview" dangerouslySetInnerHTML={{ __html: markdownHtml(readable) }} />;
}

export function ContentReview({ content }: { content: any }) {
  if (!content.review) return <p>No automated review is available for this draft. Review its claims and sources before publishing.</p>;
  const issues = content.review?.issues ?? [];
  return <section>
    <h3>Claims to review</h3>
    {content.review.scope === "numeric_and_absolute_statements" && <p className="small">Automated checks cover numbers and absolute claims{content.review.coverageComplete === false ? ", with some claims left unchecked" : ""}. Review the remaining claims and their sources before publishing.</p>}
    {content.sourceCoverage && <p className="small">Based on {content.sourceCoverage.pagesUsed} website {content.sourceCoverage.pagesUsed === 1 ? 'page' : 'pages'} selected for this topic. Source links are preserved with this draft.</p>}
    {content.reviewCurrent === false && <p>Your edits came after this review. Check the current draft before publishing.</p>}
    {issues.length ? <ul>{issues.map((issue: any, index: number) => <li key={index}>
      <strong>{issue.claim}</strong><p>{issue.reason}</p>
      {(issue.evidenceIds ?? []).map((id: string) => {
        const source = content.sourceEvidence?.find((s: any) => s.id === id);
        return source ? <p key={id}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></p> : id === 'user-knowledge' ? <p key={id}>Your supplied expertise</p> : null;
      })}
    </li>)}</ul> : <p>{content.review.coverageComplete === false
      ? "Checks are incomplete. Review the draft and its sources before publishing."
      : "No issues were found in the checked claims. Review the source support and wording before publishing."}</p>}
  </section>;
}

export function ModelSelector({ models, value, onChange, loading, validation }: { models: Model[]; value: string; onChange: (value: string) => void; loading: boolean; validation?: ReturnType<ReturnType<typeof useFormFeedback>["field"]> }) {
  return <label>Model<Select label="Model" {...validation} value={value} onChange={onChange} disabled={loading} placeholder={loading ? "Loading available models..." : "Choose a model"} options={models.map((model, index) => ({ value: model.id, label: model.name, detail: index === 0 ? "Default for this connection" : undefined, icon: <ProviderIcon provider={model.id} size={18} /> }))} /></label>;
}

export function ScheduleControls({ run, connected }: { run: (f: () => Promise<unknown>) => Promise<void>; connected: Record<string, boolean> }) {
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const feedback = useFormFeedback(), { setError } = feedback;
  const [schedules, setSchedules] = useState<any[]>([]), [projects, setProjects] = useState<Project[]>([]),
    [adding, setAdding] = useState(false), [kind, setKind] = useState("audit"),
    [provider, setProvider] = useState<Provider>("chatgpt"), [platform, setPlatform] = useState("chat_gpt"),
    [models, setModels] = useState<Model[]>([]), [model, setModel] = useState(""), [loading, setLoading] = useState(false),
    [platforms, setPlatforms] = useState<{ key: string; name: string }[]>([]), [frequency, setFrequency] = useState("weekly"), [saving, setSaving] = useState(false), [message, setMessage] = useState(""),
    [discoveryError, setDiscoveryError] = useState(""), [discoveryRevision, setDiscoveryRevision] = useState(0),
    [consoleAvailability, setConsoleAvailability] = useState<{ content: boolean; answers: boolean } | null>(null),
    [availabilityError, setAvailabilityError] = useState("");
  async function mutate(action: () => Promise<unknown>) {
    setSaving(true); setError(""); setMessage("");
    try { await run(async () => { try { await action(); } catch (failure) { setError(failure); } }); }
    finally { setSaving(false); }
  }
  const availableConnections: Record<string, boolean> = { ...connected, console: connected.console && (kind === "content" ? consoleAvailability?.content : consoleAvailability?.answers) === true },
    allowed: Provider[] = kind === "content" ? ["chatgpt", "console", "openrouter"] : ["chatgpt", "console", "dataforseo", "openrouter"],
    choices = providerOptions(availableConnections, allowed), local = kind === "audit",
    workflows = [{ value: "audit", label: "Local audit", detail: "No provider required" },
      ...(connected.chatgpt || connected.openrouter || connected.dataforseo || connected.console && consoleAvailability?.answers ? [{ value: "recheck", label: "Visibility recheck" }] : []),
      ...(connected.chatgpt || connected.openrouter || connected.console && consoleAvailability?.content ? [{ value: "content", label: "Content draft" }] : [])];
  useEffect(() => {
    let stopped = false;
    setConsoleAvailability(null); setAvailabilityError("");
    if (!connected.console) return;
    void api("/providers/console/capabilities").then(capabilities => {
      if (!stopped) setConsoleAvailability({ content: capabilities.content_available === true && capabilities.operations?.includes("content") === true,
        answers: (capabilities.platforms ?? []).some((entry: any) => entry.enabled) });
    }).catch(() => { if (!stopped) setAvailabilityError("SurfacedBy availability could not be checked."); });
    return () => { stopped = true; };
  }, [connected.console, discoveryRevision]);
  useEffect(() => {
    let stopped = false;
    const refresh = () => void Promise.all([api("/schedules"), api("/projects")]).then(([nextSchedules, nextProjects]) => { if (!stopped) { setSchedules(nextSchedules); setProjects(nextProjects); } }).catch((failure) => { if (!stopped) setError(failure.message); });
    refresh(); const timer = setInterval(refresh, 15000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!choices.some((choice) => choice.value === provider) && choices.length) setProvider(choices[0].value as Provider);
  }, [kind, connected.chatgpt, connected.console, connected.dataforseo, connected.openrouter, consoleAvailability]);
  useEffect(() => {
    let stopped = false;
    setModels([]); setModel(""); setPlatforms([]); setDiscoveryError(""); setError("");
    if (local || !connected[provider]) { setLoading(false); return; }
    setLoading(true);
    const request = provider === "console" ? api("/providers/console/capabilities").then((capabilities) => {
      if (stopped) return;
      if (kind === "content") {
        if (!capabilities.content_available || !capabilities.operations?.includes("content")) setDiscoveryError("Content is unavailable on this SurfacedBy connection. Choose ChatGPT or OpenRouter.");
        return;
      }
      const available = (capabilities.platforms ?? []).filter((entry: any) => entry.enabled);
      setPlatforms(available); if (!available.some((entry: any) => entry.key === platform)) setPlatform(available[0]?.key ?? "");
      if (!available.length) setDiscoveryError("This connection has no supported answer platforms available.");
    }) : api<Model[]>("/providers/" + provider + "/models?platform=" + (provider === "dataforseo" ? platform : "chat_gpt")).then((available) => {
      if (!stopped) { setModels(available); setModel(available[0]?.id ?? ""); if (!available.length) setDiscoveryError("This connection has no supported models available."); }
    });
    void request.catch((failure) => { if (!stopped) setDiscoveryError(failure.message); }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [provider, platform, local, kind, connected[provider], discoveryRevision]);
  return <section className="panel">
    <div className="panel-heading"><h2>Schedules</h2><button className="secondary" disabled={saving} onClick={() => { submission.current = null; setError(""); setAdding(!adding); }}><Plus size={15} />Add schedule</button></div>
    <p className="small schedule-intro">Runs while {identity.name} is open. Docker can run continuously on your host. Missed runs become one fresh run.</p>
    {!schedules.length && !adding && <div className="empty"><CalendarClock size={28} /><h3>Keep your workflow moving</h3><p>Choose a website, task and time. Start with a free local audit, or schedule AI work using a connected provider.</p></div>}
    {schedules.map((entry) => <div className="schedule-row" key={entry.id}>
      <CalendarClock size={18} /><div>
        <strong>{projects.find((project) => project.id === entry.job.projectId)?.domain ?? "Website unavailable"}</strong>
        <p className="small">{entry.job.kind === "audit" ? "Local audit" : entry.job.kind === "content" ? "Content draft" : "Visibility recheck"}, {entry.frequency === "daily" ? "daily" : "weekly"}{entry.job.provider ? " with " + providerLabels[entry.job.provider as Provider] : ""}</p>
        <small>Next run {dateTime(entry.nextAt)} ({entry.timezone.replaceAll("_", " ")})</small>
        {entry.job.provider && !connected[entry.job.provider] && <p className="small">Reconnect this provider before the next run.</p>}
        {entry.lastError && <p role="status" className="small">{entry.lastError}</p>}
      </div>
      <button aria-label={"Remove schedule for " + (projects.find((project) => project.id === entry.job.projectId)?.domain ?? "website")} className="icon-button" disabled={saving} onClick={() => void mutate(async () => {
        await api("/schedules/" + entry.id, undefined, "DELETE"); setSchedules(await api("/schedules")); setMessage("Schedule removed.");
      })}><Trash2 size={17} /></button>
    </div>)}
    <FormFeedback feedback={feedback} />
    {message && <p className="panel-padding" role="status">{message}</p>}
    {adding && <form className="settings-form" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      void mutate(async () => {
        const request = {
          job: { projectId: data.get("project"), kind, ...(!local ? { provider, model: model || undefined, platform: ["chatgpt", "openrouter"].includes(provider) ? "chat_gpt" : platform } : {}),
            ...(kind === "content" ? { topic: data.get("topic") } : {}), maxCostUsd: local || provider === "chatgpt" ? 0 : Number(data.get("budget")) },
          frequency, hour: Number(data.get("hour")), weekday: Number(data.get("weekday") ?? 1), timezone: data.get("timezone"),
          monthlyBudgetUsd: local || provider === "chatgpt" ? 0 : Number(data.get("monthly")),
        };
        const fingerprint = JSON.stringify(request);
        if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
        await api("/schedules", request, "POST", submission.current.key);
        setSchedules(await api("/schedules")); setAdding(false); submission.current = null; setMessage("Schedule saved.");
      });
    }}>
      <div className="form-grid">
        <label>Website<Select label="Scheduled website" name="project" {...feedback.field("projectId")} options={projects.map((project) => ({ value: project.id, label: project.domain, detail: project.brand }))} placeholder="Add a website first" /></label>
        <label>Workflow<Select label="Scheduled workflow" {...feedback.field("kind")} value={kind} onChange={setKind} searchable={false} options={workflows} /></label>
        {!local && choices.length > 0 && <><label>Connection<Select label="Schedule connection" {...feedback.field("provider")} value={provider} onChange={(value) => { setProvider(value as Provider); setPlatform("chat_gpt"); }} options={choices} placeholder="Connect a provider first" /></label>
          {["dataforseo", "console"].includes(provider) && kind !== "content" && <label>Answer platform<Select label="Schedule answer platform" {...feedback.field("platform")} value={platform} onChange={setPlatform} options={(provider === "console" ? platforms : [{ key: "chat_gpt", name: "ChatGPT" }, { key: "gemini", name: "Gemini" }, { key: "perplexity", name: "Perplexity" }]).map((entry) => ({ value: entry.key, label: entry.name, icon: <ProviderIcon provider={entry.key} size={18} /> }))} /></label>}
          {provider !== "console" && <ModelSelector models={models} value={model} onChange={setModel} loading={loading} validation={feedback.field("model")} />}
        </>}
        <label>Frequency<Select label="Schedule frequency" {...feedback.field("frequency")} value={frequency} onChange={setFrequency} searchable={false} options={[{ value: "weekly", label: "Weekly" }, { value: "daily", label: "Daily" }]} /></label>
        <label>Time<Select label="Schedule time" name="hour" {...feedback.field("hour")} defaultValue="9" options={Array.from({ length: 24 }, (_,hour) => ({ value: String(hour), label: String(hour).padStart(2,"0") + ":00" }))} /></label>
        {frequency === "weekly" && <label>Day<Select label="Schedule day" name="weekday" {...feedback.field("weekday")} defaultValue="1" searchable={false} options={["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,index) => ({ value: String(index), label: day }))} /></label>}
        <label>Time zone<Select label="Schedule time zone" name="timezone" {...feedback.field("timezone")} defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} options={[...new Set([Intl.DateTimeFormat().resolvedOptions().timeZone, ...Intl.supportedValuesOf("timeZone")])].map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))} /></label>
        {!local && choices.length > 0 && provider !== "chatgpt" && <><label>Maximum per run (USD)<input name="budget" {...feedback.field("maxCostUsd")} type="number" min="0.01" step="0.01" required placeholder="Your approved maximum" /></label><label>Monthly maximum (USD)<input name="monthly" {...feedback.field("monthlyBudgetUsd")} type="number" min="0.01" step="0.01" required placeholder="Your approved maximum" /></label></>}
      </div>
      {kind === "content" && <label>Topic<input name="topic" {...feedback.field("topic")} required placeholder="What should this scheduled content help readers understand?" /></label>}
      {!local && !choices.length && <p role="status">Connect a provider in Connections before scheduling AI work.</p>}
      {availabilityError && <div><p className="inline-error" role="alert">{availabilityError}</p><button type="button" className="secondary" disabled={saving} onClick={() => setDiscoveryRevision(value => value + 1)}>Retry SurfacedBy availability</button></div>}
      {!local && discoveryError && <div><p className="inline-error" role="alert">{discoveryError}</p><button type="button" className="secondary" disabled={loading || saving} onClick={() => setDiscoveryRevision(value => value + 1)}>Retry availability check</button></div>}
      {!local && provider === "chatgpt" && <p className="small">Uses your ChatGPT plan within its limits. Affected work pauses if access is unavailable.</p>}
      {kind === "content" && provider === "console" && <p className="small">Scheduled drafts run automatically only when their estimate fits both approved maximums. Unused credits are returned after completion.</p>}
      <div className="button-row"><button className="primary" disabled={saving || !projects.length || loading || (!local && (!!discoveryError || !choices.length || !availableConnections[provider] || (provider !== "console" && !model) || (provider === "console" && kind !== "content" && !platform)))}>{saving ? "Saving schedule..." : "Save schedule"}</button><button type="button" disabled={saving} className="secondary" onClick={() => setAdding(false)}>Cancel</button></div>
    </form>}
  </section>;
}
