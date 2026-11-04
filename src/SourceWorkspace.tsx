import { useMemo, useState } from 'react';
import { ArrowRight, FileText, Globe, Link, Search } from 'lucide-react';
import type { Job, Observation } from '../server/contracts';
import type { Presentation, SourceRow } from '../server/presentation';
import { sourceCoverage } from '../server/presentation';
import { SourceRows, isOwnHost } from './DataPresentation';
import { Dialog } from './ui/Dialog';
import { EmptyState, MetricCard, Section, Tabs, Toolbar } from './ui/Primitives';
import { Select } from './Select';
import { WebsiteIdentity } from './WebsiteIdentity';
import { checkWebsiteClassifications, classifiedWebsite, websiteCategoryLabels } from './website-category';
import './sources.css';

type Evidence = (ids: string[], label: string) => void;

/** Citation counts describe saved answers, never estimated traffic, rankings or source quality. */
export function SourceWorkspace({ presentation, observations, projectId, ownDomain, competitors, evidence, startCheck, jobs, measurementId }: {
  presentation: Presentation; observations: Observation[]; projectId: string; ownDomain: string; competitors: string[]; evidence: Evidence; startCheck: () => void; jobs: Job[]; measurementId?: string;
}) {
  const [tab, setTab] = useState<'domains' | 'own' | 'pages'>('domains');
  const [query, setQuery] = useState(''), [relationship, setRelationship] = useState('all');
  const [answerScope, setAnswerScope] = useState('all');
  const [category, setCategory] = useState('all');
  const classifications = useMemo(() => checkWebsiteClassifications(jobs, measurementId), [jobs, measurementId]);
  const categoryFor = (row: SourceRow) => classifiedWebsite(classifications, row.url)?.category;
  const [selected, setSelected] = useState<SourceRow | null>(null);
  const [detailTab, setDetailTab] = useState<'pages' | 'prompts'>('pages');
  const collected = observations.length;
  const ownPages = presentation.pages.filter(row => isOwnHost(new URL(row.url).hostname, ownDomain));
  const ownAnswers = new Set(ownPages.flatMap(row => row.observationIds));
  const scopedAnswers = observations.filter(answer => answerScope === 'all' || ownAnswers.has(answer.id) === (answerScope === 'with'));
  const coverage = useMemo(() => answerScope === 'all' ? presentation : sourceCoverage(scopedAnswers), [answerScope, presentation, observations, ownDomain]);
  const relation = (row: SourceRow) => isOwnHost(new URL(row.url).hostname, ownDomain) ? 'own' : competitors.some(domain => isOwnHost(new URL(row.url).hostname, domain)) ? 'competitor' : 'other';
  const available = tab === 'own' ? ownPages : coverage[tab];
  const shown = available.filter(row => (category === 'all' || (categoryFor(row) ?? 'unknown') === category) && (relationship === 'all' || tab === 'own' || relation(row) === relationship) && (row.label + ' ' + row.url).toLowerCase().includes(query.trim().toLowerCase()));
  const filtered = !!query || relationship !== 'all' || answerScope !== 'all' || category !== 'all';
  const selectedClassification = selected ? classifiedWebsite(classifications, selected.url) : undefined;
  const selectedAnswers = selected ? scopedAnswers.filter(answer => selected.observationIds.includes(answer.id)) : [];
  const selectedPages = selected ? coverage.pages.filter(row => tab === 'domains' ? new URL(row.url).hostname.replace(/^www\./, '') === new URL(selected.url).hostname.replace(/^www\./, '') : row.key === selected.key) : [];
  const prompts = [...new Set(selectedAnswers.map(answer => answer.prompt))];
  const openEvidence: Evidence = (ids, label) => { setSelected(null); evidence(ids, label); };
  return <>
    {collected > 0 && <div className="metrics three">
      <MetricCard title="Cited websites" value={String(presentation.domains.length)} detail={`Across ${collected} collected ${collected === 1 ? 'answer' : 'answers'}`} />
      <MetricCard title="Your cited pages" value={String(ownPages.length)} detail="Unique pages on your website" />
      <MetricCard title="Answers citing you" value={String(ownAnswers.size)} detail={`Out of ${collected} collected ${collected === 1 ? 'answer' : 'answers'}`} tone="citation" />
    </div>}
    <Section className="source-workspace">
      <Tabs label="Citation views" panelId="source-results" value={tab} onChange={value => { setTab(value); setRelationship('all'); setAnswerScope('all'); setCategory('all'); }} items={[
        { value: 'domains', label: 'Sources', icon: Globe, count: presentation.domains.length },
        { value: 'own', label: 'Your pages', icon: FileText, count: ownPages.length },
        { value: 'pages', label: 'All cited pages', icon: Link, count: presentation.pages.length },
      ]} />
      <div id="source-results" role="tabpanel">
        <Toolbar actions={tab !== 'own' ? <Select label="Source relationship" compact searchable={false} value={relationship} onChange={setRelationship} options={[{ value: 'all', label: 'All sources' }, { value: 'own', label: 'Your website' }, { value: 'competitor', label: 'Tracked competitors' }, { value: 'other', label: 'Other sources' }]} /> : undefined}>
          <label className="search"><Search size={16} /><input aria-label="Search sources" placeholder="Find a website or page" value={query} onChange={event => setQuery(event.target.value)} /></label>
          {tab !== 'own' && <Select label="Citation context" compact searchable={false} value={answerScope} onChange={setAnswerScope} options={[{ value: 'all', label: 'All answers' }, { value: 'with', label: 'Citing your website' }, { value: 'without', label: 'Not citing your website' }]} />}
          {tab !== 'own' && <Select label="Source website type" compact searchable={false} value={category} onChange={setCategory} options={[{ value: 'all', label: 'All website types' }, ...Object.entries(websiteCategoryLabels).map(([value, label]) => ({ value, label })), { value: 'unknown', label: 'Not classified' }]} />}
        </Toolbar>
        {shown.length ? <SourceRows rows={shown} collected={scopedAnswers.length} mode={tab === 'domains' ? 'domains' : 'pages'} evidence={openEvidence} projectId={projectId} ownDomain={ownDomain} open={row => { setSelected(row); setDetailTab(tab === 'domains' ? 'pages' : 'prompts'); }} /> : <EmptyState icon={Link} title={filtered ? 'No sources match this filter' : !collected ? 'See where AI finds its answers' : tab === 'own' ? 'Your pages were not linked in these answers' : 'These answers did not include source links'} action={!collected ? <button className="primary" onClick={startCheck}>Check AI visibility<ArrowRight size={15} /></button> : filtered ? <button className="secondary" onClick={() => { setQuery(''); setRelationship('all'); setAnswerScope('all'); setCategory('all'); }}>Clear filters</button> : undefined}>
          {collected ? 'Citation links come from the saved answers. Missing links do not prove that a source was never used.' : 'Run a visibility check to discover the websites and pages cited for your customer questions.'}
        </EmptyState>}
        <p className="chart-note table-note">{scopedAnswers.length} of {collected} collected answers in this view. Answer coverage counts each answer once per source. One answer can cite several sources.</p>
      </div>
    </Section>
    {selected && <Dialog title={selected.label} variant="drawer" close={() => setSelected(null)}>
      <div className="source-reader">
        <WebsiteIdentity projectId={projectId} domain={new URL(selected.url).hostname} url={selected.url} linkLabel={'Open ' + (tab === 'domains' ? 'website' : 'page')} />
        {selectedClassification?.category && <div className="source-classification"><strong>{websiteCategoryLabels[selectedClassification.category]}</strong>{selectedClassification.categoryEvidence && <blockquote>{selectedClassification.categoryEvidence.quote}</blockquote>}<small>Classification from this check's saved analysis.</small></div>}
        <dl className="evidence-summary"><div><dt>Answers citing it</dt><dd>{selectedAnswers.length}</dd></div><div><dt>Customer prompts</dt><dd>{prompts.length}</dd></div><div><dt>Linked pages</dt><dd>{selectedPages.length}</dd></div></dl>
        <Tabs label="Source details" panelId="source-detail-results" value={detailTab} onChange={setDetailTab} items={[{ value: 'pages', label: 'Cited pages', count: selectedPages.length }, { value: 'prompts', label: 'Prompts', count: prompts.length }]} />
        <div id="source-detail-results" role="tabpanel">{detailTab === 'pages' ? <SourceRows rows={selectedPages} mode="pages" collected={scopedAnswers.length} projectId={projectId} ownDomain={ownDomain} evidence={openEvidence} /> : <ul className="source-prompt-list">{prompts.map(prompt => {
          const ids = selectedAnswers.filter(answer => answer.prompt === prompt).map(answer => answer.id);
          return <li key={prompt}><span>{prompt}</span><button className="text-button" onClick={() => openEvidence(ids, prompt)}>{ids.length} {ids.length === 1 ? 'answer' : 'answers'}<ArrowRight size={14} /></button></li>;
        })}</ul>}</div>
        <button className="primary" onClick={() => openEvidence(selected.observationIds, selected.label)}>Read the answers citing this source<ArrowRight size={16} /></button>
      </div>
    </Dialog>}
  </>;
}
