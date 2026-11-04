import { load } from "cheerio";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CrawlBackoff, crawlFetch, publicUrl, sameSiteHost } from "./network.js";
import { loadRobots } from "./robots.js";
import { sitemapPages } from "./sitemap.js";
import { structuredTypes } from './structured-data.js';
import type { PageEvidence, Finding, Project, AuditCoverage } from "./contracts.js";
export type CrawlCheckpoint = {
  base: string; maxPages: number; queue: string[]; seen: string[]; visited: string[];
  fetched: number; errors: { url: string; reason: string }[]; excluded: string[]; skippedNonHtml: string[];
};
export type CrawlPolicies = Map<string, { expiresAt: number; policy: ReturnType<typeof loadRobots> }>;
export function parsePage(
  url: string,
  status: number,
  html: string,
  robotsHeader = '',
): PageEvidence {
  const $ = load(html);
  const structured = structuredTypes($('script[type]').toArray()
    .filter(element => $(element).attr('type')?.trim().toLowerCase() === 'application/ld+json')
    .map(element => $(element).text()));
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
    'script,style,nav,footer,aside,noscript,template,form,button,input,select,textarea,iframe,svg,dialog,[hidden]',
  ).remove();
  $('[role], [aria-hidden]').each((_, element) => {
    const roles = ($(element).attr('role') ?? '').toLowerCase().split(/\s+/);
    if (roles.some(role => ['banner', 'navigation', 'complementary', 'contentinfo', 'dialog', 'alertdialog', 'menu', 'menubar'].includes(role))
      || $(element).attr('aria-hidden')?.toLowerCase() === 'true') $(element).remove();
  });
  $('[style]').each((_, element) => {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test($(element).attr('style') ?? '')) $(element).remove();
  });
  // Use the page's declared main region when present. Menus and shared banners
  // must not become evidence that the page itself answers a customer's question.
  const mains = $('main, [role="main"]').filter((_, element) => !$(element).parents('main, [role="main"]').length);
  const articles = $('article').filter((_, element) => !$(element).parents('article').length);
  const content = mains.length ? mains : articles.length === 1 ? articles : $('body');
  // Article headers can carry the actual page heading; generic site headers cannot.
  content.find('header').filter((_, element) => !$(element).find('h1').length).remove();
  // Block boundaries need spaces, while inline words (e.g. "Woo<strong>Commerce</strong>") stay intact.
  content.find('p,div,section,article,header,h1,h2,h3,h4,h5,h6,li,td,th,br,dt,dd,summary,details,blockquote,pre,figcaption').append(' ');
  return {
    id: randomUUID(),
    url,
    fetchedAt: new Date().toISOString(),
    status,
    title: $('head > title').first().text().trim(),
    description: $('meta[name="description"]').attr("content")?.trim() ?? "",
    h1: content.find('h1')
      .map((_, e) => $(e).text().trim())
      .get(),
    canonical: $('link[rel="canonical"]').attr("href") ?? "",
    noindex: /(?:^|[\s,:])(?:noindex|none)(?:$|[\s,])/i.test(robotsHeader) || $('meta[name]').toArray().some(element => /^(robots|googlebot)$/i.test($(element).attr('name') ?? '') && /(?:^|[\s,])(?:noindex|none)(?:$|[\s,])/i.test($(element).attr('content') ?? '')),
    schemaTypes: structured.types,
    structuredDataLimitations: structured.limitations,
    text: content.text().replace(/\s+/g, " ").trim().slice(0, 30000),
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
  recovery?: { initial?: CrawlCheckpoint; batchSize?: number; policies?: CrawlPolicies; commit: (state: CrawlCheckpoint, page?: PageEvidence) => void },
): Promise<AuditCoverage> {
  const base = publicUrl(domain);
  const policies = recovery?.policies ?? new Map<string, { expiresAt: number; policy: ReturnType<typeof loadRobots> }>();
  const policy = (url: URL) => {
    const cached = policies.get(url.origin);
    if (cached && cached.expiresAt > Date.now()) return cached.policy;
    const pending = loadRobots(url, signal, metadataFetcher).catch(error => { policies.delete(url.origin); throw error; });
    // Short background batches share a one-hour policy read, rather than requesting robots.txt every few pages.
    policies.set(url.origin, { expiresAt: Date.now() + 3600000, policy: pending });
    return pending;
  };
  const basePolicy = await policy(base);
  const allowed = async (value: string) => {
    const url = publicUrl(value);
    return sameSiteHost(url, base) && (await policy(url))(url.href);
  };
  progress("Discovering your website pages");
  const initial = recovery?.initial;
  if (initial && (initial.base !== base.href || initial.maxPages !== maxPages)) throw new Error('The saved crawl belongs to a different scope');
  const discovered = initial ? [] : await sitemapPages(base, basePolicy.sitemaps, allowed, signal, maxPages * 4, metadataFetcher);
  const queue = initial ? [...initial.queue] : [...new Set([base.href, ...discovered])],
    seen = new Set<string>(initial?.seen);
  const queued = new Set([...queue, ...seen]),
    errors = [...(initial?.errors ?? [])];
  const visited = new Set<string>(initial?.visited);
  let fetched = initial?.fetched ?? 0;
  const excluded = [...(initial?.excluded ?? [])], skippedNonHtml = [...(initial?.skippedNonHtml ?? [])];
  // The frontier and its page evidence are committed together; a restart never discards discovery or duplicates saved pages.
  const checkpoint = (page?: PageEvidence) => {
    if (recovery) recovery.commit({ base: base.href, maxPages, queue: [...queue], seen: [...seen], visited: [...visited], fetched, errors: [...errors], excluded: [...excluded], skippedNonHtml: [...skippedNonHtml] }, page);
    else if (page) save(page);
  };
  checkpoint();
  const batchEnd = seen.size + (recovery?.batchSize ?? maxPages);
  while (queue.length && seen.size < maxPages && seen.size < batchEnd) {
    signal.throwIfAborted();
    const url = queue[0];
    if (visited.has(url)) { queue.shift(); checkpoint(); continue; }
    // A small, cancellable gap between reads keeps the local crawler from hammering a website.
    if (seen.size) await delay(500, undefined, { signal });
    visited.add(url);
    seen.add(url);
    if (!await allowed(url)) {
      excluded.push(url); queue.shift(); checkpoint();
      continue;
    }
    progress("Checking page " + seen.size + ": " + new URL(url).pathname);
    let page: PageEvidence | undefined;
    try {
      const r = await fetcher(url, signal, allowed);
      if (!await allowed(r.url)) throw new Error("The response is outside the website's permitted crawl scope");
      visited.add(r.url);
      if (!r.contentType.includes("text/html") && !r.contentType.includes("application/xhtml+xml")) skippedNonHtml.push(url);
      else {
        page = parsePage(r.url, r.status, r.text, r.robotsHeader);
        fetched++;
        for (const link of page.links)
          if (
            sameSiteHost(new URL(link), base) &&
            !visited.has(link) &&
            !queued.has(link) &&
            queue.length < maxPages * 4
          ) {
            queue.push(link);
            queued.add(link);
          }
      }
    } catch (e) {
      if (signal.aborted || e instanceof CrawlBackoff) throw e;
      if (url === base.href) throw e;
      errors.push({
        url,
        reason: "The page could not be retrieved. This is missing evidence.",
      });
    }
    queue.shift(); checkpoint(page);
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
/** Saved findings keep their identity and progress while current explanations use the original page evidence. */
export function auditFindingPresentation(project: Project, finding: Finding, page: PageEvidence): Finding {
  const current = auditFindings(project, finding.jobId, [page]).find(item => item.kind === finding.kind);
  return current ? { ...finding, title: current.title, description: current.description, steps: current.steps } : finding;
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
    if (p.status < 200 || p.status >= 300) {
      add(
        "http",
        "Page could not be retrieved",
        "The page returned HTTP " + p.status + ".",
        "high",
        ["Confirm whether this URL should still exist. Restore the page or update links to its replacement.", "Recheck the URL."],
      );
      continue;
    }
    if (!p.title)
      add(
        "title",
        "Add a descriptive page title",
        "This page has no HTML title. A clear title helps people recognize it in search results and browser tabs.",
        "medium",
        ["Describe the page topic and brand in a unique title."],
      );
    if (!p.description)
      add(
        "description",
        "Add a useful search-result description",
        "This page has no meta description. Search engines may write their own snippet, but a specific summary gives them a useful starting point.",
        "low",
        ["Summarize what someone will find on this page and why it is useful. Make the description specific to this page."],
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
        "Check what readers can see on this page",
        "This check retrieved fewer than 100 words of page content. That does not mean the page needs more words: a contact page, tool or short answer may already serve its purpose.",
        "medium",
        [
          "Open the page and check whether its main content is visible. If it loads with JavaScript, enable rendering in a website health check before editing it.",
          "Check whether a visitor can complete the purpose of this page. Add an explanation or example only where something they need is missing; leave a useful short page short.",
        ],
      );
  }
  return out;
}
