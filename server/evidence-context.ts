import type { PageEvidence } from "./contracts.js";
import { ProviderError } from "./contracts.js";

export function evidenceBatches<T>(items: T[], maximumBytes: number): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const item of items) {
    if (Buffer.byteLength(JSON.stringify([item]), "utf8") > maximumBytes)
      throw new ProviderError("context", "Choose a model with more room for this evidence. No request was sent.");
    if (batch.length && Buffer.byteLength(JSON.stringify([...batch, item]), "utf8") > maximumBytes) {
      batches.push(batch); batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Source selection favors the requested subject while retaining the site's primary context. */
export function contentSources(pages: PageEvidence[], topic: string, maximumBytes: number) {
  const terms = [...new Set(topic.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const score = (page: PageEvidence) => {
    const heading = (page.title + " " + page.h1.join(" ")).toLocaleLowerCase();
    const text = page.text.toLocaleLowerCase();
    return terms.reduce((total, term) => total + (heading.includes(term) ? 4 : 0) + (text.includes(term) ? 1 : 0), 0)
      + (new URL(page.url).pathname === "/" ? 2 : 0);
  };
  const readable = pages.filter(page => page.status >= 200 && page.status < 300 && !page.noindex && page.text.trim());
  const ranked = [...readable].sort((a, b) => score(b) - score(a) || a.url.localeCompare(b.url));
  const sources: { id: string; url: string; title: string; text: string }[] = [];
  let remaining = maximumBytes - 2;
  for (const page of ranked) {
    const source = { id: page.id, url: page.url, title: page.title.slice(0, 500), text: page.text.slice(0, 8000) };
    const bytes = Buffer.byteLength(JSON.stringify(source), "utf8") + 1;
    if (bytes > remaining) continue;
    sources.push(source); remaining -= bytes;
  }
  if (!sources.length) throw new ProviderError("context", "Choose a model with more room for the website sources.");
  return { sources, coverage: { pagesAvailable: readable.length, pagesUsed: sources.length, excerpts: true } };
}
