import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { localCall } from "./local-client.js";
import identity from "../brand/identity.json";
const server = new McpServer({ name: identity.name, version: "0.1.0" });
async function call(path: string, body?: unknown) {
  const { ok, data: result } = await localCall(path, body);
  return {
    isError: !ok,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}
server.registerTool(
  "list_projects",
  {
    description: "List local " + identity.name + " projects",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () => call("/projects"),
);
server.registerTool(
  "read_workspace",
  {
    description: "Read local evidence, opportunities and drafts",
    inputSchema: { projectId: z.string().uuid() },
    annotations: { readOnlyHint: true },
  },
  ({ projectId }) => call("/projects/" + projectId + "/workspace"),
);
server.registerTool(
  "start_audit",
  {
    description:
      "Audit public pages. This contacts the website but does not use a paid provider.",
    inputSchema: { projectId: z.string().uuid() },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  ({ projectId }) => call("/jobs", { projectId, kind: "audit" }),
);
server.registerTool(
  "start_workflow",
  {
    description:
      "Run a selected provider workflow with an explicitly approved USD budget. Never substitute providers. DeepSeek runs measure and recheck only; recommendations, suggestions, competitors and content stay with the other providers.",
    inputSchema: {
      projectId: z.string().uuid(),
      kind: z.enum(["discover", "measure", "recheck", "diagnose", "competitors", "content", "revise"]),
      provider: z.enum(["chatgpt", "openrouter", "dataforseo", "console", "deepseek"]),
      model: z.string().optional(),
      maxCostUsd: z.number().nonnegative(),
      topic: z.string().optional(),
      platform: z.string().optional(),
      contentId: z.string().uuid().optional(),
      findingId: z.string().uuid().optional(),
      contentMode: z.enum(["article", "page_update"]).optional(),
      measurementJobId: z.string().uuid().optional(),
      auditJobId: z.string().uuid().optional(),
      revisionInstructions: z.string().min(3).max(2000).optional(),
      webSearch: z.boolean().optional(),
      topicId: z.string().uuid().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  (input) => call("/jobs", input),
);
server.registerTool(
  "read_job",
  {
    description: "Read workflow status",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true },
  },
  ({ id }) => call("/jobs/" + id),
);
server.registerTool(
  "preview_resume",
  {
    description: "Read the saved spending ceiling and uncertain requests before approving a paused workflow.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true },
  },
  ({ id }) => call("/jobs/" + id + "/resume-preview"),
);
server.registerTool(
  "resume_workflow",
  {
    description: "Resume saved work after explicit review. Paid estimates need approval; unknown completion is recovered before any new purchase.",
    inputSchema: { id: z.string().uuid(), reviewed: z.boolean(), maxCostUsd: z.number().finite().nonnegative().max(10000).optional() },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  ({ id, ...approval }) => call("/jobs/" + id + "/resume", approval),
);
server.registerTool(
  "cancel_workflow",
  {
    description: "Stop a saved workflow and request remote cancellation. Completed work may remain billable; inspect the saved receipt afterward.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  ({ id }) => call("/jobs/" + id + "/cancel", {}),
);
const askEngines = z.enum(["chatgpt", "surfacedby-chatgpt", "surfacedby-gemini", "dataforseo-chatgpt", "dataforseo-gemini", "dataforseo-perplexity", "deepseek"]);
server.registerTool(
  "list_ask_engines",
  {
    description: "List the engines an ask can use for a project, whether each is available and why not, how each is priced, and the default spending limit.",
    inputSchema: { projectId: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ projectId }) => call("/projects/" + projectId + "/asks/engines"),
);
server.registerTool(
  "estimate_ask",
  {
    description: "Estimate one question on the chosen engines without running it. ChatGPT uses the connected plan and its limits; SurfacedBy returns a quote; DataForSEO uses the saved per-request estimate and its actual charge can differ; DeepSeek returns the most one answer can cost, and its recorded cost is computed from reported tokens and searches.",
    inputSchema: { projectId: z.string().uuid(), question: z.string().min(3).max(500), engines: z.array(askEngines).min(1) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ projectId, ...input }) => call("/projects/" + projectId + "/asks/estimate", input),
);
server.registerTool(
  "ask_engines",
  {
    description: "Ask one question of the chosen engines once. Paid engines share maxCostUsd evenly and an engine whose price exceeds its share stops before any purchase. Engines are never substituted. Answers stay out of the project's evidence until the question is tracked.",
    inputSchema: {
      projectId: z.string().uuid(),
      question: z.string().min(3).max(500),
      engines: z.array(askEngines).min(1),
      maxCostUsd: z.number().finite().nonnegative().max(1000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  ({ projectId, ...input }) => call("/projects/" + projectId + "/asks", input),
);
server.registerTool(
  "read_ask",
  {
    description: "Read one ask's answers per engine with their state, surface, citations, searches and cost, or every ask for the project when askId is omitted.",
    inputSchema: { projectId: z.string().uuid(), askId: z.string().uuid().optional() },
    annotations: { readOnlyHint: true },
  },
  ({ projectId, askId }) => call("/projects/" + projectId + "/asks" + (askId ? "/" + askId : "")),
);
await server.connect(new StdioServerTransport());
