import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Flag, Search } from 'lucide-react';
import type { Campaign, Project } from '../server/contracts';
import type { CampaignSummary, CampaignView } from '../server/campaigns';
import { completedMeasurement } from '../server/portable-results';
import { api } from './api';
import { Select } from './Select';
import { CitationComparison, PromptTable, RateBar, SourcesTable, VisibilityChart } from './DataPresentation';
import { EmptyState, MetricCard, Section, Tabs } from './ui/Primitives';
import { dateTime, percent, shortDate } from './format';
import './campaigns.css';

type Evidence = (ids: string[], label: string) => void;

/** A campaign's evidence refreshes on the workspace's rhythm, so scoped screens never lag the brand view. */
export function useCampaignView(projectId: string | undefined, campaignId: string | null, version: string) {
  const [view, setView] = useState<CampaignView | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!projectId || !campaignId) { setView(null); setError(''); return; }
    let stopped = false;
    const load = () => api<CampaignView>('/projects/' + projectId + '/campaigns/' + campaignId)
      .then(next => { if (!stopped) { setView(next); setError(''); } })
      .catch(failure => { if (!stopped) setError((failure as Error).message); });
    void load();
    const timer = setInterval(load, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [projectId, campaignId, version]);
  return { view: view?.campaign.id === campaignId ? view : null, error };
}

const today = () => new Date().toLocaleDateString('en-CA');
const reviewDate = (value: string) => new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Scoping is a lens over the same screens: it narrows the questions read, never the saved evidence. */
export function CampaignLens({ campaigns, total, value, onChange, onNew, mobile = false }: {
  campaigns: CampaignSummary[]; total: number; value: string | null;
  onChange: (id: string | null) => void; onNew: () => void; mobile?: boolean;
}) {
  const active = campaigns.filter(campaign => campaign.status === 'active' || campaign.id === value);
  return <div className={'campaign-lens' + (mobile ? ' in-page' : '') + (value ? ' scoped' : '')}>
    <Flag size={15} aria-hidden="true" />
    <Select label={mobile ? 'Mobile campaign' : 'Campaign'} compact searchable={active.length > 8} value={value ?? 'all'} onChange={id => id === 'new' ? onNew() : onChange(id === 'all' ? null : id)}
      options={[{ value: 'all', label: 'All questions', detail: total + ' questions' }, ...active.map(campaign => ({ value: campaign.id, label: campaign.name, detail: campaign.questions + ' questions' })), { value: 'new', label: 'New campaign' }]} />
    {value && <button className="text-button" onClick={() => onChange(null)}>Show all questions</button>}
  </div>;
}

function ReviewBy({ date, edit }: { date: string | null; edit: () => void }) {
  if (!date) return <button className="text-button" onClick={edit}>Set a date</button>;
  return date < today() ? <span className="badge medium">{reviewDate(date)}, passed</span> : <span className="badge low">{reviewDate(date)}</span>;
}

