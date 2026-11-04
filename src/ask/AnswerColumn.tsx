import { useState } from 'react';
import { ExternalLink, LoaderCircle, Search } from 'lucide-react';
import { markdownHtml } from '../../server/markdown';
import { api } from '../api';
import { targetDomain } from '../finding-groups';
import { usd } from '../format';
import { ProviderIcon, retrievalLabel } from '../provider-ui';
import { SiteIcon } from '../SiteIcon';
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
  const app = row.surface === 'consumer_interface';
  const status = row.state === 'answered' ? { tone: 'completed', text: 'Answered, ' + usd(row.spentUsd) }
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
        <span className={app ? 'ask-chip app' : 'ask-chip'}>{app ? 'In the app, as a person sees it' : 'API answer'}</span>
        {app && <span className="ask-chip">via SurfacedBy</span>}
        {answer && <span className="ask-chip">{answer.model}</span>}
        {answer?.searchQueries?.length ? <span className="ask-chip">{answer.searchQueries.length} {answer.searchQueries.length === 1 ? 'search' : 'searches'}</span> : null}
      </div>
    </header>

    {answer && <>
      <div className="ask-marks">
        <div className={answer.mentioned ? 'ask-mark mentioned' : 'ask-mark missing'}><span>{brand}</span><strong>{answer.mentioned ? 'Mentioned' : 'Not mentioned'}</strong></div>
        <div className={answer.cited ? 'ask-mark cited' : 'ask-mark missing'}><span>{domain}</span><strong>{answer.cited ? 'Cited' : 'Not cited'}</strong></div>
      </div>
      <div className="ask-answer-text" lang={answer.locale} dangerouslySetInnerHTML={{ __html: markdownHtml(answer.answer) }} />
      <details className="ask-fold" open>
        <summary>Sources ({sources.length})</summary>
        {sources.length ? <ul className="ask-sources">{sources.map((citation, index) => <li key={index}>
          <a href={citation.url} target="_blank" rel="noreferrer"><SiteIcon projectId={projectId} domain={targetDomain(citation.url)!} size={16} />
            <span><strong>{targetDomain(citation.url)}</strong>{citation.title && <small>{citation.title}</small>}</span><ExternalLink size={11} /></a>
        </li>)}</ul> : <p className="ask-muted">This answer has no source links.</p>}
      </details>
      <details className="ask-fold">
        <summary>Searches it ran ({answer.searchQueries?.length ?? 0})</summary>
        {answer.searchQueries?.length ? <ul className="ask-searches">{answer.searchQueries.map(query => <li key={query}><Search size={12} /><code>{query}</code></li>)}</ul>
          : <p className="ask-muted">{answer.provider === 'chatgpt' ? 'No searches were reported for this answer.' : 'This engine does not report its searches.'}</p>}
      </details>
      <p className="ask-provenance">{answer.provider === 'chatgpt' ? retrievalLabel(answer) + '. ' : ''}Collected {new Date(answer.observedAt).toLocaleString()}.</p>
    </>}

    {row.state === 'collecting' && <>
      <p className="ask-muted">{row.progress && row.progress !== 'Waiting to start' && row.progress !== 'Starting' ? row.progress + '. ' : ''}The answer appears here when {via(row.provider)} returns it{app ? ', usually within a few minutes' : ''}.</p>
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

    {row.state === 'no_answer' && <p className="ask-note">{row.engine === 'chatgpt' || row.provider === 'chatgpt' ? 'ChatGPT' : via(row.provider)} did not return an answer. It is left out of every count, so it never reads as not mentioned. {row.spentUsd > 0 ? 'Charged ' + usd(row.spentUsd) + '.' : 'Not charged.'}</p>}
    {row.state === 'skipped' && <p className="ask-note">Skipped. {row.spentUsd > 0 ? 'Work already started was charged ' + usd(row.spentUsd) + '.' : 'Nothing was charged.'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </article>;
}
