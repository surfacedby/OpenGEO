import { useState } from 'react';
import { Globe, Play, Square } from 'lucide-react';
import type { Job } from '../server/contracts';
import { api } from './api';
import { Section } from './ui/Primitives';
import { Select } from './Select';

/** Discovery controls act on the durable crawl, so stopping never discards saved pages. */
export function WebsiteDiscovery({ projectId, jobs, run }: { projectId: string; jobs: Job[]; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [limit, setLimit] = useState('10000');
  const discoveries = jobs.filter(job => job.projectId === projectId && job.kind === 'audit' && job.background);
  const discovery = discoveries.find(job => ['queued', 'running', 'paused'].includes(job.status)) ?? discoveries[0];
  const active = discovery && ['queued', 'running'].includes(discovery.status);
  const resumable = discovery && ['paused', 'cancelled'].includes(discovery.status);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    try { await run(action); } finally { setBusy(false); }
  }
  return <Section title="Automatic page discovery" description="Explore your website gradually while OpenGEO is open. Pages appear in your results as they are checked.">
    <div className="website-discovery-controls">
      <div className="website-discovery-description"><Globe size={20} /><div><strong>{active ? 'Discovering pages in the background' : resumable ? 'Discovery is stopped' : discovery?.status === 'failed' ? 'Discovery could not finish' : discovery ? 'Discovery finished' : 'Discover more of your website'}</strong><p>{discovery ? discovery.progress : 'Follows public links and sitemaps, respects robots.txt and makes room for your AI checks.'}</p></div></div>
      {!active && !resumable && <Select label="Page discovery limit" compact searchable={false} value={limit} onChange={setLimit} options={[{ value: '1000', label: 'Up to 1,000 pages' }, { value: '10000', label: 'Up to 10,000 pages' }, { value: '100000', label: 'Up to 100,000 pages' }]} />}
      {active ? <button className="secondary" disabled={busy} onClick={() => void change(() => api('/jobs/' + discovery.id + '/cancel', {}))}><Square size={15} />Stop discovery</button> : <button className="secondary" disabled={busy} onClick={() => void change(() => resumable ? api('/jobs/' + discovery.id + '/resume', { reviewed: false }) : api('/jobs', { projectId, kind: 'audit', background: true, maxPages: Number(limit) }))}><Play size={15} />{resumable ? 'Resume discovery' : discovery ? 'Check pages again' : 'Start discovery'}</button>}
    </div>
    <p className="small">Uses this computer and your internet connection, with no AI charges. {discovery ? 'This crawl checks up to ' + discovery.maxPages.toLocaleString() + ' pages. ' : ''}You can stop at any time and keep the pages already checked.</p>
  </Section>;
}
