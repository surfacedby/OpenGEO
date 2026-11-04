import type { PageSummary } from '../server/contracts';
import { pageAvailable, pageSearchExclusion } from '../server/page-classification';

/** Search the whole saved crawl, but render only a short list of public target suggestions. Manual URLs remain available. */
export function pageSuggestions(pages: PageSummary[], selected: string[], query: string): PageSummary[] {
  const excluded = new Set(selected), needle = query.trim().toLowerCase();
  const matches: PageSummary[] = [];
  for (const page of pages) {
    if (excluded.has(page.url) || !pageAvailable(page) || pageSearchExclusion(page)) continue;
    if (needle && !(page.title + ' ' + page.url).toLowerCase().includes(needle)) continue;
    matches.push(page);
    excluded.add(page.url);
    if (matches.length === 20) break;
  }
  return matches;
}
