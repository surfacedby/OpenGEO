import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

const directory = mkdtempSync(join(tmpdir(), "opengeo-docker-test-"));
const name = "opengeo-test-" + randomUUID();
const image = process.argv[2] ?? "opengeo:preview";
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
try {
  // docker cp keeps Unix modes on Linux hosts; the container runs as the unprivileged node user, like a mounted Docker secret it must be readable there.
  writeFileSync(join(directory, "opengeo_secret"), randomBytes(48), { mode: 0o644 });
  chmodSync(directory, 0o755);
  docker(["create", "--name", name, image, "node", "/tmp/workflow.cjs"]);
  docker(["cp", directory, name + ":/run/secrets"]);
  docker(["cp", "scripts/docker-workflow.cjs", name + ":/tmp/workflow.cjs"]);
  const run = () => {
    docker(["start", name]);
    const code = docker(["wait", name]).trim();
    if (code !== "0") {
      process.stderr.write(docker(["logs", name]).slice(-4000));
      docker(["cp", name + ":/tmp/failure.json", join(directory, "failure.json")]);
      throw new Error(JSON.parse(readFileSync(join(directory, "failure.json"), "utf8")).error);
    }
  };
  run();
  docker(["cp", name + ":/tmp/outcome.json", join(directory, "outcome.json")]);
  const outcome = JSON.parse(readFileSync(join(directory, "outcome.json"), "utf8"));
  run();
  docker(["cp", name + ":/tmp/restart.json", join(directory, "restart.json")]);
  if (!JSON.parse(readFileSync(join(directory, "restart.json"), "utf8")).persisted) throw new Error("Database did not survive restart");
  delete outcome.projectId;
  console.log(JSON.stringify({ ...outcome, restartPersistence: true, image }));
} finally {
  try { docker(["rm", "-fv", name]); } catch {}
  const child = relative(resolve(tmpdir()), resolve(directory));
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Refusing cleanup outside temporary test directory");
  rmSync(directory, { recursive: true, force: true });
}
