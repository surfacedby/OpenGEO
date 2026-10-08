import { z } from "zod";
import type { Job, Model, Project, DiscoveredWebsite, Observation } from "./contracts.js";
import { ProviderError } from "./contracts.js";
import type { Runner } from "./workflows.js";
import { publicUrl, sameSiteHost } from "./network.js";
import { prompts } from "./prompts.js";
import { contentSources } from "./evidence-context.js";
import { consoleQuestions } from "./console-questions.js";

export const questionDiscoveryVersion = 4;
const offeringInventory = z.object({
  siteType: z.enum(["business", "marketplace", "publication", "personal", "unclear"]),
  audience: z.string().trim().max(500),
  offerings: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(3).max(300), customerNeed: z.string().trim().min(3).max(500), evidence: z.array(z.object({ pageId: z.string(), quote: z.string().trim().min(1).max(600) }).strict()).min(1).max(5) }).strict()).max(30),
  incidentalTopics: z.array(z.string().max(300)).max(30),
}).strict();
const suggestedQuestions = z.object({
  questions: z.array(z.object({ text: z.string().trim().min(10).max(500), offeringId: z.string(), intent: z.enum(["discover", "compare", "choose"]) }).strict()).max(20),
}).strict();
const reviewedQuestions = z.object({ questions: z.array(z.object({ index: z.number().int().min(0), text: z.string().trim().min(10).max(500) }).strict()).max(20) }).strict();
const suggestedCompetitors = z.object({
  competitors: z.array(z.object({ name: z.string().trim().min(2).max(100), domain: z.string().max(253), observationIds: z.array(z.string()).min(1),
    role: z.enum(['competitor', 'reference', 'both']).optional(), reason: z.string().trim().min(1).max(600).optional(),
  }).strict()).max(50),
}).strict();

/** Suggestions reuse the durable pass receipts; generated questions never become tracked prompts without review. */
export async function discoverQuestions(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  if (job.provider === "console") return consoleQuestions(runner, job, project, signal);
  if (!["chatgpt", "openrouter"].includes(job.provider ?? ""))
    throw new ProviderError("capability", "Connect ChatGPT or OpenRouter to suggest questions. You can also add your own.");
  const model = await runner.contentModel(job);
  const saved = runner.store.step(job.id, 'question-inputs');
  let inputs: { auditJobId: string; pages: { id: string; url: string; title: string; headings: string[]; schemaTypes: string[]; text: string; externalLinks: string[] }[] };
  if (saved?.body) inputs = JSON.parse(saved.body);
  else {
    const audit = runner.store.job(job.auditJobId!);
    if (audit.projectId !== project.id || audit.kind !== "audit" || JSON.parse(runner.store.step(audit.id, "project")?.body ?? "null")?.domain !== project.domain)
      throw new ProviderError("evidence", "Run a website audit for this website before suggesting questions.");
    if (audit.status !== "completed")
      throw new ProviderError("evidence", ["failed", "cancelled"].includes(audit.status)
        ? "The website audit did not finish. Run it again, then suggest questions."
        : "Wait for the website audit to finish before suggesting questions.");
    const readable = runner.store.pages(project.id, audit.id).filter(page => page.status >= 200 && page.status < 300 && !page.noindex && page.text.trim().length >= 80);
    if (!readable.length) throw new ProviderError("evidence", "We couldn't read enough website content. Try a rendered audit or add your own questions.");
    // Shorter paths prioritize the home page within the bounded evidence context.
    const sorted = [...readable].sort((a, b) => new URL(a.url).pathname.length - new URL(b.url).pathname.length);
    const pages = [];
    let remaining = Math.max(0, Math.min(60000, model.contextLength - 7000));
    for (const page of sorted) {
      const source = { id: page.id, url: page.url, title: page.title.slice(0, 300), headings: page.h1.slice(0, 5), schemaTypes: page.schemaTypes, text: page.text.slice(0, 3500), externalLinks: page.links.filter(link => { try { return !sameSiteHost(new URL(link), new URL(page.url)); } catch { return false; } }).slice(0, 30) };
      const size = Buffer.byteLength(JSON.stringify(source), "utf8");
      if (size > remaining) continue;
      pages.push(source); remaining -= size;
    }
    if (!pages.length) throw new ProviderError("context", "Choose a model with enough room for your website evidence.");
    inputs = { auditJobId: audit.id, pages };
    runner.store.setStep(job.id, 'question-inputs', 'done', inputs);
  }
  const { pages } = inputs;
  const context = { brand: project.brand, aliases: project.aliases, locale: project.locale, businessNotes: project.knowledge.slice(0, 4000) };
  const inventory = await runner.structuredPass(offeringInventory, job, model, "offerings", { ...context, pages }, signal);
  const spaces = (value: string) => value.replace(/\s+/g, " ").trim();
  const offeringIds = new Set<string>();
  for (const offering of inventory.offerings) {
    if (offeringIds.has(offering.id)) runner.rejectResponse(job, ["offerings"], "Website analysis repeated an offering identifier.");
    offeringIds.add(offering.id);
    for (const proof of offering.evidence) {
      const page = pages.find(page => page.id === proof.pageId);
      if (!page || !spaces(page.text).includes(spaces(proof.quote)))
        runner.rejectResponse(job, ["offerings"], "Website analysis referenced an unsupported passage.");
    }
  }
  const result = { pagesRead: pages.length, auditJobId: inputs.auditJobId, model: model.id, version: questionDiscoveryVersion };
  if (!inventory.offerings.length) return { ...result, questions: [] };
  const data = await runner.structuredPass(suggestedQuestions, job, model, "questions", { ...context, inventory }, signal);
  if (data.questions.some(question => !offeringIds.has(question.offeringId)))
    runner.rejectResponse(job, ["questions"], "Questions referenced an unconfirmed offering.");
  if (!data.questions.length) return { ...result, questions: [] };
  const review = await runner.structuredPass(reviewedQuestions, job, model, "questionReview", { ...context, proposedInventory: inventory, pages, candidates: data.questions.map((question, index) => ({ ...question, index })) }, signal);
  const seen = new Set<string>(), reviewedIndices = new Set<number>();
  const normalized = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const brands = [project.brand, ...project.aliases].map(normalized).filter(value => value.length >= 3);
  const questions = review.questions.flatMap(question => {
    const candidate = data.questions[question.index];
    if (!candidate || reviewedIndices.has(question.index)) runner.rejectResponse(job, ["questionReview"], "Question review referenced an unknown or repeated candidate.");
    reviewedIndices.add(question.index);
    const key = normalized(question.text);
    if (seen.has(key) || brands.some(brand => (" " + key + " ").includes(" " + brand + " "))) return [];
    seen.add(key);
    const offering = inventory.offerings.find(item => item.id === candidate.offeringId)!;
    const pageIds = [...new Set(offering.evidence.map(proof => proof.pageId))];
    return [{ text: question.text, intent: candidate.intent, pageIds, sources: pageIds.map(id => { const page = pages.find(item => item.id === id)!; return { url: page.url, title: page.title }; }) }];
  });
  return { ...result, questions };
}

