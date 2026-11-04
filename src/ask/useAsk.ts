import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { engineCatalog, estimateAsk, listAsks, readAsk } from '../../server/asks';
import { askFit } from '../../server/ask-scope';
import { api } from '../api';

export type Catalog = Awaited<ReturnType<typeof engineCatalog>>;
export type Engine = Catalog['engines'][number];
export type Estimate = Awaited<ReturnType<typeof estimateAsk>>;
export type AskDetail = ReturnType<typeof readAsk>;
export type AskEngine = AskDetail['engines'][number];
export type AskList = ReturnType<typeof listAsks>;

/** One ask in progress: the question, the chosen engines and the limit, shared by the header and the settings drawer. */
export function useAskController(projectId: string | undefined, onAsked: (askId: string) => void) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [question, setQuestion] = useState('');
  const [choice, setChoice] = useState<string[]>([]);
  const [limit, setLimit] = useState('1.00');
  const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState<{ key: string; value: Estimate } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const freeOf = (list: Catalog | null) => list?.engines.filter(engine => engine.available && engine.price === 'free').map(engine => engine.id) ?? [];
  const freeChoice = useMemo(() => freeOf(catalog), [catalog]);
  const loading = useRef<Promise<Catalog | null> | null>(null);
  // Connections are checked on first use, as other screens do, rather than on every page load.
  const ensureCatalog = useCallback(() => {
    if (!projectId) return Promise.resolve(null);
    if (catalog) return Promise.resolve(catalog);
    loading.current ??= api<Catalog>('/projects/' + projectId + '/asks/engines')
      .then(next => { setCatalog(next); setLimit(next.defaultLimitUsd.toFixed(2)); setChoice(freeOf(next)); return next; })
      .catch(failure => { setError((failure as Error).message); return null; })
      .finally(() => { loading.current = null; });
    return loading.current;
  }, [projectId, catalog]);
  useEffect(() => { setCatalog(null); setChoice([]); setOpen(false); setEstimate(null); setError(''); loading.current = null; }, [projectId]);
  useEffect(() => { if (open) void ensureCatalog(); }, [open, ensureCatalog]);

  const chosen = catalog?.engines.filter(engine => choice.includes(engine.id)) ?? [];
  const paid = chosen.filter(engine => engine.price !== 'free');
  const trimmed = question.trim();
  const estimateKey = projectId + '|' + trimmed + '|' + paid.map(engine => engine.id).join(',');
  useEffect(() => {
    if (!projectId || !paid.length || trimmed.length < 3) return;
    if (estimate?.key === estimateKey) return;
    const timer = setTimeout(() => {
      setEstimating(true);
      api<Estimate>('/projects/' + projectId + '/asks/estimate', { question: trimmed, engines: paid.map(engine => engine.id) })
        .then(value => setEstimate({ key: estimateKey, value }))
        .catch(failure => setError((failure as Error).message))
        .finally(() => setEstimating(false));
    }, 600);
    return () => clearTimeout(timer);
  }, [estimateKey]);

  const current = estimate?.key === estimateKey ? estimate.value : null;
  const priceOf = (id: string) => {
    const engine = catalog?.engines.find(row => row.id === id);
    if (engine?.price === 'free') return 0;
    return current?.engines.find(row => row.id === id)?.estimateUsd ?? null;
  };
  const limitUsd = Number(limit);
  const fit = askFit(Number.isFinite(limitUsd) ? limitUsd : 0, paid.map(engine => priceOf(engine.id)));
  const totalUsd = paid.length ? (current ? current.totalUsd : null) : 0;
  const priced = !paid.length || (!!current && !estimating);

  async function submit(requested?: string[]) {
    const loaded = catalog ?? await ensureCatalog();
    // Before the first load the choice is still empty; it starts as the free engine, like after every ask.
    const engines = requested ?? (catalog ? choice : freeOf(loaded));
    const picked = loaded?.engines.filter(engine => engines.includes(engine.id)) ?? [];
    const paying = picked.some(engine => engine.price !== 'free');
    if (!projectId || !loaded) return;
    if (trimmed.length < 3) { setError('Type a question of at least 3 characters.'); return; }
    if (!picked.length) { setOpen(true); setError('Choose at least one engine.'); return; }
    if (paying && (!priced || fit.overLimit)) { setOpen(true); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ askId: string }>('/projects/' + projectId + '/asks',
        { question: trimmed, engines, maxCostUsd: paying ? limitUsd : 0 }, 'POST', crypto.randomUUID());
      // The engine choice resets to the free engine after every ask, so Enter in the header never spends money.
      setOpen(false); setChoice(freeOf(loaded)); setEstimate(null); setQuestion('');
      onAsked(result.askId);
    } catch (failure) { setError((failure as Error).message); setOpen(true); }
    finally { setBusy(false); }
  }
  return {
    catalog, ensureCatalog, question, setQuestion, choice, setChoice, limit, setLimit, open, setOpen, error, setError, busy,
    chosen, paid, priceOf, fit, totalUsd, estimating, priced, freeChoice, submit,
    toggle: (id: string) => setChoice(list => list.includes(id) ? list.filter(item => item !== id) : [...list, id]),
    /** Opens settings with a question and engines filled in, for example to ask again with a higher limit. */
    prefill: (text: string, engines?: string[]) => { setQuestion(text); if (engines) setChoice(engines); setOpen(true); },
  };
}
export type AskController = ReturnType<typeof useAskController>;

/** A collecting ask refreshes on the workspace's rhythm; a settled one stops polling. */
export function useAskDetail(projectId: string, askId: string | null) {
  const [detail, setDetail] = useState<AskDetail | null>(null), [error, setError] = useState('');
  const settled = useRef(false);
  const load = useCallback(() => {
    if (!askId) return Promise.resolve();
    return api<AskDetail>('/projects/' + projectId + '/asks/' + askId)
      .then(next => { setDetail(next); setError(''); settled.current = next.engines.every(row => !['collecting'].includes(row.state)); })
      .catch(failure => setError((failure as Error).message));
  }, [projectId, askId]);
  useEffect(() => {
    setDetail(null); settled.current = false;
    if (!askId) return;
    void load();
    const timer = setInterval(() => { if (!settled.current) void load(); }, 3000);
    return () => clearInterval(timer);
  }, [load, askId]);
  return { detail: detail?.askId === askId ? detail : null, error, reload: load };
}

export function useAskList(projectId: string, version: string) {
  const [list, setList] = useState<AskList | null>(null), [error, setError] = useState('');
  const load = useCallback(() => api<AskList>('/projects/' + projectId + '/asks')
    .then(next => { setList(next); setError(''); })
    .catch(failure => setError((failure as Error).message)), [projectId]);
  useEffect(() => { setList(null); void load(); }, [load, version]);
  return { list, error, reload: load };
}
