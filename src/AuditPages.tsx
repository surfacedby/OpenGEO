import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronRight, FileText, Search } from 'lucide-react';
import type { Finding, PageSummary } from '../server/contracts';
import { pageAvailable, pageSearchExclusion, pageType, pageTypeLabels } from '../server/page-classification';
import type { PageCatalog } from '../server/page-catalog';
import { useApiResource as usePageRequest } from './useApiResource';
import { shortDate } from './format';
import { EmptyState, Pagination, Tabs, Toolbar } from './ui/Primitives';
import { Dialog } from './ui/Dialog';
import { Select } from './Select';
import { targetLabel } from './finding-groups';
import { Findings } from './Findings';
import './pages.css';

/** Group real page evidence and findings without inventing readiness or traffic scores. */
export function AuditPages({ checkId, revision, projectId, run }: { checkId: string; revision: string; projectId: string; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [query, setQuery] = useState(''), [tab, setTab] = useState<'all' | 'attention' | 'unavailable' | 'excluded'>('all');
  const [grouping, setGrouping] = useState('type'), [selected, setSelected] = useState<PageSummary | null>(null), [groupPage, setGroupPage] = useState(0);
  const base = `/projects/${projectId}/checks/${checkId}/pages`;
  const params = new URLSearchParams({ query, tab, grouping, groupOffset: String(groupPage * 20) });
  const request = usePageRequest<ReturnType<PageCatalog['list']>>(base + '?' + params, revision, 150);
  const detail = usePageRequest<{ page: PageSummary; findings: Finding[] }>(selected ? base + '/' + selected.id : null, revision);
  const opened = detail.data?.page ?? selected;
  const counts = request.data?.counts;
  useEffect(() => {
    if (request.data) setGroupPage(current => Math.min(current, Math.max(0, Math.ceil(request.data!.groupCount / 20) - 1)));
  }, [request.data?.groupCount]);
  const changeTab = (value: typeof tab) => { setTab(value); setGroupPage(0); };
  return <>
    <div className="pages-navigation"><Tabs label="Website pages" panelId="website-pages" value={tab} onChange={changeTab} items={[
      { value: 'all', label: 'All pages', count: counts?.allPages },
      { value: 'attention', label: 'Needs attention', count: counts?.attention },
      { value: 'unavailable', label: 'Unavailable', count: counts?.unavailable },
      { value: 'excluded', label: 'Not for search', count: counts?.excluded },
    ]} /></div>
    <div id="website-pages" role="tabpanel" className="pages-hub">
      <Toolbar actions={<Select label="Group pages" compact searchable={false} value={grouping} onChange={value => { setGrouping(value); setGroupPage(0); }} options={[{ value: 'type', label: 'Group by page type' }, { value: 'folder', label: 'Group by folder' }, { value: 'none', label: 'No grouping' }]} />}>
        <label className="search"><Search size={16} /><input aria-label="Search audited pages" placeholder="Find a page" maxLength={300} value={query} onChange={event => { setQuery(event.target.value); setGroupPage(0); }} /></label>
      </Toolbar>
      {tab === 'excluded' && <p className="pages-note">These pages ask search engines to skip them or require sign-in. Keep private pages private; change an exclusion only when you intend the page to be public.</p>}
      <PageRequestStatus request={request} />
      {request.data?.groups.map(group => <PageGroup key={[grouping, tab, query, group.name].join(':')} label={grouping === 'type' ? pageTypeLabels[group.name as keyof typeof pageTypeLabels] : group.name} group={group} path={base + '?' + new URLSearchParams({ query, tab, grouping, group: group.name })} revision={revision} open={setSelected} />)}
      {request.data && <Pagination page={groupPage} total={request.data.groupCount} pageSize={20} label="Page groups" unit="groups" onChange={setGroupPage} />}
      {request.data && !request.data.total && <EmptyState icon={FileText} title={query ? 'No matching pages' : tab === 'attention' ? 'No open issues on these public pages' : tab === 'unavailable' ? 'No unavailable pages in this audit' : tab === 'excluded' ? 'No search exclusions found' : 'Your pages will appear here'} action={query ? <button className="secondary" onClick={() => setQuery('')}>Clear search</button> : tab !== 'all' ? <button className="secondary" onClick={() => changeTab('all')}>Show all pages</button> : undefined}>
        {query ? 'Try a different page title or address.' : 'This view reflects the pages checked on your device. It does not measure visits or prove that AI can read every page.'}
      </EmptyState>}
    </div>
    {opened && <Dialog title={opened.title || targetLabel(opened.url)} variant="drawer" close={() => setSelected(null)}>
      <div className="page-reader">
        <a className="page-reader-url" href={opened.url} target="_blank" rel="noreferrer">{opened.url}<ArrowUpRight size={15} /></a>
        <div className="page-reader-facts"><span>{pageTypeLabels[pageType(opened)]}</span><span>HTTP {opened.status}</span><span>Checked {shortDate(opened.fetchedAt)}</span></div>
        {pageSearchExclusion(opened) && <p className="pages-note">{pageSearchExclusion(opened)}. This page is not included in the public-page attention list.</p>}
        {!pageSearchExclusion(opened) && <section><h3>Page improvements</h3><PageRequestStatus request={detail} />{detail.data && <Findings findings={detail.data.findings} projectId={projectId} run={run} mode="audit" emptyTitle="No open page improvements" emptyMessage="No unfinished findings from this saved check. Search rankings and AI citations are measured separately." />}</section>}
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

function PageGroup({ label, group, path, revision, open }: { label: string; group: ReturnType<PageCatalog['list']>['groups'][number]; path: string; revision: string; open: (page: PageSummary) => void }) {
  const [expanded, setExpanded] = useState(true), [pageIndex, setPageIndex] = useState(0);
  const currentPage = Math.min(pageIndex, Math.max(0, Math.ceil(group.count / 10) - 1));
  const request = usePageRequest<ReturnType<PageCatalog['list']>>(expanded && currentPage ? path + '&offset=' + currentPage * 10 : null, revision);
  const shown = currentPage ? request.data?.rows ?? [] : group.rows;
  return <section className="page-group">
    <button className="page-group-heading" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<strong>{label}</strong><span>{group.count} {group.count === 1 ? 'page' : 'pages'}</span></button>
    {expanded && <><PageRequestStatus request={request} /><div className="table-wrap"><table className="analytics-table responsive-evidence-table page-inventory-table"><caption className="visually-hidden">{label}</caption>
      <thead><tr><th>Page</th><th>Access</th><th>Open checks</th><th>Last checked</th></tr></thead>
      <tbody>{shown.map(({ page, openChecks }) => <tr key={page.id}>
        <td><button className="page-title-button" onClick={() => open(page)}>{page.title || targetLabel(page.url)}</button><small className="page-address" title={page.url}>{targetLabel(page.url)}</small></td>
        <td data-label="Access"><span className={'badge ' + (pageSearchExclusion(page) ? 'low' : pageAvailable(page) ? 'good' : 'high')}>{pageSearchExclusion(page) ? 'Not for search' : pageAvailable(page) ? 'Available' : 'Unavailable'}</span></td>
        <td data-label="Open checks"><button className="text-button" onClick={() => open(page)}>{pageSearchExclusion(page) ? 'View details' : openChecks ? `${openChecks} to review` : 'View details'}<ChevronRight size={14} /></button></td>
        <td data-label="Last checked">{shortDate(page.fetchedAt)}</td>
      </tr>)}</tbody>
    </table></div><Pagination page={currentPage} total={group.count} pageSize={10} label={label} unit="pages" onChange={setPageIndex} /></>}
  </section>;
}

function PageRequestStatus({ request }: { request: { loading: boolean; error: string; retry: () => void } }) {
  if (request.error) return <p role="alert">Could not load these pages. <button className="text-button" onClick={request.retry}>Try again</button></p>;
  return request.loading ? <p className="small" role="status">Loading page details...</p> : null;
}
