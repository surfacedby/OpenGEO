import { load } from "cheerio";
import { crawlFetch, publicUrl } from "./network.js";

/** Sitemaps supply discovery URLs, not factual evidence. Every page still passes crawl policy and network checks. */
export async function sitemapPages(base: URL, declared: string[], allowed: (url: string) => boolean, signal: AbortSignal, limit: number, fetcher = crawlFetch) {
  const queue = [...declared, new URL("/sitemap.xml", base).href];
  const seen = new Set<string>(), pages = new Set<string>();
  for (let index = 0; index < queue.length && seen.size < 16 && pages.size < limit; index++) {
    signal.throwIfAborted();
    let url: URL;
    try { url = publicUrl(queue[index]); } catch { continue; }
    if (url.hostname !== base.hostname || seen.has(url.href) || !allowed(url.href)) continue;
    seen.add(url.href);
    try {
      const response = await fetcher(url.href, signal);
      if (response.status !== 200 || publicUrl(response.url).hostname !== base.hostname || !response.text.trim().startsWith("<")) continue;
      const xml = load(response.text, { xml: true });
      const isIndex = xml("sitemapindex").length > 0;
      for (const element of xml(isIndex ? "sitemap > loc" : "urlset > url > loc").toArray()) {
        let entry: URL;
        try { entry = publicUrl(xml(element).text().trim()); } catch { continue; }
        if (entry.hostname !== base.hostname || !allowed(entry.href)) continue;
        if (isIndex) { if (queue.length < 64) queue.push(entry.href); }
        else { pages.add(entry.href); if (pages.size >= limit) break; }
      }
    } catch (error) { if (signal.aborted) throw error; /* Optional discovery failures do not replace page evidence. */ }
  }
  return [...pages];
}
