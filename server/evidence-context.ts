import type { PageEvidence, ManagedSourceEvidence } from "./contracts.js";
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

/**
 * Source selection favors the requested subject while retaining the site's primary context.
 * Several subjects (a project's questions) each contribute their best-matching page first, so one
 * broad page matching many words cannot crowd out the page that answers a specific question.
 * Pages are sized at the excerpt length actually sent, so the budget holds as many pages as it can.
 */
export function contentSources(pages: (PageEvidence | ManagedSourceEvidence)[], subjects: string | string[], maximumBytes: number, requiredUrls: string[] = [], excerptChars = 8000) {
  const readable = pages.filter(page => (!("status" in page) || page.status >= 200 && page.status < 300 && !page.noindex) && page.text.trim());
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  const words = (text: string) => new Set([...segmenter.segment(text.normalize("NFKC").toLowerCase())]
    .filter(part => part.isWordLike).map(part => part.segment));
  const documents = readable.map(page => ({ page, heading: words(page.title + " " + ("h1" in page ? page.h1.join(" ") : "")), text: words(page.text) }));
  const rank = (topic: string) => {
    const terms = [...words(topic)];
    // Corpus frequency discounts repeated navigation and common query words without a niche or language blacklist.
    const weights = new Map(terms.map(term => {
      const frequency = documents.filter(doc => doc.heading.has(term) || doc.text.has(term)).length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
    }));
    return documents.map(doc => {
      const match = terms.reduce((total, term) => total + weights.get(term)! * ((doc.heading.has(term) ? 4 : 0) + (doc.text.has(term) ? 1 : 0)), 0);
      return { page: doc.page, match, score: match + (new URL(doc.page.url).pathname === "/" ? 0.5 : 0) };
    }).sort((a, b) => b.score - a.score || a.page.url.localeCompare(b.page.url));
  };
  const topics = typeof subjects === "string" ? [subjects] : subjects;
  const leaders = topics.length > 1 ? topics.map(topic => rank(topic)[0]).filter(best => best && best.match > 0).map(best => best.page) : [];
  const ranked = [...leaders, ...rank(topics.join(" ")).map(doc => doc.page)];
  const required = [...new Set(requiredUrls)].map(url => {
    const page = readable.filter(page => page.url === url).sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))[0];
    if (!page) throw new ProviderError('evidence', 'The page to improve is not available in your audited sources. Audit it before creating a draft.');
    return page;
  });
  const sources: { id: string; url: string; title: string; text: string }[] = [];
  let remaining = maximumBytes - 2;
  const used = new Set<string>();
  for (const page of [...required, ...ranked]) {
    if (used.has(page.url)) continue;
    const source = { id: page.id, url: page.url, title: page.title.slice(0, 500), text: page.text.slice(0, excerptChars) };
    const bytes = Buffer.byteLength(JSON.stringify(source), "utf8") + 1;
    if (bytes > remaining) {
      if (required.includes(page)) throw new ProviderError('context', 'Choose a model with more room for the page you want to improve. No request was sent.');
      continue;
    }
    sources.push(source); remaining -= bytes; used.add(page.url);
  }
  if (!sources.length) throw new ProviderError("context", "Choose a model with more room for the website sources.");
  return { sources, coverage: { pagesAvailable: readable.length, pagesUsed: sources.length, excerpts: true } };
}
