import { z } from "zod";
import { ProviderError, type DiscoveredWebsite, type Job, type Project } from "./contracts.js";
import { publicUrl } from "./network.js";
import { consoleManaged, managedJob } from "./console-managed.js";
import type { Runner } from "./workflows.js";

const result = z.object({ job: managedJob, review_complete: z.literal(true),
  provenance: z.literal("client_supplied_answers"), locale: z.string().max(40),
  websites: z.array(z.object({ name: z.string().trim().min(1).max(120), domain: z.string().max(253).refine(value => {
    try { return publicUrl(value).hostname === value; } catch { return false; }
  }),
    role: z.enum(["competitor", "reference"]), reason: z.string().trim().min(1).max(600),
    answer_ids: z.array(z.string().uuid()).min(1).max(100) })).max(100) });

/** Roles retain the original local citation evidence and never change the comparison list. */
export async function consoleCompetitors(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  const { output, input } = await consoleManaged(runner, job, project, signal, () => {
    const observations = runner.store.observations(project.id, job.measurementJobId);
    if (!observations.length || observations.length > 100 || observations.some(answer => answer.answer.length > 32000 || answer.citations.length > 50))
      throw new ProviderError("evidence", "Choose a completed check with up to 100 answers within this connection's supported size.");
    const audit = runner.store.jobs(project.id).find(item => item.kind === "audit" && item.status === "completed" &&
      JSON.parse(runner.store.step(item.id, "project")?.body ?? "null")?.domain === project.domain);
    const pages = audit ? runner.store.pages(project.id, audit.id) : [];
    return { locale: project.locale, source_urls: pages.filter(page => page.status >= 200 && page.status < 300 && !page.noindex)
      .sort((a, b) => new URL(a.url).pathname.length - new URL(b.url).pathname.length).slice(0, 5).map(page => page.url),
      answers: observations.map(answer => ({ id: answer.id, question: answer.prompt, answer: answer.answer,
        observed_at: answer.observedAt, citations: answer.citations.map(citation => ({ url: citation.url, title: citation.title ?? "" })) })) };
  }, result);
  if (output.locale !== input.locale)
    throw new ProviderError("invalid_response", "The role review used a different language setting. Your comparison list is unchanged.");
  const seen = new Set<string>();
  const websites: DiscoveredWebsite[] = output.websites.map(site => {
    const domain = publicUrl(site.domain).hostname.replace(/^www\./, "");
    if (domain !== site.domain || domain === project.domain || domain.endsWith("." + project.domain) || seen.has(domain))
      throw new ProviderError("invalid_response", "The review returned an unrelated or repeated website. Your saved evidence is unchanged.");
    seen.add(domain);
    const ids = new Set(site.answer_ids);
    if (ids.size !== site.answer_ids.length || [...ids].some(id => !input.answers.some(answer => answer.id === id && answer.citations.some(citation => {
      const host = publicUrl(citation.url).hostname.replace(/^www\./, "");
      return host === domain || host.endsWith("." + domain);
    })))) throw new ProviderError("invalid_response", "The role review did not match its saved citations. Resume to check the same result again.");
    return { name: site.name, domain, role: site.role, reason: site.reason, observationIds: site.answer_ids };
  });
  return { measurementJobId: job.measurementJobId, competitors: websites.filter(site => site.role === "competitor"),
    references: websites.filter(site => site.role === "reference") };
}
