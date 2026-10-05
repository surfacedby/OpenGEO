import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Lightbulb, Search, Check, ArrowRight, FilePenLine, ScanSearch, Link, BookOpen, Wrench } from 'lucide-react';
import type { Finding, Job } from '../server/contracts';
import { api } from './api';
import { FindingEvidence } from './WorkflowControls';
import { Select } from './Select';
import { findingGroups, targetLabel, targetDomain } from './finding-groups';
import { SiteIcon } from './SiteIcon';
import './findings.css';

export function Findings({ findings, projectId, run, compact = false, mode = 'opportunities', openAll, openFinding, createContent, drafts = [], openContent, focusedFinding, onFocused, jobs = [], measurementId, emptyMessage, emptyTitle = 'No recommendations yet' }: {
  findings: Finding[];
  projectId: string;
  run: (action: () => Promise<unknown>) => Promise<void>;
  compact?: boolean;
  mode?: 'opportunities' | 'audit';
  openAll?: () => void;
  openFinding?: (finding: Finding) => void;
  createContent?: (finding: Finding) => void;
  drafts?: { id: string; task?: { findingId?: string } }[];
  openContent?: (id: string) => void;
  focusedFinding?: string | null;
  onFocused?: () => void;
  jobs?: Job[];
  measurementId?: string;
  emptyMessage?: string;
  emptyTitle?: string;
}) {
  const [status, setStatus] = useState('active'), [query, setQuery] = useState(''), [type, setType] = useState('all');
  const [saving, setSaving] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusedFinding) return;
    setStatus('all'); setQuery(''); setType('all');
  }, [focusedFinding]);
  const statusCounts = {
    active: findingGroups(findings.filter(finding => finding.status !== 'done')).length,
    doing: findingGroups(findings.filter(finding => finding.status === 'doing')).length,
    done: findingGroups(findings.filter(finding => finding.status === 'done')).length,
    all: findingGroups(findings).length,
  };
  // Type and text filters only earn their place once the list is too long to scan.
  const detailedFilters = statusCounts.all > 6;
  const shown = findings.filter(finding => (compact ? finding.status !== 'done' : status === 'all' || (status === 'active' ? finding.status !== 'done' : finding.status === status))
    && (!detailedFilters || type === 'all' || finding.opportunity?.type === type)
    && (!detailedFilters || (finding.title + ' ' + finding.description + ' ' + (finding.targetUrl ?? '')).toLowerCase().includes(query.trim().toLowerCase())));
  const groups = findingGroups(shown);
  useEffect(() => {
    if (!focusedFinding) return;
    const item = root.current?.querySelector<HTMLElement>('[data-finding="' + focusedFinding + '"]');
    const group = item?.closest('details');
    if (!item || !group) return;
    group.open = true;
    group.querySelector('summary')?.focus();
    item.scrollIntoView({ block: 'center', behavior: 'instant' });
    onFocused?.();
  }, [focusedFinding, status, query]);
  if (compact && groups.length) return <div className="opportunity-preview">{groups.slice(0, 3).map(group => <button key={group.key} onClick={() => openFinding ? openFinding(group.findings[0]) : openAll?.()}>
    <span className={'opportunity-symbol ' + group.priority}><Lightbulb size={18} /></span><span><strong>{group.title}</strong><small>{group.findings[0].opportunity?.type === 'new_content' ? 'Create new content' : group.findings[0].opportunity?.type === 'site_change' ? 'Website change' : group.findings.length === 1 ? 'One page to improve' : group.findings.length + ' related pages'} / {group.priority === 'high' ? 'High priority' : group.priority === 'medium' ? 'Worth reviewing' : 'Optional'}</small></span><ArrowRight size={16} />
  </button>)}</div>;
  return <div className="improvement-list" ref={root}>
    {!compact && findings.length > 0 && <div className="improvement-toolbar">
      <div className="segmented-control" role="group" aria-label="Filter improvements">
        {([['active', 'To do'], ['doing', 'In progress'], ['done', 'Done'], ['all', 'All']] as const).map(([value, label]) => <button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{value === 'done' && <Check size={14} />}{label}<span>{statusCounts[value]}</span></button>)}
      </div>
      {detailedFilters && mode !== 'audit' && findings.some(item => item.opportunity) && <Select label="Kind of opportunity" compact searchable={false} value={type} onChange={setType} options={[{ value: 'all', label: 'All opportunities' }, { value: 'page_update', label: 'Improve a page' }, { value: 'new_content', label: 'Create new content' }, { value: 'site_change', label: 'Website changes' }]} />}
      {detailedFilters && <label className="search"><Search size={15} /><input aria-label="Search improvements" placeholder="Find an improvement or page" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    </div>}
    {groups.length ? groups.map(group => <details className={'improvement-group ' + mode} key={group.key}>
      <summary><span className={'opportunity-symbol ' + group.priority}>{mode === 'audit' ? <ScanSearch size={18} /> : group.findings[0].opportunity?.type === 'new_content' ? <BookOpen size={18} /> : group.findings[0].opportunity?.type === 'site_change' ? <Wrench size={18} /> : <FilePenLine size={18} />}</span><span className="opportunity-heading"><strong>{group.title}</strong>{mode !== 'audit' && <span className="opportunity-description">{group.findings[0].opportunity?.benefit ?? group.findings[0].description}</span>}<span className="opportunity-meta"><span className={'badge ' + group.priority}>{group.priority === 'high' ? 'High priority' : group.priority === 'medium' ? 'Worth reviewing' : 'Optional'}</span><span className="opportunity-kind">{group.findings[0].opportunity?.type === 'new_content' ? 'Create new content' : group.findings[0].opportunity?.type === 'site_change' ? 'Website change' : 'Improve existing page'}</span>{group.findings.length > 1 ? <span>{group.findings.length} related pages</span> : <span className={'opportunity-page' + (group.findings[0].opportunity?.type === 'new_content' ? ' planned' : '')} title={group.findings[0].targetUrl}>{group.findings[0].opportunity?.type === 'new_content' ? <><BookOpen size={13} />{group.findings[0].opportunity.pageTitle}</> : <>{targetDomain(group.findings[0].targetUrl) && <SiteIcon projectId={projectId} domain={targetDomain(group.findings[0].targetUrl)!} size={16} />}{targetLabel(group.findings[0].targetUrl)}</>}</span>}</span></span><span className="opportunity-expand">View plan <ChevronDown size={16} /></span></summary>
      <div className="improvement-items">{group.findings.map(finding => <article key={finding.id} data-finding={finding.id} className="improvement-item">
        <div className="improvement-item-heading"><div><span className="finding-target">{targetDomain(finding.targetUrl) && <SiteIcon projectId={projectId} domain={targetDomain(finding.targetUrl)!} size={24} />}<span>{finding.opportunity?.pageTitle ?? targetLabel(finding.targetUrl)}</span></span><small>{finding.opportunity ? (finding.opportunity.type === 'new_content' ? 'Context: ' : 'Page: ') + finding.opportunity.pageLabel : mode === 'audit' ? 'Observed page check' : 'Page improvement'}</small></div>
          <Select label={'Status for ' + finding.title + ' on ' + targetLabel(finding.targetUrl)} compact searchable={false} disabled={saving === finding.id} value={finding.status} options={[{ value: 'open', label: 'To do' }, { value: 'doing', label: 'In progress' }, { value: 'done', label: 'Done' }]} onChange={status => {
            setSaving(finding.id);
            void run(() => api('/projects/' + projectId + '/findings/' + finding.id, { status }, 'PATCH')).finally(() => setSaving(null));
          }} />
        </div>
        {jobs.find(job => job.id === finding.jobId) && <small className="finding-period">{(() => {
          const job = jobs.find(job => job.id === finding.jobId)!;
          const period = (job.result as { measurementJobId?: string } | null)?.measurementJobId;
          return (period && period !== measurementId ? 'Started from an earlier check / ' : 'Analyzed ') + new Date(job.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        })()}</small>}
        <div className="finding-next-step"><span>Start here</span><p>{finding.steps[0] ?? finding.description}</p></div>
        <div className="improvement-detail"><h3>{finding.opportunity?.type === 'new_content' ? 'Build the resource' : 'Complete the improvement'}</h3>{finding.steps.length > 1 && <ol start={2}>{finding.steps.slice(1).map((step, index) => <li key={index}>{step}</li>)}</ol>}
          <details className="finding-reason"><summary>Why this matters</summary><p>{finding.description}</p>{finding.opportunity && <p>{finding.opportunity.benefit}</p>}</details>
          {targetDomain(finding.targetUrl) && <a href={finding.targetUrl} target="_blank" rel="noreferrer">{finding.opportunity?.type === 'new_content' ? 'View context page' : 'Open page'} <ExternalLink size={13} /></a>}
          <small><Link size={13} />{finding.confidence === 'known' ? 'Observed on the page' : 'Review the interpretation against its sources'}</small>
          <FindingEvidence projectId={projectId} findingId={finding.id} />
          {mode !== 'audit' && createContent && finding.opportunity?.type !== 'site_change' && (() => {
            const draft = drafts.find(doc => doc.task?.findingId === finding.id);
            const active = jobs.find(job => job.kind === 'content' && job.findingId === finding.id && ['queued', 'running', 'paused'].includes(job.status));
            return draft && openContent ? <button className="secondary" onClick={() => openContent(draft.id)}><FilePenLine size={15} />View draft <ArrowRight size={14} /></button>
              : active ? <small>A draft for this improvement is {active.status === 'paused' ? 'paused' : 'in progress'}. Follow it in Content.</small>
              : <button className="secondary" onClick={() => createContent(finding)}><FilePenLine size={15} />{finding.opportunity?.type === 'new_content' ? 'Draft this resource' : 'Draft page copy'}</button>;
          })()}
        </div>
      </article>)}</div>
    </details>) : <div className="empty"><Lightbulb size={24} /><h3>{findings.length ? 'No matching improvements' : emptyTitle}</h3><p>{findings.length ? 'Choose another status or clear your search.' : emptyMessage ?? 'Analyze your collected answers and audited pages to prepare an improvement plan.'}</p></div>}
  </div>;
}