export function Campaigns({ project, campaigns, openId, view, error, open, edit, evidence, openPrompts, openCompetitors }: {
  project: Project; campaigns: CampaignSummary[]; openId: string | null; view: CampaignView | null; error: string;
  open: (id: string | null) => void; edit: (campaign: Campaign | null) => void;
  evidence: (campaign: Campaign) => Evidence; openPrompts: () => void; openCompetitors: () => void;
}) {
  const [tab, setTab] = useState<'active' | 'closed'>('active'), [query, setQuery] = useState('');
  if (openId) return view ? <CampaignDetail project={project} view={view} open={open} edit={edit} evidence={evidence(view.campaign)} openCompetitors={openCompetitors} />
    : <Section>{error ? <p role="alert">{error}</p> : <div className="workspace-loading" role="status"><span className="visually-hidden">Loading this campaign</span><div className="panel skeleton tall" aria-hidden="true" /></div>}</Section>;
  if (!campaigns.length) return <Section><EmptyState icon={Flag} title="Group your questions into campaigns" action={<button className="primary" onClick={() => edit(null)}>Create a campaign</button>}>
    A campaign follows a few questions toward one goal: their mentions, citations and target pages, checked together. Your {project.prompts.length} questions keep working as they do today.
  </EmptyState></Section>;
  const grouped = new Set(project.campaigns.flatMap(campaign => campaign.prompts));
  const loose = project.prompts.filter(prompt => !grouped.has(prompt)).length;
  const shown = campaigns.filter(campaign => campaign.status === tab && (campaign.name + ' ' + campaign.goal).toLowerCase().includes(query.trim().toLowerCase()));
  const byId = new Map(project.campaigns.map(campaign => [campaign.id, campaign]));
  return <>
    <Tabs label="Campaign status" panelId="campaign-list" value={tab} onChange={setTab} items={[{ value: 'active', label: 'Active', count: campaigns.filter(campaign => campaign.status === 'active').length }, { value: 'closed', label: 'Closed', count: campaigns.filter(campaign => campaign.status === 'closed').length }]} />
    <section id="campaign-list" role="tabpanel" className="panel analytics-panel campaign-list" aria-label={tab === 'active' ? 'Active campaigns' : 'Closed campaigns'}>
      <div className="panel-heading"><h2>{tab === 'active' ? 'Active campaigns' : 'Closed campaigns'}</h2><label className="search"><Search size={15} /><input aria-label="Find a campaign" placeholder="Find a campaign" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {shown.length ? <div className="table-wrap"><table className="analytics-table campaign-table responsive-evidence-table">
        <caption className="visually-hidden">Campaigns and their latest readings</caption>
        <thead><tr><th>Campaign</th><th>Questions</th><th>Mentions</th><th>Citations</th><th>Target pages cited</th><th>Last check</th><th>Review by</th></tr></thead>
        <tbody>{shown.map(campaign => <tr key={campaign.id}>
          <td><button className="text-button campaign-name" onClick={() => open(campaign.id)}>{campaign.name}<ArrowRight size={14} /></button>{campaign.goal && <small>{campaign.goal}</small>}</td>
          <td data-label="Questions">{campaign.questions}</td>
          <td data-label="Mentions">{campaign.metrics ? <RateBar value={campaign.metrics.mentionRate} measure="mention" /> : <span className="campaign-pending">Not checked yet</span>}</td>
          <td data-label="Citations">{campaign.metrics ? <RateBar value={campaign.metrics.citationRate} measure="citation" /> : <span className="campaign-pending">Not checked yet</span>}</td>
          <td data-label="Target pages cited">{!campaign.targets ? <span className="campaign-pending">Not set</span> : campaign.targetsCited === null ? <span className="campaign-pending">Not checked yet</span> : campaign.targetsCited + ' of ' + campaign.targets}</td>
          <td data-label="Last check">{campaign.lastCheckAt ? shortDate(campaign.lastCheckAt) : 'None'}</td>
          <td data-label="Review by"><ReviewBy date={campaign.reviewBy} edit={() => edit(byId.get(campaign.id) ?? null)} /></td>
        </tr>)}</tbody>
      </table></div> : <div className="analytics-empty"><p>{query ? 'No matching campaigns' : tab === 'active' ? 'No active campaigns' : 'No closed campaigns'}</p></div>}
      <p className="chart-note table-note">{loose} of {project.prompts.length} questions are in no campaign. They still count in Visibility and Responses. <button className="text-button" onClick={openPrompts}>Review them in Prompts</button></p>
    </section>
  </>;
}

