import { _electron as electron } from "playwright";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import identity from "../brand/identity.json" with { type: "json" };
const directory = mkdtempSync(join(tmpdir(), "opengeo-desktop-test-"));
const root = process.argv[2] === "--verification" ? "release/verification" : "release";
const defaultExecutable = process.platform === "darwin"
  ? join(root, process.arch === "arm64" ? "mac-arm64" : "mac", identity.name + ".app", "Contents/MacOS", identity.name)
  : join(root, "win-unpacked", identity.name + ".exe");
let application;
try {
  const executable = resolve(process.argv[2] && process.argv[2] !== "--verification" ? process.argv[2] : defaultExecutable);
  if (!existsSync(executable)) throw new Error("Build the desktop verification package before running its checks");
  application = await electron.launch({
    executablePath: executable,
    env: { ...process.env, OPENGEO_DESKTOP_DATA_DIR: directory },
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await page
    .getByRole("heading", { name: "Power your AI visibility workspace", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Use local audits only", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Website", exact: true })
    .fill("example.com");
  await page
    .getByRole("textbox", { name: "Brand name", exact: true })
    .fill("Example Domain");
  await page
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await page.getByRole("button", { name: "Open workspace & audit", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const runtime = JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8"));
  const token = readFileSync(join(directory, "local-session"), "utf8");
  const api = async path => {
    const response = await fetch(runtime.origin + "/api" + path, { headers: { Authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("Packaged workflow request failed");
    return response.json();
  };
  const projects = await api("/projects");
  if (projects.length !== 1) throw new Error("Setup must create one project");
  let workspace;
  for (let attempt = 0; attempt < 60; attempt++) {
    workspace = await api("/projects/" + projects[0].id + "/workspace");
    if (["completed", "failed"].includes(workspace.jobs[0]?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (workspace.jobs.length !== 1 || workspace.jobs[0].kind !== "audit"
    || workspace.jobs[0].status !== "completed" || workspace.jobs[0].spentUsd !== 0 || !workspace.pages.length)
    throw new Error("The packaged local audit did not produce completed page evidence");
  const backup = await api("/backup");
  if (backup.format !== "opengeo-backup" || backup.projects.length !== 1 || JSON.stringify(backup).includes(token))
    throw new Error("The packaged backup is incomplete or contains session credentials");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Data & privacy", exact: true }).click();
  await page
    .getByRole("heading", { name: "Backup and restore", exact: true })
    .waitFor();
  const sandbox = await page.evaluate(
    () =>
      typeof window.require === "undefined" &&
      typeof window.process === "undefined",
  );
  if (!sandbox) throw new Error("Renderer isolation failed");
  console.log(
    JSON.stringify({
      packagedStartup: true,
      sqlite: true,
      localAudit: true,
      credentialFreeBackup: true,
      rendererIsolated: true,
      settings: true,
    }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await application?.close();
  try {
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Desktop profile cleanup escaped its temporary directory");
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    });
  } catch {
    console.error("Temporary desktop profile remains locked: " + directory);
  }
}
