import { useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import type { PublicObservation as Observation } from '../server/public-results';
import { EmptyState, Section, Toolbar } from './ui/Primitives';
import { reportedSearches } from '../server/prompt-searches';

/** Searches are provider-reported evidence, not inferred from an answer's prose or citations. */
export function PromptSearches({ observations, evidence }: {
  observations: Observation[]; evidence: (ids: string[], label: string) => void;
}) {
  const [query, setQuery] = useState('');
  const rows = reportedSearches(observations);
  const shown = rows.filter(row => (row.query + ' ' + row.prompts.join(' ')).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <Section title="What AI searched for" description="See the searches behind your collected answers and the prompts that led to them.">
    {rows.length ? <>
      <Toolbar actions={<span>{shown.length} {shown.length === 1 ? 'search' : 'searches'}</span>}><label className="search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a search or prompt" aria-label="Find an AI search" /></label></Toolbar>
      <div className="table-wrap"><table className="analytics-table responsive-evidence-table stacked-mobile-table">
        <caption className="visually-hidden">Actual searches reported by AI</caption>
        <thead><tr><th>Search</th><th>Prompt</th><th>Answers</th></tr></thead>
        <tbody>{shown.map(row => <tr key={row.query.toLocaleLowerCase()}>
          <td>{row.query}</td><td data-label="Prompt">{row.prompts.map(prompt => <p key={prompt}>{prompt}</p>)}</td>
          <td data-label="Answers"><button className="text-button" onClick={() => evidence(row.observationIds, row.query)}>{row.observationIds.length} {row.observationIds.length === 1 ? 'answer' : 'answers'}<ArrowRight size={14} /></button></td>
        </tr>)}</tbody>
      </table></div>
      {!shown.length && <p>No searches match this filter.</p>}
    </> : <EmptyState icon={Search} title="No search queries reported yet">Some AI platforms return their search queries alongside answers; others do not. Queries will appear here when a check includes them. An empty list does not mean AI skipped web search.</EmptyState>}
  </Section>;
}
