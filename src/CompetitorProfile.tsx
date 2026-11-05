import { useId, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { DiscoveredWebsite, Project } from '../server/contracts';
import type { PublicObservation as Observation } from '../server/public-results';
import { sourceCoverage } from '../server/presentation';
import { AnswerCard, SourceRows } from './DataPresentation';
import { competitorComparison } from './competitor-comparison';
import { SiteIcon } from './SiteIcon';
import { WebsiteIdentity } from './WebsiteIdentity';
import { websiteCategoryLabels } from './website-category';
import { platformLabel, ProviderIcon } from './provider-ui';
import { Dialog } from './ui/Dialog';
import { EmptyState, Tabs, Toolbar } from './ui/Primitives';

export function CompetitorProfile({ site, project, answers, close }: { site: DiscoveredWebsite; project: Project; answers: Observation[]; close: () => void }) {
  const [tab, setTab] = useState<'summary' | 'prompts' | 'platforms' | 'sources'>('summary');
  const [filter, setFilter] = useState<'all' | 'gap' | 'both' | 'own' | 'neither'>('all'), [query, setQuery] = useState('');
  const [sourceAnswers, setSourceAnswers] = useState<string[] | null>(null);
  const panelId = useId();
  const comparison = useMemo(() => competitorComparison(answers, project.domain, site.domain), [answers, project.domain, site.domain]);
  const pages = useMemo(() => sourceCoverage(answers).pages.filter(page => {
    const host = new URL(page.url).hostname.replace(/^www\./, '');
    return host === site.domain || host.endsWith('.' + site.domain);
  }), [answers, site.domain]);
  const shown = comparison.prompts.filter(row => (!sourceAnswers || row.answers.some(answer => sourceAnswers.includes(answer.id))) && row.prompt.toLowerCase().includes(query.trim().toLowerCase()) && (filter === 'all' || (filter === 'gap' ? row.otherOnly : filter === 'own' ? row.ownOnly : filter === 'neither' ? row.neither : row.both) > 0));
  const rate = (count: number, total: number) => total ? Math.round(count / total * 100) + '%' : 'No data';
  return <Dialog title={site.name} variant="drawer" close={close}>
    <div className="competitor-profile">
      <WebsiteIdentity projectId={project.id} domain={site.domain} name={site.name} description={site.reason} />
      <Tabs label="Website comparison" panelId={panelId} value={tab} onChange={setTab} items={[{ value: 'summary', label: 'Summary' }, { value: 'prompts', label: 'Prompts', count: comparison.prompts.length }, { value: 'platforms', label: 'By platform' }, { value: 'sources', label: 'Cited pages', count: pages.length }]} />
      <div id={panelId} role="tabpanel" aria-label={tab}>
        {tab === 'summary' && <>
          {site.category && <details className="competitor-profile-section"><summary>{websiteCategoryLabels[site.category]}: why this category?</summary><p>{site.categoryEvidence?.quote}</p><small>Based on the saved {site.categoryEvidence?.source === 'citation' ? 'citation title' : 'answer'}, not a separate website verification.</small></details>}
          <div className="competitor-versus">{[{ domain: project.domain, name: project.brand, count: comparison.own }, { domain: site.domain, name: site.name, count: comparison.other }].map(item => <section key={item.domain}><SiteIcon projectId={project.id} domain={item.domain} size={32} /><h3>{item.name}</h3><strong>{rate(item.count, comparison.total)}</strong><p>Cited in {item.count} of {comparison.total} {comparison.total === 1 ? 'answer' : 'answers'}</p></section>)}</div>
          <section className="competitor-profile-section"><h3>Where the citations differ</h3><div className="competitor-comparison-facts">{([{ value: 'gap', count: comparison.otherOnly, label: 'Only ' + site.name + ' cited' }, { value: 'own', count: comparison.ownOnly, label: 'Only your website cited' }, { value: 'both', count: comparison.both, label: 'Both websites cited' }, { value: 'neither', count: comparison.neither, label: 'Neither website cited' }] as const).map(item => <button key={item.value} onClick={() => { setSourceAnswers(null); setQuery(''); setFilter(item.value); setTab('prompts'); }}><strong>{item.count}</strong><span>{item.label}</span></button>)}</div></section>
          <p className="chart-note">Based on {comparison.total} saved {comparison.total === 1 ? 'answer' : 'answers'} in the selected check. A citation gap is a reason to inspect the answer, not proof that new content is needed.</p>
        </>}
        {tab === 'prompts' && <>
          {sourceAnswers && <div className="evidence-filter"><span>Prompts linked to the selected cited page</span><button className="text-button" onClick={() => setSourceAnswers(null)}>Show all prompts</button></div>}
          <Toolbar><label className="search"><Search size={16} /><input aria-label="Find a comparison prompt" placeholder="Find a prompt" value={query} onChange={event => setQuery(event.target.value)} /></label></Toolbar>
          <div className="filter-chips" role="group" aria-label="Comparison prompt filters">{([{ value: 'all', label: 'All prompts' }, { value: 'gap', label: 'Only their site cited' }, { value: 'own', label: 'Only your site cited' }, { value: 'both', label: 'Both sites cited' }, { value: 'neither', label: 'Neither site cited' }] as const).map(item => <button key={item.value} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}</div>
          {shown.map(row => <details className="competitor-prompt" key={row.prompt}><summary><span>{row.prompt}</span><small>Your site: {row.own}/{row.total} answers. {site.name}: {row.other}/{row.total}.</small></summary>{row.answers.map(answer => <AnswerCard key={answer.id} observation={answer} />)}</details>)}
          {!shown.length && <EmptyState title="No prompts match this view">Try another filter or clear the search to explore the saved answers.</EmptyState>}
        </>}
        {tab === 'platforms' && <div className="table-wrap"><table className="analytics-table responsive-evidence-table"><caption>Citation coverage by AI platform</caption><thead><tr><th>Platform</th><th>Your website</th><th>{site.name}</th><th>Answers</th></tr></thead><tbody>{comparison.platforms.map(row => <tr key={row.platform}><td><ProviderIcon provider={row.platform} size={18} /> {platformLabel(row.platform)}</td><td data-label="Your website">{rate(row.own, row.total)} ({row.own})</td><td data-label={site.name}>{rate(row.other, row.total)} ({row.other})</td><td data-label="Answers">{row.total}</td></tr>)}</tbody></table></div>}
        {tab === 'sources' && (pages.length ? <SourceRows rows={pages} projectId={project.id} ownDomain={project.domain} collected={comparison.total} mode="pages" evidence={(ids) => { setSourceAnswers(ids); setQuery(''); setFilter('all'); setTab('prompts'); }} /> : <EmptyState title="No cited pages in this check">This website may have been added manually or named without a link. There are no saved page citations to display.</EmptyState>)}
      </div>
    </div>
  </Dialog>;
}
