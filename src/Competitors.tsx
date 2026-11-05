import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, Check, ExternalLink, Globe, Plus, RefreshCw, Search, Users, X } from 'lucide-react';
import type { DiscoveredWebsite, Job, Observation, Project } from '../server/contracts';
import { completedBrandMeasurement, completedMeasurement, measurementTime } from '../server/portable-results';
import { api } from './api';
import { Select } from './Select';
import { SiteIcon } from './SiteIcon';
import { CompetitorProfile } from './CompetitorProfile';
import { websiteCategoryLabels } from './website-category';
import { platformLabel, ProviderIcon } from './provider-ui';
import './competitors.css';
import { dateTime } from './format';
import { EmptyState } from './ui/Primitives';

function hostname(value: string) {
  try { return new URL(value.includes('://') ? value : 'https://' + value).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

/** Comparison metrics and discovered roles always use the same saved check. */
export function Competitors({ project, jobs, review, run, activity, scope }: {
  project: Project; jobs: Job[]; review: (measurementId: string) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
  activity: (job: Job) => ReactNode;
  /** A topic lens reads only the topic's questions, starting from its latest covering check. */
  scope?: { prompts: string[]; checkId?: string };
}) {
  const checks = jobs.filter(job => ['measure', 'recheck'].includes(job.kind) && (completedMeasurement(job) || ['completed', 'paused', 'failed'].includes(job.status)));
  const preferred = checks.find(job => job.id === scope?.checkId) ?? checks.find(completedBrandMeasurement) ?? checks[0];
  const [checkId, setCheckId] = useState(preferred?.id ?? ''), [savedAnswers, setAnswers] = useState<Observation[]>([]);
  const [platform, setPlatform] = useState('all');
  const platforms = [...new Set(savedAnswers.map(answer => answer.platform))];
  const selectedPlatform = platforms.includes(platform) ? platform : 'all';
  const answers = selectedPlatform === 'all' ? savedAnswers : savedAnswers.filter(answer => answer.platform === selectedPlatform);
  const [loading, setLoading] = useState(!!preferred), [error, setError] = useState(''), [query, setQuery] = useState(''), [tab, setTab] = useState('competitors'), [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [saving, setSaving] = useState(false), [newDomain, setNewDomain] = useState('');
  const [detail, setDetail] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [category, setCategory] = useState('all');
  const check = checks.find(job => job.id === checkId) ?? preferred;
  useEffect(() => { setCheckId(preferred?.id ?? ''); setDetail(null); setSelected([]); setCategory('all'); }, [project.id, scope?.checkId]);
  useEffect(() => {
    let current = true;
    setAnswers([]); setPlatform('all'); setDetail(null); setSelected([]); setError('');
    if (!check) { setLoading(false); return; }
    setLoading(true);
    void api<Observation[]>('/projects/' + project.id + '/checks/' + check.id + '/answers').then(result => {
      if (current) setAnswers(scope ? result.filter(answer => scope.prompts.includes(answer.prompt)) : result);
    }).catch(error => { if (current) setError(error.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [project.id, check?.id, retry, scope?.prompts.join('\n')]);
  const analysis = jobs.find(job => job.kind === 'competitors' && job.measurementJobId === check?.id && job.status === 'completed');
  const pending = jobs.find(job => job.kind === 'competitors' && job.measurementJobId === check?.id && ['queued', 'running', 'paused'].includes(job.status));
  const result = (analysis ?? check)?.result as { competitors?: DiscoveredWebsite[]; references?: DiscoveredWebsite[] } | null;
  const rolesReviewed = Array.isArray(result?.competitors) && Array.isArray(result?.references);
  const cited = new Map<string, Set<string>>();
  for (const answer of answers) for (const citation of answer.citations) {
    const domain = hostname(citation.url);
    if (!domain) continue;
    const ids = cited.get(domain) ?? new Set<string>(); ids.add(answer.id); cited.set(domain, ids);
  }
  const coverage = (domain: string) => [...new Set([...cited.entries()].filter(([host]) => host === domain || host.endsWith('.' + domain)).flatMap(([, ids]) => [...ids]))];
  const knownIds = new Set(answers.map(answer => answer.id));
  const discovered = (result?.competitors ?? []).filter(site => site.role !== 'reference').map(site => ({ ...site, observationIds: site.observationIds.filter(id => knownIds.has(id)) })).filter(site => site.observationIds.length);
  const tracked = new Set(project.competitors.map(hostname));
  const references = new Map((result?.references ?? []).map(site => ({ ...site, observationIds: site.observationIds.filter(id => knownIds.has(id)) })).filter(site => site.observationIds.length).map(site => [hostname(site.domain), site]));
  const unreviewed = new Map<string, DiscoveredWebsite>();
  const alternatives = new Map(discovered.map(site => [hostname(site.domain), site]));
  for (const domain of tracked) if (domain && !alternatives.has(domain) && references.get(domain)?.role !== 'reference')
    alternatives.set(domain, { name: domain, domain, observationIds: [], reason: 'Added to your comparison. Its role has not been confirmed in this check.' });
  const reviewedDomains = [hostname(project.domain), ...discovered.map(site => hostname(site.domain)), ...references.keys()];
  for (const domain of cited.keys()) if (!reviewedDomains.some(known => domain === known || domain.endsWith('.' + known)))
    unreviewed.set(domain, { name: domain, domain, observationIds: coverage(domain), reason: 'Cited in this check. Review its role to distinguish a reference from a competing offering.' });
  const candidates = discovered.filter(site => !tracked.has(hostname(site.domain)));
  const filtered = !!query || category !== 'all';
  const rows = [...(tab === 'competitors' ? alternatives : tab === 'references' ? references : unreviewed).values()].filter(site => (category === 'all' || (site.category ?? 'unclassified') === category) && (site.name + ' ' + site.domain).toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => coverage(b.domain).length - coverage(a.domain).length || a.name.localeCompare(b.name));
  async function save(domains: string[], message: string) {
    const { id, createdAt, ...settings } = project;
    setSaving(true); setError('');
    await run(async () => {
      try { await api('/projects/' + id, { ...settings, competitors: [...new Set(domains)] }, 'PUT'); setSelected([]); setNewDomain(''); setNotice(message); }
      catch (error) { setError((error as Error).message); }
      finally { setSaving(false); }
    });
  }
  const inspected = rows.find(site => site.domain === detail);
  return <div className="competitor-workspace">
    <section className="panel competitor-summary" aria-label="Comparison summary">
      <div className="competitor-metrics" aria-busy={loading}><div><Users size={19} /><strong>{loading ? '...' : rolesReviewed ? discovered.length : 'Not reviewed'}</strong><span>Discovered alternatives</span></div><div><BookOpen size={19} /><strong>{loading ? '...' : rolesReviewed ? references.size : 'Not reviewed'}</strong><span>Cited reference sites</span></div><div><Globe size={19} /><strong>{loading ? '...' : answers.length}</strong><span>Answers in this check</span></div></div>
      <div className="competitor-check"><span>Visibility check</span><Select label="Comparison check" compact searchable={false} value={check?.id ?? ''} onChange={setCheckId} options={checks.map(job => ({ value: job.id, label: dateTime(measurementTime(job)), detail: completedMeasurement(job) ? 'Completed check' : 'Partial check' }))} placeholder="No saved checks" /></div>
    </section>
    {error && <div className="inline-error" role="alert">{error}<button className="secondary compact" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
    {check && !completedMeasurement(check) && <p className="competitor-progress">This check is incomplete. You can explore its saved answers; website role review becomes available when collection finishes.</p>}
    <section className="panel competitor-ranking">
      {!loading && answers.length > 0 && <div className="competitor-own-benchmark"><SiteIcon projectId={project.id} domain={project.domain} size={36} /><div><strong>{project.brand}</strong><span>Your website in this check</span></div><div><strong>{Math.round(coverage(hostname(project.domain)).length / answers.length * 100)}%</strong><span>{coverage(hostname(project.domain)).length} of {answers.length} answers cite your site</span></div></div>}
      <div className="competitor-toolbar"><div className="segmented-control" role="group" aria-label="Website roles"><button aria-pressed={tab === 'competitors'} onClick={() => { setTab('competitors'); setDetail(null); }}><Users size={14} />Competitors <span>{alternatives.size}</span></button><button aria-pressed={tab === 'references'} onClick={() => { setTab('references'); setDetail(null); }}><BookOpen size={14} />References <span>{references.size}</span></button><button aria-pressed={tab === 'unreviewed'} onClick={() => { setTab('unreviewed'); setDetail(null); }}><Search size={14} />To review <span>{unreviewed.size}</span></button></div>
        <label className="search"><Search size={15} /><input aria-label="Search comparison websites" placeholder="Find a website" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <Select label="Comparison platform" compact searchable={false} value={selectedPlatform} onChange={value => { setPlatform(value); setDetail(null); setSelected([]); }} options={[{ value: 'all', label: 'All platforms' }, ...platforms.map(value => ({ value, label: platformLabel(value), icon: <ProviderIcon provider={value} size={16} /> }))]} />
        <Select label="Website type" compact searchable={false} value={category} onChange={setCategory} options={[{ value: 'all', label: 'All website types' }, ...Object.entries(websiteCategoryLabels).map(([value, label]) => ({ value, label })), { value: 'unclassified', label: 'Not classified' }]} />
        <button className="secondary compact" disabled={loading || !answers.length || !check || !completedMeasurement(check) || !!pending} onClick={() => check && review(check.id)}><RefreshCw size={14} />Review website roles</button></div>
      {pending && activity(pending)}
      {tab === 'references' && <div className="competitor-table-intro"><p>These websites supply cited information. Citation frequency alone does not establish authority or competition.</p></div>}
      {tab === 'unreviewed' && <div className="competitor-table-intro"><p>These websites were cited, but their role is unconfirmed. Review website roles to identify competing offerings and references.</p></div>}
      {tab === 'competitors' && candidates.length > 0 && <div className="competitor-discovery-heading"><h3>Discover competitors</h3><button className="primary compact" disabled={saving || !selected.length} onClick={() => void save([...project.competitors, ...selected], 'Competitors added to your comparison.')}><Plus size={14} />Add selected competitors</button></div>}
      <div className="competitor-ranking-head"><span>Website</span><span>Why it appears</span><span>Cited answers</span><span /></div>
      {loading ? <div className="analytics-empty" role="status">Loading saved answers...</div> : rows.length ? rows.map(site => {
        const ids = coverage(site.domain), rate = answers.length ? ids.length / answers.length * 100 : null;
        return <div className="competitor-ranking-row" key={site.domain}>
          <div className="competitor-identity">{tab === 'competitors' && !tracked.has(site.domain) && <input type="checkbox" aria-label={'Follow ' + site.name} checked={selected.includes(site.domain)} disabled={saving} onChange={event => setSelected(current => event.target.checked ? [...current, site.domain] : current.filter(value => value !== site.domain))} />}<SiteIcon projectId={project.id} domain={site.domain} size={34} /><div><strong>{site.name}</strong><a href={'https://' + site.domain} target="_blank" rel="noreferrer">{site.domain}<ExternalLink size={11} /></a>{site.role === 'both' && <small>Competing offering and reference</small>}</div></div>
          <div className="competitor-reason">{site.category && <small>{websiteCategoryLabels[site.category]}</small>}<p>{site.reason ?? 'Named and cited as an alternative in your saved answers.'}</p></div>
          <div className="competitor-rate"><strong>{rate === null ? 'No data' : rate.toFixed(0) + '%'}</strong><span>{ids.length} / {answers.length} answers</span><div><i style={{ width: (rate ?? 0) + '%' }} /></div></div>
          <button className="secondary compact" disabled={!ids.length && !site.observationIds.length} aria-label={'View answers for ' + site.name} onClick={() => setDetail(detail === site.domain ? null : site.domain)}><ArrowRight size={16} /></button>
        </div>;
      }) : <EmptyState icon={Users} title={filtered ? 'No matching websites' : answers.length ? tab === 'competitors' ? 'No competing offerings confirmed yet' : tab === 'references' ? 'No cited references in this check' : 'All cited websites have a reviewed role' : 'Start with a visibility check'} action={filtered ? <button className="secondary" onClick={() => { setQuery(''); setCategory('all'); }}>Clear filters</button> : undefined}>{filtered ? 'Try another website type or name, or clear the filters to see this group.' : answers.length ? tab === 'unreviewed' ? 'Explore competitors and references to read the supporting answers.' : 'Review website roles using your connected analysis provider, or add a competitor you already know below.' : 'Your saved answers will show which websites appear for your customers\' questions. You can add known competitors to your comparison list below.'}</EmptyState>}
      <p className="competitor-footnote">Citation rate counts answers linking to a website, not recommendations or market share. All values use {selectedPlatform === 'all' ? 'all platforms' : platformLabel(selectedPlatform)} in the selected check. Website role review covers the complete check.</p>
    </section>
    {inspected && <CompetitorProfile key={inspected.domain} site={inspected} project={project} answers={answers} close={() => setDetail(null)} />}
    <section className="panel competitor-manage"><div className="panel-heading"><h2>Your comparison list</h2><span>{project.competitors.length} websites</span></div><div className="tracked-competitors">{project.competitors.map(value => <div key={value}><SiteIcon projectId={project.id} domain={hostname(value)} size={25} /><span>{hostname(value)}</span><Check size={14} /><button className="text-button" aria-label={'Remove ' + hostname(value) + ' from comparison'} disabled={saving} onClick={() => void save(project.competitors.filter(item => item !== value), 'Comparison updated.')}><X size={14} /></button></div>)}</div><form onSubmit={event => { event.preventDefault(); if (newDomain.trim()) void save([...project.competitors, newDomain.trim()], 'Comparison website added.'); }}><label><span>Add a competitor website</span><input aria-label="Add a competitor website" placeholder="example.com" value={newDomain} onChange={event => setNewDomain(event.target.value)} disabled={saving} /></label><button className="secondary" disabled={saving || !newDomain.trim()}><Plus size={15} />Add website</button></form>{notice && <p className="save-notice" role="status">{notice}</p>}</section>
  </div>;
}
