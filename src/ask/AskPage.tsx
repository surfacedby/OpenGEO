import { useState } from 'react';
import { ArrowLeft, ArrowRight, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../api';
import { relativeTime, shortDate, usd } from '../format';
import { ProviderIcon, platformLabel } from '../provider-ui';
import { Select } from '../Select';
import { Dialog } from '../ui/Dialog';
import { EmptyState, Pagination } from '../ui/Primitives';
import { AnswerColumn } from './AnswerColumn';
import { useAskDetail, useAskList, type AskController, type AskDetail } from './useAsk';
import './ask.css';

const engineLabel = (id?: string) => ({ chatgpt: 'ChatGPT', 'surfacedby-chatgpt': 'ChatGPT app', 'surfacedby-gemini': 'Gemini app', 'dataforseo-chatgpt': 'ChatGPT',
  'dataforseo-gemini': 'Gemini', 'dataforseo-perplexity': 'Perplexity' } as Record<string, string>)[id ?? ''] ?? 'Engine';
const enginePlatform = (id?: string) => id?.endsWith('gemini') ? 'gemini' : id?.endsWith('perplexity') ? 'perplexity' : 'chat_gpt';

/** Ask history: past asks, one ask's answers side by side, and the first-visit suggestions. */
export function AskPage({ projectId, version, askId, setAskId, ask, refresh }: {
  projectId: string; version: string; askId: string | null; setAskId: (id: string | null) => void; ask: AskController; refresh: () => Promise<void> | void;
}) {
  return askId ? <AskResult key={askId} projectId={projectId} askId={askId} setAskId={setAskId} ask={ask} refresh={refresh} />
    : <AskHistory projectId={projectId} version={version} setAskId={setAskId} ask={ask} />;
}

function AskHistory({ projectId, version, setAskId, ask }: { projectId: string; version: string; setAskId: (id: string) => void; ask: AskController }) {
  const { list, error, reload } = useAskList(projectId, version);
  const [query, setQuery] = useState(''), [page, setPage] = useState(0);
  const retry = error && <p className="inline-error" role="alert">{error} <button className="text-button" onClick={reload}>Try again</button></p>;
  if (error && !list) return retry;
  if (!list) return <div className="panel skeleton tall" aria-hidden="true" />;
  if (!list.asks.length) return <EmptyState title="Ask a question the way a person would search it" icon={Search}
    action={<div className="ask-empty-actions">
      <button className="primary" onClick={() => ask.setOpen(true)}><Search size={15} />Ask a question</button>
      {list.suggestions.length > 0 && <div className="ask-suggestions"><span>Or try one of your suggested questions</span>
        {list.suggestions.map(text => <button key={text} type="button" className="secondary" onClick={() => ask.prefill(text)}>{text}</button>)}</div>}
    </div>}>
    Each engine you choose answers once, and you see whether your brand is mentioned and your website is cited. Nothing here changes your rates.
  </EmptyState>;
  const matching = list.asks.filter(row => row.question.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / 20) - 1));
  return <section className="panel ask-history" aria-label="Past asks">
    {retry}
    <div className="panel-heading"><h2>Past questions</h2><label className="search"><Search size={15} /><input aria-label="Find an ask" placeholder="Find a question" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label></div>
    {!matching.length && <EmptyState title="No matching questions" icon={Search} action={<button className="secondary" onClick={() => setQuery('')}>Clear search</button>}>Try another word from your question.</EmptyState>}
    <ul>{matching.slice(currentPage * 20, (currentPage + 1) * 20).map(row => <li key={row.askId}><button type="button" onClick={() => setAskId(row.askId)}>
      <span className="ask-history-question"><strong>{row.question}</strong><small>{relativeTime(row.createdAt)}{row.spentUsd > 0 ? ', ' + usd(row.spentUsd) : ''}</small></span>
      <span className="ask-history-engines">{row.engines.map((engine, index) => <span key={index} className={'ask-dot ' + (engine.cited ? 'cited' : engine.mentioned ? 'mentioned' : engine.state === 'answered' ? 'absent' : 'none')}
        title={engineLabel(engine.engine) + ': ' + (engine.state !== 'answered' ? ({ collecting: 'collecting', paused: 'needs attention', skipped: 'skipped', no_answer: 'no answer collected' }[engine.state]) : engine.cited ? 'website cited' : engine.mentioned ? 'brand mentioned' : 'not mentioned')}>
        <ProviderIcon provider={enginePlatform(engine.engine)} size={14} /></span>)}</span>
      <ArrowRight size={15} />
    </button></li>)}</ul>
    <Pagination page={currentPage} total={matching.length} pageSize={20} label="Past" unit="questions" onChange={setPage} />
  </section>;
}

