import { readFileSync } from "node:fs";
import { localCall } from "./local-client.js";
const [command = "projects", ...args] = process.argv.slice(2);
async function call(path: string, body?: unknown) {
  const { ok, data } = await localCall(path, body);
  if (!ok) throw new Error(data.error ?? "Request failed");
  return data;
}
if (command === "projects")
  console.log(JSON.stringify(await call("/projects"), null, 2));
else if (command === "workspace")
  console.log(
    JSON.stringify(await call("/projects/" + args[0] + "/workspace"), null, 2),
  );
else if (command === "job")
  console.log(JSON.stringify(await call("/jobs/" + args[0]), null, 2));
else if (command === "run") {
  if (!args[0])
    throw new Error(
      "Pass a JSON request file, never credentials on the command line",
    );
  console.log(
    JSON.stringify(
      await call("/jobs", JSON.parse(readFileSync(args[0], "utf8"))),
      null,
      2,
    ),
  );
} else if (command === "schedule") {
  if (!args[0]) throw new Error("Pass a schedule JSON file");
  console.log(
    JSON.stringify(
      await call("/schedules", JSON.parse(readFileSync(args[0], "utf8"))),
      null,
      2,
    ),
  );
} else
  throw new Error(
    "Commands: projects, workspace <id>, job <id>, run <file.json>, schedule <file.json>",
  );
