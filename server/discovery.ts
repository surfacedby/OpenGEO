import { z } from "zod";
import type { Job, Model, Project } from "./contracts.js";
import { ProviderError } from "./contracts.js";
import type { Runner } from "./workflows.js";
import { parseJson } from "./workflows.js";
import { publicUrl } from "./network.js";

export const questionDiscoveryVersion = 3;
const offeringInventory = z.object({
  siteType: z.enum(["business", "marketplace", "publication", "personal", "unclear"]),
  audience: z.string().trim().max(500),
  offerings: z.array(z.object({ id: z.string().min(1).max(80), label: z.string().trim().min(3).max(300), customerNeed: z.string().trim().min(3).max(500), evidence: z.array(z.object({ pageId: z.string(), quote: z.string().trim().min(16).max(600) }).strict()).min(1).max(5) }).strict()).max(30),
  incidentalTopics: z.array(z.string().max(300)).max(30),
}).strict();
const suggestedQuestions = z.object({
  questions: z.array(z.object({ text: z.string().trim().min(10).max(500), offeringId: z.string(), intent: z.enum(["discover", "compare", "choose"]) }).strict()).max(20),
}).strict();
const reviewedQuestions = z.object({ questions: z.array(z.object({ index: z.number().int().min(0), text: z.string().trim().min(10).max(500) }).strict()).max(20) }).strict();
const suggestedCompetitors = z.object({
  competitors: z.array(z.object({ name: z.string().trim().min(2).max(100), domain: z.string().max(253), observationIds: z.array(z.string()).min(1) }).strict()).max(20),
}).strict();

