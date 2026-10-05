import {
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  ModelSelector,
} from "./WorkflowControls";
import {
  LayoutDashboard,
  ScanSearch,
  ChartNoAxesCombined,
  MessagesSquare,
  Link,
  Lightbulb,
  FileText,
  FilePenLine,
  Users,
  ChartColumn,
  Settings,
  Plus,
  ArrowUpRight,
  Play,
  RefreshCw,
  ChevronDown,
  Check,
  Search,
  Globe,
  ArrowRight,
  Download,
  X,
  ShieldCheck,
  Menu,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
} from "lucide-react";
import { percent, shortDate, relativeTime, dateTime, pointChange, usd } from "./format";
import { api } from "./api";
import { ConnectionSettings, type ChatGPTProfiles } from "./ConnectionSettings";
import { Onboarding } from "./Onboarding";
import { QuestionRows, type QuestionRow } from "./QuestionRows";
import { Select } from "./Select";
import { FormFeedback, useFormFeedback } from "./FormFeedback";
import { ProviderIcon, providerLabels, providerOptions, providerOrder } from "./provider-ui";
import { AnswerCard, AnswerDistribution, AuditEssentials, CheckHistory, CitationComparison, MeasurementScope, PromptTable, SourcesTable, VisibilityChart } from "./DataPresentation";
import { SiteIcon } from "./SiteIcon";
import { AuditSummary } from "./AuditSummary";
import { Findings } from "./Findings";
import { findingGroups, opportunityFindings, auditFindings, targetDomain, targetLabel } from "./finding-groups";
import { ContentWorkspace } from "./ContentWorkspace";
import { ErrorBoundary } from "./ErrorBoundary";
import { runsNeedingAttention } from "./runs";
import { Competitors } from "./Competitors";
import { completedMeasurement } from "../server/portable-results";
import type { Presentation } from "../server/presentation";
import identity from "../brand/identity.json";
import type {
  Project,
  Job,
  Observation,
  PageEvidence,
  Finding,
  Model,
  Provider,
  SetupDraft,
  AuditCoverage,
} from "../server/contracts";
type Workspace = {
  project: Project;
  jobs: Job[];
  pages: PageEvidence[];
  auditCoverage: AuditCoverage | null;
  observations: Observation[];
  findings: Finding[];
  content: any[];
  metrics: {
    requested: number;
    completed: number;
    missing: number;
    mentionRate: number | null;
    citationRate: number | null;
    citations: number;
  };
  measurement: Job | null;
  presentation: Presentation;
  comparison: any;
  competitors: {
    domain: string;
    answersCiting: number;
    answersCollected: number;
    citationRate: number | null;
    urls: string[];
    observationIds: string[];
  }[];
};
const navigation = [
  ["Overview", LayoutDashboard],
  ["Site Audit", ScanSearch],
  ["Visibility", ChartNoAxesCombined],
  ["Responses", MessagesSquare],
  ["Sources", Link],
  ["Opportunities", Lightbulb],
  ["Content", FileText],
  ["Competitors", Users],
  ["Reports", ChartColumn],
  ["Settings", Settings],
] as const;
function Empty({ title, children }: { title: string; children: ReactNode }) {
  const Icon = /draft|create|content/i.test(title) ? FileText : /audit|page/i.test(title) ? ScanSearch : /answer|response/i.test(title) ? MessagesSquare : /recommendation|improvement/i.test(title) ? Lightbulb : Search;
  return (
    <div className="empty">
      <Icon size={24} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [selected, setSelected] = useState(""),
    [page, setPage] = useState("Overview"),
    [connectionsRequest, setConnectionsRequest] = useState(0),
    [mobileNavigation, setMobileNavigation] = useState(false),
    [workspace, setWorkspace] = useState<Workspace | null>(null),
    [connected, setConnected] = useState<Record<string, boolean>>({}),
    [profiles, setProfiles] = useState<ChatGPTProfiles>({ active: null, profiles: [] }),
    [error, setError] = useState(""),
    [refreshError, setRefreshError] = useState(""),
    [refreshing, setRefreshing] = useState(false),
    [busy, setBusy] = useState(false),
    [newProject, setNewProject] = useState(false),
    [jobDialog, setJobDialog] = useState<Job["kind"] | null>(null),
    [revision, setRevision] = useState<any>(null),
    [query, setQuery] = useState(""),
    [evidenceFilter, setEvidenceFilter] = useState<{ ids: string[]; label: string } | null>(null),
    [contentTopic, setContentTopic] = useState(""),
    [contentFinding, setContentFinding] = useState<Finding | null>(null),
    [competitorCheck, setCompetitorCheck] = useState<string | undefined>(),
    [focusedFinding, setFocusedFinding] = useState<string | null>(null),
    [selectedContent, setSelectedContent] = useState(""),
    [pendingContent, setPendingContent] = useState<{ projectId: string; jobId: string } | null>(null),
    [unsavedDraft, setUnsavedDraft] = useState<{ projectId: string; id: string; markdown: string; baseMarkdown: string; recoverySession: string } | null>(null),
    [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null),
    [navigationError, setNavigationError] = useState(""),
    [sessionReady, setSessionReady] = useState(false),
    [setupState, setSetupState] = useState<{ completed: boolean; draft: SetupDraft | null } | null>(null);
  const selectedRef = useRef(selected);
  const mainRef = useRef<HTMLElement>(null);
  const refreshSequence = useRef(0);
  selectedRef.current = selected;
  async function refresh() {
    // A slower poll must not replace a newer mutation or another website's view.
    const sequence = ++refreshSequence.current;
    setRefreshing(true);
    try {
      const [ps, connection, setup] = await Promise.all([
        api<Project[]>("/projects"),
        api("/providers"),
        api("/onboarding"),
      ]);
      const selection = selectedRef.current;
      const id = ps.some((project) => project.id === selection) ? selection : ps[0]?.id;
      const next = id ? await api<Workspace>("/projects/" + id + "/workspace") : null;
      if (sequence !== refreshSequence.current || selectedRef.current !== selection) return;
      setProjects(ps);
      setConnected(connection.connected);
      setProfiles(connection.chatgpt);
      setSetupState(setup);
      if (id && selection !== id) { selectedRef.current = id; setSelected(id); }
      setWorkspace(next);
      setRefreshError("");
    } catch (failure) {
      if (sequence === refreshSequence.current) setRefreshError((failure as Error).message);
    } finally {
      if (sequence === refreshSequence.current) setRefreshing(false);
    }
  }
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let stopped = false;
    void api("/session").then(() => {
      if (!stopped) setSessionReady(true);
    }).catch((e) => setError(e.message));
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    if (!sessionReady) return;
    if (selected) setWorkspace(null);
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => { clearInterval(timer); refreshSequence.current++; };
  }, [selected, sessionReady]);
  useEffect(() => { document.title = identity.name; }, []);
  useEffect(() => { mainRef.current?.scrollTo(0, 0); }, [page, selected]);
  const w = workspace,
    p = w?.project;
  const connectedProviders = providerOrder.filter((provider) => connected[provider]);
  const opportunities = opportunityFindings(w?.findings ?? []);
  const auditIssues = auditFindings(w?.findings ?? []);
  const ownCitations = w?.presentation.outcomes.find((group) => group.kind === "cited");
  const ownWebsite = w ? { domain:w.project.domain, citationRate:w.metrics.citationRate, answersCiting:ownCitations?.count ?? 0, answersCollected:w.metrics.completed, observationIds:ownCitations?.observationIds ?? [] } : null;
  const filteredAnswers = w?.observations.filter((answer) => (!evidenceFilter || evidenceFilter.ids.includes(answer.id)) && (answer.prompt + " " + answer.answer).toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  useEffect(() => {
    if (w) setSelectedContent((id) => w.content.some((draft) => draft.id === id) ? id : "");
  }, [w?.project.id, w?.content.map((draft) => draft.id).join(",")]);
  useEffect(() => {
    if (!w || !pendingContent || unsavedDraft || w.project.id !== pendingContent.projectId) return;
    const job = w.jobs.find(job => job.id === pendingContent.jobId);
    if (job?.status === 'completed') {
      const id = (job.result as { id?: string } | null)?.id;
      if (id && w.content.some(draft => draft.id === id)) setSelectedContent(id);
      setPendingContent(null);
    } else if (job && ['failed', 'cancelled'].includes(job.status)) setPendingContent(null);
  }, [w, pendingContent, unsavedDraft]);
  useEffect(() => { setEvidenceFilter(null); }, [w?.project.id, w?.measurement?.id]);
  function navigate(action: () => void) {
    if (unsavedDraft) { setNavigationError(""); setPendingNavigation(() => action); }
    else action();
  }
  const changePage = (label: string) => {
    if (page === label) mainRef.current?.scrollTo(0, 0);
    else navigate(() => { setPage(label); setQuery(""); setEvidenceFilter(null); if (label === 'Content') setSelectedContent(''); });
  };
  const openConnections = () => navigate(() => { setPage("Settings"); setQuery(""); setEvidenceFilter(null); setConnectionsRequest(value => value + 1); });
  const openEvidence = (ids: string[], label: string) => navigate(() => {
    setPage("Responses"); setQuery(""); setEvidenceFilter({ ids, label });
  });
  const openOpportunity = (finding: Finding) => navigate(() => {
    setPage('Opportunities'); setFocusedFinding(finding.id);
  });
  if (!setupState) return <div className="startup-state" role="status"><img src="/logo.svg" width="40" height="40" alt="" /><h1>{identity.name}</h1>{error || refreshError ? <><p role="alert">{error || refreshError}</p><button className="secondary" disabled={refreshing} onClick={() => { setError(""); setRefreshError(""); void api("/session").then(() => { setSessionReady(true); return refresh(); }).catch((failure) => setError(failure.message)); }}>Try again</button></> : <p>Opening your workspace...</p>}</div>;
  if (!setupState.completed || !projects.length || newProject || setupState.draft) return <Onboarding connected={connected} profiles={profiles} refresh={refresh} draft={setupState.draft} savedProject={projects.find((project) => project.id === setupState.draft?.projectId)} initialStep={setupState.completed && Object.values(connected).some(Boolean) ? 1 : 0} cancel={projects.length && setupState.completed ? () => setNewProject(false) : undefined} finish={async (project) => { selectedRef.current = project.id; setSelected(project.id); setNewProject(false); changePage("Overview"); await refresh(); }} />;
  const audited = !!w?.pages.length, measured = !!w?.metrics.completed;
  const comparison = w?.comparison?.status === "comparable" && w.jobs.find(completedMeasurement)?.id === w.measurement?.id ? w.comparison as { previousAt: string; mentionPoints: number | null; citationPoints: number | null } : null;
  const analysisMeasurement = w?.jobs.find(completedMeasurement);
  const activeMeasurement = w?.jobs.find(job => ['measure', 'recheck'].includes(job.kind) && ['queued', 'running', 'paused'].includes(job.status) && !completedMeasurement(job));
  const completedAnalysis = analysisMeasurement && w!.jobs.find(job => job.kind === 'diagnose' && job.status === 'completed' && ((job.result as { measurementJobId?: string } | null)?.measurementJobId ? (job.result as { measurementJobId: string }).measurementJobId === analysisMeasurement.id : job.createdAt >= analysisMeasurement.createdAt));
  const analyzed = !!completedAnalysis;
  const omittedSuggestions = (completedAnalysis?.result as { omittedSuggestions?: number } | null)?.omittedSuggestions ?? 0;
  const activeAnalysis = w?.jobs.find(job => job.kind === 'diagnose' && ['queued', 'running'].includes(job.status));
  const pausedAnalysis = w?.jobs.find(job => job.kind === 'diagnose' && job.status === 'paused' && (!w.measurement || job.createdAt >= w.measurement.createdAt));
  const canAnalyze = connected.chatgpt || connected.openrouter;
  const activeAudit = w?.jobs.find((job) => job.kind === "audit" && ["running", "queued"].includes(job.status));
  const auditLabel = activeAudit?.status === "queued" ? "Audit queued" : activeAudit ? "Auditing..." : "Run audit";
  const canMeasure = providerOptions(connected).length > 0;
  const measurementAction = canMeasure
    ? { label: p?.prompts.length ? "Check visibility" : "Add questions", action: () => p?.prompts.length ? setJobDialog("measure") : page === "Visibility" ? document.getElementById("project-questions")?.focus() : changePage("Visibility") }
    : { label: "Connect for AI checks", action: openConnections };
  const headingAction = page === "Site Audit" ? { label: auditLabel, action: () => setJobDialog("audit") }
    : page === "Visibility" ? activeMeasurement ? null : measurementAction
    : page === "Overview" ? activeMeasurement ? { label: "View current check", action: () => changePage('Visibility') } : !audited ? { label: auditLabel, action: () => setJobDialog("audit") } : !measured ? measurementAction : activeAnalysis ? null : pausedAnalysis ? { label: "Review paused analysis", action: () => changePage('Opportunities') } : !analyzed && canAnalyze ? { label: "Find opportunities", action: () => setJobDialog('diagnose') } : { label: "Review opportunities", action: () => changePage("Opportunities") }
    : page === "Opportunities" && audited && measured && !activeAnalysis && !pausedAnalysis ? { label: "Analyze evidence", action: () => setJobDialog("diagnose") }
    : page === "Content" && audited && !!w?.content.length ? { label: "Create content", action: () => { setContentFinding(null); setContentTopic(""); setJobDialog("content"); } } : null;
  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">Skip to workspace</a>
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            changePage("Overview");
          }}
        >
          <img src="/logo.svg" alt="" width="30" height="30" />
          <span>{identity.name}</span>
        </a>
        <div className="project-switch">
          <Globe size={16} />
          <Select label="Website" compact placeholder="Choose a website" value={selected} onChange={(id) => { if (id !== selected) navigate(() => setSelected(id)); }} options={projects.map((project) => ({ value: project.id, label: project.domain, detail: project.brand, icon: <SiteIcon projectId={project.id} domain={project.domain} size={22} /> }))} />
          <button aria-label="Add website" onClick={() => navigate(() => setNewProject(true))}>
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          {[{ label: "Workspace", items: navigation.slice(0, 2) }, { label: "AI visibility", items: navigation.slice(2, 5) }, { label: "Improve", items: navigation.slice(5, 9) }, { label: "", items: navigation.slice(9) }].map(group => <div className="nav-group" key={group.label}>
          {group.label && <p>{group.label}</p>}
          {group.items.map(([label, Icon]) => (
            <button
              key={label}
              className={page === label ? "active" : ""}
              aria-current={page === label ? "page" : undefined}
              aria-label={label}
              onClick={() => changePage(label)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}</div>)}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-label"><ShieldCheck size={14} />Runs on your device</span>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-navigation-trigger" aria-label="Open navigation" aria-haspopup="dialog" onClick={() => setMobileNavigation(true)}><Menu size={20} /></button>
          <div className="mobile-project-switch"><Select label="Mobile website" compact value={selected} onChange={(id) => { if (id !== selected) navigate(() => setSelected(id)); }} options={projects.map((project) => ({ value: project.id, label: project.domain, detail: project.brand, icon: <SiteIcon projectId={project.id} domain={project.domain} size={22} /> }))} /><button className="icon-button" aria-label="Add website on mobile" onClick={() => navigate(() => setNewProject(true))}><Plus size={17} /></button></div>
          <div className="workspace-identity">{p && <SiteIcon projectId={p.id} domain={p.domain} size={30} />}<div><strong>{p?.brand ?? "Your workspace"}</strong>{p && <a href={"https://" + p.domain} target="_blank" rel="noreferrer">{p.domain}<ExternalLink size={11} /></a>}</div></div>
          <div className="topbar-actions"><button className="connection-shortcut" onClick={openConnections} aria-label="Manage connections"><span className={"connection-dot" + (connectedProviders.length ? "" : " off")} aria-hidden="true" />{connectedProviders.slice(0, 3).map((provider) => <ProviderIcon key={provider} provider={provider} size={16} />)}<span>{connectedProviders.length === 1 ? providerLabels[connectedProviders[0]] : connectedProviders.length ? connectedProviders.length + " connections" : "Connect a provider"}</span><ChevronDown size={13} /></button>
          <button
            className="icon-button"
            aria-label="Refresh workspace"
            onClick={() => void refresh()}
            disabled={busy || refreshing}
          >
            <RefreshCw size={16} />
          </button>
          </div>
        </header>
        <main ref={mainRef} id="main-content" tabIndex={-1}>
          {profiles.welcome && page === 'Overview' && <section className="plan-welcome" aria-label="ChatGPT plan usage"><ProviderIcon provider="chatgpt" size={20} /><div><h2>Your ChatGPT plan is connected</h2><p>Your plan limits apply.</p></div><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage <ArrowUpRight size={14} /></a><button className="icon-button" aria-label="Dismiss ChatGPT connection notice" onClick={() => void run(() => api("/connections/chatgpt/acknowledge-plan", {}))}><X size={16} /></button></section>}
          <div className="page-heading">
            <div>
              <h1>{page}</h1>
              <p>
                {page === "Overview"
                  ? identity.tagline
                  : descriptions[page]}
              </p>
            </div>
            {p && headingAction && (
              <button
                className="primary"
                disabled={busy || ((page === "Site Audit" || (page === "Overview" && !audited)) && !!activeAudit)}
                onClick={headingAction.action}
              >
                {headingAction.label === "Connect for AI checks" ? <Link size={15} /> : headingAction.label.startsWith('Review') || headingAction.label.startsWith('View') ? <ArrowRight size={15} /> : headingAction.label === 'Create content' ? <Plus size={15} /> : page === 'Site Audit' ? <ScanSearch size={15} /> : <Play size={14} />}
                {headingAction.label}
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {refreshError && <div role="alert" className="alert"><span>Could not refresh your workspace. {w ? "Showing the last loaded results." : refreshError}</span><button className="secondary" disabled={refreshing} onClick={() => void refresh()}>Try again</button></div>}
          <ErrorBoundary resetKey={page + ":" + selected}>
          {page === "Settings" ? (
            <ConnectionSettings connected={connected} profiles={profiles} run={run} connectionsRequest={connectionsRequest} />
          ) : !w ? (
            <p aria-live="polite">Loading your workspace...</p>
          ) : (
            <>
              {w.measurement && ["Overview", "Visibility", "Responses", "Sources"].includes(page) && <MeasurementScope measurement={w.measurement} observations={w.observations} missing={w.metrics.missing} />}
              {page === "Overview" && (
                <>
                  {measured ? <div className="metrics">
                    <Metric
                      title="Brand mentions"
                      value={percent(w.metrics.mentionRate)}
                      detail="Collected answers naming your brand"
                      points={comparison?.mentionPoints}
                      since={comparison?.previousAt}
                    />
                    <Metric
                      title="Website citations"
                      value={percent(w.metrics.citationRate)}
                      detail="Collected answers linking to your site"
                      points={comparison?.citationPoints}
                      since={comparison?.previousAt}
                    />
                    <Metric
                      title="Answers collected"
                      value={String(w.metrics.completed)}
                      detail={
                        w.metrics.requested
                          ? `${w.metrics.completed} of ${w.metrics.requested} requested${w.metrics.missing ? activeMeasurement ? ' / still collecting' : ' / incomplete' : ''}`
                          : "No measurement yet"
                      }
                    />
                    <Metric
                      title="Opportunities"
                      value={analyzed || opportunities.length ? String(findingGroups(opportunities.filter((f) => f.status !== "done")).length) : "Not analyzed"}
                      detail={analyzed ? "Evidence-based improvements to review" : "Analyze your answers to find improvements"}
                    />
                  </div> : activeAudit && <section className="next-step-card"><ScanSearch size={25} /><div><h2>{activeAudit.status === "queued" ? "Your site audit is queued" : "Your site audit is running"}</h2><p>{activeAudit.progress}</p></div></section>}
                  <RunsPanel jobs={runsNeedingAttention(w.jobs).filter((job) => measured || job.id !== activeAudit?.id)} run={run} />
                  {measured && !activeMeasurement && !analyzed && !activeAnalysis && !pausedAnalysis && <section className="insight-banner"><Lightbulb size={22} /><div><h2>{w.metrics.mentionRate === 0 ? 'Your brand was missing from this check' : 'Turn your visibility into your next improvement'}</h2><p>{`${w.metrics.completed} answers collected. Analyze them alongside your pages to find where useful content can make a difference.`}</p></div>{!canAnalyze && <button className="secondary" onClick={openConnections}>Connect for analysis <ArrowRight size={15} /></button>}</section>}
                  {measured && <><div className="analytics-grid"><VisibilityChart presentation={w.presentation} openVisibility={() => changePage("Visibility")} /><SourcesTable presentation={w.presentation} collected={w.metrics.completed} compact evidence={openEvidence} openSources={() => changePage("Sources")} projectId={p!.id} ownDomain={p!.domain} /></div><div className="analytics-grid"><AnswerDistribution presentation={w.presentation} collected={w.metrics.completed} requested={w.metrics.requested} missing={w.metrics.missing} collecting={!!activeMeasurement} evidence={openEvidence} /><CitationComparison projectId={p!.id} ownDomain={p!.domain} rows={[ownWebsite!,...w.competitors]} evidence={openEvidence} openCompetitors={() => changePage("Competitors")} /></div></>}
                  {!measured && audited && <AuditSummary audit={w.presentation.audit} domain={p!.domain} findings={w.findings} openAudit={() => changePage("Site Audit")} />}
                  {!measured && <section className="panel next-steps">
                      <div className="panel-heading">
                        <h2>Your next steps</h2>
                      </div>
                      <WorkflowRow
                        n="1"
                        title="Audit your site"
                        description={
                          w.pages.length
                            ? w.pages.length +
                              (w.pages.length === 1
                                ? " page has been examined"
                                : " pages have been examined")
                            : "Find technical and content issues without a provider"
                        }
                        done={!!w.pages.length}
                        onClick={() => activeAudit || audited ? changePage("Site Audit") : setJobDialog("audit")}
                      />
                      <WorkflowRow
                        n="2"
                        title="Collect AI visibility evidence"
                        description={
                          w.metrics.completed
                            ? "Review " +
                              w.metrics.completed +
                              " collected answers"
                            : "Choose questions your customers ask"
                        }
                        done={!!w.metrics.completed}
                        onClick={() => canMeasure ? changePage("Visibility") : openConnections()}
                      />
                      <WorkflowRow
                        n="3"
                        title="Make an evidence-based improvement"
                        description={w.findings.some((finding) => finding.status === "done") ? "Review the improvements you've marked done" : w.content.length ? "Review your drafts and apply an improvement" : "Turn evidence into useful content"}
                        done={w.findings.some((finding) => finding.status === "done")}
                        onClick={() => changePage("Content")}
                      />
                      <WorkflowRow
                        n="4"
                        title="Recheck the same questions"
                        description={measured ? "Compare measurements with the same scope" : "Available after your first visibility check"}
                        disabled={!measured}
                        done={w.jobs.some(
                          (j) =>
                            j.kind === "recheck" && j.status === "completed",
                        )}
                        onClick={() => setJobDialog("recheck")}
                      />
                  </section>}
                  {opportunities.some(finding => finding.status !== 'done') && <section className="panel">
                    <div className="panel-heading">
                      <h2>Next opportunities</h2>
                      <button
                        className="text-button"
                        onClick={() => changePage("Opportunities")}
                      >
                        View all <ArrowRight size={14} />
                      </button>
                    </div>
                    <Findings
                      findings={opportunities
                        .filter((f) => f.status !== "done")}
                      compact
                      projectId={p!.id}
                      run={run}
                      openAll={() => changePage("Opportunities")}
                      openFinding={openOpportunity}
                      emptyMessage={w.findings.length ? "Your current improvements are complete. Recheck visibility to see what changed." : audited && measured ? "Analyze your collected evidence in Opportunities to prepare recommendations." : audited ? "Check visibility to connect page improvements to collected answers." : "Run a site audit to find page improvements you can act on."}
                      emptyTitle={w.findings.length ? "Current improvements complete" : "No recommendations yet"}
                    />
                  </section>}
                </>
              )}
              {page === "Site Audit" && (
                <><RunsPanel jobs={runsNeedingAttention(w.jobs, ["audit"])} run={run} /><AuditEssentials audit={w.presentation.audit} />{auditIssues.length > 0 && <section className="panel"><div className="panel-heading"><h2>Page improvements</h2><span>{findingGroups(auditIssues).length} checks to review</span></div><Findings findings={auditIssues} projectId={p!.id} run={run} mode="audit" /></section>}<section className="panel">
                  <div className="panel-heading">
                    <h2>Audited pages</h2>
                    <span>{w.pages.length} {w.pages.length === 1 ? "page" : "pages"}</span>
                  </div>
                  {w.auditCoverage && <div className="panel-padding audit-coverage"><p>{w.auditCoverage.fetched} {w.auditCoverage.fetched === 1 ? "page inspected" : "pages inspected"} from {w.auditCoverage.attempted} {w.auditCoverage.attempted === 1 ? "address checked" : "addresses checked"}.</p>
                    {w.auditCoverage.truncated && <p role="status">The page limit was reached. {w.auditCoverage.remainingDiscovered} discovered addresses remain. Increase the limit in a new audit to inspect more.</p>}
                    {(w.auditCoverage.failed.length > 0 || w.auditCoverage.excludedByRobots.length > 0 || w.auditCoverage.skippedNonHtml.length > 0) && <details><summary>Inspect coverage gaps</summary>
                      {w.auditCoverage.failed.map((entry) => <p key={entry.url}><a href={entry.url} target="_blank" rel="noreferrer">{entry.url}</a>: {entry.reason}</p>)}
                      {w.auditCoverage.excludedByRobots.map((url) => <p key={url}>Excluded by robots.txt: {url}</p>)}
                      {w.auditCoverage.skippedNonHtml.map((url) => <p key={url}>Not an HTML page: {url}</p>)}
                    </details>}
                  </div>}
                  {w.pages.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Page</th>
                            <th>Access</th>
                            <th>Main heading</th>
                            <th>Structured data</th>
                            <th>Last checked</th>
                          </tr>
                        </thead>
                        <tbody>
                          {w.pages.map((e) => (
                            <tr key={e.id}>
                              <td className="page-cell">
                                <a
                                  href={e.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {e.title || targetLabel(e.url)}
                                </a>
                                <small title={e.url}>{e.title ? targetLabel(e.url) : "No page title"}</small>
                              </td>
                              <td>
                                <span
                                  className={
                                    "badge " +
                                    (e.status < 400 ? "good" : "high")
                                  }
                                >
                                  {e.status < 400 ? "Available" : "Unavailable"}
                                </span>
                              </td>
                              <td>{e.h1.length === 0 ? "Missing" : e.h1.length === 1 ? "Present" : e.h1.length + " headings"}</td>
                              <td title={e.schemaTypes.join(", ")}>{e.schemaTypes.length ? "Present" : "Not found"}</td>
                              <td>
                                {shortDate(e.fetchedAt)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty title={w.auditCoverage ? "No pages could be inspected" : "No pages audited yet"}>
                      {w.auditCoverage ? "Review the audit coverage above before starting another run. Missing pages have not been assessed." : "Run a local audit to inspect your site's content and technical signals."}
                    </Empty>
                  )}
                </section></>
              )}
              {page === "Visibility" && (
                <>
                  {measured && <div className="metrics three">
                    <Metric
                      title="Brand mentions"
                      value={percent(w.metrics.mentionRate)}
                      detail="Answers naming your brand"
                      points={comparison?.mentionPoints}
                      since={comparison?.previousAt}
                    />
                    <Metric
                      title="Website citations"
                      value={percent(w.metrics.citationRate)}
                      detail="Answers linking to your site"
                      points={comparison?.citationPoints}
                      since={comparison?.previousAt}
                    />
                    <Metric
                      title={activeMeasurement ? "Answers remaining" : "Answers collected"}
                      value={activeMeasurement && activeMeasurement.id !== w.measurement?.id ? "Starting" : activeMeasurement ? String(w.metrics.missing) : String(w.metrics.completed)}
                      detail={activeMeasurement && activeMeasurement.id !== w.measurement?.id ? "Previous results shown until answers arrive" : activeMeasurement ? "Saved as they arrive" : w.metrics.missing ? `${w.metrics.completed} of ${w.metrics.requested} requested. Missing answers are not counted as absent mentions.` : `All ${w.metrics.requested} requested answers`}
                    />
                  </div>}
                  {w.measurement && <><VisibilityChart presentation={w.presentation} /><PromptTable rows={w.presentation.prompts} collecting={activeMeasurement?.id === w.measurement.id} evidence={openEvidence} /></>}
                  <RunsPanel jobs={runsNeedingAttention(w.jobs, ["measure", "recheck"])} run={run} />
                  <CheckHistory jobs={w.jobs} currentId={w.measurement?.id} recheck={measured ? { disabled: !!activeMeasurement, start: () => setJobDialog("recheck") } : undefined} note={!comparison && w.jobs.find(completedMeasurement)?.id === w.measurement?.id ? w.comparison?.message : undefined} />
                  <ProjectSettings project={p!} run={run} />
                </>
              )}
              {page === "Responses" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Collected answers</h2>
                    <label className="search">
                      <Search size={15} />
                      <input
                        aria-label="Search answers"
                        placeholder="Search answers"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                  </div>
                  {evidenceFilter && <div className="evidence-filter"><span>Answers for: {evidenceFilter.label}</span><button className="text-button" onClick={() => setEvidenceFilter(null)}>Show all answers <X size={14} /></button></div>}
                  {filteredAnswers.length ? (
                    filteredAnswers.map((o) => <AnswerCard observation={o} key={o.id} />)
                  ) : (
                    <Empty title={w.observations.length ? "No matching answers" : "No collected answers"}>
                      {w.observations.length ? "Try another search or clear it to see your collected answers." : "Run a visibility check to inspect the full responses and their sources."}
                    </Empty>
                  )}
                </section>
              )}
              {page === "Sources" && (
                <SourcesTable presentation={w.presentation} collected={w.metrics.completed} evidence={openEvidence} projectId={p!.id} ownDomain={p!.domain} />
              )}
              {page === "Opportunities" && <>
                {(analysisMeasurement || omittedSuggestions > 0) && <div className="opportunity-context">
                  {analysisMeasurement && <p className="small">Recommendations use the completed visibility check from {shortDate(analysisMeasurement.createdAt)} and your audited pages.</p>}
                  {omittedSuggestions > 0 && <p className="small">{omittedSuggestions} {omittedSuggestions === 1 ? 'suggestion was' : 'suggestions were'} left out because the supporting evidence could not be verified.</p>}
                </div>}
                <RunsPanel jobs={runsNeedingAttention(w.jobs, ['diagnose'])} run={run} title={pausedAnalysis ? 'Continue your saved analysis' : undefined} />
                <section className="panel"><Findings findings={opportunities} projectId={p!.id} run={run}
                  emptyTitle={activeAnalysis ? "Your opportunities are on their way" : pausedAnalysis ? "Waiting for the analysis to finish" : "Find your next content opportunity"}
                  emptyMessage={activeAnalysis ? "You can explore your answers while the analysis runs." : pausedAnalysis ? "Recommendations appear after all reviewed pages have been checked. Your saved answers and progress are kept." : measured && audited ? "Analyze your answers alongside your website to identify specific pages to improve. A missing mention alone is not a recommendation." : "Complete a site audit and visibility check to find improvements grounded in your evidence."}
                  jobs={w.jobs} measurementId={analysisMeasurement?.id}
                  focusedFinding={focusedFinding} onFocused={() => setFocusedFinding(null)}
                  drafts={w.content} openContent={id => navigate(() => { setPage('Content'); setSelectedContent(id); })}
                  createContent={finding => navigate(() => { setContentFinding(finding); setContentTopic(finding.opportunity?.topic ?? finding.title); setJobDialog('content'); })} /></section>
              </>}
              {page === "Content" && <>
                <RunsPanel jobs={runsNeedingAttention(w.jobs, ['content', 'revise'])} run={run} />
                <ContentWorkspace drafts={w.content} selected={selectedContent} select={id => { if (id !== selectedContent) navigate(() => setSelectedContent(id)); }} projectId={p!.id} run={run}
                  pending={w.jobs.some(job => job.kind === 'content' && ['queued', 'running'].includes(job.status))}
                  create={() => { setContentFinding(null); setContentTopic(''); setJobDialog('content'); }}
                  revise={draft => { setRevision(draft); setJobDialog('revise'); }}
                  onDraftChange={edit => setUnsavedDraft(edit === null ? null : { projectId: p!.id, ...edit })} />
              </>}
              {page === "Competitors" && <Competitors project={p!} jobs={w.jobs} run={run} activity={job => <Jobs jobs={[job]} run={run} />} review={measurementId => { setCompetitorCheck(measurementId); setJobDialog('competitors'); }} />}
              {page === "Reports" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Export your work</h2>
                  </div>
                  <div className="report-grid">
                    <div>
                      <FileText size={25} />
                      <h3>Evidence and improvement report</h3>
                      <p>
                        Download an editable report or open a print-friendly
                        version.
                      </p>
                      <div className="button-row">
                        <a
                          className="secondary"
                          href={"/api/projects/" + p!.id + "/report"}
                        >
                          Markdown
                        </a>
                        <a
                          className="secondary"
                          href={
                            "/api/projects/" + p!.id + "/report?format=html"
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          Print report
                        </a>
                      </div>
                    </div>
                    <div>
                      <Download size={25} />
                      <h3>Portable project</h3>
                      <p>
                        Your configuration, evidence, improvements and drafts.
                        Credentials are excluded.
                      </p>
                      <a
                        className="secondary"
                        href={"/api/projects/" + p!.id + "/export"}
                      >
                        Export project
                      </a>
                    </div>
                  </div>
                  <div className="managed">
                    <h3>Need managed monitoring or a team workspace?</h3>
                    <p>
                      SurfacedBy offers hosted operation. Your local projects
                      remain yours.
                    </p>
                    <a
                      href="https://surfacedby.com"
                      rel="noreferrer"
                      target="_blank"
                    >
                      Explore managed services <ArrowUpRight size={14} />
                    </a>
                  </div>
                </section>
              )}
            </>
          )}
          </ErrorBoundary>
        </main>
      </div>
      {pendingNavigation && <Modal title="Save your changes?" close={() => setPendingNavigation(null)}><p>You have unsaved changes to this draft.</p>{navigationError && <p className="inline-error" role="alert">{navigationError}</p>}<div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void run(async () => { try { if (unsavedDraft) await api("/projects/" + unsavedDraft.projectId + "/content/" + unsavedDraft.id, { markdown: unsavedDraft.markdown, baseMarkdown: unsavedDraft.baseMarkdown, recoverySession: unsavedDraft.recoverySession }, "PATCH"); setUnsavedDraft(null); setPendingNavigation(null); pendingNavigation(); } catch (failure) { setNavigationError((failure as Error).message); } })}>Save and continue</button>
        <button className="secondary" disabled={busy} onClick={() => void run(async () => { try { if (unsavedDraft) await api("/projects/" + unsavedDraft.projectId + "/content/" + unsavedDraft.id + "/recovery", undefined, "DELETE"); setUnsavedDraft(null); setPendingNavigation(null); pendingNavigation(); } catch (failure) { setNavigationError((failure as Error).message); } })}>Discard changes</button>
        <button className="secondary" disabled={busy} onClick={() => setPendingNavigation(null)}>Keep editing</button>
      </div></Modal>}
      {jobDialog && p && (
        <JobDialog
          kind={jobDialog}
          openConnections={() => { setJobDialog(null); openConnections(); }}
          project={p}
          connected={connected}
          revision={revision}
          initialTopic={contentTopic}
          finding={contentFinding}
          measurementJobId={jobDialog === 'competitors' ? competitorCheck : w?.measurement?.id}
          previousMeasurement={w?.jobs.find(completedMeasurement) ?? null}
          run={run}
          onStarted={job => { if (['content', 'revise'].includes(job.kind)) { setPage('Content'); setPendingContent({ projectId: p.id, jobId: job.id }); } }}
          close={() => { setJobDialog(null); setRevision(null); setContentFinding(null); }}
        />
      )}
      {mobileNavigation && <Modal title="Navigate workspace" close={() => setMobileNavigation(false)}><div className="mobile-navigation-menu">{navigation.map(([label, Icon]) => <button key={label} aria-current={page === label ? "page" : undefined} onClick={() => { setMobileNavigation(false); changePage(label); }}><Icon size={20} /><span>{label}</span><ArrowRight size={15} /></button>)}</div></Modal>}
    </div>
  );
}
const descriptions: Record<string, string> = {
  "Site Audit": "Inspect what your public pages expose to crawlers.",
  Visibility: "Measure mentions and citations for the questions that matter.",
  Responses: "Read the answers behind your measurements.",
  Sources: "Inspect the pages linked in collected answers.",
  Opportunities: "Find useful improvements supported by evidence.",
  Content: "Create useful content with research, source links and a review before publishing.",
  Competitors: "Keep a clear view of relevant competing brands.",
  Reports: "Keep, share and move your work.",
  Settings: "Manage provider connections and scheduled work.",
};
/** Rate changes come only from the server's same-scope comparison, never from adjacent checks. */
function Metric({
  title,
  value,
  detail,
  points,
  since,
}: {
  title: string;
  value: string;
  detail: string;
  points?: number | null;
  since?: string;
}) {
  const Icon = ({ "Brand mentions": MessagesSquare, "Website citations": Link, "Answers collected": Check, "Opportunities": Lightbulb, "Missing answers": MessagesSquare, "Answers remaining": MessagesSquare, "Source links": Globe } as Record<string, typeof MessagesSquare>)[title] ?? ChartColumn;
  const change = points === undefined ? null : pointChange(points);
  const ChangeIcon = change?.direction === "up" ? TrendingUp : change?.direction === "down" ? TrendingDown : Minus;
  return (
    <section className="metric">
      <span className="metric-title">{title}<span className="metric-icon"><Icon size={16} aria-hidden="true" /></span></span>
      <div className="metric-value"><strong className={value.length > 10 ? 'metric-text' : undefined}>{value}</strong>
        {change && since && <span className={"metric-change " + change.direction} title={"Compared with the comparable check on " + shortDate(since)}><ChangeIcon size={13} aria-hidden="true" />{change.label}<span className="visually-hidden"> since the comparable check on {shortDate(since)}</span></span>}</div>
      <small>{detail}</small>
    </section>
  );
}
function WorkflowRow({
  n,
  title,
  description,
  done,
  onClick,
  disabled = false,
}: {
  n: string;
  title: string;
  description: string;
  done: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="workflow-row" onClick={onClick} disabled={disabled}>
      <span className={done ? "step done" : "step"}>
        {done ? <Check size={16} /> : n}
      </span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ArrowRight size={16} />
    </button>
  );
}
const jobLabels: Record<Job["kind"], string> = { audit: "Site audit", discover: "Question suggestions", competitors: "Competitor review", measure: "Visibility check", recheck: "Visibility recheck", diagnose: "Recommendations", content: "Content draft", revise: "Draft revision" };
const jobIcons: Record<Job["kind"], typeof ScanSearch> = { audit: ScanSearch, discover: Sparkles, competitors: Users, measure: ChartNoAxesCombined, recheck: RefreshCw, diagnose: Lightbulb, content: FileText, revise: FilePenLine };
/** A run's live status; queued checks with every answer saved are only finishing follow-up work. */
function jobSummary(job: Job) {
  return completedMeasurement(job) ? "All answers saved. Competitor suggestions: " + job.progress : job.progress;
}
/** Shown only while something runs or needs a decision; finished work is read from its results. */
function RunsPanel({ jobs, run, title }: { jobs: Job[]; run: (f: () => Promise<unknown>) => Promise<void>; title?: string }) {
  if (!jobs.length) return null;
  const attention = jobs.some((job) => ["paused", "failed", "cancelled"].includes(job.status));
  return <section className="panel runs-panel"><div className="panel-heading"><h2>{title ?? (attention ? "Needs your attention" : "In progress")}</h2></div><Jobs jobs={jobs} run={run} /></section>;
}
function Jobs({
  jobs,
  run,
}: {
  jobs: Job[];
  run: (f: () => Promise<unknown>) => Promise<void>;
}) {
  const [review, setReview] = useState<{ id: string; uncertainRequests: number; maxCostUsd: number; spentUsd: number; provider: Provider; reason: string; scheduledBudgetCeilingUsd?: number } | null>(null), [reviewError, setReviewError] = useState(""), [resuming, setResuming] = useState(false);
  return jobs.length ? (
    <ul className="jobs">
      {jobs.map((j) => (
        <li key={j.id} className={"job " + j.status}>
          <span className="job-icon" aria-hidden="true">{(() => { const Icon = jobIcons[j.kind]; return <Icon size={16} />; })()}</span>
          <div className="job-body">
            <strong>{jobLabels[j.kind]}</strong>
            <small title={jobSummary(j)}>{jobSummary(j)}</small>
          </div>
          <div className="job-meta">
            <time dateTime={j.createdAt} title={dateTime(j.createdAt)}>{relativeTime(j.createdAt)}</time>
            {j.spentUsd > 0 && <small title={j.costBasis === 'includes_estimates' ? 'Includes held estimates' : 'Reported cost'}>{usd(j.spentUsd, 3)}{j.costBasis === 'includes_estimates' ? ' est.' : ''}</small>}
          </div>
          <span className={"badge " + j.status}>{({ queued:"Waiting", running:"In progress", paused:"Paused", completed:"Complete", failed:"Did not finish", cancelled:"Cancelled" } as Record<Job["status"], string>)[j.status]}</span>
          {j.provider === "chatgpt" && j.error === "quota" && <a className="secondary" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage <ArrowUpRight size={14} /></a>}
          {j.status === "paused" && (
            <button
              className="secondary"
              onClick={() => { setReviewError(""); void run(async () => { const receipt = await api<Omit<NonNullable<typeof review>, "id">>("/jobs/" + j.id + "/resume-preview"); setReview({ ...receipt, id: j.id }); }); }}
            >
              {j.error === "approval" ? "Review draft price" : "Resume"}
            </button>
          )}
          {["running", "queued", "paused"].includes(j.status) && (
            <button
              aria-label="Cancel job"
              className="icon-button"
              onClick={() =>
                void run(() => api("/jobs/" + j.id + "/cancel", {}))
              }
            >
              <X size={14} />
            </button>
          )}
          {j.status === 'cancelled' && j.error === 'cancel_remote' && <button className="secondary" onClick={() => void run(() => api('/jobs/' + j.id + '/cancel', {}))}>Check cancellation</button>}
          {review?.id === j.id && <form className="resume-review" onSubmit={(event) => {
            event.preventDefault(); const data = new FormData(event.currentTarget); setResuming(true); setReviewError("");
            void run(async () => { try { await api("/jobs/" + j.id + "/resume", { reviewed: review.reason === "approval" || data.get("reviewed") === "on", ...(data.has("budget") ? { maxCostUsd: Number(data.get("budget")) } : {}) }); setReview(null); } catch (failure) { setReviewError((failure as Error).message); } }).finally(() => setResuming(false));
          }}><h3>{review.reason === "approval" ? "Approve your draft" : "Resume this run"}</h3><p>{review.reason === "approval" ? j.progress : review.uncertainRequests ? "A previous request may have completed. Check your provider's activity before allowing another attempt." : j.error === "quota" ? "Resume when your provider's limits allow requests again. Saved results will be kept." : "Saved results will be kept. Resolve the issue shown above before continuing."}</p>
            {review.uncertainRequests > 0 && <label className="checkbox-field"><input type="checkbox" name="reviewed" required />I reviewed provider activity and approve retrying uncertain requests.</label>}
            {review.reason === "budget" && review.provider !== "chatgpt" && <label>New approved total budget (USD)<input name="budget" type="number" min={Math.max(review.spentUsd, review.maxCostUsd)} max={review.scheduledBudgetCeilingUsd ?? 10000} step="0.01" defaultValue={Math.max(review.spentUsd, review.maxCostUsd)} required /><small>Includes ${review.spentUsd.toFixed(3)} already committed. Increasing this amount approves additional provider spending.</small>{review.scheduledBudgetCeilingUsd !== undefined && <small>Schedule allowance for this run: ${review.scheduledBudgetCeilingUsd.toFixed(2)}.</small>}</label>}
            {reviewError && <p className="inline-error" role="alert">{reviewError}</p>}<div className="button-row"><button className="primary" disabled={resuming}>{resuming ? "Starting..." : review.reason === "approval" ? "Approve and start draft" : "Resume run"}</button><button type="button" className="secondary" disabled={resuming} onClick={() => setReview(null)}>Keep paused</button></div>
          </form>}
        </li>
      ))}
    </ul>
  ) : null;
}
function Modal({
  title,
  close,
  children,
  dismissible = true,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  dismissible?: boolean;
}) {
  const dialog = useRef<HTMLElement>(null);
  const dismiss = useRef({ close, dismissible });
  dismiss.current = { close, dismissible };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const targets = () => [...(dialog.current?.querySelectorAll<HTMLElement>(
      "button,input,textarea,a[href],[tabindex]",
    ) ?? [])].filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
    targets()[0]?.focus();
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismiss.current.dismissible) dismiss.current.close();
      if (e.key === "Tab") {
        const items = targets();
        const first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="panel-heading">
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={close} disabled={!dismissible}>
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function ProjectSettings({ project, run }: { project: Project; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [saving, setSaving] = useState(false), [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<QuestionRow[]>(project.prompts.map(text => ({ id: crypto.randomUUID(), text, selected: true })));
  useEffect(() => { setEditing(false); setMessage(""); setRows(project.prompts.map(text => ({ id: crypto.randomUUID(), text, selected: true }))); }, [project.id]);
  const feedback = useFormFeedback(), { setError } = feedback;
  return <section className="panel">
    <div className="panel-heading"><h2>Questions to check</h2><span>{project.prompts.length} configured</span>{project.prompts.length > 0 && !editing && <button className="text-button" onClick={() => setEditing(true)}>Edit questions <ArrowRight size={14} /></button>}</div>
    {(editing || !project.prompts.length) && <form key={project.id} className="settings-form" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget), lines = (key: string) => String(data.get(key) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
      setEditing(true); setSaving(true); setError(""); setMessage("");
      void run(async () => {
        try {
          await api("/projects/" + project.id, { domain: project.domain, brand: data.get("brand"), aliases: lines("aliases"), competitors: lines("competitors"), prompts: [...new Set(rows.filter(row => row.selected).map(row => row.text.trim()).filter(Boolean))], locale: data.get("locale"), knowledge: data.get("knowledge") }, "PUT");
          setMessage("Questions and website details saved.");
        } catch (failure) { setError(failure); }
        finally { setSaving(false); }
      });
    }}>
      <QuestionRows rows={rows} onChange={setRows} disabled={saving} feedback={feedback} />
      <details className="advanced-settings"><summary>Brand, language and competitors <ChevronDown size={16} /></summary>
        <div className="advanced-fields"><div className="form-grid">
          <label>Brand name<input name="brand" {...feedback.field("brand")} defaultValue={project.brand} /></label>
          <label>Answer language and region<Select label="Project language and region" name="locale" {...feedback.field("locale")} defaultValue={project.locale} options={[...new Set([project.locale, "en-US", "en-GB", "fr-FR", "es-ES", "de-DE", "ar-MA", "pt-BR"])].map((locale) => ({ value: locale, label: new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale }))} /></label>
          <label>Other names for your brand<textarea name="aliases" {...feedback.field("aliases")} defaultValue={project.aliases.join("\n")} placeholder="One name per line" rows={3} /></label>
          <label>Competitor websites<textarea name="competitors" {...feedback.field("competitors")} defaultValue={project.competitors.join("\n")} placeholder="One website per line" rows={3} /></label>
        </div><label>Your expertise and brand facts<textarea name="knowledge" {...feedback.field("knowledge")} rows={4} defaultValue={project.knowledge} /></label></div>
      </details>
      <FormFeedback feedback={feedback} />
      {message && <p className="save-notice" role="status">{message}</p>}
      <button className="primary" disabled={saving}>{saving ? "Saving..." : "Save questions"}</button>
    </form>}
  </section>;
}
function JobDialog({
  kind,
  project,
  connected,
  revision,
  initialTopic,
  finding,
  measurementJobId,
  previousMeasurement,
  run,
  close,
  openConnections,
  onStarted,
}: {
  kind: Job["kind"];
  project: Project;
  connected: Record<string, boolean>;
  revision: any;
  initialTopic: string;
  finding: Finding | null;
  measurementJobId?: string;
  previousMeasurement: Job | null;
  run: (f: () => Promise<unknown>) => Promise<void>;
  close: () => void;
  openConnections: () => void;
  onStarted: (job: Job) => void;
}) {
  const choices: Provider[] =
    ["diagnose", "competitors"].includes(kind)
      ? ["chatgpt", "openrouter"]
      : kind === "revise"
        ? ["chatgpt", "openrouter"]
      : kind === "content"
        ? finding ? ["chatgpt", "openrouter"] : ["chatgpt", "console", "openrouter"]
        : ["chatgpt", "console", "dataforseo", "openrouter"];
  const baseline = kind === 'recheck' ? previousMeasurement : null;
  const [provider, setProvider] = useState<Provider>(
      baseline?.provider ?? choices.find((p) => connected[p]) ?? choices[0],
    ),
    [models, setModels] = useState<Model[]>([]),
    [model, setModel] = useState(""),
    [platform, setPlatform] = useState(baseline?.platform ?? "chat_gpt"),
    [webSearch, setWebSearch] = useState(baseline?.webSearch ?? true),
    [consolePlatforms, setConsolePlatforms] = useState<{ key: string; name: string; enabled: boolean }[]>([]),
    [loading, setLoading] = useState(false),
    [budget, setBudget] = useState(0),
    [contentMode, setContentMode] = useState<'article' | 'page_update'>(finding && finding.opportunity?.type !== 'new_content' ? 'page_update' : 'article'),
    [discoveryError, setDiscoveryError] = useState(""),
    [discoveryRevision, setDiscoveryRevision] = useState(0),
    [submitting, setSubmitting] = useState(false);
  // A lost response must not turn retrying the same approval into another paid run.
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const feedback = useFormFeedback(), { setError } = feedback;
  useEffect(() => {
    if (!connected[provider] && !baseline) {
      const available = choices.find(choice => connected[choice]);
      if (available) { setProvider(available); setError(""); }
    }
  }, [connected.chatgpt, connected.console, connected.dataforseo, connected.openrouter]);
  useEffect(() => {
    let stopped = false;
    setModels([]);
    setModel("");
    setConsolePlatforms([]);
    setDiscoveryError("");
    setLoading(false);
    if (kind === "audit" || !connected[provider])
      return;
    setLoading(true);
    if (provider === 'console') {
      void api('/providers/console/capabilities').then((capability) => {
        if (stopped) return;
        if (kind === "content") {
          if (!capability.content_available || !capability.operations?.includes("content"))
            setDiscoveryError("Content is unavailable on this SurfacedBy connection. Choose ChatGPT or OpenRouter.");
          return;
        }
        const enabled = (capability.platforms ?? []).filter((p: any) => p.enabled === true);
        setConsolePlatforms(enabled);
        if (!enabled.some((p: any) => p.key === platform)) setPlatform(baseline ? '' : enabled[0]?.key ?? '');
        if (!enabled.length) setDiscoveryError('No answer platforms are available on this connection.');
      }).catch((e) => { if (!stopped) setDiscoveryError(e.message); }).finally(() => { if (!stopped) setLoading(false); });
      return () => { stopped = true; };
    }
    if (provider === 'dataforseo' && !['chat_gpt', 'gemini', 'perplexity'].includes(platform)) {
      setPlatform(baseline ? '' : 'chat_gpt');
      setLoading(false);
      return;
    }
    if (!platform) { setLoading(false); return; }
    void api<Model[]>("/providers/" + provider + "/models?platform=" + platform)
      .then((ms) => {
        if (!stopped) {
          setModels(ms);
          setModel(baseline ? provider === baseline.provider && platform === baseline.platform && ms.some(entry => entry.id === baseline.model) ? baseline.model! : '' : ms[0]?.id ?? "");
          if (!ms.length) setDiscoveryError("No supported models are available on this connection.");
        }
      })
      .catch((e) => {
        if (!stopped) setDiscoveryError(e.message);
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [provider, platform, connected[provider], discoveryRevision]);
  if (kind !== "audit" && !choices.some((choice) => connected[choice])) return <Modal title="Connect a provider to continue" close={close}><div className="empty"><Link size={25} /><h3>Choose a connection for this task</h3><p>ChatGPT powers AI work through your plan. Other providers are optional. Local site audits work without any connection.</p><button className="primary" onClick={openConnections}>Open connections <ArrowRight size={15} /></button></div></Modal>;
  return (
    <Modal
      title={
        kind === "audit"
          ? "Audit your website"
          : kind === "revise"
            ? "Revise content"
          : kind === "content"
            ? finding ? finding.opportunity?.type === 'new_content' ? "Draft a new resource" : "Draft a page improvement" : "Create content"
            : kind === "competitors"
              ? "Review competitor evidence"
            : kind === "diagnose"
              ? "Analyze your visibility evidence"
              : kind === 'recheck' ? 'Recheck AI visibility' : "Measure AI visibility"
      }
      close={close}
      dismissible={!submitting}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          setSubmitting(true);
          setError("");
          void run(async () => {
            try {
              const request = {
              projectId: project.id,
              kind,
              ...(kind !== "audit"
                ? { provider, model: model || undefined, platform }
                : {}),
              maxCostUsd: kind === "audit" || provider === "chatgpt" ? 0 : budget,
              topic: d.get("topic") ?? undefined,
              ...(kind === 'content' ? { contentMode, ...(finding ? { findingId: finding.id } : {}) } : {}),
              ...(kind === 'revise' ? { contentId: revision.id, revisionInstructions: d.get('instructions') } : {}),
              ...(kind === 'competitors' ? { measurementJobId } : {}),
              render: d.get("render") === "on",
              webSearch: provider === "chatgpt" && ["measure", "recheck"].includes(kind) ? webSearch : true,
              maxPages: kind === "audit" ? Number(d.get("maxPages")) : 100,
              };
              const fingerprint = JSON.stringify(request);
              if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
              const started = await api<Job>("/jobs", request, "POST", submission.current.key);
              onStarted(started);
            close(); } catch (failure) { setError(failure); }
          }).finally(() => setSubmitting(false));
        }}
      >
        {kind === "audit" ? (
          <div>
            Retrieve public pages from this website. Provider accounts are not
            required.
            <details className="advanced-settings"><summary>Audit options <ChevronDown size={16} /></summary><div className="advanced-fields"><label>
              Pages per audit
              <input
                name="maxPages"
                {...feedback.field("maxPages")}
                type="number"
                min="1"
                max="100000"
                defaultValue="100"
                required
              />
            </label>
            <label className="checkbox-field">
              <input type="checkbox" name="render" /> Render pages that need
              JavaScript
            </label>
            </div></details>
          </div>
        ) : (
          <>
            {kind === 'diagnose' && previousMeasurement && <p className="small">Reviews the completed visibility check from {shortDate(previousMeasurement.createdAt)} alongside your audited pages.</p>}
            {kind === 'content' && finding && <section className="draft-origin" aria-label="Selected opportunity">
              <span className="draft-origin-icon"><Lightbulb size={19} /></span><div><strong>{finding.title}</strong>{targetDomain(finding.targetUrl) && <a href={finding.targetUrl} target="_blank" rel="noreferrer"><SiteIcon projectId={project.id} domain={targetDomain(finding.targetUrl)!} size={18} /><span>{finding.opportunity?.type === 'new_content' ? 'View context page' : 'View the existing page'}</span><ArrowUpRight size={13} /></a>}</div>
              <p>{finding.opportunity?.type === 'new_content' ? 'Create a separate resource supported by your website and saved answers.' : 'Draft focused copy for this improvement.'}</p>
            </section>}
            {kind === 'content' && finding && finding.opportunity?.type !== 'new_content' && <fieldset className="content-purpose"><legend>What would you like to write?</legend>{[
              { value: 'page_update' as const, title: 'Improve this page', detail: 'Focused copy for the existing page', Icon: FilePenLine },
              { value: 'article' as const, title: 'Write a new article', detail: 'A separate article informed by this opportunity', Icon: FileText },
            ].map(({ value, title, detail, Icon }) => <label key={value} className={contentMode === value ? 'selected' : ''}><input type="radio" name="contentMode" value={value} checked={contentMode === value} onChange={() => setContentMode(value)} /><Icon size={21} /><span><strong>{title}</strong><small>{detail}</small></span><Check size={16} aria-hidden="true" /></label>)}</fieldset>}
            <label>
              Connection
              <Select label="Connection" {...feedback.field("provider")} value={provider} placeholder="Choose a connected provider" options={providerOptions(connected, choices)} onChange={(value) => { setProvider(value as Provider); setPlatform(value === baseline?.provider ? baseline.platform : 'chat_gpt'); setError(""); }} />
            </label>
            <p className="small">
              {kind === "competitors" ? "Reviews your saved answers and website evidence. No visibility questions are asked again. Your connection's usage limits or charges apply." : provider === "chatgpt"
                ? "Uses your ChatGPT plan within its limits. Answers can differ from the ChatGPT website."
                : provider === "console"
                  ? kind === "content" ? "A researched draft with source links and review notes. Pay as you go, within your approved maximum." : "Managed measurement and analysis through one connection. Pay as you go."
                  : provider === "dataforseo"
                    ? "Collect visibility evidence for local analysis. Provider charges apply."
                    : "Checks answers from your chosen model. OpenRouter usage charges apply."}
            </p>
            {!connected[provider] && (
              <p role="alert">{baseline ? 'The previous connection is unavailable. Reconnect it in Settings or choose another connection.' : 'Connect this provider in Settings first.'}</p>
            )}
            {baseline && connected[provider] && !loading && !discoveryError && <p className="small" role="status">{provider === baseline.provider && platform === baseline.platform && (provider === 'console' || model === baseline.model) && (provider !== 'chatgpt' || webSearch === baseline.webSearch) ? 'Keeps the previous connection and answer settings. Changes to your questions or website settings start a separate comparison.' : !model && provider !== 'console' ? 'Choose an available model. Different answer settings start a separate comparison.' : 'Different answer settings start a separate comparison.'}</p>}
            {["dataforseo", "console"].includes(provider) && !['content', 'revise'].includes(kind) && (
              <label>
                Answer platform
                <Select label="Answer platform" {...feedback.field("platform")} value={platform} options={(provider === "console" ? consolePlatforms : [{ key: "chat_gpt", name: "ChatGPT" }, { key: "gemini", name: "Gemini" }, { key: "perplexity", name: "Perplexity" }]).map((platform) => ({ value: platform.key, label: platform.name, icon: <ProviderIcon provider={platform.key} size={18} /> }))} onChange={setPlatform} />
              </label>
            )}
            {provider !== "console" && (
              <ModelSelector
                models={models}
                value={model}
                onChange={setModel}
                loading={loading}
                validation={feedback.field("model")}
              />
            )}
            {discoveryError && <div className="button-row"><p className="inline-error" role="alert">{discoveryError}</p><button type="button" className="secondary" disabled={loading || submitting} onClick={() => setDiscoveryRevision(value => value + 1)}>Retry availability check</button></div>}
            {provider === "chatgpt" && ["measure", "recheck"].includes(kind) && <label className="checkbox-field"><input type="checkbox" name="webSearch" checked={webSearch} onChange={event => setWebSearch(event.target.checked)} />Search the web for this check<small>Requires web search permission for this model and account. Turn it off to collect model-only answers.</small></label>}
            {kind === "content" && (
              <label>
                {finding ? 'Focus of the draft' : 'Topic'}
                <input
                  name="topic"
                  defaultValue={initialTopic}
                  {...feedback.field("topic")}
                  required
                  placeholder="What should this content help readers understand?"
                />
              </label>
            )}
            {kind === 'revise' && <label>What should change?<textarea name="instructions" {...feedback.field("revisionInstructions")} required minLength={3} maxLength={2000} rows={4} placeholder="Describe the improvement. Supported facts and citations will be checked again." /></label>}
            {provider !== "chatgpt" && (
              <label>
                Approved run budget (USD)
                <input
                  type="number"
                  {...feedback.field("maxCostUsd")}
                  min="0.01"
                  step="0.01"
                  required
                  value={budget || ""}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
                <small>
                  {provider === "dataforseo"
                    ? "Further calls stop at this budget. A single request can exceed its estimate; set a provider-side spending limit too."
                    : "The workflow stops before a step that exceeds its estimated budget."}
                </small>
              </label>
            )}
            {!project.prompts.length &&
              ["measure", "recheck"].includes(kind) && (
                <p>Add questions in Visibility before measuring.</p>
              )}
          </>
        )}
        <FormFeedback feedback={feedback} />
        <button
          className="primary"
          disabled={
            submitting ||
            loading ||
            !!discoveryError ||
            (provider === 'console' && kind !== 'content' && !platform) ||
            (kind !== "audit" &&
              (!connected[provider] ||
                (provider !== "console" && !model) ||
                (["measure", "recheck"].includes(kind) &&
                  !project.prompts.length)))
          }
        >
          {submitting
            ? "Starting..."
            : kind === "audit"
              ? "Start local audit"
              : kind === 'content' ? contentMode === 'page_update' ? 'Draft page copy' : 'Create draft' : kind === 'revise' ? 'Revise draft' : kind === 'diagnose' ? 'Find opportunities' : kind === 'competitors' ? 'Review competitors' : 'Start visibility check'}
        </button>
      </form>
    </Modal>
  );
}
