import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ExternalLink, Flag, Search } from 'lucide-react';
import type { Topic, Project } from '../server/contracts';
import type { TopicSummary, TopicView } from '../server/topics';
import { completedMeasurement } from '../server/portable-results';
import { api } from './api';
import { Select } from './Select';
import { CitationComparison, PromptTable, RateBar, SourcesTable, VisibilityChart } from './DataPresentation';
import { EmptyState, MetricCard, Section, Tabs } from './ui/Primitives';
import { dateTime, percent, shortDate } from './format';
import './topics.css';

type Evidence = (ids: string[], label: string) => void;

/** A topic's evidence refreshes on the workspace's rhythm, so scoped screens never lag the brand view. */
export function useTopicView(projectId: string | undefined, topicId: string | null, version: string) {
  const [snapshot, setSnapshot] = useState<{ projectId: string; view: TopicView } | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!projectId || !topicId) { setSnapshot(null); setError(''); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(null); setError('');
    const load = () => api<TopicView>('/projects/' + projectId + '/topics/' + topicId)
      .then(next => { if (!stopped) { setSnapshot({ projectId, view: next }); setError(''); } })
      .catch(failure => { if (!stopped) setError((failure as Error).message); })
      .finally(() => { if (!stopped) timer = setTimeout(load, 3000); });
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [projectId, topicId, version]);
  return { view: snapshot && snapshot.projectId === projectId && snapshot.view.topic.id === topicId ? snapshot.view : null, error };
}

