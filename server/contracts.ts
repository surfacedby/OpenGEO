import { z } from "zod";
export const providers = [
  "chatgpt",
  "openrouter",
  "dataforseo",
  "console",
] as const;
export type Provider = (typeof providers)[number];
export const projectInput = z
  .object({
    domain: z.string().max(253),
    brand: z.string().trim().min(1).max(100),
    aliases: z.array(z.string().trim().min(2).max(100)).default([]),
    competitors: z.array(z.string().trim().min(2).max(253)).default([]),
    prompts: z.array(z.string().trim().min(3).max(500)).default([]),
    locale: z
      .string()
      .max(40)
      .refine((value) => {
        try {
          new Intl.Locale(value);
          return true;
        } catch {
          return false;
        }
      }, "Use a valid language tag")
      .default("en-US"),
    knowledge: z.string().max(50000).default(""),
  })
  .strict();
export type ProjectInput = z.infer<typeof projectInput>;
export type Project = ProjectInput & { id: string; createdAt: string };
export const setupDraft = z.object({
  step: z.number().int().min(0).max(3),
  projectId: z.string().uuid().optional(),
  provider: z.enum(providers),
  localOnly: z.boolean(),
  discoveryJobId: z.string().uuid().optional(),
  checkJobId: z.string().uuid().optional(),
  questionRows: z.array(z.object({ id: z.string().uuid(), text: z.string().max(500), selected: z.boolean() }).strict()).max(200).optional(),
}).strict();
export type SetupDraft = z.infer<typeof setupDraft>;
export type Citation = { url: string; title?: string };
export type Observation = {
  id: string;
  projectId: string;
  jobId: string;
  prompt: string;
  provider: Provider;
  platform: string;
  model: string;
  locale: string;
  observedAt: string;
  answer: string;
  citations: Citation[];
  surface: "api" | "consumer_interface" | "unknown";
  retrieval?: "web_search" | "model_only" | "provider_managed";
  webSearchConfirmed?: boolean;
  mentioned: boolean;
  cited: boolean;
  costUsd: number | null;
};
export type PageEvidence = {
  id: string;
  url: string;
  fetchedAt: string;
  status: number;
  title: string;
  description: string;
  h1: string[];
  text: string;
  canonical: string;
  noindex: boolean;
  schemaTypes: string[];
  links: string[];
};
export const auditCoverage = z.object({
  attempted: z.number().int().nonnegative(),
  fetched: z.number().int().nonnegative(),
  failed: z.array(z.object({ url: z.string(), reason: z.string() })),
  excludedByRobots: z.array(z.string()),
  skippedNonHtml: z.array(z.string()).default([]),
  truncated: z.boolean(),
  remainingDiscovered: z.number().int().nonnegative(),
  maxPages: z.number().int().positive(),
});
export type AuditCoverage = z.infer<typeof auditCoverage>;
export type Finding = {
  id: string;
  projectId: string;
  jobId: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  targetUrl: string;
  evidenceIds: string[];
  steps: string[];
  confidence: "known" | "inferred";
  status: "open" | "doing" | "done";
  kind: string;
};
export const contentTask = z.object({
  mode: z.enum(["article", "page_update"]),
  findingId: z.string().min(1).max(200).optional(),
  targetUrl: z.string().url().optional(),
  recommendation: z.object({
    title: z.string().max(200),
    description: z.string().max(3000),
    steps: z.array(z.string().max(2000)),
  }).strict().optional(),
}).strict()
  .refine(task => Boolean(task.findingId) === Boolean(task.targetUrl) && Boolean(task.findingId) === Boolean(task.recommendation), 'Keep the opportunity and target page together')
  .refine(task => task.mode !== 'page_update' || Boolean(task.findingId), 'A page update requires its source opportunity');
export type ContentTask = z.infer<typeof contentTask>;
export const jobKinds = ["audit", "discover", "competitors", "measure", "diagnose", "content", "revise", "recheck"] as const;
export const jobInput = z
  .object({
    projectId: z.string().uuid(),
    kind: z.enum(jobKinds),
    contentId: z.string().uuid().optional(),
    findingId: z.string().uuid().optional(),
    contentMode: z.enum(["article", "page_update"]).optional(),
    revisionInstructions: z.string().trim().min(3).max(2000).optional(),
    provider: z.enum(providers).optional(),
    model: z.string().max(150).optional(),
    platform: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).default("chat_gpt"),
    maxCostUsd: z.number().finite().min(0).max(10000).default(0),
    topic: z.string().max(1000).optional(),
    render: z.boolean().default(false),
    webSearch: z.boolean().default(true),
    discoverCompetitors: z.boolean().optional(),
    measurementJobId: z.string().uuid().optional(),
    maxPages: z.number().int().positive().max(100000).default(100),
  })
  .strict()
  .refine((input) => input.kind !== 'revise' || (!!input.contentId && !!input.revisionInstructions), 'Choose a draft and describe the revision')
  .refine((input) => input.kind !== 'competitors' || !!input.measurementJobId, 'Choose a saved visibility check')
  .refine(input => (!input.findingId && !input.contentMode) || input.kind === 'content', 'Content options apply only to a new draft')
  .refine(input => input.contentMode !== 'page_update' || !!input.findingId, 'Choose a page improvement before drafting its changes');
export type JobInput = z.infer<typeof jobInput>;
export type Job = JobInput & {
  id: string;
  status:
    "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  step: number;
  progress: string;
  error: string | null;
  result: unknown;
  spentUsd: number;
  costBasis?: "reported" | "includes_estimates";
  requestedAnswers?: number;
};
export type Model = {
  id: string;
  name: string;
  contextLength: number;
  inputUsd: number;
  outputUsd: number;
  maxOutputTokens?: number;
};
export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public uncertain = false,
    public remoteCode?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
export const credentialInput = z.discriminatedUnion("provider", [
  z
    .object({ provider: z.literal("openrouter"), key: z.string().min(10) })
    .strict(),
  z
    .object({
      provider: z.literal("dataforseo"),
      login: z.string().min(1),
      password: z.string().min(1),
    })
    .strict(),
  z
    .object({ provider: z.literal("console"), key: z.string().min(10) })
    .strict(),
]);
export type CredentialInput = z.infer<typeof credentialInput>;