/** A suggested alternative needs an answer mention and its own cited domain before user review. */
export async function discoverCompetitors(runner: Runner, job: Job, project: Project, model: Model, signal: AbortSignal, measurementJobId = job.id) {
  const saved = runner.store.step(job.id, "competitor-inputs");
  let inputs;
  if (saved?.body) inputs = JSON.parse(saved.body);
  else {
    const observations = runner.store.observations(project.id, measurementJobId);
    const audit = runner.store.jobs(project.id).find(item => item.kind === "audit" && item.status === "completed" && JSON.parse(runner.store.step(item.id, "project")?.body ?? "null")?.domain === project.domain);
    const pages = audit ? runner.store.pages(project.id, audit.id) : [];
    const others = pages.filter(page => new URL(page.url).pathname !== "/");
    // The homepage already travels as the site overview, so the website context spends its room on other pages.
    const website = others.length ? contentSources(others, observations.map(answer => answer.prompt), Math.min(12000, Math.max(0, model.contextLength - 14000)), [], 2000) : { sources: [], coverage: { pagesAvailable: 0, pagesUsed: 0, excerpts: true } };
    const home = pages.find(page => page.status >= 200 && page.status < 300 && new URL(page.url).pathname === '/');
    inputs = { observations, context: { brand: project.brand, domain: project.domain, locale: project.locale, businessNotes: project.knowledge.slice(0, 4000), website,
      siteOverview: home ? { id: home.id, url: home.url, title: home.title, headings: home.h1, text: home.text.slice(0, 3500) } : null } };
    runner.store.setStep(job.id, "competitor-inputs", "done", inputs);
  }
  const { observations, context } = inputs as { observations: ReturnType<typeof runner.store.observations>; context: Record<string, unknown> };
  const legacy = runner.store.step(job.id, "competitors");
  const batches: { id: string; question: string; text: string; citations: typeof observations[number]["citations"] }[][] = [];
  if (legacy) {
    // An existing receipt retains its request identity, including uncertain completion.
    batches.push(observations.map(answer => ({ id: answer.id, question: answer.prompt, text: answer.answer.slice(0, 12000), citations: answer.citations })));
  } else {
    const ceiling = Math.min(18000, model.contextLength - 6000 - Buffer.byteLength(JSON.stringify(context) + prompts.competitors, "utf8"));
    let batch: typeof batches[number] = [];
    for (const answer of observations.filter(answer => answer.citations.length > 0)) {
      const source = { id: answer.id, question: answer.prompt, text: answer.answer.slice(0, 12000), citations: answer.citations };
      if (Buffer.byteLength(JSON.stringify([source]), "utf8") > ceiling)
        throw new ProviderError("context", "Choose a model with more room to review competitor evidence. Your answers are saved.");
      if (batch.length && Buffer.byteLength(JSON.stringify([...batch, source]), "utf8") > ceiling) {
        batches.push(batch); batch = [];
      }
      batch.push(source);
    }
    if (batch.length) batches.push(batch);
  }
  const candidates: z.infer<typeof suggestedCompetitors>["competitors"] = [];
  for (const [index, answers] of batches.entries()) {
    signal.throwIfAborted();
    const data = await runner.structuredPass(suggestedCompetitors, job, model, "competitors", { ...context, answers }, signal, legacy ? "competitors" : "competitors:" + index);
    candidates.push(...data.competitors);
  }
  return confirmedWebsites(project, observations, candidates);
}

