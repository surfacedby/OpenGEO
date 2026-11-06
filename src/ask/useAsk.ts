import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { engineCatalog, estimateAsk, listAsks, readAsk } from '../../server/asks';
import { askFit } from '../../server/ask-scope';
import { api } from '../api';
import { useApiResource } from '../useApiResource';

export type Catalog = Awaited<ReturnType<typeof engineCatalog>>;
export type Engine = Catalog['engines'][number];
export type Estimate = Awaited<ReturnType<typeof estimateAsk>>;
export type AskDetail = ReturnType<typeof readAsk>;
export type AskEngine = AskDetail['engines'][number];
export type AskList = ReturnType<typeof listAsks>;

/** One ask in progress: the question, the chosen engines and the limit, shared by the header and the settings drawer. */
export function useAskController(projectId: string | undefined, onAsked: (askId: string) => void, connectionRevision = '') {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [question, setQuestion] = useState('');
  const [choice, setChoice] = useState<string[]>([]);
  const [limit, setLimit] = useState('1.00');
  const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState<{ key: string; value: Estimate } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [priceRevision, setPriceRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const freeOf = (list: Catalog | null) => list?.engines.filter(engine => engine.available && engine.price === 'free').map(engine => engine.id) ?? [];
  const freeChoice = useMemo(() => freeOf(catalog), [catalog]);
  const scope = projectId + '|' + connectionRevision;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const submitting = useRef(false);
  const preselected = useRef<{ scope: string; engines: string[] } | null>(null);
  const attempts = useRef(new Map<string, string>());
  const cache = useRef<{ scope: string; value: Catalog; expires: number } | null>(null);
  const loading = useRef<{ scope: string; promise: Promise<Catalog | null> } | null>(null);
  // Recheck on interaction after a short window, and immediately after a connection or brand change.
  const ensureCatalog = useCallback(() => {
    if (!projectId) return Promise.resolve(null);
    if (cache.current?.scope === scope && cache.current.expires > Date.now()) return Promise.resolve(cache.current.value);
    if (loading.current?.scope === scope) return loading.current.promise;
    const promise = api<Catalog>('/projects/' + projectId + '/asks/engines')
      .then(next => {
        if (currentScope.current !== scope) return null;
        const first = cache.current?.scope !== scope;
        cache.current = { scope, value: next, expires: Date.now() + 30000 };
        setCatalog(next);
        if (first) {
          setLimit(String(next.defaultLimitUsd));
          setChoice(preselected.current?.scope === scope
            ? preselected.current.engines.filter(id => next.engines.some(engine => engine.id === id && engine.available)) : freeOf(next));
          preselected.current = null;
        }
        else setChoice(previous => previous.filter(id => next.engines.some(engine => engine.id === id && engine.available)));
        return next;
      })
      .catch(failure => { if (currentScope.current === scope) setError((failure as Error).message); return null; })
      .finally(() => { if (loading.current?.promise === promise) loading.current = null; });
    loading.current = { scope, promise };
    return promise;
  }, [projectId, scope]);
  useEffect(() => { cache.current = null; setCatalog(null); setChoice([]); setOpen(false); setEstimate(null); setError(''); }, [scope]);
  useEffect(() => { setQuestion(''); }, [projectId]);
  useEffect(() => { if (open) void ensureCatalog(); }, [open, ensureCatalog]);

  const chosen = catalog?.engines.filter(engine => choice.includes(engine.id)) ?? [];
  const paid = chosen.filter(engine => engine.price !== 'free');
  const trimmed = question.trim();
  const estimateKey = scope + '|' + trimmed + '|' + paid.map(engine => engine.id).join(',');
  useEffect(() => {
    let current = true;
    setEstimating(false);
    if (!projectId || !paid.length || trimmed.length < 3) return;
    if (estimate?.key === estimateKey && (!estimate.value.expiresAt || Date.parse(estimate.value.expiresAt) > Date.now())) return;
    const timer = setTimeout(() => {
      setEstimating(true);
      api<Estimate>('/projects/' + projectId + '/asks/estimate', { question: trimmed, engines: paid.map(engine => engine.id) })
        .then(value => { if (current) setEstimate({ key: estimateKey, value }); })
        .catch(failure => { if (current) setError((failure as Error).message); })
        .finally(() => { if (current) setEstimating(false); });
    }, 600);
    return () => { current = false; clearTimeout(timer); };
  }, [estimateKey, priceRevision]);

  useEffect(() => {
    if (!estimate?.value.expiresAt || estimate.key !== estimateKey) return;
    const timer = setTimeout(() => setPriceRevision(value => value + 1), Math.max(0, Date.parse(estimate.value.expiresAt) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [estimate, estimateKey]);

  const current = estimate?.key === estimateKey && (!estimate.value.expiresAt || Date.parse(estimate.value.expiresAt) > Date.now()) ? estimate.value : null;
  const priceOf = (id: string) => {
    const engine = catalog?.engines.find(row => row.id === id);
    if (engine?.price === 'free') return 0;
    return current?.engines.find(row => row.id === id)?.estimateUsd ?? null;
  };
  const limitUsd = Number(limit);
  const fit = askFit(Number.isFinite(limitUsd) ? limitUsd : 0, paid.map(engine => priceOf(engine.id)));
  const totalUsd = paid.length ? (current ? current.totalUsd : null) : 0;
  const blockedQuote = current?.engines.find(row => 'blocked' in row && row.blocked);
  const menuPrices = current?.engines.filter(row => 'publishedPrice' in row && row.publishedPrice).map(row => row.id) ?? [];
  const quoteNotice = blockedQuote && 'note' in blockedQuote ? blockedQuote.note : undefined;
  const priced = !paid.length || (!!current && !estimating && !blockedQuote);

  async function submit(requested?: string[]) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      const initialSelection = preselected.current?.scope === scope ? preselected.current.engines : null;
      const loaded = await ensureCatalog();
      // Header submissions default to the plan connection; an explicit retry retains its selected engine.
      const engines = requested ?? (catalog ? choice : initialSelection ?? freeOf(loaded));
      const picked = loaded?.engines.filter(engine => engines.includes(engine.id)) ?? [];
      const paying = picked.some(engine => engine.price !== 'free');
      if (!projectId || !loaded || currentScope.current !== scope) return;
      if (trimmed.length < 3) { setError('Type a question of at least 3 characters.'); return; }
      if (!picked.length) { setOpen(true); setError('Choose at least one engine.'); return; }
      if (paying && (!catalog || !priced || fit.overLimit)) { setOpen(true); return; }
      const input = { question: trimmed, engines: [...engines].sort(), maxCostUsd: paying ? limitUsd : 0 };
      const fingerprint = projectId + '|' + JSON.stringify(input);
      const requestKey = attempts.current.get(fingerprint) ?? crypto.randomUUID();
      attempts.current.set(fingerprint, requestKey);
      const result = await api<{ askId: string }>('/projects/' + projectId + '/asks',
        input, 'POST', requestKey);
      attempts.current.delete(fingerprint);
      if (currentScope.current !== scope) return;
      // The engine choice resets to the free engine after every ask, so Enter in the header never spends money.
      setOpen(false); setChoice(freeOf(loaded)); setEstimate(null); setQuestion('');
      onAsked(result.askId);
    } catch (failure) { if (currentScope.current === scope) { setError((failure as Error).message); setOpen(true); } }
    finally { submitting.current = false; setBusy(false); }
  }
  return {
    catalog, ensureCatalog, question, setQuestion, choice, setChoice, limit, setLimit, open, setOpen, error, setError, busy,
    chosen, paid, priceOf, fit, totalUsd, estimating, priced, quoteNotice, menuPrices, freeChoice, submit, estimateExpiresAt: current?.expiresAt ?? null,
    refreshPrices: () => { setEstimate(null); setError(''); setPriceRevision(value => value + 1); },
    toggle: (id: string) => setChoice(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]),
    /** Opens settings with a question and engines filled in, for example to ask again with a higher limit. */
    prefill: (text: string, engines?: string[]) => {
      setQuestion(text);
      if (engines) { preselected.current = { scope, engines }; setChoice(engines); }
      setOpen(true);
    },
  };
}
export type AskController = ReturnType<typeof useAskController>;

/** A collecting ask refreshes on the workspace's rhythm; a settled one stops polling. */
export function useAskDetail(projectId: string, askId: string | null) {
  const [revision, setRevision] = useState(0);
  const result = useApiResource<AskDetail>(askId ? '/projects/' + projectId + '/asks/' + askId : null, String(revision));
  const collecting = !result.data || result.data.engines.some(row => row.state === 'collecting');
  useEffect(() => {
    if (!askId || !collecting) return;
    const timer = setInterval(() => setRevision(value => value + 1), 3000);
    return () => clearInterval(timer);
  }, [projectId, askId, collecting]);
  return { detail: result.data, error: result.error, reload: () => setRevision(value => value + 1) };
}

export function useAskList(projectId: string, version: string) {
  const result = useApiResource<AskList>('/projects/' + projectId + '/asks', version);
  return { list: result.data, error: result.error, reload: result.retry };
}