/** Suggestions reuse the durable pass receipts; generated questions never become tracked prompts without review. */
export async function discoverQuestions(runner: Runner, job: Job, project: Project, signal: AbortSignal) {
  if (!["chatgpt", "openrouter"].includes(job.provider ?? ""))
    throw new ProviderError("capability", "Connect ChatGPT or OpenRouter to suggest questions. You can also add your own.");
  const audit = runner.store.jobs(project.id).find(item => item.kind === "audit" && item.status === "completed" &&
    JSON.parse(runner.store.step(item.id, "project")?.body ?? "null")?.domain === project.domain);
  if (!audit) throw new ProviderError("evidence", "Wait for the website audit to finish before suggesting questions.");
  const model = await runner.contentModel(job);
  const readable = runner.store.pages(project.id, audit.id).filter(page => page.status >= 200 && page.status < 300 && !page.noindex && page.text.trim().length >= 80);
  if (!readable.length) throw new ProviderError("evidence", "We couldn't read enough website content. Try a rendered audit or add your own questions.");
  // Shorter paths prioritize the home page within the bounded evidence context.
  const sorted = [...readable].sort((a, b) => new URL(a.url).pathname.length - new URL(b.url).pathname.length);
  const pages = [];
  let remaining = Math.max(0, Math.min(60000, model.contextLength - 7000));
  for (const page of sorted) {
    const source = { id: page.id, url: page.url, title: page.title.slice(0, 300), headings: page.h1.slice(0, 5), schemaTypes: page.schemaTypes, text: page.text.slice(0, 3500), externalLinks: page.links.filter(link => { try { return new URL(link).hostname !== new URL(page.url).hostname; } catch { return false; } }).slice(0, 30) };
    const size = Buffer.byteLength(JSON.stringify(source), "utf8");
    if (size > remaining) continue;
    pages.push(source); remaining -= size;
  }
  if (!pages.length) throw new ProviderError("context", "Choose a model with enough room for your website evidence.");
  const context = { brand: project.brand, aliases: project.aliases, locale: project.locale, businessNotes: project.knowledge.slice(0, 4000) };
  const inventory = offeringInventory.parse(parseJson(await runner.llmPass(job, model, "offerings", { ...context, pages }, signal)));
  const spaces = (value: string) => value.replace(/\s+/g, " ").trim();
  const offeringIds = new Set<string>();
  for (const offering of inventory.offerings) {
    if (offeringIds.has(offering.id)) throw new ProviderError("evidence", "Website analysis repeated an offering identifier. The output is saved for review.", true);
    offeringIds.add(offering.id);
    for (const proof of offering.evidence) {
      const page = pages.find(page => page.id === proof.pageId);
      if (!page || !spaces(page.text).includes(spaces(proof.quote)))
        throw new ProviderError("evidence", "Website analysis referenced an unsupported passage. The output is saved for review.", true);
    }
  }
  const result = { pagesRead: pages.length, auditJobId: audit.id, model: model.id, version: questionDiscoveryVersion };
  if (!inventory.offerings.length) return { ...result, questions: [] };
  const data = suggestedQuestions.parse(parseJson(await runner.llmPass(job, model, "questions", { ...context, inventory }, signal)));
  if (data.questions.some(question => !offeringIds.has(question.offeringId)))
    throw new ProviderError("evidence", "Questions referenced an unconfirmed offering. The output is saved for review.", true);
  if (!data.questions.length) return { ...result, questions: [] };
  const review = reviewedQuestions.parse(parseJson(await runner.llmPass(job, model, "questionReview", { ...context, proposedInventory: inventory, pages, candidates: data.questions.map((question, index) => ({ ...question, index })) }, signal)));
  const seen = new Set<string>(), reviewedIndices = new Set<number>();
  const normalized = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const brands = [project.brand, ...project.aliases].map(normalized).filter(value => value.length >= 3);
  const questions = review.questions.flatMap(question => {
    const candidate = data.questions[question.index];
    if (!candidate || reviewedIndices.has(question.index)) throw new ProviderError("evidence", "Question review referenced an unknown or repeated candidate. The output is saved for review.", true);
    reviewedIndices.add(question.index);
    const key = normalized(question.text);
    if (seen.has(key) || brands.some(brand => (" " + key + " ").includes(" " + brand + " "))) return [];
    seen.add(key);
    const offering = inventory.offerings.find(item => item.id === candidate.offeringId)!;
    const pageIds = [...new Set(offering.evidence.map(proof => proof.pageId))];
    return [{ text: question.text, intent: candidate.intent, pageIds, sources: pageIds.map(id => { const page = readable.find(item => item.id === id)!; return { url: page.url, title: page.title }; }) }];
  });
  return { ...result, questions };
}

/** A suggested alternative needs an answer mention and its own cited domain before user review. */
export async function discoverCompetitors(runner: Runner, job: Job, project: Project, model: Model, signal: AbortSignal) {
  const observations = runner.store.observations(project.id, job.id);
  const data = suggestedCompetitors.parse(parseJson(await runner.llmPass(job, model, "competitors", {
    brand: project.brand, domain: project.domain, locale: project.locale,
    answers: observations.map(answer => ({ id: answer.id, question: answer.prompt, text: answer.answer.slice(0, 12000), citations: answer.citations })),
  }, signal)));
  const seen = new Set<string>();
  return data.competitors.flatMap(candidate => {
    let domain: string;
    try { domain = publicUrl(candidate.domain).hostname.replace(/^www\./, ""); } catch { return []; }
    if (domain === project.domain || domain.endsWith("." + project.domain) || seen.has(domain)) return [];
    const evidence = observations.filter(answer => candidate.observationIds.includes(answer.id) && answer.answer.toLocaleLowerCase().includes(candidate.name.toLocaleLowerCase()) && answer.citations.some(citation => {
      try { const host = publicUrl(citation.url).hostname.replace(/^www\./, ""); return host === domain || host.endsWith("." + domain); } catch { return false; }
    }));
    if (!evidence.length) return [];
    seen.add(domain);
    return [{ name: candidate.name, domain, observationIds: evidence.map(answer => answer.id) }];
  });
}
