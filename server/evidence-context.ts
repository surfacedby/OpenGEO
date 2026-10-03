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
  const readable = pages.filter(page => page.status >= 200 && page.status < 300 && !page.noindex && page.text.trim());
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const words = (text: string) => new Set([...segmenter.segment(text.normalize("NFKC").toLowerCase())]
    .filter(part => part.isWordLike).map(part => part.segment));
  const terms = [...words(topic)];
  const documents = readable.map(page => ({ page, heading: words(page.title + " " + page.h1.join(" ")), text: words(page.text) }));
  // Corpus frequency discounts repeated navigation and common query words without a niche or language blacklist.
  const weights = new Map(terms.map(term => {
    const frequency = documents.filter(doc => doc.heading.has(term) || doc.text.has(term)).length;
    return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  const ranked = documents.map(doc => ({ page: doc.page, score: terms.reduce((total, term) =>
    total + weights.get(term)! * ((doc.heading.has(term) ? 4 : 0) + (doc.text.has(term) ? 1 : 0)), 0)
    + (new URL(doc.page.url).pathname === "/" ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url)).map(doc => doc.page);
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
