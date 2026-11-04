import { useState } from 'react';
import { ArrowLeft, ArrowRight, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../api';
import { relativeTime, shortDate, usd } from '../format';
import { ProviderIcon, platformLabel } from '../provider-ui';
import { Select } from '../Select';
import { Dialog } from '../ui/Dialog';
import { EmptyState } from '../ui/Primitives';
import { AnswerColumn } from './AnswerColumn';
import { useAskDetail, useAskList, type AskController, type AskDetail } from './useAsk';
import './ask.css';

const engineLabel = (id?: string) => ({ chatgpt: 'ChatGPT', 'surfacedby-chatgpt': 'ChatGPT app', 'surfacedby-gemini': 'Gemini app', 'dataforseo-chatgpt': 'ChatGPT',
  'dataforseo-gemini': 'Gemini', 'dataforseo-perplexity': 'Perplexity' } as Record<string, string>)[id ?? ''] ?? 'Engine';
const enginePlatform = (id?: string) => id?.endsWith('gemini') ? 'gemini' : id?.endsWith('perplexity') ? 'perplexity' : 'chat_gpt';

/** Ask history: past asks, one ask's answers side by side, and the first-visit suggestions. */
export function AskPage({ projectId, brand, domain, askId, setAskId, ask, refresh }: {
  projectId: string; brand: string; domain: string; askId: string | null; setAskId: (id: string | null) => void; ask: AskController; refresh: () => Promise<void> | void;
}) {
  return askId ? <AskResult key={askId} projectId={projectId} brand={brand} domain={domain} askId={askId} setAskId={setAskId} ask={ask} refresh={refresh} />
    : <AskHistory projectId={projectId} setAskId={setAskId} ask={ask} />;
}

function AskHistory({ projectId, setAskId, ask }: { projectId: string; setAskId: (id: string) => void; ask: AskController }) {
  const { list, error } = useAskList(projectId, '');
  if (error) return <p className="inline-error" role="alert">{error}</p>;
  if (!list) return <div className="panel skeleton tall" aria-hidden="true" />;
  if (!list.asks.length) return <EmptyState title="Ask a question the way a person would search it" icon={Search}
    action={<div className="ask-empty-actions">
      <button className="primary" onClick={() => ask.setOpen(true)}><Search size={15} />Ask a question</button>
      {list.suggestions.length > 0 && <div className="ask-suggestions"><span>Or try one of your suggested questions</span>
        {list.suggestions.map(text => <button key={text} type="button" className="secondary" onClick={() => ask.prefill(text)}>{text}</button>)}</div>}
    </div>}>
    Each engine you choose answers once, and you see whether your brand is mentioned and your website is cited. Nothing here changes your rates.
  </EmptyState>;
  return <section className="panel ask-history" aria-label="Past asks">
    <ul>{list.asks.map(row => <li key={row.askId}><button type="button" onClick={() => setAskId(row.askId)}>
      <span className="ask-history-question"><strong>{row.question}</strong><small>{relativeTime(row.createdAt)}{row.spentUsd > 0 ? ', ' + usd(row.spentUsd) : ''}</small></span>
      <span className="ask-history-engines">{row.engines.map((engine, index) => <span key={index} className={'ask-dot ' + (engine.cited ? 'cited' : engine.mentioned ? 'mentioned' : engine.state === 'answered' ? 'absent' : 'none')}
        title={engineLabel(engine.engine) + ': ' + (engine.state !== 'answered' ? 'no answer yet' : engine.cited ? 'website cited' : engine.mentioned ? 'brand mentioned' : 'not mentioned')}>
        <ProviderIcon provider={enginePlatform(engine.engine)} size={14} /></span>)}</span>
      <ArrowRight size={15} />
    </button></li>)}</ul>
  </section>;
}

function AskResult({ projectId, brand, domain, askId, setAskId, ask, refresh }: {
  projectId: string; brand: string; domain: string; askId: string; setAskId: (id: string | null) => void; ask: AskController; refresh: () => Promise<void> | void;
}) {
  const { detail, error, reload } = useAskDetail(projectId, askId);
  const [tracking, setTracking] = useState(false), [deleting, setDeleting] = useState(false);
  if (error && !detail) return <p className="inline-error" role="alert">{error}</p>;
  if (!detail) return <div className="panel skeleton tall" aria-hidden="true" />;
  const answered = detail.engines.filter(row => row.state === 'answered').length;
  const trackable = !detail.tracked || detail.topics.some(topic => !topic.tracked);
  const askAgain = (engine: string) => ask.prefill(detail.question, [...new Set([...ask.freeChoice, engine])]);
  return <div className="ask-result">
    <div className="ask-result-heading">
      <div>
        <button type="button" className="text-button" onClick={() => setAskId(null)}><ArrowLeft size={14} />Ask history</button>
        <p className="ask-eyebrow">Asked {relativeTime(detail.createdAt).toLowerCase()}, {detail.locale}, scored for {detail.domain}</p>
        <h2>{detail.question}</h2>
        <p className="ask-muted">{detail.engines.length} {detail.engines.length === 1 ? 'engine' : 'engines'}, {detail.limitUsd > 0 ? usd(detail.spentUsd) + ' spent of your ' + usd(detail.limitUsd) + ' limit' : 'free'}. These answers stay out of your rates until you track the question.</p>
      </div>
      <div className="button-row">
        <button type="button" className="secondary" disabled={!trackable} onClick={() => setTracking(true)}><Plus size={15} />{trackable ? 'Track this question' : 'Tracked'}</button>
        <button type="button" className="icon-button" aria-label="Delete this ask" onClick={() => setDeleting(true)}><Trash2 size={16} /></button>
      </div>
    </div>
    <div className="ask-answers-heading"><h3>Answers</h3><span>{answered} of {detail.engines.length} in</span></div>
    <div className="ask-columns">
      {detail.engines.map(row => <AnswerColumn key={row.jobId} row={row} projectId={projectId} brand={brand} domain={domain} reload={reload} askAgain={askAgain} />)}
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
  return <Dialog title="Track this question" close={close}>
    <div className="ask-dialog ask-track">
      <p className="ask-track-question">{detail.question}</p>
      {open.length > 0 && <Select label="Add to topic" value={topic} onChange={setTopic}
        options={[...open.map(row => ({ value: row.id, label: row.name })), ...(detail.tracked ? [] : [{ value: '', label: 'No topic, tracked questions only' }])]} />}
      <p className="ask-muted">Visibility checks ask it from now on, and it counts in your rates from the next check. The answers from this ask stay in Ask history and are not added to your rates.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="button-row ask-dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
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
  return <Dialog title="Delete this ask?" close={close}>
    <div className="ask-dialog">
      <p>Its answers are removed from Ask history. Paid answers stay charged, and tracked questions are not changed.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="button-row ask-dialog-actions">
        <button type="button" className="secondary" onClick={close}>Cancel</button>
        <button type="button" className="primary danger-button" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await api('/projects/' + projectId + '/asks/' + askId, undefined, 'DELETE'); done(); }
          catch (failure) { setError((failure as Error).message); setBusy(false); }
        }}><Trash2 size={15} />Delete ask</button>
      </div>
    </div>
  </Dialog>;
}
