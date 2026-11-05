import { type RefObject } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Search, SlidersHorizontal } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { ProviderIcon } from '../provider-ui';
import { usd } from '../format';
import type { AskController } from './useAsk';
import './ask.css';

const engineCount = (count: number) => count + (count === 1 ? ' engine' : ' engines');

/** Paid choices always return to the visible approval drawer before a header submission can spend. */
export function AskBar({ ask, settingsButton }: { ask: AskController; settingsButton: RefObject<HTMLButtonElement> }) {
  const count = ask.choice.length;
  const settings = <button ref={settingsButton} type="button" className={'ask-settings-button' + (ask.open ? ' open' : '')} aria-expanded={ask.open} aria-controls="ask-settings"
    aria-label={'Ask settings' + (ask.catalog ? ': ' + engineCount(count) : '')} onClick={() => ask.setOpen(!ask.open)}>
    <SlidersHorizontal size={15} /><span>{ask.catalog ? engineCount(count) : 'Engines'}</span>{ask.open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
  </button>;
  return <form role="search" className="ask-bar" onSubmit={event => { event.preventDefault(); if (ask.paid.length) ask.setOpen(true); else void ask.submit(); }}>
    <Search size={16} />
    <label htmlFor="ask-question" className="visually-hidden">Ask every engine</label>
    <input id="ask-question" value={ask.question} onFocus={() => void ask.ensureCatalog()} onChange={event => ask.setQuestion(event.target.value)} placeholder="Ask any question" maxLength={500} autoComplete="off" />
    {settings}
    <button type="submit" className="ask-submit" disabled={ask.busy}>Ask</button>
  </form>;
}

/** Opens a search-only button on narrow screens, where the question is typed in ask settings. */
export function AskMobileTrigger({ ask }: { ask: AskController }) {
  return <button type="button" className="icon-button ask-mobile-trigger" aria-label="Ask every engine" aria-expanded={ask.open} aria-controls="ask-settings" onClick={() => ask.setOpen(!ask.open)}><Search size={18} /></button>;
}

/** Engine selection uses the same modal isolation and keyboard behavior as the rest of the app. */
export function AskDrawer({ ask, brand, domain, locale }: {
  ask: AskController; brand: string; domain: string; locale: string;
}) {
  const close = () => ask.setOpen(false);
  const language = (() => { try { return new Intl.DisplayNames(undefined, { type: 'language' }).of(locale) ?? locale; } catch { return locale; } })();
  const available = ask.catalog?.engines.filter(engine => engine.available) ?? [];
  const missing = ask.catalog?.engines.filter(engine => !engine.available) ?? [];
  const unavailableGroups = [...new Map(missing.map(engine => [engine.provider + '|' + engine.reason, missing.filter(row => row.provider === engine.provider && row.reason === engine.reason)])).values()];
  const providerName = (provider: string) => ({ chatgpt: 'ChatGPT', console: 'SurfacedBy', dataforseo: 'DataForSEO' } as Record<string, string>)[provider] ?? provider;
  const priceText = (id: string) => {
    const engine = ask.catalog!.engines.find(row => row.id === id)!;
    if (engine.price === 'free') return 'Uses your ChatGPT plan';
    const value = ask.priceOf(id);
    return value === null ? (ask.estimating ? 'Checking price...' : 'Estimate unavailable') : 'est. ' + usd(value);
  };
  const askLabel = 'Ask ' + engineCount(ask.choice.length);
  return <Dialog title="Ask a question" close={close} variant="drawer" dismissible={!ask.busy}>
    <section id="ask-settings" className="ask-drawer" aria-label="Ask settings" aria-busy={ask.busy}>
      <form onSubmit={event => { event.preventDefault(); void ask.submit(); }}>
        <div className="ask-drawer-heading">
          <p>Compare one answer from each engine. Check whether it mentions <strong>{brand}</strong> or cites {domain}.</p>
          <span>Answer language: {language}. Your tracked visibility results stay separate.</span>
        </div>
        <label className="ask-question-field">
          <span>Question</span>
          <textarea autoFocus disabled={ask.busy} rows={3} maxLength={500} value={ask.question} placeholder="What would your customer ask?"
            onChange={event => ask.setQuestion(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask.submit(); } }} />
        </label>
        <fieldset className="ask-engines" disabled={ask.busy}>
          <legend>Engines</legend>
          {!ask.catalog && <p className="ask-muted" role="status">Checking your connections...</p>}
          <div className="ask-engine-grid">
            {available.map(engine => {
              const on = ask.choice.includes(engine.id);
              return <label key={engine.id} className={'ask-engine' + (on ? ' selected' : '')}>
                <input type="checkbox" checked={on} onChange={() => ask.toggle(engine.id)} />
                <ProviderIcon provider={engine.platform} size={18} />
                <span><strong>{engine.label}</strong><small>{engine.detail}</small><b>{priceText(engine.id)}</b></span>
              </label>;
            })}
            {unavailableGroups.map(group => <div key={group[0].provider + group[0].reason} className="ask-engine unavailable">
              <ProviderIcon provider={group[0].provider} size={18} />
              <span><strong>{group.length > 1 ? providerName(group[0].provider) + ': ' + group.map(row => row.label).join(', ') : group[0].label}</strong>
                <small>{group[0].detail}</small><b>{group[0].reason}</b></span>
            </div>)}
          </div>
        </fieldset>
        {ask.paid.length > 0 && ask.priced && ask.fit.overLimit && <div className="ask-over-limit" role="alert">
          <AlertTriangle size={18} />
            <div><strong>An engine's estimate exceeds its share of your limit</strong>
            <span>Each paid engine gets an equal share ({usd(ask.fit.shareUsd)}). Nothing has run and nothing was charged.</span>
            <div className="button-row">
              {ask.fit.suggestedLimitUsd !== null && <button type="button" className="secondary" onClick={() => ask.setLimit(ask.fit.suggestedLimitUsd!.toFixed(2))}>Raise limit to {usd(ask.fit.suggestedLimitUsd)}</button>}
              {ask.freeChoice.length > 0 && <button type="button" className="secondary" disabled={ask.busy} onClick={() => void ask.submit(ask.freeChoice)}>Use ChatGPT plan only</button>}
            </div>
          </div>
        </div>}
        {ask.error && <p className="inline-error" role="alert">{ask.error}</p>}
        <div className="ask-drawer-footer">
          {ask.paid.length > 0 && <label className="ask-limit">Spending limit
            <span><span aria-hidden="true">$</span><input disabled={ask.busy} inputMode="decimal" value={ask.limit} onChange={event => ask.setLimit(event.target.value)} aria-describedby="ask-estimate" /></span>
          </label>}
          <span id="ask-estimate" className="ask-estimate">{ask.paid.length
            ? <>{ask.totalUsd === null ? <>A complete estimate is unavailable. SurfacedBy checks its quote against each engine's share before starting.</> : <>Estimated <strong>{usd(ask.totalUsd)}</strong>. Each paid engine receives an equal share of the limit.</>} {ask.paid.some(engine => engine.provider === 'dataforseo') && <>DataForSEO uses your saved estimate; its actual charge may differ. </>}Provider charges and refunds apply. No paid fallback.</>
            : <>Uses your ChatGPT plan. Your plan limits apply.</>}</span>
          <button type="submit" className="primary" disabled={ask.busy || !ask.choice.length || (ask.paid.length > 0 && (!ask.priced || ask.fit.overLimit))}><Search size={15} />{ask.busy ? 'Starting...' : askLabel}</button>
        </div>
      </form>
    </section>
  </Dialog>;
}