function AskResult({ projectId, askId, setAskId, ask, refresh }: {
  projectId: string; askId: string; setAskId: (id: string | null) => void; ask: AskController; refresh: () => Promise<void> | void;
}) {
  const { detail, error, reload } = useAskDetail(projectId, askId);
  const [tracking, setTracking] = useState(false), [deleting, setDeleting] = useState(false);
  if (error && !detail) return <p className="inline-error" role="alert">{error}</p>;
  if (!detail) return <div className="panel skeleton tall" aria-hidden="true" />;
  const answered = detail.engines.filter(row => row.state === 'answered').length;
  const collecting = detail.engines.filter(row => row.state === 'collecting').length;
  const needsAttention = detail.engines.length - answered - collecting;
  const trackable = !detail.tracked || detail.topics.some(topic => !topic.tracked);
  const askAgain = (engine: string) => ask.prefill(detail.question, [...new Set([...ask.freeChoice, engine])]);
  return <div className="ask-result">
    <div className="ask-result-heading">
      <div>
        <button type="button" className="text-button" onClick={() => setAskId(null)}><ArrowLeft size={14} />Ask history</button>
        <p className="ask-eyebrow">Asked {relativeTime(detail.createdAt).toLowerCase()}, {detail.locale}, scored for {detail.domain}</p>
        <h2>{detail.question}</h2>
        <p className="ask-muted">{detail.engines.length} {detail.engines.length === 1 ? 'engine' : 'engines'}{detail.limitUsd > 0 ? ', ' + usd(detail.spentUsd) + ' recorded against your ' + usd(detail.limitUsd) + ' limit' : ', using your ChatGPT plan'}. Track this question to include it in future visibility checks. These one-off answers stay separate.</p>
      </div>
      <div className="button-row">
        <button type="button" className="secondary" disabled={!trackable} onClick={() => setTracking(true)}><Plus size={15} />{trackable ? 'Track this question' : 'Tracked'}</button>
        <button type="button" className="icon-button" aria-label="Delete this ask" onClick={() => setDeleting(true)}><Trash2 size={16} /></button>
      </div>
    </div>
    {error && <p className="inline-error" role="alert">{error} Showing the last saved answers. <button className="text-button" onClick={reload}>Try again</button></p>}
    <div className="ask-answers-heading"><h3>Answers</h3><span role="status">{answered} collected{collecting > 0 ? `, ${collecting} collecting` : ''}{needsAttention > 0 ? `, ${needsAttention} without an answer` : ''}</span></div>
    <div className="ask-columns">
      {detail.engines.map(row => <AnswerColumn key={row.jobId} row={row} projectId={projectId} brand={detail.brand} domain={detail.domain} reload={reload} askAgain={askAgain} />)}
    </div>
    {detail.history.length > 0 && <SampleHistory detail={detail} />}
    {tracking && <TrackDialog detail={detail} projectId={projectId} close={() => setTracking(false)} done={async () => { setTracking(false); await reload(); await refresh(); }} />}
    {deleting && <DeleteDialog projectId={projectId} askId={askId} close={() => setDeleting(false)} done={() => { setDeleting(false); setAskId(null); }} />}
  </div>;
}

/** Earlier tracked answers to the same question: one ask is one sample, not a verdict. */
function SampleHistory({ detail }: { detail: AskDetail }) {
  const cited = detail.history.filter(row => row.cited).length;
  return <section className="panel ask-sample" aria-label="Earlier answers to this question">
    <div className="panel-heading"><h3>Earlier answers to this tracked question</h3></div>
    <p className="ask-sample-summary">{cited} of {detail.history.length} {detail.history.length === 1 ? 'check' : 'checks'} cited {detail.domain}. Answers change between asks, so one result is a sample, not a verdict.</p>
    <ul>{detail.history.map((row, index) => <li key={index}>
      <time dateTime={row.observedAt}>{shortDate(row.observedAt)}</time>
      <span><ProviderIcon provider={row.platform} size={14} />{platformLabel(row.platform)}{row.surface === 'consumer_interface' ? ' app' : ''}</span>
      <strong className={row.cited ? 'cited' : row.mentioned ? 'mentioned' : 'absent'}>{row.cited ? 'Cited' : row.mentioned ? 'Mentioned, not cited' : 'Not mentioned'}</strong>
    </li>)}</ul>
  </section>;
}

function TrackDialog({ detail, projectId, close, done }: { detail: AskDetail; projectId: string; close: () => void; done: () => Promise<void> }) {
  const open = detail.topics.filter(topic => !topic.tracked);
  const [topic, setTopic] = useState(open[0]?.id ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Dialog title="Track this question" close={close} dismissible={!busy}>
    <div className="ask-dialog ask-track">
      <p className="ask-track-question">{detail.question}</p>
      {open.length > 0 && <Select label="Add to topic" value={topic} onChange={setTopic}
        options={[...open.map(row => ({ value: row.id, label: row.name })), ...(detail.tracked ? [] : [{ value: '', label: 'No topic, tracked questions only' }])]} />}
      <p className="ask-muted">Visibility checks ask it from now on, and it counts in your rates from the next check. The answers from this ask stay in Ask history and are not added to your rates.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="button-row ask-dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await api('/projects/' + projectId + '/asks/' + detail.askId + '/track', topic ? { topicId: topic } : {}); await done(); }
          catch (failure) { setError((failure as Error).message); setBusy(false); }
        }}>Track question</button>
      </div>
    </div>
  </Dialog>;
}

function DeleteDialog({ projectId, askId, close, done }: { projectId: string; askId: string; close: () => void; done: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Dialog title="Delete this ask?" close={close} dismissible={!busy}>
    <div className="ask-dialog">
      <p>Its answers are removed from Ask history. Paid answers stay charged, and tracked questions are not changed.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="button-row ask-dialog-actions">
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="primary danger-button" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await api('/projects/' + projectId + '/asks/' + askId, undefined, 'DELETE'); done(); }
          catch (failure) { setError((failure as Error).message); setBusy(false); }
        }}><Trash2 size={15} />Delete ask</button>
      </div>
    </div>
  </Dialog>;
}
