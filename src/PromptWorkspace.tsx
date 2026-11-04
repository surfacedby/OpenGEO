import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Globe, LoaderCircle, MessagesSquare, Plus, Save, Search, Sparkles } from 'lucide-react';
import type { Campaign, Job, Project, Provider } from '../server/contracts';
import type { CampaignSummary } from '../server/campaigns';
import { api } from './api';
import { QuestionRows, type QuestionRow } from './QuestionRows';
import { FormFeedback, useFormFeedback } from './FormFeedback';
import { Select } from './Select';
import { providerOptions } from './provider-ui';
import { EmptyState, Section, Tabs, Toolbar } from './ui/Primitives';
import type { EditState } from './useCloseProtection';
import { PromptGroups } from './Campaigns';

type Suggestion = { text: string; sources?: { url: string; title: string }[] };

/** The same durable discovery jobs power setup and later prompt selection. */
export function PromptWorkspace({ project, jobs, connected, refresh, openConnections, runControls, onEditState, campaigns, checkCampaign, editCampaign }: {
  project: Project; jobs: Job[]; connected: Record<string, boolean>; refresh: () => Promise<void>;
  openConnections: () => void; runControls: ReactNode;
  onEditState: (state: EditState) => void;
  campaigns: CampaignSummary[]; checkCampaign: (id: string) => void; editCampaign: (campaign: Campaign | null, prompts?: string[]) => void;
}) {
  const options = providerOptions(connected, ['chatgpt', 'console', 'openrouter']);
  const [provider, setProvider] = useState<Provider>(options[0]?.value as Provider ?? 'chatgpt');
  const [budget, setBudget] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [editing, setEditing] = useState(!project.prompts.length), [query, setQuery] = useState(''), [grouping, setGrouping] = useState<'campaign' | 'none'>('campaign');
  const [rows, setRows] = useState<QuestionRow[]>(project.prompts.map(text => ({ id: crypto.randomUUID(), text, selected: true })));
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<'tracked' | 'suggested'>(project.prompts.length ? 'tracked' : 'suggested');
  const request = useRef<string | null>(null), feedback = useFormFeedback();
  const discovery = jobs.find(job => job.kind === 'discover');
  const reading = discovery?.auditJobId ? jobs.find(job => job.id === discovery.auditJobId) : undefined;
  const suggestions = discovery?.status === 'completed' ? (discovery.result as { questions?: Suggestion[] })?.questions ?? [] : [];
  const pending = discovery && ['queued', 'running', 'paused'].includes(discovery.status);
  const dirty = editing && JSON.stringify(rows.filter(row => row.selected).map(row => row.text.trim()).filter(Boolean)) !== JSON.stringify(project.prompts);
  useEffect(() => { onEditState({ dirty, busy }); return () => onEditState({ dirty: false, busy: false }); }, [dirty, busy, onEditState]);
  useEffect(() => { setSelected([]); }, [discovery?.id]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); feedback.setError(''); setMessage('');
    try { await action(); await refresh(); } catch (error) { feedback.setError(error); }
    finally { setBusy(false); }
  }
  const filtered = project.prompts.filter(text => text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    <Tabs label="Prompts" panelId="prompt-content" value={tab} onChange={value => {
      if (busy || dirty) { feedback.setError('Save or cancel your prompt changes before switching tabs.'); return; }
      setTab(value);
    }} items={[{ value: 'tracked', label: 'Tracked prompts', count: project.prompts.length }, { value: 'suggested', label: 'Suggested for you', icon: Sparkles }]} />
    <FormFeedback feedback={feedback} />{message && <p role="status" className="save-notice">{message}</p>}
    <div id="prompt-content" role="tabpanel" aria-label={tab === 'tracked' ? 'Tracked prompts' : 'Suggested for you'} tabIndex={0}>
    {tab === 'tracked' ? <Section className="prompt-panel">
      <Toolbar actions={!editing && <>{project.campaigns.some(campaign => campaign.status === 'active') && <Select label="Group prompts" compact searchable={false} value={grouping} onChange={value => setGrouping(value as 'campaign' | 'none')} options={[{ value: 'campaign', label: 'Group by campaign' }, { value: 'none', label: 'No grouping' }]} />}<button className="secondary" disabled={busy} onClick={() => { setRows(project.prompts.map(text => ({ id: crypto.randomUUID(), text, selected: true }))); setEditing(true); }}><Plus size={15} />Add or edit prompts</button></>}>
        {!editing && project.prompts.length > 0 ? <label className="search"><Search size={16} /><input aria-label="Search tracked prompts" placeholder="Find a prompt..." value={query} onChange={event => setQuery(event.target.value)} /></label> : <h2>Your tracked prompts</h2>}
      </Toolbar>
      {editing ? <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        await api('/projects/' + project.id, { prompts: [...new Set(rows.filter(row => row.selected).map(row => row.text.trim()).filter(Boolean))] }, 'PATCH');
        setEditing(false); setMessage('Prompts saved. Your next visibility check will use this list.');
      }); }}><QuestionRows rows={rows} onChange={setRows} disabled={busy} feedback={feedback} /><div className="button-row"><button className="primary" disabled={busy}><Save size={16} />Save prompts</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div></form>
      : project.prompts.length && grouping === 'campaign' && project.campaigns.some(campaign => campaign.status === 'active') ? filtered.length ? <PromptGroups project={project} campaigns={campaigns} prompts={filtered} check={checkCampaign} edit={editCampaign} create={prompts => editCampaign(null, prompts)} /> : <p>No prompts match your search.</p>
      : project.prompts.length ? <><div className="prompt-list-label"><span>Prompt</span><span>Status</span></div><ol className="tracked-prompt-list">{filtered.map((text, index) => <li key={index + ':' + text}><MessagesSquare size={17} /><span>{text}</span><span className="prompt-ready"><Check size={13} />Tracked</span></li>)}</ol>{!filtered.length && <p>No prompts match your search.</p>}</>
      : <EmptyState icon={MessagesSquare} title="Start with prompts your customers would ask" action={<button className="primary" onClick={() => setTab('suggested')}><Sparkles size={16} />Find suggestions</button>}>Let your connected AI read your website and suggest relevant questions, or add your own.</EmptyState>}
    </Section> : <Section className="prompt-panel" title="Discover your next prompts" description="Suggestions use your website and brand details. Nothing is tracked until you choose it.">
      {pending ? <div className="question-discovery" role="status"><LoaderCircle size={21} className={discovery.status === 'paused' ? '' : 'loading-spin'} /><div><strong>{discovery.status === 'queued' && reading && reading.status !== 'completed' ? 'Reading your website' : discovery.progress}</strong><p>{discovery.status === 'paused' ? 'Review this saved run below to continue.' : 'Your progress is saved. You can leave this page and come back.'}</p></div></div>
      : options.length ? <form className="prompt-discovery-controls" onSubmit={event => { event.preventDefault(); void perform(async () => {
        request.current ??= crypto.randomUUID();
        await api('/onboarding/questions', { projectId: project.id, provider, maxCostUsd: provider === 'chatgpt' ? 0 : Number(budget), requestId: request.current });
        request.current = null;
      }); }}><label>Suggest with<Select label="Suggestion provider" value={provider} options={options} onChange={value => { setProvider(value as Provider); request.current = null; }} /></label>{provider !== 'chatgpt' && <label>Spending limit (USD)<input type="number" min="0.01" max="100" step="0.01" required value={budget} onChange={event => { setBudget(event.target.value); request.current = null; }} /></label>}<button className="primary" disabled={busy || !connected[provider]}><Sparkles size={16} />{busy ? 'Starting...' : suggestions.length ? 'Find more suggestions' : 'Suggest prompts'}</button><small>{provider === 'chatgpt' ? 'Uses your connected ChatGPT plan. Its usage limits apply.' : 'Your spending limit applies. Managed work asks you to approve its price before starting.'}</small></form>
      : <EmptyState icon={Globe} title="Connect AI to discover prompts" action={<button className="primary" onClick={openConnections}>Choose a connection<ArrowRight size={15} /></button>}>Use ChatGPT, SurfacedBy or OpenRouter. You can also add prompts yourself in Tracked prompts.</EmptyState>}
      {runControls}
      {!!suggestions.length && <><div className="panel-heading"><h3>Based on your website</h3><span>{selected.length} selected</span></div><div className="prompt-suggestions">{suggestions.map(item => {
        const tracked = project.prompts.some(text => text.toLocaleLowerCase() === item.text.toLocaleLowerCase());
        return <div className="prompt-suggestion" key={item.text}><label><input type="checkbox" disabled={tracked || busy} checked={tracked || selected.includes(item.text)} onChange={event => setSelected(current => event.target.checked ? [...current, item.text] : current.filter(text => text !== item.text))} /><span>{item.text}{tracked && <small>Already tracked</small>}</span></label>{item.sources?.length ? <div className="prompt-source-links">{item.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><Globe size={12} />{source.title || new URL(source.url).hostname}</a>)}</div> : null}</div>;
      })}</div><button className="primary" disabled={busy || !selected.length} onClick={() => void perform(async () => { await api('/projects/' + project.id, { prompts: [...new Set([...project.prompts, ...selected])] }, 'PATCH'); setSelected([]); setEditing(false); setTab('tracked'); setMessage('Selected prompts added. You can start your visibility check.'); })}><Plus size={16} />Track selected prompts</button></>}
      {discovery?.status === 'completed' && !suggestions.length && <p>We couldn't find supported suggestions from these pages. Add your own prompts, or update your brand details and try again.</p>}
    </Section>}
    </div>
  </>;
}
