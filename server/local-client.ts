import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/** Resolve the actual desktop port; credentials only travel to verified loopback. */
export async function localCall(path: string, body?: unknown) {
  const directory = resolve(process.env.OPENGEO_DATA_DIR ?? ".local");
  const token = readFileSync(resolve(directory, "local-session"), "utf8");
  const runtime = JSON.parse(
    readFileSync(resolve(directory, "runtime.json"), "utf8"),
  );
  const origin = new URL(runtime.origin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid local runtime address");
  const response = await fetch(origin.origin + "/api" + path, {
    method: body ? "POST" : "GET",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(body ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  return { ok: response.ok, data };
}
