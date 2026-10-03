import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { api } from './api';

export function WebsiteIconPreference() {
  const [enabled, setEnabled] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let stopped = false;
    void api<{ enabled: boolean }>('/settings/website-icons').then(value => {
      if (!stopped) { setEnabled(value.enabled); setReady(true); setError(''); }
    }).catch(() => { if (!stopped) setError('The icon preference could not be loaded.'); });
    return () => { stopped = true; };
  }, [retry]);
  async function change(next: boolean) {
    setBusy(true); setError('');
    try {
      const value = await api<{ enabled: boolean }>('/settings/website-icons', { enabled: next }, 'PUT');
      setEnabled(value.enabled);
    } catch {
      try {
        const value = await api<{ enabled: boolean }>('/settings/website-icons');
        setEnabled(value.enabled);
        if (value.enabled !== next) setError('The change was not saved. Try again.');
      } catch { setReady(false); setError('The icon preference could not be confirmed.'); }
    } finally { setBusy(false); }
  }
  return <section className="panel usage-preference" aria-label="Website icons" aria-busy={busy}>
    <div className="panel-heading"><h2><Globe size={17} />Website icons</h2></div>
    <div className="panel-padding"><label className="usage-choice"><input type="checkbox" checked={enabled} disabled={!ready || busy} onChange={event => void change(event.target.checked)} /><span>Use cached icons when a website icon is unavailable</span></label>
      <p className="small">Optional. Google receives the public website name to return its icon. No prompts, content or credentials are sent. Icons load through this installation.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {!ready && error && <button className="secondary" onClick={() => setRetry(value => value + 1)}>Try again</button>}
    </div>
  </section>;
}
