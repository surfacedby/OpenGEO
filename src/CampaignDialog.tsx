import { useId, useState } from 'react';
import { Plus, Save, Search, Trash2, X } from 'lucide-react';
import type { Campaign, PageEvidence, Project } from '../server/contracts';
import { api } from './api';
import { Dialog } from './ui/Dialog';
import { Select } from './Select';
import { FormFeedback, useFormFeedback } from './FormFeedback';

/** Campaigns save with the brand, so a campaign can only point at questions and competitors the brand already tracks. */
export function CampaignDialog({ project, pages, campaign, initialPrompts = [], close, saved }: {
  project: Project; pages: PageEvidence[]; campaign: Campaign | null; initialPrompts?: string[];
  close: () => void; saved: (id: string | null) => Promise<void>;
}) {
  const [prompts, setPrompts] = useState(campaign?.prompts ?? initialPrompts), [targets, setTargets] = useState(campaign?.targetUrls ?? []), [competitors, setCompetitors] = useState(campaign?.competitors ?? []);
  const [status, setStatus] = useState<Campaign['status']>(campaign?.status ?? 'active'), [query, setQuery] = useState(''), [page, setPage] = useState('');
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  const feedback = useFormFeedback(), listId = useId();
  const shown = [...new Set(project.prompts)].filter(prompt => prompt.toLowerCase().includes(query.trim().toLowerCase()));
  const audited = pages.filter(item => item.status < 400 && !targets.includes(item.url));
  async function save(next: Campaign[], open: string | null) {
    setBusy(true); feedback.setError('');
    try { await api('/projects/' + project.id, { campaigns: next }, 'PATCH'); await saved(open); }
    catch (error) { feedback.setError(error); setBusy(false); }
  }
  function addPage() {
    const value = page.trim();
    if (!value || targets.includes(value)) return setPage('');
    setTargets([...targets, value]); setPage('');
  }
  if (deleting && campaign) return <Dialog title={'Delete ' + campaign.name + '?'} dismissible={!busy} close={() => setDeleting(false)}>
    <p>The campaign's questions stay with your brand, and checks it ran stay in your check history.</p>
    <FormFeedback feedback={feedback} />
    <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => setDeleting(false)}>Keep campaign</button><button className="primary danger-button" disabled={busy} onClick={() => void save(project.campaigns.filter(item => item.id !== campaign.id), null)}><Trash2 size={16} />{busy ? 'Deleting...' : 'Delete campaign'}</button></div>
  </Dialog>;
  return <Dialog title={campaign ? 'Edit ' + campaign.name : 'New campaign'} dismissible={!busy} close={close}>
    <form className="campaign-form" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      const next: Campaign = { id: campaign?.id ?? crypto.randomUUID(), name: String(form.get('name') ?? ''), goal: String(form.get('goal') ?? ''), prompts, targetUrls: targets, competitors, reviewBy: String(form.get('reviewBy') ?? '') || null, status, createdAt: campaign?.createdAt ?? new Date().toISOString() };
      void save(campaign ? project.campaigns.map(item => item.id === campaign.id ? next : item) : [...project.campaigns, next], next.id);
    }}>
      <fieldset className="form-fields" disabled={busy}>
        <label>Campaign name<input name="name" required maxLength={100} defaultValue={campaign?.name} placeholder="Example: Pricing questions" autoFocus={!campaign} {...feedback.field('name')} /></label>
        <label>Goal<textarea name="goal" rows={2} maxLength={300} defaultValue={campaign?.goal} placeholder="What should AI answers say or link to?" {...feedback.field('goal')} /></label>
        <fieldset className="campaign-questions" {...feedback.field('prompts')}>
          <legend>Questions <span>{new Set(prompts).size} of {new Set(project.prompts).size} selected</span></legend>
          {project.prompts.length > 8 && <label className="search"><Search size={15} /><input aria-label="Find a question" placeholder="Find a question" value={query} onChange={event => setQuery(event.target.value)} /></label>}
          <div className="campaign-choices">{shown.map(prompt => <label className="checkbox-field" key={prompt}><input type="checkbox" checked={prompts.includes(prompt)} onChange={event => setPrompts(current => event.target.checked ? [...current, prompt] : current.filter(item => item !== prompt))} />{prompt}</label>)}{!shown.length && <p>{project.prompts.length ? 'No matching questions' : 'Add questions in Prompts first.'}</p>}</div>
        </fieldset>
        <fieldset className="campaign-targets-field">
          <legend>Target pages <span>Pages on {project.domain} you want AI answers to link to</span></legend>
          {targets.length > 0 && <ul className="campaign-target-list">{targets.map(url => <li key={url}><span>{url.replace(/^https?:\/\//, '')}</span><button type="button" aria-label={'Remove ' + url} onClick={() => setTargets(targets.filter(item => item !== url))}><X size={14} /></button></li>)}</ul>}
          {targets.length < 20 && <div className="campaign-add-page"><input type="url" list={listId} aria-label="Add a target page" placeholder={'https://' + project.domain + '/'} value={page} onChange={event => setPage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addPage(); } }} {...feedback.field('targetUrls')} /><button type="button" className="secondary" disabled={!page.trim()} onClick={addPage}><Plus size={15} />Add</button>
            <datalist id={listId}>{audited.map(item => <option key={item.id} value={item.url}>{item.title}</option>)}</datalist></div>}
          <small>{pages.length ? 'Suggestions come from your latest website audit.' : 'Run a website audit to pick from your own pages.'}</small>
        </fieldset>
        <fieldset className="campaign-competitors">
          <legend>Competitors <span>Leave all unchecked to compare with every competitor</span></legend>
          {project.competitors.length ? <div className="campaign-choices compact">{project.competitors.map(domain => <label className="checkbox-field" key={domain}><input type="checkbox" checked={competitors.includes(domain)} onChange={event => setCompetitors(current => event.target.checked ? [...current, domain] : current.filter(item => item !== domain))} />{domain}</label>)}</div> : <p>Add competitor websites in Settings to compare them here.</p>}
        </fieldset>
        <div className="form-grid">
          <label>Review by<input type="date" name="reviewBy" defaultValue={campaign?.reviewBy ?? ''} {...feedback.field('reviewBy')} /><small>When to look at this campaign's results again.</small></label>
          {campaign && <label>Status<Select label="Status" searchable={false} value={status} onChange={value => setStatus(value as Campaign['status'])} options={[{ value: 'active', label: 'Active', detail: 'Shown in the campaign selector' }, { value: 'closed', label: 'Closed', detail: 'Kept with its results' }]} /></label>}
        </div>
      </fieldset>
      <FormFeedback feedback={feedback} />
      <div className="button-row campaign-form-actions">
        {campaign && <button type="button" className="secondary danger-text" disabled={busy} onClick={() => { feedback.setError(''); setDeleting(true); }}><Trash2 size={16} />Delete</button>}
        <button type="button" className="secondary" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary" disabled={busy || !prompts.length}><Save size={16} />{busy ? 'Saving...' : campaign ? 'Save campaign' : 'Create campaign'}</button>
      </div>
    </form>
  </Dialog>;
}
