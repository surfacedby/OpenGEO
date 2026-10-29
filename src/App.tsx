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
  Sparkles,
  Flag,
} from "lucide-react";
import { percent, shortDate, relativeTime, dateTime, usd } from "./format";
import { api } from "./api";
import { ConnectionSettings, type ChatGPTProfiles } from "./ConnectionSettings";
import { Onboarding } from "./Onboarding";
import { PromptWorkspace } from "./PromptWorkspace";
import { BrandSettings } from "./BrandSettings";
import { DesktopUpdates } from './DesktopUpdates';
import { useCloseProtection, type EditState } from './useCloseProtection';
import { Select } from "./Select";
import { AuditPages } from './AuditPages';
import { FormFeedback, useFormFeedback } from "./FormFeedback";
import { ProviderIcon, providerLabels, providerOptions, providerOrder } from "./provider-ui";
import { AnswerCard, AnswerDistribution, AuditEssentials, CheckHistory, CitationComparison, MeasurementScope, PromptTable, SourcesTable, VisibilityChart } from "./DataPresentation";
import { SiteIcon } from "./SiteIcon";
import { AuditSummary } from "./AuditSummary";
import { AuditCoverageDetails } from "./AuditCoverageDetails";
import { Findings } from "./Findings";
import { findingGroups, opportunityFindings, auditFindings, targetDomain } from "./finding-groups";
import { ContentWorkspace } from "./ContentWorkspace";
import { ErrorBoundary } from "./ErrorBoundary";
import { runsNeedingAttention } from "./runs";
import { Competitors } from "./Competitors";
import { PageHeader, EmptyState, emptyIcon, ActionCard, MetricCard as Metric } from './ui/Primitives';
import { OverviewSummary } from './OverviewSummary';
import { Dialog as Modal } from './ui/Dialog';
import { completedBrandMeasurement, completedMeasurement } from "../server/portable-results";
import type { CampaignSummary } from "../server/campaigns";
import { CampaignLens, Campaigns, CampaignVisibility, useCampaignView } from "./Campaigns";
import { CampaignDialog } from "./CampaignDialog";
import type { Presentation } from "../server/presentation";
import identity from "../brand/identity.json";
import type {
  Campaign,
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
  campaigns: CampaignSummary[];
};
const navigation = [
  ["Overview", LayoutDashboard],
  ["Scans", ScanSearch],
  ["Prompts", MessagesSquare],
  ["Campaigns", Flag],
  ["Visibility", ChartNoAxesCombined],
  ["Responses", MessagesSquare],
  ["Sources", Link],
  ["Opportunities", Lightbulb],
  ["Content", FileText],
  ["Competitors", Users],
  ["Reports", ChartColumn],
  ["Brand", Globe],
  ["Settings", Settings],
] as const;
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <EmptyState title={title} icon={emptyIcon(title)}>{children}</EmptyState>;
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
    [answerStatus, setAnswerStatus] = useState<'all' | 'cited' | 'named' | 'absent'>('all'),
    [evidenceFilter, setEvidenceFilter] = useState<{ ids: string[]; label: string } | null>(null),
    [contentTopic, setContentTopic] = useState(""),
    [contentFinding, setContentFinding] = useState<Finding | null>(null),
    [competitorCheck, setCompetitorCheck] = useState<string | undefined>(),
    [campaignPage, setCampaignPage] = useState<string | null>(null),
    [scope, setScope] = useState<string | null>(null),
    [campaignEditor, setCampaignEditor] = useState<{ campaign: Campaign | null; prompts?: string[] } | null>(null),
    [jobCampaign, setJobCampaign] = useState<string | null>(null),
    [focusedFinding, setFocusedFinding] = useState<string | null>(null),
    [selectedContent, setSelectedContent] = useState(""),
    [pendingContent, setPendingContent] = useState<{ projectId: string; jobId: string } | null>(null),
    [unsavedDraft, setUnsavedDraft] = useState<{ projectId: string; id: string; markdown: string; baseMarkdown: string; recoverySession: string } | null>(null),
    [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null),
    [navigationError, setNavigationError] = useState(""),
    [editState, setEditState] = useState<EditState>({ dirty: false, busy: false }),
    [sessionReady, setSessionReady] = useState(false),
    [setupState, setSetupState] = useState<{ completed: boolean; draft: SetupDraft | null } | null>(null);
  const selectedRef = useRef(selected);
  const mainRef = useRef<HTMLElement>(null);
  const refreshSequence = useRef(0);
  selectedRef.current = selected;
  useCloseProtection(editState.dirty || editState.busy);
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
  const auditIssueCount = findingGroups(auditIssues).length;
  const ownCitations = w?.presentation.outcomes.find((group) => group.kind === "cited");
  const ownWebsite = w ? { domain:w.project.domain, citationRate:w.metrics.citationRate, answersCiting:ownCitations?.count ?? 0, answersCollected:w.metrics.completed, observationIds:ownCitations?.observationIds ?? [] } : null;
  useEffect(() => { setScope(null); setCampaignPage(null); }, [selected]);
  const lensPage = ["Visibility", "Responses", "Sources", "Competitors"].includes(page);
  const scoped = p?.campaigns.some((campaign) => campaign.id === scope) ? scope : null;
  const viewId = page === "Campaigns" ? campaignPage : lensPage ? scoped : null;
  const viewCampaign = p?.campaigns.find((campaign) => campaign.id === viewId);
  const { view: campaignView, error: campaignError } = useCampaignView(p?.id, viewCampaign ? viewId : null, JSON.stringify(viewCampaign ?? null));
  const lens = lensPage && scoped ? campaignView : null, lensLoading = lensPage && !!scoped && !lens;
  const showLens = !!w && lensPage && w.project.campaigns.some((campaign) => campaign.status === "active" || campaign.id === scoped);
  const chooseScope = (id: string | null) => { setScope(id); setEvidenceFilter(null); };
  const scopedAnswers = (lens ?? w)?.observations.filter((answer) => (!evidenceFilter || evidenceFilter.ids.includes(answer.id)) && (answer.prompt + " " + answer.answer).toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const answerMatches = (answer: Observation, status: typeof answerStatus) => status === 'all' || (status === 'cited' ? answer.cited : status === 'named' ? answer.mentioned && !answer.cited : !answer.mentioned && !answer.cited);
  const filteredAnswers = scopedAnswers.filter(answer => answerMatches(answer, answerStatus));
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
  useEffect(() => { setEvidenceFilter(null); setAnswerStatus('all'); }, [w?.project.id, w?.measurement?.id]);
  function navigate(action: () => void) {
    if (editState.busy) { setError('Wait for your changes to finish saving.'); return; }
    if (unsavedDraft || editState.dirty) { setNavigationError(""); setPendingNavigation(() => action); }
    else action();
  }
  const changePage = (label: string) => {
    if (page === label) { mainRef.current?.scrollTo(0, 0); setCampaignPage(null); }
    else navigate(() => { setPage(label); setQuery(""); setAnswerStatus('all'); setEvidenceFilter(null); setCampaignPage(null); if (label === 'Content') setSelectedContent(''); });
  };
  const openConnections = () => navigate(() => { setPage("Settings"); setQuery(""); setEvidenceFilter(null); setConnectionsRequest(value => value + 1); });
  const openEvidence = (ids: string[], label: string) => navigate(() => {
    setPage("Responses"); setQuery(""); setAnswerStatus('all'); setEvidenceFilter({ ids, label });
  });
  const openOpportunity = (finding: Finding) => navigate(() => {
    setPage('Opportunities'); setFocusedFinding(finding.id);
  });
  if (!setupState) return <div className="startup-state" role="status"><img src="/logo.svg" width="40" height="40" alt="" /><h1>{identity.name}</h1>{error || refreshError ? <><p role="alert">{error || refreshError}</p><button className="secondary" disabled={refreshing} onClick={() => { setError(""); setRefreshError(""); void api("/session").then(() => { setSessionReady(true); return refresh(); }).catch((failure) => setError(failure.message)); }}>Try again</button></> : <p>Opening your workspace...</p>}</div>;
  if (page !== "Settings" && (!setupState.completed || !projects.length || newProject || setupState.draft)) return <Onboarding openSettings={openConnections} connected={connected} profiles={profiles} refresh={refresh} draft={setupState.draft} savedProject={projects.find((project) => project.id === setupState.draft?.projectId)} initialStep={setupState.completed && Object.values(connected).some(Boolean) ? 1 : 0} cancel={projects.length && setupState.completed ? () => setNewProject(false) : undefined} finish={async (project, startVisibility) => { if (startVisibility) setJobDialog("measure"); selectedRef.current = project.id; setSelected(project.id); setNewProject(false); changePage("Overview"); await refresh(); }} />;
  const audited = !!w?.pages.length, measured = !!w?.metrics.completed;
  const comparison = w?.comparison?.status === "comparable" && w.jobs.find(completedBrandMeasurement)?.id === w.measurement?.id ? w.comparison as { previousAt: string; mentionPoints: number | null; citationPoints: number | null } : null;
  const analysisMeasurement = w?.jobs.find(completedBrandMeasurement);
  const activeMeasurement = w?.jobs.find(job => ['measure', 'recheck'].includes(job.kind) && !job.campaignId && ['queued', 'running', 'paused'].includes(job.status) && !completedMeasurement(job));
  const completedAnalysis = analysisMeasurement && w!.jobs.find(job => job.kind === 'diagnose' && job.status === 'completed' && ((job.result as { measurementJobId?: string } | null)?.measurementJobId ? (job.result as { measurementJobId: string }).measurementJobId === analysisMeasurement.id : job.createdAt >= analysisMeasurement.createdAt));
  const analyzed = !!completedAnalysis;
  const omittedSuggestions = (completedAnalysis?.result as { omittedSuggestions?: number } | null)?.omittedSuggestions ?? 0;
  const activeAnalysis = w?.jobs.find(job => job.kind === 'diagnose' && ['queued', 'running'].includes(job.status));
  const pausedAnalysis = w?.jobs.find(job => job.kind === 'diagnose' && job.status === 'paused' && (!w.measurement || job.createdAt >= w.measurement.createdAt));
  const canAnalyze = connected.chatgpt || connected.console || connected.openrouter;
  const activeAudit = w?.jobs.find((job) => job.kind === "audit" && ["running", "queued"].includes(job.status));
  const canMeasure = providerOptions(connected).length > 0;
  const measurementAction = canMeasure
    ? { label: "Check visibility", action: () => editState.dirty || editState.busy ? setError('Save your prompt changes before starting a check.') : setJobDialog("measure") }
    : { label: "Connect for AI checks", action: openConnections };
  const checkCampaign = (id: string) => {
    if (!canMeasure) openConnections();
    else if (editState.dirty || editState.busy) setError('Save your prompt changes before starting a check.');
    else { setJobCampaign(id); setJobDialog("measure"); }
  };
  const openCampaign = page === "Campaigns" && campaignPage ? p?.campaigns.find((campaign) => campaign.id === campaignPage) : undefined;
  const headingAction = page === "Campaigns" ? openCampaign ? openCampaign.prompts.length ? { label: "Check this campaign", action: () => checkCampaign(openCampaign.id) } : null : { label: "New campaign", action: () => setCampaignEditor({ campaign: null }) }
    : lens ? lens.campaign.prompts.length && !(lens.measurement && !completedMeasurement(lens.measurement) && ['queued', 'running', 'paused'].includes(lens.measurement.status)) ? { label: "Check these " + lens.campaign.prompts.length + " questions", action: () => checkCampaign(lens.campaign.id) } : null
    : page === "Prompts" ? measurementAction
    : page === "Visibility" ? activeMeasurement ? null : measurementAction
    : page === "Overview" ? activeMeasurement ? { label: "View current check", action: () => changePage('Visibility') } : !measured ? measurementAction : activeAnalysis ? null : pausedAnalysis ? { label: "Review paused analysis", action: () => changePage('Opportunities') } : !analyzed && canAnalyze ? { label: "Find opportunities", action: () => setJobDialog('diagnose') } : { label: "Review opportunities", action: () => changePage("Opportunities") }
    : page === "Opportunities" && audited && measured && !activeAnalysis && !pausedAnalysis ? { label: "Find opportunities", action: () => setJobDialog("diagnose") }
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
          {[{ label: "Workspace", items: [...navigation.slice(0, 2), navigation[11]] }, { label: "AI visibility", items: navigation.slice(2, 7) }, { label: "Improve", items: navigation.slice(7, 11) }].map(group => <div className="nav-group" key={group.label}>
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
          <nav aria-label="Application"><button className={page === 'Settings' ? 'active' : ''} aria-current={page === 'Settings' ? 'page' : undefined} onClick={() => changePage('Settings')}><Settings size={18} /><span>Settings</span></button></nav>
          <span className="local-label"><ShieldCheck size={14} />Runs on your device</span>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <button className="icon-button mobile-navigation-trigger" aria-label="Open navigation" aria-haspopup="dialog" onClick={() => setMobileNavigation(true)}><Menu size={20} /></button>
          <div className={"mobile-project-switch" + (page === "Settings" ? " global-hidden" : "")}><Select label="Mobile website" compact value={selected} onChange={(id) => { if (id !== selected) navigate(() => setSelected(id)); }} options={projects.map((project) => ({ value: project.id, label: project.domain, detail: project.brand, icon: <SiteIcon projectId={project.id} domain={project.domain} size={22} /> }))} /><button className="icon-button" aria-label="Add website on mobile" onClick={() => navigate(() => setNewProject(true))}><Plus size={17} /></button></div>
          <div className="workspace-identity">{page === 'Settings' ? <><Settings size={26} /><div><strong>OpenGEO settings</strong><span>Applies to every brand on this device</span></div></> : <>{p && <SiteIcon projectId={p.id} domain={p.domain} size={30} />}<div><strong>{p?.brand ?? "Your workspace"}</strong>{p && <a href={"https://" + p.domain} target="_blank" rel="noreferrer">{p.domain}<ExternalLink size={11} /></a>}</div></>}</div>
          {showLens && <CampaignLens campaigns={w!.campaigns} total={p!.prompts.length} value={scoped} onChange={chooseScope} onNew={() => setCampaignEditor({ campaign: null })} />}
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
        <DesktopUpdates compact />
        <main ref={mainRef} id="main-content" tabIndex={-1}>
          {profiles.welcome && page === 'Overview' && <section className="plan-welcome" aria-label="ChatGPT plan usage"><ProviderIcon provider="chatgpt" size={20} /><div><h2>Your ChatGPT plan is connected</h2><p>Your plan limits apply.</p></div><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage <ArrowUpRight size={14} /></a><button className="icon-button" aria-label="Dismiss ChatGPT connection notice" onClick={() => void run(() => api("/connections/chatgpt/acknowledge-plan", {}))}><X size={16} /></button></section>}
          <PageHeader title={openCampaign?.name ?? page} description={openCampaign ? openCampaign.goal || "Questions checked together toward one goal." : page === 'Overview' ? identity.tagline : descriptions[page]} icon={navigation.find(([label]) => label === page)?.[1] ?? LayoutDashboard}>
            {openCampaign ? <div className="button-row page-heading-actions"><button className="secondary" onClick={() => setCampaignEditor({ campaign: openCampaign })}>Edit campaign</button>{headingAction && <button className="primary" disabled={busy} onClick={headingAction.action}><Play size={14} />{headingAction.label}</button>}</div>
            : p && headingAction && (
              <button
                className="primary"
                disabled={busy}
                onClick={headingAction.action}
              >
                {headingAction.label === "Connect for AI checks" ? <Link size={15} /> : headingAction.label.startsWith('Review') || headingAction.label.startsWith('View') ? <ArrowRight size={15} /> : headingAction.label === 'Create content' || headingAction.label === 'New campaign' ? <Plus size={15} /> : page === 'Scans' ? <ScanSearch size={15} /> : <Play size={14} />}
                {headingAction.label}
              </button>
            )}
          </PageHeader>
          {showLens && <CampaignLens mobile campaigns={w!.campaigns} total={p!.prompts.length} value={scoped} onChange={chooseScope} onNew={() => setCampaignEditor({ campaign: null })} />}
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
            <div className="workspace-loading" role="status" aria-live="polite"><span className="visually-hidden">Loading your workspace</span>
              <div className="metrics" aria-hidden="true">{[0, 1, 2, 3].map((index) => <div className="metric skeleton" key={index} />)}</div>
              <div className="panel skeleton tall" aria-hidden="true" />
            </div>
          ) : (
            <>
              {lensLoading ? <div className="workspace-loading" role="status">{campaignError ? <p role="alert">{campaignError}</p> : <><span className="visually-hidden">Loading this campaign</span><div className="panel skeleton tall" aria-hidden="true" /></>}</div>
              : lens?.measurement && ["Visibility", "Responses", "Sources"].includes(page) ? <MeasurementScope measurement={lens.measurement} observations={lens.observations} missing={lens.metrics.missing} />
              : !lens && w.measurement && ["Overview", "Visibility", "Responses", "Sources"].includes(page) && <MeasurementScope measurement={w.measurement} observations={w.observations} missing={w.metrics.missing} />}
              {page === "Overview" && (
                <>
                  <OverviewSummary brand={p!.brand} presentation={w.presentation} collected={w.metrics.completed} audited={w.pages.length} missing={w.metrics.missing} onAnswers={() => changePage('Responses')} onAudit={() => changePage('Scans')} onCheck={measurementAction.action} />
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
                      tone="citation"
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
                  {measured && <><div className="analytics-grid"><VisibilityChart presentation={w.presentation} openVisibility={() => changePage("Visibility")} /><SourcesTable presentation={w.presentation} collected={w.metrics.completed} compact evidence={openEvidence} openSources={() => changePage("Sources")} projectId={p!.id} ownDomain={p!.domain} /></div><div className="analytics-grid"><AnswerDistribution presentation={w.presentation} collected={w.metrics.completed} requested={w.metrics.requested} missing={w.metrics.missing} collecting={activeMeasurement?.id === w.measurement?.id} evidence={openEvidence} /><CitationComparison projectId={p!.id} ownDomain={p!.domain} rows={[ownWebsite!,...w.competitors]} evidence={openEvidence} openCompetitors={() => changePage("Competitors")} /></div></>}
                  {measured && !activeMeasurement && !analyzed && !activeAnalysis && !pausedAnalysis && <section className="insight-banner"><Lightbulb size={22} /><div><h2>{w.metrics.mentionRate === 0 ? 'Your brand was missing from this check' : 'Turn your visibility into your next improvement'}</h2><p>{`${w.metrics.completed} answers collected. Analyze them alongside your pages to find where useful content can make a difference.`}</p></div><button className="secondary" onClick={() => canAnalyze ? changePage('Opportunities') : openConnections()}>{canAnalyze ? 'Review next steps' : 'Connect for analysis'} <ArrowRight size={15} /></button></section>}
                  {!measured && audited && <AuditSummary audit={w.presentation.audit} domain={p!.domain} findings={w.findings} openAudit={() => changePage("Scans")} />}
                  {!measured && <section className="panel next-steps">
                      <div className="panel-heading">
                        <h2>Your next steps</h2>
                      </div>
                      <WorkflowRow
                        n="1"
                        title="Choose your prompts"
                        description={p!.prompts.length ? `${p!.prompts.length} prompts ready to check` : "Discover questions your customers ask before choosing a business"}
                        done={!!p!.prompts.length}
                        onClick={() => changePage("Prompts")}
                      />
                      <WorkflowRow
                        n="2"
                        title="See where AI recommends you"
                        description={
                          w.metrics.completed
                            ? "Review " +
                              w.metrics.completed +
                              " collected answers"
                            : "Choose questions your customers ask"
                        }
                        done={!!w.metrics.completed}
                        onClick={measurementAction.action}
                      />
                      <WorkflowRow
                        n="3"
                        title="Turn insights into better content"
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
              {page === "Scans" && (
                <><div className="scan-options"><ActionCard icon={ChartNoAxesCombined} title="AI visibility" description="Ask the questions your customers ask. See which brands are mentioned and which websites get cited."><button className="primary" onClick={measurementAction.action}>Check visibility<ArrowRight size={16} /></button><button className="text-button" onClick={() => changePage('Visibility')}>View results<ArrowRight size={14} /></button></ActionCard><ActionCard icon={ScanSearch} title="Website health" description="Find pages that are hard to access, missing useful details or unclear to search engines. Runs on your device with no AI charges."><button className="secondary" disabled={!!activeAudit} onClick={() => setJobDialog('audit')}>{activeAudit ? 'Checking your website...' : 'Check website health'}<ArrowRight size={16} /></button></ActionCard></div><RunsPanel jobs={runsNeedingAttention(w.jobs, ["audit", "measure", "recheck"])} run={run} /><h2>Website health results</h2><AuditEssentials audit={w.presentation.audit} />{auditIssues.length > 0 && <section className="panel"><div className="panel-heading"><h2>Page improvements</h2><span>{auditIssueCount} {auditIssueCount === 1 ? 'check' : 'checks'} to review</span></div><Findings findings={auditIssues} projectId={p!.id} run={run} mode="audit" /></section>}<section className="panel">
                  <div className="panel-heading">
                    <h2>Pages checked</h2>
                    <span>{w.pages.length} {w.pages.length === 1 ? "page" : "pages"}</span>
                  </div>
                  {w.auditCoverage && <AuditCoverageDetails coverage={w.auditCoverage} />}
                  {w.pages.length ? (
                    <AuditPages pages={w.pages} />
                  ) : (
                    <Empty title={w.auditCoverage ? "No pages could be inspected" : "Your website health check starts here"}>
                      {w.auditCoverage ? "Review the coverage above before starting another run. Missing pages have not been assessed." : activeAudit ? 'Pages appear here as your check finishes. Follow its progress above.' : 'Start a website health check above. Results will show which pages need attention and what to improve.'}
                    </Empty>
                  )}
                </section></>
              )}
              {page === "Visibility" && lens && <CampaignVisibility view={lens} total={p!.prompts.length} evidence={openEvidence} open={() => navigate(() => { setPage("Campaigns"); setCampaignPage(lens.campaign.id); })} />}
              {page === "Visibility" && !lens && !lensLoading && (
                <>
                  {!w.measurement && <section className="panel"><Empty title="Find out how AI answers your customers">
                    Your saved questions define the check. Collect answers to measure brand mentions and website citations, then repeat the same questions to compare results.<br /><button className="primary" onClick={() => canMeasure ? setJobDialog('measure') : openConnections()}>{canMeasure ? 'Start visibility check' : 'Connect an answer provider'}</button>
                  </Empty></section>}
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
                      tone="citation"
                      points={comparison?.citationPoints}
                      since={comparison?.previousAt}
                    />
                    <Metric
                      title={activeMeasurement ? "Answers remaining" : "Answers collected"}
                      value={activeMeasurement && activeMeasurement.id !== w.measurement?.id ? activeMeasurement.status === "paused" ? "Paused" : "Starting" : activeMeasurement ? String(w.metrics.missing) : String(w.metrics.completed)}
                      detail={activeMeasurement && activeMeasurement.id !== w.measurement?.id ? activeMeasurement.status === "paused" ? "Previous results shown. Resume the new check below." : "Previous results shown until answers arrive" : activeMeasurement ? "Saved as they arrive" : w.metrics.missing ? `${w.metrics.completed} of ${w.metrics.requested} requested. Missing answers are not counted as absent mentions.` : `All ${w.metrics.requested} requested answers`}
                    />
                  </div>}
                  {w.measurement && <><VisibilityChart presentation={w.presentation} /><PromptTable rows={w.presentation.prompts} collecting={activeMeasurement?.id === w.measurement.id} evidence={openEvidence} groups={p!.campaigns.some((campaign) => campaign.status === "active") ? p!.campaigns.filter((campaign) => campaign.status === "active").map((campaign) => ({ name: campaign.name, prompts: campaign.prompts })) : undefined} /></>}
                  <RunsPanel jobs={runsNeedingAttention(w.jobs, ["measure", "recheck"])} run={run} />
                  <CheckHistory jobs={w.jobs} currentId={w.measurement?.id} recheck={measured ? { disabled: !!activeMeasurement, start: () => setJobDialog("recheck") } : undefined} note={!comparison && w.jobs.find(completedBrandMeasurement)?.id === w.measurement?.id ? w.comparison?.message : undefined} campaigns={Object.fromEntries(p!.campaigns.map((campaign) => [campaign.id, campaign.name]))} />
                </>
              )}
              {page === 'Brand' && <BrandSettings key={p!.id} project={p!} refresh={refresh} onEditState={setEditState} />}
              {page === "Prompts" && <PromptWorkspace key={p!.id} project={p!} jobs={w.jobs} connected={connected} refresh={refresh} openConnections={openConnections} onEditState={setEditState} runControls={<RunsPanel jobs={runsNeedingAttention(w.jobs, ['discover'])} run={run} />} campaigns={w.campaigns} checkCampaign={checkCampaign} editCampaign={(campaign, prompts) => setCampaignEditor({ campaign, prompts })} />}
              {page === "Campaigns" && <Campaigns project={p!} campaigns={w.campaigns} openId={campaignPage} view={campaignView} error={campaignError} open={setCampaignPage} edit={(campaign) => setCampaignEditor({ campaign })}
                evidence={(campaign) => (ids, label) => navigate(() => { setScope(campaign.id); setPage("Responses"); setQuery(""); setAnswerStatus('all'); setEvidenceFilter({ ids, label }); })}
                openPrompts={() => changePage("Prompts")} openCompetitors={() => navigate(() => { setScope(campaignPage); setPage("Competitors"); setCampaignPage(null); })} />}
              {page === "Responses" && !lensLoading && (
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
                  {(lens ?? w).observations.length > 0 && <div className="response-toolbar"><div className="filter-chips" role="group" aria-label="Filter answers by outcome">{([{ value: 'all', label: 'All answers' }, { value: 'cited', label: 'Cited' }, { value: 'named', label: 'Named only' }, { value: 'absent', label: 'Not mentioned' }] as const).map(option => <button key={option.value} type="button" aria-pressed={answerStatus === option.value} onClick={() => setAnswerStatus(option.value)}>{option.label}<span>{scopedAnswers.filter(answer => answerMatches(answer, option.value)).length}</span></button>)}</div><span className="small" role="status">{filteredAnswers.length} {filteredAnswers.length === 1 ? 'answer' : 'answers'} shown</span></div>}
                  {filteredAnswers.length ? (
                    filteredAnswers.map((o) => <AnswerCard observation={o} key={o.id} />)
                  ) : (
                    <Empty title={(lens ?? w).observations.length ? "No matching answers" : "No collected answers"}>
                      {(lens ?? w).observations.length ? <>Try another search or clear your filters.<br /><button className="text-button" onClick={() => { setQuery(''); setAnswerStatus('all'); setEvidenceFilter(null); }}>Clear filters</button></> : activeMeasurement ? 'Answers are being collected. Follow progress in Visibility; saved answers will appear here.' : <>Read the exact answers, compare how your brand appears and inspect every source link.<br /><button className="primary" onClick={() => canMeasure ? setJobDialog('measure') : openConnections()}>{canMeasure ? 'Start visibility check' : 'Connect an answer provider'}</button></>}
                    </Empty>
                  )}
                </section>
              )}
              {page === "Sources" && !lensLoading && (
                <SourcesTable presentation={(lens ?? w).presentation} collected={(lens ?? w).metrics.completed} evidence={openEvidence} projectId={p!.id} ownDomain={p!.domain} startCheck={() => changePage('Visibility')} />
              )}
              {page === "Opportunities" && <>
                {(analysisMeasurement || omittedSuggestions > 0) && <div className="opportunity-context">
                  {analysisMeasurement && <p className="small">Recommendations use answers collected {shortDate(analysisMeasurement.createdAt)} and {completedAnalysis?.provider === 'console' ? 'website pages read for this analysis.' : 'your audited pages.'}</p>}
                  {omittedSuggestions > 0 && <p className="small">{omittedSuggestions} {omittedSuggestions === 1 ? 'suggestion was' : 'suggestions were'} left out because the supporting evidence could not be verified.</p>}
                </div>}
                <RunsPanel jobs={runsNeedingAttention(w.jobs, ['diagnose'])} run={run} title={pausedAnalysis ? 'Continue your saved analysis' : undefined} />
                <section className="panel"><Findings findings={opportunities} projectId={p!.id} run={run}
                  emptyTitle={activeAnalysis ? "Your opportunities are on their way" : pausedAnalysis ? "Waiting for the analysis to finish" : "Find your next content opportunity"}
                  emptyMessage={activeAnalysis ? "You can explore your answers while the analysis runs." : pausedAnalysis ? "Recommendations appear after all reviewed pages have been checked. Your saved answers and progress are kept." : measured && audited ? "Analyze your answers alongside your website to identify specific pages to improve. A missing mention alone is not a recommendation." : measured ? 'Your answers are collected. Audit your pages next so recommendations can address the content already on your website.' : audited ? 'Your pages are audited. Collect AI answers next to find the gaps between your website and what customers are told.' : 'Start with a local site audit, then collect AI answers. Recommendations connect both sources of evidence to a specific improvement.'}
                  emptyAction={!activeAnalysis && !pausedAnalysis ? <button className="primary" onClick={() => !audited ? setJobDialog('audit') : !measured ? changePage('Visibility') : canAnalyze ? setJobDialog('diagnose') : openConnections()}>{!audited ? 'Audit your site' : !measured ? 'Set up visibility' : canAnalyze ? 'Find opportunities' : 'Connect for analysis'}</button> : undefined}
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
              {page === "Competitors" && !lensLoading && <Competitors project={p!} jobs={w.jobs} scope={lens ? { prompts: lens.campaign.prompts, checkId: lens.measurement?.id } : undefined} run={run} activity={job => <Jobs jobs={[job]} run={run} />} review={measurementId => { setCompetitorCheck(measurementId); setJobDialog('competitors'); }} />}
              {page === "Reports" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Export your work</h2>
                  </div>
                  <div className="report-overview"><div><h3>{p!.brand}</h3><p>Your saved workspace, ready to share or back up. Reports use the current evidence; backups also preserve earlier checks and draft versions.</p></div><dl className="evidence-summary" aria-label="Current workspace evidence"><div><dt>Audited pages</dt><dd>{w.pages.length}</dd></div><div><dt>Answers in current check</dt><dd>{w.metrics.completed}</dd></div><div><dt>Improvements</dt><dd>{w.findings.length}</dd></div><div><dt>Saved drafts</dt><dd>{w.content.length}</dd></div></dl></div>
                  <div className="report-grid">
                    <div>
                      <FileText size={25} />
                      <h3>Evidence and improvement report</h3>
                      <p>
                        Download an editable report or open a print-friendly
                        version.
                      </p>
                      <ul className="report-includes"><li>Visibility measurements and their scope</li><li>Page findings and recommended improvements</li><li>Page addresses and steps for following up</li></ul>
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
                      <ul className="report-includes"><li>Move your project to another installation</li><li>Keep a backup before an update</li><li>Review the file before sharing private work</li></ul>
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
      {pendingNavigation && !unsavedDraft && <Modal title="Discard unsaved changes?" close={() => setPendingNavigation(null)}><p>Your edits have not been saved. Keep editing to save them, or discard them to continue.</p><div className="button-row"><button className="primary" onClick={() => setPendingNavigation(null)}>Keep editing</button><button className="secondary" onClick={() => { setEditState({ dirty: false, busy: false }); setPendingNavigation(null); pendingNavigation(); }}>Discard changes</button></div></Modal>}
      {pendingNavigation && unsavedDraft && <Modal title="Save your changes?" close={() => setPendingNavigation(null)}><p>You have unsaved changes to this draft.</p>{navigationError && <p className="inline-error" role="alert">{navigationError}</p>}<div className="button-row">
        <button className="primary" disabled={busy} onClick={() => void run(async () => { try { if (unsavedDraft) await api("/projects/" + unsavedDraft.projectId + "/content/" + unsavedDraft.id, { markdown: unsavedDraft.markdown, baseMarkdown: unsavedDraft.baseMarkdown, recoverySession: unsavedDraft.recoverySession }, "PATCH"); setUnsavedDraft(null); setPendingNavigation(null); pendingNavigation(); } catch (failure) { setNavigationError((failure as Error).message); } })}>Save and continue</button>
        <button className="secondary" disabled={busy} onClick={() => void run(async () => { try { if (unsavedDraft) await api("/projects/" + unsavedDraft.projectId + "/content/" + unsavedDraft.id + "/recovery", undefined, "DELETE"); setUnsavedDraft(null); setPendingNavigation(null); pendingNavigation(); } catch (failure) { setNavigationError((failure as Error).message); } })}>Discard changes</button>
        <button className="secondary" disabled={busy} onClick={() => setPendingNavigation(null)}>Keep editing</button>
      </div></Modal>}
      {jobDialog && p && (
        <JobDialog
          kind={jobDialog}
          openConnections={() => { setJobDialog(null); openConnections(); }}
          openPrompts={() => { setJobDialog(null); changePage('Prompts'); }}
          project={p}
          connected={connected}
          revision={revision}
          initialTopic={contentTopic}
          finding={contentFinding}
          measurementJobId={jobDialog === 'competitors' ? competitorCheck : w?.measurement?.id}
          previousMeasurement={w?.jobs.find(completedBrandMeasurement) ?? null}
          campaign={jobDialog === "measure" && jobCampaign ? p.campaigns.find((campaign) => campaign.id === jobCampaign) ?? null : null}
          run={run}
          onStarted={job => { if (['content', 'revise'].includes(job.kind)) { setPage('Content'); setPendingContent({ projectId: p.id, jobId: job.id }); } }}
          close={() => { setJobDialog(null); setRevision(null); setContentFinding(null); setJobCampaign(null); }}
        />
      )}
      {campaignEditor && p && w && <CampaignDialog project={p} pages={w.pages} campaign={campaignEditor.campaign} initialPrompts={campaignEditor.prompts} close={() => setCampaignEditor(null)} saved={async (id) => {
        await refresh(); setCampaignEditor(null);
        if (!id) setCampaignPage(null);
        else if (!campaignEditor.campaign && lensPage) setScope(id);
        else if (!campaignEditor.campaign && page === "Campaigns") setCampaignPage(id);
      }} />}
      {mobileNavigation && <Modal title="Navigate workspace" close={() => setMobileNavigation(false)}><div className="mobile-navigation-menu">{navigation.map(([label, Icon]) => <button key={label} aria-current={page === label ? "page" : undefined} onClick={() => { setMobileNavigation(false); changePage(label); }}><Icon size={20} /><span>{label}</span><ArrowRight size={15} /></button>)}</div></Modal>}
    </div>
  );
}
const descriptions: Record<string, string> = {
  Scans: "Check your AI visibility and website health in one place.",
  Prompts: "Choose the questions you want your brand to be found for.",
  Visibility: "Measure mentions and citations for the questions that matter.",
  Responses: "Read the answers behind your measurements.",
  Sources: "Inspect the pages linked in collected answers.",
  Opportunities: "Find useful improvements supported by evidence.",
  Content: "Create useful content with research, source links and a review before publishing.",
  Competitors: "Keep a clear view of relevant competing brands.",
  Reports: "Keep, share and move your work.",
  Campaigns: "Group questions toward one goal and follow their mentions, citations and target pages.",
  Brand: "Manage this website's identity, audience and comparison list.",
  Settings: "Connections, schedules, privacy and updates for all your brands.",
};
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
const jobLabels: Record<Job["kind"], string> = { audit: "Website health", discover: "Question suggestions", competitors: "Competitor review", measure: "Visibility check", recheck: "Visibility recheck", diagnose: "Recommendations", content: "Content draft", revise: "Draft revision" };
const jobIcons: Record<Job["kind"], typeof ScanSearch> = { audit: ScanSearch, discover: Sparkles, competitors: Users, measure: ChartNoAxesCombined, recheck: RefreshCw, diagnose: Lightbulb, content: FileText, revise: FilePenLine };
/** A run's live status. A check with every answer saved is only finishing follow-up work. */
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
              {j.error === "approval" ? "Review price" : "Resume"}
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
          {j.status === "failed" && <button className="text-button" onClick={() => void run(() => api("/jobs/" + j.id + "/dismiss", {}))}>Dismiss</button>}
          {j.status === 'cancelled' && j.error === 'cancel_remote' && <button className="secondary" onClick={() => void run(() => api('/jobs/' + j.id + '/cancel', {}))}>Check cancellation</button>}
          {review?.id === j.id && <form className="resume-review" onSubmit={(event) => {
            event.preventDefault(); const data = new FormData(event.currentTarget); setResuming(true); setReviewError("");
            void run(async () => { try { await api("/jobs/" + j.id + "/resume", { reviewed: review.reason === "approval" || data.get("reviewed") === "on", ...(data.has("budget") ? { maxCostUsd: Number(data.get("budget")) } : {}) }); setReview(null); } catch (failure) { setReviewError((failure as Error).message); } }).finally(() => setResuming(false));
          }}><h3>{review.reason === "approval" ? "Approve this run" : "Resume this run"}</h3><p>{review.reason === "approval" ? j.progress : review.uncertainRequests ? "A previous request may have completed. Check your provider's activity before allowing another attempt." : j.error === "quota" ? "Resume when your provider's limits allow requests again. Saved results will be kept." : "Saved results will be kept. Resolve the issue shown above before continuing."}</p>
            {review.reason === "approval" && review.provider === "console" && <p className="hint">Up to {usd(Math.floor(review.maxCostUsd * 10 + 1e-9) / 10)} will be held from your balance. Unused funds are returned when the run ends.</p>}
            {review.uncertainRequests > 0 && <label className="checkbox-field"><input type="checkbox" name="reviewed" required />I reviewed provider activity and approve retrying uncertain requests.</label>}
            {review.reason === "budget" && review.provider !== "chatgpt" && <label>New approved total budget (USD)<input name="budget" type="number" min={Math.max(review.spentUsd, review.maxCostUsd)} max={review.scheduledBudgetCeilingUsd ?? 10000} step="0.01" defaultValue={Math.max(review.spentUsd, review.maxCostUsd)} required /><small>Includes ${review.spentUsd.toFixed(3)} already committed. Increasing this amount approves additional provider spending.</small>{review.scheduledBudgetCeilingUsd !== undefined && <small>Schedule allowance for this run: ${review.scheduledBudgetCeilingUsd.toFixed(2)}.</small>}</label>}
            {reviewError && <p className="inline-error" role="alert">{reviewError}</p>}<div className="button-row"><button className="primary" disabled={resuming}>{resuming ? "Starting..." : review.reason === "approval" ? "Approve and start" : "Resume run"}</button><button type="button" className="secondary" disabled={resuming} onClick={() => setReview(null)}>Keep paused</button></div>
          </form>}
        </li>
      ))}
    </ul>
  ) : null;
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
  openPrompts,
  onStarted,
  campaign,
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
  openPrompts: () => void;
  onStarted: (job: Job) => void;
  campaign: Campaign | null;
}) {
  const choices: Provider[] =
    ["diagnose", "content", "revise", "competitors"].includes(kind)
        ? ["chatgpt", "console", "openrouter"]
        : ["chatgpt", "console", "dataforseo", "openrouter"];
  const baseline = kind === 'recheck' ? previousMeasurement : null;
  const [provider, setProvider] = useState<Provider>(
      baseline?.provider ?? choices.find((p) => connected[p]) ?? choices[0],
    ),
    [models, setModels] = useState<Model[]>([]),
    [model, setModel] = useState(""),
    [platform, setPlatform] = useState(baseline?.platform ?? "chat_gpt"),
    [consolePlatforms, setConsolePlatforms] = useState<{ key: string; name: string; enabled: boolean }[]>([]),
    [selectedQuestionPlatforms, setSelectedQuestionPlatforms] = useState<string[]>([]),
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
    setSelectedQuestionPlatforms([]);
    setDiscoveryError("");
    setLoading(false);
    if (kind === "audit" || !connected[provider])
      return;
    setLoading(true);
    if (provider === 'console') {
      void api('/providers/console/capabilities').then((capability) => {
        if (stopped) return;
        if (["content", "revise", "competitors", "diagnose"].includes(kind)) {
          const operation = kind === "competitors" ? "competitors" : kind === "diagnose" ? "local_opportunities" : "content";
          if (!capability.operations?.includes(operation) || operation === "content" && !capability.content_available)
            setDiscoveryError("This task is unavailable on this SurfacedBy connection. Choose ChatGPT or OpenRouter.");
          return;
        }
        const enabled = (capability.platforms ?? []).filter((p: any) => p.enabled === true);
        setConsolePlatforms(enabled);
        setSelectedQuestionPlatforms(capability.operations?.includes('measurement') ? capability.selected_question_platforms ?? [] : []);
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
  if (['measure', 'recheck'].includes(kind) && !project.prompts.length) return <Modal title="Choose what to check" close={close}><div className="empty"><MessagesSquare size={30} /><h3>Let's find your first prompts</h3><p>We can suggest questions from your website, or you can add your own. Choose a few to start measuring how AI recommends your brand.</p><button className="primary" onClick={openPrompts}><Sparkles size={16} />Discover prompts<ArrowRight size={16} /></button></div></Modal>;
  if (kind !== "audit" && !choices.some((choice) => connected[choice])) return <Modal title="Connect a provider to continue" close={close}><div className="empty"><Link size={25} /><h3>Choose a connection for this task</h3><p>ChatGPT powers AI work through your plan. Other providers are optional. Website health checks work without any connection.</p><button className="primary" onClick={openConnections}>Open connections <ArrowRight size={15} /></button></div></Modal>;
  return (
    <Modal
      title={
        kind === "audit"
          ? "Check website health"
          : kind === "revise"
            ? "Revise content"
          : kind === "content"
            ? finding ? finding.opportunity?.type === 'new_content' ? "Draft a new resource" : "Draft a page improvement" : "Create content"
            : kind === "competitors"
              ? "Review competitor evidence"
            : kind === "diagnose"
              ? "Find opportunities to improve"
              : kind === 'recheck' ? 'Recheck AI visibility' : campaign ? 'Check ' + campaign.name : "Measure AI visibility"
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
              ...(campaign ? { campaignId: campaign.id } : {}),
              render: d.get("render") === "on",
              webSearch: true,
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
            {kind === 'diagnose' && previousMeasurement && <p className="small">Reviews answers collected {shortDate(previousMeasurement.createdAt)} alongside {provider === 'console' ? 'freshly read website pages.' : 'your audited pages.'}</p>}
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
                  ? kind === "content" ? "A researched draft with source links and review notes. Pay as you go, within your approved maximum." : kind === "diagnose" ? "Find useful page improvements and new content ideas from your saved evidence. Pay as you go, within your approved maximum." : "Managed measurement and analysis through one connection. Pay as you go."
                  : provider === "dataforseo"
                    ? "Collect visibility evidence for local analysis. Provider charges apply."
                    : "Checks answers from your chosen model. OpenRouter usage charges apply."}
            </p>
            {campaign && <p className="small" role="note">Asks this campaign's {campaign.prompts.length} {campaign.prompts.length === 1 ? 'question' : 'questions'}. Your other {project.prompts.length - campaign.prompts.length} are not asked. The answers count in this campaign and in your brand's check history, where this check shows as a partial check.</p>}
            {provider === 'console' && ['measure', 'recheck'].includes(kind) && !loading && !discoveryError && <p className="small">
              {selectedQuestionPlatforms.includes(platform === 'chat_gpt' ? 'chatgpt' : platform)
                ? 'Checks your selected questions with fresh answers. Review the estimate before any paid work starts.'
                : 'Runs a full managed check using your questions. The displayed estimate covers the full check.'}
            </p>}
            {!connected[provider] && (
              <p role="alert">{baseline ? 'The previous connection is unavailable. Reconnect it in Settings or choose another connection.' : 'Connect this provider in Settings first.'}</p>
            )}
            {baseline && connected[provider] && !loading && !discoveryError && <p className="small" role="status">{provider === baseline.provider && platform === baseline.platform && (provider === 'console' || model === baseline.model) && (provider !== 'chatgpt' || baseline.webSearch !== false) ? 'Keeps the previous connection and answer settings. Changes to your questions or website settings start a separate comparison.' : !model && provider !== 'console' ? 'Choose an available model. Different answer settings start a separate comparison.' : 'Different answer settings start a separate comparison.'}</p>}
            {["dataforseo", "console"].includes(provider) && ['measure', 'recheck'].includes(kind) && (
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
          </>
        )}
        <FormFeedback feedback={feedback} />
        <button
          className="primary"
          disabled={
            submitting ||
            loading ||
            !!discoveryError ||
            (provider === 'console' && ['measure', 'recheck'].includes(kind) && !platform) ||
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
              ? "Start website health check"
              : kind === 'content' ? contentMode === 'page_update' ? 'Draft page copy' : 'Create draft' : kind === 'revise' ? 'Revise draft' : kind === 'diagnose' ? 'Find opportunities' : kind === 'competitors' ? 'Review competitors' : kind === 'recheck' ? 'Recheck visibility' : 'Start visibility check'}
        </button>
      </form>
    </Modal>
  );
}
