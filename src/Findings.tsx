import { useState } from 'react';
import { ChevronDown, ExternalLink, Lightbulb, Search, Check } from 'lucide-react';
import type { Finding } from '../server/contracts';
import { api } from './api';
import { FindingEvidence } from './WorkflowControls';
import { Select } from './Select';
import { findingGroups, targetLabel } from './finding-groups';
import './findings.css';

export function Findings({ findings, projectId, run, compact = false, emptyMessage, emptyTitle = 'No recommendations yet' }: {
  findings: Finding[];
  projectId: string;
  run: (action: () => Promise<unknown>) => Promise<void>;
  compact?: boolean;
  emptyMessage?: string;
  emptyTitle?: string;
}) {
  const [status, setStatus] = useState('active'), [query, setQuery] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const shown = findings.filter(finding => (compact || status === 'all' || (status === 'active' ? finding.status !== 'done' : finding.status === status))
    && (finding.title + ' ' + finding.description + ' ' + (finding.targetUrl ?? '')).toLowerCase().includes(query.trim().toLowerCase()));
  const groups = findingGroups(shown);
  return <div className="improvement-list">
    {!compact && findings.length > 0 && <div className="improvement-toolbar">
      <div className="segmented-control" role="group" aria-label="Filter improvements">
        {[['active', 'Unfinished'], ['doing', 'In progress'], ['done', 'Done'], ['all', 'All']].map(([value, label]) => <button key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{value === 'done' && <Check size={14} />}{label}</button>)}
      </div>
      <label className="search"><Search size={15} /><input aria-label="Search improvements" placeholder="Find an improvement or page" value={query} onChange={event => setQuery(event.target.value)} /></label>
    </div>}
    {groups.length ? groups.slice(0, compact ? 5 : undefined).map(group => <details className="improvement-group" key={group.key} open={!compact && groups.length === 1}>
      <summary><span className={'badge ' + group.priority}>{group.priority === 'high' ? 'High priority' : group.priority === 'medium' ? 'Worth reviewing' : 'Optional'}</span><strong>{group.title}</strong><span className="improvement-count">{group.findings.length} {group.findings.length === 1 ? 'item' : 'items'}</span><ChevronDown size={16} /></summary>
      <div className="improvement-items">{group.findings.map(finding => <article key={finding.id} className="improvement-item">
        <div className="improvement-item-heading"><div><span>{targetLabel(finding.targetUrl)}</span><small>{finding.kind === 'visibility' ? 'Collected answer' : ['analysis', 'console'].includes(finding.kind) ? 'Evidence analysis' : 'Site audit'}</small></div>
          <Select label={'Status for ' + finding.title + ' on ' + targetLabel(finding.targetUrl)} compact searchable={false} disabled={saving === finding.id} value={finding.status} options={[{ value: 'open', label: 'To do' }, { value: 'doing', label: 'In progress' }, { value: 'done', label: 'Done' }]} onChange={status => {
            setSaving(finding.id);
            void run(() => api('/projects/' + projectId + '/findings/' + finding.id, { status }, 'PATCH')).finally(() => setSaving(null));
          }} />
        </div>
        <p>{finding.description}</p>
        <details className="improvement-detail"><summary>Steps and supporting evidence <ChevronDown size={14} /></summary><ol>{finding.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
          {finding.targetUrl && <a href={finding.targetUrl} target="_blank" rel="noreferrer">Open page <ExternalLink size={13} /></a>}
          <small>{finding.confidence === 'known' ? 'Observed finding' : 'Interpretation to review'} / {finding.evidenceIds.length} supporting records</small>
          <FindingEvidence projectId={projectId} findingId={finding.id} />
        </details>
      </article>)}</div>
    </details>) : <div className="empty"><Lightbulb size={24} /><h3>{findings.length ? 'No matching improvements' : emptyTitle}</h3><p>{findings.length ? 'Choose another status or clear your search.' : emptyMessage ?? 'Analyze your collected answers and audited pages to prepare an improvement plan.'}</p></div>}
  </div>;
}