/** Cited evidence determines eligible roles; a reference cannot erase a competing-offering explanation. */
export function confirmedWebsites(project: Pick<Project, 'domain'>, observations: Observation[], candidates: z.infer<typeof suggestedCompetitors>['competitors']) {
  const confirmed = new Map<string, DiscoveredWebsite>();
  for (const candidate of candidates) {
    let domain: string;
    try { domain = publicUrl(candidate.domain).hostname.replace(/^www\./, ""); } catch { continue; }
    if (domain === project.domain || domain.endsWith("." + project.domain)) continue;
    const named = (answer: typeof observations[number]) => answer.answer.toLocaleLowerCase().includes(candidate.name.toLocaleLowerCase());
    const referenceName = (answer: typeof observations[number]) => candidate.name.toLocaleLowerCase() === domain || answer.citations.some(citation => {
      try { return publicUrl(citation.url).hostname.replace(/^www\./, '') === domain && citation.title?.toLocaleLowerCase().includes(candidate.name.toLocaleLowerCase()); } catch { return false; }
    });
    const evidence = observations.filter(answer => candidate.observationIds.includes(answer.id) && (named(answer) || (candidate.role === 'reference' && referenceName(answer))) && answer.citations.some(citation => {
      try { const host = publicUrl(citation.url).hostname.replace(/^www\./, ""); return host === domain || host.endsWith("." + domain); } catch { return false; }
    }));
    if (!evidence.length) continue;
    const prior = confirmed.get(domain);
    const role = prior?.role && candidate.role && prior.role !== candidate.role ? 'both' : candidate.role ?? prior?.role;
    const reason = candidate.role === 'reference' && prior?.role && prior.role !== 'reference'
      ? prior.reason ?? candidate.reason : candidate.reason ?? prior?.reason;
    confirmed.set(domain, { name: prior?.name ?? candidate.name, domain,
      ...(role ? { role } : {}), ...(reason ? { reason } : {}),
      observationIds: [...new Set([...(prior?.observationIds ?? []), ...evidence.map(answer => answer.id)])] });
  }
  // Tracking a domain already covers its subdomains, so a business cited on several of its own hosts is offered once, under its parent domain.
  const sites = [...confirmed.values()];
  for (const site of sites) {
    const owner = sites.filter(other => site.domain.endsWith("." + other.domain)).sort((a, b) => a.domain.length - b.domain.length)[0];
    if (!owner) continue;
    const merged = confirmed.get(owner.domain)!;
    const role = merged.role && site.role && merged.role !== site.role ? 'both' : merged.role ?? site.role;
    const reason = merged.role === 'reference' && site.role && site.role !== 'reference' ? site.reason ?? merged.reason : merged.reason ?? site.reason;
    confirmed.set(owner.domain, { ...merged, ...(role ? { role } : {}), ...(reason ? { reason } : {}),
      observationIds: [...new Set([...merged.observationIds, ...site.observationIds])] });
    confirmed.delete(site.domain);
  }
  return [...confirmed.values()];
}
