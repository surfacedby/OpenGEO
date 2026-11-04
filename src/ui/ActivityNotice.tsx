import { ArrowRight, LoaderCircle, PauseCircle } from 'lucide-react';

/** Persistent, compact progress stays visible when a user leaves the screen that started work. */
export function ActivityNotice({ title, detail, paused, open }: { title: string; detail: string; paused: boolean; open: () => void }) {
  const Icon = paused ? PauseCircle : LoaderCircle;
  return <aside className="activity-notice" aria-label="Current activity">
    <Icon size={17} className={paused ? '' : 'loading-spin'} aria-hidden="true" />
    <div><strong>{title}</strong><span role="status">{detail}</span></div>
    <button className="text-button" onClick={open}>{paused ? 'Review check' : 'View progress'}<ArrowRight size={14} /></button>
  </aside>;
}