const today = () => new Date().toLocaleDateString('en-CA');
const reviewDate = (value: string) => new Date(value + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Scoping is a lens over the same screens: it narrows the questions read, never the saved evidence. */
export function TopicLens({ topics, total, value, onChange, onNew, mobile = false }: {
  topics: TopicSummary[]; total: number; value: string | null;
  onChange: (id: string | null) => void; onNew: () => void; mobile?: boolean;
}) {
  const active = topics.filter(topic => topic.status === 'active' || topic.id === value);
  return <div className={'topic-lens' + (mobile ? ' in-page' : '') + (value ? ' scoped' : '')}>
    <Flag size={15} aria-hidden="true" />
    <Select label={mobile ? 'Mobile topic' : 'Topic'} compact searchable={active.length > 8} value={value ?? 'all'} onChange={id => id === 'new' ? onNew() : onChange(id === 'all' ? null : id)}
      options={[{ value: 'all', label: 'All questions', detail: total + ' questions' }, ...active.map(topic => ({ value: topic.id, label: topic.name, detail: topic.questions + ' questions' })), { value: 'new', label: 'New topic' }]} />
    {value && <button className="text-button" onClick={() => onChange(null)}>Show all questions</button>}
  </div>;
}

function ReviewBy({ date, edit }: { date: string | null; edit: () => void }) {
  if (!date) return <button className="text-button" onClick={edit}>Set a date</button>;
  return date < today() ? <span className="badge medium">{reviewDate(date)}, passed</span> : <span className="badge low">{reviewDate(date)}</span>;
}

export function Topics({ project, topics, openId, view, error, open, edit, evidence, openPrompts, openCompetitors, opportunities }: {
  project: Project; topics: TopicSummary[]; openId: string | null; view: TopicView | null; error: string;
  open: (id: string | null) => void; edit: (topic: Topic | null) => void;
  evidence: (topic: Topic) => Evidence; openPrompts: () => void; openCompetitors: () => void;
  opportunities: ReactNode;
}) {
  const [tab, setTab] = useState<'active' | 'closed'>('active'), [query, setQuery] = useState('');
  if (openId) return view ? <TopicDetail project={project} view={view} open={open} edit={edit} evidence={evidence(view.topic)} openCompetitors={openCompetitors} opportunities={opportunities} />
    : <Section>{error ? <p role="alert">{error}</p> : <div className="workspace-loading" role="status"><span className="visually-hidden">Loading this topic</span><div className="panel skeleton tall" aria-hidden="true" /></div>}</Section>;
  if (!topics.length) return <Section><EmptyState icon={Flag} title="Group your questions into topics" action={<button className="primary" onClick={() => edit(null)}>Create a topic</button>}>
    A topic follows a few questions toward one goal: their mentions, citations and target pages, checked together. Your {project.prompts.length} questions keep working as they do today.
  </EmptyState></Section>;
  const grouped = new Set(project.topics.flatMap(topic => topic.prompts));
  const loose = project.prompts.filter(prompt => !grouped.has(prompt)).length;
  const shown = topics.filter(topic => topic.status === tab && (topic.name + ' ' + topic.goal).toLowerCase().includes(query.trim().toLowerCase()));
  const byId = new Map(project.topics.map(topic => [topic.id, topic]));
  return <>
    <Tabs label="Topic status" panelId="topic-list" value={tab} onChange={setTab} items={[{ value: 'active', label: 'Active', count: topics.filter(topic => topic.status === 'active').length }, { value: 'closed', label: 'Closed', count: topics.filter(topic => topic.status === 'closed').length }]} />
    <section id="topic-list" role="tabpanel" className="panel analytics-panel topic-list" aria-label={tab === 'active' ? 'Active topics' : 'Closed topics'}>
      <div className="panel-heading"><h2>{tab === 'active' ? 'Active topics' : 'Closed topics'}</h2><label className="search"><Search size={15} /><input aria-label="Find a topic" placeholder="Find a topic" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {shown.length ? <div className="table-wrap"><table className="analytics-table topic-table responsive-evidence-table">
        <caption className="visually-hidden">Topics and their latest readings</caption>
        <thead><tr><th>Topic</th><th>Questions</th><th>Mentions</th><th>Citations</th><th>Target pages cited</th><th>Last check</th><th>Review by</th></tr></thead>
        <tbody>{shown.map(topic => <tr key={topic.id}>
          <td><button className="text-button topic-name" onClick={() => open(topic.id)}>{topic.name}<ArrowRight size={14} /></button>{topic.goal && <small>{topic.goal}</small>}</td>
          <td data-label="Questions">{topic.questions}</td>
          <td data-label="Mentions">{topic.metrics ? <RateBar value={topic.metrics.mentionRate} measure="mention" /> : <span className="topic-pending">Not checked yet</span>}</td>
          <td data-label="Citations">{topic.metrics ? <RateBar value={topic.metrics.citationRate} measure="citation" /> : <span className="topic-pending">Not checked yet</span>}</td>
          <td data-label="Target pages cited">{!topic.targets ? <span className="topic-pending">Not set</span> : topic.targetsCited === null ? <span className="topic-pending">Not checked yet</span> : topic.targetsCited + ' of ' + topic.targets}</td>
          <td data-label="Last check">{topic.lastCheckAt ? shortDate(topic.lastCheckAt) : 'None'}</td>
          <td data-label="Review by"><ReviewBy date={topic.reviewBy} edit={() => edit(byId.get(topic.id) ?? null)} /></td>
        </tr>)}</tbody>
      </table></div> : <div className="analytics-empty"><p>{query ? 'No matching topics' : tab === 'active' ? 'No active topics' : 'No closed topics'}</p></div>}
      <p className="chart-note table-note">{loose} of {project.prompts.length} questions are in no topic. They still count in Visibility and Responses. <button className="text-button" onClick={openPrompts}>Review them in Prompts</button></p>
    </section>
  </>;
}

function TopicDetail({ project, view, open, edit, evidence, openCompetitors, opportunities }: {
  project: Project; view: TopicView; open: (id: string | null) => void; edit: (topic: Topic | null) => void;
  evidence: Evidence; openCompetitors: () => void;
  opportunities: ReactNode;
}) {
  const [tab, setTab] = useState<'results' | 'questions' | 'targets' | 'competitors' | 'checks' | 'opportunities'>('results');
  const { topic, metrics, measurement, presentation, targets } = view;
  const cited = targets.filter(target => target.answersCiting > 0).length;
  const own = presentation.outcomes.find(group => group.kind === 'cited');
  const passed = !!topic.reviewBy && topic.reviewBy < today();
  return <>
    <nav aria-label="Breadcrumb" className="topic-breadcrumb"><button className="text-button" onClick={() => open(null)}><ArrowLeft size={14} />Topics</button><span aria-hidden="true">/</span><span aria-current="page">{topic.name}</span></nav>
    <div className="measurement-scope topic-scope">
      <span>{topic.prompts.length} {topic.prompts.length === 1 ? 'question' : 'questions'}</span>
      <span>{topic.targetUrls.length} target {topic.targetUrls.length === 1 ? 'page' : 'pages'}</span>
      <span>{topic.competitors.length || project.competitors.length} {(topic.competitors.length || project.competitors.length) === 1 ? 'competitor' : 'competitors'}</span>
      <span>Started {shortDate(topic.createdAt)}</span>
      {topic.reviewBy ? <span className={passed ? 'scope-missing' : ''}>Review by {reviewDate(topic.reviewBy)}{passed ? ', passed' : ''}</span> : <button className="text-button" onClick={() => edit(topic)}>Set a review date</button>}
      {topic.status === 'closed' && <span>Closed</span>}
    </div>
    <Tabs label="Topic views" panelId="topic-view" value={tab} onChange={setTab} items={[{ value: 'results', label: 'Results' }, { value: 'questions', label: 'Questions', count: topic.prompts.length }, { value: 'targets', label: 'Target pages', count: targets.length }, { value: 'competitors', label: 'Competitors', count: view.competitors.length }, { value: 'opportunities', label: 'Opportunities' }, { value: 'checks', label: 'Checks', count: view.checks.length }]} />
    <div id="topic-view" role="tabpanel" tabIndex={0} className="topic-view">
      {tab === 'opportunities' ? opportunities : !measurement && tab !== 'questions' && tab !== 'targets' ? <Section><EmptyState icon={Flag} title="Not checked yet">Check this topic to see its mentions, citations and target pages. A check of all your questions counts here too once it has asked every one of this topic's questions.</EmptyState></Section>
        : tab === 'results' ? <>
          <div className="metrics">
            <MetricCard title="Brand mentions" value={percent(metrics.mentionRate)} detail="Answers naming your brand" />
            <MetricCard title="Website citations" value={percent(metrics.citationRate)} detail="Answers linking to your site" tone="citation" />
            <MetricCard title="Target pages cited" value={targets.length ? cited + ' of ' + targets.length : 'Not set'} detail={targets.length ? 'Pages linked at least once' : 'Add the pages this topic should earn'} tone="citation" />
            <MetricCard title="Answers collected" value={String(metrics.completed)} detail={metrics.missing ? `${metrics.completed} of ${metrics.requested} requested. Missing answers are not counted as absent mentions.` : `All ${metrics.requested} requested answers`} />
          </div>
          <VisibilityChart presentation={presentation} />
          <SourcesTable presentation={presentation} collected={metrics.completed} evidence={evidence} projectId={project.id} ownDomain={project.domain} compact />
        </>
        : tab === 'questions' ? <PromptTable rows={presentation.prompts} evidence={evidence} collecting={!!measurement && !completedMeasurement(measurement)} />
        : tab === 'targets' ? <Section title="Target pages" description={measurement ? 'Pages this topic should earn, with the latest website audit.' : 'Pages this topic should earn. Citations appear after its first check.'} action={<button className="secondary" onClick={() => edit(topic)}>Edit pages</button>}>
          {targets.length ? <ul className="topic-targets">{targets.map(target => <li key={target.url}>
            <a href={target.url} target="_blank" rel="noreferrer">{target.url.replace(/^https?:\/\//, '')}<ExternalLink size={12} /></a>
            {measurement ? <button className="text-button" disabled={!target.answersCiting} onClick={() => evidence(target.observationIds, target.url)}>Cited in {target.answersCiting} of {target.answersCollected} answers</button> : <span className="topic-pending">Not checked yet</span>}
            <span className={'badge ' + (!target.page ? 'low' : target.page.status >= 200 && target.page.status < 300 && !target.page.noindex ? 'good' : 'medium')}>{!target.page ? 'Not checked' : target.page.noindex ? 'Excluded by noindex' : 'HTTP ' + target.page.status}</span>
          </li>)}</ul> : <p>No target pages yet. Add the pages you want AI answers to link to.</p>}
        </Section>
        : tab === 'competitors' ? <CitationComparison rows={[{ domain: project.domain, citationRate: metrics.citationRate, answersCiting: own?.count ?? 0, answersCollected: metrics.completed, observationIds: own?.observationIds ?? [] }, ...view.competitors]} projectId={project.id} ownDomain={project.domain} evidence={evidence} openCompetitors={openCompetitors} />
        : <section className="panel analytics-panel"><div className="panel-heading"><h2>Checks that read this topic</h2></div><div className="table-wrap"><table className="analytics-table check-history responsive-evidence-table">
          <caption className="visually-hidden">Checks that asked every question in this topic, newest first</caption>
          <thead><tr><th>Check</th><th>Brand mentions</th><th>Website citations</th><th>Answers</th></tr></thead>
          <tbody>{view.checks.map(check => <tr key={check.jobId} className={check.jobId === measurement?.id ? 'current' : undefined}>
            <td><span className="check-date">{dateTime(check.at)}</span><small>{check.topicCheck ? 'This topic only' : 'All questions'}{check.comparable ? '' : ', different settings'}</small></td>
            <td data-label="Brand mentions"><RateBar value={check.metrics.mentionRate} measure="mention" /></td>
            <td data-label="Website citations"><RateBar value={check.metrics.citationRate} measure="citation" /></td>
            <td data-label="Answers">{check.metrics.completed} / {check.metrics.requested}{check.metrics.missing > 0 && <small className="scope-missing">{check.metrics.missing} missing</small>}</td>
          </tr>)}</tbody>
        </table></div></section>}
    </div>
  </>;
}

/** The lens keeps Visibility's layout and swaps in the topic's evidence, so the two never disagree on how a rate is read. */
export function TopicVisibility({ view, total, evidence, open }: { view: TopicView; total: number; evidence: Evidence; open: () => void }) {
  const { topic, metrics, measurement, presentation } = view;
  return <>
    <div className="measurement-scope topic-scope"><span>Showing {topic.prompts.length} of {total} questions</span><button className="text-button" onClick={open}>Open topic<ArrowRight size={14} /></button></div>
    {!measurement ? <Section><EmptyState icon={Flag} title="Not checked yet">Check these questions to see this topic's mentions and citations. A check of all your questions counts here too.</EmptyState></Section> : <>
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

/** Grouping is a reading aid: a question in two topics appears under both, and editing the list stays in one place. */
export function PromptGroups({ project, topics, prompts, check, edit, create, renderPrompts }: {
  project: Project; topics: TopicSummary[]; prompts: string[];
  check: (id: string) => void; edit: (topic: Topic) => void; create: (prompts: string[]) => void;
  renderPrompts: (prompts: string[]) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const active = project.topics.filter(topic => topic.status === 'active');
  const groups = [...active.map(topic => ({ id: topic.id, name: topic.name, prompts: [...new Set(prompts)].filter(prompt => topic.prompts.includes(prompt)), topic, summary: topics.find(item => item.id === topic.id) })),
    { id: '', name: 'No topic', prompts: [...new Set(prompts)].filter(prompt => !active.some(topic => topic.prompts.includes(prompt))), topic: null, summary: undefined }].filter(group => group.prompts.length);
  return <div className="prompt-groups">{groups.map(group => {
    const open = !collapsed.includes(group.id);
    return <section className="prompt-group-card" key={group.id || 'none'} aria-label={group.name}>
      <div className="prompt-group-head">
        <button type="button" className="prompt-group-toggle" aria-expanded={open} onClick={() => setCollapsed(open ? [...collapsed, group.id] : collapsed.filter(id => id !== group.id))}><ChevronDown size={16} aria-hidden="true" /><strong>{group.name}</strong><span>{group.prompts.length} {group.prompts.length === 1 ? 'question' : 'questions'}</span></button>
        {group.summary && (group.summary.metrics ? <span className="prompt-group-rates"><span>Mentions {percent(group.summary.metrics.mentionRate)}</span><span>Citations {percent(group.summary.metrics.citationRate)}</span></span> : <span className="topic-pending">Not checked yet</span>)}
        <div className="button-row">{group.topic ? <><button className="text-button" onClick={() => check(group.id)}>Check group</button><button className="text-button" onClick={() => edit(group.topic!)}>Edit</button></> : <button className="text-button" onClick={() => create(group.prompts)}>Start a topic with these</button>}</div>
      </div>
      {open && renderPrompts(group.prompts)}
    </section>;
  })}</div>;
}
