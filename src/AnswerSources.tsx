import { ExternalLink } from 'lucide-react';
import type { Citation } from '../server/contracts';
import { targetDomain } from './finding-groups';
import { SiteIcon } from './SiteIcon';
import { Disclosure } from './ui/Primitives';

function SourceLinks({ sources, projectId }: { sources: Citation[]; projectId: string }) {
  return <ul className="answer-sources">{sources.map((source, index) => {
    const domain = targetDomain(source.url);
    if (!domain) return null;
    return <li key={index}><a href={source.url} target="_blank" rel="noreferrer">
      <SiteIcon projectId={projectId} domain={domain} size={20} />
      <span><strong>{source.title || domain}</strong>{source.title && <small>{domain}</small>}</span>
      <ExternalLink size={12} aria-hidden="true" />
    </a></li>;
  })}</ul>;
}

export function AnswerSources({ citations, retrieved, projectId }: {
  citations: Citation[]; retrieved?: Citation[]; projectId: string;
}) {
  return <>
    {!!citations.length && !!retrieved?.length && <h4 className="answer-source-heading">Cited in this answer</h4>}
    {citations.length ? <SourceLinks sources={citations} projectId={projectId} />
      : <p>This answer has no reported citation links.</p>}
    {!!retrieved?.length && <Disclosure label={`Retrieved without a citation (${retrieved.length})`}>
      <SourceLinks sources={retrieved} projectId={projectId} />
    </Disclosure>}
  </>;
}
