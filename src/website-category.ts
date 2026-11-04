import type { DiscoveredWebsite, Job, WebsiteCategory } from '../server/contracts';

export const websiteCategoryLabels: Record<WebsiteCategory, string> = {
  organization: 'Organization', product: 'Product', publisher: 'Publisher',
  directory: 'Directory', marketplace: 'Marketplace', platform: 'Platform', community: 'Community',
};

/** Classification belongs to its saved check; later or unrelated checks cannot fill missing labels. */
export function checkWebsiteClassifications(jobs: Job[], measurementId?: string) {
  if (!measurementId) return [];
  const review = jobs.find(job => job.kind === 'competitors' && job.measurementJobId === measurementId && job.status === 'completed');
  const result = (review ?? jobs.find(job => job.id === measurementId))?.result as { competitors?: DiscoveredWebsite[]; references?: DiscoveredWebsite[] } | null | undefined;
  return [...(result?.competitors ?? []), ...(result?.references ?? [])];
}

export function classifiedWebsite(rows: DiscoveredWebsite[], url: string) {
  const host = (value: string) => {
    try { return new URL(value.includes('://') ? value : 'https://' + value).hostname.toLowerCase().replace(/^www\./, ''); }
    catch { return ''; }
  };
  const target = host(url);
  return target ? rows.find(row => host(row.domain) === target) : undefined;
}
