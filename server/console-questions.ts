import { z } from "zod";
import { ProviderError, type Job, type Project } from "./contracts.js";
import { publicUrl } from "./network.js";
import { consoleManaged, managedJob } from "./console-managed.js";
import type { Runner } from "./workflows.js";

const source = z.object({ url: z.string().url().refine(value => {
  try { publicUrl(value); return true; } catch { return false; }
}), title: z.string().max(1000), observed_at: z.string().datetime({ offset: true }) });
const result = z.object({ job: managedJob, review_complete: z.literal(true),
  locale: z.string().max(40), pages_read: z.number().int().min(1).max(6),
  questions: z.array(z.object({ text: z.string().trim().min(10).max(500), sources: z.array(source).min(1).max(6) })).max(20) });

/** Only reviewed suggestions with owned source evidence reach the selection list. */
export async function consoleQuestions(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  const { output, capability } = await consoleManaged(runner, job, project, signal, () => {
    const audit = job.auditJobId ? runner.store.job(job.auditJobId) : null;
    if (!audit || audit.projectId !== project.id || audit.kind !== "audit" || audit.status !== "completed" ||
      JSON.parse(runner.store.step(audit.id, "project")?.body ?? "null")?.domain !== project.domain)
      throw new ProviderError("evidence", "Complete a website audit before suggesting questions.");
    const pages = runner.store.pages(project.id, audit.id)
      .filter(page => page.status >= 200 && page.status < 300 && !page.noindex && page.text.trim().length >= 80)
      .sort((a, b) => new URL(a.url).pathname.length - new URL(b.url).pathname.length);
    if (!pages.length)
      throw new ProviderError("evidence", "We couldn't read enough website content. Try a rendered audit or add your own questions.");
    return { source_urls: [...new Set(pages.map(page => page.url))].slice(0, 5),
      existing_questions: project.prompts.slice(0, 100), count: 12, locale: project.locale };
  }, result);
  const related = runner.store.pages(project.id, job.auditJobId);
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const known = new Set(project.prompts.map(normalize));
  const questions = output.questions.flatMap(question => {
    if (question.sources.some(item => {
      const host = publicUrl(item.url).hostname.replace(/^www\./, "");
      return host !== project.domain && !host.endsWith("." + project.domain);
    })) throw new ProviderError("invalid_response", "A suggested question used evidence from another website. No questions were selected.");
    const key = normalize(question.text);
    if (known.has(key)) return [];
    known.add(key);
    return [{ text: question.text, sources: question.sources,
      pageIds: related.filter(page => question.sources.some(item => item.url === page.url)).map(page => page.id) }];
  });
  if (output.locale !== project.locale)
    throw new ProviderError("invalid_response", "The suggestions use a different language setting. No questions were selected.");
  return { version: 4, pagesRead: output.pages_read, auditJobId: job.auditJobId,
    model: capability?.models.find(model => model.operations.includes("questions"))?.id ?? "managed", questions };
}
