import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Flag, Globe, LoaderCircle, MessagesSquare, Plus, Save, Search, Sparkles } from 'lucide-react';
import type { Topic, Job, Project, Provider, Observation } from '../server/contracts';
import type { TopicSummary } from '../server/topics';
import { api } from './api';
import { QuestionRows, type QuestionRow } from './QuestionRows';
import { FormFeedback, useFormFeedback } from './FormFeedback';
import { Select } from './Select';
import { providerOptions } from './provider-ui';
import { EmptyState, Section, Tabs, Toolbar } from './ui/Primitives';
import type { EditState } from './useCloseProtection';
import { PromptGroups } from './Topics';
import { PromptSearches } from './PromptSearches';
import { dateTime } from './format';
import { promptResults } from './prompt-results';

type Suggestion = { text: string; sources?: { url: string; title: string }[] };

/** The same durable discovery jobs power setup and later prompt selection. */
export function PromptWorkspace({ project, jobs, connected, refresh, openConnections, runControls, onEditState, topics, checkTopic, editTopic, observations, evidence }: {
  project: Project; jobs: Job[]; connected: Record<string, boolean>; refresh: () => Promise<void>;
  openConnections: () => void; runControls: ReactNode;
  onEditState: (state: EditState) => void;
  topics: TopicSummary[]; checkTopic: (id: string) => void; editTopic: (topic: Topic | null, prompts?: string[]) => void;
  observations: Observation[]; evidence: (ids: string[], label: string) => void;
}) {
  const options = providerOptions(connected, ['chatgpt', 'console', 'openrouter']);
  const [provider, setProvider] = useState<Provider>(options[0]?.value as Provider ?? 'chatgpt');
  const [budget, setBudget] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [editing, setEditing] = useState(!project.prompts.length), [query, setQuery] = useState(''), [grouping, setGrouping] = useState<'topic' | 'none'>('topic');
  const [rows, setRows] = useState<QuestionRow[]>(project.prompts.map(text => ({ id: crypto.randomUUID(), text, selected: true })));
  const [selected, setSelected] = useState<string[]>([]);
  const [topicSelection, setTopicSelection] = useState<string[]>([]);
  const [suggestionRun, setSuggestionRun] = useState('');
  const [tab, setTab] = useState<'tracked' | 'suggested' | 'searches'>(project.prompts.length ? 'tracked' : 'suggested');
  const request = useRef<string | null>(null), feedback = useFormFeedback();
  const discovery = jobs.find(job => job.kind === 'discover');
  const completedDiscoveries = jobs.filter(job => job.kind === 'discover' && job.status === 'completed');
  const selectedDiscovery = completedDiscoveries.find(job => job.id === suggestionRun) ?? completedDiscoveries[0];
  const reading = discovery?.auditJobId ? jobs.find(job => job.id === discovery.auditJobId) : undefined;
  const suggestions = (selectedDiscovery?.result as { questions?: Suggestion[] } | undefined)?.questions ?? [];
  const pending = discovery && ['queued', 'running', 'paused'].includes(discovery.status);
  const dirty = editing && JSON.stringify(rows.filter(row => row.selected).map(row => row.text.trim()).filter(Boolean)) !== JSON.stringify(project.prompts);
  useEffect(() => { onEditState({ dirty, busy }); return () => onEditState({ dirty: false, busy: false }); }, [dirty, busy, onEditState]);
  useEffect(() => { setSelected([]); }, [selectedDiscovery?.id]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); feedback.setError(''); setMessage('');
    try { await action(); await refresh(); } catch (error) { feedback.setError(error); }
    finally { setBusy(false); }
  }
  const filtered = project.prompts.filter(text => text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selectedPrompts = topicSelection.filter(prompt => project.prompts.includes(prompt));
  const results = useMemo(() => promptResults(observations), [observations]);
  function renderPrompts(prompts: string[]) {
    return <ol className="tracked-prompt-list">{prompts.map(text => {
      const result = results.get(text);
      return <li key={text}><label className="tracked-prompt-choice"><input type="checkbox" aria-label={'Select prompt: ' + text} checked={selectedPrompts.includes(text)} onChange={event => setTopicSelection(current => event.target.checked ? [...new Set([...current, text])] : current.filter(prompt => prompt !== text))} /><span>{text}</span></label>
        <div className="prompt-result">{result ? <><button className="text-button" aria-label={'View answers for prompt: ' + text} onClick={() => evidence(result.ids, text)}>{result.ids.length} {result.ids.length === 1 ? 'answer' : 'answers'}<ArrowRight size={14} /></button><span>{result.mentions} {result.mentions === 1 ? 'mention' : 'mentions'} / {result.citations} {result.citations === 1 ? 'citation' : 'citations'}</span></> : <span>No answer in this check</span>}</div>
      </li>;
    })}</ol>;
  }
  return <>
    <Tabs label="Prompts" panelId="prompt-content" value={tab} onChange={value => {
      if (busy || dirty) { feedback.setError('Save or cancel your prompt changes before switching tabs.'); return; }
      setTab(value);
    }} items={[{ value: 'tracked', label: 'Tracked prompts', count: project.prompts.length }, { value: 'suggested', label: 'Suggested by AI', icon: Sparkles }, { value: 'searches', label: 'AI searches', icon: Search }]} />
    <FormFeedback feedback={feedback} />{message && <p role="status" className="save-notice">{message}</p>}
    <div id="prompt-content" role="tabpanel" aria-label={tab === 'tracked' ? 'Tracked prompts' : tab === 'searches' ? 'AI searches' : 'Suggested by AI'} tabIndex={0}>
    {tab === 'searches' ? <PromptSearches observations={observations} evidence={evidence} /> : tab === 'tracked' ? <Section className="prompt-panel">
      <Toolbar actions={!editing && <>{project.topics.some(topic => topic.status === 'active') && <Select label="Group prompts" compact searchable={false} value={grouping} onChange={value => setGrouping(value as 'topic' | 'none')} options={[{ value: 'topic', label: 'Group by topic' }, { value: 'none', label: 'No grouping' }]} />}<button className="secondary" disabled={busy} onClick={() => { setRows(project.prompts.map(text => ({ id: crypto.randomUUID(), text, selected: true }))); setEditing(true); }}><Plus size={15} />Add or edit prompts</button></>}>
        {!editing && project.prompts.length > 0 ? <label className="search"><Search size={16} /><input aria-label="Search tracked prompts" placeholder="Find a prompt..." value={query} onChange={event => setQuery(event.target.value)} /></label> : <h2>Your tracked prompts</h2>}
      </Toolbar>
      {!editing && observations.length > 0 && <p className="prompt-result-note">Results from the current check. Mentions name your brand; citations link to your website.</p>}
      {!editing && project.prompts.length > 0 && <Toolbar actions={<button className="secondary" disabled={!selectedPrompts.length} onClick={() => editTopic(null, selectedPrompts)}><Flag size={15} />Create topic{selectedPrompts.length ? ' (' + selectedPrompts.length + ')' : ''}</button>}>
        <div className="button-row"><button className="text-button" disabled={!filtered.length} onClick={() => setTopicSelection(current => [...new Set([...current, ...filtered])])}>Select {query ? 'matching' : 'all'} prompts</button>
        {selectedPrompts.length > 0 && <><span role="status">{selectedPrompts.length} selected{selectedPrompts.some(prompt => !filtered.includes(prompt)) ? ', including hidden prompts' : ''}</span><button className="text-button" onClick={() => setTopicSelection([])}>Clear selection</button></>}</div>
      </Toolbar>}
      {editing ? <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        await api('/projects/' + project.id, { prompts: [...new Set(rows.filter(row => row.selected).map(row => row.text.trim()).filter(Boolean))] }, 'PATCH');
        setEditing(false); setMessage('Prompts saved. Your next visibility check will use this list.');
      }); }}><QuestionRows rows={rows} onChange={setRows} disabled={busy} feedback={feedback} /><div className="button-row"><button className="primary" disabled={busy}><Save size={16} />Save prompts</button><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div></form>
      : project.prompts.length && grouping === 'topic' && project.topics.some(topic => topic.status === 'active') ? filtered.length ? <PromptGroups project={project} topics={topics} prompts={filtered} check={checkTopic} edit={editTopic} create={prompts => editTopic(null, prompts)} renderPrompts={renderPrompts} /> : <p>No prompts match your search.</p>
      : project.prompts.length ? <><div className="prompt-list-label"><span>Prompt</span><span>Current check</span></div>{renderPrompts(filtered)}{!filtered.length && <p>No prompts match your search.</p>}</>
      : <EmptyState icon={MessagesSquare} title="Start with prompts your customers would ask" action={<button className="primary" onClick={() => setTab('suggested')}><Sparkles size={16} />Find suggestions</button>}>Let your connected AI read your website and suggest relevant questions, or add your own.</EmptyState>}
    </Section> : <Section className="prompt-panel" title="Discover your next prompts" description="Suggestions use your website and brand details. Nothing is tracked until you choose it.">
      {pending ? <div className="question-discovery" role="status"><LoaderCircle size={21} className={discovery.status === 'paused' ? '' : 'loading-spin'} /><div><strong>{discovery.status === 'queued' && reading && reading.status !== 'completed' ? 'Reading your website' : discovery.progress}</strong><p>{discovery.status === 'paused' ? 'Review this saved run below to continue.' : 'Your progress is saved. You can leave this page and come back.'}</p></div></div>
      : options.length ? <form className="prompt-discovery-controls" onSubmit={event => { event.preventDefault(); void perform(async () => {
        request.current ??= crypto.randomUUID();
        await api('/onboarding/questions', { projectId: project.id, provider, maxCostUsd: provider === 'chatgpt' ? 0 : Number(budget), requestId: request.current });
        setSuggestionRun('');
        request.current = null;
      }); }}><label>Suggest with<Select label="Suggestion provider" value={provider} options={options} onChange={value => { setProvider(value as Provider); request.current = null; }} /></label>{provider !== 'chatgpt' && <label>Spending limit (USD)<input type="number" min="0.01" max="100" step="0.01" required value={budget} onChange={event => { setBudget(event.target.value); request.current = null; }} /></label>}<button className="primary" disabled={busy || !connected[provider]}><Sparkles size={16} />{busy ? 'Starting...' : suggestions.length ? 'Find more suggestions' : 'Suggest prompts'}</button><small>{provider === 'chatgpt' ? 'Uses your connected ChatGPT plan. Its usage limits apply.' : 'Your spending limit applies. Managed work asks you to approve its price before starting.'}</small></form>
      : <EmptyState icon={Globe} title="Connect AI to discover prompts" action={<button className="primary" onClick={openConnections}>Choose a connection<ArrowRight size={15} /></button>}>Use ChatGPT, SurfacedBy or OpenRouter. You can also add prompts yourself in Tracked prompts.</EmptyState>}
      {runControls}
      {completedDiscoveries.length > 1 && <Toolbar><Select label="Suggestion history" compact searchable={false} value={selectedDiscovery?.id ?? ''} onChange={setSuggestionRun} options={completedDiscoveries.map(job => ({ value: job.id, label: dateTime(job.createdAt), detail: ((job.result as { questions?: Suggestion[] })?.questions?.length ?? 0) + ' suggestions' }))} /></Toolbar>}
      {!!suggestions.length && <><div className="panel-heading"><h3>Based on your website</h3><span>{selected.length} selected</span></div><div className="prompt-suggestions">{suggestions.map(item => {
        const tracked = project.prompts.some(text => text.toLocaleLowerCase() === item.text.toLocaleLowerCase());
        return <div className="prompt-suggestion" key={item.text}><label><input type="checkbox" disabled={tracked || busy} checked={tracked || selected.includes(item.text)} onChange={event => setSelected(current => event.target.checked ? [...current, item.text] : current.filter(text => text !== item.text))} /><span>{item.text}{tracked && <small>Already tracked</small>}</span></label>{item.sources?.length ? <div className="prompt-source-links">{item.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><Globe size={12} />{source.title || new URL(source.url).hostname}</a>)}</div> : null}</div>;
      })}</div><button className="primary" disabled={busy || !selected.length} onClick={() => void perform(async () => { await api('/projects/' + project.id + '/prompts', { prompts: selected }); setSelected([]); setEditing(false); setTab('tracked'); setMessage('Selected prompts added. You can start your visibility check.'); })}><Plus size={16} />Track selected prompts</button></>}
      {selectedDiscovery && !suggestions.length && <p>We couldn't find supported suggestions from these pages. Add your own prompts, or update your brand details and try again.</p>}
    </Section>}
    </div>
  </>;
}