function CampaignDetail({ project, view, open, edit, evidence, openCompetitors }: {
  project: Project; view: CampaignView; open: (id: string | null) => void; edit: (campaign: Campaign | null) => void;
  evidence: Evidence; openCompetitors: () => void;
}) {
  const [tab, setTab] = useState<'results' | 'questions' | 'targets' | 'competitors' | 'checks'>('results');
  const { campaign, metrics, measurement, presentation, targets } = view;
  const cited = targets.filter(target => target.answersCiting > 0).length;
  const own = presentation.outcomes.find(group => group.kind === 'cited');
  const passed = !!campaign.reviewBy && campaign.reviewBy < today();
  return <>
    <nav aria-label="Breadcrumb" className="campaign-breadcrumb"><button className="text-button" onClick={() => open(null)}><ArrowLeft size={14} />Campaigns</button><span aria-hidden="true">/</span><span aria-current="page">{campaign.name}</span></nav>
    <div className="measurement-scope campaign-scope">
      <span>{campaign.prompts.length} {campaign.prompts.length === 1 ? 'question' : 'questions'}</span>
      <span>{campaign.targetUrls.length} target {campaign.targetUrls.length === 1 ? 'page' : 'pages'}</span>
      <span>{campaign.competitors.length || project.competitors.length} {(campaign.competitors.length || project.competitors.length) === 1 ? 'competitor' : 'competitors'}</span>
      <span>Started {shortDate(campaign.createdAt)}</span>
      {campaign.reviewBy ? <span className={passed ? 'scope-missing' : ''}>Review by {reviewDate(campaign.reviewBy)}{passed ? ', passed' : ''}</span> : <button className="text-button" onClick={() => edit(campaign)}>Set a review date</button>}
      {campaign.status === 'closed' && <span>Closed</span>}
    </div>
    <Tabs label="Campaign views" panelId="campaign-view" value={tab} onChange={setTab} items={[{ value: 'results', label: 'Results' }, { value: 'questions', label: 'Questions', count: campaign.prompts.length }, { value: 'targets', label: 'Target pages', count: targets.length }, { value: 'competitors', label: 'Competitors', count: view.competitors.length }, { value: 'checks', label: 'Checks', count: view.checks.length }]} />
    <div id="campaign-view" role="tabpanel" tabIndex={0} className="campaign-view">
      {!measurement && tab !== 'questions' && tab !== 'targets' ? <Section><EmptyState icon={Flag} title="Not checked yet">Check this campaign to see its mentions, citations and target pages. A check of all your questions counts here too once it has asked every one of this campaign's questions.</EmptyState></Section>
        : tab === 'results' ? <>
          <div className="metrics">
            <MetricCard title="Brand mentions" value={percent(metrics.mentionRate)} detail="Answers naming your brand" />
            <MetricCard title="Website citations" value={percent(metrics.citationRate)} detail="Answers linking to your site" tone="citation" />
            <MetricCard title="Target pages cited" value={targets.length ? cited + ' of ' + targets.length : 'Not set'} detail={targets.length ? 'Pages linked at least once' : 'Add the pages this campaign should earn'} tone="citation" />
            <MetricCard title="Answers collected" value={String(metrics.completed)} detail={metrics.missing ? `${metrics.completed} of ${metrics.requested} requested. Missing answers are not counted as absent mentions.` : `All ${metrics.requested} requested answers`} />
          </div>
          <VisibilityChart presentation={presentation} />
          <SourcesTable presentation={presentation} collected={metrics.completed} evidence={evidence} projectId={project.id} ownDomain={project.domain} compact />
        </>
        : tab === 'questions' ? <PromptTable rows={presentation.prompts} evidence={evidence} collecting={!!measurement && !completedMeasurement(measurement)} />
        : tab === 'targets' ? <Section title="Target pages" description={measurement ? 'Pages this campaign should earn, with the latest website audit.' : 'Pages this campaign should earn. Citations appear after its first check.'} action={<button className="secondary" onClick={() => edit(campaign)}>Edit pages</button>}>
          {targets.length ? <ul className="campaign-targets">{targets.map(target => <li key={target.url}>
            <a href={target.url} target="_blank" rel="noreferrer">{target.url.replace(/^https?:\/\//, '')}<ExternalLink size={12} /></a>
            {measurement ? <button className="text-button" disabled={!target.answersCiting} onClick={() => evidence(target.observationIds, target.url)}>Cited in {target.answersCiting} of {target.answersCollected} answers</button> : <span className="campaign-pending">Not checked yet</span>}
            <span className={'badge ' + (!target.page ? 'low' : target.page.status >= 200 && target.page.status < 300 && !target.page.noindex ? 'good' : 'medium')}>{!target.page ? 'Not audited' : target.page.noindex ? 'Not indexable' : target.page.status + (target.page.status < 300 ? ', indexable' : '')}</span>
          </li>)}</ul> : <p>No target pages yet. Add the pages you want AI answers to link to.</p>}
        </Section>
        : tab === 'competitors' ? <CitationComparison rows={[{ domain: project.domain, citationRate: metrics.citationRate, answersCiting: own?.count ?? 0, answersCollected: metrics.completed, observationIds: own?.observationIds ?? [] }, ...view.competitors]} projectId={project.id} ownDomain={project.domain} evidence={evidence} openCompetitors={openCompetitors} />
        : <section className="panel analytics-panel"><div className="panel-heading"><h2>Checks that read this campaign</h2></div><div className="table-wrap"><table className="analytics-table check-history responsive-evidence-table">
          <caption className="visually-hidden">Checks that asked every question in this campaign, newest first</caption>
          <thead><tr><th>Check</th><th>Brand mentions</th><th>Website citations</th><th>Answers</th></tr></thead>
          <tbody>{view.checks.map(check => <tr key={check.jobId} className={check.jobId === measurement?.id ? 'current' : undefined}>
            <td><span className="check-date">{dateTime(check.at)}</span><small>{check.campaignCheck ? 'This campaign only' : 'All questions'}{check.comparable ? '' : ', different settings'}</small></td>
            <td data-label="Brand mentions"><RateBar value={check.metrics.mentionRate} measure="mention" /></td>
            <td data-label="Website citations"><RateBar value={check.metrics.citationRate} measure="citation" /></td>
            <td data-label="Answers">{check.metrics.completed} / {check.metrics.requested}{check.metrics.missing > 0 && <small className="scope-missing">{check.metrics.missing} missing</small>}</td>
          </tr>)}</tbody>
        </table></div></section>}
    </div>
  </>;
}

/** The lens keeps Visibility's layout and swaps in the campaign's evidence, so the two never disagree on how a rate is read. */
export function CampaignVisibility({ view, total, evidence, open }: { view: CampaignView; total: number; evidence: Evidence; open: () => void }) {
  const { campaign, metrics, measurement, presentation } = view;
  return <>
    <div className="measurement-scope campaign-scope"><span>Showing {campaign.prompts.length} of {total} questions</span><button className="text-button" onClick={open}>Open campaign<ArrowRight size={14} /></button></div>
    {!measurement ? <Section><EmptyState icon={Flag} title="Not checked yet">Check these questions to see this campaign's mentions and citations. A check of all your questions counts here too.</EmptyState></Section> : <>
      <div className="metrics three">
        <MetricCard title="Brand mentions" value={percent(metrics.mentionRate)} detail="Answers naming your brand" />
        <MetricCard title="Website citations" value={percent(metrics.citationRate)} detail="Answers linking to your site" tone="citation" />
        <MetricCard title="Answers collected" value={String(metrics.completed)} detail={metrics.missing ? `${metrics.completed} of ${metrics.requested} requested. Missing answers are not counted as absent mentions.` : `All ${metrics.requested} requested answers`} />
      </div>
      <VisibilityChart presentation={presentation} />
      <PromptTable rows={presentation.prompts} evidence={evidence} collecting={!completedMeasurement(measurement)} />
    </>}
  </>;
}

/** Grouping is a reading aid: a question in two campaigns appears under both, and editing the list stays in one place. */
export function PromptGroups({ project, campaigns, prompts, check, edit, create }: {
  project: Project; campaigns: CampaignSummary[]; prompts: string[];
  check: (id: string) => void; edit: (campaign: Campaign) => void; create: (prompts: string[]) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const active = project.campaigns.filter(campaign => campaign.status === 'active');
  const groups = [...active.map(campaign => ({ id: campaign.id, name: campaign.name, prompts: [...new Set(prompts)].filter(prompt => campaign.prompts.includes(prompt)), campaign, summary: campaigns.find(item => item.id === campaign.id) })),
    { id: '', name: 'No campaign', prompts: [...new Set(prompts)].filter(prompt => !active.some(campaign => campaign.prompts.includes(prompt))), campaign: null, summary: undefined }].filter(group => group.prompts.length);
  return <div className="prompt-groups">{groups.map(group => {
    const open = !collapsed.includes(group.id);
    return <section className="prompt-group-card" key={group.id || 'none'} aria-label={group.name}>
      <div className="prompt-group-head">
        <button type="button" className="prompt-group-toggle" aria-expanded={open} onClick={() => setCollapsed(open ? [...collapsed, group.id] : collapsed.filter(id => id !== group.id))}><ChevronDown size={16} aria-hidden="true" /><strong>{group.name}</strong><span>{group.prompts.length} {group.prompts.length === 1 ? 'question' : 'questions'}</span></button>
        {group.summary && (group.summary.metrics ? <span className="prompt-group-rates"><span>Mentions {percent(group.summary.metrics.mentionRate)}</span><span>Citations {percent(group.summary.metrics.citationRate)}</span></span> : <span className="campaign-pending">Not checked yet</span>)}
        <div className="button-row">{group.campaign ? <><button className="text-button" onClick={() => check(group.id)}>Check group</button><button className="text-button" onClick={() => edit(group.campaign!)}>Edit</button></> : <button className="text-button" onClick={() => create(group.prompts)}>Start a campaign with these</button>}</div>
      </div>
      {open && <ol>{group.prompts.map(prompt => <li key={prompt}>{prompt}</li>)}</ol>}
    </section>;
  })}</div>;
}
