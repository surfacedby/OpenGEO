import { useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import { markdownHtml } from '../../server/markdown';
import { api } from '../api';
import { targetDomain } from '../finding-groups';
import { usd } from '../format';
import { ProviderIcon } from '../provider-ui';
import { AnswerSources } from '../AnswerSources';
import { Disclosure } from '../ui/Primitives';
import type { AskEngine } from './useAsk';

const via = (provider?: string) => provider === 'console' ? 'SurfacedBy' : provider === 'dataforseo' ? 'DataForSEO' : 'ChatGPT';
/** Pause reasons that only need a fresh start; anything with an uncertain request needs a review first. */
const reviewFirst = new Set(['interrupted', 'waiting', 'cost_unknown', 'invalid_response', 'approval']);

/** One engine's answer as it arrives. A missing answer is never shown as "not mentioned". */
export function AnswerColumn({ row, projectId, brand, domain, reload, askAgain }: {
  row: AskEngine; projectId: string; brand: string; domain: string; reload: () => Promise<unknown> | void; askAgain: (engine: string) => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(false);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await reload(); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const answer = row.answer;
  const sources = answer?.citations.filter(citation => targetDomain(citation.url)) ?? [];
  const recordedCost = row.costBasis === 'includes_estimates' ? 'Estimated ' + usd(row.spentUsd)
    : row.spentUsd > 0 ? 'Recorded charge ' + usd(row.spentUsd) : 'No charge recorded';
  const status = row.state === 'answered' ? { tone: 'completed', text: row.provider === 'chatgpt' ? 'Answered' : 'Answered, ' + usd(row.spentUsd) + (row.costBasis === 'includes_estimates' ? ' est.' : '') }
    : row.state === 'collecting' ? { tone: 'running', text: 'Collecting' }
    : row.state === 'paused' ? { tone: 'paused', text: 'Paused' }
    : row.state === 'skipped' ? { tone: 'cancelled', text: 'Skipped' }
    : { tone: 'failed', text: 'No answer collected' };
  return <article className={'ask-column state-' + row.state} aria-busy={row.state === 'collecting'}>
    <header>
      <div className="ask-column-title">
        <ProviderIcon provider={row.platform ?? 'chatgpt'} size={18} />
        <h3>{row.label ?? 'Engine'}</h3>
        <span className={'badge ' + status.tone}>{row.state === 'collecting' && <LoaderCircle size={12} className="loading-spin" aria-hidden="true" />}{status.text}</span>
      </div>
      <div className="ask-chips">
        <span className="ask-chip">{via(row.provider)} connection</span>
        {answer?.searchQueries?.length ? <span className="ask-chip">{answer.searchQueries.length} {answer.searchQueries.length === 1 ? 'search' : 'searches'}</span> : null}
      </div>
    </header>

    {answer && <>
      <div className="ask-marks">
        <div className={answer.mentioned ? 'ask-mark mentioned' : 'ask-mark missing'}><span>{brand}</span><strong>{answer.mentioned ? 'Mentioned' : 'Not mentioned'}</strong></div>
        <div className={answer.cited ? 'ask-mark cited' : 'ask-mark missing'}><span>{domain}</span><strong>{answer.cited ? 'Cited' : 'Not cited'}</strong></div>
      </div>
      <div className="ask-answer-text" lang={answer.locale} dangerouslySetInnerHTML={{ __html: markdownHtml(answer.answer) }} />
      <div className="ask-fold"><Disclosure label="Sources" defaultOpen>
        <AnswerSources projectId={projectId} citations={sources} retrieved={answer.retrievedSources} />
      </Disclosure></div>
      <div className="ask-fold"><Disclosure label={answer.searchQueries?.length ? `Reported searches (${answer.searchQueries.length})` : 'Reported searches'}>
        {answer.searchQueries?.length ? <ul className="ask-searches">{answer.searchQueries.map((query, index) => <li key={index}><Search size={12} /><code>{query}</code></li>)}</ul>
          : <p className="ask-muted">{answer.webSearchConfirmed ? 'This answer used web search, but no queries were reported.' : 'No search queries were reported for this answer.'}</p>}
      </Disclosure></div>
      <p className="ask-provenance">Collected {new Date(answer.observedAt).toLocaleString()}.</p>
    </>}

    {row.state === 'collecting' && <>
      <p className="ask-muted">{row.progress && row.progress !== 'Waiting to start' && row.progress !== 'Starting' ? row.progress + '. ' : ''}The answer appears here when {via(row.provider)} returns it.</p>
      <div className="ask-skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
      <button type="button" className="secondary ask-column-action" disabled={busy} onClick={() => void act(() => api('/jobs/' + row.jobId + '/cancel', {}))}>Skip this engine</button>
    </>}

    {row.state === 'paused' && <>
      <p className="ask-note">{row.progress}</p>
      {row.error === 'budget'
        ? <button type="button" className="secondary ask-column-action" onClick={() => askAgain(row.engine!)}>Ask again with a higher limit</button>
        : review
          ? <div className="ask-review"><p>Check {via(row.provider)} usage for this request before resuming, so nothing is bought twice.</p>
              <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api('/jobs/' + row.jobId + '/resume', { reviewed: true }))}>Resume after review</button></div>
          : <button type="button" className="secondary ask-column-action" disabled={busy} onClick={() => reviewFirst.has(row.error ?? '') ? setReview(true) : void act(() => api('/jobs/' + row.jobId + '/resume', {}))}>Resume</button>}
    </>}

    {row.state === 'no_answer' && <p className="ask-note">{via(row.provider)} did not return an answer. A missing answer is not counted as an absent mention. {row.provider === 'chatgpt' ? 'Your ChatGPT plan limits apply.' : recordedCost + '. Check provider usage for any unresolved requests.'}</p>}
    {row.state === 'skipped' && <p className="ask-note">Stopped. {row.provider === 'chatgpt' ? 'Your ChatGPT plan limits apply.' : recordedCost + '. Completed work may still be billable.'}</p>}
    {row.error === 'cancel_remote' && <div className="ask-review"><p>{row.progress}</p><button className="secondary" disabled={busy} onClick={() => void act(() => api('/jobs/' + row.jobId + '/cancel', {}))}>Check cancellation</button></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </article>;
}
