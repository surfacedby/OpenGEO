import { ExternalLink } from 'lucide-react';
import { SiteIcon } from './SiteIcon';

export function WebsiteIdentity({ projectId, domain, name = domain, description, url = 'https://' + domain, linkLabel = domain }: { projectId: string; domain: string; name?: string; description?: string; url?: string; linkLabel?: string }) {
  return <div className="website-identity"><SiteIcon projectId={projectId} domain={domain} size={36} /><div><strong>{name}</strong><a href={url} target="_blank" rel="noreferrer">{linkLabel}<ExternalLink size={14} /></a>{description && <p>{description}</p>}</div></div>;
}
