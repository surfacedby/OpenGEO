import { useMemo, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, FileText, Search } from 'lucide-react';
import type { Finding, PageSummary } from '../server/contracts';
import { pageAvailable, pageFolder, pageSearchExclusion, pageType, pageTypeLabels } from '../server/page-classification';
import { shortDate } from './format';
import { EmptyState, Pagination, Tabs, Toolbar } from './ui/Primitives';
import { Dialog } from './ui/Dialog';
import { Select } from './Select';
import { targetLabel } from './finding-groups';
import { Findings } from './Findings';
import './pages.css';

/** Group real page evidence and findings without inventing readiness or traffic scores. */
export function AuditPages({ pages, findings = [], projectId, run }: { pages: PageSummary[]; findings?: Finding[]; projectId: string; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [query, setQuery] = useState(''), [tab, setTab] = useState<'all' | 'attention' | 'unavailable' | 'excluded'>('all');
  const [grouping, setGrouping] = useState('type'), [selected, setSelected] = useState<string | null>(null);
  const findingsByUrl = useMemo(() => {
    const grouped = new Map<string, Finding[]>();
    for (const finding of findings) {
      if (!finding.targetUrl || finding.status === 'done') continue;
      const matches = grouped.get(finding.targetUrl) ?? [];
      matches.push(finding); grouped.set(finding.targetUrl, matches);
    }
    return grouped;
  }, [findings]);
  const issues = (page: PageSummary) => findingsByUrl.get(page.url) ?? [];
  const needsAttention = (page: PageSummary) => !pageSearchExclusion(page) && (!pageAvailable(page) || issues(page).length > 0);
  const shown = pages.filter(page => (tab === 'all' || (tab === 'attention' ? needsAttention(page) : tab === 'unavailable' ? !pageAvailable(page) : !!pageSearchExclusion(page))) && (page.title + ' ' + page.url).toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map<string, PageSummary[]>();
  for (const page of shown) {
    const label = grouping === 'folder' ? pageFolder(page) : grouping === 'type' ? pageTypeLabels[pageType(page)] : 'Pages';
    const rows = groups.get(label) ?? [];
    rows.push(page); groups.set(label, rows);
  }
  const opened = pages.find(page => page.id === selected);
  return <>
    <div className="pages-navigation"><Tabs label="Website pages" panelId="website-pages" value={tab} onChange={setTab} items={[
      { value: 'all', label: 'All pages', count: pages.length },
      { value: 'attention', label: 'Needs attention', count: pages.filter(needsAttention).length },
      { value: 'unavailable', label: 'Unavailable', count: pages.filter(page => !pageAvailable(page)).length },
      { value: 'excluded', label: 'Not for search', count: pages.filter(page => pageSearchExclusion(page)).length },
    ]} /></div>
    <div id="website-pages" role="tabpanel" className="pages-hub">
      <Toolbar actions={<Select label="Group pages" compact searchable={false} value={grouping} onChange={setGrouping} options={[{ value: 'type', label: 'Group by page type' }, { value: 'folder', label: 'Group by folder' }, { value: 'none', label: 'No grouping' }]} />}>
        <label className="search"><Search size={16} /><input aria-label="Search audited pages" placeholder="Find a page" value={query} onChange={event => setQuery(event.target.value)} /></label>
      </Toolbar>
      {tab === 'excluded' && <p className="pages-note">These pages ask search engines to skip them or require sign-in. Keep private pages private; change an exclusion only when you intend the page to be public.</p>}
      {[...groups].map(([label, rows]) => <PageGroup key={[grouping, tab, query, label].join(':')} label={label} rows={rows} issues={issues} open={page => setSelected(page.id)} />)}
      {!shown.length && <EmptyState icon={FileText} title={query ? 'No matching pages' : tab === 'attention' ? 'No open issues on these public pages' : tab === 'unavailable' ? 'No unavailable pages in this audit' : tab === 'excluded' ? 'No search exclusions found' : 'Your pages will appear here'} action={query ? <button className="secondary" onClick={() => setQuery('')}>Clear search</button> : tab !== 'all' ? <button className="secondary" onClick={() => setTab('all')}>Show all pages</button> : undefined}>
        {query ? 'Try a different page title or address.' : 'This view reflects the pages checked on your device. It does not measure visits or prove that AI can read every page.'}
      </EmptyState>}
    </div>
    {opened && <Dialog title={opened.title || targetLabel(opened.url)} variant="drawer" close={() => setSelected(null)}>
      <div className="page-reader">
        <a className="page-reader-url" href={opened.url} target="_blank" rel="noreferrer">{opened.url}<ArrowUpRight size={15} /></a>
        <div className="page-reader-facts"><span>{pageTypeLabels[pageType(opened)]}</span><span>HTTP {opened.status}</span><span>Checked {shortDate(opened.fetchedAt)}</span></div>
        {pageSearchExclusion(opened) && <p className="pages-note">{pageSearchExclusion(opened)}. This page is not included in the public-page attention list.</p>}
        {!pageSearchExclusion(opened) && <section><h3>Page improvements</h3><Findings findings={findings.filter(finding => finding.targetUrl === opened.url)} projectId={projectId} run={run} mode="audit" emptyTitle="No open page improvements" emptyMessage="No unfinished findings from this saved check. Search rankings and AI citations are measured separately." /></section>}
        <section><h3>Page details</h3><dl className="page-detail-list">
          <dt>Page title</dt><dd>{opened.title || 'Not found'}</dd>
          <dt>Search description</dt><dd>{opened.description || 'Not found'}</dd>
          <dt>Main headings</dt><dd>{opened.h1.length ? <ul>{opened.h1.map((heading, index) => <li key={index}>{heading}</li>)}</ul> : 'Not found'}</dd>
          <dt>Preferred address</dt><dd>{opened.canonical || 'No canonical declared'}</dd>
          <dt>Structured data</dt><dd>{opened.schemaTypes.length ? opened.schemaTypes.join(', ') : 'No Schema.org types identified'}{opened.structuredDataLimitations?.map(note => <p className="small" key={note}>{note}</p>)}</dd>
        </dl></section>
      </div>
    </Dialog>}
  </>;
}

function PageGroup({ label, rows, issues, open }: { label: string; rows: PageSummary[]; issues: (page: PageSummary) => Finding[]; open: (page: PageSummary) => void }) {
  const [expanded, setExpanded] = useState(true), [pageIndex, setPageIndex] = useState(0);
  const currentPage = Math.min(pageIndex, Math.max(0, Math.ceil(rows.length / 10) - 1));
  const shown = rows.slice(currentPage * 10, (currentPage + 1) * 10);
  return <section className="page-group">
    <button className="page-group-heading" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<strong>{label}</strong><span>{rows.length} {rows.length === 1 ? 'page' : 'pages'}</span></button>
    {expanded && <><div className="table-wrap"><table className="analytics-table responsive-evidence-table page-inventory-table"><caption className="visually-hidden">{label}</caption>
      <thead><tr><th>Page</th><th>Access</th><th>Open checks</th><th>Last checked</th></tr></thead>
      <tbody>{shown.map(page => <tr key={page.id}>
        <td><button className="page-title-button" onClick={() => open(page)}>{page.title || targetLabel(page.url)}</button><small className="page-address" title={page.url}>{targetLabel(page.url)}</small></td>
        <td data-label="Access"><span className={'badge ' + (pageSearchExclusion(page) ? 'low' : pageAvailable(page) ? 'good' : 'high')}>{pageSearchExclusion(page) ? 'Not for search' : pageAvailable(page) ? 'Available' : 'Unavailable'}</span></td>
        <td data-label="Open checks"><button className="text-button" onClick={() => open(page)}>{pageSearchExclusion(page) ? 'View details' : issues(page).length ? `${issues(page).length} to review` : 'View details'}<ChevronRight size={14} /></button></td>
        <td data-label="Last checked">{shortDate(page.fetchedAt)}</td>
      </tr>)}</tbody>
    </table></div><Pagination page={currentPage} total={rows.length} pageSize={10} label={label} unit="pages" onChange={setPageIndex} /></>}
  </section>;
}
