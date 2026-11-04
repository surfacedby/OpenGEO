import { useId, useState } from 'react';
import { Plus, Save, Search, Trash2, X } from 'lucide-react';
import type { Topic, PageSummary, Project } from '../server/contracts';
import { api } from './api';
import { Dialog } from './ui/Dialog';
import { Select } from './Select';
import { FormFeedback, useFormFeedback } from './FormFeedback';
import { useCloseProtection } from './useCloseProtection';

/** Topics save with the brand, so a topic can only point at questions and competitors the brand already tracks. */
export function TopicDialog({ project, pages, topic, initialPrompts = [], close, saved }: {
  project: Project; pages: PageSummary[]; topic: Topic | null; initialPrompts?: string[];
  close: () => void; saved: (id: string | null) => Promise<void>;
}) {
  const [prompts, setPrompts] = useState(topic?.prompts ?? initialPrompts), [targets, setTargets] = useState(topic?.targetUrls ?? []), [competitors, setCompetitors] = useState(topic?.competitors ?? []);
  const [status, setStatus] = useState<Topic['status']>(topic?.status ?? 'active'), [query, setQuery] = useState(''), [page, setPage] = useState('');
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(topic?.name ?? ''), [goal, setGoal] = useState(topic?.goal ?? ''), [reviewBy, setReviewBy] = useState(topic?.reviewBy ?? '');
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = JSON.stringify([name, goal, reviewBy, prompts, targets, competitors, status]) !== JSON.stringify([topic?.name ?? '', topic?.goal ?? '', topic?.reviewBy ?? '', topic?.prompts ?? initialPrompts, topic?.targetUrls ?? [], topic?.competitors ?? [], topic?.status ?? 'active']) || !!page.trim();
  useCloseProtection(dirty || busy);
  const requestClose = () => { if (!busy) { if (dirty) setConfirmClose(true); else close(); } };
  const feedback = useFormFeedback(), listId = useId();
  const shown = [...new Set(project.prompts)].filter(prompt => prompt.toLowerCase().includes(query.trim().toLowerCase()));
  const audited = pages.filter(item => item.status < 400 && !targets.includes(item.url));
  async function save(next: Topic[], open: string | null) {
    setBusy(true); feedback.setError('');
    try { await api('/projects/' + project.id, { topics: next }, 'PATCH'); await saved(open); }
    catch (error) { feedback.setError(error); setBusy(false); }
  }
  function addPage() {
    const value = page.trim();
    if (!value || targets.includes(value)) return setPage('');
    setTargets([...targets, value]); setPage('');
  }
  if (deleting && topic) return <Dialog title={'Delete ' + topic.name + '?'} dismissible={!busy} close={() => setDeleting(false)}>
    <p>The topic's questions stay with your brand, and checks it ran stay in your check history.</p>
    <FormFeedback feedback={feedback} />
    <div className="button-row"><button type="button" className="secondary" disabled={busy} onClick={() => setDeleting(false)}>Keep topic</button><button className="primary danger-button" disabled={busy} onClick={() => void save(project.topics.filter(item => item.id !== topic.id), null)}><Trash2 size={16} />{busy ? 'Deleting...' : 'Delete topic'}</button></div>
  </Dialog>;
  return <Dialog title={topic ? 'Edit ' + topic.name : 'New topic'} dismissible={!busy} close={requestClose}>
    <form className="topic-form" onSubmit={event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      const next: Topic = { id: topic?.id ?? crypto.randomUUID(), name: String(form.get('name') ?? ''), goal: String(form.get('goal') ?? ''), prompts, targetUrls: targets, competitors, reviewBy: String(form.get('reviewBy') ?? '') || null, status, createdAt: topic?.createdAt ?? new Date().toISOString() };
      void save(topic ? project.topics.map(item => item.id === topic.id ? next : item) : [...project.topics, next], next.id);
    }}>
      <fieldset className="form-fields" disabled={busy}>
        <label>Topic name<input name="name" required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="Example: Pricing questions" autoFocus={!topic} {...feedback.field('name')} /></label>
        <label>Goal<textarea name="goal" rows={2} maxLength={300} value={goal} onChange={event => setGoal(event.target.value)} placeholder="What should AI answers say or link to?" {...feedback.field('goal')} /></label>
        <fieldset className="topic-questions" {...feedback.field('prompts')}>
          <legend>Questions <span>{new Set(prompts).size} of {new Set(project.prompts).size} selected</span></legend>
          {project.prompts.length > 8 && <label className="search"><Search size={15} /><input aria-label="Find a question" placeholder="Find a question" value={query} onChange={event => setQuery(event.target.value)} /></label>}
          <div className="topic-choices">{shown.map(prompt => <label className="checkbox-field" key={prompt}><input type="checkbox" checked={prompts.includes(prompt)} onChange={event => setPrompts(current => event.target.checked ? [...current, prompt] : current.filter(item => item !== prompt))} />{prompt}</label>)}{!shown.length && <p>{project.prompts.length ? 'No matching questions' : 'Add questions in Prompts first.'}</p>}</div>
        </fieldset>
        <fieldset className="topic-targets-field">
          <legend>Target pages <span>Pages on {project.domain} you want AI answers to link to</span></legend>
          {targets.length > 0 && <ul className="topic-target-list">{targets.map(url => <li key={url}><span>{url.replace(/^https?:\/\//, '')}</span><button type="button" aria-label={'Remove ' + url} onClick={() => setTargets(targets.filter(item => item !== url))}><X size={14} /></button></li>)}</ul>}
          {targets.length < 20 && <div className="topic-add-page"><input type="url" list={listId} aria-label="Add a target page" placeholder={'https://' + project.domain + '/'} value={page} onChange={event => setPage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addPage(); } }} {...feedback.field('targetUrls')} /><button type="button" className="secondary" disabled={!page.trim()} onClick={addPage}><Plus size={15} />Add</button>
            <datalist id={listId}>{audited.map(item => <option key={item.id} value={item.url}>{item.title}</option>)}</datalist></div>}
          <small>{pages.length ? 'Suggestions come from your latest website check.' : 'You can enter a page now, or discover pages from Scans.'}</small>
        </fieldset>
        <fieldset className="topic-competitors">
          <legend>Competitors <span>Leave all unchecked to compare with every competitor</span></legend>
          {project.competitors.length ? <div className="topic-choices compact">{project.competitors.map(domain => <label className="checkbox-field" key={domain}><input type="checkbox" checked={competitors.includes(domain)} onChange={event => setCompetitors(current => event.target.checked ? [...current, domain] : current.filter(item => item !== domain))} />{domain}</label>)}</div> : <p>Add websites in Competitors to compare them here.</p>}
        </fieldset>
        <div className="form-grid">
          <label>Review by<input type="date" name="reviewBy" value={reviewBy} onChange={event => setReviewBy(event.target.value)} {...feedback.field('reviewBy')} /><small>When to look at this topic's results again.</small></label>
          {topic && <label>Status<Select label="Status" searchable={false} value={status} onChange={value => setStatus(value as Topic['status'])} options={[{ value: 'active', label: 'Active', detail: 'Shown in the topic selector' }, { value: 'closed', label: 'Closed', detail: 'Kept with its results' }]} /></label>}
        </div>
      </fieldset>
      <FormFeedback feedback={feedback} />
      {confirmClose && <div className="alert" role="alert"><span>Discard your unsaved topic changes?</span><button type="button" className="secondary" onClick={() => setConfirmClose(false)}>Keep editing</button><button type="button" className="secondary danger-text" onClick={close}>Discard changes</button></div>}
      <div className="button-row topic-form-actions">
        {topic && <button type="button" className="secondary danger-text" disabled={busy} onClick={() => { feedback.setError(''); setDeleting(true); }}><Trash2 size={16} />Delete</button>}
        <button type="button" className="secondary" disabled={busy} onClick={requestClose}>Cancel</button>
        <button className="primary" disabled={busy || !prompts.length}><Save size={16} />{busy ? 'Saving...' : topic ? 'Save topic' : 'Create topic'}</button>
      </div>
    </form>
  </Dialog>;
}
