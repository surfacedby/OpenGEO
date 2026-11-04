import { useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import type { PageSummary } from '../server/contracts';
import { shortDate } from './format';
import { EmptyState } from './ui/Primitives';
import { targetLabel } from './finding-groups';

/** Page checks remain observations, not a synthetic aggregate readiness score. */
export function AuditPages({ pages }: { pages: PageSummary[] }) {
  const [query, setQuery] = useState(''), [unavailable, setUnavailable] = useState(false);
  const shown = pages.filter(page => (!unavailable || page.status >= 400) && (page.title + ' ' + page.url).toLowerCase().includes(query.trim().toLowerCase()));
  return <>
    <div className="analytics-toolbar"><div className="filter-chips" role="group" aria-label="Filter audited pages"><button aria-pressed={!unavailable} onClick={() => setUnavailable(false)}>All pages <span>{pages.length}</span></button><button aria-pressed={unavailable} onClick={() => setUnavailable(true)}>Unavailable <span>{pages.filter(page => page.status >= 400).length}</span></button></div><label className="search"><Search size={15} /><input aria-label="Search audited pages" placeholder="Find a page" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    {shown.length ? <div className="table-wrap"><table className="audit-pages-table"><thead><tr><th>Page</th><th>Access</th><th>Main heading</th><th>Structured data</th><th>Last checked</th></tr></thead><tbody>{shown.map(page => <tr key={page.id}>
      <td className="page-cell"><a href={page.url} target="_blank" rel="noreferrer">{page.title || targetLabel(page.url)} <ArrowUpRight size={12} /></a><small title={page.url}>{page.title ? targetLabel(page.url) : 'No page title'}</small></td>
      <td data-label="Access"><span className={'badge ' + (page.status < 400 ? 'good' : 'high')}>{page.status < 400 ? 'Available' : 'Unavailable'}</span><small>HTTP {page.status}</small></td>
      <td data-label="Main heading">{page.h1.length ? <details><summary>{page.h1.length === 1 ? 'Present' : page.h1.length + ' headings'}</summary><ul>{page.h1.map((heading, index) => <li key={index}>{heading}</li>)}</ul></details> : 'Missing'}</td>
      <td data-label="Structured data">{page.schemaTypes.length ? <details><summary>{page.schemaTypes.length} {page.schemaTypes.length === 1 ? 'type' : 'types'}</summary><ul>{page.schemaTypes.map((type, index) => <li key={index}>{type}</li>)}</ul></details> : 'Not found'}</td>
      <td data-label="Last checked">{shortDate(page.fetchedAt)}</td>
    </tr>)}</tbody></table></div> : <EmptyState title={query ? 'No matching pages' : 'No unavailable pages in this audit'} action={<button className="secondary" onClick={() => { setQuery(''); setUnavailable(false); }}>Show all pages</button>}>{query ? 'Search by title or address, or reset your filters.' : 'All inspected pages returned an available response. Review their headings and structured data for content improvements.'}</EmptyState>}
  </>;
}
