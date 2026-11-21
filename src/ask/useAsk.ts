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

type AskReceipt = { askId: string | null; deleted: boolean };
const pendingAskKey = (projectId: string) => 'opengeo.pending-asks.' + projectId;

/** Keep only request identifiers and input digests across a reload of this tab. */
function savedAskAttempts(projectId: string): Map<string, string> {
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(pendingAskKey(projectId)) ?? '[]');
    return new Map(Array.isArray(entries) ? entries.filter(entry => Array.isArray(entry)
      && typeof entry[0] === 'string' && /^[a-f0-9]{64}$/.test(entry[0])
      && typeof entry[1] === 'string' && /^[a-f0-9-]{36}$/.test(entry[1])) : []);
  } catch { return new Map(); }
}

function saveAskAttempt(projectId: string, fingerprint: string, key?: string) {
  try {
    const saved = savedAskAttempts(projectId);
    if (key) saved.set(fingerprint, key); else saved.delete(fingerprint);
    if (saved.size) sessionStorage.setItem(pendingAskKey(projectId), JSON.stringify([...saved]));
    else sessionStorage.removeItem(pendingAskKey(projectId));
  } catch { /* In-memory retries still work if the browser denies storage. */ }
}

const readAskReceipt = (projectId: string, key: string) =>
  api<AskReceipt>('/projects/' + projectId + '/asks/receipts/' + encodeURIComponent(key));

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
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const freeOf = (list: Catalog | null) => list?.engines.filter(engine => engine.available && engine.price === 'free').map(engine => engine.id) ?? [];
  const freeChoice = useMemo(() => freeOf(catalog), [catalog]);
  const scope = projectId + '|' + connectionRevision;
  const refreshingPrices = refreshingScope === scope;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const onAskedRef = useRef(onAsked);
  onAskedRef.current = onAsked;
  const editingAsk = useRef(false);
  editingAsk.current = open || !!question.trim();
  const submitting = useRef(false);
  const preselected = useRef<{ scope: string; engines: string[] } | null>(null);
  const attempts = useRef(new Map<string, string>());
  const cache = useRef<{ scope: string; value: Catalog; expires: number } | null>(null);
  const loading = useRef<{ scope: string; promise: Promise<Catalog | null> } | null>(null);
  // Recheck on interaction after a short window, and immediately after a connection or brand change.
  const ensureCatalog = useCallback((refresh = false) => {
    if (!projectId) return Promise.resolve(null);
    if (!refresh && cache.current?.scope === scope && cache.current.expires > Date.now()) return Promise.resolve(cache.current.value);
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
  useEffect(() => { cache.current = null; setCatalog(null); setChoice([]); setOpen(false); setEstimate(null); setRefreshingScope(null); setError(''); }, [scope]);
  useEffect(() => { setQuestion(''); }, [projectId]);
  useEffect(() => { if (open) void ensureCatalog(); }, [open, ensureCatalog]);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void (async () => {
      for (const [fingerprint, key] of [...savedAskAttempts(projectId)].reverse()) {
        const receipt = await readAskReceipt(projectId, key).catch(() => null);
        if (!active || currentScope.current !== scope || submitting.current || editingAsk.current) return;
        if (receipt?.askId || receipt?.deleted) {
          attempts.current.delete(fingerprint);
          saveAskAttempt(projectId, fingerprint);
        }
        if (receipt?.askId) {
          preselected.current = null;
          setOpen(false); setQuestion(''); setEstimate(null);
          onAskedRef.current(receipt.askId);
          return;
        }
      }
    })();
    return () => { active = false; };
  }, [projectId, scope]);

  const chosen = catalog?.engines.filter(engine => choice.includes(engine.id)) ?? [];
  const paid = chosen.filter(engine => engine.price !== 'free');
  const trimmed = question.trim();
  const estimateKey = scope + '|' + trimmed + '|' + paid.map(engine => engine.id).join(',');
  useEffect(() => {
    let current = true;
    setEstimating(false);
    if (!projectId || refreshingPrices || !paid.length || trimmed.length < 3) return;
    if (estimate?.key === estimateKey && (!estimate.value.expiresAt || Date.parse(estimate.value.expiresAt) > Date.now())) return;
    const timer = setTimeout(() => {
      setEstimating(true);
      api<Estimate>('/projects/' + projectId + '/asks/estimate', { question: trimmed, engines: paid.map(engine => engine.id) })
        .then(value => { if (current) setEstimate({ key: estimateKey, value }); })
        .catch(failure => { if (current) setError((failure as Error).message); })
        .finally(() => { if (current) setEstimating(false); });
    }, 600);
    return () => { current = false; clearTimeout(timer); };
  }, [estimateKey, priceRevision, refreshingPrices]);

  useEffect(() => {
    if (!estimate?.value.expiresAt || estimate.key !== estimateKey) return;
    const timer = setTimeout(() => setPriceRevision(value => value + 1), Math.max(0, Date.parse(estimate.value.expiresAt) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [estimate, estimateKey]);

  const current = !refreshingPrices && estimate?.key === estimateKey && (!estimate.value.expiresAt || Date.parse(estimate.value.expiresAt) > Date.now()) ? estimate.value : null;
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

  async function refreshPrices() {
    if (!projectId || refreshingPrices || submitting.current) return;
    setRefreshingScope(scope);
    setError('');
    // Refresh the engine list first so a withdrawn engine cannot request another quote.
    await ensureCatalog(true);
    if (currentScope.current !== scope) return;
    setEstimate(null);
    setRefreshingScope(null);
    setPriceRevision(value => value + 1);
  }

  async function submit(requested?: string[]) {
    if (submitting.current || refreshingPrices) return;
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
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(projectId + '|' + JSON.stringify(input)));
      if (currentScope.current !== scope) return;
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const requestKey = attempts.current.get(fingerprint) ?? savedAskAttempts(projectId).get(fingerprint) ?? crypto.randomUUID();
      attempts.current.set(fingerprint, requestKey);
      saveAskAttempt(projectId, fingerprint, requestKey);
      const result = await api<{ askId: string }>('/projects/' + projectId + '/asks',
        input, 'POST', requestKey);
      attempts.current.delete(fingerprint);
      saveAskAttempt(projectId, fingerprint);
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
    refreshPrices, refreshingPrices,
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
