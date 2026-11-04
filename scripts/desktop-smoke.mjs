import { _electron as electron } from "playwright";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import identity from "../brand/identity.json" with { type: "json" };
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const externalProfile = option("--profile"), phase = option("--phase"), receipt = option("--receipt");
if (externalProfile && (!receipt || !["seed", "verify"].includes(phase))) throw new Error("Upgrade checks require a phase and receipt");
const directory = externalProfile ? resolve(externalProfile) : mkdtempSync(join(tmpdir(), "opengeo-desktop-test-"));
if (phase === 'seed' && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || readdirSync(directory).length))
  throw new Error('Upgrade seeding requires an empty, regular test directory');
const systemNames = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS', 'SHELL', 'USER', 'LOGNAME', 'DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
const root = process.argv[2] === "--verification" ? "release/verification" : "release";
const defaultExecutable = process.platform === "darwin"
  ? join(root, process.arch === "arm64" ? "mac-arm64" : "mac", identity.name + ".app", "Contents/MacOS", identity.name)
  : join(root, "win-unpacked", identity.name + ".exe");
let application;
let browserError = "";
try {
  const executable = resolve(process.argv[2] && process.argv[2] !== "--verification" ? process.argv[2] : defaultExecutable);
  if (!existsSync(executable)) throw new Error("Build the desktop verification package before running its checks");
  application = await electron.launch({
    executablePath: executable,
    // Provider credentials, CI tokens and editor Electron flags are not application configuration.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => systemNames.has(name.toUpperCase()))), OPENGEO_DESKTOP_DATA_DIR: directory },
    timeout: 30000,
  });
  application.process().stderr?.on('data', bytes => { browserError = (browserError + bytes.toString()).slice(-65536); });
  const page = await application.firstWindow();
  if (phase !== "verify") {
  await page
    .getByRole("heading", { name: "Power your AI visibility workspace", exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Continue without AI", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Website", exact: true })
    .fill("example.com");
  await page
    .getByRole("textbox", { name: "Brand name", exact: true })
    .fill("Example Domain");
  await page
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  // The previous released beta permits navigation during this save. Observe its
  // actual response before continuing; do not seed an unconfirmed privacy choice.
  const savedPreference = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings/usage-sharing' && response.request().method() === 'PUT');
  await page.getByRole("checkbox", { name: "Help improve OpenGEO by sharing usage", exact: true }).uncheck();
  const saved = await savedPreference;
  if (!saved.ok() || (await saved.json()).enabled !== false) throw new Error('Usage sharing withdrawal was not saved');
  await page.getByRole("button", { name: "Check website health", exact: true }).click();
  }
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  const runtime = JSON.parse(readFileSync(join(directory, "runtime.json"), "utf8"));
  const token = readFileSync(join(directory, "local-session"), "utf8");
  const api = async path => {
    const response = await fetch(runtime.origin + "/api" + path, { headers: { Authorization: "Bearer " + token } });
    if (!response.ok) throw new Error("Packaged workflow request failed");
    return response.json();
  };
  const projects = await api("/projects");
  const consent = await api("/settings/usage-sharing");
  if (consent.enabled !== false) throw new Error("Packaged local verification must not submit usage");
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
  if (phase === "seed") {
    // A synthetic opaque value tests OS-encrypted storage without connecting any provider.
    const sealed = await application.evaluate(({ safeStorage }) => [...safeStorage.encryptString(JSON.stringify({ __upgradeProbe: "synthetic-upgrade-storage-check" }))]);
    writeFileSync(join(directory, "credentials.sealed"), Buffer.from(sealed));
    writeFileSync(receipt, JSON.stringify({ projectId: projects[0].id, auditId: workspace.jobs[0].id, pages: workspace.pages.length, usageSharing: consent.enabled }));
  } else if (phase === "verify") {
    const before = JSON.parse(readFileSync(receipt, "utf8"));
    if (projects[0].id !== before.projectId || workspace.jobs[0].id !== before.auditId || workspace.pages.length !== before.pages || consent.enabled !== before.usageSharing)
      throw new Error("The installer update did not preserve the existing workspace");
    const sealed = [...readFileSync(join(directory, "credentials.sealed"))];
    const probe = await application.evaluate(({ safeStorage }, bytes) => JSON.parse(safeStorage.decryptString(Buffer.from(bytes))), sealed);
    if (probe.__upgradeProbe !== "synthetic-upgrade-storage-check") throw new Error("OS-encrypted storage did not survive the update");
  }
  console.log(
    JSON.stringify({
      packagedStartup: true,
      sqlite: true,
      localAudit: true,
      credentialFreeBackup: true,
      rendererIsolated: true,
      settings: true,
      usageSharingDisabled: true,
      upgradeWorkspaceAndEncryptedStorage: phase === "verify",
    }),
  );
} catch (error) {
  if (browserError) console.error(browserError);
  console.error(error);
  process.exitCode = 1;
} finally {
  await application?.close();
  try {
    if (!externalProfile) {
      if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Desktop profile cleanup escaped its temporary directory");
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 300,
      });
    }
  } catch {
    console.error("Temporary desktop profile remains locked: " + directory);
  }
}
