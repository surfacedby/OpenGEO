import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/** A previous brand or filter response must never replace the current view; refreshes retain already displayed data. */
export function useApiResource<T>(path: string | null, revision: string, delay = 0) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ path: string | null; data: T | null; loading: boolean; error: string }>({ path: null, data: null, loading: false, error: '' });
  const latestRevision = useRef(revision), refresh = useRef<() => void>(() => {});
  latestRevision.current = revision;
  useEffect(() => {
    if (!path) return;
    let current = true, running = false, queued = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      if (!current) return;
      if (running) { queued = true; return; }
      clearTimeout(timer);
      timer = setTimeout(load, delay);
    };
    const load = () => {
      running = true; queued = false;
      const startedRevision = latestRevision.current;
      setState(previous => ({ path, data: previous.path === path ? previous.data : null, loading: true, error: '' }));
      void api<T>(path).then(data => {
        if (current) setState({ path, data, loading: false, error: '' });
      }).catch(error => { if (current) setState(previous => ({ ...previous, loading: false, error: error.message })); })
        .finally(() => {
          running = false;
          // A slower read must finish and become visible; coalesce writes into one following refresh.
          if (current && (queued || startedRevision !== latestRevision.current)) schedule();
        });
    };
    refresh.current = schedule;
    schedule();
    return () => { current = false; clearTimeout(timer); refresh.current = () => {}; };
  }, [path, attempt, delay]);
  useEffect(() => { refresh.current(); }, [revision]);
  return { data: path && state.path === path ? state.data : null, loading: !!path && (state.path !== path || state.loading), error: path && state.path === path ? state.error : '', retry: () => setAttempt(value => value + 1) };
}
