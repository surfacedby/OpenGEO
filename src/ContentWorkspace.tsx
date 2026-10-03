import { FileText, FilePenLine, Plus, ShieldCheck, BookOpen, ChevronDown, Search, ArrowUpRight, ArrowLeft, ArrowRight, History } from 'lucide-react';
import { useState } from 'react';
import { ContentEditor, ContentBrief, ContentReview } from './WorkflowControls';
import type { ContentTask } from '../server/contracts';
import { SiteIcon } from './SiteIcon';
import { targetDomain } from './finding-groups';
import { contentHistory } from './content-history';
import { Select } from './Select';
import './content.css';

type Draft = {
  id: string; topic: string; markdown: string; brief: string; createdAt: string;
  locale: string; status?: string; reviewCurrent?: boolean; derivedFrom?: string;
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
  const draft = drafts.find(item => item.id === selected);
  const library = contentHistory(drafts);
  const versions = library.find(group => group.some(item => item.id === draft?.id)) ?? [];
  const shown = library.filter(group => group.some(item => item.topic.toLowerCase().includes(query.toLowerCase())));
  if (!drafts.length) return <section className="panel content-empty">
    <div className="content-illustration" aria-hidden="true"><FileText size={82} strokeWidth={1} /><FilePenLine size={38} strokeWidth={1.5} /></div>
    <h2>{pending ? 'Your draft is on its way' : 'Create your first content draft'}</h2>
    <p>{pending ? 'Research, writing and review progress appears above.' : 'Start with an opportunity or a topic. Get a researched draft, a clear brief and source links to review.'}</p>
    {!pending && <button className="primary" onClick={create}><Plus size={16} />Create your first draft</button>}
    <div className="content-process"><span><BookOpen size={16} />Research</span><span><FilePenLine size={16} />Write</span><span><ShieldCheck size={16} />Review</span></div>
  </section>;
  if (!draft) return <section className="panel draft-library" aria-label="Draft library">
      <div className="draft-library-heading"><h2>Your drafts <span>{library.length}</span></h2><button className="icon-button" aria-label="Create a draft" onClick={create}><Plus size={17} /></button></div>
      <label className="search"><Search size={15} /><input aria-label="Search drafts" placeholder="Find a draft" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="draft-list-heading" aria-hidden="true"><span>Content</span><span>Type</span><span>Review</span><span>Updated</span><span /></div>
      <div className="draft-list">{shown.map(group => {
        const item = group[0], needsReview = item.reviewCurrent === false || item.review?.issues?.length || item.review?.coverageComplete === false || !item.review;
        return <button key={item.id} className="draft-card" aria-label={'Open draft: ' + item.topic} onClick={() => select(item.id)}>
          <span className="draft-list-title"><span className="draft-file-icon">{item.task?.mode === 'page_update' ? <FilePenLine size={21} /> : <FileText size={21} />}</span><span><strong>{item.topic}</strong>{item.task?.targetUrl && <small>{targetDomain(item.task.targetUrl)}</small>}{group.length > 1 && <small className="draft-version-count"><History size={12} />{group.length} versions</small>}</span></span>
          <span className="draft-type">{item.task?.mode === 'page_update' ? 'Page update' : 'Article'}</span>
          <span className={'draft-state' + (needsReview ? ' needs-review' : '')}>{item.reviewCurrent === false ? 'Review outdated' : needsReview ? 'Needs review' : 'Draft'}</span>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time><ArrowRight size={17} />
        </button>;
      })}</div>
      {!shown.length && <p className="small">No matching drafts.</p>}
  </section>;
  return <section className="panel content-workspace" aria-label="Content workspace">
    <div className="draft-document-toolbar"><button className="secondary compact" onClick={() => select('')}><ArrowLeft size={15} />All drafts</button><span>{draft.task?.mode === 'page_update' ? 'Page update' : 'Article'}</span></div>
    <article className="draft-document" key={draft.id}>
      <header className="draft-document-heading"><span className="badge">{draft.status === 'needs_review' || draft.reviewCurrent === false ? 'Needs review' : 'Draft'}</span><h3>{draft.topic}</h3><p>Review the content and its sources before publishing.</p></header>
      {versions.length > 1 && <div className="draft-history"><History size={16} /><Select label="Draft version" value={draft.id} onChange={select} compact searchable={false} options={versions.map((item, index) => ({ value: item.id, label: index === 0 ? 'Latest version' : 'Version ' + (versions.length - index), detail: new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }))} /></div>}
      {draft.task?.targetUrl && <div className="draft-target"><span>{draft.task.mode === 'page_update' ? 'Copy for' : 'Inspired by'}</span><a href={draft.task.targetUrl} target="_blank" rel="noreferrer">{targetDomain(draft.task.targetUrl) && <SiteIcon projectId={projectId} domain={targetDomain(draft.task.targetUrl)!} size={22} />}<span>{draft.sourceEvidence?.find(source => source.url === draft.task!.targetUrl)?.title || targetDomain(draft.task.targetUrl)}</span><ArrowUpRight size={14} /></a></div>}
      <div className="draft-context">
        <details><summary><BookOpen size={16} />Content brief <ChevronDown size={14} /></summary><ContentBrief brief={draft.brief} sources={draft.sourceEvidence} /></details>
        <details className={'draft-review' + (draft.review?.issues?.length || draft.review?.coverageComplete === false || draft.reviewCurrent === false || !draft.review ? ' needs-review' : '')}>
          <summary><ShieldCheck size={16} />{!draft.review ? 'Review not available' : draft.reviewCurrent === false ? 'Review outdated after edits' : draft.review?.issues?.length ? draft.review.issues.length + (draft.review.issues.length === 1 ? ' claim needs review' : ' claims need review') : draft.review.coverageComplete === false ? 'Review incomplete' : 'Verification notes'}<ChevronDown size={14} /></summary><ContentReview content={draft} />
        </details>
      </div>
      <ContentEditor content={draft} projectId={projectId} run={run} revise={() => revise(draft)} onDraftChange={edit => onDraftChange(edit ? { id: draft.id, ...edit } : null)} />
    </article>
  </section>;
}
