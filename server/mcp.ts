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
      "Run a selected provider workflow with an explicitly approved USD budget. Never substitute providers.",
    inputSchema: {
      projectId: z.string().uuid(),
      kind: z.enum(["measure", "recheck", "diagnose", "competitors", "content", "revise"]),
      provider: z.enum(["chatgpt", "openrouter", "dataforseo", "console"]),
      model: z.string().optional(),
      maxCostUsd: z.number().nonnegative(),
      topic: z.string().optional(),
      platform: z.string().optional(),
      contentId: z.string().uuid().optional(),
      findingId: z.string().uuid().optional(),
      contentMode: z.enum(["article", "page_update"]).optional(),
      measurementJobId: z.string().uuid().optional(),
      revisionInstructions: z.string().min(3).max(2000).optional(),
      webSearch: z.boolean().optional(),
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
await server.connect(new StdioServerTransport());
