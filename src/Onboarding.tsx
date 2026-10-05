import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Globe, LoaderCircle, ShieldCheck, ScanSearch, X, MessagesSquare, FileCheck2, Plus, Sparkles, Users } from "lucide-react";
import { ConnectionSettings, type ChatGPTProfiles } from "./ConnectionSettings";
import { providerLabels, ProviderIcon } from "./provider-ui";
import { Select } from "./Select";
import { api } from "./api";
import { FormFeedback, useFormFeedback } from "./FormFeedback";
import identity from "../brand/identity.json";
import { UsagePreference } from "./UsagePreference";
import { QuestionRows, type QuestionRow } from "./QuestionRows";
import type { DiscoveredWebsite, Job, Project, Provider, SetupDraft } from "../server/contracts";

const steps = ["Connection", "Website", "Questions", "Review"];
const languages = [
  { value: "en-US", label: "English (United States)" }, { value: "en-GB", label: "English (United Kingdom)" },
  { value: "fr-FR", label: "French (France)" }, { value: "fr-MA", label: "French (Morocco)" },
  { value: "es-ES", label: "Spanish (Spain)" }, { value: "de-DE", label: "German (Germany)" },
  { value: "ar-MA", label: "Arabic (Morocco)" }, { value: "pt-BR", label: "Portuguese (Brazil)" },
];
/** The first check returns only websites offering a substitute; reference-only sources are excluded server-side. */
const competingSites = (check: Job) => (check.result as { competitors?: DiscoveredWebsite[] }).competitors ?? [];

