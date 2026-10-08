import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { start } from "../server/main.js";
import { jobInput, projectInput } from "../server/contracts.js";

test("CLI and MCP review the same saved work and cannot resume uncertain requests without approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opengeo-automation-"));
  const runtime = await start({ directory, port: 0, protector: {
    encrypt: value => Buffer.from(value), decrypt: value => value.toString(),
  } });
  const client = new Client({ name: "Local verification", version: "1.0.0" });
  const env = Object.fromEntries(Object.entries({ ...process.env, OPENGEO_DATA_DIR: directory })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const run = promisify(execFile);
  const cli = (...args: string[]) => run(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "server/cli.ts", ...args], { env });
  try {
    await runtime.runner.stop(); runtime.scheduler.stop(); runtime.usage.setEnabled(false);
    const project = runtime.store.createProject(projectInput.parse({ domain: "example.com", brand: "Example" }));
    const job = runtime.store.enqueue(jobInput.parse({ projectId: project.id, kind: "content", provider: "openrouter", maxCostUsd: 1 }), "automation");
    runtime.store.setStep(job.id, "draft", "started");
    runtime.store.updateJob(job.id, { status: "paused", error: "network" });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [resolve("node_modules/tsx/dist/cli.mjs"), "server/mcp.ts"], env, stderr: "pipe" }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === "preview_resume" && tool.annotations?.readOnlyHint));
    const read = (result: any) => JSON.parse(result.content[0].text);
    const preview = read(await client.callTool({ name: "preview_resume", arguments: { id: job.id } }));
    assert.equal(preview.uncertainRequests, 1); assert.equal(preview.maxCostUsd, 1);
    assert.deepEqual(JSON.parse((await cli("review", job.id)).stdout), preview);
    const approval = join(directory, "approval.json");
    writeFileSync(approval, JSON.stringify({ reviewed: false }));
    await assert.rejects(cli("resume", job.id, approval));
    assert.equal(runtime.store.job(job.id).status, "paused");
    const denied = await client.callTool({ name: "resume_workflow", arguments: { id: job.id, reviewed: false } });
    assert.equal(denied.isError, true);
    assert.equal(runtime.store.step(job.id, "draft")?.state, "started");
    const accepted = await client.callTool({ name: "resume_workflow", arguments: { id: job.id, reviewed: true, maxCostUsd: 1.5 } });
    assert.equal(accepted.isError, false); assert.equal(read(accepted).status, "queued");
    assert.equal(runtime.store.job(job.id).maxCostUsd, 1.5);
    assert.equal(runtime.store.step(job.id, "draft")?.state, "approved-retry");
    assert.equal(JSON.parse((await cli("cancel", job.id)).stdout).status, "cancelled");
    assert.equal(read(await client.callTool({ name: "read_job", arguments: { id: job.id } })).status, "cancelled");
    assert.equal(runtime.store.job(job.id).spentUsd, 0);
  } finally {
    await client.close(); await runtime.app.close(); rmSync(directory, { recursive: true, force: true });
  }
});
