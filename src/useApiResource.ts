import { useEffect, useState } from 'react';
import { api } from './api';

/** A previous brand or filter response must never replace the current view; refreshes retain already displayed data. */
export function useApiResource<T>(path: string | null, revision: string, delay = 0) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ path: string | null; data: T | null; loading: boolean; error: string }>({ path: null, data: null, loading: false, error: '' });
  useEffect(() => {
    if (!path) return;
    let current = true;
    setState(previous => ({ path, data: previous.path === path ? previous.data : null, loading: true, error: '' }));
    const timer = setTimeout(() => void api<T>(path).then(data => {
      if (current) setState({ path, data, loading: false, error: '' });
    }).catch(error => { if (current) setState(previous => ({ ...previous, loading: false, error: error.message })); }), delay);
    return () => { current = false; clearTimeout(timer); };
  }, [path, revision, attempt, delay]);
  return { data: path && state.path === path ? state.data : null, loading: !!path && (state.path !== path || state.loading), error: path && state.path === path ? state.error : '', retry: () => setAttempt(value => value + 1) };
}
