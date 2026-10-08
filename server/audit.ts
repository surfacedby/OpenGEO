import { load } from "cheerio";
import { randomUUID } from "node:crypto";
import { crawlFetch, publicUrl, sameSiteHost } from "./network.js";
import { loadRobots } from "./robots.js";
import { sitemapPages } from "./sitemap.js";
import type { PageEvidence, Finding, Project, AuditCoverage } from "./contracts.js";
export function parsePage(
  url: string,
  status: number,
  html: string,
): PageEvidence {
  const $ = load(html);
  // Navigation links belong to crawl discovery even when navigation text is
  // excluded from the page's content evidence.
  const links = [
    ...new Set(
      $("a[href]")
        .map((_, e) => {
          try {
            return publicUrl(new URL($(e).attr("href")!, url).href).href;
          } catch {
            return "";
          }
        })
        .get()
        .filter(Boolean),
    ),
  ];
  $(
    'script:not([type="application/ld+json"]),style,nav,footer,noscript',
  ).remove();
  const schemaTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const visit = (v: any) => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === "object") {
          if (v["@type"])
            schemaTypes.push(
              ...[v["@type"]].flat().filter((x) => typeof x === "string"),
            );
          if (v["@graph"]) visit(v["@graph"]);
        }
      };
      visit(JSON.parse($(el).text()));
    } catch {
      /* Invalid structured data is not evidence of valid schema. */
    }
  });
  $("script").remove();
  return {
    id: randomUUID(),
    url,
    fetchedAt: new Date().toISOString(),
    status,
    title: $("title").text().trim(),
    description: $('meta[name="description"]').attr("content")?.trim() ?? "",
    h1: $("h1")
      .map((_, e) => $(e).text().trim())
      .get(),
    canonical: $('link[rel="canonical"]').attr("href") ?? "",
    noindex: /noindex/i.test($('meta[name="robots"]').attr("content") ?? ""),
    schemaTypes: [...new Set(schemaTypes)],
    text: $("body").text().replace(/\s+/g, " ").trim().slice(0, 30000),
    links,
  };
}
export async function crawl(
  domain: string,
  signal: AbortSignal,
  save: (p: PageEvidence) => void,
  progress: (s: string) => void,
  fetcher = crawlFetch,
  maxPages = 100,
  metadataFetcher = fetcher,
): Promise<AuditCoverage> {
  const base = publicUrl(domain);
  const policies = new Map<string, ReturnType<typeof loadRobots>>();
  const policy = (url: URL) => {
    let pending = policies.get(url.origin);
    if (!pending) { pending = loadRobots(url, signal, metadataFetcher); policies.set(url.origin, pending); }
    return pending;
  };
  const basePolicy = await policy(base);
  const allowed = async (value: string) => {
    const url = publicUrl(value);
    return sameSiteHost(url, base) && (await policy(url))(url.href);
  };
  progress("Discovering your website pages");
  const discovered = await sitemapPages(base, basePolicy.sitemaps, allowed, signal, maxPages * 4, metadataFetcher);
  const queue = [...new Set([base.href, ...discovered])],
    seen = new Set<string>();
  const queued = new Set(queue),
    errors: { url: string; reason: string }[] = [];
  const visited = new Set<string>();
  let fetched = 0;
  const excluded: string[] = [], skippedNonHtml: string[] = [];
  while (queue.length && seen.size < maxPages) {
    signal.throwIfAborted();
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    seen.add(url);
    if (!await allowed(url)) {
      excluded.push(url);
      continue;
    }
    progress("Auditing " + new URL(url).pathname);
    try {
      const r = await fetcher(url, signal, allowed);
      if (!await allowed(r.url)) throw new Error("The response is outside the website's permitted crawl scope");
      visited.add(r.url);
      if (!r.contentType.includes("text/html")) { skippedNonHtml.push(url); continue; }
      const p = parsePage(r.url, r.status, r.text);
      save(p);
      fetched++;
      for (const link of p.links)
        if (
          sameSiteHost(new URL(link), base) &&
          !visited.has(link) &&
          !queued.has(link) &&
          queue.length < maxPages * 4
        ) {
          queue.push(link);
          queued.add(link);
        }
    } catch (e) {
      if (signal.aborted) throw e;
      if (url === base.href) throw e;
      errors.push({
        url,
        reason: "The page could not be retrieved. This is missing evidence.",
      });
    }
  }
  return {
    attempted: seen.size,
    fetched,
    failed: errors,
    excludedByRobots: excluded,
    skippedNonHtml,
    truncated: queue.length > 0,
    remainingDiscovered: queue.length,
    maxPages,
  };
}
export function auditFindings(
  project: Project,
  jobId: string,
  pages: PageEvidence[],
): Finding[] {
  const out: Finding[] = [];
  for (const p of pages) {
    const add = (
      kind: string,
      title: string,
      description: string,
      priority: Finding["priority"],
      steps: string[],
    ) =>
      out.push({
        id: randomUUID(),
        projectId: project.id,
        jobId,
        title,
        description,
        priority,
        targetUrl: p.url,
        evidenceIds: [p.id],
        steps,
        confidence: "known",
        status: "open",
        kind,
      });
    if (p.status >= 400)
      add(
        "http",
        "Page could not be retrieved",
        "The page returned HTTP " + p.status + ".",
        "high",
        ["Restore a successful response for the page.", "Recheck the URL."],
      );
    if (!p.title)
      add(
        "title",
        "Add a descriptive page title",
        "The retrieved page has no title.",
        "medium",
        ["Describe the page topic and brand in a unique title."],
      );
    if (!p.description)
      add(
        "description",
        "Write a page summary",
        "No meta description was present in the retrieved HTML.",
        "low",
        ["Write an accurate summary of the page."],
      );
    if (p.h1.length !== 1)
      add(
        "heading",
        "Clarify the main heading",
        "The retrieved page contains " +
          p.h1.length +
          " H1 headings. This is a structure finding, not proof of ranking impact.",
        "medium",
        ["Use one clear main heading that describes the page."],
      );
    if (p.noindex)
      add(
        "indexing",
        "Review the indexing instruction",
        "A noindex instruction is present. Confirm whether the exclusion is intentional.",
        "high",
        [
          "Check the intended visibility of this page.",
          "Remove noindex only if the page should be indexed.",
        ],
      );
    if (!p.canonical)
      add(
        "canonical",
        "Declare a canonical URL",
        "No canonical URL was found. Duplicate URL variants may need an explicit canonical.",
        "low",
        [
          "Review duplicate URL variants.",
          "Declare the preferred URL if appropriate.",
        ],
      );
    if (p.text.split(/\s+/).length < 100)
      add(
        "content",
        "Review the page substance",
        "The retrieved HTML exposes fewer than 100 words. A rendered audit may reveal more content.",
        "medium",
        [
          "Check the rendered page before changing content.",
          "Add useful explanations supported by your expertise.",
        ],
      );
  }
  return out;
}