export function Onboarding({ connected, profiles, refresh, finish, cancel, initialStep = 0, draft, savedProject }: {
  connected: Record<string, boolean>; profiles: ChatGPTProfiles; refresh: () => Promise<void>;
  finish: (project: Project) => Promise<void>; cancel?: () => void; initialStep?: number;
  draft?: SetupDraft | null; savedProject?: Project;
}) {
  const initialProvider = draft?.provider ?? (connected.chatgpt ? "chatgpt" : connected.console ? "console" : connected.dataforseo && connected.openrouter ? "dataforseo" : "chatgpt");
  const [step, setStep] = useState(draft?.step ?? initialStep), [provider, setProvider] = useState<Provider>(initialProvider === "openrouter" ? "dataforseo" : initialProvider),
    [localOnly, setLocalOnly] = useState(draft?.localOnly ?? false), [busy, setBusy] = useState(false),
    [domain, setDomain] = useState(savedProject?.domain ?? ""), [brand, setBrand] = useState(savedProject?.brand ?? ""), [locale, setLocale] = useState(savedProject?.locale ?? "en-US"),
    [rows, setRows] = useState<QuestionRow[]>(draft?.questionRows ?? (savedProject?.prompts ?? []).map(text => ({ id: crypto.randomUUID(), text, selected: true }))), [project, setProject] = useState<Project | null>(savedProject ?? null),
    [discoveryId, setDiscoveryId] = useState(draft?.discoveryJobId ?? ""), [discovery, setDiscovery] = useState<Job | null>(null), [readingAudit, setReadingAudit] = useState<Job | null>(null),
    [checkId, setCheckId] = useState(draft?.checkJobId ?? ""), [check, setCheck] = useState<Job | null>(null),
    [budget, setBudget] = useState(""), [selectedCompetitors, setSelectedCompetitors] = useState<string[]>(savedProject?.competitors ?? []), [previewSuggestions, setPreviewSuggestions] = useState(false);
  const appliedDiscovery = useRef("");
  const suggestionRequest = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const feedback = useFormFeedback(), { setError } = feedback;
  useEffect(() => { heading.current?.focus(); }, [step]);
  const prompts = [...new Set(rows.filter(row => row.selected).map(row => row.text.trim()).filter(item => item.length >= 3))];
  const connectionReady = provider === "dataforseo" ? connected.dataforseo && connected.openrouter : connected[provider];
  useEffect(() => { if (draft) { setProvider(draft.provider === "openrouter" ? "dataforseo" : draft.provider); setLocalOnly(draft.localOnly); } }, [draft?.provider, draft?.localOnly]);
  useEffect(() => {
    if (!discoveryId && !checkId) return;
    let stopped = false;
    const poll = async () => {
      try {
        if (discoveryId) {
          const job = await api<Job>("/jobs/" + discoveryId);
          // Suggestions wait behind the website audit they read; its progress is what is happening meanwhile.
          const audit = job.status === "queued" && job.auditJobId ? await api<Job>("/jobs/" + job.auditJobId) : null;
          if (!stopped) {
            setDiscovery(job);
            setReadingAudit(audit && ["queued", "running"].includes(audit.status) ? audit : null);
            if (job.status === "completed" && appliedDiscovery.current !== job.id) {
              appliedDiscovery.current = job.id;
              const questions = (job.result as { questions: { text: string }[] }).questions;
              if (questions.length) setRows(current => current.length ? current : questions.map(item => ({ id: crypto.randomUUID(), text: item.text, selected: true })));
            }
          }
        }
        if (checkId) { const job = await api<Job>("/jobs/" + checkId); if (!stopped) setCheck(job); }
      } catch { /* A temporary disconnect must preserve setup and completed evidence. */ }
    };
    void poll(); const timer = setInterval(() => void poll(), 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [discoveryId, checkId]);
  const draftSave = useRef(Promise.resolve());
  const rowRevision = useRef(0);
  useEffect(() => {
    if (step !== 2 || !project) return;
    const revision = ++rowRevision.current;
    const timer = setTimeout(() => {
      draftSave.current = draftSave.current.catch(() => {}).then(async () => {
        if (revision !== rowRevision.current) return;
        await api("/onboarding/draft", makeDraft(2), "PUT");
      });
      void draftSave.current.catch(setError);
    }, 350);
    return () => { clearTimeout(timer); rowRevision.current++; };
  }, [rows, step, project?.id, discoveryId, checkId, provider, localOnly]);
  function makeDraft(next: number): SetupDraft {
    return { step: next, provider, localOnly, ...(project ? { projectId: project.id } : {}), ...(discoveryId ? { discoveryJobId: discoveryId } : {}), ...(checkId ? { checkJobId: checkId } : {}), questionRows: rows };
  }
  async function persistConnection() {
    await api("/onboarding/draft", { ...makeDraft(0), localOnly: false }, "PUT");
    setLocalOnly(false);
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }
  function go(next: number) { setError(""); setStep(next); }
  async function continueConnection(onlyLocal: boolean) {
    if (!onlyLocal && !connectionReady) return;
    await api("/onboarding/draft", { ...makeDraft(1), localOnly: onlyLocal }, "PUT");
    setLocalOnly(onlyLocal); go(1);
  }
  async function saveWebsite() {
    const changed = Boolean(project && (domain.trim() !== project.domain || brand.trim() !== project.brand || locale !== project.locale));
    if (changed) {
      for (const job of [discovery, check]) if (job && ["queued", "running"].includes(job.status)) await api("/jobs/" + job.id + "/cancel", {});
      rowRevision.current++; await draftSave.current.catch(() => {});
      setRows([]); setDiscoveryId(""); setDiscovery(null); setReadingAudit(null); setCheckId(""); setCheck(null); appliedDiscovery.current = "";
    }
    const body = { domain: domain.trim(), brand: brand.trim(), locale, prompts: changed ? [] : project?.prompts ?? [], aliases: project?.aliases ?? [], competitors: changed ? [] : project?.competitors ?? [], knowledge: changed ? "" : project?.knowledge ?? "" };
    const result = await api<{ project: Project }>("/onboarding/website", { project: body, draft: { step: localOnly ? 3 : 2, provider, localOnly, ...(project ? { projectId: project.id } : {}) } });
    const saved = result.project;
    setDomain(saved.domain); setProject(saved); go(localOnly ? 3 : 2);
    if (!localOnly && provider === "chatgpt" && !saved.prompts.length) {
      const job = await api<Job>("/onboarding/questions", { projectId: saved.id, provider: "chatgpt" });
      setDiscoveryId(job.id); setDiscovery(job);
    }
  }
  async function suggestQuestions() {
    if (!project) return;
    const ai = provider === "chatgpt" ? "chatgpt" : "openrouter";
    suggestionRequest.current ??= crypto.randomUUID();
    const job = await api<Job>("/onboarding/questions", { projectId: project.id, provider: ai, maxCostUsd: ai === "chatgpt" ? 0 : Number(budget), requestId: suggestionRequest.current });
    suggestionRequest.current = null;
    setPreviewSuggestions(false);
    setDiscoveryId(job.id); setDiscovery(job);
  }
  function useSuggestions() {
    const questions = (discovery?.result as { questions?: { text: string }[] } | undefined)?.questions;
    if (discovery?.status !== "completed" || !questions?.length) return;
    setRows(questions.map(item => ({ id: crypto.randomUUID(), text: item.text, selected: true })));
    setPreviewSuggestions(false);
  }
  async function saveQuestions() {
    if (!project) return;
    rowRevision.current++; await draftSave.current.catch(() => {});
    const { project: saved } = await api<{ project: Project }>("/onboarding/website", { project: { domain: project.domain, brand: project.brand, aliases: project.aliases, competitors: project.competitors, knowledge: project.knowledge, locale, prompts }, draft: { ...makeDraft(3), checkJobId: undefined } });
    setCheckId(""); setCheck(null);
    setProject(saved); go(3);
  }
  async function start() {
    if (!project) return;
    if (!localOnly && provider === "chatgpt" && !checkId) {
      const job = await api<Job>("/onboarding/check", { projectId: project.id });
      setCheckId(job.id); setCheck(job); return;
    }
    if (check?.status === "completed") {
      const { id, createdAt, ...input } = project;
      const saved = await api<Project>("/projects/" + id, { ...input, competitors: selectedCompetitors }, "PUT");
      setProject(saved);
    }
    await api("/onboarding/start", { step: 3, projectId: project.id, localOnly, provider });
    await finish({ ...project, competitors: check?.status === "completed" ? selectedCompetitors : project.competitors });
  }
  return <div className="setup-shell">
    <header className="setup-header"><div className="brand"><img src="/logo.svg" width="30" height="30" alt="" /><span>{identity.name}</span></div>
      {cancel ? <button className="icon-button" aria-label="Cancel website setup" disabled={busy} onClick={() => void run(async () => { await api("/onboarding/draft", null, "PUT"); cancel(); })}><X size={20} /></button> : <span className="setup-local"><ShieldCheck size={15} />Your local workspace</span>}
    </header>
    <main className="setup-main" id="main-content">
      <ol className="setup-progress" aria-label="Setup progress">{steps.map((label, index) => ({ label, index })).filter(({ index }) => !localOnly || index !== 2).map(({ label, index }, position) => <li key={label} className={index === step ? "current" : index < step ? "complete" : ""} aria-current={index === step ? "step" : undefined}><span>{index < step ? <Check size={14} /> : position + 1}</span><strong>{label}</strong></li>)}</ol>
      <div className="setup-layout"><aside className="setup-story" aria-label="How your workspace works"><h2>Get found<br />in AI search.</h2><p>See where your brand appears.<br />Turn the evidence into improvements.</p><div className="setup-workflow-visual"><div><span><Globe size={21} /></span><section><strong>Your website</strong><small>Audit your public pages</small></section></div><div><span><MessagesSquare size={21} /></span><section><strong>AI visibility</strong><small>Track mentions and citations</small></section></div><div><span><FileCheck2 size={21} /></span><section><strong>Your next move</strong><small>Improve content and recheck</small></section></div></div><div className="setup-story-privacy"><ShieldCheck size={15} /><span>Your projects stay on your device.</span></div></aside>
      <section className="setup-body" aria-busy={busy}>
        <div className="setup-heading"><h1 ref={heading} tabIndex={-1}>{step === 0 ? "Power your AI visibility workspace" : step === 1 ? "Which website are you improving?" : step === 2 ? "Choose how customers find you" : check?.status === "completed" ? "Your first answers are ready" : "Ready for your first check?"}</h1>
          <p>{step === 0 ? "Use your ChatGPT subscription, connect SurfacedBy, or bring your own measurement and AI providers." : step === 1 ? "Add your public website and the brand you want to track." : step === 2 ? "Review questions suggested from your website. Edit them, add your own and choose which to check." : localOnly ? "Start with a free audit of your public pages." : provider === "chatgpt" ? "Check your selected questions with ChatGPT and see which businesses appear." : "Your local audit is free. Review a price before starting visibility checks from your dashboard."}</p>
        </div>
        <FormFeedback feedback={feedback} />
        {step === 0 && <>
          <div className="setup-provider-options" role="group" aria-label="Choose your setup">{(["chatgpt", "console", "dataforseo"] as const).map((item) => <button key={item} className={provider === item ? "selected" : ""} aria-pressed={provider === item} disabled={busy} onClick={() => void run(async () => { await api("/onboarding/draft", { ...makeDraft(0), provider: item, localOnly: false }, "PUT"); setProvider(item); setLocalOnly(false); })}><div className="setup-choice-icons"><ProviderIcon provider={item} size={21} />{item === "dataforseo" && <><Plus size={12} /><ProviderIcon provider="openrouter" size={21} /></>}</div><span>{item === "dataforseo" ? "Bring your own" : providerLabels[item]}<small>{item === "chatgpt" ? "Your subscription" : item === "console" ? "Managed insights" : "DataForSEO + OpenRouter"}</small></span>{(item === "dataforseo" ? connected.dataforseo && connected.openrouter : connected[item]) && <Check size={14} />}</button>)}</div>
          <ConnectionSettings connected={connected} profiles={profiles} run={run} variant="onboarding" provider={provider} beforeConnect={persistConnection} />
          <div className="setup-actions"><div className="local-audit-option"><button className="secondary" disabled={busy} onClick={() => void run(() => continueConnection(true))}>Use local audits only</button><small>Not recommended: no AI visibility or content.</small></div><button className="primary" disabled={busy || !connectionReady} onClick={() => void run(() => continueConnection(false))}>Continue <ArrowRight size={16} /></button></div>
        </>}
        {step === 1 && <form onSubmit={(event) => { event.preventDefault(); void run(saveWebsite); }}>
          <label htmlFor="setup-website">Website<input id="setup-website" name="domain" {...feedback.field("domain")} value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="example.com" required autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="url" /></label>
          <label htmlFor="setup-brand">Brand name<input id="setup-brand" name="brand" {...feedback.field("brand")} value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Your business or product name" required maxLength={100} /></label>
          <label>Answer language and region<Select label="Answer language and region" {...feedback.field("locale")} value={locale} options={languages} onChange={setLocale} /></label>
          <div className="setup-actions"><button type="button" className="secondary" onClick={() => go(0)} disabled={busy}><ArrowLeft size={15} />Back</button><button className="primary" disabled={busy}>{busy ? "Reading website..." : !localOnly && provider === "chatgpt" ? "Find my questions" : "Continue"}<ArrowRight size={16} /></button></div>
        </form>}
        {step === 2 && <form onSubmit={(event) => { event.preventDefault(); void run(saveQuestions); }}>
          {discovery && <div className="question-discovery" role="status">{["queued", "running"].includes(discovery.status) ? <LoaderCircle className="loading-spin" size={21} /> : <Sparkles size={21} />}<div><strong>{discovery.status === "completed" ? "Questions based on your website" : readingAudit ? "Reading your website before suggesting questions" : discovery.progress}</strong><p>{discovery.status === "completed" ? `${(discovery.result as { pagesRead: number }).pagesRead} ${(discovery.result as { pagesRead: number }).pagesRead === 1 ? "page" : "pages"} reviewed. Choose what matters to your business.` : readingAudit ? (readingAudit.status === "running" ? readingAudit.progress : "Starting with your home page and sitemap") : ["queued", "running"].includes(discovery.status) ? "Finding relevant customer questions from your pages." : "Your progress is saved. You can add questions yourself or resume from the dashboard."}</p></div>{["queued", "running"].includes(discovery.status) && <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => api("/jobs/" + discovery.id + "/cancel", {}))}>Stop</button>}</div>}
          {!["queued", "running"].includes(discovery?.status ?? "") && <div className="question-tools">{provider !== "console" && <>{provider === "dataforseo" && <label>Maximum for suggestions (USD)<input type="number" min="0.01" step="0.01" value={budget} onChange={event => setBudget(event.target.value)} /></label>}<button type="button" className="secondary" disabled={busy || provider === "dataforseo" && !(Number(budget) > 0)} onClick={() => void run(suggestQuestions)}><Sparkles size={15} />{discovery ? "Refresh suggestions" : "Suggest from my website"}</button>{discovery?.status === "completed" && (discovery.result as { questions: { text: string }[] }).questions.length > 0 && JSON.stringify(rows.map(row => row.text)) !== JSON.stringify((discovery.result as { questions: { text: string }[] }).questions.map(item => item.text)) && <button type="button" className="secondary" disabled={busy} onClick={() => setPreviewSuggestions(current => !current)} aria-expanded={previewSuggestions}>Review suggestions</button>}</>}{provider === "console" && <p className="small">Add the questions you want to track. SurfacedBy will analyze the answers in your visibility check.</p>}</div>}
          {previewSuggestions && discovery?.status === "completed" && <section className="suggestion-preview" aria-label="Suggested questions"><header><Sparkles size={17} /><h2>Suggested questions</h2></header><ol>{(discovery.result as { questions: { text: string }[] }).questions.map((question, index) => <li key={index}>{question.text}</li>)}</ol><footer><p>Using these replaces your current list.</p><div><button type="button" className="secondary" onClick={() => setPreviewSuggestions(false)}>Keep my questions</button><button type="button" className="primary" onClick={useSuggestions}>Use these questions<Check size={15} /></button></div></footer></section>}
          <QuestionRows rows={rows} onChange={setRows} disabled={busy} feedback={feedback} />
          <p className="small">Only selected questions will be checked. You can change them later.</p>
          <div className="setup-actions"><button type="button" className="secondary" disabled={busy} onClick={() => go(1)}><ArrowLeft size={15} />Back</button><button className="primary" disabled={busy || !prompts.length}>{busy ? "Saving questions..." : "Continue"}<ArrowRight size={16} /></button></div>
        </form>}
        {step === 3 && project && <>
          <dl className="setup-summary"><div><dt><Globe size={16} />Website</dt><dd>{project.domain}<small>{project.brand}</small></dd></div><div><dt><ProviderIcon provider={localOnly ? "local" : provider} size={16} />Connection</dt><dd>{localOnly ? "Local audits only" : provider === "dataforseo" ? "DataForSEO + OpenRouter" : providerLabels[provider]}</dd></div>{!localOnly && <div><dt><MessagesSquare size={16} />Questions</dt><dd>{project.prompts.length} ready to check</dd></div>}<div><dt><ScanSearch size={16} />First run</dt><dd>{!localOnly && provider === "chatgpt" ? "ChatGPT answers + competitor discovery" : "Website audit"}<small>{!localOnly && provider === "chatgpt" ? "Uses your connected ChatGPT plan" : "No provider charge"}</small></dd></div></dl>
          {check && <section className="setup-check-status" aria-live="polite"><h2>{["queued", "running"].includes(check.status) ? <LoaderCircle className="loading-spin" size={19} /> : <Users size={19} />}{check.status === "completed" ? "Choose competitors to follow" : check.progress}</h2>
            {check.status === "completed" ? <><p>These businesses were named and cited in your answers. Choose which belong in your comparison.</p>{competingSites(check).map(item => <label className="competitor-choice" key={item.domain}><input type="checkbox" checked={selectedCompetitors.includes(item.domain)} onChange={event => setSelectedCompetitors(current => event.target.checked ? [...current, item.domain] : current.filter(domain => domain !== item.domain))} /><div><strong>{item.name}</strong><small>{item.domain}</small><p>{item.reason}</p></div></label>)}{!competingSites(check).length && <p>No competitors had enough supporting evidence in these answers. You can add them later.</p>}</> : <><p>{["queued", "running"].includes(check.status) ? "Your answers and citations are saved as they arrive." : "Saved answers are kept. Open your dashboard to review or resume this check."}</p>{["queued", "running"].includes(check.status) && <button className="secondary" disabled={busy} onClick={() => void run(() => api("/jobs/" + check.id + "/cancel", {}))}>Stop check</button>}</>}
          </section>}
          <UsagePreference compact />
          <div className="setup-actions"><button className="secondary" disabled={busy || !!checkId} onClick={() => go(localOnly ? 1 : 2)}><ArrowLeft size={15} />Back</button><button className="primary" disabled={busy} onClick={() => void run(start)}>{busy ? <LoaderCircle className="loading-spin" size={16} /> : <ScanSearch size={16} />}{busy ? "Starting..." : checkId ? "Open dashboard" : !localOnly && provider === "chatgpt" ? "Check my questions" : "Open workspace & audit"}</button></div>
        </>}
      </section></div>
    </main>
  </div>;
}
