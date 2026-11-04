import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Section } from './ui/Primitives';

export function DesktopUpdates({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const bridge = window.opengeoDesktop;
    if (!bridge) return;
    let live = true, receivedEvent = false;
    const unsubscribe = bridge.onUpdate(next => { receivedEvent = true; if (live) setState(next); });
    // A delayed initial snapshot must not replace newer download progress or a ready installer.
    void bridge.updates().then(next => { if (live && !receivedEvent) setState(next); }).catch(() => { if (live && !receivedEvent) setError('Update settings could not load. Reopen the app to try again.'); });
    return () => { live = false; unsubscribe(); };
  }, []);
  if (!window.opengeoDesktop) return null;
  if (compact && !(['available', 'downloading', 'ready', 'installing'].includes(state?.status ?? '') || (state?.status === 'error' && state.availableVersion))) return null;
  async function command(action: 'check' | 'download' | 'install' | 'preference' | 'cancel', value?: boolean) {
    setError('');
    try { setState(await window.opengeoDesktop!.updates(action, value)); }
    catch { setError('The update request could not complete. Please try again.'); }
  }
  const content = <>
    {state?.status === 'unavailable' ? <p>Automatic installation is not available for this build. Your projects stay on this computer when you replace the app with a newer release.</p> : <>
      <p role="status">{state?.status === 'ready' ? state.manualInstall ? `Version ${state.availableVersion} is ready. Open the installer, quit OpenGEO, then drag the new app into Applications. Your projects stay on this device.` : `Version ${state.availableVersion} is ready. Restart when you are ready to install it.` : state?.status === 'downloading' ? `Downloading version ${state.availableVersion}... ${Math.round(state.progress)}%` : state?.status === 'available' ? `Version ${state.availableVersion} is available.` : state?.status === 'checking' ? 'Checking for updates...' : state?.status === 'current' ? 'You have the latest version.' : 'OpenGEO checks for updates automatically. You choose when to install.'}</p>
      {state?.status === 'downloading' && <><progress max={100} value={state.progress} aria-label="Update download progress" /><button className="secondary" onClick={() => void command('cancel')}>Stop download</button></>}
      {state?.status === 'installing' && <p role="status">Opening the installer. OpenGEO will close when installation starts.</p>}
      {!compact && state && <label className="checkbox-field"><input type="checkbox" checked={state.autoDownload} onChange={event => void command('preference', event.target.checked)} />Download updates automatically. Turn this off on mobile data.</label>}
      <div className="button-row">{state?.status === 'ready' ? <button className="primary" onClick={() => void command('install')}><RefreshCw size={16} />{state.manualInstall ? 'Open downloaded installer' : 'Install and restart'}</button> : state?.status === 'available' ? <button className="primary" onClick={() => void command('download')}><Download size={16} />Download update</button> : <button className="secondary" disabled={!state || ['checking', 'downloading', 'installing'].includes(state.status)} onClick={() => void command('check')}><RefreshCw size={16} />Check for updates</button>}</div>
      {state?.message && <p role="alert">{state.message}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </>;
  return compact ? <div className="update-notice" aria-label="App updates">{content}</div> : <Section title="App updates" className="desktop-updates">{content}</Section>;
}
