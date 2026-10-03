import { FileText, FilePenLine, Plus, ShieldCheck, BookOpen, ChevronDown, Search, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { ContentEditor, ContentBrief, ContentReview } from './WorkflowControls';
import type { ContentTask } from '../server/contracts';
import { SiteIcon } from './SiteIcon';
import { targetDomain } from './finding-groups';
import './content.css';

type Draft = {
  id: string; topic: string; markdown: string; brief: string; createdAt: string;
  locale: string; status?: string; reviewCurrent?: boolean;
  review?: { issues?: unknown[]; coverageComplete?: boolean };
  sourceEvidence?: { id: string; url: string; title: string }[];
  task?: ContentTask;
};
type Edit = { id: string; markdown: string; baseMarkdown: string; recoverySession: string };

export function ContentWorkspace({ drafts, selected, select, projectId, run, revise, onDraftChange, create, pending }: {
  drafts: Draft[]; selected: string; select: (id: string) => void; projectId: string;
  run: (action: () => Promise<unknown>) => Promise<void>; revise: (draft: Draft) => void;
  onDraftChange: (edit: Edit | null) => void; create: () => void; pending: boolean;
}) {
  const [query, setQuery] = useState('');
  const draft = drafts.find(item => item.id === selected) ?? drafts[0];
  const shown = drafts.filter(item => item.topic.toLowerCase().includes(query.toLowerCase()));
  if (!draft) return <section className="panel content-empty">
    <div className="content-illustration" aria-hidden="true"><FileText size={82} strokeWidth={1} /><FilePenLine size={38} strokeWidth={1.5} /></div>
    <h2>{pending ? 'Your draft is on its way' : 'Create your first content draft'}</h2>
    <p>{pending ? 'Research, writing and review progress appears above.' : 'Start with an opportunity or a topic. Get a researched draft, a clear brief and source links to review.'}</p>
    {!pending && <button className="primary" onClick={create}><Plus size={16} />Create your first draft</button>}
    <div className="content-process"><span><BookOpen size={16} />Research</span><span><FilePenLine size={16} />Write</span><span><ShieldCheck size={16} />Review</span></div>
  </section>;
  return <section className="panel content-workspace" aria-label="Content workspace">
    <aside className="draft-library" aria-label="Draft library">
      <div className="draft-library-heading"><h2>Your drafts <span>{drafts.length}</span></h2><button className="icon-button" aria-label="Create a draft" onClick={create}><Plus size={17} /></button></div>
      <label className="search"><Search size={15} /><input aria-label="Search drafts" placeholder="Find a draft" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="draft-list">{shown.map(item => <button key={item.id} className={'draft-card' + (draft.id === item.id ? ' selected' : '')} aria-label={'Open draft: ' + item.topic} aria-pressed={draft.id === item.id} onClick={() => select(item.id)}>
        {item.task?.mode === 'page_update' ? <FilePenLine size={17} /> : <FileText size={17} />}<span><strong>{item.topic}</strong><small>{item.task?.mode === 'page_update' ? 'Page copy' : 'Article'} / {new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><span className={'draft-state' + (item.reviewCurrent === false || item.review?.issues?.length ? ' needs-review' : '')}>{item.reviewCurrent === false ? 'Review outdated' : item.review?.issues?.length ? 'Needs review' : 'Draft'}</span></span>
      </button>)}</div>
      {!shown.length && <p className="small">No matching drafts.</p>}
    </aside>
    <article className="draft-document" key={draft.id}>
      <header className="draft-document-heading"><span className="badge">{draft.status === 'needs_review' || draft.reviewCurrent === false ? 'Needs review' : 'Draft'}</span><h3>{draft.topic}</h3><p>Review the content and its sources before publishing.</p></header>
      {draft.task?.targetUrl && <div className="draft-target"><span>{draft.task.mode === 'page_update' ? 'Copy for' : 'Inspired by'}</span><a href={draft.task.targetUrl} target="_blank" rel="noreferrer">{targetDomain(draft.task.targetUrl) && <SiteIcon projectId={projectId} domain={targetDomain(draft.task.targetUrl)!} size={22} />}<span>{draft.sourceEvidence?.find(source => source.url === draft.task!.targetUrl)?.title || targetDomain(draft.task.targetUrl)}</span><ArrowUpRight size={14} /></a></div>}
      <div className="draft-context">
        <details><summary><BookOpen size={16} />Content brief <ChevronDown size={14} /></summary><ContentBrief brief={draft.brief} sources={draft.sourceEvidence} /></details>
        <details className="draft-review" open={!!draft.review?.issues?.length || draft.review?.coverageComplete === false || draft.reviewCurrent === false || !draft.review}>
          <summary><ShieldCheck size={16} />{draft.reviewCurrent === false ? 'Review outdated after edits' : draft.review?.issues?.length ? draft.review.issues.length + (draft.review.issues.length === 1 ? ' claim needs review' : ' claims need review') : 'Verification notes'}<ChevronDown size={14} /></summary><ContentReview content={draft} />
        </details>
      </div>
      <ContentEditor content={draft} projectId={projectId} run={run} revise={() => revise(draft)} onDraftChange={edit => onDraftChange(edit ? { id: draft.id, ...edit } : null)} />
    </article>
  </section>;
}
