import { useEffect, useRef, type RefObject } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Search, SlidersHorizontal, X } from 'lucide-react';
import { ProviderIcon } from '../provider-ui';
import { usd } from '../format';
import type { AskController } from './useAsk';
import './ask.css';

const engineCount = (count: number) => count + (count === 1 ? ' engine' : ' engines');

/** The header search: type, press Enter, and the free engine answers. Settings hold the paid engines and the limit. */
export function AskBar({ ask, settingsButton }: { ask: AskController; settingsButton: RefObject<HTMLButtonElement> }) {
  const count = ask.choice.length;
  const settings = <button ref={settingsButton} type="button" className={'ask-settings-button' + (ask.open ? ' open' : '')} aria-expanded={ask.open} aria-controls="ask-settings"
    aria-label={'Ask settings' + (ask.catalog ? ': ' + engineCount(count) : '')} onClick={() => ask.setOpen(!ask.open)}>
    <SlidersHorizontal size={15} /><span>{ask.catalog ? engineCount(count) : 'Engines'}</span>{ask.open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
  </button>;
  if (ask.open) return <div className="ask-bar ask-bar-moved"><Search size={16} /><span>The question is in ask settings below</span>{settings}</div>;
  return <form role="search" className="ask-bar" onSubmit={event => { event.preventDefault(); void ask.submit(); }}>
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

/** Settings open under the header over a dimmed page; the page behind is inert until they close. */
export function AskDrawer({ ask, brand, domain, locale, behind, settingsButton }: {
  ask: AskController; brand: string; domain: string; locale: string; behind: RefObject<HTMLElement>; settingsButton: RefObject<HTMLButtonElement>;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const page = behind.current;
    page?.setAttribute('inert', '');
    field.current?.focus();
    const opener = settingsButton.current;
    return () => { page?.removeAttribute('inert'); if (opener?.isConnected) opener.focus(); };
  }, []);
  const close = () => ask.setOpen(false);
  const language = (() => { try { return new Intl.DisplayNames(undefined, { type: 'language' }).of(locale) ?? locale; } catch { return locale; } })();
  const available = ask.catalog?.engines.filter(engine => engine.available) ?? [];
  const missing = ask.catalog?.engines.filter(engine => !engine.available) ?? [];
  const unavailableGroups = [...new Map(missing.map(engine => [engine.provider + '|' + engine.reason, missing.filter(row => row.provider === engine.provider && row.reason === engine.reason)])).values()];
  const providerName = (provider: string) => ({ chatgpt: 'ChatGPT', console: 'SurfacedBy', dataforseo: 'DataForSEO' } as Record<string, string>)[provider] ?? provider;
  const priceText = (id: string) => {
    const engine = ask.catalog!.engines.find(row => row.id === id)!;
    if (engine.price === 'free') return 'Free on your plan';
    const value = ask.priceOf(id);
    return value === null ? (ask.estimating ? 'Pricing...' : 'Priced when the ask starts') : 'est. ' + usd(value);
  };
  const askLabel = 'Ask ' + engineCount(ask.choice.length);
  return <>
    <div className="ask-scrim" aria-hidden="true" onClick={close} />
    <section id="ask-settings" className="ask-drawer" aria-label="Ask settings" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <form onSubmit={event => { event.preventDefault(); void ask.submit(); }}>
        <div className="ask-drawer-heading">
          <h2>Ask settings</h2>
          <span>Asked in {language}. Scored for {brand} and {domain}.</span>
          <button type="button" className="icon-button" aria-label="Close ask settings" onClick={close}><X size={16} /></button>
        </div>
        <label className="ask-question-field">
          <span>Question</span>
          <textarea ref={field} rows={2} maxLength={500} value={ask.question} placeholder="Type a question the way a person would search it"
            onChange={event => ask.setQuestion(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask.submit(); } }} />
        </label>
        <fieldset className="ask-engines">
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
          <div><strong>{ask.totalUsd !== null ? 'Estimated ' + usd(ask.totalUsd) + ' is over your ' + usd(Number(ask.limit) || 0) + ' limit' : 'This limit is too small for the paid engines'}</strong>
            <span>Each paid engine gets an equal share ({usd(ask.fit.shareUsd)}). Nothing has run and nothing was charged.</span>
            <div className="button-row">
              {ask.fit.suggestedLimitUsd !== null && <button type="button" className="secondary" onClick={() => ask.setLimit(ask.fit.suggestedLimitUsd!.toFixed(2))}>Raise limit to {usd(ask.fit.suggestedLimitUsd)}</button>}
              {ask.freeChoice.length > 0 && <button type="button" className="secondary" onClick={() => void ask.submit(ask.freeChoice)}>Ask {ask.catalog!.engines.find(engine => engine.id === ask.freeChoice[0])!.label} only, free</button>}
            </div>
          </div>
        </div>}
        {ask.error && <p className="inline-error" role="alert">{ask.error}</p>}
        <div className="ask-drawer-footer">
          <label className="ask-limit">Spending limit
            <span><span aria-hidden="true">$</span><input inputMode="decimal" value={ask.limit} onChange={event => ask.setLimit(event.target.value)} aria-describedby="ask-estimate" /></span>
          </label>
          <span id="ask-estimate" className="ask-estimate">{ask.paid.length
            ? <>{ask.totalUsd === null ? <>Paid answers are priced when the ask starts and must fit your limit.</> : <>Estimated <strong>{usd(ask.totalUsd)}</strong> for {engineCount(ask.choice.length).replace('engine', 'answer')}.</>} You pay only for answers collected, and a paid engine is never used as a fallback.</>
            : <>Estimated <strong>{usd(0)}</strong>. Paid engines are chosen for each ask.</>}</span>
          <button type="submit" className="primary" disabled={ask.busy || !ask.choice.length || (ask.paid.length > 0 && (!ask.priced || ask.fit.overLimit))}><Search size={15} />{askLabel}</button>
        </div>
      </form>
    </section>
  </>;
}
